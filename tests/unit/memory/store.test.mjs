import { describe, it, expect } from 'vitest';
import { createStore, createMemoryFs, MEMORY_FILE_NAME, STORE_VERSION, TEMP_SUFFIX } from '../../../src/memory/store.js';
import { createMemoryEngine } from '../../../src/memory/engine.js';

const T0 = 1730000000000;
const FILE = 'mem/' + MEMORY_FILE_NAME;

function record(over = {}) {
  // 必须每次返回**新对象**：Object.assign({}, 常量, over) 会改到模板本身，
  // 于是第二次调用拿到的 content 是上一次改过的值（这个坑真踩过）
  return Object.assign({
    id: 'mem-1',
    content: '用户喜欢猫',
    type: 'preference',
    importance: 0.8,
    confidence: 0.7,
    created_at: T0,
    updated_at: T0,
    status: 'active',
    embedding: [0.1, 0.2],
  }, Object.assign({}, over));
}

describe('store：基础读写', () => {
  it('文件不存在时返回空库，且不算错误（首次运行是正常的）', async () => {
    const fs = createMemoryFs();
    const store = createStore({ fs, filePath: FILE });
    const result = await store.load();
    expect(result.records).toEqual([]);
    expect(result.corrupted).toBe(false);
    expect(result.error).toBeNull();
    expect(store.lastError()).toBeNull();
  });

  it('save → load 往返一致，且文件里有 version/count', async () => {
    const fs = createMemoryFs();
    const store = createStore({ fs, filePath: FILE });
    await store.load();
    store.upsert(record());
    await store.save();

    const raw = JSON.parse(fs.files.get(FILE));
    expect(raw.version).toBe(STORE_VERSION);
    expect(raw.count).toBe(1);

    const other = createStore({ fs, filePath: FILE });
    const loaded = await other.load();
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0].content).toBe('用户喜欢猫');
    expect(loaded.records[0].embedding).toEqual([0.1, 0.2]);
  });

  it('upsert 按 id 覆盖，按内容指纹去重（同一句话不产生第二条）', async () => {
    const fs = createMemoryFs();
    const store = createStore({ fs, filePath: FILE });
    await store.load();

    const first = store.upsert(record());
    expect(first.inserted).toBe(true);
    expect(store.size()).toBe(1);

    // 同一句话换个 id 再写一次 → 按**内容指纹**命中同一条，不产生第二条
    const dup = store.upsert(record({ id: 'mem-2' }));
    expect(dup.inserted).toBe(false);
    expect(dup.record.id).toBe('mem-1');
    expect(store.size()).toBe(1);

    // 同 id 但内容变了 → 覆盖（created_at 保留，表示「第一次出现的时间」不变）
    const second = store.upsert(record({ content: '用户非常喜欢猫', created_at: T0 + 999 }));
    expect(second.inserted).toBe(false);
    expect(second.record.created_at).toBe(T0);
    expect(second.record.content).toBe('用户非常喜欢猫');
    expect(store.size()).toBe(1);

    // 内容不同则是另一条记忆（指纹只对「同一句话」生效，不对近义句生效）
    const fourth = store.upsert(record({ id: 'mem-3', content: '用户住在杭州' }));
    expect(fourth.inserted).toBe(true);
    expect(store.size()).toBe(2);
  });

  it('getById / all / byType / byStatus 过滤正确', async () => {
    const store = createStore({ fs: createMemoryFs(), filePath: FILE });
    await store.load();
    store.upsert(record({ id: 'a', content: '用户喜欢猫', type: 'preference' }));
    store.upsert(record({ id: 'b', content: '用户住在杭州', type: 'user_fact' }));
    store.upsert(record({ id: 'c', content: '用户讨厌下雨', type: 'preference', status: 'archived' }));

    expect(store.getById('b').content).toBe('用户住在杭州');
    expect(store.getById('nope')).toBeNull();
    expect(store.all()).toHaveLength(3);
    expect(store.all({ statuses: ['active'] })).toHaveLength(2);
    expect(store.byType('preference')).toHaveLength(2);
    expect(store.byStatus('archived')).toHaveLength(1);
    expect(store.all({ since: T0 + 1 })).toHaveLength(0);
    expect(store.counts().byStatus.active).toBe(2);
  });

  it('缺少必要字段时 upsert 抛中文错误', async () => {
    const store = createStore({ fs: createMemoryFs(), filePath: FILE });
    await store.load();
    expect(() => store.upsert({ id: '', content: 'x' })).toThrow('upsert 需要 id');
    expect(() => store.upsert({ id: 'mem-x', content: '   ' })).not.toThrow();
  });
});

