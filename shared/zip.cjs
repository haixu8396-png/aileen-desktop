// ============================================================
// 最小 ZIP 读取器（零依赖）
//
// 为什么自己写：项目不许新增依赖，而「导入 Live2D 模型」最常见的就是一个 zip 包
// （Booth / GitHub 下载下来都是 zip）。用系统解压工具要起进程，路径和编码都容易翻车；
// 这里只实现真正需要的部分：**读取中央目录 + store/deflate 两种压缩方式**。
//
// 明确不支持（遇到就报错，不静默解错）：
//   · ZIP64（单文件 > 4GB / 条目 > 65535）
//   · 加密条目
//   · 多卷压缩包
//
// 安全约束（这里有解压，等于把外部字节写到磁盘上）：
//   · 路径不许是绝对路径、不许含 `..`、不许带盘符 —— 防目录穿越；
//   · 跳过符号链接条目（Unix external attrs 高 16 位）；
//   · 条目数量 / 解压后总大小都有上限 —— 防 zip bomb；
//   · 只往调用方给的目录里写，且不覆盖已存在的文件（同名直接跳过并记录）。
// ============================================================
'use strict';

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 解压上限：Live2D 模型一般几 MB ~ 几十 MB，超过这些数就是恶意的了 */
const DEFAULTS = {
  maxEntries: 5000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
};

function findEocd(buf) {
  // EOCD 在文件末尾（注释最长 65535），从后往前找
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** 读中央目录：返回 [{ name, method, compressedSize, size, localOffset, isSymlink }] */
function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 ZIP 文件（太短）');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到目录结尾）');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || total === 0xffff || cdSize === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 压缩包');
  }
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP 中央目录越界（文件可能被截断）');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > buf.length) throw new Error('ZIP 中央目录损坏');
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('ZIP 中央目录损坏（签名不对）');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new Error('ZIP 中央目录损坏（文件名越界）');
    const nameRaw = buf.subarray(p + 46, p + 46 + nameLen);
    // bit 11 = UTF-8 文件名；否则按 cp437/latin1 处理（模型包里基本只会是 ASCII 路径）
    const name = nameRaw.toString(flags & 0x800 ? 'utf8' : 'latin1');
    // Unix 模式放在 external attrs 高 16 位；0o120000 = 符号链接
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    entries.push({
      name,
      method,
      compressedSize,
      size,
      localOffset,
      encrypted: (flags & 1) === 1,
      isSymlink: (unixMode & 0o170000) === 0o120000,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 把一个条目名变成安全的相对路径；不安全就抛错 */
function safeEntryPath(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (!raw) throw new Error('ZIP 里有空的文件名');
  if (raw.startsWith('/')) throw new Error('ZIP 里有绝对路径：' + raw);
  if (/^[a-zA-Z]:/.test(raw)) throw new Error('ZIP 里有带盘符的路径：' + raw);
  const parts = raw.split('/').filter((seg) => seg && seg !== '.');
  if (parts.some((seg) => seg === '..')) throw new Error('ZIP 里试图跳出目标目录：' + raw);
  if (!parts.length) throw new Error('ZIP 里有空的文件名');
  return parts.join('/');
}

/** 解一条 zip 条目的数据 */
function readEntryData(buf, entry) {
  const p = entry.localOffset;
  if (p + 30 > buf.length) throw new Error('ZIP 条目损坏：' + entry.name);
  if (buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error('ZIP 条目损坏（签名不对）：' + entry.name);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > buf.length) throw new Error('ZIP 条目被截断：' + entry.name);
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1024) });
    } catch (err) {
      throw new Error('解压失败（' + entry.name + '）：' + String((err && err.message) || err));
    }
  }
  throw new Error('不支持的压缩方式 ' + entry.method + '（' + entry.name + '）');
}

/**
 * 把 zip 解到 destDir。
 * @returns {{ files: string[], skipped: string[], modelJsons: string[] }}
 *   files     实际写出的相对路径
 *   skipped   被跳过的条目（目录 / 符号链接 / 系统垃圾 / 已存在）
 *   modelJsons 包里的 Live2D 配置（model3.json / model.json），相对路径
 */
function extractZipBuffer(buf, destDir, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  const entries = readZipEntries(buf);
  if (entries.length > cfg.maxEntries) throw new Error('ZIP 内条目太多（' + entries.length + '），已拒绝解压');

  const files = [];
  const skipped = [];
  const modelJsons = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.encrypted) throw new Error('不支持加密的 ZIP');
    const safe = safeEntryPath(entry.name);
    if (entry.name.endsWith('/') || entry.name.endsWith('\\')) { skipped.push(safe); continue; }
    // 系统垃圾：不写进模型目录
    if (/(^|\/)__MACOSX(\/|$)/.test(safe) || /(^|\/)\.DS_Store$/.test(safe)) { skipped.push(safe); continue; }
    if (entry.isSymlink) { skipped.push(safe); continue; }
    if (entry.size > cfg.maxEntryBytes) throw new Error('ZIP 里单个文件太大：' + safe);
    totalBytes += entry.size;
    if (totalBytes > cfg.maxTotalBytes) throw new Error('ZIP 解压后总大小超过上限，已拒绝解压');

    const target = path.resolve(root, safe.split('/').join(path.sep));
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('ZIP 里试图写到目标目录之外：' + safe);
    }
    if (fs.existsSync(target)) { skipped.push(safe); continue; }
    const data = readEntryData(buf, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files.push(safe);
    if (/^(?:model3?\.json|.+\.model3?\.json)$/i.test(path.posix.basename(safe))) modelJsons.push(safe);
  }

  return { files, skipped, modelJsons };
}

module.exports = { readZipEntries, extractZipBuffer, safeEntryPath, findEocd, DEFAULTS };
