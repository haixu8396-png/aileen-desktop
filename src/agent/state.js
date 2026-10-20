// ============================================================
// AgentRun 数据模型 + 状态机
//
// 两条硬规矩：
//   1) 状态迁移走**显式白名单**，不在表里的迁移一律抛错
//      （paused → completed 必须被拒 —— 没跑完的活不能算完成）
//   2) 终态不可逆：completed / failed / cancelled 出去就出不去
// ============================================================
import { RUN_STATUS, isTerminal } from './events.js';
import { normalizeAuthorization } from './authorization.js';

export const RUN_FIELDS = [
  'run_id', 'status', 'task', 'workspace', 'messages', 'tool_calls',
  'approvals', 'artifacts', 'answer', 'error', 'rounds',
  'created_at', 'updated_at',
  // 0.8：任务预算 / 检查点 / 授权
  'maxRounds', 'roundBudget', 'segments', 'checkpoint', 'authorization',
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

/** 单次「段」的轮数上限：没给或者给了脏值就用 20；给了有效值就收敛到 1~50 */
export function clampRounds(value) {
  if (value === undefined || value === null || value === '') return 20;
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(50, Math.round(n)));
}

/**
 * 任务总轮数预算（与「单次段」区分）。
 *
 * 以前只有一个 maxRounds=20 的硬上限：到 20 轮就写一句「先停在这里」并结束，
 * 长任务因此经常半途而废。现在 maxRounds 只表示「一次连续跑多少轮」，
 * 真正的上限是这个任务预算：段到顶但预算还在，就接着跑，进度不丢。
 * 默认 3 倍段长（20 → 60），允许 1~200，避免变相无限循环。
 */
export function clampRoundBudget(value, maxRounds) {
  const segs = Number(maxRounds) > 0 ? Number(maxRounds) : 20;
  if (value === undefined || value === null || value === '') return Math.min(200, segs * 3);
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.min(200, segs * 3);
  return Math.max(1, Math.min(200, Math.round(n)));
}

function newRunId() {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return 'run-' + Date.now().toString(36) + '-' + seq.toString(36) + '-' + rand;
}

/** 硬上限：即便用户一路点「继续」，总轮数也不会超过这个数（防无限循环） */
export const HARD_ROUND_CAP = 400;

/** 一次「继续」追加的轮数：默认再给一个任务预算的量 */
export function clampExtendRounds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.max(1, Math.min(HARD_ROUND_CAP, Math.round(n)));
}

/**
 * 建立一次 Agent Run。
 * @param {object} opts { task, workspace, maxRounds, roundBudget, authorization, now }
 */
export function createRun(opts = {}) {
  const task = String(opts.task == null ? '' : opts.task).trim();
  if (!task) throw new Error('Agent Run 缺少 task');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxRounds = clampRounds(opts.maxRounds);
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
    maxRounds,
    roundBudget: clampRoundBudget(opts.roundBudget, maxRounds),
    /** 已经跑了几「段」（每续跑一次 +1）—— 预算用尽但任务没完时靠它判断能不能再续 */
    segments: 1,
    /** 授权（模式 / 范围 / 有效期）；由设置注入，可在运行中撤销 */
    authorization: normalizeAuthorization(opts.authorization, { now }),
    /** 检查点：任务目标、已完成步骤、错误、下一步 —— 断点续跑全靠它 */
    checkpoint: createCheckpoint(opts.task, { now }),
    created_at: now,
    updated_at: now,
  };
}

/**
 * 检查点。**只存「够用来接着干」的东西**：
 *   · goal      任务目标（原话）
 *   · steps     已完成的关键步骤（工具 + 结果摘要）
 *   · completed 已完成调用的指纹（同一次操作不重复执行）
 *   · errors    失败与恢复记录
 *   · next      下一步计划（模型上一轮自己说的话，收尾时留作提示）
 *   · roundsSpent / segments  已经花掉的预算
 */
export function createCheckpoint(goal, { now = Date.now() } = {}) {
  return {
    goal: String(goal || ''),
    steps: [],
    completed: [],
    errors: [],
    next: '',
    roundsSpent: 0,
    segments: 1,
    updatedAt: now,
  };
}

const MAX_CHECKPOINT_STEPS = 200;

