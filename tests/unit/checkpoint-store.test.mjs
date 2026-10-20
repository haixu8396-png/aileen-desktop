// ============================================================
// Agent 检查点存储（落盘）单测
//
// 用注入的内存 fs，不碰磁盘（unit 目录的约定）。
// 重点不是「能存」，而是：只留最近一次、坏文件不炸、写坏不留半个文件、太大直接拒。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCheckpointStore, MAX_BYTES } = require('../../src/main/storage/checkpoint-store.cjs');

/** 极简内存 fs：记录 rename 次数，好验证「先写 tmp 再改名」 */
function memFs() {
  const files = new Map();
  const calls = { rename: 0, write: 0, unlink: 0 };
  return {
    files,
    calls,
    mkdirSync() {},
    writeFileSync(p, text) { calls.write += 1; files.set(p, String(text)); },
    renameSync(a, b) { calls.rename += 1; files.set(b, files.get(a)); files.delete(a); },
    readFileSync(p) { if (!files.has(p)) throw new Error('ENOENT: ' + p); return files.get(p); },
    existsSync(p) { return files.has(p); },
    unlinkSync(p) { calls.unlink += 1; files.delete(p); },
  };
}

const FILE = 'D:/data/agent/checkpoint.json';

describe('createCheckpointStore', () => {
  it('save → load 往返，内容原样保留', () => {
    const fs = memFs();
    const store = createCheckpointStore({ fs, file: FILE });
    const data = { task: '写测试', checkpoint: { steps: [{ tool: 'read_file' }] }, rounds: 3 };
    expect(store.save(data).ok).toBe(true);
    expect(store.load()).toEqual(data);
  });

  it('只保留最近一次（再存就覆盖）', () => {
    const fs = memFs();
    const store = createCheckpointStore({ fs, file: FILE });
    store.save({ task: '任务 A' });
    store.save({ task: '任务 B' });
    expect(store.load().task).toBe('任务 B');
  });

  it('原子写：先写 .tmp 再 rename，正常路径不留下 tmp', () => {
    const fs = memFs();
    const store = createCheckpointStore({ fs, file: FILE });
    store.save({ task: 'x' });
    expect(fs.calls.rename).toBe(1);
    expect(fs.files.has(FILE + '.tmp')).toBe(false);
  });

  it('没有文件时返回 null（首次使用不是错误）', () => {
    const store = createCheckpointStore({ fs: memFs(), file: FILE });
    expect(store.load()).toBeNull();
  });

  it('文件坏了返回 null 且不抛（应用照常启动）', () => {
    const fs = memFs();
    fs.files.set(FILE, '{ 这不是 JSON');
    const store = createCheckpointStore({ fs, file: FILE });
    expect(store.load()).toBeNull();
  });

  it('清除之后读不到；重复清除也不报错', () => {
    const fs = memFs();
    const store = createCheckpointStore({ fs, file: FILE });
    store.save({ task: 'x' });
    expect(store.clear()).toBe(true);
    expect(store.load()).toBeNull();
    expect(store.clear()).toBe(true);
  });

  it('不是对象、太大的一律拒绝（不写坏文件）', () => {
    const fs = memFs();
    const store = createCheckpointStore({ fs, file: FILE });
    expect(store.save(null).ok).toBe(false);
    expect(store.save('文本').ok).toBe(false);
    const huge = { task: 'x'.repeat(MAX_BYTES + 10) };
    expect(store.save(huge).ok).toBe(false);
    expect(fs.files.has(FILE)).toBe(false);
  });

  it('写入抛错时清理 tmp 并返回失败原因', () => {
    const fs = memFs();
    fs.renameSync = () => { throw new Error('EBUSY'); };
    const store = createCheckpointStore({ fs, file: FILE });
    const res = store.save({ task: 'x' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('EBUSY');
    expect(fs.files.has(FILE + '.tmp')).toBe(false);
  });
});
