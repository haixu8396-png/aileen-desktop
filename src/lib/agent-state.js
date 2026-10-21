// ============================================================
// Agent 的**界面状态**（唯一来源）
//
// 为什么单独一层：
//   · 以前「抽屉」自己画日志、Dashboard 自己也画一份、任务页再去读抽屉的 DOM，
//     三处各存一份状态，谁先更新谁赢 —— 界面上的表现就是「有的地方变了、有的没变」。
//   · 现在只留这一份纯数据：事件进来先写这里，任何一块界面（对话里的活动卡、
//     任务页、输入区的 Agent 面板）都从它订阅。
//
// 这里是**纯状态**：不碰 DOM、不读设置、不认识 Electron。
// 所以它能被单测直接跑（tests/unit/agent-state.test.mjs）。
// ============================================================

/** 对话里的活动卡最多保留多少步（够看清在干什么，又不会把聊天撑爆） */
export const MAX_STEPS = 40;
/** 「最近的决定」保留几条 */
export const MAX_RECENT = 6;

function blank() {
  return {
    /** 有 run 在跑 */
    running: false,
    /** 运行态（AGENT_STATUS 的原始值） */
    status: 'idle',
    /** 任务目标（用户那句话 / 角色卡里那条任务） */
    task: '',
    round: 0,
    roundBudget: 0,
    segments: 1,
    /** [{ kind, text, ok, at }] —— kind: info|step|tool|ok|err|warn|answer */
    steps: [],
    /** 等确认的调用（单条或批量）：{ id, name, riskLevel, preview, irreversible, batch, items } */
    approval: null,
    /** 最近的决定：[{ name, riskLevel, approved, remember, at }] */
    recent: [],
    /** 有可续跑的检查点 */
    checkpoint: false,
    /** 这一轮结束了（用于把活动卡收成摘要） */
    finished: false,
    /** 出错信息（结束时有） */
    error: '',
  };
}

let state = blank();
const listeners = new Set();

/** 当前状态的**副本**：调用方拿到的永远是自己的数据，不会共享引用 */
export function agentUiState() {
  return {
    running: state.running,
    status: state.status,
    task: state.task,
    round: state.round,
    roundBudget: state.roundBudget,
    segments: state.segments,
    steps: state.steps.map((s) => Object.assign({}, s)),
    approval: state.approval ? Object.assign({}, state.approval) : null,
    recent: state.recent.map((r) => Object.assign({}, r)),
    checkpoint: state.checkpoint,
    finished: state.finished,
    error: state.error,
  };
}

/** 订阅：回调收到状态副本。返回取消订阅函数（别忘记调，否则会越订越多） */
export function subscribeAgentUi(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit() {
  const snapshot = agentUiState();
  for (const fn of listeners) {
    try { fn(snapshot); } catch (err) { /* 一个订阅者坏了不该影响其它人 */ }
  }
}

/** 合并若干字段并通知订阅者 */
export function patchAgentUi(patch) {
  if (!patch || typeof patch !== 'object') return agentUiState();
  state = Object.assign({}, state, patch);
  emit();
  return agentUiState();
}

/** 复位成「没在跑」的干净状态（新任务 / 应用刚起来） */
export function resetAgentUi() {
  state = blank();
  emit();
  return agentUiState();
}

/** 追加一步（超出上限丢最早的） */
export function addAgentStep(step) {
  const entry = {
    kind: String((step && step.kind) || 'info'),
    text: String((step && step.text) || ''),
    ok: step && step.ok === true ? true : (step && step.ok === false ? false : null),
    at: Date.now(),
  };
  if (!entry.text) return agentUiState();
  const steps = state.steps.concat([entry]);
  state = Object.assign({}, state, {
    steps: steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps,
  });
  emit();
  return agentUiState();
}

/** 记一条「最近的决定」（批准 / 拒绝都会进列表，用户能回看） */
export function noteAgentDecision(decision) {
  const d = decision || {};
  const entry = {
    name: String(d.name || ''),
    riskLevel: String(d.riskLevel || 'HIGH').toUpperCase(),
    approved: !!d.approved,
    remember: !!d.remember,
    at: Date.now(),
  };
  state = Object.assign({}, state, {
    recent: [entry].concat(state.recent).slice(0, MAX_RECENT),
  });
  emit();
  return agentUiState();
}

/** 设置 / 清空待确认的调用 */
export function setAgentApproval(req) {
  state = Object.assign({}, state, {
    approval: req ? Object.assign({}, req) : null,
  });
  emit();
  return agentUiState();
}

/** 本轮结束：把状态落成「已完成/失败/取消」，活动卡据此收成摘要 */
export function finishAgentUi({ status = 'completed', error = '', checkpoint = false } = {}) {
  state = Object.assign({}, state, {
    running: false,
    finished: true,
    status: String(status || 'completed'),
    error: String(error || ''),
    approval: null,
    checkpoint: !!checkpoint,
  });
  emit();
  return agentUiState();
}
