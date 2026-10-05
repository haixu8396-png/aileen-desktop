// ============================================================
// Knowledge Base：召回（Recall / Retriever）
//
// 流水线里的位置：
//   Query → **Query Rewrite** → Embedding → **Top-K 向量召回** → **元数据过滤**
//         → Reranker（另一个文件、另一趟）→ Top-N → Context Builder
//
// 这一层**只负责「把可能有用的东西捞出来」**，不做精排。
// 精排必须分开（见 reranker.js），因为：
//   · 召回要快、要宽（宁滥勿缺），精排要慢、要准（宁缺勿滥），
//     两者的目标函数根本不同，揉在一起就两头不讨好；
//   · 召回分数可以离线复现（纯向量数学），精排引入了时间/权威性等策略，
//     混在一起之后「检索结果为什么变了」就查不清了。
//
// Query Rewrite 是**规则式**的（不调模型）：剥掉疑问词/礼貌语/尾部语气词，
// 留下关键词。好处是确定、可单测、离线可用、零延迟。
// ============================================================

import { tokenize, keywordScore, cosine, isUsableVector } from './embeddings.js';

export const DEFAULT_K = 5;
export const DEFAULT_CANDIDATE_FACTOR = 4;
/** 低于这个混合分的候选直接丢掉 —— 否则"无关的也能召回"，引用全是噪声 */
export const DEFAULT_MIN_SCORE = 0.08;

/**
 * 混合权重：向量分与关键词分的配比。
 *  · remote：后端真向量语义强，靠它拿 75%；
 *  · local ：降级成本地词频向量后，语义能力弱，把关键词提到 45% 兜住下限
 *            （这就是"离线也仍然可用"的具体做法）。
 */
export const HYBRID_WEIGHTS = {
  remote: { dense: 0.75, keyword: 0.25 },
  local: { dense: 0.55, keyword: 0.45 },
};

const LEADING_PATTERNS = [
  /^(请问|请帮我|请|帮我|帮忙|麻烦|我想知道|想知道|我想问|想问|问一下|了解一下|介绍一下|解释一下|说明一下|告诉我)/,
  /^(什么是|是什么|如何|怎么样|怎么|怎样|为什么|为啥|哪些|哪个|多少|能不能|能否|可以|可不可以)/,
  /^(please|could you|can you|would you|tell me|explain|describe|what is|what are|what's|how to|how do i|how does|why is|why does|which|who is|where is)\s+/i,
];

const TRAILING_NOISE = /(吗|呢|吧|么|嘛|啊|呀|[?？。！!，,、；;：:\s]+)$/;

/**
 * 规则式 Query Rewrite：剥疑问词/礼貌语/尾部语气 → 抽出关键词。
 * 返回 { original, rewritten, keywords, removed }；
 * 如果剥完什么都不剩（比如用户只发了"为什么？"），就退回原句，不要交白卷。
 */
export function rewriteQuery(query) {
  const original = String(query == null ? '' : query).trim();
  let text = original;
  const removed = [];

  for (let round = 0; round < 4; round += 1) {
    let changed = false;
    for (const re of LEADING_PATTERNS) {
      const m = re.exec(text);
      if (m && m[0]) {
        removed.push(m[0].trim());
        text = text.slice(m[0].length).trim();
        changed = true;
      }
    }
    if (!changed) break;
  }
  let guard = 0;
  while (TRAILING_NOISE.test(text) && guard < 8) {
    const m = TRAILING_NOISE.exec(text);
    removed.push(m[0].trim());
    text = text.slice(0, m[0].length ? -m[0].length : undefined).trim();
    guard += 1;
  }
  if (!text) text = original;
  return {
    original,
    rewritten: text,
    keywords: tokenize(text),
    removed: removed.filter(Boolean),
  };
}

function toList(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v)).filter(Boolean);
}

function toTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function sourceMatches(source, wanted) {
  const want = String(wanted).toLowerCase();
  const src = source || {};
  if (String(src.kind || '').toLowerCase() === want) return true;
  if (src.format && String(src.format).toLowerCase() === want) return true;
  if (src.extension && String(src.extension).toLowerCase().replace(/^\./, '') === want) return true;
  const name = String(src.filename || src.name || '').toLowerCase();
  const path = String(src.path || '').toLowerCase();
  return name.includes(want) || path.includes(want);
}

/**
 * 元数据过滤：文档 id / 文件名 / source / 扩展名 / 路径 / 时间区间 / 自定义函数。
 * 时间区间用 chunk 自己的 created_at/updated_at（chunk 就是文档的时间快照）。
 */
