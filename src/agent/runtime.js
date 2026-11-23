// ============================================================
// Agent Runtime：主循环
//
//   User Task → LLM → Tool Call → Permission → Executor
//             → Tool Result → LLM → … → Final Answer
//
// 设计上的几条线：
//
// 1) **单 Agent**。没有子 agent。同一轮的多个工具调用默认顺序执行
//    （顺序执行才能保证审批不打架，也让「改了 A 再读 A」这种依赖成立）；
//    只有「只读 + 已确定放行」的连续调用才受控并行（上限 3，结果顺序不变）。
//
// 2) **runtime 不认识 Live2D / DOM / Electron**。它只 emit 事件；
//    谁来订阅是别人的事。所以这一层能在 vitest 里注入假的 llm 和假桥接跑通。
//
// 3) **pause/cancel 是真暂停真取消**：pause 在每轮开始和每次工具调用前检查；
//    cancel 走 AbortController 并让 executor 杀掉所有在跑的子进程。
//
// 4) **预算与进度分离**（0.8）：maxRounds 只是「一段跑多少轮」，真正封顶的是
//    roundBudget（任务预算）。预算用尽**既不是失败也不是完成**：写检查点、进
//    paused、由用户点「继续」追加预算再接着跑 —— 进度不丢，也不会无限循环
//    （续跑有硬上限 HARD_ROUND_CAP）。
//
// 5) **授权有范围、有期限、可撤销**（0.8）：风险等级不会被降低，授权只决定
//    「要不要打断用户」。不可逆操作（删除/push/装包/shell）、高危命令、敏感目标、
//    越界调用**永远单独确认**，与是否开启信任模式无关。
// ============================================================
import { createEventBus, AGENT_EVENT, AGENT_STATUS, RUN_STATUS } from './events.js';
import {
  createRun, transition, recordToolCall, recordApproval, addArtifact, isFinished,
  recordCheckpointStep, hasCompletedCall, noteCheckpointNext, checkpointBrief, extendRoundBudget,
} from './state.js';
import { toolsToProviderSpecs, parseToolCalls, normalizeToolCall, assistantMessage, toolResultMessage, unknownToolMessage, shouldFinish, buildAgentSystemPrompt } from './planner.js';
import { riskForTool, describeApproval, normalizePermissionConfig, RISK } from './permission.js';
import {
  decideAuthorized, fingerprintCall, shouldRetryAfterFailure, isReadOnlyTool,
  isTrustActive, AUTH_MODE, AUTH_SCOPE, normalizeAuthorization,
} from './authorization.js';
import { createExecutor, resolveInsideWorkspace } from './executor.js';
import fsPaths from '../../shared/fs-paths.cjs';
import { buildRequestMessages, clipToolResult, workspaceDigest, estimateTokens } from './context.js';
import { buildAgentRequest } from './context-engine.js';
import { validateArgs, attachExecutors } from './tool-registry.js';

/** 只读并行上限：再多既没意义，也容易把主进程的 IPC 挤住 */
const MAX_PARALLEL_READS = 3;
const RETRY_BACKOFF_MS = 120;

/**
 * 0.7.12：执行流程的看门狗（默认值；调用方可逐个覆盖）
 *
 * 这几个超时是**分开的**，不能混成一个：
 *   · llmTimeoutMs      单次模型请求最长等多久（等不到就判这次请求失败，走错误恢复）
 *   · approvalTimeoutMs 等用户批准最长等多久（等不到按「拒绝这一次」处理，绝不无限挂住）
 *   · toolTimeoutMs     单个工具最长跑多久（超时取消并作为失败结果回给模型）
 *   · stallMs           多久没有任何进展事件就判「疑似停滞」→ 存检查点并暂停
 *   · repeatLimit       同一工具 + 同一参数 + 同一结果重复多少次算空转
 */
const WATCHDOG_DEFAULTS = {
  llmTimeoutMs: 240000,
  approvalTimeoutMs: 300000,
  toolTimeoutMs: 180000,
  stallMs: 90000,
  repeatLimit: 3,
  autoExtendBudget: false,
  hardRoundCap: 200,
};

/**
 * 给 Promise 套一层超时：到点返回 { __timeout:true }，由调用方决定怎么处理。
 * 注意它 resolve 而不是 reject —— 调用方需要区分「超时」和「出错」。
 */
function raceTimeout(promise, ms, label) {
  const limit = Number(ms);
  if (!Number.isFinite(limit) || limit <= 0) {
    return Promise.resolve(promise).then((value) => ({ value }), (error) => ({ error }));
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timeout: true, label });
    }, limit);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ value });
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error });
    });
  });
}

