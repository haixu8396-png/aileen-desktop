// ============================================================
// Agent 任务抽屉（主窗口内，可收起）
//
// 面板只做三件事：把任务交给 run.js、把事件画成人能看的东西、
// 把用户的操作（暂停/继续/取消/批准/驳回/改授权模式）送回 runtime。
//
// 刻意不做的事：
//   · 不 direct 调 executor —— 执行永远走 runtime 的权限闸门；
//   · 不自己维护一份任务状态 —— 状态以 runtime 的 run 快照为准；
//   · 不 import Live2D —— 状态事件的订阅者在 agent-stage.js 那边；
//   · **不替换 Live2D 展台** —— 抽屉只是主窗口里的一列。
// ============================================================
import { getSettings, saveSettings, setSettingsCache } from './settings.js';
import { state } from './state.js';
import { $, toast } from './dom.js';
import { t } from './i18n.js';
import { startRun } from '../agent/run.js';
import { AGENT_EVENT, AGENT_STATUS, RUN_STATUS } from '../agent/events.js';
import { AUTH_MODE, AUTH_SCOPE, authSummary, normalizeAuthorization } from '../agent/authorization.js';
import { createAgentBridge, createAgentLlm, isSensitivePath } from './agent-bridge.js';
import { subscribeAgentStatus } from './agent-stage.js';
import { syncDashboardMode, pinDrawer } from './agent-dashboard.js';

let controller = null;
let logEl = null;
let approval = null;
/** 批量审批：{ id, items: [{ id, name, preview, riskLevel, irreversible, decision }] } */
let batch = null;
/** 状态总线的订阅（Live2D 表现）——每次开始任务前重订，避免越订越多 */
let unbindStatus = null;
/** 继续执行的回调（由 main.js 注入 chat.js 的 resumeWithAgent，避免模块循环依赖） */
let resumeHandler = null;

const MAX_LOG_LINES = 400;

function lines() {
  if (!logEl) logEl = $('ag-log');
  return logEl;
}

/** 往面板里追加一行（自动滚到底，最多留 400 行） */
function logLine(kind, text) {
  const box = lines();
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'agent-log-line agent-log-' + kind;
  row.textContent = text;
  box.appendChild(row);
  while (box.childElementCount > MAX_LOG_LINES) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  const box = lines();
  if (box) box.innerHTML = '';
}

function setStatus(text) {
  const el = $('ag-status');
  if (el) el.textContent = text;
}

function setControls() {
  const status = controller ? controller.run.status : null;
  const busy = !!status && !['completed', 'failed', 'cancelled'].includes(status);
  const paused = status === RUN_STATUS.PAUSED;
  // 「继续」有两种来源：本轮预算用尽（controller 里有检查点），或者上次没跑完
  // 的检查点已经从磁盘恢复（state.pendingCheckpoint）。
  const canContinue = !!(controller && controller.budget && controller.budget.canContinue)
    || !!state.pendingCheckpoint;
  if ($('ag-start')) $('ag-start').disabled = busy;
  if ($('ag-pause')) $('ag-pause').disabled = !busy || paused;
  if ($('ag-resume')) $('ag-resume').disabled = !paused;
  if ($('ag-continue')) $('ag-continue').classList.toggle('hidden', !canContinue);
  if ($('ag-cancel')) $('ag-cancel').disabled = !busy;
}

/** 授权状态 → 顶部的徽章（把「现在是哪种模式」一直显示出来） */
function renderAuthBadge() {
  const el = $('ag-auth-badge');
  if (!el) return;
  const s = getSettings();
  const auth = normalizeAuthorization((s.agent || {}).authorization || {}, { now: Date.now() });
  const sum = authSummary(auth, Date.now());
  let label = t('agent.authManualTag');
  let cls = 'auth-manual';
  if (sum.mode === AUTH_MODE.BATCH) { label = t('agent.authBatchTag'); cls = 'auth-batch'; }
  if (sum.mode === AUTH_MODE.TRUST) {
    cls = sum.active ? 'auth-trust' : 'auth-trust-off';
    label = sum.active
      ? t('agent.authTrustTag', { scope: sum.scope === AUTH_SCOPE.PERSISTENT ? t('agent.scopePersistent') : t('agent.scopeTask') })
      : t(sum.revoked ? 'agent.authRevokedTag' : 'agent.authExpiredTag');
  }
  el.textContent = label;
  el.className = 'auth-badge ' + cls;
  if ($('ag-trust-warn')) $('ag-trust-warn').classList.toggle('hidden', sum.mode !== AUTH_MODE.TRUST || !sum.active);
  if ($('ag-auth-revoke')) $('ag-auth-revoke').classList.toggle('hidden', sum.mode === AUTH_MODE.MANUAL);
}

