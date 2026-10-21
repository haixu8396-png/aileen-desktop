// ZIP 读取器（shared/zip.cjs）—— 模型导入直接吃 zip，所以这只手得自己稳。
// 测试里现造 zip（store / deflate 两种），不依赖任何外部压缩包文件。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readZipEntries, extractZipBuffer, safeEntryPath } from '../../shared/zip.cjs';

/** 造一个最小可用的 zip；deflate: true 时用 deflate 压 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const method = e.deflate ? 8 : 0;
    const body = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const flags = 0x0800; // UTF-8 文件名
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);          // crc（读取器不校验）
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    locals.push(local, nameBuf, body);
    offset += 30 + nameBuf.length + body.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(e.extAttrs || 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBuf);
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cdBuf, eocd]);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-zip-'));
}

const MODEL_JSON = JSON.stringify({
  Version: 3,
  FileReferences: { Moc: 'haru.moc3', Textures: ['textures/00.png'] },
});

describe('zip：读取与解压', () => {
  it('store 与 deflate 两种都能解出原样字节', () => {
    const buf = makeZip([
      { name: 'a.txt', data: 'hello store' },
      { name: 'b.txt', data: 'hello deflate hello deflate', deflate: true },
    ]);
    const dir = tmpDir();
    const out = extractZipBuffer(buf, dir);
    expect(out.files.sort()).toEqual(['a.txt', 'b.txt']);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hello store');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('hello deflate hello deflate');
  });

  it('嵌套目录会建出来，并认出 Live2D 配置', () => {
    const buf = makeZip([
      { name: 'haru/haru.model3.json', data: MODEL_JSON },
      { name: 'haru/haru.moc3', data: Buffer.from([1, 2, 3, 4]) },
      { name: 'haru/textures/00.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const dir = tmpDir();
    const out = extractZipBuffer(buf, dir);
    expect(out.modelJsons).toEqual(['haru/haru.model3.json']);
    expect(fs.existsSync(path.join(dir, 'haru', 'textures', '00.png'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'haru', 'haru.moc3')).length).toBe(4);
  });

  it('model3.json 在 zip 根目录时也能认出来', () => {
    const buf = makeZip([{ name: 'model3.json', data: MODEL_JSON }]);
    const dir = tmpDir();
    expect(extractZipBuffer(buf, dir).modelJsons).toEqual(['model3.json']);
  });

  it('目录条目和系统垃圾（__MACOSX / .DS_Store）被跳过', () => {
    const buf = makeZip([
      { name: 'haru/', data: '' },
      { name: '__MACOSX/._haru.model3.json', data: 'junk' },
      { name: 'haru/.DS_Store', data: 'junk' },
      { name: 'haru/haru.model3.json', data: MODEL_JSON },
    ]);
    const dir = tmpDir();
    const out = extractZipBuffer(buf, dir);
    expect(out.files).toEqual(['haru/haru.model3.json']);
    expect(out.skipped.length).toBe(3);
    expect(fs.existsSync(path.join(dir, '__MACOSX'))).toBe(false);
  });

  it('符号链接条目被跳过（不往模型目录里写链接）', () => {
    const buf = makeZip([
      { name: 'link', data: '/etc/passwd', extAttrs: (0o120777 << 16) >>> 0 },
      { name: 'haru/haru.model3.json', data: MODEL_JSON },
    ]);
    const dir = tmpDir();
    const out = extractZipBuffer(buf, dir);
    expect(out.files).toEqual(['haru/haru.model3.json']);
    expect(fs.existsSync(path.join(dir, 'link'))).toBe(false);
  });

  it('目录穿越会被拒绝（../ / 绝对路径 / 盘符）', () => {
    expect(() => extractZipBuffer(makeZip([{ name: '../evil.txt', data: 'x' }]), tmpDir())).toThrow(/跳出目标目录/);
    expect(() => extractZipBuffer(makeZip([{ name: '/etc/passwd', data: 'x' }]), tmpDir())).toThrow(/绝对路径/);
    expect(() => extractZipBuffer(makeZip([{ name: 'C:/Windows/win.ini', data: 'x' }]), tmpDir())).toThrow(/盘符/);
    expect(() => safeEntryPath('a/../../b')).toThrow();
  });

  it('条目数超过上限直接拒绝（zip bomb 的第一道闸）', () => {
    const many = [];
    for (let i = 0; i < 50; i += 1) many.push({ name: 'f' + i + '.txt', data: 'x' });
    expect(() => extractZipBuffer(makeZip(many), tmpDir(), { maxEntries: 10 })).toThrow(/条目太多/);
  });

  it('解压后总大小超过上限直接拒绝', () => {
    const big = 'x'.repeat(4096);
    const buf = makeZip([{ name: 'a.txt', data: big }, { name: 'b.txt', data: big }]);
    expect(() => extractZipBuffer(buf, tmpDir(), { maxTotalBytes: 1024 })).toThrow(/总大小超过上限/);
  });

  it('不是 zip / 被截断 / 加密 / ZIP64 都报错而不是瞎解', () => {
    expect(() => readZipEntries(Buffer.from('这不是压缩包'))).toThrow(/ZIP/);
    const good = makeZip([{ name: 'a.txt', data: 'x' }]);
    expect(() => readZipEntries(good.subarray(0, good.length - 30))).toThrow(/ZIP/);

    // 加密：中央目录的 flags bit0
    const enc = makeZip([{ name: 'a.txt', data: 'x' }]);
    const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    enc.writeUInt16LE(1, cd + 8);
    expect(() => extractZipBuffer(enc, tmpDir())).toThrow(/加密/);

    // ZIP64：EOCD 里把条目数写成 0xFFFF
    const z64 = makeZip([{ name: 'a.txt', data: 'x' }]);
    const eocd = z64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    z64.writeUInt16LE(0xffff, eocd + 10);
    expect(() => readZipEntries(z64)).toThrow(/ZIP64/);
  });
});
