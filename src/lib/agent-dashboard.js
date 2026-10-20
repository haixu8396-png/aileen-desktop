// ============================================================
// Agent Control Dashboard（现在的形态：主窗口里的抽屉）
//
// 0.8 起**不再接管 Live2D 展台**：
//   · 展台是陪伴体验的核心，Agent 干活时它必须一直开着；
//   · 任务详情搬到主窗口右侧的 #agent-drawer（可收起）。
// 所以这里只负责「抽屉的可见性 + 状态/工具/截图」，绝不碰展台的可见性。
//
// 它仍是**纯订阅者**：只认 Agent 事件，不反向调 runtime 的内部状态。
// 聊天区负责「人和 AILEEN 说话」，抽屉负责「AILEEN 到底在干什么」。
// ============================================================
import { $, toast } from './dom.js';
import { t } from './i18n.js';
import { getSettings } from './settings.js';
import { AGENT_EVENT, AGENT_STATUS, RUN_STATUS } from '../agent/events.js';

let controller = null;
let approval = null;
let logEl = null;
/** 这次对话是否正在跑 Agent（跑的过程中不能被「退出控制模式」把抽屉抽走） */
let running = false;
/** 任务结束后的「延迟归位」定时器句柄 —— 不清会被下一轮任务继承，抽屉会莫名消失 */
let settleTimer = null;

const MAX_LINES = 500;
const TOOL_HISTORY = 40;
let toolCalls = [];

/**
 * 只切「抽屉可不可见」。
 * **展台的任何元素都不在这里动** —— 这是 0.8 的硬要求：Agent 不得替换展台。
 */
function applyPanelVisibility(on) {
  const drawer = $('agent-drawer');
  if (!drawer) return;
  drawer.classList.toggle('hidden', !on);
  // 用一个 body 级类名让主窗口的栅格知道「抽屉占了一列」，方便做宽度过渡
  if (document.body && document.body.classList) {
    document.body.classList.toggle('agent-drawer-open', !!on);
  }
}

/** 电脑控制的总开关（读设置） */
function computerUseOn() {
  try {
    const s = getSettings();
    return !!(s && s.agent && s.agent.computerUse);
  } catch {
    return false;
  }
}

/**
 * 用户手动打开抽屉时把「钉住」标记打开。
 * 没有这个标记的话，`syncDashboardMode()` 会在「电脑控制关着 + 没在跑」时
 * 立刻把用户刚点开的抽屉又收回去（点 btn-agent 看起来像没反应）。
 */
let pinned = false;
export function pinDrawer(on) {
  pinned = !!on;
  applyPanelVisibility(pinned || computerUseOn() || running);
}

/**
 * 同步「抽屉可见性」：
 *   Agent 在跑 → 抽屉开着（用户能看见进度）
 *   电脑控制开关打开且没在跑 → 也打开（用户点开关就是在说「我要用」）
 *   用户手动打开 → 一直开着，直到他自己关
 *   都关掉 → 抽屉收起，**展台始终保持原样**
 */
export function syncDashboardMode() {
  const on = pinned || computerUseOn() || running;
  applyPanelVisibility(on);
  if (on && !running) {
    setStatus(AGENT_STATUS.IDLE);
    setNow(t('dash.idleHint'));
  }
}

function logLine(kind, text) {
  const box = logEl || $('ag-log') || $('dash-log');
  if (!box) return;
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const row = document.createElement('div');
  row.className = 'agent-log-line agent-log-' + kind;
  row.textContent = '[' + stamp + '] ' + text;
  box.appendChild(row);
  while (box.childElementCount > MAX_LINES) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  const box = logEl || $('ag-log') || $('dash-log');
  if (box) box.innerHTML = '';
}

function statusLabel(status) {
  const map = {
    [AGENT_STATUS.IDLE]: 'dash.idle',
    [AGENT_STATUS.THINKING]: 'dash.thinking',
    [AGENT_STATUS.PLANNING]: 'dash.planning',
    [AGENT_STATUS.USING_TOOL]: 'dash.usingTool',
    [AGENT_STATUS.WORKING]: 'dash.working',
    [AGENT_STATUS.WAITING_APPROVAL]: 'dash.waiting',
    [AGENT_STATUS.PAUSED]: 'dash.pausedState',
    [AGENT_STATUS.COMPLETED]: 'dash.completed',
    [AGENT_STATUS.SUCCESS]: 'dash.completed',
    [AGENT_STATUS.FAILED]: 'dash.failedState',
    [AGENT_STATUS.ERROR]: 'dash.failedState',
    [AGENT_STATUS.CANCELLED]: 'dash.cancelledState',
  };
  return t(map[status] || 'dash.idle');
}