/** 稳定哈希（用于「同一调用 + 同一结果」的重复检测） */
function hashText(text) {
  const s = String(text == null ? '' : text);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * 建一个「等待被唤醒」的闸门。
 * pause() 之后条件为 false，await gate() 会挂住；resume() 放行。
 */
function createGate() {
  let open = true;
  let waiters = [];
  return {
    isOpen: () => open,
    close() { open = false; },
    open() {
      open = true;
      const list = waiters;
      waiters = [];
      for (const resolve of list) resolve();
    },
    wait() {
      if (open) return Promise.resolve();
      return new Promise((resolve) => { waiters.push(resolve); });
    },
  };
}

function cloneJSON(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

/** 把一个 run 的进度整理成检查点（给持久化 / 界面用） */
function checkpointPayload(run, reason) {
  return {
    reason: String(reason || ''),
    run_id: run.run_id,
    task: run.task,
    workspace: run.workspace,
    status: run.status,
    rounds: run.rounds,
    roundBudget: run.roundBudget,
    segments: run.segments,
    checkpoint: run.checkpoint ? cloneJSON(run.checkpoint) : null,
  };
}

/**
 * 跑一次 Agent Run。
 *
 * @param {object} deps
 *   task          用户任务
 *   taskMessage   可选：真正发给模型的那条 user 消息（会带上工具上下文）
 *   systemPrompt  **可选但强烈建议传**：由调用方（context-engine）拼好的
 *                 系统提示词 —— 角色人格在前、能力说明在后。
 *   workspace     绑定的工作区绝对路径
 *   llm           async ({ messages, tools, signal, onDelta, onReasoning }) => { text, toolCalls }
 *   tools         [{ name, description, inputSchema, riskLevel, execute }]
 *   executor      可选：已有 executor（不传则用 bridge 建一个）
 *   bridge        可选：宿主能力，用来建 executor
 *   isSensitive   可选：敏感路径判定
 *   bus           可选：外部事件总线（默认自建）
 *   requestApproval  async ({ id, name, riskLevel, args, preview }) => { approved, remember }
 *                    —— 批量审批时收到的是 { id, batch: true, items: [...] }
 *   authorization 授权配置 { mode, scope, maxRisk, tools, workspace, expiresAt }
 *   permissionConfig  风险设置（requireMedium）
 *   maxRounds     单段轮数上限（默认 20）
 *   roundBudget   任务总轮数预算（默认 3×maxRounds）
 *   maxRetries    只读工具失败后的自动重试次数（0~3，默认 1）
 *   parallelReadOnly  只读工具是否受控并行（默认 true）
 *   signal        外部取消信号
 *   budgetTokens  上下文预算
 *   checkpoint    可选：从检查点续跑（会给模型一段进度摘要）
 *   now           注入时间（测试用）
 *
 * @returns {{ api: object, done: Promise<object> }}
 */
export function runAgent(deps = {}) {
  const bus = deps.bus || createEventBus();
  const emit = (type, payload) => bus.emit(type, payload);
  const clock = (typeof deps.now === 'function') ? deps.now : () => Date.now();

  const run = createRun({
    task: deps.task,
    workspace: deps.workspace,
    maxRounds: deps.maxRounds,
    roundBudget: deps.roundBudget,
    authorization: deps.authorization,
    now: Number.isFinite(deps.now) ? deps.now : Date.now(),
  });

  const registry = deps.registry || null;
  const tools = (deps.tools || (registry ? registry.list() : [])).slice();
  const permissionConfig = normalizePermissionConfig(deps.permissionConfig);
  const gates = createGate();
  const grants = new Set();
  const outside = deps.signal || null;
  const abortCtrl = new AbortController();
  const maxRounds = run.maxRounds;
  const budgetTokens = Number(deps.budgetTokens) || 60000;
  const maxRetries = Math.max(0, Math.min(3, Number.isFinite(deps.maxRetries) ? deps.maxRetries : 1));
  const parallelReadOnly = deps.parallelReadOnly !== false;

  // 看门狗参数：调用方可以逐个覆盖（chat.js 从设置里传），默认值是保守的
  const wd = {};
  for (const key of Object.keys(WATCHDOG_DEFAULTS)) {
    wd[key] = deps[key] === undefined ? WATCHDOG_DEFAULTS[key] : deps[key];
  }

  /**
   * 进展心跳：任何「有意义的进展」都刷新它（一轮开始、工具调用、工具结果、文本增量）。
   * 停滞判定只看它 —— 没有进展 ≠ 正在思考，等太久就要停下来告诉用户。
   */
  const progress = {
    lastAt: clock(),
    lastStage: 'start',
    rounds: 0,
    toolCalls: 0,
    // 「同一工具 + 同一参数 + 同一结果」的重复计数：一次正常的重复是需求，连续多次就是空转
    repeatKey: '',
    repeatCount: 0,
  };
  const touch = (stage) => {
    progress.lastAt = clock();
    if (stage) progress.lastStage = stage;
  };

  /** 运行中可变的授权（撤销/收紧立刻生效，不必重启任务） */
  let authCurrent = run.authorization;

  /**
   * 现在是否已经获得「外部文件访问」授权（运行期判断：撤销 / 过期立刻生效）。
   * 完整权限，或「信任 + 允许高风险」。手动模式下批准的那一次调用走 approvedExternal。
   */
  const externalAllowedNow = () => {
    const a = authCurrent || {};
    if (a.fullAccess === true) return true;
    if (a.mode !== AUTH_MODE.TRUST) return false;
    if (!a.allowHighRisk) return false;
    return isTrustActive(a, clock());
  };

  const executor = deps.executor || createExecutor({
    workspace: run.workspace,
    home: deps.home || '',
    bridge: deps.bridge || {},
    isSensitive: deps.isSensitive,
    allowExternal: externalAllowedNow,
    fullAccess: authCurrent && authCurrent.fullAccess === true,
  });

  let cancelled = false;
  let paused = false;
  /**
   * 从**上一个**检查点继承来的「已完成操作」指纹。
   *
   * 只跳过这些 —— 本次运行里同一个调用出现两次是正常需求（改完再读一遍），
   * 绝不能因为「刚才调过一次」就把它吞掉。跳过一次后从集合里删掉，
   * 免得模型靠重复同一个调用来空转。
   */
  const inheritedCompleted = new Set();
  /** 审批等待者：id → resolve。UI 内联卡片和主进程 dialog 两条路都回填到这里 */
  const pendingResolvers = new Map();

  const onOutsideAbort = () => { cancelled = true; gates.open(); abortCtrl.abort(); };
  if (outside) {
    if (outside.aborted) onOutsideAbort();
    else outside.addEventListener('abort', onOutsideAbort, { once: true });
  }

  const api = {
    run,
    bus,
    /** 宿主能力（测试用来验证工具名与 executor 方法一一对应） */
    executor,
    pause() {
      if (isFinished(run) || paused) return false;
      paused = true;
      gates.close();
      run.pauseReason = 'user';
      touch('paused');
      transition(run, RUN_STATUS.PAUSED);
      emit(AGENT_EVENT.RUN_UPDATED, run);
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.PAUSED, reason: 'user' });
      return true;
    },
    resume() {
      if (isFinished(run) || !paused) return false;
      paused = false;
      run.pauseReason = null;
      // 恢复时重置心跳与重复计数：否则刚恢复就立刻被判「停滞」
      touch('resumed');
      progress.repeatKey = '';
      progress.repeatCount = 0;
      gates.open();
      transition(run, RUN_STATUS.RUNNING);
      emit(AGENT_EVENT.RUN_UPDATED, run);
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.WORKING });
      return true;
    },
    /**
     * 预算用尽后**不是**在同一个 run 里硬续（那会把对话一直挂住、用户没法再说话）。
     * 正确做法是：run 带着检查点结束 → 编排层（chat/面板）用这个检查点
     * 重新 startRun 一次，于是「继续」= 断点续跑，界面也能正常解锁。
     * 这里只保留一个查询，方便编排层拿进度。
     */
    get budget() {
      return {
        rounds: run.rounds,
        roundBudget: run.roundBudget,
        segments: run.segments,
        exhausted: run.status === RUN_STATUS.PAUSED && run.pauseReason === 'budget',
        canContinue: run.status === RUN_STATUS.PAUSED && run.pauseReason === 'budget',
      };
    },
    cancel() {
      if (isFinished(run)) return false;
      cancelled = true;
      gates.open();
      const killed = executor && typeof executor.cancelAll === 'function' ? executor.cancelAll() : 0;
      abortCtrl.abort();
      emit(AGENT_EVENT.NOTICE, { level: 'warn', code: 'CANCELLED', message: '已取消', killedProcesses: killed });
      return true;
    },
    /** 运行中改授权（界面撤销「完全信任」走这条） */
    setAuthorization(next) {
      authCurrent = normalizeAuthorization(next, { now: clock() });
      run.authorization = authCurrent;
      const summary = {
        mode: authCurrent.mode,
        scope: authCurrent.scope,
        active: authCurrent.mode === AUTH_MODE.TRUST && isTrustActive(authCurrent, clock()),
        revoked: !!authCurrent.revokedAt,
        expiresAt: authCurrent.expiresAt,
      };
      emit(AGENT_EVENT.AUTH_UPDATED, summary);
      emit(AGENT_EVENT.NOTICE, {
        level: 'info', code: 'AUTH_UPDATED', message: '授权模式已更新', authorization: summary,
      });
      return summary;
    },
    get authorization() {
      return authCurrent;
    },
    /** 给界面/持久化用：当前进度快照（含检查点） */
    checkpoint(reason) {
      return checkpointPayload(run, reason || 'manual');
    },
    /**
     * 审批结果由外部（UI / dialog）回填。
     *   单条：resolveApproval(id, true, remember)
     *   批量：resolveApproval(batchId, { decisions: { [itemId]: true|false }, remember })
     *   整批：resolveApproval(batchId, true|false)
     */
    resolveApproval(id, approved, remember = false) {
      if (!pendingResolvers.has(id)) return false;
      const resolve = pendingResolvers.get(id);
      pendingResolvers.delete(id);
      if (approved && typeof approved === 'object') {
        const decisions = (approved.decisions && typeof approved.decisions === 'object') ? approved.decisions : {};
        resolve({ approved: true, decisions, remember: !!approved.remember });
        return true;
      }
      resolve({ approved: !!approved, decisions: {}, remember: !!remember });
      return true;
    },
    get status() {
      return run.status;
    },
  };

  /** 单条审批：发事件 → 等回填（requestApproval 与 resolveApproval 两条路都认） */
  async function askApproval({ name, riskLevel, args, callId, reason, irreversible, fingerprint, external = false }) {
    const id = 'ap-' + Math.random().toString(36).slice(2, 10);
    let preview = describeApproval({ name }, args);
    if (external) preview = '【工作区外】' + preview;
    const item = {
      id, name, riskLevel, args, preview, callId: callId || '',
      external: !!external,
      reason: String(reason || ''),
      irreversible: !!irreversible,
      fingerprint: fingerprint || fingerprintCall(name, args, riskLevel),
    };
    emit(AGENT_EVENT.APPROVAL_REQUEST, Object.assign({ batch: false }, item));
    transition(run, RUN_STATUS.WAITING_APPROVAL);
    emit(AGENT_EVENT.RUN_UPDATED, run);
    emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.WAITING_APPROVAL });

    /**
     * 关键：审批等待**必须有上限**。
     *
     * 这就是「执行到某一步就没动静了」最常见的一种：卡片没被挂出来（活动卡按需挂载 +
     * 用户切了页面）、或者回填路径断了 —— 于是 pendingResolvers 里那个 Promise 永远不 resolve，
     * 整个 run 停在 waiting_approval，前端继续显示「运行中」。
     *
     * 到点按「拒绝这一次」处理：把结果作为正常的工具失败回给模型，让它可以换做法，
     * 而不是把任务永久挂死；同时发一条能看懂的 NOTICE。
     */
    let answer;
    const waitApproval = async (waitPromise) => {
      const r = await raceTimeout(waitPromise, wd.approvalTimeoutMs, 'approval');
      if (r.timeout) {
        pendingResolvers.delete(id);
        emit(AGENT_EVENT.NOTICE, {
          level: 'warn',
          code: 'APPROVAL_TIMEOUT',
          message: '等待用户批准超时（' + Math.round(wd.approvalTimeoutMs / 1000) + ' 秒），这一次按「拒绝」处理',
          name,
          timeoutMs: wd.approvalTimeoutMs,
        });
        return { approved: false, remember: false, timedOut: true };
      }
      if (r.error) throw r.error;
      return r.value;
    };

    if (typeof deps.requestApproval === 'function') {
      const promise = Promise.resolve(deps.requestApproval(item));
      const wrapped = promise.then((r) => ((r && typeof r === 'object')
        ? { approved: !!r.approved, remember: !!r.remember }
        : { approved: !!r, remember: false }));
      const manual = new Promise((resolve) => { pendingResolvers.set(id, resolve); });
      answer = await waitApproval(Promise.race([wrapped, manual]));
      pendingResolvers.delete(id);
    } else {
      answer = await waitApproval(new Promise((resolve) => { pendingResolvers.set(id, resolve); }));
    }

    recordApproval(run, { id, name, riskLevel, approved: answer.approved, remember: answer.remember, reason });
    emit(AGENT_EVENT.APPROVAL_DECIDED, { id, approved: answer.approved, remember: answer.remember, batch: false, timedOut: !!answer.timedOut });
    // 审批结束只允许「回到运行中」—— 如果这期间用户点了暂停，就保持暂停，
    // 不能把状态改回 running（否则前端显示在跑、实际卡在闸门上）。
    if (run.status === RUN_STATUS.WAITING_APPROVAL && !paused) {
      transition(run, RUN_STATUS.RUNNING);
      emit(AGENT_EVENT.RUN_UPDATED, run);
    }
    touch('approval-done');
    if (answer.remember && answer.approved && riskLevel === RISK.MEDIUM) grants.add('medium');
    return answer;
  }

  /**
   * 批量审批：一次事件带一个列表，用户一次看完整批。
   * 批准**只对这批操作生效**（每一项都带指纹）；参数/路径/风险变了就是新调用，
   * 会重新问 —— 不存在「批一次就永久放权」。
   */
  async function askApprovalBatch(pending) {
    const id = 'apb-' + Math.random().toString(36).slice(2, 10);
    const items = pending.map((p) => ({
      id: p.approvalId,
      callId: p.call.id || '',
      name: p.call.name,
      args: p.args,
      riskLevel: p.riskLevel,
      preview: (p.external ? '【工作区外】' : '') + describeApproval({ name: p.call.name }, p.args),
      external: !!p.external,
      reason: p.verdict ? p.verdict.reason : '',
      irreversible: !!p.irreversible,
      outOfScope: !!p.outOfScope,
      fingerprint: p.fingerprint,
    }));
    const order = ['LOW', 'MEDIUM', 'HIGH'];
    emit(AGENT_EVENT.APPROVAL_REQUEST, {
      id,
      batch: true,
      count: items.length,
      items,
      highestRisk: items.reduce((acc, it) => (order.indexOf(it.riskLevel) > order.indexOf(acc) ? it.riskLevel : acc), 'LOW'),
      hasIrreversible: items.some((it) => it.irreversible),
    });
    transition(run, RUN_STATUS.WAITING_APPROVAL);
    emit(AGENT_EVENT.RUN_UPDATED, run);
    emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.WAITING_APPROVAL });

    let answer;
    const waitBatch = async (waitPromise) => {
      const r = await raceTimeout(waitPromise, wd.approvalTimeoutMs, 'approval-batch');
      if (r.timeout) {
        pendingResolvers.delete(id);
        emit(AGENT_EVENT.NOTICE, {
          level: 'warn',
          code: 'APPROVAL_TIMEOUT',
          message: '等待用户批准超时（' + Math.round(wd.approvalTimeoutMs / 1000) + ' 秒），这一批按「全部拒绝」处理',
          timeoutMs: wd.approvalTimeoutMs,
          batch: true,
        });
        return { approved: false, decisions: {}, remember: false, timedOut: true };
      }
      if (r.error) throw r.error;
      return r.value;
    };
    if (typeof deps.requestApproval === 'function') {
      const promise = Promise.resolve(deps.requestApproval({ id, batch: true, items }));
      const wrapped = promise.then((r) => ((r && typeof r === 'object')
        ? {
          approved: !!r.approved,
          decisions: (r.decisions && typeof r.decisions === 'object') ? r.decisions : {},
          remember: !!r.remember,
        }
        : { approved: !!r, decisions: {}, remember: false }));
      const manual = new Promise((resolve) => { pendingResolvers.set(id, resolve); });
      answer = await waitBatch(Promise.race([wrapped, manual]));
      pendingResolvers.delete(id);
    } else {
      answer = await waitBatch(new Promise((resolve) => { pendingResolvers.set(id, resolve); }));
    }

    const decisions = {};
    for (const item of items) {
      const decided = Object.prototype.hasOwnProperty.call(answer.decisions || {}, item.id)
        ? answer.decisions[item.id]
        : answer.approved;
      decisions[item.id] = !!decided;
      recordApproval(run, {
        id: item.id,
        name: item.name,
        riskLevel: item.riskLevel,
        approved: decisions[item.id],
        remember: answer.remember,
        reason: 'batch:' + String(item.reason || ''),
      });
    }
    emit(AGENT_EVENT.APPROVAL_DECIDED, { id, batch: true, approved: answer.approved, decisions, remember: answer.remember, timedOut: !!answer.timedOut });
    if (run.status === RUN_STATUS.WAITING_APPROVAL && !paused) {
      transition(run, RUN_STATUS.RUNNING);
      emit(AGENT_EVENT.RUN_UPDATED, run);
    }
    touch('approval-batch-done');
    if (answer.remember) grants.add('medium');
    return { decisions };
  }

  /**
   * 事后校验：只做便宜且可靠的那一种 —— 写完之后把文件读回来看开头对不对。
   * 校验不通过**不判失败**（任务不该因为一次读回失败就整体失败），
   * 而是在工具结果里加一句提示，让模型自己决定要不要重写。
   *
   * 0.7.9 起扩到电脑控制：「发送点击 ≠ 任务完成」，动作之后读一次前台窗口，
   * 和目标不一致就明确写进工具结果（模型会看到，从而重新观察/换做法）。
   */
  const COMPUTER_TOOLS = new Set([
    'window_focus', 'window_control', 'open_application', 'ui_action',
    'mouse_click', 'mouse_move', 'mouse_scroll', 'mouse_drag',
    'keyboard_type', 'keyboard_press', 'app_close',
  ]);

  async function verifyStep(name, args) {
    if (name !== 'write_file' && name !== 'apply_patch') {
      if (!COMPUTER_TOOLS.has(name)) return { ok: true, note: '' };
      if (typeof executor.observe !== 'function') return { ok: true, note: '' };
      let obs = null;
      try { obs = await executor.observe(); } catch { obs = null; }
      const active = obs && obs.active ? obs.active : null;
      if (!active || !active.title) return { ok: true, note: '' };
      const seen = String(active.title);
      const want = String((args && (args.title || args.target)) || '').trim();
      const state = '【动作后状态】前台窗口：' + seen + (active.process ? '（' + active.process + '）' : '');
      if (want && seen.toLowerCase().indexOf(want.toLowerCase()) < 0) {
        return { ok: false, note: state + '；和预期目标「' + want + '」不一致，请重新观察再决定下一步' };
      }
      return { ok: true, note: state };
    }
    if (typeof executor.readFile !== 'function') return { ok: true, note: '' };
    try {
      const want = String((name === 'write_file' ? args.content : args.new) == null ? '' : (name === 'write_file' ? args.content : args.new));
      if (!want.trim()) return { ok: true, note: '' };
      const shown = await executor.readFile({ path: String(args.path || ''), limit: 20 });
      const text = String(shown || '');
      // readFile 返回带行号的内容，取预期内容的第一行非空行做包含检查
      const firstLine = want.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= 4);
      if (!firstLine) return { ok: true, note: '' };
      if (!text.includes(firstLine)) {
        return { ok: false, note: '写入后读回的文件里找不到刚写入的内容（可能没真正落盘）' };
      }
      return { ok: true, note: '' };
    } catch {
      return { ok: true, note: '' };
    }
  }

  /**
   * 执行单个工具调用：只负责「跑 + 重试 + 记录 + 校验」，权限决策在外面做完。
   */
  async function callTool(call, prep) {
    const { args, riskLevel, fingerprint } = prep;
    const tool = registry ? registry.get(call.name) : tools.find((x) => x.name === call.name);
    // 兼容：老的「using_tool」仍然发一份（既有消费者/测试依赖），
    // 新的「executing/observing/verifying/recovering」用于更细的前端阶段显示。
    emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.USING_TOOL, tool: call.name });
    emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.EXECUTING, tool: call.name });
    emit(AGENT_EVENT.TOOL_CALL, { name: call.name, args, callId: call.id, riskLevel, reason: prep.verdict ? prep.verdict.reason : '' });
    touch('tool:' + call.name);

    const exec = (typeof executor[call.name] === 'function')
      ? executor[call.name].bind(executor)
      : ((tool && typeof tool.execute === 'function') ? tool.execute : null);
    if (!exec) {
      const msg = '工具 ' + call.name + ' 还没有实现';
      recordToolCall(run, { name: call.name, callId: call.id, args, ok: false, riskLevel, error: msg, summary: msg });
      recordCheckpointStep(run, { tool: call.name, ok: false, riskLevel, error: msg, fingerprint });
      emit(AGENT_EVENT.TOOL_RESULT, { name: call.name, callId: call.id, ok: false, summary: msg });
      return { ok: false, content: msg };
    }

    const started = clock();
    let attempts = 0;
    for (;;) {
      try {
        // 工具超时：到点按失败处理（结果回给模型），而不是让 run 卡在一个不返回的 Promise 上
        const raced = await raceTimeout(
          (async () => exec(Object.assign({}, args, {
            signal: abortCtrl.signal,
            workspace: run.workspace,
            approvedExternal: !!(prep.external && prep.approved),
          })))(),
          wd.toolTimeoutMs,
          'tool:' + call.name,
        );
        if (raced.timeout) {
          const err = new Error('工具执行超时（' + Math.round(wd.toolTimeoutMs / 1000) + ' 秒）：' + call.name);
          err.code = 'TOOL_TIMEOUT';
          if (executor && typeof executor.cancelAll === 'function') {
            try { executor.cancelAll(); } catch { /* 取消失败也继续 */ }
          }
          throw err;
        }
        if (raced.error) throw raced.error;
        const raw = raced.value;
        const content = clipToolResult(typeof raw === 'string' ? raw : JSON.stringify(raw));
        const durationMs = clock() - started;
        emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.OBSERVING, tool: call.name });
        emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.VERIFYING, tool: call.name });
        const verified = await verifyStep(call.name, args);
        recordToolCall(run, { name: call.name, callId: call.id, args, ok: true, riskLevel, durationMs, summary: content.slice(0, 500) });
        recordCheckpointStep(run, {
          tool: call.name, ok: true, riskLevel, summary: content.slice(0, 300),
          fingerprint, retries: attempts, verified: verified.ok, at: clock(),
        });
        if (call.name === 'write_file' || call.name === 'apply_patch') {
          addArtifact(run, { name: call.name, kind: 'file', path: String(args.path || ''), summary: content.slice(0, 200) });
        }
        emit(AGENT_EVENT.TOOL_RESULT, {
          name: call.name, callId: call.id, ok: true, summary: content.slice(0, 300), durationMs, retries: attempts,
        });
        if (!verified.ok) {
          emit(AGENT_EVENT.NOTICE, {
            level: 'warn', code: 'STEP_UNVERIFIED', message: '步骤结果未能确认：' + verified.note, tool: call.name,
          });
        }
        // 重复调用检测：同一工具 + 同一参数 + 同一结果，连续出现就是空转
        const repeatKey = fingerprint + '|' + hashText(content);
        if (repeatKey === progress.repeatKey) progress.repeatCount += 1;
        else { progress.repeatKey = repeatKey; progress.repeatCount = 1; }
        let suffix = verified.ok ? '' : '\n（注意：' + verified.note + '）';
        if (progress.repeatCount >= wd.repeatLimit) {
          emit(AGENT_EVENT.NOTICE, {
            level: 'warn',
            code: 'REPEAT_DETECTED',
            message: '同一个调用已经重复 ' + progress.repeatCount + ' 次且结果相同（' + call.name + '），请换一种做法',
            tool: call.name,
            count: progress.repeatCount,
          });
          suffix += '\n（提醒：你刚才用完全相同的参数调用 ' + call.name + ' 已经 ' + progress.repeatCount
            + ' 次，结果也完全相同。不要再重复同样的调用，换参数或换工具，或者直接说明做不到。）';
        }
        touch('result:' + call.name);
        return { ok: true, content: content + suffix };
      } catch (err) {
        const message = String((err && err.message) || err);
        if (shouldRetryAfterFailure({ tool: call.name, attempt: attempts, maxRetries, riskLevel })) {
          attempts += 1;
          emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.RECOVERING, tool: call.name, retry: attempts, error: message });
          emit(AGENT_EVENT.TOOL_RETRY, { name: call.name, callId: call.id, attempt: attempts, error: message });
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempts));
          continue;
        }
        const durationMs = clock() - started;
        recordToolCall(run, { name: call.name, callId: call.id, args, ok: false, riskLevel, durationMs, error: message, summary: message });
        recordCheckpointStep(run, { tool: call.name, ok: false, riskLevel, error: message, fingerprint, retries: attempts, at: clock() });
        emit(AGENT_EVENT.TOOL_RESULT, {
          name: call.name, callId: call.id, ok: false, summary: message, durationMs, retries: attempts,
        });
        return { ok: false, content: '执行失败：' + message };
      }
    }
  }

  /** 执行计划：连续的「只读 + 已放行」成一组并行，其余单个顺序 */
  function buildExecutionPlan(prepared, results) {
    const plan = [];
    let group = [];
    const flush = () => {
      if (group.length) {
        plan.push({ parallel: group.length > 1, items: group });
        group = [];
      }
    };
    prepared.forEach((p, idx) => {
      if (results[idx]) return; // 参数错误 / 跳过 / 被拒绝：已经有结果了
      const canParallel = parallelReadOnly
        && isReadOnlyTool(p.call.name)
        && p.verdict && p.verdict.decision === 'allow';
      if (!canParallel) {
        flush();
        plan.push({ parallel: false, items: [{ p, idx }] });
        return;
      }
      group.push({ p, idx });
      if (group.length >= MAX_PARALLEL_READS) flush();
    });
    flush();
    return plan;
  }

  // ---- 主循环 ----
  emit(AGENT_EVENT.RUN_CREATED, run);
  transition(run, RUN_STATUS.RUNNING);
  emit(AGENT_EVENT.RUN_UPDATED, run);
  // 先 planning（看工具、定步骤）再 thinking（真正开始说话）
  emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.PLANNING });

  const systemPrompt = typeof deps.systemPrompt === 'string' && deps.systemPrompt.trim()
    ? deps.systemPrompt
    // 兜底：调用方没给人格时，至少给一份能力说明（单测/无角色场景走这条）。
    // 正常路径（Chat 触发）永远由 context-engine 注入「角色人格 + 能力说明」。
    : buildAgentSystemPrompt({ task: run.task, workspace: run.workspace, tools });
  run.messages.push({ role: 'user', content: deps.taskMessage || run.task });

  // 从检查点续跑：把进度摘要作为一条**普通 user 消息**塞在任务后面。
  // 它只说「做到哪了」，不碰 system —— 人格永远是 system 的第一段。
  if (deps.checkpoint && deps.checkpoint.checkpoint) {
    run.checkpoint = Object.assign(run.checkpoint || {}, deps.checkpoint.checkpoint);
    run.checkpoint.goal = run.checkpoint.goal || run.task;
    for (const fp of (run.checkpoint.completed || [])) inheritedCompleted.add(String(fp));
    const brief = checkpointBrief(run);
    if (brief) {
      run.messages.push({ role: 'user', content: '【接着上次的进度继续，不要从头重做】\n' + brief });
      emit(AGENT_EVENT.NOTICE, { level: 'info', code: 'RESUMED_FROM_CHECKPOINT', message: '已从检查点继续' });
    }
  }

  // ---- 停滞看门狗 ----
  // 只在「应该动」的状态下检查：running / waiting_approval / planning。
  // 到点没有进展就存检查点 + 暂停（pauseReason='stalled'），前端能明确显示「停住了」，
  // 而不是一个永远在转的圈。
  const watchdog = setInterval(() => {
    if (cancelled || paused || isFinished(run)) return;
    if (run.status === RUN_STATUS.PAUSED) return;
    const silent = clock() - progress.lastAt;
    if (silent < Number(wd.stallMs)) return;
    paused = true;
    gates.close();
    run.pauseReason = 'stalled';
    if (!isFinished(run)) transition(run, RUN_STATUS.PAUSED);
    emit(AGENT_EVENT.NOTICE, {
      level: 'warn',
      code: 'STALL_SUSPECTED',
      message: '执行已停滞 ' + Math.round(silent / 1000) + ' 秒（最后阶段：' + progress.lastStage + '），已保存进度并暂停',
      silentMs: silent,
      stage: progress.lastStage,
      rounds: run.rounds,
    });
    emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.PAUSED, reason: 'stalled' });
    emit(AGENT_EVENT.RUN_UPDATED, run);
    emit(AGENT_EVENT.CHECKPOINT, checkpointPayload(run, 'stalled'));
  }, Math.max(250, Math.min(30000, Number(wd.stallMs) / 3)));

  const done = (async () => {
  try {
    // 用 run.roundBudget（而不是常量）：用户点「继续」时它会被追加
    let round = run.rounds || 0;
    while (round < run.roundBudget) {
      if (cancelled) break;
      await gates.wait();
      if (cancelled) break;

      round += 1;
      run.rounds = round;
      emit(AGENT_EVENT.STEP, { step: round, phase: 'llm' });
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.THINKING });
      touch('llm:' + round);

      // 请求结构（顺序不能换）：
      //   [system 人格+能力] → [进入 Agent 前的对话历史] → [本轮对话]
      // 人格只在开头出现一次；工具结果以 tool 消息形式跟在后面，
      // **没有写 system 的通路** —— 所以它不可能覆盖角色提示词。
      let messages;
      if (typeof deps.buildRequest === 'function') {
        messages = deps.buildRequest({ systemPrompt, history: deps.history, messages: run.messages, round });
      } else {
        const head = buildAgentRequest({ systemPrompt, history: deps.history });
        messages = buildRequestMessages({
          systemPrompt: head[0] ? head[0].content : systemPrompt,
          history: head.slice(1),
          messages: run.messages,
          budgetTokens,
        });
      }

      let result;
      try {
        const raced = await raceTimeout(
          (async () => deps.llm({
            messages,
            tools: toolsToProviderSpecs(tools),
            signal: abortCtrl.signal,
            onDelta: (text) => { touch('delta'); emit(AGENT_EVENT.TEXT, { text }); },
            onReasoning: (text) => { touch('reasoning'); emit(AGENT_EVENT.REASONING, { text }); },
          }))(),
          wd.llmTimeoutMs,
          'llm:' + round,
        );
        if (raced.timeout) {
          emit(AGENT_EVENT.NOTICE, {
            level: 'warn',
            code: 'LLM_TIMEOUT',
            message: '模型请求超过 ' + Math.round(wd.llmTimeoutMs / 1000) + ' 秒没有返回，已中止这一轮',
            round,
          });
          throw Object.assign(new Error('模型请求超时（' + Math.round(wd.llmTimeoutMs / 1000) + ' 秒）'), { code: 'LLM_TIMEOUT' });
        }
        if (raced.error) throw raced.error;
        result = raced.value;
        touch('llm-done:' + round);
      } catch (err) {
        if (cancelled || (err && (err.code === 'ABORTED' || err.name === 'AbortError'))) break;
        throw err;
      }

      const text = String((result && result.text) || '');
      const rawCalls = (result && result.toolCalls) || [];
      const { calls, unknown } = registry
        ? parseToolCalls({ tool_calls: rawCalls }, registry)
        : { calls: (rawCalls || []).map((c) => normalizeToolCall(c)).filter(Boolean), unknown: [] };

      run.messages.push(assistantMessage(text, rawCalls.map((c) => normalizeToolCall(c)).filter(Boolean)));

      if (!calls.length && !unknown.length) {
        run.answer = text;
        noteCheckpointNext(run, '');
        break;
      }

      // 模型编出来的工具名也要回执，否则它会一直重试
      for (const u of unknown) {
        const content = unknownToolMessage(u.name, registry);
        run.messages.push(toolResultMessage(u.id, content));
        recordToolCall(run, { name: u.name, callId: u.id, args: u.args, ok: false, riskLevel: RISK.HIGH, error: '未知工具', summary: content });
        recordCheckpointStep(run, { tool: u.name, ok: false, riskLevel: RISK.HIGH, error: '未知工具', summary: content });
      }

      // ---- ① 决策：参数校验 → 续跑去重 → 授权 ----
      const prepared = [];
      for (const call of calls) {
        const tool = registry ? registry.get(call.name) : tools.find((x) => x.name === call.name);
        // 工具表里的风险只管「工作区内」；碰到工作区外的普通路径是**另一次授权**（HIGH）。
        // 这样「读自己工作区」不打扰，「读桌面」才会问。
        const externalHits = fsPaths.externalTargets(call.args || {}, {
          workspace: run.workspace, home: deps.home || '',
        }).filter((x) => x.scope === 'external');
        const externalUsed = externalHits.length > 0;
        const riskLevel = externalUsed ? RISK.HIGH : riskForTool(tool || { name: call.name });
        const argsCheck = validateArgs(tool || { inputSchema: { type: 'object', properties: {} } }, call.args);
        if (!argsCheck.ok) {
          prepared.push({ call, bad: true, reason: argsCheck.errors.join('；'), riskLevel });
          continue;
        }
        const args = argsCheck.value;
        const fingerprint = fingerprintCall(call.name, args, riskLevel);
        if (inheritedCompleted.has(fingerprint)) {
          // 上一次的进度里已经成功做过这一步：跳过，并且只跳这一次
          inheritedCompleted.delete(fingerprint);
          prepared.push({ call, skip: true, args, riskLevel, fingerprint });
          continue;
        }
        const verdict = decideAuthorized({
          riskLevel, tool: call.name, args, workspace: run.workspace,
          auth: authCurrent, config: permissionConfig, grants, now: clock(),
        });
        prepared.push({
          call, args, riskLevel, fingerprint, verdict, external: externalUsed,
          needAsk: verdict.decision === 'ask',
          outOfScope: !!verdict.outOfScope,
          irreversible: !!verdict.irreversible,
        });
      }

      // ---- ② 审批：批量模式一次问完；逐项模式一个个问 ----
      const pending = prepared.filter((p) => p.needAsk);
      pending.forEach((p, i) => { p.approvalId = 'ai-' + i; });
      if (pending.length) {
        if (authCurrent.mode === AUTH_MODE.BATCH && pending.length > 1) {
          const decided = await askApprovalBatch(pending);
          for (const p of pending) p.approved = !!decided.decisions[p.approvalId];
        } else {
          for (const p of pending) {
            // eslint-disable-next-line no-await-in-loop
            const answer = await askApproval({
              name: p.call.name, riskLevel: p.riskLevel, args: p.args,
              callId: p.call.id, reason: p.verdict && p.verdict.reason,
              irreversible: p.irreversible, fingerprint: p.fingerprint, external: !!p.external,
            });
            p.approved = !!answer.approved;
          }
        }
      }

      // ---- ③ 执行 ----
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.WORKING });
      const results = new Array(prepared.length).fill(null);

      prepared.forEach((p, idx) => {
        if (p.bad) {
          const msg = '参数错误：' + p.reason;
          recordToolCall(run, { name: p.call.name, callId: p.call.id, args: p.call.args, ok: false, riskLevel: p.riskLevel, error: msg, summary: msg });
          results[idx] = { ok: false, content: msg };
        } else if (p.skip) {
          results[idx] = { ok: true, content: '（这一步在之前的进度里已经做过，已跳过，没有重复执行）' };
          emit(AGENT_EVENT.TOOL_RESULT, { name: p.call.name, callId: p.call.id, ok: true, summary: 'skipped: already completed', skipped: true });
        } else if (p.needAsk && p.approved === false) {
          const why = '用户拒绝了这次操作。请不要重试同一个操作，换一个做法或直接说明做不到。';
          recordToolCall(run, { name: p.call.name, callId: p.call.id, args: p.args, ok: false, riskLevel: p.riskLevel, error: '用户拒绝', summary: why });
          recordCheckpointStep(run, { tool: p.call.name, ok: false, riskLevel: p.riskLevel, error: '用户拒绝', fingerprint: p.fingerprint });
          results[idx] = { ok: false, content: why, denied: true };
          emit(AGENT_EVENT.TOOL_RESULT, { name: p.call.name, callId: p.call.id, ok: false, summary: '用户拒绝' });
        }
      });

      const plan = buildExecutionPlan(prepared, results);
      for (const group of plan) {
        if (cancelled) break;
        if (group.parallel) {
          emit(AGENT_EVENT.NOTICE, {
            level: 'info', code: 'PARALLEL_READS',
            message: '并行执行 ' + group.items.length + ' 个只读工具',
            tools: group.items.map((x) => x.p.call.name),
          });
          await Promise.all(group.items.map(async ({ p, idx }) => {
            emit(AGENT_EVENT.STEP, { step: round, phase: 'tool', tool: p.call.name });
            results[idx] = await callTool(p.call, p);
          }));
          continue;
        }
        for (const { p, idx } of group.items) {
          if (cancelled) break;
          await gates.wait();
          if (cancelled) break;
          emit(AGENT_EVENT.STEP, { step: round, phase: 'tool', tool: p.call.name });
          results[idx] = await callTool(p.call, p);
        }
      }

      // ---- ④ 按调用顺序回填工具结果（顺序不能乱：模型是按顺序理解的）----
      prepared.forEach((p, idx) => {
        const out = results[idx] || { ok: false, content: '（未执行：已取消）' };
        run.messages.push(toolResultMessage(p.call.id, out.content));
        if (out.denied) emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.WORKING });
      });

      // 记一下模型自己说的「下一步」，续跑时作为提示；顺手刷新预算计数
      noteCheckpointNext(run, text);
      if (run.checkpoint) {
        run.checkpoint.roundsSpent = round;
        run.checkpoint.segments = run.segments;
        run.checkpoint.updatedAt = clock();
      }

      // ---- ⑤ 收尾 / 预算判定 ----
      const onlyUnknown = calls.length === 0 && unknown.length > 0;
      if (!onlyUnknown && shouldFinish(text, calls, round, maxRounds)) {
        if (round >= maxRounds && calls.length && round < run.roundBudget) {
          // 段上限到了、任务预算还有：接着跑（不是放弃，也不是完成）
          emit(AGENT_EVENT.NOTICE, {
            level: 'info', code: 'ROUND_SEGMENT_EXTENDED',
            message: '单次段达到轮数上限，任务预算尚余，继续执行',
            maxRounds, roundBudget: run.roundBudget, round,
          });
          continue;
        }
        if (round >= run.roundBudget && calls.length) {
          // 预算用尽但任务没完：先看这一轮有没有真实进展。
          // 有进展 + 允许自动续预算 → 追加一段继续跑（复杂任务不该被固定轮数一刀切死）；
          // 没进展 / 已到硬上限 / 没打开自动续 → 保存进度并暂停。
          const madeProgress = progress.repeatCount < wd.repeatLimit
            && (run.tool_calls || []).some((t) => t.ok);
          const canExtend = wd.autoExtendBudget
            && madeProgress
            && run.roundBudget < Number(wd.hardRoundCap)
            && !cancelled;
          if (canExtend) {
            const nextBudget = Math.min(Number(wd.hardRoundCap), run.roundBudget + maxRounds);
            run.roundBudget = nextBudget;
            run.segments = (run.segments || 0) + 1;
            emit(AGENT_EVENT.NOTICE, {
              level: 'info',
              code: 'BUDGET_EXTENDED',
              message: '本轮仍有进展，任务预算已自动追加到 ' + nextBudget + ' 轮（硬上限 ' + wd.hardRoundCap + '）',
              round,
              roundBudget: nextBudget,
              segments: run.segments,
            });
            continue;
          }
          run.answer = text;
          paused = true;
          run.pauseReason = 'budget';
          gates.close();
          if (!isFinished(run)) transition(run, RUN_STATUS.PAUSED);
          emit(AGENT_EVENT.RUN_UPDATED, run);
          emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.PAUSED });
          emit(AGENT_EVENT.CHECKPOINT, checkpointPayload(run, 'budget'));
          emit(AGENT_EVENT.NOTICE, {
            level: 'warn',
            code: 'BUDGET_EXHAUSTED',
            message: madeProgress
              ? '任务预算已用尽，进度已保存；可以继续执行'
              : '任务预算已用尽，且最近几轮没有产生新进展（可能在空转），进度已保存',
            rounds: round,
            roundBudget: run.roundBudget,
            segments: run.segments,
            stalled: !madeProgress,
          });
          break;
        }
        run.answer = text;
        noteCheckpointNext(run, '');
        break;
      }
    }

    if (cancelled) {
      if (!isFinished(run)) transition(run, RUN_STATUS.CANCELLED);
      run.error = run.error || '已取消';
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.IDLE });
      emit(AGENT_EVENT.CHECKPOINT, checkpointPayload(run, 'cancelled'));
    } else if (run.status !== RUN_STATUS.COMPLETED && run.status !== RUN_STATUS.PAUSED) {
      transition(run, RUN_STATUS.COMPLETED);
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.COMPLETED });
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.SUCCESS });
    }
  } catch (err) {
    const message = String((err && err.message) || err);
    run.error = message;
    if (!isFinished(run)) {
      try { transition(run, RUN_STATUS.FAILED); } catch { run.status = RUN_STATUS.FAILED; }
    }
    emit(AGENT_EVENT.NOTICE, { level: 'error', code: (err && err.code) || 'RUN_FAILED', message });
    emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.ERROR });
    emit(AGENT_EVENT.CHECKPOINT, checkpointPayload(run, 'error'));
  } finally {
    clearInterval(watchdog);
    if (outside) outside.removeEventListener('abort', onOutsideAbort);
    run.updated_at = Date.now();
    emit(AGENT_EVENT.RUN_UPDATED, run);
    emit(AGENT_EVENT.FINISHED, {
      status: run.status,
      answer: run.answer,
      error: run.error,
      paused: run.status === RUN_STATUS.PAUSED,
      pauseReason: run.pauseReason || null,
      stalled: run.pauseReason === 'stalled',
      canContinue: run.status === RUN_STATUS.PAUSED,
    });
  }
  return api;
  })();

  return { api, done };
}

/**
 * 把「工具元信息 + executor」装配成注册表能收的完整工具定义。
 * 单独抽出来是为了让 runtime 不必知道 executor 的细节。
 */
export function buildAgentTools({ specs, executor }) {
  return attachExecutors(specs, executor);
}

export { estimateTokens, workspaceDigest, resolveInsideWorkspace, AUTH_SCOPE };
