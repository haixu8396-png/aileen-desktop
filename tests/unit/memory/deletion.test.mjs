import { describe, it, expect } from 'vitest';
import { createMemoryEngine, createMemoryFs } from '../../../src/memory/engine.js';
import { createMemoryEmbedder, hasVector } from '../../../src/memory/embeddings.js';
import { MEMORY_STATUS } from '../../../src/memory/types.js';

const T0 = 1730000000000;

function engineAt(now = T0) {
  return createMemoryEngine({
    fs: createMemoryFs(),
    filePath: 'memory.json',
    embedConfig: { enabled: false },
    now: () => now,
  });
}

describe('deletion：软删除', () => {
  it('forget 之后默认搜不到，但记录仍然在库里（status=deleted）', async () => {
    const engine = engineAt();
    const rec = await engine.remember({ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 });

    const forgotten = await engine.forget(rec.id);
    expect(forgotten.status).toBe('deleted');

    // 默认检索（statuses 默认 ['active']）搜不到
    expect(await engine.search('Luna 猫', { k: 5 })).toHaveLength(0);

    // 但记录没被删
    const still = await engine.get(rec.id);
    expect(still).not.toBeNull();
    expect(still.status).toBe('deleted');
    expect(still.content).toContain('Luna');
    expect(await engine.allRecords()).toHaveLength(1);
    expect((await engine.stats()).byStatus.deleted).toBe(1);
  });

  it('重复 forget 是幂等的，不存在的 id 返回 null', async () => {
    const engine = engineAt();
    const rec = await engine.remember({ content: '用户喜欢猫', type: 'preference', importance: 0.8 });
    await engine.forget(rec.id);
    const again = await engine.forget(rec.id);
    expect(again.status).toBe('deleted');
    expect(await engine.forget('mem-not-exist')).toBeNull();
  });

  it('软删除的记录仍然可以显式检索出来（可追溯）', async () => {
    const engine = engineAt();
    const rec = await engine.remember({ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 });
    await engine.forget(rec.id);
    const hits = await engine.search('Luna 猫', { k: 5, statuses: ['deleted'] });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(rec.id);
  });
});

describe('deletion：forgetBelow 按 importance 批量归档', () => {
  it('只影响低于阈值的，等于阈值的保留', async () => {
    const engine = engineAt();
    // 三条刻意选成「不会互相合并」的不同主题：
    // 如果两条被判为同一件事，它们会被合并成一条（importance 取高者），
    // 那样就测不出「只归档低分的那条」了。
    const low = await engine.remember({ content: '用户随口提过喜欢蓝色', type: 'preference', importance: 0.2 });
    const edge = await engine.remember({ content: '用户明确说不吃香菜', type: 'preference', importance: 0.5 });
    const high = await engine.remember({ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.9 });
    expect((await engine.allRecords())).toHaveLength(3);

    const result = await engine.forgetBelow(0.5);
    expect(result.count).toBe(1);
    expect(result.threshold).toBe(0.5);

    expect((await engine.get(low.id)).status).toBe('archived');
    expect((await engine.get(edge.id)).status).toBe('active');
    expect((await engine.get(high.id)).status).toBe('active');

    // 归档不是删除：记录都在，只是默认搜不到
    expect(await engine.allRecords()).toHaveLength(3);
    const stats = await engine.stats();
    expect(stats.byStatus.archived).toBe(1);
    expect(stats.byStatus.active).toBe(2);
    // 用只可能命中「蓝色」那条的查询验证状态过滤（别的记忆跟它没有公共词）
    const found = await engine.search('蓝色', { k: 5, statuses: ['archived'] });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(low.id);
    expect(await engine.search('蓝色', { k: 5 })).toHaveLength(0);
  });

  it('阈值非法时收敛到 0（不会把全库误归档）', async () => {
    const engine = engineAt();
    await engine.remember({ content: '用户喜欢猫', type: 'preference', importance: 0.8 });
    const result = await engine.forgetBelow(-5);
    expect(result.threshold).toBe(0);
    expect(result.count).toBe(0);
  });

  it('已经 superseded / deleted 的记录不会被 forgetBelow 再动一次', async () => {
    const engine = engineAt();
    const old = await engine.remember({ content: '用户准备购买 RTX 4070', type: 'preference', importance: 0.2 });
    await engine.remember({ content: '用户现在准备购买 RTX 5080', type: 'preference', importance: 0.2 });
    expect((await engine.get(old.id)).status).toBe('superseded');

    const result = await engine.forgetBelow(0.9);
    // 只归档那条 active 的
    expect(result.count).toBe(1);
    expect((await engine.get(old.id)).status).toBe('superseded');
  });
});

