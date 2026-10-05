// ============================================================
// Agent Runtime：主循环
//
//   User Task → LLM → Tool Call → Permission → Executor
//             → Tool Result → LLM → … → Final Answer
//
// 设计上的三条线：
//
// 1) **单 Agent**。没有子 agent、没有并行工具调用（同一轮的多个 call 顺序执行，
//    顺序执行才能保证审批弹窗不打架、也让「改了 A 再读 A」这种依赖成立）。
//
// 2) **runtime 不认识 Live2D / DOM / Electron**。它只 emit 事件；
//    谁来订阅是别人的事。所以这一层能在 vitest 里注入假的 llm 和假桥接跑通。
//
// 3) **pause/cancel 是真暂停真取消**：pause 在每轮开始和每次工具调用前检查；
//    cancel 走 AbortController 并让 executor 杀掉所有在跑的子进程。
// ============================================================
import { createEventBus, AGENT_EVENT, AGENT_STATUS, RUN_STATUS } from './events.js';
import { createRun, transition, recordToolCall, recordApproval, addArtifact, isFinished } from './state.js';
import { toolsToProviderSpecs, parseToolCalls, normalizeToolCall, assistantMessage, toolResultMessage, unknownToolMessage, shouldFinish, buildAgentSystemPrompt } from './planner.js';
import { decide, DECISION, riskForTool, describeApproval, normalizePermissionConfig, RISK } from './permission.js';
import { createExecutor, resolveInsideWorkspace } from './executor.js';
import { buildRequestMessages, clipToolResult, workspaceDigest, estimateTokens } from './context.js';
import { buildAgentRequest } from './context-engine.js';
import { validateArgs, attachExecutors } from './tool-registry.js';

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

/**
 * 跑一次 Agent Run。
 *
 * @param {object} deps
 *   task          用户任务
 *   taskMessage   可选：真正发给模型的那条 user 消息（会带上工具上下文）
 *   systemPrompt  **可选但强烈建议传**：由调用方（context-engine）拼好的
 *                 系统提示词 —— 角色人格在前、能力说明在后。
 *                 不传时退化成「纯能力说明」，那样模型就没有人格了。
 *   workspace     绑定的工作区绝对路径
 *   llm           async ({ messages, tools, signal, onDelta, onReasoning }) => { text, toolCalls }
 *   tools         [{ name, description, inputSchema, riskLevel, execute }]（真正执行由 executor 适配）
 *   executor      可选：已有 executor（不传则用 bridge 建一个）
 *   bridge        可选：宿主能力，用来建 executor
 *   isSensitive   可选：敏感路径判定
 *   bus           可选：外部事件总线（默认自建）
 *   requestApproval  async ({ id, name, riskLevel, args, preview }) => { approved, remember }
 *   permissionConfig  风险设置
 *   signal        外部取消信号
 *   maxRounds     循环上限
 *   budgetTokens  上下文预算
 *   now           注入时间（测试用）
 *
 * @returns {{ api: object, done: Promise<object> }}
 *   api 立刻可用（run / pause / resume / cancel / resolveApproval）
 */
