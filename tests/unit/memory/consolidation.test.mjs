import { describe, it, expect } from 'vitest';
import { createMemoryEngine, createMemoryFs } from '../../../src/memory/engine.js';
import {
  planConsolidation, CONSOLIDATE_ACTION, detectConflict, relationKeys,
  polarity, valueAnchors, mergeContent, CONSOLIDATE_THRESHOLD,
} from '../../../src/memory/consolidator.js';
import { createMemoryEmbedder } from '../../../src/memory/embeddings.js';

const T0 = 1730000000000;

function engineAt(now = T0) {
  return createMemoryEngine({
    fs: createMemoryFs(),
    filePath: 'memory.json',
    embedConfig: { enabled: false },
    now: () => now,
  });
}

/** 造一条「已入库」的记录（带向量），用于直接把 consolidation 当纯函数测 */
async function makeExisting(over = {}) {
  const embedder = createMemoryEmbedder({ config: { enabled: false } });
  const base = Object.assign({
    id: 'mem-old-1',
    content: '用户准备购买 RTX 4070',
    type: 'preference',
    importance: 0.8,
    confidence: 0.8,
    created_at: T0,
    updated_at: T0,
    last_retrieved_at: null,
    source: 'conversation',
    status: 'active',
    supersedes: null,
    supersededBy: null,
    mergedFrom: [],
    relations: [],
  }, over);
  base.embedding = await embedder.embedOne(base.content);
  return base;
}

describe('consolidation：判据（纯函数）', () => {
  it('关系键：能认出「购买/居住/取向」这类同一件事', () => {
    expect(relationKeys('用户准备购买 RTX 4070')).toContain('购买');
    expect(relationKeys('I want to buy a new GPU')).toContain('购买');
    expect(relationKeys('用户搬到上海住了')).toContain('居住');
    expect(relationKeys('用户喜欢猫')).toContain('取向');
  });

  it('极性：不喜欢/讨厌 与 喜欢 相反', () => {
    expect(polarity('用户喜欢猫')).toBe(1);
    expect(polarity('用户不喜欢猫')).toBe(-1);
    expect(polarity('用户打算买显卡')).toBe(1);
    expect(polarity('今天下雨了')).toBe(0);
  });

  it('数值锚点：型号/岁数/金额分离出来', () => {
    expect(valueAnchors('准备购买 RTX 4070')).toEqual(['rtx4070']);
    expect(valueAnchors('今年 21 岁')).toEqual(['21岁']);
    expect(valueAnchors('没有数字')).toEqual([]);
  });

  it('冲突检测：同关系 + 取值不同 → 冲突；关系不同 → 不冲突', () => {
    const oldRec = { content: '用户准备购买 RTX 4070' };
    const newRec = { content: '用户现在准备购买 RTX 5080' };
    const c = detectConflict(oldRec, newRec);
    expect(c.conflict).toBe(true);
    expect(c.kind).toBe('value');
    expect(c.relations).toContain('购买');

    expect(detectConflict({ content: '用户喜欢猫' }, { content: '用户喜欢狗' }).conflict).toBe(false);
    expect(detectConflict({ content: '用户打算买显卡' }, { content: '用户喜欢初音未来' }).conflict).toBe(false);
    expect(detectConflict({ content: '用户喜欢猫' }, { content: '用户讨厌猫' }).conflict).toBe(true);
  });

  it('合并内容不重复拼接', () => {
    expect(mergeContent('用户养了一只猫叫 Luna', '用户养了一只猫叫 Luna')).toBe('用户养了一只猫叫 Luna');
    const merged = mergeContent('用户养了一只猫叫 Luna', 'Luna 已经三岁了');
    expect(merged).toContain('Luna');
    expect(merged).toContain('三岁');
    expect(merged).toContain('；');
  });
});

describe('consolidation：不相关 → 新增', () => {
  it('内容毫不相干时建新记忆，两条都在', async () => {
    const engine = engineAt();
    const first = await engine.remember({ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.85 });
    const second = await engine.remember({ content: '用户准备购买 RTX 4070', type: 'preference', importance: 0.8 });

    expect(first.consolidate.action).toBe(CONSOLIDATE_ACTION.INSERT);
    expect(second.consolidate.action).toBe(CONSOLIDATE_ACTION.INSERT);
    expect(second.consolidate.reason).toContain('不相关');
    const all = await engine.allRecords({ statuses: ['active'] });
    expect(all).toHaveLength(2);
  });

  it('planConsolidation 直接调用：空库 → insert', async () => {
    const embedder = createMemoryEmbedder({ config: { enabled: false } });
    const record = await makeExisting({ id: 'mem-new-1', content: '用户喜欢初音未来' });
    const plan = await planConsolidation(record, [], { embedder, now: T0 });
    expect(plan.action).toBe(CONSOLIDATE_ACTION.INSERT);
    expect(plan.kept.id).toBe('mem-new-1');
  });
});

