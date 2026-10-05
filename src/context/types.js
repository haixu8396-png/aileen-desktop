// ============================================================
// Context Engine · 层定义与 token 估算
//
// 为什么要把它单独抽出来：Chat / Agent / Memory / Knowledge / 未来的 MCP、Vision、
// Browser **各自拼 prompt** 是这个项目最大的架构债 ——
// 谁都想往 system 里塞东西，最后人格被挤掉、Memory 无限注入、Tool Result 无限增长。
//
// 这一层的职责是：**成为唯一的上下文入口**。别的模块只负责「提供候选内容 + 元数据」，
// 由这里决定「放什么、放多少、什么顺序、被裁掉了什么」。
//
// 层次顺序是固定的（人格必须在最前，这是硬约束）：
//   system → character → persona → recent → memory → knowledge → agentState → toolResults
// ============================================================

/** 层的标识。顺序即优先级上下文里的**呈现顺序**（不是裁剪顺序）。 */
export const LAYER = {
  SYSTEM: 'system',
  CHARACTER: 'character',
  PERSONA: 'persona',
  RECENT: 'recent',
  MEMORY: 'memory',
  KNOWLEDGE: 'knowledge',
  AGENT_STATE: 'agent_state',
  TOOL_RESULTS: 'tool_results',
};

/** 呈现顺序：人格在最前，工具结果在最后（它是「事实」，不是「身份」） */
export const LAYER_ORDER = [
  LAYER.SYSTEM,
  LAYER.CHARACTER,
  LAYER.PERSONA,
  LAYER.RECENT,
  LAYER.MEMORY,
  LAYER.KNOWLEDGE,
  LAYER.AGENT_STATE,
  LAYER.TOOL_RESULTS,
];

/**
 * 默认 token 预算（用户给的示例值）。
 * 全部可配置 —— 不同模型窗口差很多，硬编码就是等着出事。
 */
export const DEFAULT_BUDGET = {
  total: 16000,
  [LAYER.SYSTEM]: 1500,
  [LAYER.CHARACTER]: 1000,
  [LAYER.PERSONA]: 800,
  [LAYER.RECENT]: 4000,
  [LAYER.MEMORY]: 1500,
  [LAYER.KNOWLEDGE]: 2000,
  [LAYER.AGENT_STATE]: 600,
  [LAYER.TOOL_RESULTS]: 3000,
};

/**
 * 每层的「不可裁」标记。
 * system / character / persona 是**身份**，任何情况下都不许被裁掉或截断 ——
 * 一旦被裁，模型就不再是那个角色了（这正是要防的事）。
 */
export const PROTECTED_LAYERS = [LAYER.SYSTEM, LAYER.CHARACTER, LAYER.PERSONA];

/**
 * token 估算：保守取「字符数 / 2」。
 *
 * 依据：中文大约 1 字 1 token，英文大约 4 字符 1 token，
 * 取 2 是两者的折中且偏保守（宁可高估、不要低估导致真实请求超窗口）。
 * 想更准就换 tokenizer，但那是额外依赖，与「零新依赖」冲突 —— 这里如实说明是估算。
 */
export function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  return Math.ceil(s.length / 2);
}

/** 一段内容的 token 花费（含标题/分隔符的开销，避免低估） */
export function costOf(text) {
  return estimateTokens(text);
}

/** 合并用户的预算覆盖（浅合并 + 只认已知层 + 数值收敛） */
export function resolveBudget(override) {
  const out = Object.assign({}, DEFAULT_BUDGET);
  const o = override && typeof override === 'object' ? override : {};
  for (const key of Object.keys(DEFAULT_BUDGET)) {
    const v = Number(o[key]);
    if (Number.isFinite(v) && v >= 0) out[key] = Math.round(v);
  }
  return out;
}

/** 某一层这次实际能用的上限（层预算 与 全局剩余 取小） */
export function layerCap(layer, budget, used) {
  const own = Number(budget[layer]);
  const remain = Math.max(0, Number(budget.total) - used);
  if (!Number.isFinite(own)) return remain;
  return Math.min(own, remain);
}