export function runAgent(deps = {}) {
  const bus = deps.bus || createEventBus();
  const emit = (type, payload) => bus.emit(type, payload);

  const run = createRun({
    task: deps.task,
    workspace: deps.workspace,
    maxRounds: deps.maxRounds,
    now: deps.now,
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

  const executor = deps.executor || createExecutor({
    workspace: run.workspace,
    bridge: deps.bridge || {},
    isSensitive: deps.isSensitive,
  });

  let cancelled = false;
  let paused = false;
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
      transition(run, RUN_STATUS.PAUSED);
      emit(AGENT_EVENT.RUN_UPDATED, run);
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.PAUSED });
      return true;
    },
    resume() {
      if (isFinished(run) || !paused) return false;
      paused = false;
      gates.open();
      transition(run, RUN_STATUS.RUNNING);
      emit(AGENT_EVENT.RUN_UPDATED, run);
      return true;
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
    /** 审批结果由外部（UI / dialog）回填 */
    resolveApproval(id, approved, remember = false) {
      if (pendingResolvers.has(id)) {
        const resolve = pendingResolvers.get(id);
        pendingResolvers.delete(id);
        resolve({ approved: !!approved, remember: !!remember });
        return true;
      }
      // 没有等待者（比如已经取消）——不抛错，界面晚点关也一样
      return false;
    },
    get status() {
      return run.status;
    },
  };

  async function askApproval({ name, riskLevel, args }) {
    const id = 'ap-' + Math.random().toString(36).slice(2, 10);
    const preview = describeApproval({ name }, args);
    emit(AGENT_EVENT.APPROVAL_REQUEST, { id, name, riskLevel, args, preview });
    transition(run, RUN_STATUS.WAITING_APPROVAL);
    emit(AGENT_EVENT.RUN_UPDATED, run);
    emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.WAITING_APPROVAL });

    let answer;
    if (typeof deps.requestApproval === 'function') {
      const promise = Promise.resolve(deps.requestApproval({ id, name, riskLevel, args, preview }));
      const wrapped = promise.then((r) => (r && typeof r === 'object') ? { approved: !!r.approved, remember: !!r.remember } : { approved: !!r, remember: false });
      // 同时接受 resolveApproval 回填（UI 内联卡片那条路）
      const manual = new Promise((resolve) => { pendingResolvers.set(id, resolve); });
      answer = await Promise.race([wrapped, manual]);
      pendingResolvers.delete(id);
    } else {
      answer = await new Promise((resolve) => { pendingResolvers.set(id, resolve); });
    }

    recordApproval(run, { id, name, riskLevel, approved: answer.approved, remember: answer.remember });
    emit(AGENT_EVENT.APPROVAL_DECIDED, { id, approved: answer.approved, remember: answer.remember });
    if (run.status === RUN_STATUS.WAITING_APPROVAL) {
      transition(run, RUN_STATUS.RUNNING);
      emit(AGENT_EVENT.RUN_UPDATED, run);
    }
    if (answer.remember && answer.approved && riskLevel === RISK.MEDIUM) grants.add('medium');
    return answer;
  }

  /** 执行单个工具调用：权限 → executor */
  async function callTool(call) {
    const tool = registry ? registry.get(call.name) : tools.find((x) => x.name === call.name);
    const riskLevel = riskForTool(tool || { name: call.name });
    emit(AGENT_EVENT.TOOL_CALL, { name: call.name, args: call.args, callId: call.id, riskLevel });
    emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.USING_TOOL });

    // 参数校验不通过也要回给模型，让它改
    const check = validateArgs(tool || { inputSchema: { type: 'object', properties: {} } }, call.args);
    if (!check.ok) {
      const msg = '参数错误：' + check.errors.join('；');
      recordToolCall(run, { name: call.name, callId: call.id, args: call.args, ok: false, riskLevel, error: msg, summary: msg });
      emit(AGENT_EVENT.TOOL_RESULT, { name: call.name, callId: call.id, ok: false, summary: msg });
      return { ok: false, content: msg };
    }

    const decision = decide({ riskLevel, config: permissionConfig, grants });
    if (decision === DECISION.DENY) {
      const msg = '该操作被权限策略拒绝。';
      recordToolCall(run, { name: call.name, callId: call.id, args: check.value, ok: false, riskLevel, error: msg, summary: msg });
      return { ok: false, content: msg };
    }
    if (decision === DECISION.ASK) {
      const answer = await askApproval({ name: call.name, riskLevel, args: check.value });
      if (!answer.approved) {
        const msg = '用户拒绝了这次操作。请不要重试同一个操作，换一个做法或直接说明做不到。';
        recordToolCall(run, { name: call.name, callId: call.id, args: check.value, ok: false, riskLevel, error: '用户拒绝', summary: msg });
        emit(AGENT_EVENT.TOOL_RESULT, { name: call.name, callId: call.id, ok: false, summary: msg });
        return { ok: false, content: msg, denied: true };
      }
    }

    const started = Date.now();
    // 执行实现优先用 executor（真正的宿主能力），其次才是工具定义自带的 execute。
    // 顺序很关键：注册表里的工具定义可能只是元信息 + 占位 execute，
    // 而 executor 才是接上文件系统/进程的那一份。
    const exec = (typeof executor[call.name] === 'function')
      ? executor[call.name].bind(executor)
      : ((tool && typeof tool.execute === 'function') ? tool.execute : null);
    if (!exec) {
      const msg = '工具 ' + call.name + ' 还没有实现';
      recordToolCall(run, { name: call.name, callId: call.id, args: check.value, ok: false, riskLevel, error: msg, summary: msg });
      return { ok: false, content: msg };
    }

    try {
      const raw = await exec(Object.assign({}, check.value, { signal: abortCtrl.signal, workspace: run.workspace }));
      const content = clipToolResult(typeof raw === 'string' ? raw : JSON.stringify(raw));
      const durationMs = Date.now() - started;
      recordToolCall(run, { name: call.name, callId: call.id, args: check.value, ok: true, riskLevel, durationMs, summary: content.slice(0, 500) });
      if (call.name === 'write_file' || call.name === 'apply_patch') {
        addArtifact(run, { name: call.name, kind: 'file', path: String(check.value.path || ''), summary: content.slice(0, 200) });
      }
      emit(AGENT_EVENT.TOOL_RESULT, { name: call.name, callId: call.id, ok: true, summary: content.slice(0, 300), durationMs });
      return { ok: true, content };
    } catch (err) {
      const message = String((err && err.message) || err);
      const durationMs = Date.now() - started;
      recordToolCall(run, { name: call.name, callId: call.id, args: check.value, ok: false, riskLevel, durationMs, error: message, summary: message });
      emit(AGENT_EVENT.TOOL_RESULT, { name: call.name, callId: call.id, ok: false, summary: message, durationMs });
      return { ok: false, content: '执行失败：' + message };
    }
  }

  // ---- 主循环 ----
  emit(AGENT_EVENT.RUN_CREATED, run);
  transition(run, RUN_STATUS.RUNNING);
  emit(AGENT_EVENT.RUN_UPDATED, run);
  // 先 planning（看工具、定步骤）再 thinking（真正开始说话）——
  // Dashboard 靠这个区分「在规划」和「在想词」
  emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.PLANNING });

  const systemPrompt = typeof deps.systemPrompt === 'string' && deps.systemPrompt.trim()
    ? deps.systemPrompt
    // 兜底：调用方没给人格时，至少给一份能力说明（单测/无角色场景走这条）。
    // 正常路径（Chat 触发）永远由 context-engine 注入「角色人格 + 能力说明」。
    : buildAgentSystemPrompt({ task: run.task, workspace: run.workspace, tools });
  run.messages.push({ role: 'user', content: deps.taskMessage || run.task });

  const done = (async () => {
  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      if (cancelled) break;
      await gates.wait();
      if (cancelled) break;

      run.rounds = round;
      emit(AGENT_EVENT.STEP, { step: round, phase: 'llm' });
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.THINKING });

      // 请求结构（顺序不能换）：
      //   [system 人格+能力] → [进入 Agent 前的对话历史] → [本轮对话]
      // 人格只在开头出现一次；工具结果以 tool 消息形式跟在后面，
      // **没有写 system 的通路** —— 所以它不可能覆盖角色提示词。
      //
      // 两种调用方式：
      //   · 传了 deps.buildRequest → 用调用方的（统一走 Context Engine 那条路，
      //     Chat 与 Agent 共用同一份拼装，这是规范做法）；
      //   · 没传 → 退回内置的简单拼装（单测与无 Context Engine 的场景）。
      // 保留后者是为了让 runtime 单独可测，不是鼓励绕过引擎。
      let messages;
      if (typeof deps.buildRequest === 'function') {
        messages = deps.buildRequest({
          systemPrompt,
          history: deps.history,
          messages: run.messages,
          round,
        });
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
        result = await deps.llm({
          messages,
          tools: toolsToProviderSpecs(tools),
          signal: abortCtrl.signal,
          onDelta: (text) => emit(AGENT_EVENT.TEXT, { text }),
          onReasoning: (text) => emit(AGENT_EVENT.REASONING, { text }),
        });
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
        break;
      }

      // 模型编出来的工具名也要回执，否则它会一直重试
      for (const u of unknown) {
        const content = unknownToolMessage(u.name, registry);
        run.messages.push(toolResultMessage(u.id, content));
        recordToolCall(run, { name: u.name, callId: u.id, args: u.args, ok: false, riskLevel: RISK.HIGH, error: '未知工具', summary: content });
      }

      for (const call of calls) {
        if (cancelled) break;
        await gates.wait();
        if (cancelled) break;
        emit(AGENT_EVENT.STEP, { step: round, phase: 'tool', tool: call.name });
        emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.WORKING });
        const out = await callTool(call);
        run.messages.push(toolResultMessage(call.id, out.content));
        if (out.denied) emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.WORKING });
      }

      // 收尾判定。
      // 唯一的例外是「这一轮只有未知工具」：那不是要执行的动作，只是给模型的
      // 一句纠错回执，必须让它再想一轮，否则模型永远看不到那句回执。
      const onlyUnknown = calls.length === 0 && unknown.length > 0;
      if (!onlyUnknown && shouldFinish(text, calls, round, maxRounds)) {
        if (round >= maxRounds && calls.length) {
          run.answer = text || '（达到循环上限 ' + maxRounds + ' 轮，先停在这里）';
          emit(AGENT_EVENT.NOTICE, { level: 'warn', code: 'MAX_ROUNDS', message: '达到循环上限，已停止', maxRounds });
        } else {
          run.answer = text;
        }
        break;
      }
    }

    if (cancelled) {
      if (!isFinished(run)) transition(run, RUN_STATUS.CANCELLED);
      run.error = run.error || '已取消';
      emit(AGENT_EVENT.STATUS, { status: AGENT_STATUS.IDLE });
    } else if (run.status !== RUN_STATUS.COMPLETED) {
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
  } finally {
    if (outside) outside.removeEventListener('abort', onOutsideAbort);
    run.updated_at = Date.now();
    emit(AGENT_EVENT.RUN_UPDATED, run);
    emit(AGENT_EVENT.FINISHED, { status: run.status, answer: run.answer, error: run.error });
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

export { estimateTokens, workspaceDigest, resolveInsideWorkspace };