describe('consolidation：相关 → 合并成一条更完整的', () => {
  it('同一件事的补充信息合并，不留两条半截的', async () => {
    const embedder = createMemoryEmbedder({ config: { enabled: false } });
    const old = await makeExisting({ id: 'mem-old-1', content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.7 });
    const next = await makeExisting({ id: 'mem-new-1', content: '用户喜欢猫 Luna', type: 'relationship', importance: 0.7 });

    const plan = await planConsolidation(next, [old], { embedder, now: T0 + 1000 });
    expect(plan.action).toBe(CONSOLIDATE_ACTION.MERGE);
    expect(plan.kept.content).toContain('Luna');
    expect(plan.kept.content).toContain('喜欢');
    expect(plan.superseded).toBeNull();
    expect(plan.kept.id).toBe(old.id); // 合并是改写原记录，不新增
    expect(plan.kept.mergedFrom).toContain('mem-new-1');
    expect(plan.kept.importance).toBeGreaterThanOrEqual(old.importance);
    expect(plan.reason).toContain('合并');
  });

  it('走 engine.remember 时也合并，库里只有一条', async () => {
    const engine = engineAt();
    await engine.remember({ content: '用户养了一只猫叫 Luna', type: 'relationship', importance: 0.7 });
    const second = await engine.remember({ content: '用户喜欢猫 Luna', type: 'relationship', importance: 0.7 });

    expect(second.consolidate.action).toBe(CONSOLIDATE_ACTION.MERGE);
    const all = await engine.allRecords();
    expect(all).toHaveLength(1);
    expect(all[0].content).toContain('Luna');
    expect(all[0].mergedFrom.length).toBeGreaterThan(0);
    const stats = await engine.stats();
    expect(stats.counters.merged).toBe(1);
  });
});

describe('consolidation：冲突 → 旧的 superseded，两条都还在', () => {
  it('RTX 4070 → RTX 5080：旧记录置 superseded，新记录 active，双向留痕', async () => {
    const engine = engineAt();
    const old = await engine.remember({ content: '用户准备购买 RTX 4070', type: 'preference', importance: 0.8 });
    const next = await engine.remember({ content: '用户现在准备购买 RTX 5080', type: 'preference', importance: 0.8 });

    expect(next.consolidate.action).toBe(CONSOLIDATE_ACTION.SUPERSEDE);
    expect(next.consolidate.reason).toContain('冲突');

    const oldAfter = await engine.get(old.id);
    const newAfter = await engine.get(next.id);

    // 旧记录：**没有被删**，只是状态变了，并指向新记录
    expect(oldAfter).not.toBeNull();
    expect(oldAfter.status).toBe('superseded');
    expect(oldAfter.supersededBy).toBe(newAfter.id);
    expect(oldAfter.content).toContain('4070');

    // 新记录：active，并指回旧记录
    expect(newAfter.status).toBe('active');
    expect(newAfter.supersedes).toBe(oldAfter.id);
    expect(newAfter.supersededBy).toBeNull();
    expect(newAfter.content).toContain('5080');

    // 两条都还在库里
    const all = await engine.allRecords();
    expect(all).toHaveLength(2);
    expect((await engine.stats()).byStatus.superseded).toBe(1);
    expect((await engine.stats()).counters.superseded).toBe(1);
  });

  it('默认检索只看得到新记录，旧记录需要显式查状态或直接 get', async () => {
    const engine = engineAt();
    const old = await engine.remember({ content: '用户准备购买 RTX 4070', type: 'preference', importance: 0.8 });
    await engine.remember({ content: '用户现在准备购买 RTX 5080', type: 'preference', importance: 0.8 });

    const hits = await engine.search('用户准备买什么显卡', { k: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('5080');

    const superseded = await engine.search('用户准备买什么显卡', { k: 5, statuses: ['superseded'] });
    expect(superseded).toHaveLength(1);
    expect(superseded[0].id).toBe(old.id);
  });

  it('极性翻转也算冲突（喜欢 → 讨厌）', async () => {
    const engine = engineAt();
    const old = await engine.remember({ content: '用户喜欢初音未来', type: 'preference', importance: 0.9 });
    const next = await engine.remember({ content: '用户现在不喜欢初音未来了', type: 'preference', importance: 0.9 });

    expect(next.consolidate.action).toBe(CONSOLIDATE_ACTION.SUPERSEDE);
    expect((await engine.get(old.id)).status).toBe('superseded');
    expect((await engine.get(next.id)).status).toBe('active');
  });

  it('阈值是公开常量，冲突阈值低于相关阈值（矛盾本身就是强证据）', () => {
    expect(CONSOLIDATE_THRESHOLD.conflict).toBeLessThan(CONSOLIDATE_THRESHOLD.relate);
    expect(CONSOLIDATE_THRESHOLD.duplicate).toBeGreaterThan(CONSOLIDATE_THRESHOLD.relate);
  });

  it('同一内容重复写入算 duplicate，不产生第二条也不改写内容', async () => {
    const engine = engineAt();
    const first = await engine.remember({ content: '用户准备购买 RTX 4070', type: 'preference', importance: 0.8 });
    const again = await engine.remember({ content: '用户准备购买 RTX 4070', type: 'preference', importance: 0.8 });

    expect(again.consolidate.action).toBe(CONSOLIDATE_ACTION.DUPLICATE);
    expect(again.id).toBe(first.id);
    const all = await engine.allRecords();
    expect(all).toHaveLength(1);
    expect((await engine.stats()).counters.duplicates).toBe(1);
  });
});
