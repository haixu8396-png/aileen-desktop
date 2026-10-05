// ============================================================
// Retriever：召回（第一步）
//
//   Query → Rewrite → Embedding → Top-K 粗召回 → 元数据过滤
//         → 交给 reranker 精排（**不在这个文件里**）
//
// 这个文件只做「宁滥勿缺」：口径宽、算得便宜。
// 它**故意不算 importance/recency** —— 那些属于精排，混进来会让
// 「召回质量」和「排序质量」没法分开测（也就没法定位是谁的问题）。
//
// 离线可用是硬要求：拿不到后端 embedding 时，cosine 退化成「本地词频向量
// 余弦」，再叠加 keywordScore，照样能召回；两条路都不为空。
// ============================================================
import { tokenize, cosine, STOPWORDS } from './embeddings.js';
import { filterRecords } from './store.js';
import { QUESTION_WORDS } from './extractor.js';

/** 召回宽度：先多召回一些，精排再收窄。topK 未指定时按 4 倍 k 召回（上限 100） */
export const DEFAULT_RECALL_MULTIPLIER = 4;
export const MAX_RECALL = 100;

/**
 * 相关性下限：低于它的直接丢，避免「什么都召回一点」把精排变成随机排序。
 * 0.08 的理由：本地降级向量（512 维哈希）在完全无关的中文之间也会有 0.05~0.15
 * 的撞桶噪声，纯余弦兜不住；而真正有一点点关系的（哪怕只共用一个词）
 * 混合分通常 ≥ 0.2。取 0.08 是「压掉噪声，但放得过弱匹配」的那个点。
 */
export const RELEVANCE_FLOOR = 0.08;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 中文疑问/语气词（改写时要去掉的尾巴） */
const CJK_NOISE = /[的吗呢吧啊呀哦嘛么？?！!。，,、；;：:]+$/;
/** 句首客套：这些词不携带信息，问「请问我的猫叫什么」和「我的猫叫什么」等价 */
const LEADING_POLITE = /^(?:请问|请|帮我|帮忙|告诉我|麻烦|能不能|可不可以|我想知道|你知道|请问一下|please|can\s+you|could\s+you|tell\s+me|do\s+you\s+know)\s*/i;
/** 句尾疑问块：整块删掉（不是只删一个字） */
const TRAILING_QUESTION_BLOCK = /\s*(?:是什么|是啥|是什么呀|怎么样|怎么样呢|叫什么|在哪|在哪里|多少钱|什么时候|为什么|怎么回事|如何|多少|what|which|when|where|why|how)\s*[?？。]*\s*$/i;

/** 单个字的「实义词」太容易串味，但如果查询里全是单字（如「猫」）就得留着 */
const MIN_MULTI_TOKEN_LEN = 2;

/** 拉丁停用词：只在抽关键词时用；中文靠 length 判据 */
const KEYWORD_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'my', 'your', 'me', 'you', 'it',
]);

/**
 * Query Rewrite：**规则式**，只做三件事，别的（尤其是代词消解）留给上层。
 *
 *   1) 去掉句首客套与句尾疑问语气（「请问…呢？」→「…」）；
 *   2) 削掉疑问词块（「是什么 / 在哪里 / what / how…」）；
 *   3) 抽出关键词（去停用词，供关键词兜底与调试查看）。
 *
 * **不做**：同义词扩展、代词消解（「它」指什么只有对话上下文知道，
 * 而 retriever 是纯函数，拿不到那层信息 —— 硬做只会引入错误指代）。
 *
 * @returns {{ original:string, rewritten:string, keywords:string[], removed:string[] }}
 */
export function rewriteQuery(query) {
  const original = String(query == null ? '' : query).trim();
  let text = original;
  const removed = [];

  const lead = text.match(LEADING_POLITE);
  if (lead) {
    removed.push(lead[0].trim());
    text = text.slice(lead[0].length);
  }

  const trail = text.match(TRAILING_QUESTION_BLOCK);
  if (trail) {
    removed.push(trail[0].trim());
    text = text.slice(0, text.length - trail[0].length);
  }

  // 尾巴上的单个语气词（吗/呢/吧…）逐个削，削到不匹配为止
  let guard = 0;
  while (guard < 5) {
    const next = text.replace(CJK_NOISE, '');
    if (next === text) break;
    removed.push(text.slice(next.length));
    text = next;
    guard += 1;
  }

  // 整句就是一个疑问词时（「什么？」），保留原文 —— 空查询召回不了任何东西
  const rewritten = text.trim() || original;
  return { original, rewritten, keywords: extractKeywords(rewritten), removed };
}