/** 预算/轮数显示：让用户知道「这一段还剩多少」 */
function renderBudget(run) {
  const el = $('ag-round');
  if (!el) return;
  if (!run) { el.textContent = ''; return; }
  el.textContent = t('agent.budget', {
    n: run.rounds || 0,
    max: run.roundBudget || run.maxRounds || 0,
    seg: run.segments || 1,
  });
}

function showApproval(req) {
  approval = req;
  const box = $('ag-approval');
  if (!box) return;
  $('ag-approval-risk').textContent = String(req.riskLevel || 'HIGH');
  $('ag-approval-risk').className = 'agent-risk risk-' + String(req.riskLevel || 'HIGH').toLowerCase();
  const text = req.preview || req.name;
  $('ag-approval-text').textContent = req.irreversible ? text + '  ' + t('agent.irreversible') : text;
  box.classList.remove('hidden');
}

function hideApproval() {
  approval = null;
  const box = $('ag-approval');
  if (box) box.classList.add('hidden');
}

/** 批量审批清单：每项都能单独勾，也能整批批准/拒绝 */
function showBatch(req) {
  batch = { id: req.id, items: (req.items || []).map((it) => Object.assign({ decision: true }, it)) };
  const box = $('ag-batch');
  const list = $('ag-batch-list');
  if (!box || !list) return;
  if ($('ag-batch-risk')) {
    $('ag-batch-risk').textContent = String(req.highestRisk || 'HIGH');
    $('ag-batch-risk').className = 'agent-risk risk-' + String(req.highestRisk || 'HIGH').toLowerCase();
  }
  if ($('ag-batch-title')) {
    $('ag-batch-title').textContent = t('agent.batchCount', { n: batch.items.length });
  }
  list.innerHTML = '';
  batch.items.forEach((item, i) => {
    const row = document.createElement('label');
    row.className = 'batch-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.idx = String(i);
    cb.addEventListener('change', () => {
      if (batch && batch.items[i]) batch.items[i].decision = cb.checked;
    });
    const risk = document.createElement('span');
    risk.className = 'agent-risk risk-' + String(item.riskLevel || 'HIGH').toLowerCase();
    risk.textContent = String(item.riskLevel || 'HIGH');
    const text = document.createElement('span');
    text.className = 'batch-item-text';
    text.textContent = (item.irreversible ? t('agent.irreversibleTag') : '') + (item.preview || item.name);
    row.appendChild(cb);
    row.appendChild(risk);
    row.appendChild(text);
    list.appendChild(row);
  });
  box.classList.remove('hidden');
}

function hideBatch() {
  batch = null;
  const box = $('ag-batch');
  if (box) box.classList.add('hidden');
}

/** 状态事件 → 界面文案（键都在 i18n 里，三语同键） */
function statusLabel(status) {
  const map = {
    [AGENT_STATUS.IDLE]: 'agent.stateIdle',
    [AGENT_STATUS.THINKING]: 'agent.stateThinking',
    [AGENT_STATUS.USING_TOOL]: 'agent.stateTool',
    [AGENT_STATUS.WORKING]: 'agent.stateWorking',
    [AGENT_STATUS.WAITING_APPROVAL]: 'agent.stateWaiting',
    [AGENT_STATUS.SUCCESS]: 'agent.stateSuccess',
    [AGENT_STATUS.ERROR]: 'agent.stateError',
  };
  return t(map[status] || 'agent.stateIdle');
}

