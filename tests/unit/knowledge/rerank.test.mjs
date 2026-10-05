// ============================================================
// reranker：精排（第二趟）—— 必须能**改变**召回的顺序，
// 并且离线/无向量时退化得合理
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  rerank, recencyScore, authorityOf, lengthScore, DEFAULT_RERANK_WEIGHTS, DEFAULT_HALF_LIFE_DAYS,
} from '../../../src/knowledge/reranker.js';
import { retrieve } from '../../../src/knowledge/retriever.js';

const NOW = '2024-06-01T00:00:00.000Z';

function chunk(overrides = {}) {
  return Object.assign({
    id: 'c1',
    document_id: 'd1',
    content: '知识库切块策略说明：优先段落边界。',
    title: null,
    page: null,
    chunk_index: 0,
    embedding: null,
    created_at: '2023-01-01T00:00:00.000Z',
    updated_at: '2023-01-01T00:00:00.000Z',
    metadata: { token_count: 120 },
    source: { kind: 'text', filename: 'a.md', extension: 'md', format: 'md' },
  }, overrides);
}

function candidate(c, dense, keyword) {
  return { chunk: c, dense, keyword, score: dense * 0.55 + keyword * 0.45 };
}

describe('reranker / 精排改变顺序', () => {
  it('相关性相近时，更权威 + 更新的排在前面（召回顺序被翻转）', () => {
    const stale = candidate(chunk({
      id: 'c_old',
      updated_at: '2021-01-01T00:00:00.000Z',
      metadata: { token_count: 120, authority: 0 },
    }), 0.61, 0.8);
    const fresh = candidate(chunk({
      id: 'c_new',
      updated_at: '2024-05-30T00:00:00.000Z',
      metadata: { token_count: 120, authority: 0.9 },
    }), 0.6, 0.8);

    // 召回顺序：c_old 在前（dense 更高）
    expect([stale, fresh].sort((a, b) => b.score - a.score)[0].chunk.id).toBe('c_old');

    const out = rerank([stale, fresh], { query: '知识库切块策略', k: 2, now: NOW });
    expect(out.map((x) => x.chunk.id)).toEqual(['c_new', 'c_old']);
    // 分数构成要摊开说明，便于解释"为什么它排第一"
    expect(out[0].rerank.parts.recency).toBeGreaterThan(out[1].rerank.parts.recency);
    expect(out[0].rerank.parts.authority).toBeGreaterThan(out[1].rerank.parts.authority);
  });

  it('权重可调：只留标题权重时，标题命中者胜出', () => {
    const a = candidate(chunk({ id: 'c_a', title: '无关标题', content: '内容甲' }), 0.9, 0.9);
    const b = candidate(chunk({ id: 'c_b', title: '知识库切块策略', content: '内容乙' }), 0.05, 0.05);
    const weights = { relevance: 0, keyword: 0, title: 1, recency: 0, authority: 0, length: 0 };
    const out = rerank([a, b], { query: '知识库切块策略', k: 2, weights, now: NOW });
    expect(out.map((x) => x.chunk.id)).toEqual(['c_b', 'c_a']);
  });

  it('同一批候选重复精排，结果稳定（可复现）', () => {
    const list = [candidate(chunk({ id: 'x1' }), 0.5, 0.5), candidate(chunk({ id: 'x2' }), 0.5, 0.5)];
    const first = rerank(list, { query: '切块', k: 2, now: NOW }).map((x) => x.chunk.id);
    const second = rerank(list, { query: '切块', k: 2, now: NOW }).map((x) => x.chunk.id);
    expect(first).toEqual(second);
  });
});