/**
 * 抽关键词：中英日通用。
 * 中文没有空格，所以「多字词」和「单字」分开取：优先多字，一个都没有才退回单字
 * （查询「猫」这种情况得留一个单字，否则关键词路径就废了）。
 *
 * 这里额外处理一种 shared 分词器覆盖不到的情况：**CJK 与数字/拉丁连写**
 * （「去798」「RTX4070」「東京タワー2」）。shared 的 tokenize 会把整段当成一个
 * 拉丁词，于是查询「798」和文本「去798」就没有公共 token —— 关键词这一路直接
 * 假阴性。这里按文字系统再切一刀，把两边拆成可对齐的片段。
 */
export function extractKeywords(text) {
  const s = String(text == null ? '' : text);
  const raw = [];
  for (const token of tokenizeFallback(s)) {
    for (const piece of splitMixedToken(token)) raw.push(piece);
  }
  const multi = [];
  const single = [];
  for (const token of raw) {
    const tk = String(token);
    if (!tk) continue;
    if (/^[a-z0-9]+$/.test(tk)) {
      if (tk.length < 2 || KEYWORD_STOPWORDS.has(tk)) continue;
      multi.push(tk);
    } else if (tk.length >= MIN_MULTI_TOKEN_LEN) {
      multi.push(tk);
    } else if (!QUESTION_WORDS.includes(tk) && !KEYWORD_STOPWORDS.has(tk)) {
      single.push(tk);
    }
  }
  const out = multi.length ? multi : single;
  return Array.from(new Set(out));
}

/** 把一个 token 按「汉字/假名 段」与「数字字母 段」再切一次（保持两段的组合） */
function splitMixedToken(token) {
  const tk = String(token || '');
  if (!tk) return [];
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(tk)) return [tk];
  if (/^[A-Za-z0-9]+$/.test(tk)) return [tk];
  const pieces = tk.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[A-Za-z0-9]+/gu) || [];
  const out = pieces.slice();
  // 「去」+「798」→ 也把连写整体留一份，避免丢掉原本的语义片段
  if (pieces.length > 1) out.push(pieces.join(''));
  return out;
}

/** 没有注入 embedding 模块时的最简分词（只用于关键词抽取，不参与向量计算） */
function tokenizeFallback(text) {
  const s = String(text || '').toLowerCase();
  const parts = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(part)) {
      const chars = Array.from(part);
      for (let i = 0; i < chars.length; i += 1) {
        if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
        out.push(chars[i]);
      }
    } else {
      out.push(part);
    }
  }
  return out;
}

/**
 * 关键词重合度。
 *
 * 为什么不用 shared 的 keywordScore 直接算：shared 的分词器把
 * **CJK 与数字/字母连写** 的整段当成一个「拉丁词」（「去798」「RTX4070」），
 * 于是查询「798」与文本「去798」没有任何公共 token，关键词这一路直接假阴性；
 * 更可惜的是这种文本的**本地向量几乎全是噪声**，两路一起失灵。
 * 所以这里在调用 shared 的分词前，先在「汉字/假名 ↔ 字母数字」的边界插空格，
 * 让 shared 分得开（**分词规则仍然是 shared 那一份**，我只是喂给它更干净的分段）。
 */
export function keywordRelevance(query, text) {
  const q = mixedTokens(query);
  if (!q.length) return 0;
  const t = mixedTokens(text);
  if (!t.length) return 0;
  const qSet = new Set(q);
  const seen = new Set();
  let hit = 0;
  for (const token of t) {
    if (qSet.has(token) && !seen.has(token)) { hit += 1; seen.add(token); }
  }
  // 口径与 shared 一致：命中「查询词」的比例
  return hit / qSet.size;
}

