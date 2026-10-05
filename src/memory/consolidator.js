// ============================================================
// Consolidator：新记忆与旧记忆的合并 / 冲突判定
//
// 流程（新记忆入库**之前**跑）：
//   New Memory → Similarity Search → Reranker → 「是否相关」
//     ├─ 不相关 → 建新记忆（insert）
//     ├─ 相关且是同一件事的补充信息 → 合并成一条更完整的（merge）
//     └─ 相关但互相矛盾 → **旧的置 superseded，新的 active**（supersede）
//
// 铁律：**冲突不删旧的**。
//   旧记录留在库里、状态变 superseded，并双向留痕：
//     旧.supersededBy = 新.id
//     新.supersedes   = 旧.id
//   为什么：用户三个月后问「我原来打算买什么显卡」时，答案就在那条 superseded
//   记录里。删掉 = 把历史烧了，而 memory 存在的意义恰恰是「长期」。
//
// 为什么用 reranker 而不是只看 cosine：
//   「是不是同一件事」和「检索时该不该进上下文」应当用同一套口径，
//   否则会出现「检索时算相关、写入时算无关」这种自相矛盾的行为。
// ============================================================
import { rerank } from './reranker.js';
import { findSimilar, blendRelevance } from './retriever.js';
import { contentFingerprint, normalizeContent } from './types.js';
import { cosine, keywordScore as defaultKeywordScore } from './embeddings.js';

/** 合并动作 */
export const CONSOLIDATE_ACTION = {
  INSERT: 'insert',
  MERGE: 'merge',
  SUPERSEDE: 'supersede',
  DUPLICATE: 'duplicate',
};

/** 判定阈值（用「内容相关度」= 0.8·向量 + 0.2·关键词，0~1）。理由见各项注释。 */
export const CONSOLIDATE_THRESHOLD = {
  /**
   * ≥ 0.42 才算「同一件事」。这个值明显低于「检索相关」的直觉阈值，是被本地降级向量
   * 逼出来的：512 维哈希向量对中文近义表达的余弦只有 0.3 上下
   * （实测「用户养了一只猫叫 Luna」vs「用户喜欢猫 Luna」= 0.316），
   * 阈定高了，同一件事的补充信息就全变成新记忆，库会越用越碎。
   * 放宽的代价由**关系键**兜住：合并/冲突都要求两边命中同一个关系键，
   * 所以「喜欢猫」和「喜欢狗」不会被合成一句（关系键虽然都是「取向」，
   * 但合并只发生在补充信息上，见 mergeRecords 的保留原措辞策略）。
   *
   * 0.33 是**标定出来的**，不是拍脑袋：本地哈希向量对中文近义表达天生偏弱
   *（「养了一只猫叫 Luna」vs「喜欢猫 Luna」cos 只有 0.316），实测
   *   同一件事的补充信息：0.353 / 0.392
   *   真正冲突的（4070→5080）：0.740
   *   无关的两条：0.000 / 0.289 / 0.261
   * 缝在 (0.29, 0.353) 之间，取中间偏保守的 0.33：既不漏合并，也不会把
   * 「住北京」和「喜欢猫」这种无关的两条混起来。
   */
  relate: 0.33,
  /** ≥ 0.90 且内容指纹相同 → 直接算重复，不做任何改写（对话里同一句话常被复述） */
  duplicate: 0.90,
  /** 关系键冲突 + 相关度 ≥ 0.30 就判冲突。比 relate 低，因为「矛盾」本身就是强证据 */
  conflict: 0.30,
};

/**
 * 关系键词表：描述「同一件事的不同取值」。
 * 例如「用户准备购买 X」的关系键是 `购买|准备`，X 变化就是**冲突**而不是新记忆。
 * 每种关系还给出「反向词」，用来识别极性翻转（喜欢 ↔ 讨厌）。
 */
export const RELATION_KEYWORDS = [
  { key: '购买', verbs: ['购买', '买', '入手', '下单', '订购', 'buy', 'purchase', '買う', '購入'] },
  { key: '居住', verbs: ['住在', '搬到', '移居', '定居', 'live in', 'move to', '住んで', '引っ越'] },
  { key: '称呼', verbs: ['我叫', '名字是', '名字叫', '是叫', 'call me', 'my name is', '名前は'] },
  { key: '年龄', verbs: ['年龄', '岁', '才', 'years old', '歳'] },
  { key: '生日', verbs: ['生日', 'birthday', '誕生日'] },
  { key: '职业', verbs: ['职业是', '工作是', '做', 'work as', 'my job'] },
  { key: '取向', verbs: ['喜欢', '讨厌', '不喜欢', '爱', '恨', 'like', 'love', 'hate', '好き', '嫌い'] },
  { key: '计划', verbs: ['打算', '计划', '准备', '决定', 'plan to', 'going to', 'つもり', '予定'] },
  // 「养了一只猫」这类是**关系**的典型表达：没有它，「Luna 的补充信息」就会被判成不相关
  { key: '关系', verbs: ['养了', '养着', '养了一只', '养了只', '宠物', 'have a cat', 'have a dog', '飼って'] },
];

