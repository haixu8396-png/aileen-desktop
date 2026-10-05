// ============================================================
// AgentRun 数据模型 + 状态机
//
// 两条硬规矩：
//   1) 状态迁移走**显式白名单**，不在表里的迁移一律抛错
//      （paused → completed 必须被拒 —— 没跑完的活不能算完成）
//   2) 终态不可逆：completed / failed / cancelled 出去就出不去
// ============================================================
import { RUN_STATUS, isTerminal } from './events.js';

export const RUN_FIELDS = [
  'run_id', 'status', 'task', 'workspace', 'messages', 'tool_calls',
  'approvals', 'artifacts', 'answer', 'error', 'rounds',
  'created_at', 'updated_at',
];

/** 合法迁移表：from -> 允许去的状态 */
export const TRANSITIONS = {
  [RUN_STATUS.QUEUED]: [RUN_STATUS.RUNNING, RUN_STATUS.CANCELLED],
  [RUN_STATUS.RUNNING]: [
    RUN_STATUS.WAITING_APPROVAL,
    RUN_STATUS.PAUSED,
    RUN_STATUS.COMPLETED,
    RUN_STATUS.FAILED,
    RUN_STATUS.CANCELLED,
  ],
  [RUN_STATUS.WAITING_APPROVAL]: [
    RUN_STATUS.RUNNING,
    RUN_STATUS.PAUSED,
    RUN_STATUS.CANCELLED,
    RUN_STATUS.FAILED,
  ],
  [RUN_STATUS.PAUSED]: [
    RUN_STATUS.RUNNING,
    RUN_STATUS.CANCELLED,
    RUN_STATUS.FAILED,
  ],
  // 终态：无处可去
  [RUN_STATUS.COMPLETED]: [],
  [RUN_STATUS.FAILED]: [],
  [RUN_STATUS.CANCELLED]: [],
};

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

let seq = 0;

/** 轮数上限：没给或者给了脏值就用 20；给了有效值就收敛到 1~50 */
export function clampRounds(value) {
  if (value === undefined || value === null || value === '') return 20;
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(50, Math.round(n)));
}

function newRunId() {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return 'run-' + Date.now().toString(36) + '-' + seq.toString(36) + '-' + rand;
}

/**
 * 建立一次 Agent Run。
 * @param {object} opts { task, workspace, maxRounds, now }
 */
export function createRun(opts = {}) {
  const task = String(opts.task == null ? '' : opts.task).trim();
  if (!task) throw new Error('Agent Run 缺少 task');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  return {
    run_id: opts.runId || newRunId(),
    status: RUN_STATUS.QUEUED,
    task,
    workspace: String(opts.workspace || ''),
    messages: [],
    tool_calls: [],
    approvals: [],
    artifacts: [],
    answer: '',
    error: null,
    rounds: 0,
    maxRounds: clampRounds(opts.maxRounds),
    created_at: now,
    updated_at: now,
  };
}

/**
 * 状态迁移。非法迁移抛错 —— 这是刻意让调用方早发现，
 * 而不是悄悄把 run 置成完成。
 */
export function transition(run, to, now = Date.now()) {
  if (!run || typeof run !== 'object') throw new Error('transition 需要 run 对象');
  const from = run.status;
  if (from === to) return run;
  if (!canTransition(from, to)) {
    throw new Error('非法的状态迁移：' + from + ' → ' + to);
  }
  run.status = to;
  run.updated_at = now;
  return run;
}

export function isPaused(run) {
  return !!run && run.status === RUN_STATUS.PAUSED;
}

export function isFinished(run) {
  return !!run && isTerminal(run.status);
}

/** 记录一次工具调用（成功与否都记，「为什么失败」是排查的依据） */
export function recordToolCall(run, entry) {
  const rec = {
    name: String((entry && entry.name) || ''),
    callId: String((entry && entry.callId) || ''),
    args: (entry && entry.args) || {},
    ok: !!(entry && entry.ok),
    riskLevel: (entry && entry.riskLevel) || 'LOW',
    durationMs: Number((entry && entry.durationMs) || 0),
    summary: String((entry && entry.summary) || '').slice(0, 2000),
    error: entry && entry.error ? String(entry.error).slice(0, 2000) : '',
    at: Number.isFinite(entry && entry.at) ? entry.at : Date.now(),
  };
  run.tool_calls.push(rec);
  run.updated_at = rec.at;
  return rec;
}

/** 记录一次审批（谁点的、批没批） */
export function recordApproval(run, entry) {
  const rec = {
    id: String((entry && entry.id) || ''),
    name: String((entry && entry.name) || ''),
    riskLevel: (entry && entry.riskLevel) || 'LOW',
    approved: !!(entry && entry.approved),
    remember: !!(entry && entry.remember),
    reason: entry && entry.reason ? String(entry.reason).slice(0, 500) : '',
    at: Number.isFinite(entry && entry.at) ? entry.at : Date.now(),
  };
  run.approvals.push(rec);
  run.updated_at = rec.at;
  return rec;
}

export function addArtifact(run, artifact) {
  const rec = {
    name: String((artifact && artifact.name) || ''),
    kind: String((artifact && artifact.kind) || 'file'),
    path: String((artifact && artifact.path) || ''),
    summary: String((artifact && artifact.summary) || '').slice(0, 1000),
    at: Date.now(),
  };
  run.artifacts.push(rec);
  return rec;
}

/** 给 UI 的快照：不返回活对象，避免界面直接改内部状态 */
export function snapshot(run) {
  if (!run) return null;
  return {
    run_id: run.run_id,
    status: run.status,
    task: run.task,
    workspace: run.workspace,
    messageCount: run.messages.length,
    toolCalls: run.tool_calls.length,
    approvals: run.approvals.length,
    artifacts: run.artifacts.length,
    rounds: run.rounds,
    maxRounds: run.maxRounds,
    answer: run.answer,
    error: run.error,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}
