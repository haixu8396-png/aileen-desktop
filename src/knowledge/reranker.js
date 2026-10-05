// ============================================================
// Knowledge Base：精排（Reranker）—— 与召回**分开的第二趟**
//
// 为什么必须分开：
//   · 召回只看「像不像」：向量余弦 + 关键词重合，快而宽，宁滥勿缺；
//   · 精排还要看「值不值得信」：来源权威性、内容新旧、标题是否命中、
//     长度是否离谱。这些是**策略**，不是相似度，混进召回里就再也解释不清
//     「为什么这条排第一」。
//   · 两者输入输出都是纯数据（候选数组 → 结果数组），可以各自单测，
//     也能在没有任何后端的情况下跑（离线时 relevance 自动退化成关键词分）。
//
// 权重（默认，和为 1）：
//   relevance 0.55 · keyword 0.20 · title 0.08 · recency 0.07 · authority 0.06 · length 0.04
// 时间衰减：半衰期 30 天（30 天前的文档拿一半分，90 天前约 1/8），
// 可以用 weights/now/halfLifeDays 覆盖。
// ============================================================

import { keywordScore, tokenize } from './embeddings.js';
import { rewriteQuery } from './retriever.js';

export const DEFAULT_RERANK_WEIGHTS = {
  relevance: 0.55,
  keyword: 0.2,
  title: 0.08,
  recency: 0.07,
  authority: 0.06,
  length: 0.04,
};

/** 时间衰减半衰期（天） */
export const DEFAULT_HALF_LIFE_DAYS = 30;
/** 这一长度（token）以上的块才算「信息量够」，更短的会被长度分压低 */
export const COMFORT_TOKENS = 120;

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** 时间统一转毫秒：接受 Date / 毫秒数 / ISO 字符串（engine 传的就是 ISO 字符串） */
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : Date.now();
}

/** 新近度：指数衰减；没有时间信息时给中性的 0.5（不奖也不罚） */
export function recencyScore(updatedAt, opts = {}) {
  const halfLife = Number(opts.halfLifeDays) > 0 ? Number(opts.halfLifeDays) : DEFAULT_HALF_LIFE_DAYS;
  const nowMs = toMs(opts.now === undefined ? Date.now() : opts.now);
  const t = updatedAt ? Date.parse(String(updatedAt)) : NaN;
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (nowMs - t) / 86400000);
  return clamp01(Math.pow(0.5, ageDays / halfLife));
}

/** 权威性：文档元数据里显式写的 authority/priority（0~1），没写就中性 0.5 */
export function authorityOf(chunk) {
  const meta = (chunk && chunk.metadata) || {};
  const src = (chunk && chunk.source) || {};
  for (const value of [meta.authority, meta.priority, src.authority, src.priority]) {
    const n = Number(value);
    if (Number.isFinite(n)) return clamp01(n);
  }
  return 0.5;
}

/** 长度分：太短的块信息量不足（常常是标题/表格残片），按 token 数线性给分 */
export function lengthScore(chunk) {
  const meta = (chunk && chunk.metadata) || {};
  const tokens = Number(meta.token_count);
  if (!Number.isFinite(tokens) || tokens <= 0) return 0.5;
  return clamp01(tokens / COMFORT_TOKENS);
}

function normalizeWeights(weights) {
  const merged = Object.assign({}, DEFAULT_RERANK_WEIGHTS, weights || {});
  let sum = 0;
  for (const key of Object.keys(DEFAULT_RERANK_WEIGHTS)) {
    merged[key] = Number.isFinite(Number(merged[key])) ? Math.max(0, Number(merged[key])) : DEFAULT_RERANK_WEIGHTS[key];
    sum += merged[key];
  }
  if (sum <= 0) return Object.assign({}, DEFAULT_RERANK_WEIGHTS);
  const out = {};
  for (const key of Object.keys(DEFAULT_RERANK_WEIGHTS)) out[key] = merged[key] / sum;
  return out;
}

/**
 * 精排。输入是 retriever 的候选（{ chunk, dense, keyword, score }），
 * 输出是重排后的最终结果数组（长度 ≤ k），每项多一个 `rerank` 字段说明分数构成。
 *
 * 一个刻意的设计：**离线 / 全部没有向量时，relevance 退回关键词分**，
 * 于是"没有 embedding 后端"也能得到有意义的排序，而不是所有 relevance=0
 * 让排序退化成随机。
 */
export function rerank(candidates, opts = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.chunk);
  const weights = normalizeWeights(opts.weights);
  const k = Number.isFinite(Number(opts.k)) && Number(opts.k) > 0 ? Math.floor(Number(opts.k)) : list.length;
  const rewritten = typeof opts.query === 'string'
    ? rewriteQuery(opts.query)
    : (opts.query && typeof opts.query === 'object' ? opts.query : rewriteQuery(''));
  const ask = rewritten.rewritten || rewritten.original || '';
  const keywords = Array.isArray(rewritten.keywords) && rewritten.keywords.length ? rewritten.keywords : tokenize(ask);
  const askForScore = keywords.length ? keywords.join(' ') : ask;
  const hasDense = list.some((c) => Number(c.dense) > 0);
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 0;

  const scored = list.map((c) => {
    const chunk = c.chunk;
    const relevance = hasDense ? clamp01(c.dense) : clamp01(c.keyword);
    const keyword = keywordScoreForChunk(askForScore, chunk);
    const title = chunk.title ? clamp01(keywordScore(askForScore, chunk.title)) : 0;
    const recency = recencyScore(chunk.updated_at || chunk.created_at, { now: opts.now, halfLifeDays: opts.halfLifeDays });
    const authority = authorityOf(chunk);
    const length = lengthScore(chunk);
    const parts = { relevance, keyword, title, recency, authority, length };
    let final = 0;
    for (const key of Object.keys(DEFAULT_RERANK_WEIGHTS)) final += (weights[key] || 0) * parts[key];
    return Object.assign({}, c, {
      rerank: { score: final, parts, weights, keyword_only: !hasDense },
      final_score: final,
    });
  });

  scored.sort((a, b) => b.final_score - a.final_score
    || Number(b.score) - Number(a.score)
    || String(a.chunk.id).localeCompare(String(b.chunk.id)));

  return scored.filter((c) => c.final_score >= minScore).slice(0, k);
}

/** 精排里的关键词分：正文 + 标题（标题按 0.9 折算） */
function keywordScoreForChunk(query, chunk) {
  const body = keywordScore(query, chunk.content || '');
  const title = chunk.title ? keywordScore(query, chunk.title) * 0.9 : 0;
  return clamp01(Math.max(body, title));
}