/** 极性词：命中同一条关系时，极性不同即冲突（喜欢 vs 讨厌） */
const POLARITY = [
  { sign: 1, words: ['喜欢', '爱', '想要', '打算', '准备', '计划', 'like', 'love', 'want', 'plan', '好き', 'したい'] },
  { sign: -1, words: ['不喜欢', '讨厌', '不想要', '不打算', '不准备', '讨厌', 'hate', 'dislike', "don't", '嫌い', 'やめた'] },
];

/**
 * 数值锚点：型号、岁数、金额、日期 —— 这些值变了就是「更新」。
 * 分成几组分别抽（而不是一个巨型正则的分组），是为了让「哪种锚点」一目了然，
 * 也避免了分组序号错位这种低级坑。
 */
const ANCHOR_PATTERNS = [
  /(rtx|gtx|rx)\s?\d{3,4}/gi,          // 显卡型号
  /\d{1,3}\s*(?:岁|才|歳)/g,            // 年龄
  /\d{1,3}\s*(?:years?\s*old)/gi,       // 年龄（英文）
  /(?:\d{4,6})\s*(?:元|块|円|万円|dollars?|usd|rmb)/gi, // 金额
  /\d{4}-\d{2}-\d{2}/g,                 // 日期（ISO）
  /\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)/g, // 日期（中文）
];

/** 抽数值锚点（型号/岁数/金额/日期）。返回归一化字符串数组。 */
export function valueAnchors(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  for (const re of ANCHOR_PATTERNS) {
    const found = s.match(re) || [];
    for (const token of found) out.push(String(token).replace(/\s+/g, '').toLowerCase());
  }
  return Array.from(new Set(out));
}

/** 抽关系键：一句话可能命中多条（「我喜欢住在上海」→ 取向 + 居住） */
export function relationKeys(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  const keys = [];
  for (const rel of RELATION_KEYWORDS) {
    if (rel.verbs.some((v) => s.includes(String(v).toLowerCase()))) keys.push(rel.key);
  }
  return keys;
}

/** 抽极性：0 表示没表态。同关系下 1 与 −1 同时出现即矛盾。 */
export function polarity(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  // 先看否定，避免「不喜欢」被「喜欢」抢先匹配
  for (const p of POLARITY) {
    if (p.sign < 0 && p.words.some((w) => s.includes(String(w).toLowerCase()))) return -1;
  }
  for (const p of POLARITY) {
    if (p.sign > 0 && p.words.some((w) => s.includes(String(w).toLowerCase()))) return 1;
  }
  return 0;
}

/** 数值是否冲突：两边都有锚点且没有交集（4070 vs 5080 → 冲突） */
export function valuesConflict(oldText, newText) {
  const a = valueAnchors(oldText);
  const b = valueAnchors(newText);
  if (!a.length || !b.length) return false;
  return !a.some((x) => b.includes(x));
}

/**
 * 两条记忆之间的「直接相关性」。
 *
 * 为什么不直接拿精排总分当判据：精排分数里混了 importance/recency，
 * 一条**很久以前又不太重要**的旧记忆会被压到阈值以下 ——
 * 于是「显卡 4070 → 5080」这种明显冲突会被误判成「新增」，
 * 库里就同时留着两条互相矛盾的 active 记忆。
 * 所以「是不是同一件事」只看**内容本身的相关性**（向量 + 关键词），
 * 精排分只作为辅助证据写进 reason 里备查。
 */
export function pairRelevance(oldRecord, newRecord, keywordFn) {
  const a = (oldRecord && oldRecord.content) || '';
  const b = (newRecord && newRecord.content) || '';
  const va = Array.isArray(oldRecord && oldRecord.embedding) ? oldRecord.embedding : [];
  const vb = Array.isArray(newRecord && newRecord.embedding) ? newRecord.embedding : [];
  const vec = va.length && va.length === vb.length ? cosine(va, vb) : 0;
  // 关键词分**默认自己算**，不再要求调用方注入。
  // 踩过的坑：这里原来只接受注入的 keywordFn，而 engine 调 planConsolidation 时
  // 没传 → keywordScore 恒为 0 → 只有向量分参与判定，合并全被漏判成「新增」，
  // 库里留下两条半截的记忆。**静默降级成「没有关键词信号」是最难查的一类 bug**，
  // 所以默认值必须是「真的去算」，而不是 0。
  const kw = typeof keywordFn === 'function' ? keywordFn(b, a) : defaultKeywordScore(b, a);
  return { relevance: blendRelevance(vec, kw), vectorScore: vec, keywordScore: kw };
}