function onEvent(type, payload) {
  switch (type) {
    case AGENT_EVENT.RUN_CREATED:
      logLine('info', t('agent.logStarted', { id: String((payload && payload.run_id) || '').slice(0, 12) }));
      if (payload && payload.authorization) {
        // 任务开始时把这一轮用的授权模式写进日志（审计要能看到）
        logLine('info', t('agent.logAuthMode', { mode: String(payload.authorization.mode || 'manual') }));
      }
      break;
    case AGENT_EVENT.STEP:
      if (payload && payload.phase === 'llm') logLine('step', t('agent.logThinking', { n: payload.step }));
      else if (payload && payload.tool) logLine('step', t('agent.logTool', { name: payload.tool }));
      break;
    case AGENT_EVENT.TEXT:
      break;
    case AGENT_EVENT.TOOL_CALL:
      logLine('tool', t('agent.logCalling', { name: payload.name }) + (payload.riskLevel ? ' [' + payload.riskLevel + ']' : '')
        + (payload.reason ? ' · ' + payload.reason : ''));
      break;
    case AGENT_EVENT.TOOL_RETRY:
      logLine('warn', t('agent.logRetry', { name: payload.name, n: payload.attempt }) + ' · ' + String(payload.error || ''));
      break;
    case AGENT_EVENT.TOOL_RESULT:
      logLine(payload.ok ? 'ok' : 'err', (payload.ok ? '✓ ' : '✗ ') + String(payload.summary || '').slice(0, 400));
      break;
    case AGENT_EVENT.APPROVAL_REQUEST:
      if (payload && payload.batch) {
        showBatch(payload);
        logLine('warn', t('agent.logBatch', { n: (payload.items || []).length }));
      } else {
        showApproval(payload);
        logLine('warn', t('agent.logApproval', { name: payload.name }));
      }
      break;
    case AGENT_EVENT.APPROVAL_DECIDED:
      hideApproval();
      hideBatch();
      logLine('info', payload.approved ? t('agent.logApproved') : t('agent.logRejected'));
      break;
    case AGENT_EVENT.AUTH_UPDATED:
      renderAuthBadge();
      break;
    case AGENT_EVENT.CHECKPOINT:
      logLine('info', t('agent.logCheckpoint'));
      break;
    case AGENT_EVENT.NOTICE:
      if (payload && payload.level === 'error') logLine('err', String(payload.message || ''));
      else logLine('warn', String((payload && payload.message) || ''));
      break;
    case AGENT_EVENT.STATUS:
      setStatus(statusLabel(payload && payload.status));
      break;
    case AGENT_EVENT.RUN_UPDATED:
      if (payload) renderBudget(payload);
      setControls();
      break;
    case AGENT_EVENT.FINISHED: {
      hideApproval();
      hideBatch();
      const failed = payload && payload.status === RUN_STATUS.FAILED;
      const cancelled = payload && payload.status === RUN_STATUS.CANCELLED;
      const pausedBudget = !!(payload && payload.canContinue);
      if (payload && payload.answer) logLine('answer', payload.answer);
      if (payload && payload.error && !cancelled) logLine('err', payload.error);
      setStatus(cancelled
        ? t('agent.stateCancelled')
        : (pausedBudget ? t('agent.stateBudgetPaused') : (failed ? t('agent.stateError') : t('agent.stateDone'))));
      if (pausedBudget) {
        logLine('warn', t('agent.logBudgetPaused'));
        // 把检查点落盘：关掉应用之后还能续跑
        persistCheckpoint();
      } else if (!cancelled && !failed) {
        // 正常跑完 → 检查点没用了，清掉（避免下次误续一个已完成的任务）
        clearPersistedCheckpoint();
      }
      setControls();
      break;
    }
    default:
      break;
  }
}

/** 把设置里的 agent 段同步到界面 */
function syncSettingsToForm() {
  const s = getSettings();
  const agent = (s && s.agent) || {};
  const auth = normalizeAuthorization(agent.authorization || {}, { now: Date.now() });
  if ($('ag-require-medium')) $('ag-require-medium').checked = agent.requireMedium !== false;
  if ($('ag-workspace-input')) $('ag-workspace-input').value = agent.workspace || '';
  if ($('ag-auth-mode')) $('ag-auth-mode').value = auth.mode;
  if ($('ag-auth-persist')) $('ag-auth-persist').checked = auth.scope === AUTH_SCOPE.PERSISTENT;
  if ($('ag-allow-high')) $('ag-allow-high').checked = auth.allowHighRisk === true;
  renderAuthBadge();
  refreshWorkspaceLabel();
}

async function refreshWorkspaceLabel() {
  const el = $('ag-workspace');
  if (!el) return;
  try {
    const res = await window.api.agentWorkspace();
    el.textContent = (res && res.workspace) || '—';
    el.title = (res && res.workspace) || '';
  } catch (err) {
    el.textContent = '—';
  }
}