describe('reranker / 各分项', () => {
  it('recencyScore 按半衰期衰减，缺时间给中性值', () => {
    expect(recencyScore(NOW, { now: NOW })).toBeCloseTo(1, 5);
    expect(recencyScore('2024-05-02T00:00:00.000Z', { now: NOW, halfLifeDays: 30 })).toBeCloseTo(0.5, 2);
    expect(recencyScore('2024-04-02T00:00:00.000Z', { now: NOW, halfLifeDays: 30 })).toBeCloseTo(0.25, 2);
    expect(recencyScore(null, { now: NOW })).toBe(0.5);
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(30);
  });

  it('authorityOf 读 metadata/source 的 authority|priority，默认 0.5', () => {
    expect(authorityOf(chunk({ metadata: { authority: 0.9 } }))).toBe(0.9);
    expect(authorityOf(chunk({ metadata: { priority: 1 } }))).toBe(1);
    expect(authorityOf(chunk({ metadata: { authority: 2 } }))).toBe(1); // 上限夹住
    expect(authorityOf(chunk({ metadata: {} }))).toBe(0.5);
    expect(authorityOf(chunk({ metadata: {}, source: { authority: 0 } }))).toBe(0);
  });

  it('lengthScore 压低过短的块', () => {
    expect(lengthScore(chunk({ metadata: { token_count: 10 } }))).toBeLessThan(0.2);
    expect(lengthScore(chunk({ metadata: { token_count: 200 } }))).toBe(1);
  });

  it('默认权重之和为 1', () => {
    const sum = Object.values(DEFAULT_RERANK_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('k 截断与 minScore 过滤', () => {
    const list = [
      candidate(chunk({ id: 'a', content: '知识库切块策略说明' }), 0.9, 0.9),
      candidate(chunk({ id: 'b', content: '知识库切块策略说明' }), 0.5, 0.5),
      candidate(chunk({ id: 'c', content: '完全无关的另一段文字' }), 0.01, 0.01),
    ];
    expect(rerank(list, { query: '切块', k: 1, now: NOW })).toHaveLength(1);
    // 精排分是六项加权和（≤1），0.6 的门槛只留得下第一条
    const filtered = rerank(list, { query: '切块', k: 3, now: NOW, minScore: 0.6 });
    expect(filtered.map((x) => x.chunk.id)).toEqual(['a']);
    // 门槛很低时无关的也会被留下（说明过滤发生在精排之后，由调用方定门槛）
    expect(rerank(list, { query: '切块', k: 3, now: NOW }).map((x) => x.chunk.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('reranker / 离线退化', () => {
  it('所有候选都没有向量时，relevance 退回关键词分（不是全 0 变随机）', () => {
    const list = [
      candidate(chunk({ id: 'hit', content: '知识库检索召回与精排' }), 0, 1),
      candidate(chunk({ id: 'miss', content: '完全无关的内容' }), 0, 0),
    ];
    const out = rerank(list, { query: '召回与精排', k: 2, now: NOW });
    expect(out[0].chunk.id).toBe('hit');
    expect(out[0].rerank.keyword_only).toBe(true);
    expect(out[0].rerank.parts.relevance).toBe(1);
  });

  it('空候选返回空数组', () => {
    expect(rerank([], { query: 'x', now: NOW })).toEqual([]);
    expect(rerank(null, { query: 'x', now: NOW })).toEqual([]);
  });
});

describe('reranker / 与召回是两趟（集成）', () => {
  it('retrieve 的候选顺序被 rerank 重新排过（两个函数、两个结果）', () => {
    const chunks = [
      // id 排序在前 + 内容相同 → 召回阶段它先出（同分时按 id 稳定排序）
      chunk({ id: 'aaa_old_similar', content: '知识库切块策略', updated_at: '2020-01-01T00:00:00.000Z', metadata: { token_count: 120, authority: 0 } }),
      chunk({ id: 'zzz_new_authoritative', content: '知识库切块策略', updated_at: '2024-05-31T00:00:00.000Z', metadata: { token_count: 120, authority: 1 } }),
    ];
    const recall = retrieve({ query: '知识库切块策略', chunks, k: 5, mode: 'local', queryVector: null });
    expect(recall.candidates).toHaveLength(2);
    expect(recall.candidates.map((c) => c.chunk.id)).toEqual(['aaa_old_similar', 'zzz_new_authoritative']);

    const ranked = rerank(recall.candidates, { query: '知识库切块策略', k: 2, now: NOW });
    expect(ranked.map((c) => c.chunk.id)).toEqual(['zzz_new_authoritative', 'aaa_old_similar']);
  });
});
