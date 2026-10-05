// ============================================================
// Agent 事件契约 + 极简事件总线
//
// 这一层只定义「谁能说什么」，不认识 Live2D、不认识 DOM、不认识 UI。
// Live2D 的状态表现是**反向订阅**的：由 src/lib/stage.js 那边订阅这里的
// AGENT_EVENT，翻译成动作/表情。Agent Runtime 永远不知道 Live2D 存在。
// ============================================================

/** AgentRun 的生命周期状态 */
export const RUN_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const TERMINAL_STATUS = [RUN_STATUS.COMPLETED, RUN_STATUS.FAILED, RUN_STATUS.CANCELLED];

export function isTerminal(status) {
  return TERMINAL_STATUS.includes(status);
}

/**
 * 给外界的「角色状态」—— 这是给 Dashboard / Live2D 看的粗粒度状态。
 * 与 RUN_STATUS 不是一回事：run 的 7 个状态是执行状态机，
 * 这里的状态集更大（多了 planning / paused），是**表现层**要的信号。
 */
export const AGENT_STATUS = {
  IDLE: 'idle',
  THINKING: 'thinking',
  PLANNING: 'planning',
  USING_TOOL: 'using_tool',
  WORKING: 'working',
  WAITING_APPROVAL: 'waiting_approval',
  PAUSED: 'paused',
  SUCCESS: 'success',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

/** 事件名 */
export const AGENT_EVENT = {
  RUN_CREATED: 'run_created',
  RUN_UPDATED: 'run_updated',
  STATUS: 'status',            // { status: AGENT_STATUS.* }
  STEP: 'step',                // { step, phase: 'llm' | 'tool' | 'final' }
  TEXT: 'text',                // { text } 模型正文增量
  REASONING: 'reasoning',      // { text } 推理模型思考增量
  TOOL_CALL: 'tool_call',      // { name, args, callId }
  TOOL_RESULT: 'tool_result',  // { name, callId, ok, summary, durationMs }
  APPROVAL_REQUEST: 'approval_request', // { id, name, riskLevel, args, preview }
  APPROVAL_DECIDED: 'approval_decided', // { id, approved, remember }
  NOTICE: 'notice',            // { level, code, message } 提示/错误（非致命）
  FINISHED: 'finished',        // { status, answer, error }
};

/**
 * 极简事件总线：on 返回取消订阅函数。
 * emit 里任何一个订阅者抛错都不能影响其它订阅者和主循环 ——
 * 状态事件是「通知」，不是「命令」。
 */
export function createEventBus() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => {
        const set = listeners.get(type);
        if (set) set.delete(fn);
      };
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set || set.size === 0) return;
      for (const fn of Array.from(set)) {
        try {
          fn(payload);
        } catch (err) {
          // 订阅者自己的错不该让 Agent 停摆
          console.warn('[agent] 事件订阅者抛错：', type, err && err.message);
        }
      }
    },
    listenerCount(type) {
      const set = listeners.get(type);
      return set ? set.size : 0;
    },
    clear() {
      listeners.clear();
    },
  };
}
