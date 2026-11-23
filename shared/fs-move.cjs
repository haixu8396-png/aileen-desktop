'use strict';
// ============================================================
// 可靠的文件移动 / 复制（主进程唯一实现）
//
// 为什么不能只调 `fs.rename()`：Windows 上 rename 只在**同一个卷**内可靠。
// 把 `D:\AileenData\data\x.txt` 移到 `C:\Users\你\Desktop\x.txt` 会直接 EXDEV，
// 而模型收到的如果是一句含糊的「移动失败」，它会以为是权限问题或者路径问题。
//
// 这里的策略（移动）：
//   1) 同卷：rename（最快，原子）
//   2) 目标已存在：overwrite=false → 明确报 TARGET_EXISTS；overwrite=true → 先把目标
//      挪到旁边当备份，成功后再删，失败则把备份挪回去（不能让「覆盖」变成「弄丢」）
//   3) 跨卷（EXDEV）：复制 → **验证**（文件比大小 + 哈希；目录比条目与总字节）
//      → 验证通过才删源；任何一步失败都保留源文件，并清掉写了一半的目标
//   4) rename 报 EBUSY / EPERM 且不是跨卷：判定为「文件被占用」，不做复制兜底
//      （复制正在被写入的文件会得到半截内容，比报错更糟）
//
// 全部用注入的 fsImpl（默认 node:fs），所以单测可以伪造 EXDEV / 校验失败。
// ============================================================

const defaultFs = require('fs');
const crypto = require('crypto');

const MAX_VERIFY_BYTES = 64 * 1024 * 1024; // 超过这个大小只比大小，不读全文件
const MAX_TREE_ENTRIES = 200000;

const CODE = {
  SOURCE_MISSING: 'SOURCE_MISSING',
  TARGET_EXISTS: 'TARGET_EXISTS',
  FILE_IN_USE: 'FILE_IN_USE',
  VERIFY_FAILED: 'VERIFY_FAILED',
  SOURCE_DELETE_FAILED: 'SOURCE_DELETE_FAILED',
  DEST_PREPARE_FAILED: 'DEST_PREPARE_FAILED',
  UNSUPPORTED: 'UNSUPPORTED',
};

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

function statOf(p, fsImpl) {
  try { return fsImpl.statSync(p); } catch { return null; }
}

function lstatOf(p, fsImpl) {
  try { return fsImpl.lstatSync(p); } catch { return null; }
}

function hashFile(file, fsImpl) {
  const buf = fsImpl.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 目录树的指纹：条目相对路径 + 每个文件大小（用于跨卷复制后的验证） */
function treeFingerprint(dir, fsImpl) {
  const files = [];
  let totalBytes = 0;
  let count = 0;
  const walk = (cur, prefix) => {
    if (count > MAX_TREE_ENTRIES) return;
    const entries = fsImpl.readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const isDir = typeof entry === 'string'
        ? false
        : (typeof entry.isDirectory === 'function' ? !!entry.isDirectory() : !!entry.isDirectory);
      const abs = cur + '\\' + name;
      if (isDir) {
        walk(abs, prefix + name + '/');
      } else {
        const st = statOf(abs, fsImpl);
        files.push(prefix + name + '|' + (st ? st.size : -1));
        totalBytes += st ? st.size : 0;
        count += 1;
      }
    }
  };
  walk(dir, '');
  files.sort();
  return { files, totalBytes, count };
}

function sameFingerprint(a, b) {
  if (!a || !b) return false;
  if (a.count !== b.count) return false;
  if (a.totalBytes !== b.totalBytes) return false;
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i += 1) if (a.files[i] !== b.files[i]) return false;
  return true;
}