export function matchesFilters(chunk, filters) {
  if (!filters || typeof filters !== 'object') return true;
  const f = filters;
  if (typeof f.filter === 'function' && !f.filter(chunk)) return false;

  const ids = toList(f.documentIds !== undefined ? f.documentIds : (f.document_id !== undefined ? f.document_id : f.documentId));
  if (ids.length && !ids.includes(String(chunk.document_id))) return false;

  const src = chunk.source || {};
  if (f.filename && !String(src.filename || src.name || '').toLowerCase().includes(String(f.filename).toLowerCase())) return false;
  if (f.source && !sourceMatches(src, f.source)) return false;
  if (f.path && !String(src.path || '').toLowerCase().includes(String(f.path).toLowerCase())) return false;

  const exts = toList(f.extensions !== undefined ? f.extensions : (f.extension !== undefined ? f.extension : f.format))
    .map((e) => e.toLowerCase().replace(/^\./, ''));
  if (exts.length) {
    const own = String(src.extension || (chunk.metadata && chunk.metadata.format) || '').toLowerCase();
    if (!exts.includes(own)) return false;
  }

  const since = toTime(f.since);
  const until = toTime(f.until);
  if (since !== null || until !== null) {
    const field = f.timeField === 'created_at' ? 'created_at' : 'updated_at';
    const t = toTime(chunk[field]) !== null ? toTime(chunk[field]) : toTime(chunk.created_at);
    if (t === null) return false;
    if (since !== null && t < since) return false;
    if (until !== null && t > until) return false;
  }

  if (f.tags) {
    const wants = toList(f.tags).map((x) => x.toLowerCase());
    const own = toList((chunk.metadata && chunk.metadata.tags) || []).map((x) => x.toLowerCase());
    if (wants.length && !wants.some((w) => own.includes(w))) return false;
  }

  if (f.page !== undefined && f.page !== null && Number(chunk.page) !== Number(f.page)) return false;
  return true;
}

/** 关键词分：正文命中为主，标题命中打折后也算 —— 标题命中常常是「就是这篇」的强信号 */
export function keywordScoreFor(query, chunk) {
  const body = keywordScore(query, chunk.content || '');
  const title = chunk.title ? keywordScore(query, chunk.title) : 0;
  return Math.max(body, title * 0.9);
}

/**
 * 召回：元数据过滤 → 混合打分（向量 + 关键词）→ Top-K。
 * @returns {{ query: object, candidates: Array, scanned: number, matched: number, mode: string, dim: number }}
 *   candidates 里每项是 { chunk, dense, keyword, score } —— **排序在这一层定，重排在 reranker**。
 */
export function retrieve(input = {}) {
  const query = typeof input.query === 'string' ? rewriteQuery(input.query) : (input.query || rewriteQuery(''));
  const chunks = Array.isArray(input.chunks) ? input.chunks : [];
  const k = Math.max(1, Number(input.k) || DEFAULT_K);
  const candidateK = Math.max(k, Number(input.candidateK) || Math.max(k * DEFAULT_CANDIDATE_FACTOR, k + 8));
  const mode = input.mode === 'remote' ? 'remote' : 'local';
  const weights = HYBRID_WEIGHTS[mode];
  const minScore = Number.isFinite(Number(input.minScore)) ? Number(input.minScore) : DEFAULT_MIN_SCORE;
  const queryVector = Array.isArray(input.queryVector) ? input.queryVector : null;
  const dim = queryVector ? queryVector.length : 0;
  const ask = query.rewritten || query.original || '';

  const scored = [];
  let filtered = 0;
  for (const chunk of chunks) {
    if (!chunk || !chunk.content) continue;
    if (!matchesFilters(chunk, input.filters)) continue;
    filtered += 1;
    const dense = queryVector && isUsableVector(chunk.embedding, dim) ? Math.max(0, cosine(queryVector, chunk.embedding)) : 0;
    const keyword = keywordScoreFor(ask, chunk);
    const score = weights.dense * dense + weights.keyword * keyword;
    if (score < minScore) continue;
    scored.push({ chunk, dense, keyword, score });
  }
  // 同分时按 chunk id 排序：结果必须可复现，否则测试和用户都会觉得"时好时坏"
  scored.sort((a, b) => b.score - a.score || String(a.chunk.id).localeCompare(String(b.chunk.id)));
  return {
    query,
    candidates: scored.slice(0, candidateK),
    scanned: chunks.length,
    filtered,
    matched: scored.length,
    mode,
    dim,
    weights,
  };
}

/**
 * Context Builder：把最终结果拼成给模型看的上下文。
 * 每条前面带引用头，模型回答时能照抄它来标来源。
 */
export function buildContext(results, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  const budget = Number(opts.budgetTokens);
  const maxChars = Number.isFinite(Number(opts.maxChars)) ? Number(opts.maxChars) : Infinity;
  const parts = [];
  let usedTokens = 0;
  let usedChars = 0;
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const tokens = Number(r.token_count) || 0;
    const chars = String(r.content || '').length;
    if (Number.isFinite(budget) && budget > 0 && usedTokens + tokens > budget) continue;
    if (usedChars + chars > maxChars) continue;
    usedTokens += tokens;
    usedChars += chars;
    parts.push(formatCitation(r, i + 1) + '\n' + String(r.content || '').trim());
  }
  return {
    text: parts.join('\n\n'),
    used_tokens: usedTokens,
    items: parts.length,
  };
}

/** 单条引用串：人能读，且能据此回到原文 */
export function formatCitation(result, index) {
  const r = result || {};
  const src = r.source || {};
  const name = src.filename || src.name || (src.path ? String(src.path).split(/[\\/]/).pop() : '未知来源');
  const parts = ['《' + name + '》'];
  if (r.page) parts.push('第 ' + r.page + ' 页');
  else if (String(src.format || '') === 'pdf') parts.push('页码未知');
  if (r.title && r.title !== name) parts.push('小节「' + r.title + '」');
  if (Number.isFinite(Number(r.chunk_index))) parts.push('第 ' + (Number(r.chunk_index) + 1) + ' 段');
  parts.push('chunk ' + (r.chunk_id || r.id || '?'));
  return (index ? '[' + index + '] ' : '') + parts.join(' · ');
}

/** 多条引用 → 可读的多行字符串（贴给用户看的那份） */
export function formatCitations(results) {
  return (Array.isArray(results) ? results : []).map((r, i) => formatCitation(r, i + 1)).join('\n');
}
