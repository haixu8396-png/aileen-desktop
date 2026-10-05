// ============================================================
// Reranker：精排（**与召回严格分开的第二步**）
//
//   recall()  的职责：便宜、宽口径 —— 「这条**可能**相关，别漏」。
//   rerank()  的职责：贵一点、窄口径 —— 「在候选里，哪几条**最该**进上下文」。
//
// 为什么必须分开（而不是召回时直接算总分）：
//   1) 召回要能独立降级（没有 embedding 后端时只靠关键词），
//      它不清楚「重要性/新鲜度」这些元数据的语义；
//   2) 精排的权重是要调的（用户可能更想要「重要」还是「新鲜」），
//      混在一起就没法单独调、也没法单独测；
//   3) 元数据过滤必须发生在召回之后、精排之前 —— 否则被过滤掉的记录
//      会白占 top-k 名额（这是把两件事合成一个函数最常见的 bug）。
//
// 总分 = 0.55·relevance + 0.25·importance + 0.12·recency + 0.08·confidence
//   · relevance  = 0.8·cosine + 0.2·keywordScore（向量为主，关键词兜底防串味）
//   · recency    = 0.5^(天数 / 90)，下限 0.05 —— 「很旧」是减速而不是清零，
//                  所以一条 importance=1.0 的老记忆不会被新噪声完全埋掉
//   · confidence 权重最低：它表示「这条记得准不准」，本身不决定该不该用
// ============================================================

/** 精排权重（四项之和为 1，改动这里就是改动产品取向） */
export const RERANK_WEIGHTS = {
  relevance: 0.55,
  importance: 0.25,
  recency: 0.12,
  confidence: 0.08,
};

/** relevance 内部：向量余弦与关键词重合度的配比 */
export const RELEVANCE_MIX = { vector: 0.8, keyword: 0.2 };

/** 新鲜度半衰期（天）：90 天前的东西权重减半 */
export const RECENCY_HALF_LIFE_DAYS = 90;

/** 新鲜度下限：再老也不会归零 —— 否则「重要但久远」的记忆等于被删了 */
export const RECENCY_FLOOR = 0.05;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 时间衰减。
 * @param {number} updatedAt 记录最后更新时间
 * @param {number} now
 * @returns {number} 0.05 ~ 1
 */
export function recencyScore(updatedAt, now = Date.now()) {
  const at = Number(updatedAt);
  if (!Number.isFinite(at)) return RECENCY_FLOOR;
  const days = Math.max(0, (Number(now) - at) / DAY_MS);
  const decayed = Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
  return Math.max(RECENCY_FLOOR, Math.min(1, decayed));
}

/**
 * 精排一个候选。
 *
 * @param {object} candidate 至少含 { record, relevance, vectorScore, keywordScore }
 * @param {object} opts { now, weights }
 * @returns {object} { ...candidate, score, components, reasons }
 */
export function rerankCandidate(candidate, opts = {}) {
  const weights = Object.assign({}, RERANK_WEIGHTS, opts.weights || {});
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const record = (candidate && candidate.record) || {};
  const relevance = Number.isFinite(candidate && candidate.relevance) ? candidate.relevance : 0;
  const importance = Number.isFinite(record.importance) ? record.importance : 0;
  const confidence = Number.isFinite(record.confidence) ? record.confidence : 0;
  const recency = recencyScore(record.updated_at, now);

  const score = weights.relevance * relevance
    + weights.importance * importance
    + weights.recency * recency
    + weights.confidence * confidence;

  return Object.assign({}, candidate, {
    score,
    components: {
      relevance,
      vectorScore: Number(candidate && candidate.vectorScore) || 0,
      keywordScore: Number(candidate && candidate.keywordScore) || 0,
      importance,
      recency,
      confidence,
    },
    reasons: [
      'relevance ' + relevance.toFixed(3) + ' ×' + weights.relevance,
      'importance ' + importance.toFixed(2) + ' ×' + weights.importance,
      'recency ' + recency.toFixed(3) + '（半衰期 ' + RECENCY_HALF_LIFE_DAYS + ' 天，下限 ' + RECENCY_FLOOR + '）×' + weights.recency,
      'confidence ' + confidence.toFixed(2) + ' ×' + weights.confidence,
      '= ' + score.toFixed(4),
    ],
  });
}

/**
 * 分数比较：差异小于 1e-9 视为平手。
 * 为什么需要：recency 的权重只有 0.12，两条记忆时间只差几毫秒时总分差会小到
 * 浮点误差量级 —— 直接比大小会让顺序在两次运行间抖动（测试会闪、UI 会跳）。
 * 平手时退回到「纯相关性 → id」，结果稳定且仍然符合「recency 影响方向正确」。
 */
export const SCORE_EPSILON = 1e-9;

/** 精排 + 排序（分数降序；同分时 relevance 高的在前）。
 *
 * @param {Array} candidates 召回结果
 * @param {object} opts { now, weights, minScore }
 * @returns {Array} 排好序的候选（带 score/components/reasons/rank）
 */
export function rerank(candidates, opts = {}) {
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0;
  const scored = (Array.isArray(candidates) ? candidates : [])
    .map((c) => rerankCandidate(c, opts))
    .filter((c) => c.score >= minScore);

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > SCORE_EPSILON) return b.score - a.score;
    // 平手时看纯相关性：同分下「更贴题」的应该排前面
    if (Math.abs(b.components.relevance - a.components.relevance) > SCORE_EPSILON) {
      return b.components.relevance - a.components.relevance;
    }
    // 再平手就按 id 稳定排序，避免结果抖动导致测试/UI 闪烁
    return String(a.record && a.record.id).localeCompare(String(b.record && b.record.id));
  });

  return scored.map((c, i) => Object.assign({}, c, { rank: i + 1 }));
}

/** 只要记录本身时用这个（engine.search 的返回值就是它） */
export function toRecords(ranked) {
  return (Array.isArray(ranked) ? ranked : []).map((c) => c.record);
}

/**
 * 单条候选的总分（consolidation 判「是否相关」时复用同一套权重，
 * 保证「检索时觉得相关」和「写入时觉得是同一件事」口径一致）。
 */
export function scorePair({ record, relevance, now }) {
  return rerankCandidate({ record, relevance }, { now }).score;
}