/** 验证一个文件确实被复制到位 */
function verifyFile(from, to, fsImpl, fromSize) {
  const st = statOf(to, fsImpl);
  if (!st || !fsImpl.existsSync(to)) {
    throw err(CODE.VERIFY_FAILED, '复制后目标文件不存在：' + to);
  }
  if (typeof fromSize === 'number' && st.size !== fromSize) {
    throw err(CODE.VERIFY_FAILED, '复制后大小不一致（源 ' + fromSize + ' 字节，目标 ' + st.size + ' 字节）：' + to);
  }
  if (fromSize <= MAX_VERIFY_BYTES) {
    const a = hashFile(from, fsImpl);
    const b = hashFile(to, fsImpl);
    if (a !== b) throw err(CODE.VERIFY_FAILED, '复制后内容校验不一致（sha256 不同）：' + to);
    return { mode: 'hash', bytes: st.size };
  }
  return { mode: 'size', bytes: st.size };
}

function ensureParentDir(target, fsImpl) {
  const parent = target.replace(/[\\/][^\\/]+$/, '');
  if (!parent) return;
  if (fsImpl.existsSync(parent)) return;
  try {
    fsImpl.mkdirSync(parent, { recursive: true });
  } catch (e) {
    throw err(CODE.DEST_PREPARE_FAILED, '无法创建目标目录 ' + parent + '：' + ((e && e.message) || e));
  }
}

