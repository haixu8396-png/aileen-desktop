// ============================================================
// Context Engine：把「角色是谁」和「现在在干什么」分层拼起来
//
// 这是这套设计的**核心约束**，写错一个字整条需求就废了：
//
//   Character Prompt（角色卡：简介/性格/场景/示例/自定义 system_prompt）
//   + Persona（人设生成的结果，就存在卡片里）
//   + Conversation Context（最近若干轮 + 早前摘要）
//   + Agent Task（这次要做什么）
//   + Tool Context（工具结果 / 截图 / OCR / 命令输出）
//   → Context Engine → LLM
//
// 铁律：
//   1. **角色人格永远是 system 的第 0 段**，能力说明只能接在它后面。
//      绝不能另起一份「你是个 Coding Agent」把人格替换掉 ——
//      Agent 只是给这个角色**加了行动能力**，不是换了一个人。
//   2. **Tool Result 不许碰 system**。工具结果一律走独立的 tool 消息
//      （provider 的 tool 协议就是这么分层的），system 在整轮循环里保持不变。
//      这就是「Tool Result 不可能覆盖 Character Prompt」的结构性保证：
//      它压根没有写 system 的通路。
// ============================================================
import { buildSystemPrompt } from '../lib/characters.js';
import { buildAgentSystemPrompt } from './planner.js';

/** Context 的分层名字（便于测试和排查时指认是哪一层出的问题） */
export const CONTEXT_LAYERS = [
  'character',    // 角色卡本体（含 Persona / Scenario / Example / System Prompt）
  'capability',   // 这次能用哪些工具、边界在哪
  'conversation', // 对话历史（由调用方以 messages 形式给）
  'task',         // 本次任务
  'tool',         // 工具结果（独立 tool 消息，绝不进 system）
];

/**
 * 拼系统提示词：**角色人格在前，能力说明在后**。
 *
 * @param {object} params
 *   card        角色卡（state.current.data）
 *   tools       本次可用的工具定义数组
 *   workspace   工作区路径（可空）
 *   task        本次任务（可空；不传则只给能力说明，不给任务）
 * @returns {string}
 */
export function buildPersonaSystemPrompt({ card, tools, workspace, task } = {}) {
  // 第 0 段：角色人格。卡片自带 system_prompt 时它就是人格本身。
  const character = buildSystemPrompt(card);

  // 第 1 段：能力说明（「你有哪些工具、边界在哪」）—— 只是附加，不替代人格。
  const capability = buildAgentSystemPrompt({ task, workspace, tools });

  return [character, capability].filter((s) => s && String(s).trim()).join('\n\n---\n\n');
}

/**
 * 拼这一轮真正发给模型的 user 消息。
 *
 * 任务 + 工具上下文都放在**这一条 user 消息**里，而不是塞进 system：
 *   · 塞进 system 会污染人格（下一轮就得重拼，还可能把人格挤掉）；
 *   · 放在 user 消息里，与「用户说了什么」同层，符合对话语义。
 */
export function buildTaskMessage({ task, toolContext, extra } = {}) {
  const parts = [];
  const t = String(task || '').trim();
  if (t) parts.push(t);
  const ctx = String(toolContext || '').trim();
  if (ctx) parts.push('【当前环境信息】\n' + ctx);
  const ex = String(extra || '').trim();
  if (ex) parts.push(ex);
  return parts.join('\n\n');
}

/**
 * 工具上下文摘要：把「屏幕/窗口/工作区」这类即时信息给模型，让它少浪费一轮工具调用。
 * 全部是**外部事实**，不含任何人格成分。
 */
export function buildToolContext({ workspace, screen, windows, cursor } = {}) {
  const lines = [];
  if (workspace) lines.push('- 工作区：' + String(workspace));
  if (screen && (screen.width || screen.count)) {
    lines.push('- 屏幕：' + (screen.count || 1) + ' 个可捕获源，主源 ' + (screen.width || '?') + '×' + (screen.height || '?'));
  }
  if (cursor && Number.isFinite(cursor.x)) {
    lines.push('- 鼠标当前位置：(' + cursor.x + ', ' + cursor.y + ')'
      + (cursor.scale && cursor.scale !== 1 ? '（该屏幕缩放 ' + cursor.scale + '×）' : ''));
  }
  if (Array.isArray(windows) && windows.length) {
    lines.push('- 可见窗口（前 ' + Math.min(windows.length, 10) + ' 个）：' + windows.slice(0, 10).join(' / '));
  }
  return lines.join('\n');
}

/**
 * 组装一次 LLM 请求的消息数组：system（人格+能力）→ 对话历史 → 本次任务。
 *
 * @param {object} params
 *   systemPrompt  已拼好的提示词（buildPersonaSystemPrompt 的结果）
 *   history       之前的对话消息 [{role, content}]
 *   taskMessage   本次任务（buildTaskMessage 的结果）
 */
export function buildAgentRequest({ systemPrompt, history, taskMessage } = {}) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: String(systemPrompt) });
  for (const m of history || []) {
    if (m && m.role && m.content != null) out.push({ role: m.role, content: m.content });
  }
  if (taskMessage) out.push({ role: 'user', content: String(taskMessage) });
  return out;
}

/**
 * 自检用：确认人格还在。
 *
 * 这是把「不许丢人格」变成**可断言**的东西 ——
 * 每次进入 Agent 之前跑一遍，丢了就抛错，而不是等用户发现角色变成机器人。
 */
export function assertPersonaPreserved(card, systemPrompt) {
  // 顺序很重要：**先确认提示词本身不是空的**。
  // 反过来的话，persona 为空串时 indexOf('') === 0 会"匹配成功"，
  // 把最坏的情况（没有人格也没有提示词）判成通过。
  const prompt = String(systemPrompt == null ? '' : systemPrompt);
  if (!prompt.trim()) {
    throw new Error('Agent 系统提示词为空 —— 不能在没有提示词的情况下进入 Agent 模式');
  }
  const persona = String(buildSystemPrompt(card) || '');
  if (!persona.trim()) {
    throw new Error('角色人格为空：角色卡可能损坏，拒绝进入 Agent 模式');
  }
  if (prompt.indexOf(persona) < 0) {
    throw new Error('Agent 系统提示词里找不到角色人格 —— 这会让人格被替换掉，已中止');
  }
  if (prompt.indexOf(persona) !== 0) {
    throw new Error('角色人格必须是系统提示词的第一段（当前不在开头），已中止');
  }
  return true;
}

/**
 * 供自检/测试使用：人格那一段到底在不在、在第几位。
 * 不抛错，只回报事实 —— 需要断言时用 assertPersonaPreserved。
 */
export function personaPosition(card, systemPrompt) {
  const prompt = String(systemPrompt == null ? '' : systemPrompt);
  const persona = String(buildSystemPrompt(card) || '');
  const at = persona ? prompt.indexOf(persona) : -1;
  return {
    hasPersona: !!persona.trim(),
    found: at >= 0,
    at,
    first: at === 0,
    personaChars: persona.length,
    promptChars: prompt.length,
  };
}
