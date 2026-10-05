// ============================================================
// Context Engine —— AILEEN 的统一上下文层
//
// 这是**唯一**被允许拼 prompt 的地方。Chat / Agent / Memory / Knowledge /
// 未来的 MCP、Browser、Vision、Minecraft 都必须走这里，而不是各自往 system 里塞东西。
//
// 为什么必须统一（这是这个模块存在的全部理由）：
//   · 各自拼 → 人格会被挤掉（曾经真的发生过：Agent 带着自己那份「你是编程助手」）；
//   · 各自拼 → Memory / Knowledge 无限注入，没人管总量；
//   · 各自拼 → Tool Result 无限增长，直到请求被 provider 拒掉；
//   · 各自拼 → 出问题时没人说得出「这次回答为什么是这样」。
//
// 对外只暴露 `buildContext()` 一个入口：给候选内容与元数据，拿回可直接发请求的
// messages + 一份「每一段花了多少 token、来自哪里、被裁了什么」的报告。
//
// 依赖方向（刻意单向）：
//   Chat / Agent / Memory / Knowledge  ──提供候选──▶  Context Engine  ──▶  Model Provider
//   Context Engine **不认识**它们的具体实现，只认「一段文本 + 元数据 + 预算」。
// ============================================================
import { LAYER, LAYER_ORDER, DEFAULT_BUDGET, PROTECTED_LAYERS, resolveBudget, estimateTokens } from './types.js';
import { trimAll, scoreItem, trimMessages } from './budget.js';
import { buildContextBundle, assembleMessages, renderLayerSection } from './assembler.js';
import { buildSystemPrompt } from '../lib/characters.js';
import { buildAgentSystemPrompt } from '../agent/planner.js';

export { LAYER, DEFAULT_BUDGET, PROTECTED_LAYERS, estimateTokens, resolveBudget, scoreItem, trimMessages };

/**
 * 人格必须原样出现在 system 的第一段。
 *
 * 这是把「不许丢人格」从口头约定变成**可断言的代码**：
 * 拼完自己先验一遍，不合规就抛错中止，而不是把一个没有人格的请求发出去。
 */
export function assertPersonaFirst(persona, messages) {
  const p = String(persona || '');
  if (!p.trim()) throw new Error('Context Engine：角色人格为空，拒绝组装上下文');
  const first = (messages || []).find((m) => m && m.role === 'system');
  if (!first) throw new Error('Context Engine：组装结果里没有 system 消息');
  if (String(first.content || '').indexOf(p) !== 0) {
    throw new Error('Context Engine：角色人格不在 system 的第一段 —— 会让人格被替换，已中止');
  }
  return true;
}

/**
 * 建立 Context Engine。
 *
 * @param {object} deps
 *   memory     可选：{ search(query, opts) => Promise<Array<{text, relevance, importance, ...}>> }
 *   knowledge  可选：{ search(query, opts) => Promise<Array<{text, source, ...}>> }
 *   都是「提供候选」的角色，Context Engine 不关心它们内部怎么实现。
 */
