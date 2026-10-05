// ============================================================
// Context Engine · 裁剪与排序
//
// 目标是把「无限增长」这件事挡在门外：
//   · Memory 无限注入     → 每层有预算，超了就裁
//   · Knowledge 无限注入  → 同上，且按相关度裁
//   · Tool Result 无限增长 → 老结果先被压成一行占位
//   · Agent History 无限增长 → 同 Tool Result，按层预算裁
//
// 裁剪顺序（重要）：**先按分数裁低价值的，再按时间裁旧的**。
// 只按时间裁会把「很久以前但极重要」的记忆丢掉，那正是长期记忆存在的意义。
// ============================================================
import { PROTECTED_LAYERS, costOf, layerCap } from './types.js';

/**
 * 给一段候选内容算「该不该留」的综合分。
 *
 * 权重是刻意配的：相关性第一，其次重要度，再其次新鲜度与置信度。
 * 这个公式与 Memory 的 reranker 保持**同一个方向**（不是同一份代码：
 * Context Engine 不该依赖 Memory 的内部实现，那是反向耦合）。
 */
export function scoreItem(item) {
  const it = item && typeof item === 'object' ? item : {};
  const relevance = clamp01(it.relevance, 0.5);   // 没给就当中等，别一刀切丢掉
  const importance = clamp01(it.importance, 0.5);
  const confidence = clamp01(it.confidence, 0.8);
  const recency = clamp01(it.recency, 0.6);
  const priority = clamp01(it.priority, 0.5);
  return 0.40 * relevance + 0.25 * importance + 0.15 * priority + 0.12 * recency + 0.08 * confidence;
}

function clamp01(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(1, n));
}

/**
 * 把一层的候选裁到给定 token 上限。
 *
 * @param {object[]} items  每项 { text, ...元数据(score 用) }
 * @param {number} cap      token 上限（<=0 表示这一层不要）
 * @param {object} opts     { keepAll: boolean } 受保护层用 keepAll 跳过裁剪
 * @returns {{ kept: object[], dropped: object[], usedTokens: number }}
 */
export function trimLayer(items, cap, opts = {}) {
  const list = Array.isArray(items) ? items.filter((x) => x && String(x.text || '').length) : [];
  if (opts.keepAll) {
    const used = list.reduce((n, it) => n + costOf(it.text), 0);
    return { kept: list, dropped: [], usedTokens: used };
  }
  if (!(cap > 0)) {
    return { kept: [], dropped: list.map((it) => Object.assign({}, it, { droppedReason: 'no-budget' })), usedTokens: 0 };
  }

  // 先按分数降序，同分按原文顺序（稳定，避免每次请求顺序抖动导致 prompt 缓存失效）
  const ranked = list
    .map((it, i) => ({ it, i, score: scoreItem(it) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i));

  const keptIdx = [];
  const dropped = [];
  let used = 0;
  for (const { it, i, score } of ranked) {
    const cost = costOf(it.text);
    if (used + cost <= cap) {
      keptIdx.push({ it, i, score });
      used += cost;
    } else {
      dropped.push(Object.assign({}, it, { droppedReason: 'over-budget', _score: Number(score.toFixed(4)) }));
    }
  }
  // 呈现顺序回到「调用方给的顺序」：裁剪只决定留不留，不重排内容
  keptIdx.sort((a, b) => a.i - b.i);
  const kept = keptIdx.map(({ it, score }) => Object.assign({}, it, { _score: Number(score.toFixed(4)) }));
  return { kept, dropped, usedTokens: used };
}

/**
 * 对「历史消息数组」做预算裁剪（Chat 的 recent、Agent 的 tool results 都用它）。
 *
 * 策略：**从最新往回留**；放不下的旧消息被替换成一行占位而不是直接消失 ——
 * 直接消失会让模型以为「这事没发生过」，占位至少告诉它「这里省略了 N 条」。
 */
export function trimMessages(messages, cap) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (!(cap > 0)) {
    return {
      kept: [],
      dropped: list.map((m) => ({ role: m && m.role, droppedReason: 'no-budget' })),
      usedTokens: 0,
      omitted: list.length,
    };
  }
  const out = list.slice();
  let omitted = 0;
  // 第一步：从最新往回量，找出「从哪一条开始放不下」
  let used = 0;
  let firstKept = out.length;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const msg = out[i];
    if (!msg) { firstKept = i; continue; }
    const cost = costOf(contentText(msg));
    if (used + cost <= cap) {
      used += cost;
      firstKept = i;
      continue;
    }
    break;
  }
  // **最新的一条必须原样保留**：它整条超预算也不能被替换成占位，
  // 否则模型会看不到用户刚说的话（这是最不能接受的一种「省 token」）。
  if (out.length && firstKept === out.length) firstKept = out.length - 1;
  // 占位必须是**极短**的：它自己也要吃预算。
  // 早期版本每条占位写「（更早的一条消息已省略：约 N tokens）」→ 一条就 ~24 token，
  // 200 条历史光是占位就 4800 token，预算形同虚设（有测试抓到过）。
  // 现在统一压成一个字，省略了多少条由 omitNotice 一次性说明；
  // 而且最多保留 MAX_PLACEHOLDERS 条占位 —— 更早的连占位都不值当，直接丢掉。
  const MAX_PLACEHOLDERS = 40;
  let placeholders = 0;
  for (let i = firstKept - 1; i >= 0; i -= 1) {
    const msg = out[i];
    if (!msg) continue;
    if (placeholders >= MAX_PLACEHOLDERS) {
      out[i] = null;
      omitted += 1;
      continue;
    }
    out[i] = { role: msg.role, content: '省略', _omitted: true };
    placeholders += 1;
    omitted += 1;
  }
  // 占位本身也要算进预算，超出就把最老的占位也丢掉（保最新是铁律）
  let compacted = out.filter(Boolean);
  let costNow = compacted.reduce((n, m) => n + costOf(contentText(m)), 0);
  while (costNow > cap && compacted.length > 1 && compacted[0] && compacted[0]._omitted) {
    compacted = compacted.slice(1);
    costNow = compacted.reduce((n, m) => n + costOf(contentText(m)), 0);
  }
  const realUsed = costNow;
  const omitNotice = omitted > 0 ? '（更早的 ' + omitted + ' 条消息已省略）' : '';
  return { kept: compacted, dropped: [], usedTokens: realUsed, omitted, omitNotice };
}