describe('update：局部更新', () => {
  it('改内容会重新算 embedding（否则检索就废了）', async () => {
    const engine = engineAt();
    const rec = await engine.remember({ content: '用户喜欢猫', type: 'preference', importance: 0.6 });
    const before = (await engine.get(rec.id)).embedding;

    const updated = await engine.update(rec.id, { content: '用户喜欢狗', importance: 0.9, source: 'manual' });
    expect(updated.content).toBe('用户喜欢狗');
    expect(updated.importance).toBe(0.9);
    expect(updated.source).toBe('manual');
    expect(updated.updated_at).toBe(T0);
    // 向量仍然存在，且与新内容一致（重新嵌入过）
    expect(hasVector(updated.embedding)).toBe(true);
    expect(updated.embedding).not.toEqual(before);
  });

  it('不可改字段被忽略（id / embedding / created_at）', async () => {
    const engine = engineAt();
    const rec = await engine.remember({ content: '用户喜欢猫', type: 'preference', importance: 0.6 });
    const updated = await engine.update(rec.id, {
      id: 'mem-hacked', embedding: [1, 2, 3], created_at: 0, importance: 0.7,
    });
    expect(updated.id).toBe(rec.id);
    expect(updated.created_at).toBe(rec.created_at);
    expect(updated.embedding.length).not.toBe(3);
    expect(updated.importance).toBe(0.7);
  });

  it('更新不存在的 id 会抛中文错误', async () => {
    const engine = engineAt();
    await expect(engine.update('mem-nope', { importance: 0.5 })).rejects.toThrow('找不到记忆');
  });

  it('update 会同步落盘（重新开引擎仍能读到）', async () => {
    const fs = createMemoryFs();
    const e1 = createMemoryEngine({ fs, filePath: 'memory.json', embedConfig: { enabled: false }, now: () => T0 });
    const rec = await e1.remember({ content: '用户喜欢猫', type: 'preference', importance: 0.6 });
    await e1.update(rec.id, { content: '用户非常喜欢猫', importance: 0.95 });

    const e2 = createMemoryEngine({ fs, filePath: 'memory.json', embedConfig: { enabled: false }, now: () => T0 });
    const reloaded = await e2.get(rec.id);
    expect(reloaded.content).toBe('用户非常喜欢猫');
    expect(reloaded.importance).toBe(0.95);
  });
});

describe('stats 与状态常量', () => {
  it('stats 报得出各状态数量与 embedding 模式', async () => {
    const engine = engineAt();
    const a = await engine.remember({ content: '用户喜欢猫', type: 'preference', importance: 0.9 });
    await engine.remember({ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 });
    await engine.forget(a.id);

    const stats = await engine.stats();
    expect(stats.total).toBe(2);
    expect(stats.byStatus.deleted).toBe(1);
    expect(stats.byStatus.active).toBe(1);
    expect(stats.embeddingMode).toBe('local');
    expect(stats.types).toEqual(['user_fact', 'preference', 'experience', 'relationship', 'knowledge']);
    expect(MEMORY_STATUS).toEqual(['active', 'superseded', 'archived', 'deleted']);
    expect(stats.corrupted).toBe(false);
    expect(stats.loadError).toBeNull();
  });

  it('embedder 是记忆模块自己的封装，离线时给本地向量', async () => {
    const embedder = createMemoryEmbedder({ config: { enabled: false } });
    const vec = await embedder.embedOne('用户喜欢猫');
    expect(vec.length).toBeGreaterThan(0);
    expect(hasVector(vec)).toBe(true);
    expect(embedder.mode()).toBe('local');
    expect(embedder.stats().lastFallbackReason).toBe('disabled');
  });
});
