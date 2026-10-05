import { describe, it, expect } from 'vitest';
import { createMemoryEngine, createMemoryFs } from '../../../src/memory/engine.js';
import { rewriteQuery, extractKeywords, recall, blendRelevance, RELEVANCE_FLOOR } from '../../../src/memory/retriever.js';
import { estimateTokens, PER_MEMORY_OVERHEAD_TOKENS } from '../../../src/memory/budget.js';
import { makeRecord } from '../../../src/memory/types.js';

const T0 = 1730000000000;

/** 一个完全离线的引擎（enabled:false → 本地词频向量 + 关键词兜底） */
function offlineEngine(extra = {}) {
  return createMemoryEngine({
    fs: createMemoryFs(),
    filePath: 'memory.json',
    embedConfig: { enabled: false },
    now: () => T0,
    ...extra,
  });
}

async function seed(engine, list) {
  const out = [];
  for (const item of list) out.push(await engine.remember(item));
  return out;
}

/**
 * 直接把记录摆进库里（绕过 consolidation）。
 *
 * 为什么需要：召回测试要的是「库里有 3 条、查询该召回哪几条」，
 * 而这些测试数据彼此相似时会被 consolidation 合并成一条 ——
 * 那样测的就不是召回了。合并行为另有 consolidation.test.mjs 专门覆盖。
 */
async function seedRaw(engine, list, at = T0) {
  const records = [];
  for (const item of list) {
    const rec = makeRecord({
      content: item.content,
      type: item.type || 'preference',
      importance: item.importance == null ? 0.8 : item.importance,
      confidence: item.confidence == null ? 0.8 : item.confidence,
      source: item.source || 'test',
    }, at);
    records.push(rec);
  }
  const vectors = await engine.internals.embedder.embed(records.map((r) => r.content));
  records.forEach((rec, i) => { rec.embedding = vectors[i]; });
  const store = engine.internals.store;
  await store.load();
  store.upsertMany(records);
  await store.save();
  await engine.stats(); // 触发一次载入，保证后续检索看到的是同一份数据
  return records;
}

describe('Query Rewrite：规则式改写', () => {
  it('去掉句首客套与句尾语气词', () => {
    const r = rewriteQuery('请问我的猫叫什么名字呢？');
    expect(r.rewritten).toBe('我的猫叫什么名字');
    expect(r.removed).toContain('请问');
    expect(r.keywords.length).toBeGreaterThan(0);
  });

  it('英文疑问句同样处理', () => {
    const r = rewriteQuery('Can you tell me what my cat name is');
    expect(r.rewritten.toLowerCase()).not.toContain('can you');
  });

  it('全疑问词时不改写成空串（否则什么都召不回）', () => {
    const r = rewriteQuery('什么？');
    expect(r.rewritten.length).toBeGreaterThan(0);
  });

  it('关键词抽取：单字查询也能留下关键词', () => {
    expect(extractKeywords('猫')).toContain('猫');
    expect(extractKeywords('my cat Luna')).toContain('luna');
  });
});

