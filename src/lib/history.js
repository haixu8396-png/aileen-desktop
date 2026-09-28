// ============================================================
// 对话上下文装配
//
// 以前是简单粗暴地 state.messages.slice(-12) —— 更早的内容被直接丢掉，
// 角色就会「失忆」：用户说过的事它完全不记得了。
//
// 现在的做法：
//   · 最近若干轮原样保留（保真）
//   · 更早的部分压成一条摘要，放在上下文最前面（不丢信息）
//   · 给用户消息加时间戳，让模型有时间感
//     —— 只给 user 加。给 assistant 也加的话，模型会照着学，
//        之后的回复开头会自己带上 [2026-09-24 10:31] 这种东西。
// ============================================================

/** 默认保留多少轮（一问一答算一轮）原文，之外的做压缩 */
export const DEFAULT_KEEP_TURNS = 8;

/** [2026-09-24 10:31] —— 带尾空格，直接拼在用户消息前面 */
export function formatTimePrefix(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return '[' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '] ';
}

/**
 * 把消息切成「要压缩的旧部分」和「原样保留的近期部分」。
 * 切点一定落在一条 user 消息上，避免出现「保留了 assistant 却没保留它对应的问题」。
 */
export function splitForCompaction(messages, keepTurns = DEFAULT_KEEP_TURNS) {
  const list = Array.isArray(messages) ? messages : [];
  if (!(keepTurns > 0)) return { older: [], kept: list.slice() };
  let seen = 0;
  let cut = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') {
      seen += 1;
      if (seen >= keepTurns) { cut = i; break; }
    }
  }
  return { older: list.slice(0, cut), kept: list.slice(cut) };
}

/** 摘要把被压掉的部分讲清楚，供模型续上下文 */
export function summarizable(messages) {
  return Array.isArray(messages) && messages.some((m) => m && String(m.content || '').trim());
}

/**
 * 装配最终发给模型的 history（不含 system 人设，那一层由调用方拼）。
 * 时间戳只加在 user 上。
 */
export function buildContextMessages({ kept, summary }) {
  const out = [];
  if (summary && String(summary).trim()) out.push({ role: 'system', content: String(summary).trim() });
  for (const m of (Array.isArray(kept) ? kept : [])) {
    if (!m) continue;
    const text = String(m.content == null ? '' : m.content);
    if (m.role === 'user' && m.at) out.push({ role: 'user', content: formatTimePrefix(m.at) + text });
    else out.push({ role: m.role, content: text });
  }
  return out;
}

/** 拿旧消息去换一段摘要时用的请求体 */
export function buildSummaryRequest(older, label) {
  const lines = [];
  for (const m of (Array.isArray(older) ? older : [])) {
    const text = String(m && m.content != null ? m.content : '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push((m.role === 'user' ? 'User: ' : 'Character: ') + text.slice(0, 400));
  }
  const body = lines.join('\n');
  return {
    system: String(label || ''),
    body: body.slice(0, 6000),
  };
}

/**
 * 摘要缓存：同一段前缀只会去让模型总结一次。
 * key 用「条数 + 最后一条的内容长度」就够区分了，不必做哈希。
 */
export function summaryKey(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list.length ? String(list[list.length - 1].content || '') : '';
  let sum = 0;
  for (const m of list) sum += String((m && m.content) || '').length;
  return list.length + ':' + sum + ':' + last.length;
}