function setStatus(status) {
  const el = $('dash-status');
  if (el) el.textContent = statusLabel(status);
  if (el) el.className = 'agent-status status-' + String(status || 'idle');
}

function setNow(text) {
  const el = $('dash-now');
  if (el) el.textContent = text || '—';
}

function addTool(name, ok) {
  toolCalls.push({ name, ok });
  if (toolCalls.length > TOOL_HISTORY) toolCalls = toolCalls.slice(-TOOL_HISTORY);
  const el = $('dash-tools');
  if (!el) return;
  el.innerHTML = '';
  for (const c of toolCalls.slice(-12)) {
    const row = document.createElement('div');
    row.className = 'agent-tool-row ' + (c.ok === false ? 'err' : (c.ok ? 'ok' : ''));
    row.textContent = (c.ok === false ? '✗ ' : (c.ok ? '✓ ' : '· ')) + c.name;
    el.appendChild(row);
  }
}

function showScreen(info) {
  const el = $('dash-screen');
  if (!el) return;
  if (!info) {
    el.textContent = t('dash.noScreen');
    return;
  }
  el.innerHTML = '';
  const meta = document.createElement('div');
  meta.className = 'agent-dash-screen-meta';
  meta.textContent = (info.names && info.names.length)
    ? t('dash.screenMeta', { n: info.count || info.names.length, w: info.width, h: info.height })
    : t('dash.screenMetaShort', { w: info.width, h: info.height });
  el.appendChild(meta);
  if (info.dataUrl) {
    const img = document.createElement('img');
    img.className = 'agent-dash-shot';
    img.src = info.dataUrl;
    img.alt = 'screenshot';
    el.appendChild(img);
  }
}

/**
 * 审批卡片：0.8 起**只有一张**（agent-ui 那张 #ag-approval）。
 * 这里不再重复渲染卡片，只把「有没有待批」这个状态记下来，
 * 免得同一个待确认操作在抽屉里出现两遍。
 */
function showApproval(req) {
  approval = req;
  const box = $('ag-approval');
  if (box && box.classList.contains('hidden')) {
    // agent-ui 没接上（比如单测里只注入了 dashboard 事件）时兜底渲染
    if ($('ag-approval-risk')) {
      $('ag-approval-risk').textContent = String(req.riskLevel || 'HIGH');
      $('ag-approval-risk').className = 'agent-risk risk-' + String(req.riskLevel || 'HIGH').toLowerCase();
    }
    if ($('ag-approval-text')) $('ag-approval-text').textContent = req.preview || req.name;
    box.classList.remove('hidden');
  }
}

function hideApproval() {
  approval = null;
  const box = $('ag-approval');
  if (box) box.classList.add('hidden');
}

function decide(approved) {
  if (!approval) return;
  const req = approval;
  hideApproval();               // 先收卡片：决定做完就不该再挂着
  if (controller) controller.resolveApproval(req.id, approved, false);
}

function setControls() {
  const status = controller && controller.run ? controller.run.status : null;
  const busy = !!status && ![RUN_STATUS.COMPLETED, RUN_STATUS.FAILED, RUN_STATUS.CANCELLED].includes(status);
  const paused = status === RUN_STATUS.PAUSED;
  if ($('dash-pause')) $('dash-pause').disabled = !busy || paused;
  if ($('dash-resume')) $('dash-resume').disabled = !paused;
  if ($('dash-cancel')) $('dash-cancel').disabled = !busy;
}

