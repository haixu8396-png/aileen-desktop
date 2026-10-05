// ============================================================
// Agent Control Dashboard
//
// 位置：**原来 Live2D 展台那块区域**。为什么让它接管：
// 电脑控制要显示日志/状态/截图/Tool Calls，而 Live2D 也要空间 ——
// 两个都挤在右边只会互相打架。所以：
//
//   电脑控制开始 → Live2D 让位，Dashboard 顶上
//   完成 / 暂停 / 取消 / 退出 → Live2D 回来
//
// 它是**纯订阅者**：只认 Agent 事件，不反向调 runtime 的内部状态。
// 聊天区负责「人和 AILEEN 说话」，这里负责「AILEEN 到底在干什么」。
// ============================================================
import { $, toast } from './dom.js';
import { t } from './i18n.js';
import { getSettings } from './settings.js';
import { AGENT_EVENT, AGENT_STATUS, RUN_STATUS } from '../agent/events.js';

let controller = null;
let approval = null;
let logEl = null;
/** 这次对话是否正在跑 Agent（跑的过程中不能被「退出控制模式」把面板抽走） */
let running = false;
/** 任务结束后的「延迟归位」定时器句柄 —— 不清会被下一轮任务继承，面板会莫名消失 */
let settleTimer = null;

const MAX_LINES = 500;
const TOOL_HISTORY = 40;
let toolCalls = [];

/** 只切「哪块可见」，不管模式从哪来 */
function applyPanelVisibility(on) {
  const panel = $('stage-panel');
  if (!panel) return;
  const dash = $('agent-dashboard');
  if (dash) dash.classList.toggle('hidden', !on);
  // Live2D 的三块全部让位：舞台本体、模型选择条、动作/表情控件
  for (const sel of ['#stage-container', '.stage-model-bar', '.stage-controls']) {
    const el = panel.querySelector(sel) || document.querySelector(sel);
    if (el) el.classList.toggle('hidden', on);
  }
  panel.classList.toggle('agent-controlling', on);
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
 * 同步「控制模式」：
 *   开关打开 → Dashboard 常驻（Live2D 让位），哪怕还没开始干活
 *   开关关闭且没在跑 → Live2D 回来
 *
 * 为什么要这样：用户点亮开关**就是在说「我要用控制模式」**，
 * 界面上必须立刻有反应，而不是等他发一条消息才知道切过去了。
 */
export function syncDashboardMode() {
  const on = computerUseOn() || running;
  applyPanelVisibility(on);
  if (on && !running) {
    setStatus(AGENT_STATUS.IDLE);
    setNow(t('dash.idleHint'));
  }
}

function logLine(kind, text) {
  const box = logEl || $('dash-log');
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
  const box = logEl || $('dash-log');
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

function showApproval(req) {
  approval = req;
  const box = $('dash-approval');
  if (!box) return;
  if ($('dash-risk')) {
    $('dash-risk').textContent = String(req.riskLevel || 'HIGH');
    $('dash-risk').className = 'agent-risk risk-' + String(req.riskLevel || 'HIGH').toLowerCase();
  }
  if ($('dash-approval-text')) $('dash-approval-text').textContent = req.preview || req.name;
  box.classList.remove('hidden');
}

function hideApproval() {
  approval = null;
  const box = $('dash-approval');
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
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }   // 别让旧定时器把状态改回来
  hideApproval();
  setControls();
  syncDashboardMode();
}

export function initAgentDashboard() {
  logEl = $('dash-log');
  // 直接把事件接到 Dashboard（chat.js 里的 hooks.agentEvent 指到这里）
  if ($('dash-approve')) $('dash-approve').addEventListener('click', () => decide(true));
  if ($('dash-reject')) $('dash-reject').addEventListener('click', () => decide(false));
  if ($('dash-pause')) $('dash-pause').addEventListener('click', () => { if (controller) { controller.pause(); setControls(); } });
  if ($('dash-resume')) $('dash-resume').addEventListener('click', () => { if (controller) { controller.resume(); setControls(); } });
  if ($('dash-cancel')) $('dash-cancel').addEventListener('click', () => { if (controller) { controller.cancel(); setControls(); } });
  // 初始状态跟着「电脑控制」开关走：开着就直接是控制模式
  const s = getSettings();
  applyPanelVisibility(!!(s && s.agent && s.agent.computerUse));
}

/** 自检用：Dashboard 当前可见吗、日志有多少行 */
export function dashboardState() {
  const dash = $('agent-dashboard');
  const stage = $('stage-container');
  return {
    visible: !!dash && !dash.classList.contains('hidden'),
    status: ($('dash-status') || {}).textContent || '',
    task: ($('dash-task') || {}).textContent || '',
    logLines: (($('dash-log') || {}).childElementCount) || 0,
    approvalVisible: !!$('dash-approval') && !$('dash-approval').classList.contains('hidden'),
    stageHidden: !!stage && stage.classList.contains('hidden'),
  };
}