describe('store：健壮性（不许把应用炸掉）', () => {
  it('文件是坏 JSON → 返回空库 + 原因，原文件保留不删', async () => {
    const fs = createMemoryFs({ [FILE]: '{ 这不是 JSON' });
    const store = createStore({ fs, filePath: FILE });
    const result = await store.load();

    expect(result.records).toEqual([]);
    expect(result.corrupted).toBe(true);
    expect(result.error).toContain('不是合法 JSON');
    expect(store.lastError()).toContain('不是合法 JSON');
    expect(store.size()).toBe(0);
    // 原文件保留（用户可能想手工抢救）
    expect(fs.files.get(FILE)).toBe('{ 这不是 JSON');
  });

  it('结构不对（不是数组也没有 records）→ 同样降级为空库', async () => {
    const fs = createMemoryFs({ [FILE]: '{"foo":1}' });
    const store = createStore({ fs, filePath: FILE });
    const result = await store.load();
    expect(result.corrupted).toBe(true);
    expect(result.error).toContain('结构不对');
    expect(store.size()).toBe(0);
  });

  it('读取直接失败（非 ENOENT）也不会抛穿', async () => {
    const fs = createMemoryFs();
    fs.readFile = async () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
    const store = createStore({ fs, filePath: FILE });
    const result = await store.load();
    expect(result.corrupted).toBe(true);
    expect(result.error).toContain('读取记忆文件失败');
  });

  it('个别记录缺 id/content 时跳过它们，其余照常载入', async () => {
    const payload = JSON.stringify({ version: 1, records: [record(), { content: '' }, { id: 'mem-9' }] });
    const fs = createMemoryFs({ [FILE]: payload });
    const store = createStore({ fs, filePath: FILE });
    const result = await store.load();
    expect(result.records).toHaveLength(1);
    expect(result.error).toContain('跳过');
  });

  it('engine 遇到坏文件也能起来：空库 + loadError 记录，随后照常写入', async () => {
    const fs = createMemoryFs({ [FILE]: 'not json at all' });
    const logs = [];
    const engine = createMemoryEngine({
      fs, filePath: FILE, embedConfig: { enabled: false }, now: () => T0,
      logger: (m) => logs.push(m),
    });
    const stats = await engine.stats();
    expect(stats.corrupted).toBe(true);
    expect(stats.loadError).toContain('不是合法 JSON');
    expect(stats.total).toBe(0);
    expect(logs.join('|')).toContain('记忆库载入异常');

    // 写入仍然正常，并且把文件修复成合法 JSON
    const rec = await engine.remember({ content: '用户喜欢猫', type: 'preference', importance: 0.8 });
    expect(rec.id).toBeTruthy();
    expect(() => JSON.parse(fs.files.get(FILE))).not.toThrow();
    expect((await engine.stats()).corrupted).toBe(true); // 本次载入的历史事实，不谎报
  });
});

describe('store：原子写', () => {
  it('写入顺序一定是「先临时文件、后 rename」，不留 *.tmp', async () => {
    const fs = createMemoryFs();
    const store = createStore({ fs, filePath: FILE });
    await store.load();
    store.upsert(record());
    await store.save();

    const ops = fs.log.map((entry) => entry.op + ':' + (entry.to || entry.path));
    const writeIdx = fs.log.findIndex((e) => e.op === 'writeFile');
    const renameIdx = fs.log.findIndex((e) => e.op === 'rename');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeGreaterThan(writeIdx);
    expect(fs.log[writeIdx].path).toBe(FILE + TEMP_SUFFIX);
    expect(fs.log[renameIdx].to).toBe(FILE);

    // 临时文件被 rename 掉了：目录里只剩正式文件
    expect(fs.files.has(FILE + TEMP_SUFFIX)).toBe(false);
    expect(fs.files.has(FILE)).toBe(true);
    expect(fs.log.some((entry) => entry.op === 'writeFile' && entry.path === FILE)).toBe(false);
    expect(ops.length).toBeGreaterThan(0);
  });

  it('写临时文件失败时，旧文件保持完整可读（不会被写成半个 JSON）', async () => {
    const fs = createMemoryFs();
    const store = createStore({ fs, filePath: FILE });
    await store.load();
    store.upsert(record());
    await store.save();
    const before = fs.files.get(FILE);

    // 模拟磁盘满：写临时文件直接失败，rename 永远执行不到
    const failing = createStore({
      fs: Object.assign({}, fs, {
        writeFile: async (p) => {
          if (String(p).endsWith(TEMP_SUFFIX)) throw new Error('ENOSPC: 磁盘已满');
          return fs.writeFile(p, 'x', 'utf8');
        },
      }),
      filePath: FILE,
    });
    await failing.load();
    failing.upsert(record({ id: 'mem-2', content: '用户住在杭州' }));

    await expect(failing.save()).rejects.toThrow('ENOSPC');
    // 正式文件一个字节都没变，且仍然是合法 JSON、仍然只有旧的那一条
    expect(fs.files.get(FILE)).toBe(before);
    const parsed = JSON.parse(fs.files.get(FILE));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].content).toBe('用户喜欢猫');
    expect(fs.files.has(FILE + TEMP_SUFFIX)).toBe(false);
  });

  it('目录不存在时会先建目录', async () => {
    const fs = createMemoryFs();
    const store = createStore({ fs, filePath: 'deep/nested/dir/' + MEMORY_FILE_NAME });
    await store.load();
    store.upsert(record());
    await store.save();
    expect(fs.dirs.has('deep/nested/dir')).toBe(true);
    expect(fs.files.has('deep/nested/dir/' + MEMORY_FILE_NAME)).toBe(true);
  });

  it('fs 接口不完整时立刻报错（避免运行到一半才发现）', () => {
    expect(() => createStore({})).toThrow('需要注入 fs 接口');
    expect(() => createStore({ fs: { readFile: async () => '' } })).toThrow('缺少方法');
  });
});