/** 事件入口：runtime 发什么，这里画什么 */
export function onAgentEvent(type, payload) {
  switch (type) {
    case AGENT_EVENT.RUN_CREATED:
      running = true;
      // 新任务开始：把上一轮的「延迟归位」取消掉，否则它到期会把这一轮的面板切走
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      clearLog();
      toolCalls = [];
      addTool('', null);
      if ($('dash-tools')) $('dash-tools').textContent = '—';
      if ($('dash-task')) $('dash-task').textContent = (payload && payload.task) || '—';
      logLine('info', t('dash.logStarted'));
      applyPanelVisibility(true);
      break;
    case AGENT_EVENT.STEP:
      if (payload && payload.phase === 'llm') setNow(t('dash.nowThinking'));
      else if (payload && payload.tool) setNow(t('dash.nowTool', { name: payload.tool }));
      break;
    case AGENT_EVENT.TEXT:
      break;
    case AGENT_EVENT.TOOL_CALL:
      logLine('tool', t('dash.logCall', { name: payload.name }) + (payload.riskLevel ? ' [' + payload.riskLevel + ']' : ''));
      if (payload.name === 'screen_capture') logLine('info', t('dash.logScreen'));
      break;
    case AGENT_EVENT.TOOL_RESULT:
      addTool(payload.name, payload.ok);
      logLine(payload.ok ? 'ok' : 'err', (payload.ok ? '✓ ' : '✗ ') + String(payload.summary || '').slice(0, 500));
      if (payload.name === 'screen_capture' && payload.ok) {
        // 截图内容另外抓一次带数据的，专门喂给 Dashboard 的预览
        if (window.api && window.api.agentScreenshot) {
          window.api.agentScreenshot({ withData: true }).then(showScreen).catch(() => {});
        }
      }
      break;
    case AGENT_EVENT.APPROVAL_REQUEST:
      showApproval(payload);
      setNow(t('dash.nowApproval', { name: payload.name }));
      logLine('warn', t('dash.logApproval', { name: payload.name, risk: payload.riskLevel }));
      break;
    case AGENT_EVENT.APPROVAL_DECIDED:
      hideApproval();
      logLine('info', payload.approved ? t('dash.logApproved') : t('dash.logRejected'));
      break;
    case AGENT_EVENT.NOTICE:
      logLine(payload && payload.level === 'error' ? 'err' : 'warn', String((payload && payload.message) || ''));
      break;
    case AGENT_EVENT.STATUS:
      setStatus(payload && payload.status);
      break;
    case AGENT_EVENT.RUN_UPDATED:
      setControls();
      break;
    case AGENT_EVENT.FINISHED: {
      hideApproval();
      running = false;
      controller = null;
      const st = payload && payload.status;
      if (payload && payload.answer) logLine('answer', payload.answer);
      if (payload && payload.error && st !== RUN_STATUS.CANCELLED) logLine('err', payload.error);
      setNow('—');
      setControls();
      // Live2D 是否回来由「电脑控制开关」决定：
      // 开关还开着 → Dashboard 继续常驻（用户还在控制模式里）；
      // 开关关了 → Live2D 回来。延迟一下是为了让人看清最后的结果。
      //
      // 这个定时器**必须留句柄**：不留的话，用户在这 1.2 秒里又开了一次任务，
      // 旧定时器到期会把新任务的面板按「上一轮已结束」的逻辑切换/隐藏 ——
      // 面板突然消失，看起来像 bug（同类问题在语音循环那边也踩过）。
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        syncDashboardMode();
      }, 1200);
      break;
    }
    default:
      break;
  }
}

/** 由 chat.js 把这次 run 的控制器交给 Dashboard，才能 Pause/Approve */
export function bindAgentRun(runController) {
  controller = runController;
  setControls();
}

/**
 * 复位成「没在跑」的干净状态。
 * 什么时候需要它：一次 run 结束、或者自检里上一个预览留下的运行态 ——
 * 运行态没清掉的话，关掉开关后面板不会退、Live2D 也不会回来
 *（因为「正在跑就不该被抽走」这条规则会把面板按住）。
 */
export function resetDashboard() {
  running = false;
  controller = null;
  pinned = false;   // 复位时把「用户钉住」也清掉，否则自检/重启后抽屉关不掉
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }   // 别让旧定时器把状态改回来
  hideApproval();
  setControls();
  syncDashboardMode();
}

export function initAgentDashboard() {
  logEl = $('ag-log') || $('dash-log');
  // 单条审批的处理按钮在 agent-ui.js 里接（同一张卡片，不重复接两次）
  if ($('dash-approve')) $('dash-approve').addEventListener('click', () => decide(true));
  if ($('dash-reject')) $('dash-reject').addEventListener('click', () => decide(false));
  if ($('dash-pause')) $('dash-pause').addEventListener('click', () => { if (controller) { controller.pause(); setControls(); } });
  if ($('dash-resume')) $('dash-resume').addEventListener('click', () => { if (controller) { controller.resume(); setControls(); } });
  if ($('dash-cancel')) $('dash-cancel').addEventListener('click', () => { if (controller) { controller.cancel(); setControls(); } });
  // 初始状态跟着「电脑控制」开关走：开着就直接打开抽屉（展台不动）
  const s = getSettings();
  applyPanelVisibility(!!(s && s.agent && s.agent.computerUse));
}

/** 自检用：抽屉当前可见吗、日志有多少行、有没有待批 */
export function dashboardState() {
  const drawer = $('agent-drawer');
  const stage = $('stage-container');
  return {
    visible: !!drawer && !drawer.classList.contains('hidden'),
    status: ($('dash-status') || {}).textContent || '',
    task: ($('dash-task') || {}).textContent || '',
    logLines: (($('ag-log') || $('dash-log') || {}).childElementCount) || 0,
    approvalVisible: !!$('ag-approval') && !$('ag-approval').classList.contains('hidden'),
    // 0.8：Agent 干活时展台**必须可见**（旧版这里是 stageHidden，语义已经反过来）
    stageHidden: !!stage && stage.classList.contains('hidden'),
  };
}
