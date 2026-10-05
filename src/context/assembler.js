// ============================================================
// Context Engine · 拼装（把各层拼成一次请求）
//
// 拼装规则是**结构性**的，不靠调用方自觉：
//   1. system 消息**只有一条**，它的第一段永远是角色人格；
//   2. 其余各层按固定顺序转成 system / user 段落，绝不覆盖第 0 段；
//   3. 工具结果只以 tool 消息出现，**没有写 system 的通路**。
//
// 第 2 条特别说明：为什么 memory / knowledge 拼成「一条 system 里的附加段落」
// 而不是各自的 system 消息 —— 多条 system 在不同 provider 上行为不一致
//（有的只取第一条、有的合并），拼成一条最稳。
// ============================================================
import { LAYER, LAYER_ORDER, estimateTokens } from './types.js';

/** 各层在提示词里的中文标签（模型看得懂中文标签，也方便排查是哪层塞的） */
const LAYER_LABEL = {
  [LAYER.MEMORY]: '关于用户，你长期记得的事',
  [LAYER.KNOWLEDGE]: '参考资料（来自知识库，引用时请说明来源）',
  [LAYER.AGENT_STATE]: '当前任务状态',
  [LAYER.TOOL_RESULTS]: '上一次操作的结果',
};

/**
 * 把一个层的内容转成一段文本。
 * 支持两种形态：{text} 数组（memory/knowledge）或纯字符串数组。
 */
export function renderLayerItems(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const it of list) {
    if (it == null) continue;
    const text = typeof it === 'string' ? it : String(it.text || '');
    if (!text.trim()) continue;
    out.push(text.trim());
  }
  return out.join('\n');
}

/** 把一层包成带标签的段落（空层返回空串） */
export function renderLayerSection(layer, items) {
  const body = renderLayerItems(items);
  if (!body) return '';
  const label = LAYER_LABEL[layer];
  if (!label) return body;
  return '【' + label + '】\n' + body;
}

/**
 * 组装成 provider 能吃的消息数组。
 *
 * @param {object} trimmed  trimAll 的结果 { layers }
 * @param {object} opts
 *   baseSystem  角色人格那段（必填；它就是 system 的第 0 段）
 *   history     对话历史消息（会在合适位置插入）
 * @returns {{ messages: object[], sections: object[] }}
 */
export function assembleMessages(trimmed, opts = {}) {
  const layers = (trimmed && trimmed.layers) || {};
  const baseSystem = String(opts.baseSystem || '');
  const sections = [];

  // ---- 第 0 段：人格。永远第一，且这里不再往里塞别的层 ----
  const systemParts = [];
  if (baseSystem) {
    systemParts.push(baseSystem);
    sections.push({ layer: 'character', where: 'system[0]', tokens: estimateTokens(baseSystem) });
  }

  // ---- 附加到 system 的层（按固定顺序）----
  for (const layer of LAYER_ORDER) {
    if (layer === LAYER.SYSTEM || layer === LAYER.CHARACTER || layer === LAYER.PERSONA) continue;
    if (layer === LAYER.RECENT || layer === LAYER.TOOL_RESULTS) continue;   // 这两层走消息，不进 system
    const section = renderLayerSection(layer, layers[layer]);
    if (!section) continue;
    systemParts.push('---\n' + section);
    sections.push({ layer, where: 'system[extra]', tokens: estimateTokens(section) });
  }

  const messages = [];
  if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') });

  // ---- 对话历史 ----
  const recent = Array.isArray(layers[LAYER.RECENT]) ? layers[LAYER.RECENT] : [];
  for (const m of recent) {
    if (!m || !m.role) continue;
    messages.push({ role: m.role, content: m.content });
  }
  if (recent.length) sections.push({ layer: LAYER.RECENT, where: 'messages', tokens: recent.reduce((n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')), 0) });

  // ---- 工具结果：只以 tool 消息出现 ----
  const tools = Array.isArray(layers[LAYER.TOOL_RESULTS]) ? layers[LAYER.TOOL_RESULTS] : [];
  for (const t of tools) {
    if (!t) continue;
    if (t.role === 'tool' && t.tool_call_id) {
      messages.push({ role: 'tool', tool_call_id: t.tool_call_id, content: t.content });
    } else {
      // 没有 tool_call_id 的（比如屏幕摘要）退化成一条 user 消息，
      // **不进 system** —— 这条边界不能破
      messages.push({ role: 'user', content: String(t.text || t.content || '') });
    }
  }
  if (tools.length) sections.push({ layer: LAYER.TOOL_RESULTS, where: 'messages', tokens: tools.reduce((n, t) => n + estimateTokens(String(t.content || t.text || '')), 0) });

  return { messages, sections };
}

/**
 * 组装一份带元数据的 Context 包。
 *
 * 每一部分都记 source / priority / relevance / token cost ——
 * 这是需求里明确要的，也是「为什么这次回答是这样」的唯一线索。
 */
export function buildContextBundle(trimmed, opts = {}) {
  const { messages, sections } = assembleMessages(trimmed, opts);
  const descriptors = (trimmed && trimmed.descriptors) || [];
  const byLayer = new Map(descriptors.map((d) => [d.layer, d]));
  const report = sections.map((s) => {
    const d = byLayer.get(s.layer) || {};
    return {
      layer: s.layer,
      source: (opts.sources && opts.sources[s.layer]) || defaultSource(s.layer),
      where: s.where,
      priority: priorityOf(s.layer),
      relevance: d.relevance,
      tokenCost: s.tokens,
      items: d.items || 0,
      dropped: d.dropped || 0,
      protected: !!d.protected,
    };
  });
  return {
    messages,
    segments: report,
    totalTokens: report.reduce((n, r) => n + r.tokenCost, 0),
    budget: (trimmed && trimmed.budget) || null,
    dropped: (trimmed && trimmed.dropped) || [],
    warnings: collectWarnings(trimmed),
  };
}

function defaultSource(layer) {
  switch (layer) {
    case 'character': return 'character-card';
    case LAYER.MEMORY: return 'memory-engine';
    case LAYER.KNOWLEDGE: return 'knowledge-engine';
    case LAYER.RECENT: return 'chat-history';
    case LAYER.AGENT_STATE: return 'agent-runtime';
    case LAYER.TOOL_RESULTS: return 'agent-tools';
    default: return 'unknown';
  }
}

function priorityOf(layer) {
  switch (layer) {
    case 'character': return 'identity';       // 不可裁
    case LAYER.RECENT: return 'high';
    case LAYER.MEMORY: return 'medium';
    case LAYER.KNOWLEDGE: return 'medium';
    case LAYER.AGENT_STATE: return 'high';
    case LAYER.TOOL_RESULTS: return 'low';
    default: return 'medium';
  }
}

/** 把「哪层被裁了 / 为什么」变成可读警告，便于界面提示与排查 */
function collectWarnings(trimmed) {
  const out = [];
  for (const d of (trimmed && trimmed.descriptors) || []) {
    if (d.dropped > 0) out.push(d.layer + '：有 ' + d.dropped + ' 条因为超出预算被裁掉');
    if (d.omittedMessages > 0) out.push(d.layer + '：有 ' + d.omittedMessages + ' 条更早的消息被压成占位');
  }
  return out;
}
