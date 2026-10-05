import { describe, it, expect } from 'vitest';
import {
  rerank, rerankCandidate, recencyScore, RERANK_WEIGHTS,
  RECENCY_HALF_LIFE_DAYS, RECENCY_FLOOR, RELEVANCE_MIX,
} from '../../../src/memory/reranker.js';

const NOW = 1730000000000;
const DAY = 24 * 3600 * 1000;

/** 造一条候选（record 只需有精排要用的字段） */
function cand(id, { relevance = 0.8, importance = 0.5, confidence = 0.8, ageDays = 0, content = id } = {}) {
  return {
    record: {
      id,
      content,
      importance,
      confidence,
      updated_at: NOW - ageDays * DAY,
    },
    relevance,
    vectorScore: relevance,
    keywordScore: relevance,
  };
}

describe('reranking：权重与基本行为', () => {
  it('权重之和为 1，且 relevance 占大头', () => {
    const sum = RERANK_WEIGHTS.relevance + RERANK_WEIGHTS.importance
      + RERANK_WEIGHTS.recency + RERANK_WEIGHTS.confidence;
    expect(sum).toBeCloseTo(1, 6);
    expect(RERANK_WEIGHTS.relevance).toBeGreaterThan(RERANK_WEIGHTS.importance);
    expect(RERANK_WEIGHTS.importance).toBeGreaterThan(RERANK_WEIGHTS.recency);
    expect(RELEVANCE_MIX.vector).toBeGreaterThan(RELEVANCE_MIX.keyword);
  });

  it('总分 = 四项加权和，且给得出解释', () => {
    const scored = rerankCandidate(cand('a', { relevance: 1, importance: 0.5, confidence: 1, ageDays: 0 }), { now: NOW });
    const expected = 0.55 * 1 + 0.25 * 0.5 + 0.12 * 1 + 0.08 * 1;
    expect(scored.score).toBeCloseTo(expected, 6);
    expect(scored.components.recency).toBeCloseTo(1, 6);
    expect(scored.reasons.join('|')).toContain('importance');
    expect(scored.reasons.join('|')).toContain('recency');
  });

  it('相同 relevance 下 importance 高的排前面', () => {
    const ranked = rerank([
      cand('low', { relevance: 0.8, importance: 0.2 }),
      cand('high', { relevance: 0.8, importance: 0.95 }),
      cand('mid', { relevance: 0.8, importance: 0.5 }),
    ], { now: NOW });
    expect(ranked.map((c) => c.record.id)).toEqual(['high', 'mid', 'low']);
    expect(ranked[0].rank).toBe(1);
  });

  it('recency 方向正确：同 relevance/importance 时新的在前', () => {
    const ranked = rerank([
      cand('old', { relevance: 0.9, importance: 0.5, ageDays: RECENCY_HALF_LIFE_DAYS * 3 }),
      cand('new', { relevance: 0.9, importance: 0.5, ageDays: 0 }),
    ], { now: NOW });
    expect(ranked[0].record.id).toBe('new');
    expect(ranked[0].components.recency).toBeGreaterThan(ranked[1].components.recency);
  });

  it('很旧但很重要的记忆不会被新噪声完全埋掉', () => {
    const ranked = rerank([
      // 一年前记下、非常重要的一条
      cand('old-important', { relevance: 0.88, importance: 1.0, confidence: 0.95, ageDays: 365, content: '用户的生日是 3 月 14 日' }),
      // 刚刚写的噪声，相关性略高一点点但毫无重要性
      cand('new-noise', { relevance: 0.9, importance: 0.2, confidence: 0.6, ageDays: 0, content: '用户刚才说了句随便' }),
    ], { now: NOW });
    expect(ranked).toHaveLength(2);
    // 老记忆没有被丢掉，而且仍在有效范围（分数不至于塌到 0）
    const old = ranked.find((c) => c.record.id === 'old-important');
    expect(old).toBeDefined();
    // 一年前的衰减：0.5^(365/90) ≈ 0.06，还没到下限 —— 关键是它**没有被清零**
    expect(old.components.recency).toBeGreaterThanOrEqual(RECENCY_FLOOR);
    expect(old.components.recency).toBeLessThan(0.1);
    expect(old.score).toBeGreaterThan(0.6);
    // 一年前的重要事实依然能排第一：重要性差值(0.8×0.25=0.2)大于相关性差值
    expect(ranked[0].record.id).toBe('old-important');
  });

  it('recency 有下限：再老也不会归零', () => {
    // 十年以上必然触底（0.5^(3650/90) 早已小于下限）
    expect(recencyScore(NOW - 10 * 365 * DAY, NOW)).toBe(RECENCY_FLOOR);
    expect(recencyScore(NOW, NOW)).toBeCloseTo(1, 6);
    // 半衰期当天恰好衰减一半
    expect(recencyScore(NOW - RECENCY_HALF_LIFE_DAYS * DAY, NOW)).toBeCloseTo(0.5, 6);
    expect(recencyScore(undefined, NOW)).toBe(RECENCY_FLOOR);
  });

  it('数字字段缺失/脏值时不会算出 NaN', () => {
    const ranked = rerank([{ record: { id: 'x', content: 'x' }, relevance: undefined }], { now: NOW });
    expect(ranked).toHaveLength(1);
    expect(Number.isFinite(ranked[0].score)).toBe(true);
  });

  it('minScore 会过滤掉低分候选（召回宽、精排窄）', () => {
    const ranked = rerank([
      cand('keep', { relevance: 0.9, importance: 0.9 }),
      cand('drop', { relevance: 0.05, importance: 0.05, confidence: 0.1 }),
    ], { now: NOW, minScore: 0.3 });
    expect(ranked.map((c) => c.record.id)).toEqual(['keep']);
  });

  it('同分时按相关性、再按 id 稳定排序（不抖动）', () => {
    const a = rerank([
      cand('b', { relevance: 0.5, importance: 0.5 }),
      cand('a', { relevance: 0.5, importance: 0.5 }),
    ], { now: NOW });
    const b = rerank([
      cand('a', { relevance: 0.5, importance: 0.5 }),
      cand('b', { relevance: 0.5, importance: 0.5 }),
    ], { now: NOW });
    expect(a.map((c) => c.record.id)).toEqual(['a', 'b']);
    expect(b.map((c) => c.record.id)).toEqual(['a', 'b']);
  });
});