/** 按「CJK ↔ 字母数字」边界插空格后交给 shared 分词，再滤掉停用词 */
function mixedTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  const spaced = s
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])([A-Za-z0-9])/gu, '$1 $2')
    .replace(/([A-Za-z0-9])([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '$1 $2');
  return tokenize(spaced).filter((token) => token && !STOPWORDS.has(token));
}

/**
 * 融合相关性：向量为主、关键词兜底。
 * 为什么不是纯向量：本地降级向量的哈希撞桶会带来噪声，
 * 关键词那一路能在「明明有共同词」时把分数顶上来（尤其短查询）。
 */
export function blendRelevance(vectorScore, keywordHit, weights = { vector: 0.8, keyword: 0.2 }) {
  const v = Number.isFinite(vectorScore) ? Math.max(0, vectorScore) : 0;
  const k = Number.isFinite(keywordHit) ? Math.max(0, keywordHit) : 0;
  return weights.vector * v + weights.keyword * k;
}

/**
 * 按元数据过滤（type / status / 时间范围）。
 * 默认只看 active —— superseded/archived/deleted 都不该出现在正常检索里。
 */
export function filterByMetadata(records, options = {}) {
  const statuses = options.statuses || ['active'];
  return filterRecords(records, {
    statuses,
    types: options.types || null,
    since: options.since,
    until: options.until,
  });
}

/**
 * 召回第一步：宽口径取候选。
 *
 * @param {string|object} query 原始查询（也接受 rewriteQuery 的结果）
 * @param {object} params
 *   records      记录数组（已经过元数据过滤）
 *   embedder     createMemoryEmbedder() 的结果；不传则走本地关键词路径
 *   queryVector  已经算好的查询向量（engine 会复用，避免重复嵌入）
 *   topK         召回条数
 *   minRelevance 相关性下限
 * @returns {Promise<Array>} [{ record, relevance, vectorScore, keywordScore, rewrote }]
 */
export async function recall(query, params = {}) {
  const records = Array.isArray(params.records) ? params.records : [];
  const embedder = params.embedder || null;

  // query 允许是 rewriteQuery 的结果，避免同一句话被改写两次
  const rewritten = typeof query === 'object' && query
    ? query
    : rewriteQuery(query);
  const queryText = String(rewritten.rewritten || rewritten.original || '');
  const keywords = Array.isArray(rewritten.keywords) && rewritten.keywords.length
    ? rewritten.keywords
    : extractKeywords(queryText);

  let queryVector = params.queryVector || null;
  if (!queryVector && embedder && typeof embedder.embedOne === 'function') {
    queryVector = await embedder.embedOne(queryText);
  }

  const topK = Number.isFinite(params.topK) && params.topK > 0 ? Math.floor(params.topK) : MAX_RECALL;
  const minRelevance = Number.isFinite(params.minRelevance) ? params.minRelevance : RELEVANCE_FLOOR;
  const now = Number.isFinite(params.now) ? params.now : Date.now();

  const candidates = [];
  for (const record of records) {
    if (!record || !record.content) continue;

    let vectorScore = 0;
    if (queryVector && Array.isArray(record.embedding) && record.embedding.length === queryVector.length) {
      vectorScore = cosine(queryVector, record.embedding);
    } else if (queryVector && embedder && Array.isArray(record.embedding) && record.embedding.length) {
      // 维度不一致（换过后端/换过模型）：用本地向量重算这一条，保证还能比
      vectorScore = cosine(embedder.localFor(queryText), embedder.localFor(record.content));
    }

    const keywordScore = keywordRelevance(queryText, record.content);
    const relevance = blendRelevance(vectorScore, keywordScore);

    if (relevance < minRelevance) continue;
    candidates.push({
      record,
      relevance,
      vectorScore,
      keywordScore,
      category: record.type,
      ageDays: Math.max(0, (now - record.updated_at) / DAY_MS),
    });
  }

  candidates.sort((a, b) => (b.relevance - a.relevance) || String(a.record.id).localeCompare(String(b.record.id)));
  return candidates.slice(0, topK);
}

/**
 * 「这条新内容像不像库里的某条」—— consolidation 复用召回逻辑。
 * 与 recall 的区别：不问「和查询相关吗」，而是「和这条候选记忆是不是同一件事」。
 *
 * @returns {Promise<Array>} 按相关性降序的候选（未精排）
 */
export async function findSimilar(candidateContent, params = {}) {
  const rewritten = rewriteQuery(candidateContent);
  // 相似度比较不看疑问词，所以直接用原始内容抽关键词
  rewritten.keywords = extractKeywords(candidateContent);
  rewritten.rewritten = String(candidateContent || '').trim();
  return recall(rewritten, params);
}

/** 供 stats/调试：当前召回配置 */
export function describeRecallPolicy() {
  return {
    defaultRecallMultiplier: DEFAULT_RECALL_MULTIPLIER,
    maxRecall: MAX_RECALL,
    relevanceFloor: RELEVANCE_FLOOR,
    defaultStatuses: ['active'],
    rewrite: ['去句首客套', '删句尾疑问块与语气词', '抽关键词', '（不做代词消解/同义扩展）'],
  };
}