describe('retrieval：语义相关能召回、无关召不回', () => {
  it('相关记忆排在最前', async () => {
    const engine = offlineEngine();
    await seed(engine, [
      { content: '用户养了一只猫叫 Luna，已经三岁了', type: 'relationship', importance: 0.85 },
      { content: '用户准备买 RTX 4070', type: 'preference', importance: 0.8 },
      { content: '用户最喜欢初音未来的歌', type: 'preference', importance: 0.9 },
      { content: '用户住在杭州', type: 'user_fact', importance: 0.7 },
    ]);

    const hits = await engine.search('我的猫叫什么名字？', { k: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('Luna');

    const gpu = await engine.search('我打算买什么显卡', { k: 2 });
    expect(gpu[0].content).toContain('RTX');
  });

  it('毫不相关的内容不会出现在结果里', async () => {
    const engine = offlineEngine();
    await seed(engine, [
      { content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 },
      { content: '用户最喜欢初音未来的歌', type: 'preference', importance: 0.9 },
    ]);
    const hits = await engine.search('quantum entanglement experiment protocol', { k: 5 });
    expect(hits).toHaveLength(0);
  });

  it('空库检索返回空数组而不是报错', async () => {
    const engine = offlineEngine();
    expect(await engine.search('随便问点什么', { k: 3 })).toEqual([]);
  });
});

describe('retrieval：k 与 budgetTokens 生效', () => {
  it('k 限制返回条数（召回可以更多，精排后截断）', async () => {
    const engine = offlineEngine();
    // 三条不同主题，确保不会被 consolidation 合并成一条
    await seedRaw(engine, [
      { content: '用户喜欢猫', type: 'preference', importance: 0.9 },
      { content: '用户喜欢编程', type: 'preference', importance: 0.6 },
      { content: '用户喜欢旅行', type: 'preference', importance: 0.3 },
    ]);

    const one = await engine.search('用户喜欢什么', { k: 1 });
    expect(one).toHaveLength(1);
    expect(one[0].content).toBe('用户喜欢猫');

    const all = await engine.search('用户喜欢什么', { k: 3 });
    expect(all).toHaveLength(3);
    // relevance 相同的情况下 importance 决定顺序
    expect(all[0].content).toBe('用户喜欢猫');
    expect(all[2].content).toBe('用户喜欢旅行');
  });

  it('budgetTokens 生效：超出预算时从低分端裁掉，并回报被裁的条目', async () => {
    const engine = offlineEngine();
    await seedRaw(engine, [
      { content: '用户喜欢骑自行车去故宫', type: 'preference', importance: 0.9 },
      { content: '用户喜欢骑自行车去798', type: 'preference', importance: 0.8 },
      { content: '用户喜欢骑自行车去朝阳公园', type: 'preference', importance: 0.2 },
    ]);

    const loose = await engine.searchDetailed('用户骑自行车', { k: 3, budgetTokens: 2000 });
    expect(loose.memories).toHaveLength(3);
    expect(loose.dropped).toHaveLength(0);

    // 预算只够两条：必须真的裁，并且把裁掉的回报出来
    const tight = await engine.searchDetailed('用户骑自行车', { k: 3, budgetTokens: 35 });
    expect(tight.memories.length).toBeLessThan(3);
    expect(tight.dropped.length).toBeGreaterThan(0);
    expect(tight.usedTokens).toBeLessThanOrEqual(tight.budgetTokens);
    expect(tight.memories.length + tight.dropped.length).toBe(3);
    // 裁掉的一定是最低分那几条（dropped 是低分端）
    const keptMin = Math.min(...tight.ranked.slice(0, tight.memories.length).map((c) => c.score));
    expect(keptMin).toBeGreaterThanOrEqual(Math.max(...tight.dropped.map((c) => c.score)));
    // 最相关/最重要的那条一定保住了
    expect(tight.memories[0].content).toContain('故宫');
  });

  it('token 估算：中文按字、英文按 4 字符 ≈ 1 token，且单调递增', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('你好世界')).toBeGreaterThanOrEqual(4);
    expect(estimateTokens('helloworld')).toBeLessThan(estimateTokens('helloworldhelloworld'));
    expect(estimateTokens('abc')).toBeLessThanOrEqual(estimateTokens('abcd'));
    expect(PER_MEMORY_OVERHEAD_TOKENS).toBeGreaterThan(0);
  });
});