export function createContextEngine(deps = {}) {
  const memory = deps.memory || null;
  const knowledge = deps.knowledge || null;
  const history = [];

  /**
   * 组装一次请求上下文。
   *
   * @param {object} input
   *   card         角色卡（人格来源；必填）
   *   query        本轮用户输入（用于检索 memory / knowledge）
   *   messages     对话历史（会被 recent 层预算裁剪）
   *   agent        { enabled, tools, workspace, task, toolResults } —— 走 Agent 时给
   *   memoryOpts   { k, budgetTokens, types } 传给 memory.search
   *   knowledgeOpts{ k, budgetTokens, filters } 传给 knowledge.search
   *   budget       覆盖默认预算
   *   sessionId    仅用于报告
   * @returns {Promise<object>} { messages, segments, totalTokens, warnings, persona }
   */
  async function buildContext(input = {}) {
    const card = input.card;
    if (!card) throw new Error('Context Engine：缺少角色卡（人格的唯一来源）');

    const budget = resolveBudget(input.budget);
    const agentCfg = input.agent && input.agent.enabled ? input.agent : null;

    // ---- 1) 人格 + 能力说明（第 0 段）----
    const persona = buildSystemPrompt(card);
    let baseSystem = persona;
    const extras = [];
    // 风格指令（表演档位/回复节奏那套）接在人格之后，仍然是 system 的第 0 段内容
    if (input.systemExtra) extras.push(String(input.systemExtra).trim());
    if (agentCfg) {
      // 能力说明接在人格**之后**，绝不替换它
      const brief = buildAgentSystemPrompt({
        task: agentCfg.task,
        workspace: agentCfg.workspace,
        tools: agentCfg.tools,
      });
      extras.push(brief);
    }
    if (extras.filter(Boolean).length) {
      baseSystem = [persona].concat(extras.filter(Boolean)).join('\n\n---\n\n');
    }

    // ---- 2) 收候选内容 ----
    const layers = {};
    layers[LAYER.CHARACTER] = [{ text: persona }];

    // 对话历史
    const historyMsgs = Array.isArray(input.messages) ? input.messages
      : (Array.isArray(deps.getMessages) ? deps.getMessages() : []);
    // 调用方往往已经把摘要拼进 messages 了（历史就是这么做的），
    // 而摘要现在由引擎统一负责 —— 所以先剥掉那条，避免出现两次。
    layers[LAYER.RECENT] = historyMsgs.filter((m) => !(m && m.role === 'system' && String(m.content || '').indexOf('以下是更早对话的摘要') === 0));

    // 长期记忆：问一次，拿候选（失败不能把整轮拖死）
    const memoryResults = [];
    if (memory && typeof memory.search === 'function' && input.query) {
      try {
        const found = await memory.search(input.query, Object.assign({ k: 6 }, input.memoryOpts));
        for (const r of found || []) {
          memoryResults.push({
            text: typeof r === 'string' ? r : (r.text || r.content || ''),
            relevance: r.relevance ?? r.score,
            importance: r.importance,
            confidence: r.confidence,
            recency: r.recency,
            priority: r.priority,
            id: r.id,
            type: r.type,
          });
        }
      } catch (err) {
        // 记忆检索失败不该让对话发不出去
        memoryResults.push({ text: '', _error: String((err && err.message) || err) });
      }
    }
    layers[LAYER.MEMORY] = memoryResults;

    // 知识库：同上
    const knowledgeResults = [];
    if (knowledge && typeof knowledge.search === 'function' && input.query) {
      try {
        const found = await knowledge.search(input.query, Object.assign({ k: 5 }, input.knowledgeOpts));
        for (const r of found || []) {
          knowledgeResults.push({
            text: typeof r === 'string' ? r : (r.text || r.content || ''),
            relevance: r.relevance ?? r.score,
            priority: r.priority,
            source: r.source,
            document_id: r.document_id,
            chunk_id: r.chunk_id,
          });
        }
      } catch (err) {
        knowledgeResults.push({ text: '', _error: String((err && err.message) || err) });
      }
    }
    layers[LAYER.KNOWLEDGE] = knowledgeResults;

    // Agent 状态 + 工具结果
    if (agentCfg) {
      const stateLines = [];
      if (agentCfg.task) stateLines.push('- 本轮任务：' + String(agentCfg.task));
      if (agentCfg.workspace) stateLines.push('- 工作区：' + String(agentCfg.workspace));
      if (agentCfg.status) stateLines.push('- 当前状态：' + String(agentCfg.status));
      if (agentCfg.rounds) stateLines.push('- 已进行轮数：' + agentCfg.rounds);
      layers[LAYER.AGENT_STATE] = stateLines.length ? [{ text: stateLines.join('\n') }] : [];
      layers[LAYER.TOOL_RESULTS] = Array.isArray(agentCfg.toolResults) ? agentCfg.toolResults : [];
    } else {
      layers[LAYER.AGENT_STATE] = [];
      layers[LAYER.TOOL_RESULTS] = [];
    }
    layers[LAYER.SYSTEM] = [];

    // ---- 3) 裁到预算内 ----
    const trimmed = trimAll(layers, budget, { protectedLayers: PROTECTED_LAYERS });
    trimmed.budget = budget;

    // ---- 4) 拼装 + 记录每一段 ----
    const bundle = buildContextBundle(trimmed, {
      baseSystem,
      sources: { character: 'character-card', memory: 'memory-engine', knowledge: 'knowledge-engine' },
    });

    // ---- 4.5) 更早对话的摘要：作为**独立的一条 system 消息**插在人格之后 ----
    // 为什么不并进第 0 段：摘要是「发生过什么」，人格是「我是谁」。
    // 混在一起的话，将来单独更新摘要（以及做摘要缓存）就没法做了。
    const summaryText = String(input.summary || '').trim();
    let messages = bundle.messages;
    if (summaryText) {
      const idx = messages.findIndex((m) => m && m.role === 'system');
      const summaryMsg = { role: 'system', content: '以下是更早对话的摘要：\n' + summaryText };
      messages = messages.slice(0, idx + 1).concat([summaryMsg], messages.slice(idx + 1));
      bundle.segments.push({
        layer: 'summary', source: 'chat-history', where: 'system[1]',
        priority: 'medium', tokenCost: estimateTokens(summaryMsg.content), items: 1, dropped: 0, protected: false,
      });
    }
    bundle.messages = messages;
    bundle.totalTokens = bundle.segments.reduce((n, s) => n + s.tokenCost, 0);

    // ---- 5) 硬门禁：人格必须在第一段 ----
    assertPersonaFirst(persona, bundle.messages);

    const result = Object.assign({}, bundle, {
      persona,
      sessionId: input.sessionId || null,
      layerOrder: LAYER_ORDER.slice(),
      // 记忆/知识检索出错时把原因带出来（界面可以提示「记忆检索失败」）
      retrievalErrors: []
        .concat(memoryResults.filter((r) => r._error).map((r) => ({ layer: LAYER.MEMORY, message: r._error })))
        .concat(knowledgeResults.filter((r) => r._error).map((r) => ({ layer: LAYER.KNOWLEDGE, message: r._error }))),
    });
    history.push({ at: Date.now(), totalTokens: result.totalTokens, segments: result.segments.length });
    if (history.length > 50) history.shift();
    return result;
  }

  return {
    buildContext,
    /** 最近几次组装的摘要（排查「上下文怎么突然变大了」用） */
    recentUsage: () => history.slice(),
    /** 当前预算 */
    budget: () => resolveBudget(deps.budgetOverride),
  };
}

export { buildContextBundle, assembleMessages, renderLayerSection };