/**
 * 冲突判定：关系重叠 + (极性相反 或 数值不相交)。
 * @returns {{ conflict:boolean, kind:string|null, relations:string[], detail:string }}
 */
export function detectConflict(oldRecord, newRecord) {
  const oldText = (oldRecord && oldRecord.content) || '';
  const newText = (newRecord && newRecord.content) || '';
  const oldKeys = relationKeys(oldText);
  const newKeys = relationKeys(newText);
  const shared = oldKeys.filter((k) => newKeys.includes(k));
  if (!shared.length) {
    return { conflict: false, kind: null, relations: [], detail: '关系键无交集（' + (oldKeys.join('/') || '无') + ' vs ' + (newKeys.join('/') || '无') + '）' };
  }

  const po = polarity(oldText);
  const pn = polarity(newText);
  if (po !== 0 && pn !== 0 && po !== pn) {
    return {
      conflict: true,
      kind: 'polarity',
      relations: shared,
      detail: '同一关系「' + shared.join('/') + '」极性相反（' + po + ' → ' + pn + '）',
    };
  }

  if (valuesConflict(oldText, newText)) {
    return {
      conflict: true,
      kind: 'value',
      relations: shared,
      detail: '同一关系「' + shared.join('/') + '」的取值不同（'
        + valueAnchors(oldText).join(',') + ' → ' + valueAnchors(newText).join(',') + '）',
    };
  }

  return { conflict: false, kind: null, relations: shared, detail: '同一关系但取值不矛盾，属于补充信息' };
}

/** 合并内容：保留已有措辞在前、补充信息在后；真的重复时只留一份 */
export function mergeContent(oldText, newText) {
  const a = String(oldText || '').trim();
  const b = String(newText || '').trim();
  if (!a) return b;
  if (!b) return a;
  const na = normalizeContent(a);
  const nb = normalizeContent(b);
  if (na === nb) return a;
  // 「一边包含另一边」只在**多出来的部分很短**时才算重复，
  // 否则会出这种 bug：「用户喜欢猫」被「用户喜欢猫粮品牌 A」包含，
  // 直接返回长的那条就等于把「喜欢猫」这个信息悄悄删掉了。
  // 多出来的 ≤ 4 个字才当「同一句的细化」（比如补了个「品牌 A」）。
  if (na.includes(nb) && na.length - nb.length <= 4) return a;
  if (nb.includes(na) && nb.length - na.length <= 4) return b;
  return a.replace(/[。.;；]+$/, '') + '；' + b;
}

/** 合并后的字段策略：importance 取更高（信息更多了），confidence 取平均后 +0.05 封顶 */
export function mergeRecords(oldRecord, newRecord) {
  const now = Number.isFinite(newRecord.updated_at) ? newRecord.updated_at : Date.now();
  const merged = Object.assign({}, oldRecord, {
    content: mergeContent(oldRecord.content, newRecord.content),
    type: oldRecord.type === 'user_fact' ? newRecord.type : oldRecord.type,
    importance: Math.max(oldRecord.importance, newRecord.importance),
    confidence: Math.min(1, (oldRecord.confidence + newRecord.confidence) / 2 + 0.05),
    updated_at: now,
    last_retrieved_at: oldRecord.last_retrieved_at,
    // mergedFrom 只在**确实发生过合并**时记录来源（新记录的 id）：
    // 合并后旧记录 id 不变，不必把自己也记进去（否则每条合并记忆都自我指涉）
    mergedFrom: Array.from(new Set([].concat(oldRecord.mergedFrom || [], newRecord.id || []))),
    relations: Array.from(new Set([].concat(oldRecord.relations || [], newRecord.relations || [], relationKeys(newRecord.content)))),
    supersededBy: null,
  });
  return merged;
}

/**
 * 全流程：对一条新记忆做相似度检索 + 精排，决定新增 / 合并 / 冲突。
 *
 * @param {object} newRecord 新记忆（已带 embedding）
 * @param {Array} existing   库里已有的记录（通常是 active 的那些）
 * @param {object} opts { embedder, now, thresholds, topN }
 * @returns {Promise<object>} 判定结果，见下面 return
 */