describe('retrieval：离线降级路径仍然可用', () => {
  it('enabled:false 时完全不打网络，但仍能召回', async () => {
    let fetchCalls = 0;
    const engine = createMemoryEngine({
      fs: createMemoryFs(),
      filePath: 'memory.json',
      // 配了地址和密钥但显式 enabled:false —— 必须连一次请求都不发
      embedConfig: { enabled: false, baseUrl: 'https://example.invalid/v1', apiKey: 'sk-test' },
      fetchImpl: () => { fetchCalls += 1; throw new Error('离线模式下不该发请求'); },
      now: () => T0,
    });
    await seed(engine, [
      { content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 },
      { content: '用户准备买 RTX 4070', type: 'preference', importance: 0.8 },
    ]);

    const hits = await engine.search('Luna 那只猫', { k: 2 });
    expect(fetchCalls).toBe(0);
    expect(hits[0].content).toContain('Luna');
    expect(engine.internals.embedder.mode()).toBe('local');
    const stats = await engine.stats();
    expect(stats.embedding.local).toBeGreaterThan(0);
    expect(stats.embedding.remote).toBe(0);
    expect(stats.embedding.lastFallbackReason).toBe('disabled');
  });

  it('后端挂掉时自动降级，并且降级原因可读', async () => {
    let calls = 0;
    const engine = createMemoryEngine({
      fs: createMemoryFs(),
      filePath: 'memory.json',
      // 有地址也有密钥 → 会真的尝试远端；后端 500 → 必须降级而不是失败
      embedConfig: { enabled: true, baseUrl: 'https://example.invalid/v1', apiKey: 'sk-test' },
      fetchImpl: async () => { calls += 1; return { ok: false, status: 500, json: async () => ({}) }; },
      now: () => T0,
    });
    await seed(engine, [{ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 }]);
    const hits = await engine.search('Luna 那只猫', { k: 1 });
    expect(calls).toBeGreaterThan(0);
    expect(hits[0].content).toContain('Luna');
    expect(engine.internals.embedder.mode()).toBe('local');
    const stats = await engine.stats();
    expect(stats.embedding.errors).toBeGreaterThan(0);
    expect(stats.embedding.lastFallbackReason).toContain('http-500');
  });

  it('recall 单独调用也能工作（召回与精排是两步）', async () => {
    const engine = offlineEngine();
    const stored = await seed(engine, [
      { content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 },
      { content: '用户喜欢爵士乐', type: 'preference', importance: 0.6 },
    ]);
    const recalled = await recall('猫 Luna', {
      records: stored,
      embedder: engine.internals.embedder,
      topK: 5,
    });
    expect(recalled.length).toBeGreaterThan(0);
    // 召回结果只有相关性，没有精排的 score/rank
    expect(recalled[0].relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    expect(recalled[0].score).toBeUndefined();
    expect(recalled[0].rank).toBeUndefined();
    expect(blendRelevance(1, 0)).toBeCloseTo(0.8, 6);
  });
});

describe('retrieval：元数据过滤', () => {
  it('默认只取 active；显式指定 statuses 才看得到别的状态', async () => {
    const engine = offlineEngine();
    const [a] = await seed(engine, [
      { content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 },
    ]);
    await engine.forget(a.id);

    expect(await engine.search('Luna 猫', { k: 5 })).toHaveLength(0);
    const withDeleted = await engine.search('Luna 猫', { k: 5, statuses: ['deleted'] });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0].status).toBe('deleted');
  });

  it('按 type 过滤', async () => {
    const engine = offlineEngine();
    await seed(engine, [
      { content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 },
      { content: '用户喜欢猫', type: 'preference', importance: 0.8 },
    ]);
    const onlyPref = await engine.search('猫', { k: 5, types: ['preference'] });
    expect(onlyPref).toHaveLength(1);
    expect(onlyPref[0].type).toBe('preference');
  });

  it('按时间范围过滤（since/until 走 updated_at）', async () => {
    // 时间过滤必然涉及「什么时候写的」，所以这里在同一个文件上换时钟再建引擎，
    // 相当于「第二天再打开应用」—— 比在同一个引擎里硬改内部时间更接近真实用法。
    const fs = createMemoryFs();
    const path = 'memory.json';
    const day = 24 * 3600 * 1000;
    const at = (t) => createMemoryEngine({
      fs, filePath: path, embedConfig: { enabled: false }, now: () => t,
    });

    // 两条主题不同（否则会被 consolidation 合并成一条，时间过滤就无从测起）
    await at(T0).remember({ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.9 });
    await at(T0 + 5 * day).remember({ content: '用户准备买 RTX 4070', type: 'preference', importance: 0.7 });

    // 先确认文件里的时间戳（此时还没检索，updated_at 没被刷新过）
    const before = await at(T0 + 10 * day).allRecords();
    expect(before).toHaveLength(2);
    expect(before.map((r) => r.updated_at).sort()).toEqual([T0, T0 + 5 * day].sort());

    const e3 = at(T0 + 10 * day);
    const early = await e3.search('Luna 猫', { k: 5, until: T0 + day });
    expect(early).toHaveLength(1);
    expect(early[0].content).toContain('Luna');

    // 用另一个引擎实例做第二次检索（第一次检索会刷新 last_retrieved_at 并落盘）
    const e4 = at(T0 + 10 * day);
    const late = await e4.search('RTX 显卡', { k: 5, since: T0 + 5 * day });
    expect(late).toHaveLength(1);
    expect(late[0].content).toContain('RTX');
    expect(late[0].updated_at).toBeGreaterThanOrEqual(T0 + 5 * day);
  });

  it('search 会刷新 last_retrieved_at（“最近用过”要能被统计到）', async () => {
    const engine = offlineEngine();
    const [rec] = await seed(engine, [{ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 }]);
    expect(rec.last_retrieved_at).toBeNull();
    await engine.search('Luna 猫', { k: 1 });
    const after = await engine.get(rec.id);
    expect(after.last_retrieved_at).toBe(T0);
  });
});