/** 取消息的文本内容（兼容 content 是数组的多模态格式） */
export function contentText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join(' ');
  return '';
}

/**
 * 全层裁剪：按 LAYER_ORDER 依次分配预算，受保护层不裁。
 *
 * @param {object} layers  { [layer]: items[] | messages[] }
 * @param {object} budget  resolveBudget 的结果
 * @param {object} opts    { protectedLayers }
 * @returns {{ layers, descriptors, totalTokens, dropped }}
 */
export function trimAll(layers, budget, opts = {}) {
  const protectedLayers = opts.protectedLayers || PROTECTED_LAYERS;
  const result = {};
  const descriptors = [];
  const droppedAll = [];
  let used = 0;

  for (const layer of Object.keys(layers)) {
    const raw = layers[layer];
    const isProtected = protectedLayers.includes(layer);
    const cap = isProtected ? Infinity : layerCap(layer, budget, used);
    const isMessages = Array.isArray(raw) && raw.length > 0 && raw[0] && raw[0].role;

    let kept;
    let dropped;
    let usedTokens;
    let omitted = 0;
    let omitNotice = '';
    if (isMessages) {
      const r = trimMessages(raw, cap);
      kept = r.kept;
      dropped = r.dropped;
      usedTokens = r.usedTokens;
      omitted = r.omitted;
      omitNotice = r.omitNotice || '';
    } else {
      const r = trimLayer(raw, cap, { keepAll: isProtected });
      kept = r.kept;
      dropped = r.dropped;
      usedTokens = r.usedTokens;
    }

    result[layer] = kept;
    used += usedTokens;
    droppedAll.push(...dropped.map((d) => Object.assign({ layer }, d)));
    descriptors.push({
      layer,
      items: Array.isArray(kept) ? kept.length : 0,
      dropped: Array.isArray(dropped) ? dropped.length : 0,
      omittedMessages: omitted,
      omitNotice,
      tokenCost: usedTokens,
      budget: isProtected ? null : (Number.isFinite(cap) ? cap : null),
      protected: isProtected,
    });
  }
  return { layers: result, descriptors, totalTokens: used, dropped: droppedAll };
}