/** 保存授权配置（模式 / 范围 / 是否允许 HIGH） */
async function saveAuth(patch) {
  const s = getSettings();
  const agent = s.agent || {};
  const current = normalizeAuthorization(agent.authorization || {}, { now: Date.now() });
  const nextAuth = normalizeAuthorization(Object.assign({}, current, patch, {
    // 换模式就是一次新的授权：清掉上一次的撤销/授权时间
    revokedAt: null,
    grantedAt: Date.now(),
  }), { now: Date.now() });
  const next = Object.assign({}, s, { agent: Object.assign({}, agent, { authorization: nextAuth }) });
  await saveSettings(next);
  if (controller && typeof controller.setAuthorization === 'function') {
    controller.setAuthorization(nextAuth);
  }
  renderAuthBadge();
}

async function readTaskAndStart() {
  const task = (($('ag-task') && $('ag-task').value) || '').trim();
  if (!task) {
    toast(t('agent.needTask'));
    return;
  }
  if (controller && !['completed', 'failed', 'cancelled'].includes(controller.run.status)) {
    toast(t('agent.busy'));
    return;
  }
  const settings = getSettings();
  const agent = (settings && settings.agent) || {};
  let workspace = '';
  try {
    const res = await window.api.agentWorkspace();
    workspace = (res && res.workspace) || '';
  } catch (err) {
    toast(String((err && err.message) || err));
    return;
  }

  clearLog();
  hideApproval();
  hideBatch();
  const started = startRun({
    task,
    workspace,
    llm: createAgentLlm(getSettings),
    bridge: createAgentBridge(),
    isSensitive: isSensitivePath,
    permissionConfig: { requireMedium: agent.requireMedium !== false },
    authorization: normalizeAuthorization(agent.authorization || {}, { now: Date.now() }),
    maxRounds: agent.maxRounds,
    roundBudget: agent.roundBudget,
    maxRetries: agent.maxRetries,
    parallelReadOnly: agent.readOnlyParallel !== false,
    onEvent,
  });
  controller = started.controller;
  // Live2D 表现：Agent 只管 emit，翻译成动作/表情是这边的责任
  if (unbindStatus) unbindStatus();
  unbindStatus = subscribeAgentStatus(started.bus);
  logLine('info', t('agent.logWorkspace', { path: workspace }));
  renderBudget(started.controller.run);
  setControls();
  started.done.catch((err) => {
    logLine('err', String((err && err.message) || err));
    setStatus(t('agent.stateError'));
    setControls();
  });
}

/** 把「Agent 模式」（界面转蓝）挂到 <html> 上或摘掉 */
export function setAgentModeOn(on) {
  const root = document.documentElement;
  if (root && root.classList) root.classList.toggle('agent-mode', !!on);
}

/** 把「继续执行」的实现（main.js 里接 chat.js 的 resumeWithAgent） */
export function setResumeHandler(fn) {
  resumeHandler = typeof fn === 'function' ? fn : null;
}

// ---------------- 检查点落盘（跨重启续跑） ----------------
/** 把当前的检查点写进 <userData>/agent/checkpoint.json（主进程负责落盘） */
async function persistCheckpoint() {
  const api = window.api || {};
  if (typeof api.agentCheckpoint !== 'function') return false;
  const cp = (controller && typeof controller.checkpoint === 'function') ? controller.checkpoint('budget') : state.pendingCheckpoint;
  if (!cp) return false;
  state.pendingCheckpoint = cp;
  state.pendingCheckpointTask = String(cp.task || '');
  try {
    const res = await api.agentCheckpoint({ op: 'save', data: cp });
    return !!(res && res.ok);
  } catch (err) {
    logLine('warn', '检查点保存失败：' + String((err && err.message) || err));
    return false;
  }
}

async function clearPersistedCheckpoint() {
  const api = window.api || {};
  state.pendingCheckpoint = null;
  state.pendingCheckpointTask = '';
  if (typeof api.agentCheckpoint !== 'function') return false;
  try {
    await api.agentCheckpoint({ op: 'clear' });
    return true;
  } catch (err) { return false; }
}

/** 启动时读一次：上次没跑完的任务，抽屉里直接给「继续」 */
async function restoreCheckpoint() {
  const api = window.api || {};
  if (typeof api.agentCheckpoint !== 'function') return false;
  try {
    const res = await api.agentCheckpoint({ op: 'load' });
    const data = res && res.data;
    if (!data || !data.task || !data.checkpoint) return false;
    state.pendingCheckpoint = data;
    state.pendingCheckpointTask = String(data.task || '');
    logLine('info', t('agent.logRestored', { task: String(data.task || '').slice(0, 60) }));
    setControls();
    return true;
  } catch (err) { return false; }
}

