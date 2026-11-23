// ============================================================
// shared/fs-move.cjs 单测：同卷 rename / 跨卷「复制 → 校验 → 删源」/ 覆盖 / 失败保留源
//
// 跨卷在单机上没法真的造第二个盘，所以用假 fsImpl 让 rename 抛 EXDEV ——
// 这正是 Windows 上跨盘移动的真实错误码。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsMove from '../../shared/fs-move.cjs';

const { movePath, copyPath, CODE } = fsMove;

let base;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-move-'));
});
afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 让 rename 抛 EXDEV 的 fs（其它方法都走真实 fs） */
function crossVolumeFs() {
  const impl = Object.create(fs);
  impl.renameSync = () => {
    const e = new Error('EXDEV: cross-device link not permitted');
    e.code = 'EXDEV';
    throw e;
  };
  return impl;
}

const write = (name, text) => {
  const p = path.join(base, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
};

describe('同卷移动（rename）', () => {
  it('移动文件：源没了、目标内容对', () => {
    const from = write('a.txt', 'hello');
    const to = path.join(base, 'sub', 'b.txt');
    const r = movePath({ from, to });
    expect(r.strategy).toBe('rename');
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(to, 'utf8')).toBe('hello');
  });

  it('同一目录下换个名字 = 重命名', () => {
    const from = write('old.txt', 'x');
    const to = path.join(base, 'new.txt');
    movePath({ from, to });
    expect(fs.existsSync(to)).toBe(true);
    expect(fs.existsSync(from)).toBe(false);
  });

  it('目标已存在 + overwrite=false → TARGET_EXISTS，两边都还在', () => {
    const from = write('a.txt', 'A');
    const to = write('b.txt', 'B');
    expect(() => movePath({ from, to })).toThrow(/目标已存在/);
    try { movePath({ from, to }); } catch (e) { expect(e.code).toBe(CODE.TARGET_EXISTS); }
    expect(fs.readFileSync(from, 'utf8')).toBe('A');
    expect(fs.readFileSync(to, 'utf8')).toBe('B');
  });

  it('目标已存在 + overwrite=true → 覆盖，且不留备份文件', () => {
    const from = write('a.txt', 'A');
    const to = write('b.txt', 'B');
    movePath({ from, to, overwrite: true });
    expect(fs.readFileSync(to, 'utf8')).toBe('A');
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readdirSync(base).filter((n) => n.includes('aileen-bak'))).toHaveLength(0);
  });
});

describe('跨卷移动（复制 → 校验 → 删源）', () => {
  it('文件跨卷：策略是 copy+delete，内容校验通过，源被删除', () => {
    const from = write('big.txt', 'x'.repeat(5000));
    const to = path.join(base, 'moved', 'big.txt');
    const r = movePath({ from, to, fsImpl: crossVolumeFs() });
    expect(r.strategy).toBe('copy+delete');
    expect(r.verified.mode).toBe('hash');
    expect(fs.readFileSync(to, 'utf8').length).toBe(5000);
    expect(fs.existsSync(from)).toBe(false);
  });

  it('目录跨卷：按「条目 + 总字节」校验后删源', () => {
    write('dir/a.txt', 'aa');
    write('dir/sub/b.txt', 'bbb');
    const from = path.join(base, 'dir');
    const to = path.join(base, 'dir-moved');
    const r = movePath({ from, to, fsImpl: crossVolumeFs() });
    expect(r.strategy).toBe('copy+delete');
    expect(r.verified.mode).toBe('tree');
    expect(r.verified.files).toBe(2);
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(path.join(to, 'sub', 'b.txt'), 'utf8')).toBe('bbb');
  });

  it('校验失败：源必须还在，写了一半的目标被清掉', () => {
    const from = write('f.txt', 'good');
    const to = path.join(base, 'target', 'f.txt');
    const impl = crossVolumeFs();
    impl.copyFileSync = (s, t) => fs.writeFileSync(t, 'corrupted');
    let code = '';
    try { movePath({ from, to, fsImpl: impl }); } catch (e) { code = e.code; }
    expect(code).toBe(CODE.VERIFY_FAILED);
    expect(fs.readFileSync(from, 'utf8')).toBe('good');
    expect(fs.existsSync(to)).toBe(false);
  });

  it('rename 报 EBUSY/EPERM（文件被占用）→ 不复制兜底，源原样保留', () => {
    const from = write('locked.txt', 'data');
    const to = path.join(base, 'locked2.txt');
    const impl = Object.create(fs);
    impl.renameSync = () => {
      const e = new Error('EBUSY: resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    };
    let code = '';
    try { movePath({ from, to, fsImpl: impl }); } catch (e) { code = e.code; }
    expect(code).toBe(CODE.FILE_IN_USE);
    expect(fs.readFileSync(from, 'utf8')).toBe('data');
    expect(fs.existsSync(to)).toBe(false);
  });

  it('源不存在 → SOURCE_MISSING', () => {
    let code = '';
    try { movePath({ from: path.join(base, 'nope.txt'), to: path.join(base, 'x.txt') }); } catch (e) { code = e.code; }
    expect(code).toBe(CODE.SOURCE_MISSING);
  });
});

describe('复制', () => {
  it('复制文件后源还在、目标校验通过', () => {
    const from = write('src.txt', 'copy me');
    const to = path.join(base, 'out', 'dst.txt');
    const r = copyPath({ from, to });
    expect(r.verified.mode).toBe('hash');
    expect(fs.existsSync(from)).toBe(true);
    expect(fs.readFileSync(to, 'utf8')).toBe('copy me');
  });

  it('目标已存在：默认拒绝，overwrite=true 覆盖', () => {
    const from = write('src.txt', 'new');
    const to = write('dst.txt', 'old');
    expect(() => copyPath({ from, to })).toThrow(/目标已存在/);
    copyPath({ from, to, overwrite: true });
    expect(fs.readFileSync(to, 'utf8')).toBe('new');
  });
});