function removeQuiet(p, fsImpl) {
  try {
    const st = lstatOf(p, fsImpl);
    if (!st) return true;
    if (st.isDirectory()) fsImpl.rmSync(p, { recursive: true, force: true });
    else fsImpl.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 移动一个文件或目录。
 * @param {object} params
 *   from / to    绝对路径（调用方已经做过范围与敏感校验）
 *   overwrite    目标已存在时是否覆盖
 *   fsImpl       注入的文件系统（测试用假 EXDEV）
 * @returns {{ok:true, strategy:'rename'|'copy+delete', from, to, isDirectory, verified}}
 */
function movePath({ from, to, overwrite = false, fsImpl = defaultFs } = {}) {
  if (!from || !to) throw err(CODE.UNSUPPORTED, 'move 需要 from 与 to');
  const src = statOf(from, fsImpl);
  if (!src) throw err(CODE.SOURCE_MISSING, '源路径不存在：' + from);
  const isDir = src.isDirectory();

  // 目标已存在：先按 overwrite 决定
  let backup = '';
  const dest = statOf(to, fsImpl);
  if (dest) {
    if (!overwrite) {
      throw err(CODE.TARGET_EXISTS, '目标已存在：' + to + '（要覆盖请显式传 overwrite: true）', { targetExists: true });
    }
    // 先把目标挪到旁边：rename 失败时还能还原，不会「覆盖」变「弄丢」
    backup = to + '.aileen-bak-' + Date.now();
    try {
      fsImpl.renameSync(to, backup);
    } catch (e) {
      throw err(CODE.FILE_IN_USE, '目标正在被占用，无法覆盖：' + to + '（' + ((e && e.message) || e) + '）', { targetExists: true });
    }
  }

  const restoreBackup = () => {
    if (!backup) return;
    try {
      if (!fsImpl.existsSync(to)) fsImpl.renameSync(backup, to);
      else removeQuiet(backup, fsImpl);
    } catch { /* 还原失败只能留在 .aileen-bak-* 里，错误里会说明 */ }
  };

  // ① 同卷：rename
  try {
    ensureParentDir(to, fsImpl);
    fsImpl.renameSync(from, to);
    if (backup) removeQuiet(backup, fsImpl);
    return { ok: true, strategy: 'rename', from, to, isDirectory: isDir, verified: { mode: 'rename' } };
  } catch (e) {
    const code = String((e && e.code) || '');
    if (code !== 'EXDEV') {
      restoreBackup();
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        throw err(CODE.FILE_IN_USE, '文件正在被占用，移动失败（源文件没有动）：' + from + '（' + ((e && e.message) || e) + '）');
      }
      throw err(CODE.DEST_PREPARE_FAILED, '移动失败（源文件没有动）：' + from + ' → ' + to + '（' + ((e && e.message) || e) + '）');
    }
  }

  // ② 跨卷：复制 → 验证 → 删除源
  let verified = null;
  try {
    ensureParentDir(to, fsImpl);
    if (isDir) {
      fsImpl.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      const a = treeFingerprint(from, fsImpl);
      const b = treeFingerprint(to, fsImpl);
      if (!sameFingerprint(a, b)) {
        throw err(CODE.VERIFY_FAILED, '跨卷复制后目录内容不一致（源 ' + a.count + ' 个文件 / ' + a.totalBytes
          + ' 字节，目标 ' + b.count + ' 个文件 / ' + b.totalBytes + ' 字节）：' + to);
      }
      verified = { mode: 'tree', files: a.count, bytes: a.totalBytes };
    } else {
      fsImpl.copyFileSync(from, to);
      verified = verifyFile(from, to, fsImpl, src.size);
    }
  } catch (e) {
    // 复制/验证失败：清掉写了一半的目标，**源文件原样保留**
    removeQuiet(to, fsImpl);
    restoreBackup();
    if (e && e.code === CODE.VERIFY_FAILED) throw e;
    throw err(CODE.DEST_PREPARE_FAILED, '跨卷复制失败（源文件保留在 ' + from + '）：' + ((e && e.message) || e), { sourcePreserved: true });
  }

  // ③ 验证通过后才删源
  try {
    if (isDir) fsImpl.rmSync(from, { recursive: true, force: false });
    else fsImpl.unlinkSync(from);
  } catch (e) {
    throw err(CODE.SOURCE_DELETE_FAILED,
      '已复制并验证到目标，但删除源失败（两边都在）：' + from + '（' + ((e && e.message) || e) + '）',
      { sourcePreserved: true, copied: true });
  }
  if (backup) removeQuiet(backup, fsImpl);
  return { ok: true, strategy: 'copy+delete', from, to, isDirectory: isDir, verified };
}

/**
 * 复制一个文件或目录（同样处理 overwrite，并做存在性/大小校验）。
 */
function copyPath({ from, to, overwrite = false, fsImpl = defaultFs } = {}) {
  if (!from || !to) throw err(CODE.UNSUPPORTED, 'copy 需要 from 与 to');
  const src = statOf(from, fsImpl);
  if (!src) throw err(CODE.SOURCE_MISSING, '源路径不存在：' + from);
  const isDir = src.isDirectory();
  const dest = statOf(to, fsImpl);
  if (dest && !overwrite) {
    throw err(CODE.TARGET_EXISTS, '目标已存在：' + to + '（要覆盖请显式传 overwrite: true）', { targetExists: true });
  }
  if (dest && overwrite) {
    if (!removeQuiet(to, fsImpl)) {
      throw err(CODE.FILE_IN_USE, '目标正在被占用，无法覆盖：' + to, { targetExists: true });
    }
  }
  ensureParentDir(to, fsImpl);
  try {
    if (isDir) {
      fsImpl.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      const a = treeFingerprint(from, fsImpl);
      const b = treeFingerprint(to, fsImpl);
      if (!sameFingerprint(a, b)) throw err(CODE.VERIFY_FAILED, '复制后目录内容不一致：' + to);
      return { ok: true, strategy: 'copy', from, to, isDirectory: true, verified: { mode: 'tree', files: a.count, bytes: a.totalBytes } };
    }
    fsImpl.copyFileSync(from, to);
    const verified = verifyFile(from, to, fsImpl, src.size);
    return { ok: true, strategy: 'copy', from, to, isDirectory: false, verified };
  } catch (e) {
    if (e && e.code === CODE.VERIFY_FAILED) throw e;
    throw err(CODE.DEST_PREPARE_FAILED, '复制失败：' + from + ' → ' + to + '（' + ((e && e.message) || e) + '）');
  }
}

module.exports = { CODE, movePath, copyPath, treeFingerprint, verifyFile, MAX_VERIFY_BYTES };