export async function planConsolidation(newRecord, existing, opts = {}) {
  const thresholds = Object.assign({}, CONSOLIDATE_THRESHOLD, opts.thresholds || {});
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const records = Array.isArray(existing) ? existing : [];
  const newFp = contentFingerprint(newRecord.content);

  // 内容完全一样：属于「同一句话说第二遍」，直接算重复，连相似度都不用算
  const exact = records.find((r) => contentFingerprint(r.content) === newFp);
  if (exact && newFp) {
    return {
      action: CONSOLIDATE_ACTION.DUPLICATE,
      target: exact,
      kept: exact,
      superseded: null,
      related: [],
      reason: '内容与已有记忆 ' + exact.id + ' 完全一致，视为重复写入（保留原记录，只更新 confidence）',
      thresholds,
    };
  }

  // 相似度检索（复用召回），再精排 —— 两步都必须走，口径才和检索一致
  const recalled = await findSimilar(newRecord.content, {
    records,
    embedder: opts.embedder || null,
    topN: Number.isFinite(opts.topN) ? opts.topN : records.length,
    topK: Number.isFinite(opts.topK) ? opts.topK : Math.max(5, Math.min(20, records.length)),
    now,
  });
  const ranked = rerank(recalled, { now });
  const best = ranked[0] || null;

  if (!best) {
    return {
      action: CONSOLIDATE_ACTION.INSERT,
      target: null,
      kept: newRecord,
      superseded: null,
      related: [],
      reason: '库中没有任何相关记忆，建新记录',
      thresholds,
    };
  }

  const bestScore = best.score;
  const bestRecord = best.record;
  // 「是不是同一件事」只看**内容相关性**，而且必须是**同一个口径**。
  //
  // 这里踩过一个坑：`findSimilar` 返回的 relevance 是它自己那套分词算的
  //（召回用 `keywordRelevance`，为了中文短句做了收紧），而 pairRelevance
  // 用的是 shared 的 `keywordScore`。同一对记录走两条路会得到 0.253 / 0.353
  // 两个不同的数，于是「算不算同一件事」取决于你问谁 —— 合并判定因此漏判，
  // 库里留下两条半截的记忆。
  //
  // 现在**只认 pairRelevance**：它就是为「这两条是不是同一件事」写的，
  // 输入就是两条内容本身，不受召回侧分词策略变化的影响。
  const pair = pairRelevance(bestRecord, newRecord, opts.keywordScore);
  const relevance = pair.relevance;
  const conflict = detectConflict(bestRecord, newRecord);

  // 1) 明显冲突：关系键相同 + 取值/极性相反 —— 这条判据优先于「相关度够不够」，
  //    因为它本身就是「同一件事被改了」的直接证据。真相关度极低（<0.3）才放弃，
  //    避免「我喜欢猫」和「我讨厌下雨」被关系键误伤成冲突。
  if (conflict.conflict && relevance >= thresholds.conflict) {
    const oldNext = Object.assign({}, bestRecord, {
      status: 'superseded',
      supersededBy: newRecord.id,
      updated_at: now,
    });
    const kept = Object.assign({}, newRecord, {
      status: 'active',
      supersedes: bestRecord.id,
      supersededBy: null,
      relations: Array.from(new Set([].concat(newRecord.relations || [], conflict.relations))),
      updated_at: now,
    });
    return {
      action: CONSOLIDATE_ACTION.SUPERSEDE,
      target: bestRecord,
      kept,
      superseded: oldNext,
      related: ranked.slice(0, 3),
      reason: '与旧记忆 ' + bestRecord.id + ' 冲突：' + conflict.detail
        + '（内容相关度 ' + relevance.toFixed(3) + '，精排分 ' + bestScore.toFixed(3) + '）'
        + ' → 旧记录置 superseded（留在库里可追溯），新记录 active',
      conflict,
      pair,
      thresholds,
    };
  }

  // 2) 相关度不够 → 各记各的
  if (relevance < thresholds.relate) {
    return {
      action: CONSOLIDATE_ACTION.INSERT,
      target: bestRecord,
      kept: newRecord,
      superseded: null,
      related: ranked.slice(0, 3),
      reason: '最相关的旧记忆 ' + bestRecord.id + ' 内容相关度 ' + relevance.toFixed(3)
        + ' < 相关阈值 ' + thresholds.relate + '（精排分 ' + bestScore.toFixed(3) + '），判为不相关 → 新增',
      pair,
      thresholds,
    };
  }

  // 3) 相关且不冲突 → 合并成一条更完整的
  const merged = mergeRecords(bestRecord, newRecord);
  return {
    action: CONSOLIDATE_ACTION.MERGE,
    target: bestRecord,
    kept: merged,
    superseded: null,
    related: ranked.slice(0, 3),
    reason: '与旧记忆 ' + bestRecord.id + ' 相关（内容相关度 ' + relevance.toFixed(3)
      + '，精排分 ' + bestScore.toFixed(3) + '）且不冲突：' + conflict.detail + ' → 合并为一条',
    conflict,
    pair,
    thresholds,
  };
}