/** 当前这轮 run 的控制器（chat.js 用：它在对话里起的 run 要交给抽屉来管按钮） */
export function getAgentController() {
  return controller;
}

/** 面板的初始化（在 src/main.js 启动时调一次） */
export function initAgentUI() {
  logEl = $('ag-log');
  const drawer = $('agent-drawer');
  if (!drawer) return;

  // 「Agent 模式」= 界面主色转蓝。挂在 <html> 上（不是 #app）：
  // Agent 抽屉和一堆弹窗都在 #app 之外，挂 #app 的话它们继承不到新变量。
  const applyAgentMode = () => setAgentModeOn(!drawer.classList.contains('hidden'));
  new MutationObserver(applyAgentMode).observe(drawer, { attributes: true, attributeFilter: ['class'] });
  applyAgentMode();

  const open = () => {
    syncSettingsToForm();
    // 先钉住再可见：否则 syncDashboardMode 会在「开关关着 + 没在跑」时又收回去
    pinDrawer(true);
    drawer.classList.remove('hidden');
    applyAgentMode();
  };
  const close = () => {
    drawer.classList.add('hidden');
    applyAgentMode();
    pinDrawer(false);
  };
  if ($('btn-agent')) $('btn-agent').addEventListener('click', open);
  if ($('ag-close')) $('ag-close').addEventListener('click', close);

  // 电脑控制开关：开 = 之后每条对话都走 Agent（Chat 是入口，Agent 是能力）
  const syncComputerBtn = () => {
    const s = getSettings();
    const on = !!(s.agent && s.agent.computerUse);
    const btn = $('btn-computer');
    if (!btn) return;
    // 图标是内联 SVG（data-icon），这里只改文案，别把图标一起覆盖掉
    const label = $('btn-computer-label');
    const text = on ? t('agent.computerOn') : t('agent.computerOff');
    if (label) label.textContent = text;
    else btn.textContent = text;
    btn.classList.toggle('computer-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  if ($('btn-computer')) {
    $('btn-computer').addEventListener('click', async () => {
      const s = getSettings();
      const on = !(s.agent && s.agent.computerUse);
      const next = Object.assign({}, s, {
        agent: Object.assign({}, s.agent, { computerUse: on }),
      });
      // 先切缓存 + 界面，再落盘：开关必须「点下去就变」，不能等 IPC 往返。
      // 落盘失败就回滚，别让界面停在没保存成功的状态上。
      setSettingsCache(next);
      syncComputerBtn();
      // 点亮开关 = 打开抽屉（**展台不动**），让用户立刻看到任务入口
      setAgentModeOn(on || !drawer.classList.contains('hidden'));
      syncDashboardMode();
      toast(on ? t('agent.computerOn') : t('agent.computerOff'));
      try {
        await saveSettings(next);
      } catch (err) {
        setSettingsCache(s);
        syncComputerBtn();
        setAgentModeOn(!!(s.agent && s.agent.computerUse));
        syncDashboardMode();
        toast(String((err && err.message) || err));
      }
    });
  }
  syncComputerBtn();
  const initial = getSettings();
  if (initial && initial.agent && initial.agent.computerUse) {
    setAgentModeOn(true);
    syncDashboardMode();
  }
  if ($('ag-start')) $('ag-start').addEventListener('click', readTaskAndStart);
  if ($('ag-pause')) $('ag-pause').addEventListener('click', () => { if (controller) { logLine('info', t('agent.logPaused')); controller.pause(); setControls(); } });
  if ($('ag-resume')) $('ag-resume').addEventListener('click', () => { if (controller) { logLine('info', t('agent.logResumed')); controller.resume(); setControls(); } });
  if ($('ag-cancel')) $('ag-cancel').addEventListener('click', () => { if (controller) { logLine('warn', t('agent.logCancelled')); controller.cancel(); setControls(); } });
  if ($('ag-continue')) {
    $('ag-continue').addEventListener('click', () => {
      // 预算用尽后的「继续」= 用检查点重开一次任务（断点续跑）
      if (!resumeHandler) return;
      const cp = (controller && typeof controller.checkpoint === 'function' ? controller.checkpoint('budget') : null)
        || state.pendingCheckpoint;
      if (!cp) { toast(t('agent.noCheckpoint')); return; }
      logLine('info', t('agent.logResuming'));
      resumeHandler(cp);
    });
  }

  if ($('ag-approve')) $('ag-approve').addEventListener('click', () => decide(true, false));
  if ($('ag-approve-always')) $('ag-approve-always').addEventListener('click', () => decide(true, true));
  if ($('ag-reject')) $('ag-reject').addEventListener('click', () => decide(false, false));
  if ($('ag-batch-approve')) $('ag-batch-approve').addEventListener('click', () => decideBatch(true));
  if ($('ag-batch-reject')) $('ag-batch-reject').addEventListener('click', () => decideBatch(false));

  // 授权模式控件
  if ($('ag-auth-mode')) {
    $('ag-auth-mode').addEventListener('change', () => {
      const mode = $('ag-auth-mode').value;
      saveAuth({ mode, scope: $('ag-auth-persist').checked ? AUTH_SCOPE.PERSISTENT : AUTH_SCOPE.TASK });
    });
  }
  if ($('ag-auth-persist')) {
    $('ag-auth-persist').addEventListener('change', () => {
      saveAuth({ scope: $('ag-auth-persist').checked ? AUTH_SCOPE.PERSISTENT : AUTH_SCOPE.TASK });
    });
  }
  if ($('ag-allow-high')) {
    $('ag-allow-high').addEventListener('change', () => saveAuth({ allowHighRisk: !!$('ag-allow-high').checked }));
  }
  if ($('ag-auth-revoke')) {
    $('ag-auth-revoke').addEventListener('click', async () => {
      await saveAuth({ mode: AUTH_MODE.MANUAL, scope: AUTH_SCOPE.TASK, allowHighRisk: false, revokedAt: Date.now() });
      if ($('ag-auth-mode')) $('ag-auth-mode').value = AUTH_MODE.MANUAL;
      if ($('ag-auth-persist')) $('ag-auth-persist').checked = false;
      if ($('ag-allow-high')) $('ag-allow-high').checked = false;
      toast(t('agent.revoked'));
    });
  }

  if ($('ag-workspace-edit')) {
    $('ag-workspace-edit').addEventListener('click', () => $('ag-workspace-box').classList.toggle('hidden'));
  }
  if ($('ag-workspace-save')) {
    $('ag-workspace-save').addEventListener('click', async () => {
      const value = ($('ag-workspace-input').value || '').trim();
      const s = getSettings();
      const next = Object.assign({}, s, { agent: Object.assign({}, s.agent, { workspace: value }) });
      await saveSettings(next);
      $('ag-workspace-box').classList.add('hidden');
      await refreshWorkspaceLabel();
      toast(t('char.saved'));
    });
  }
  if ($('ag-require-medium')) {
    $('ag-require-medium').addEventListener('change', async () => {
      const s = getSettings();
      const next = Object.assign({}, s, {
        agent: Object.assign({}, s.agent, { requireMedium: !!$('ag-require-medium').checked }),
      });
      await saveSettings(next);
    });
  }
  syncSettingsToForm();
  // 启动时把上次没跑完的检查点读回来（跨重启续跑）
  restoreCheckpoint();
}

function decide(approved, remember) {
  if (!approval) return;
  const req = approval;
  // 先收起卡片：卡片是「等一个决定」，决定做完就不该再挂着
  hideApproval();
  if (controller) controller.resolveApproval(req.id, approved, remember);
}

/** 批量：整批批准/拒绝；逐项则用每行的勾选状态（未勾 = 拒绝） */
function decideBatch(allApproved) {
  if (!batch) return;
  const req = batch;
  const decisions = {};
  for (const item of req.items) {
    decisions[item.id] = allApproved ? true : false;
  }
  hideBatch();
  if (controller) controller.resolveApproval(req.id, { decisions, remember: false });
}

/**
 * 自检专用：走**和真实事件同一条路**注入一个事件（不经过 LLM，不花额度）。
 * 只被 __AILEEN_PROBE_AGENT 使用。
 */
export function injectAgentEvent(type, payload) {
  onEvent(type, payload);
}

/** 自检用：抽屉里当前显示什么 */
export function agentUiState() {
  return {
    drawerVisible: !!$('agent-drawer') && !$('agent-drawer').classList.contains('hidden'),
    approvalVisible: !!$('ag-approval') && !$('ag-approval').classList.contains('hidden'),
    batchVisible: !!$('ag-batch') && !$('ag-batch').classList.contains('hidden'),
    batchCount: batch ? batch.items.length : 0,
    authBadge: ($('ag-auth-badge') || {}).textContent || '',
    logLines: (($('ag-log') || {}).childElementCount) || 0,
  };
}
