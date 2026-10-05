// ============================================================
// Agent 任务面板
//
// 面板只做三件事：把任务交给 run.js、把事件画成人能看的东西、
// 把用户的操作（暂停/继续/取消/批准/驳回）送回 runtime。
//
// 刻意不做的事：
//   · 不 direct 调 executor —— 执行永远走 runtime 的权限闸门；
//   · 不自己维护一份状态 —— 状态以 runtime 的 run 快照为准；
//   · 不 import Live2D —— 状态事件的订阅者在 stage.js 那边。
// ============================================================
import { getSettings, saveSettings } from './settings.js';
import { $, toast } from './dom.js';
import { t } from './i18n.js';
import { startRun } from '../agent/run.js';
import { AGENT_EVENT, AGENT_STATUS, RUN_STATUS } from '../agent/events.js';
import { createAgentBridge, createAgentLlm, isSensitivePath } from './agent-bridge.js';
import { subscribeAgentStatus } from './agent-stage.js';
import { syncDashboardMode } from './agent-dashboard.js';

let controller = null;
let logEl = null;
let approval = null;
/** 状态总线的订阅（Live2D 表现）——每次开始任务前重订，避免越订越多 */
let unbindStatus = null;

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
  if ($('ag-start')) $('ag-start').disabled = busy;
  if ($('ag-pause')) $('ag-pause').disabled = !busy || paused;
  if ($('ag-resume')) $('ag-resume').disabled = !paused;
  if ($('ag-cancel')) $('ag-cancel').disabled = !busy;
}

function showApproval(req) {
  approval = req;
  const box = $('ag-approval');
  if (!box) return;
  $('ag-approval-risk').textContent = String(req.riskLevel || 'HIGH');
  $('ag-approval-risk').className = 'agent-risk risk-' + String(req.riskLevel || 'HIGH').toLowerCase();
  $('ag-approval-text').textContent = req.preview || req.name;
  box.classList.remove('hidden');
}