/** 记一步（成功或失败都记 —— 「做过什么」是续跑的依据） */
export function recordCheckpointStep(run, entry = {}) {
  if (!run) return null;
  if (!run.checkpoint) run.checkpoint = createCheckpoint(run.task);
  const cp = run.checkpoint;
  const step = {
    n: cp.steps.length + 1,
    round: Number(entry.round) || run.rounds,
    tool: String(entry.tool || ''),
    ok: entry.ok !== false,
    riskLevel: entry.riskLevel || 'LOW',
    summary: String(entry.summary || '').slice(0, 500),
    error: entry.error ? String(entry.error).slice(0, 500) : '',
    retries: Number(entry.retries) || 0,
    verified: entry.verified === true,
    fingerprint: String(entry.fingerprint || ''),
    at: Number.isFinite(entry.at) ? entry.at : Date.now(),
  };
  cp.steps.push(step);
  if (cp.steps.length > MAX_CHECKPOINT_STEPS) cp.steps.splice(0, cp.steps.length - MAX_CHECKPOINT_STEPS);
  if (!step.ok) {
    cp.errors.push({ at: step.at, tool: step.tool, message: step.error || step.summary });
    if (cp.errors.length > 50) cp.errors.shift();
  }
  if (step.fingerprint && step.ok) cp.completed.push(step.fingerprint);
  if (cp.completed.length > 300) cp.completed.splice(0, cp.completed.length - 300);
  cp.roundsSpent = run.rounds;
  cp.segments = run.segments;
  cp.updatedAt = step.at;
  return step;
}

/** 这一步以前是否已经成功做过（断点续跑时用来跳过已完成操作） */
export function hasCompletedCall(run, fingerprint) {
  const cp = run && run.checkpoint;
  if (!cp || !Array.isArray(cp.completed) || !fingerprint) return false;
  return cp.completed.includes(String(fingerprint));
}

/** 记下「下一步打算做什么」：续跑时作为提示，不当作命令 */
export function noteCheckpointNext(run, text) {
  if (!run) return null;
  if (!run.checkpoint) run.checkpoint = createCheckpoint(run.task);
  run.checkpoint.next = String(text || '').slice(0, 800);
  run.checkpoint.updatedAt = Date.now();
  return run.checkpoint.next;
}

/**
 * 给续跑用的进度摘要（中文，供模型读取；不是人格提示词的一部分）。
 * 只描述事实：做了什么、哪一步失败、原本打算做什么。
 */
export function checkpointBrief(run) {
  const cp = run && run.checkpoint;
  if (!cp) return '';
  const lines = [];
  lines.push('任务目标：' + (cp.goal || run.task));
  const done = cp.steps.filter((s) => s.ok);
  if (done.length) {
    lines.push('已完成的关键步骤（不要重复执行这些）：');
    for (const s of done.slice(-12)) lines.push('- ' + s.tool + '：' + s.summary);
  }
  const failed = cp.errors.slice(-5);
  if (failed.length) {
    lines.push('失败过的步骤（换一种做法，不要原样重试）：');
    for (const e of failed) lines.push('- ' + e.tool + '：' + e.message);
  }
  if (cp.next) lines.push('上一轮你打算做的下一步：' + cp.next);
  lines.push('已经用了 ' + (cp.roundsSpent || 0) + ' 轮；从这里接着做，不要从头再来。');
  return lines.join('\n');
}

/** 追加任务预算（用户点「继续」时用）。到硬上限就不再给。 */
export function extendRoundBudget(run, extra) {
  if (!run) return 0;
  const add = clampExtendRounds(extra);
  const cap = Math.min(HARD_ROUND_CAP, run.roundBudget + add);
  const gained = Math.max(0, cap - run.roundBudget);
  run.roundBudget = cap;
  run.segments = (run.segments || 1) + 1;
  if (run.checkpoint) run.checkpoint.segments = run.segments;
  run.updated_at = Date.now();
  return gained;
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
  const cp = run.checkpoint;
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
    roundBudget: run.roundBudget,
    segments: run.segments,
    answer: run.answer,
    error: run.error,
    created_at: run.created_at,
    updated_at: run.updated_at,
    // 检查点只给摘要，界面不需要 200 条步骤
    checkpoint: cp ? {
      goal: cp.goal,
      stepCount: cp.steps.length,
      completedCount: cp.completed.length,
      errorCount: cp.errors.length,
      next: cp.next,
      roundsSpent: cp.roundsSpent,
      segments: cp.segments,
    } : null,
  };
}
