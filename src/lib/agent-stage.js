// ============================================================
// Agent 状态 → Live2D 表现（**反向订阅**）
//
// Agent Runtime 只 emit 状态事件，它不知道 Live2D 存在（有单测守着这条边界）。
// 订阅放在这边：由界面决定「用哪个动作 / 表情」表现 thinking / working / error。
//
// 这里刻意做成「取不到模型也不报错」：没装模型、模型没有对应动作、
// 舞台被关掉 —— 都不该影响 Agent 干活。
// ============================================================
import { AGENT_EVENT, AGENT_STATUS } from '../agent/events.js';
import { getLive2dModel, talkMotionName, idleMotionName } from './stage.js';

/** 状态 → 想用的动作组关键词（按优先级） */
const MOTION_HINTS = {
  [AGENT_STATUS.THINKING]: [/think|idle|tap/i],
  [AGENT_STATUS.USING_TOOL]: [/tap|flick|wave/i],
  [AGENT_STATUS.WORKING]: [/tap|flick/i],
  [AGENT_STATUS.WAITING_APPROVAL]: [/wave|greet|tap/i],
  [AGENT_STATUS.SUCCESS]: [/wave|greet|happy/i],
  [AGENT_STATUS.ERROR]: [/shake|sad|flick/i],
};

/** 状态 → 想用的表情名关键词 */
const EXPR_HINTS = {
  [AGENT_STATUS.THINKING]: [/think|serious|normal/i],
  [AGENT_STATUS.USING_TOOL]: [/focus|serious|normal/i],
  [AGENT_STATUS.WORKING]: [/focus|serious|normal/i],
  [AGENT_STATUS.WAITING_APPROVAL]: [/question|surprise|normal/i],
  [AGENT_STATUS.SUCCESS]: [/happy|smile|normal/i],
  [AGENT_STATUS.ERROR]: [/sad|angry|serious/i],
};

function pickByName(names, hints) {
  if (!Array.isArray(names) || !names.length) return null;
  for (const re of hints || []) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
}

function motionGroups() {
  const model = getLive2dModel();
  if (!model) return [];
  try {
    return Object.keys(model.internalModel.motionManager.motionGroups || {});
  } catch {
    return [];
  }
}

function expressionNames() {
  const model = getLive2dModel();
  if (!model) return [];
  try {
    const defs = model.internalModel.settings.definitions || {};
    return Object.keys(defs.expressions || {});
  } catch {
    return [];
  }
}

/** 把一次 Agent 状态落到 Live2D 上（取不到模型就安静跳过） */
export function applyAgentStatus(status) {
  const model = getLive2dModel();
  if (!model) return;
  const groups = motionGroups();
  const exprs = expressionNames();
  try {
    if (status === AGENT_STATUS.IDLE) {
      const idle = idleMotionName();
      if (idle) model.motion(idle);
      return;
    }
    const motion = pickByName(groups, MOTION_HINTS[status]) || talkMotionName();
    if (motion) model.motion(motion);
    const expr = pickByName(exprs, EXPR_HINTS[status]);
    if (expr) model.expression(expr);
  } catch (err) {
    // 模型缺动作/表情是常态（不同模型差别很大），不该因此打断别的功能
    console.warn('[agent] Live2D 表现失败：', err && err.message);
  }
}

/**
 * 订阅一个 Agent 事件总线。
 * 返回取消订阅函数 —— 由调用方在合适的时候解绑（面板重开时不会越订越多）。
 */
export function subscribeAgentStatus(bus) {
  if (!bus || typeof bus.on !== 'function') return () => {};
  return bus.on(AGENT_EVENT.STATUS, (payload) => {
    if (payload && payload.status) applyAgentStatus(payload.status);
  });
}