function hideApproval() {
  approval = null;
  const box = $('ag-approval');
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
      logLine('info', t('agent.logStarted', { id: String(payload && payload.run_id || '').slice(0, 12) }));
      break;
    case AGENT_EVENT.STEP:
      if (payload && payload.phase === 'llm') {
        logLine('step', t('agent.logThinking', { n: payload.step }));
      } else if (payload && payload.tool) {
        logLine('step', t('agent.logTool', { name: payload.tool }));
      }
      break;
    case AGENT_EVENT.TEXT:
      // 正文增量不逐字刷屏，只在收尾时整段展示
      break;
    case AGENT_EVENT.TOOL_CALL:
      logLine('tool', t('agent.logCalling', { name: payload.name }) + (payload.riskLevel ? ' [' + payload.riskLevel + ']' : ''));
      break;
    case AGENT_EVENT.TOOL_RESULT:
      logLine(payload.ok ? 'ok' : 'err', (payload.ok ? '✓ ' : '✗ ') + String(payload.summary || '').slice(0, 400));
      break;
    case AGENT_EVENT.APPROVAL_REQUEST:
      showApproval(payload);
      logLine('warn', t('agent.logApproval', { name: payload.name }));
      break;
    case AGENT_EVENT.APPROVAL_DECIDED:
      hideApproval();
      logLine('info', payload.approved ? t('agent.logApproved') : t('agent.logRejected'));
      break;
    case AGENT_EVENT.NOTICE:
      if (payload && payload.level === 'error') logLine('err', String(payload.message || ''));
      else logLine('warn', String((payload && payload.message) || ''));
      break;
    case AGENT_EVENT.STATUS:
      setStatus(statusLabel(payload && payload.status));
      break;
    case AGENT_EVENT.RUN_UPDATED:
      if (payload && payload.rounds) $('ag-round').textContent = t('agent.round', { n: payload.rounds, max: payload.maxRounds });
      setControls();
      break;
    case AGENT_EVENT.FINISHED: {
      hideApproval();
      const failed = payload && payload.status === RUN_STATUS.FAILED;
      const cancelled = payload && payload.status === RUN_STATUS.CANCELLED;
      if (payload && payload.answer) logLine('answer', payload.answer);
      if (payload && payload.error && !cancelled) logLine('err', payload.error);
      setStatus(cancelled ? t('agent.stateCancelled') : (failed ? t('agent.stateError') : t('agent.stateDone')));
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
  if ($('ag-require-medium')) $('ag-require-medium').checked = agent.requireMedium !== false;
  if ($('ag-workspace-input')) $('ag-workspace-input').value = agent.workspace || '';
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

async function readTaskAndStart() {
  const task = ($('ag-task') && $('ag-task').value || '').trim();
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
  $('ag-approval').classList.add('hidden');
  const started = startRun({
    task,
    workspace,
    llm: createAgentLlm(getSettings),
    bridge: createAgentBridge(),
    isSensitive: isSensitivePath,
    permissionConfig: { requireMedium: agent.requireMedium !== false },
    onEvent,
  });
  controller = started.controller;
  // Live2D 表现：Agent 只管 emit，翻译成动作/表情是这边的责任
  if (unbindStatus) unbindStatus();
  unbindStatus = subscribeAgentStatus(started.bus);
  logLine('info', t('agent.logWorkspace', { path: workspace }));
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

/** 面板的初始化（在 src/main.js 启动时调一次） */
export function initAgentUI() {
  logEl = $('ag-log');
  const panel = $('agent-panel');
  if (!panel) return;

  // 「Agent 模式」= 界面主色转蓝。
  // 挂在 <html> 上（不是 #app）：Agent 面板和一堆弹窗都在 #app 之外，
  // 挂 #app 的话它们继承不到新变量，会出现「变量变了但按钮还是旧色」。
  // 用 MutationObserver 跟着面板的 hidden 类走，将来多一个关闭方式也不会漏还原；
  // 同时同步执行一次切换，因为观察者回调是微任务，自检要能立刻读到计算样式。
  const applyAgentMode = () => setAgentModeOn(!panel.classList.contains('hidden'));
  new MutationObserver(applyAgentMode).observe(panel, { attributes: true, attributeFilter: ['class'] });
  applyAgentMode();

  const open = () => {
    syncSettingsToForm();
    panel.classList.remove('hidden');
    applyAgentMode();
  };
  // 关面板的每个入口都要还原主色（观察者兜底，这里同步做一次让状态立刻可读）
  const close = () => {
    panel.classList.add('hidden');
    applyAgentMode();
  };
  if ($('btn-agent')) $('btn-agent').addEventListener('click', open);
  if ($('ag-close')) $('ag-close').addEventListener('click', close);

  // 电脑控制开关：侧栏一个按钮就够。
  // 开 = 之后每条对话都走 Agent（Chat 是入口，Agent 是能力）；
  // 关 = 回到纯聊天。
  const syncComputerBtn = () => {
    const s = getSettings();
    const on = !!(s.agent && s.agent.computerUse);
    const btn = $('btn-computer');
    if (!btn) return;
    btn.textContent = on ? t('agent.computerOn') : t('agent.computerOff');
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
      await saveSettings(next);
      syncComputerBtn();
      // 点亮开关 = 进入控制模式：界面立刻转蓝，右侧 Live2D 立刻换成 Dashboard。
      // 不这么做的话，用户点完会以为没反应 —— 直到他发一条消息才看到变化。
      setAgentModeOn(on || !panel.classList.contains('hidden'));
      syncDashboardMode();
      toast(on ? t('agent.computerOn') : t('agent.computerOff'));
    });
  }
  syncComputerBtn();
  // 启动时如果开关就是开着的，界面直接处于控制模式
  const initial = getSettings();
  if (initial && initial.agent && initial.agent.computerUse) {
    setAgentModeOn(true);
    syncDashboardMode();
  }
  if ($('ag-start')) $('ag-start').addEventListener('click', readTaskAndStart);
  if ($('ag-pause')) $('ag-pause').addEventListener('click', () => { if (controller) { logLine('info', t('agent.logPaused')); controller.pause(); setControls(); } });
  if ($('ag-resume')) $('ag-resume').addEventListener('click', () => { if (controller) { logLine('info', t('agent.logResumed')); controller.resume(); setControls(); } });
  if ($('ag-cancel')) $('ag-cancel').addEventListener('click', () => { if (controller) { logLine('warn', t('agent.logCancelled')); controller.cancel(); setControls(); } });

  if ($('ag-approve')) $('ag-approve').addEventListener('click', () => decide(true, false));
  if ($('ag-approve-always')) $('ag-approve-always').addEventListener('click', () => decide(true, true));
  if ($('ag-reject')) $('ag-reject').addEventListener('click', () => decide(false, false));

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
}

function decide(approved, remember) {
  if (!approval) return;
  const req = approval;
  // 先收起卡片：卡片是「等一个决定」，决定做完就不该再挂着。
  // （曾经因为先 return、后 hide，卡片会卡在界面上点不掉。）
  hideApproval();
  if (controller) controller.resolveApproval(req.id, approved, remember);
}

/**
 * 自检专用：走**和真实事件同一条路**注入一个事件（不经过 LLM，不花额度）。
 * 只被 __AILEEN_PROBE_AGENT 使用。
 */
export function injectAgentEvent(type, payload) {
  onEvent(type, payload);
}
