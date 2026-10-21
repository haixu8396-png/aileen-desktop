// ============================================================
// Agent 的界面（对话内活动卡 + 输入区权限弹层）
//
// 设计原则（用户明确要求过）：
//   · **不要一侧控制台**。Agent 在干什么，就直接长在对话里那条消息上；
//     任务做完的记录去「任务」页看，不再单开一列常驻面板。
//   · 入口只有一个：输入框左边的 Agent 按钮（弹层里有主开关）。
//     主开关与设备页的「电脑控制」是**同一个函数**，点一下只切一次。
//   · 审批卡片贴在活动卡里，风险等级、要做什么、允许/拒绝都在原地。
//   · 不替换展台：Live2D 表现由 agent-stage.js 订阅状态总线，这里不碰它。
//
// 状态全在 agent-state.js 里，这里只做「事件 → 状态 → DOM」。
// ============================================================
import { getSettings, saveSettings, setSettingsCache } from './settings.js';
import { state } from './state.js';
import { $, toast } from './dom.js';
import { t } from './i18n.js';
import { iconSvg } from './icons.js';
import { AGENT_EVENT, AGENT_STATUS, RUN_STATUS } from '../agent/events.js';
import { AUTH_MODE, authSummary, normalizeAuthorization } from '../agent/authorization.js';
import { subscribeAgentStatus } from './agent-stage.js';
import {
  agentUiState, subscribeAgentUi, patchAgentUi, resetAgentUi,
  addAgentStep, noteAgentDecision, setAgentApproval, finishAgentUi,
} from './agent-state.js';
import { fillAvatar } from './shell.js';

let controller = null;
/** 当前这一轮的活动卡 DOM（渲染直接写进去，不靠 querySelector 找「最新的」） */
let card = null;
/** 状态总线的订阅（Live2D 表现）——每次开始任务前重订，避免越订越多 */
let unbindStatus = null;
/** 继续执行的回调（由 main.js 注入 chat.js 的 resumeWithAgent，避免模块循环依赖） */
let resumeHandler = null;
/** 弹层是否展开 */
let panelOpen = false;
/** 最近的步骤在 DOM 里的条数（超过上限删最早的） */
let cardStepCount = 0;

const MIN_CARD_STEPS = 3;

// ---------------- 一、事件进来 ----------------

const STATUS_KEYS = {
  [AGENT_STATUS.IDLE]: 'agent.stateIdle',
  [AGENT_STATUS.THINKING]: 'agent.stateThinking',
  [AGENT_STATUS.PLANNING]: 'agent.statePlanning',
  [AGENT_STATUS.USING_TOOL]: 'agent.stateTool',
  [AGENT_STATUS.WORKING]: 'agent.stateWorking',
  [AGENT_STATUS.WAITING_APPROVAL]: 'agent.stateWaiting',
  [AGENT_STATUS.PAUSED]: 'agent.statePaused',
  [AGENT_STATUS.SUCCESS]: 'agent.stateDone',
  [AGENT_STATUS.COMPLETED]: 'agent.stateDone',
  [AGENT_STATUS.ERROR]: 'agent.stateError',
  [AGENT_STATUS.FAILED]: 'agent.stateError',
  [AGENT_STATUS.CANCELLED]: 'agent.stateCancelled',
};

export function statusText(status) {
  return t(STATUS_KEYS[status] || 'agent.stateIdle');
}

function step(kind, text, ok) {
  addAgentStep({ kind, text, ok });
  // 状态变化后卡片由订阅统一重画（见 initAgentUI 里的 subscribe）
}

/**
 * runtime 事件的总入口。
 * **对话路径和自检注入走的是同一条路**，所以自检验的就是真实行为。
 */
export function handleAgentEvent(type, payload) {
  switch (type) {
    case AGENT_EVENT.RUN_CREATED:
      patchAgentUi({
        running: true, finished: false, status: AGENT_STATUS.PLANNING,
        task: String((payload && (payload.task || payload.goal)) || ''),
        round: 0, error: '',
      });
      step('info', t('agent.logStarted', { id: String((payload && payload.run_id) || '—').slice(0, 12) }));
      if (payload && payload.authorization) {
        step('info', t('agent.logAuthMode', { mode: String(payload.authorization.mode || 'manual') }));
      }
      break;
    case AGENT_EVENT.STEP:
      // 只有「开始思考」值得单独一行；工具调用紧跟着 TOOL_CALL，重复写会显得很吵
      if (payload && payload.phase === 'llm') step('step', t('agent.logThinking', { n: payload.step }));
      break;
    case AGENT_EVENT.TEXT:
      break;
    case AGENT_EVENT.TOOL_CALL:
      step('tool', t('agent.logCalling', { name: payload.name })
        + (payload.riskLevel ? ' [' + payload.riskLevel + ']' : '')
        + (payload.reason ? ' · ' + payload.reason : ''));
      break;
    case AGENT_EVENT.TOOL_RETRY:
      step('warn', t('agent.logRetry', { name: payload.name, n: payload.attempt }) + ' · ' + String(payload.error || ''));
      break;
    case AGENT_EVENT.TOOL_RESULT:
      step(payload.ok ? 'ok' : 'err', (payload.ok ? '✓ ' : '✗ ') + String(payload.summary || '').slice(0, 400), !!payload.ok);
      break;
    case AGENT_EVENT.APPROVAL_REQUEST:
      setAgentApproval(payload || {});
      patchAgentUi({ status: AGENT_STATUS.WAITING_APPROVAL });
      step('warn', payload && payload.batch
        ? t('agent.logBatch', { n: (payload.items || []).length })
        : t('agent.logApproval', { name: payload && payload.name }));
      break;
    case AGENT_EVENT.APPROVAL_DECIDED: {
      const req = agentUiState().approval || {};
      noteAgentDecision({
        name: req.name || req.batchName || '',
        riskLevel: req.riskLevel || req.highestRisk || 'HIGH',
        approved: !!payload.approved,
        remember: !!payload.remember,
      });
      setAgentApproval(null);
      step('info', payload.approved ? t('agent.logApproved') : t('agent.logRejected'));
      break;
    }
    case AGENT_EVENT.AUTH_UPDATED:
      renderPanel();
      break;
    case AGENT_EVENT.CHECKPOINT:
      patchAgentUi({ checkpoint: true });
      step('info', t('agent.logCheckpoint'));
      break;
    case AGENT_EVENT.NOTICE:
      step(payload && payload.level === 'error' ? 'err' : 'warn', String((payload && payload.message) || ''));
      break;
    case AGENT_EVENT.STATUS:
      patchAgentUi({ status: (payload && payload.status) || AGENT_STATUS.IDLE });
      break;
    case AGENT_EVENT.RUN_UPDATED:
      if (payload) {
        patchAgentUi({
          round: payload.rounds || 0,
          roundBudget: payload.roundBudget || payload.maxRounds || 0,
          segments: payload.segments || 1,
        });
      }
      break;
    case AGENT_EVENT.FINISHED: {
      const failed = payload && payload.status === RUN_STATUS.FAILED;
      const cancelled = payload && payload.status === RUN_STATUS.CANCELLED;
      const pausedBudget = !!(payload && payload.canContinue);
      if (payload && payload.answer) step('answer', payload.answer);
      if (payload && payload.error && !cancelled) step('err', payload.error);
      finishAgentUi({
        status: cancelled ? RUN_STATUS.CANCELLED : (failed ? RUN_STATUS.FAILED : RUN_STATUS.COMPLETED),
        error: (payload && payload.error) || '',
        checkpoint: pausedBudget,
      });
      patchAgentUi({ status: cancelled
        ? AGENT_STATUS.CANCELLED
        : (pausedBudget ? AGENT_STATUS.PAUSED : (failed ? AGENT_STATUS.ERROR : AGENT_STATUS.SUCCESS)) });
      if (pausedBudget) {
        step('warn', t('agent.logBudgetPaused'));
        persistCheckpoint();
      } else if (!cancelled && !failed) {
        clearPersistedCheckpoint();
      }
      // 这一轮结束了：Live2D 的表现订阅可以摘掉（下一轮再重订，避免越订越多）
      if (unbindStatus) { unbindStatus(); unbindStatus = null; }
      break;
    }
    default:
      break;
  }
  updateControls();
}

// ---------------- 二、对话里的活动卡 ----------------

function currentTaskLabel() {
  const s = agentUiState();
  return s.task || t('agent.cardTitle');
}

function mountCard(task) {
  const box = $('messages');
  if (!box) return null;
  // 上一张卡收成「已结束」的样子：去掉动作区与待确认卡片，保留过程
  document.querySelectorAll('.agent-card .agc-actions').forEach((el) => { el.innerHTML = ''; });
  document.querySelectorAll('.agent-card .agent-approval').forEach((el) => el.classList.add('hidden'));
  document.querySelectorAll('.agent-card.is-running').forEach((el) => el.classList.remove('is-running'));

  const wrap = document.createElement('div');
  wrap.className = 'msg agent';
  const av = document.createElement('span');
  av.className = 'msg-avatar';
  const cur = state.current;
  fillAvatar(av, (cur && cur.data && cur.data.name) || 'AILEEN', (cur && cur.data && cur.data.avatar) || '');
  wrap.appendChild(av);

  const cardEl = document.createElement('div');
  cardEl.className = 'agent-card is-running';
  cardEl.innerHTML = ''
    + '<div class="agc-head">'
    + '  <span class="agc-ico">' + iconSvg('agent', 15) + '</span>'
    + '  <span class="agc-title"></span>'
    + '  <span class="agc-badge"></span>'
    + '  <span class="agc-spacer"></span>'
    + '  <span class="agc-round"></span>'
    + '  <button class="icon-btn tiny agc-collapse" data-i18n-title="agent.collapseTip" title="收起 / 展开">' + iconSvg('chevronDown', 14) + '</button>'
    + '</div>'
    + '<ul class="agc-steps"></ul>'
    + '<div class="agent-approval hidden">'
    + '  <div class="agent-approval-head"><span class="agent-risk">HIGH</span><span class="aa-label"></span></div>'
    + '  <p class="agent-approval-text"></p>'
    + '  <div class="batch-list hidden"></div>'
    + '  <div class="agc-actions">'
    + '    <button class="primary small-btn aa-approve">' + t('agent.approve') + '</button>'
    + '    <button class="ghost small-btn aa-always">' + t('agent.approveAlways') + '</button>'
    + '    <button class="danger small-btn aa-reject">' + t('agent.reject') + '</button>'
    + '    <button class="primary small-btn aa-batch-approve">' + t('agent.approveAll') + '</button>'
    + '    <button class="danger small-btn aa-batch-reject">' + t('agent.rejectAll') + '</button>'
    + '  </div>'
    + '</div>'
    + '<div class="agc-actions agc-controls"></div>';
  wrap.appendChild(cardEl);
  box.appendChild(wrap);

  cardEl.querySelector('.aa-approve').onclick = () => decideApproval(true, false);
  cardEl.querySelector('.aa-always').onclick = () => decideApproval(true, true);
  cardEl.querySelector('.aa-reject').onclick = () => decideApproval(false, false);
  cardEl.querySelector('.aa-batch-approve').onclick = () => decideBatch(true);
  cardEl.querySelector('.aa-batch-reject').onclick = () => decideBatch(false);
  cardEl.querySelector('.agc-collapse').onclick = () => {
    cardEl.querySelector('.agc-steps').classList.toggle('collapsed');
  };

  card = cardEl;
  cardStepCount = 0;
  cardEl.querySelector('.agc-title').textContent = task || t('agent.cardTitle');
  scrollChatToBottom();
  return cardEl;
}

function scrollChatToBottom() {
  const box = $('messages');
  if (box) box.scrollTop = box.scrollHeight;
}

function renderSteps() {
  if (!card) return;
  const list = card.querySelector('.agc-steps');
  if (!list) return;
  list.innerHTML = '';
  for (const s of agentUiState().steps) {
    const li = document.createElement('li');
    li.className = 'agc-step' + (s.ok === true ? ' ok' : (s.ok === false ? ' err' : ''))
      + (s.kind === 'warn' ? ' warn' : '') + (s.kind === 'answer' ? ' answer' : '');
    const dot = document.createElement('span');
    dot.className = 'agc-dot';
    dot.textContent = s.ok === true ? '✓' : (s.ok === false ? '✗' : '·');
    const text = document.createElement('span');
    text.className = 'agc-text';
    text.textContent = s.text;
    li.appendChild(dot);
    li.appendChild(text);
    list.appendChild(li);
  }
  cardStepCount = list.childElementCount;
  list.scrollTop = list.scrollHeight;
}

function renderApproval() {
  if (!card) return;
  const box = card.querySelector('.agent-approval');
  if (!box) return;
  const req = agentUiState().approval;
  if (!req) { box.classList.add('hidden'); return; }
  const risk = String(req.highestRisk || req.riskLevel || 'HIGH').toUpperCase();
  const riskEl = box.querySelector('.agent-risk');
  riskEl.textContent = risk;
  riskEl.className = 'agent-risk risk-' + risk.toLowerCase() + ' ' + risk;
  box.querySelector('.aa-label').textContent = req.batch
    ? t('agent.batchTitle')
    : t('agent.waitingApproval');
  box.querySelector('.agent-approval-text').textContent = req.batch
    ? t('agent.batchCount', { n: (req.items || []).length })
    : String(req.preview || req.name || '');
  // 单条 / 批量按钮互斥出现
  box.querySelector('.aa-approve').classList.toggle('hidden', !!req.batch);
  box.querySelector('.aa-always').classList.toggle('hidden', !!req.batch || !!req.irreversible);
  box.querySelector('.aa-reject').classList.toggle('hidden', !!req.batch);
  box.querySelector('.aa-batch-approve').classList.toggle('hidden', !req.batch);
  box.querySelector('.aa-batch-reject').classList.toggle('hidden', !req.batch);
  const listBox = box.querySelector('.batch-list');
  listBox.classList.toggle('hidden', !req.batch);
  if (req.batch) {
    listBox.innerHTML = '';
    (req.items || []).forEach((item, i) => {
      const row = document.createElement('label');
      row.className = 'batch-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.idx = String(i);
      cb.addEventListener('change', () => { batchDecisions[i] = cb.checked; });
      const badge = document.createElement('span');
      badge.className = 'agent-risk risk-' + String(item.riskLevel || 'HIGH').toLowerCase();
      badge.textContent = String(item.riskLevel || 'HIGH');
      const text = document.createElement('span');
      text.className = 'batch-item-text';
      text.textContent = item.preview || item.name || '';
      row.appendChild(cb);
      row.appendChild(badge);
      row.appendChild(text);
      listBox.appendChild(row);
    });
    batchDecisions = (req.items || []).map(() => true);
  }
  box.classList.remove('hidden');
  scrollChatToBottom();
}

let batchDecisions = [];

function renderControls() {
  if (!card) return;
  const box = card.querySelector('.agc-controls');
  if (!box) return;
  const s = agentUiState();
  box.innerHTML = '';
  const make = (label, cls, onClick) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.onclick = onClick;
    box.appendChild(b);
  };
  if (s.running) {
    const st = s.status;
    if (st === AGENT_STATUS.PAUSED) make(t('agent.resume'), 'ghost small-btn', () => { if (controller) { controller.resume(); } });
    else make(t('agent.pause'), 'ghost small-btn', () => { if (controller) { controller.pause(); } });
    make(t('agent.cancel'), 'danger small-btn', () => { if (controller) { controller.cancel(); } });
  } else if (s.checkpoint) {
    make(t('agent.continue'), 'primary small-btn', () => resumeAgentTask());
  }
  // 卡片头部的状态与轮数
  const badge = card.querySelector('.agc-badge');
  if (badge) {
    badge.textContent = statusText(s.status);
    badge.className = 'agc-badge status-' + String(s.status || 'idle');
  }
  const round = card.querySelector('.agc-round');
  if (round) {
    round.textContent = s.round || s.roundBudget
      ? t('agent.budget', { n: s.round, max: s.roundBudget, seg: s.segments })
      : '';
  }
  const title = card.querySelector('.agc-title');
  if (title && s.task) title.textContent = s.task;
  card.classList.toggle('is-running', !!s.running);
  card.classList.toggle('is-done', !s.running && s.status === AGENT_STATUS.SUCCESS);
  card.classList.toggle('is-failed', !s.running && (s.status === AGENT_STATUS.ERROR || s.status === AGENT_STATUS.CANCELLED));
  // 跑完之后过程自动收起来，只留一句结果 —— 聊天不该被一屏日志占满
  const steps = card.querySelector('.agc-steps');
  if (steps && !s.running && cardStepCount > MIN_CARD_STEPS) steps.classList.add('collapsed');
}

function updateControls() {
  renderSteps();
  renderApproval();
  renderControls();
}

/** 对话开始时由 chat.js 调：挂上这一轮的活动卡 */
export function beginAgentTurn(task) {
  resetAgentUi();
  patchAgentUi({ running: true, status: AGENT_STATUS.PLANNING, task: String(task || '') });
  mountCard(task);
  return card;
}

/** chat.js 把这次 run 的控制器与状态总线交进来（暂停 / 继续 / 取消 / 审批 + Live2D 表现都要它们） */
export function attachAgentController(runController, bus) {
  controller = runController;
  if (bus) {
    if (unbindStatus) unbindStatus();
    unbindStatus = subscribeAgentStatus(bus);
  }
  updateControls();
}

/** 自检 / 外部需要拿到控制器时用 */
export function getAgentController() {
  return controller;
}

export function setAgentUiState(patch) {
  return patchAgentUi(patch);
}

/**
 * 复位成「没在跑」（换角色 / 自检 / 任务结束后收尾都走它）。
 * 还会把当前那张活动卡从对话里摘掉 —— 「复位」意味着连痕迹都不该留下，
 * 否则自检的「跑之前不该有卡片」会读到上一轮的残留。
 */
export function resetAgentRun() {
  if (unbindStatus) { unbindStatus(); unbindStatus = null; }
  controller = null;
  resetAgentUi();
  if (card) {
    const wrap = card.closest('.msg.agent');
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    card = null;
    cardStepCount = 0;
  }
  return agentUiSnapshot();
}

// ---------------- 三、审批 ----------------

function decideApproval(approved, remember) {
  const req = agentUiState().approval;
  if (!req) return false;
  // 先收卡片：卡片是「等一个决定」，决定做完就不该再挂着
  setAgentApproval(null);
  if (controller) controller.resolveApproval(req.id, approved, remember);
  updateControls();
  return true;
}

function decideBatch(allApproved) {
  const req = agentUiState().approval;
  if (!req) return false;
  const decisions = {};
  (req.items || []).forEach((item, i) => {
    decisions[item.id] = allApproved ? true : (batchDecisions[i] === true);
  });
  setAgentApproval(null);
  if (controller) controller.resolveApproval(req.id, { decisions, remember: false });
  updateControls();
  return true;
}

// ---------------- 四、输入区的 Agent 权限弹层 ----------------

function panelEl() {
  return $('agent-panel');
}

export function openAgentPanel() {
  const el = panelEl();
  if (!el) return false;
  renderPanel();
  el.classList.remove('hidden');
  panelOpen = true;
  const chip = $('btn-agent-mode');
  if (chip) chip.setAttribute('aria-expanded', 'true');
  return true;
}

export function closeAgentPanel() {
  const el = panelEl();
  if (!el) return false;
  el.classList.add('hidden');
  panelOpen = false;
  const chip = $('btn-agent-mode');
  if (chip) chip.setAttribute('aria-expanded', 'false');
  return true;
}

export function toggleAgentPanel() {
  return panelOpen ? closeAgentPanel() : openAgentPanel();
}

export function isAgentPanelOpen() {
  return panelOpen;
}

async function refreshWorkspacePath() {
  const el = $('ap-workspace-path');
  if (!el) return '';
  try {
    const res = await window.api.agentWorkspace();
    const ws = (res && res.workspace) || '';
    el.textContent = ws || '—';
    el.title = ws;
    // 设置页里那一行也显示同一个路径（两处入口，一份数据）
    const settingsEl = $('ag-workspace');
    if (settingsEl) {
      settingsEl.textContent = ws || '—';
      settingsEl.title = ws;
    }
    return ws;
  } catch (err) {
    el.textContent = '—';
    return '';
  }
}

function renderRecent() {
  const box = $('ap-recent');
  if (!box) return;
  box.innerHTML = '';
  const items = agentUiState().recent;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'ap-hint';
    empty.textContent = t('agent.recentEmpty');
    box.appendChild(empty);
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'ap-recent-row';
    const mark = document.createElement('span');
    mark.className = it.approved ? 'yes' : 'no';
    mark.textContent = it.approved ? '✓' : '✗';
    const name = document.createElement('span');
    name.className = 'rp-name';
    name.textContent = it.name || '—';
    const risk = document.createElement('span');
    risk.className = 'agent-risk risk-' + String(it.riskLevel || 'high').toLowerCase();
    risk.textContent = it.riskLevel || 'HIGH';
    row.appendChild(mark);
    row.appendChild(name);
    row.appendChild(risk);
    box.appendChild(row);
  }
}

/** 把设置里的 agent 段同步到弹层控件（不传值：从 settings 读取） */
export function renderPanel() {
  const s = getSettings();
  const agent = (s && s.agent) || {};
  const auth = normalizeAuthorization(agent.authorization || {}, { now: Date.now() });
  const sum = authSummary(auth, Date.now());
  const enabled = agent.computerUse === true;
  const full = sum.mode === AUTH_MODE.TRUST && sum.allowHighRisk === true;
  if ($('ap-enabled')) $('ap-enabled').checked = enabled;
  if ($('ap-full')) $('ap-full').checked = full;
  if ($('ap-skipwrite')) $('ap-skipwrite').checked = agent.requireMedium === false;
  renderRecent();
  refreshWorkspacePath();
  // 设置页里的那几项也一起刷新（两处共用同一份设置）
  if ($('ag-workspace')) { /* 设置页自己的路径文本由 fillAllSettings 负责 */ }
  if ($('ag-auth-mode')) $('ag-auth-mode').value = auth.mode;
  if ($('ag-auth-persist')) $('ag-auth-persist').checked = auth.scope === 'persistent';
  if ($('ag-allow-high')) $('ag-allow-high').checked = auth.allowHighRisk === true;
  if ($('ag-require-medium')) $('ag-require-medium').checked = agent.requireMedium !== false;
  if ($('ag-auth-badge')) {
    const label = sum.mode === AUTH_MODE.TRUST
      ? t('agent.authTrustTag', { scope: sum.scope === 'persistent' ? t('agent.scopePersistent') : t('agent.scopeTask') })
      : (sum.mode === AUTH_MODE.BATCH ? t('agent.authBatchTag') : t('agent.authManualTag'));
    $('ag-auth-badge').textContent = label;
  }
  syncChip();
}

/** 输入区的 Agent 按钮：亮着 = 电脑控制开着；文案永远只是「Agent」 */
function syncChip() {
  const s = getSettings();
  const on = !!(s.agent && s.agent.computerUse);
  const chip = $('btn-agent-mode');
  if (chip) {
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.title = on ? t('agent.computerOn') : t('agent.computerOff');
  }
  const btn = $('btn-computer');
  if (btn) {
    const label = $('btn-computer-label');
    const text = on ? t('agent.computerOn') : t('agent.computerOff');
    if (label) label.textContent = text;
    else btn.textContent = text;
    btn.classList.toggle('computer-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/**
 * 电脑控制的总开关。
 * 设备页的按钮、弹层里的主开关**都调这一个函数**：
 * 两个入口各自再绑一个 handler 就变成「点一下切两次」，看起来像关不掉。
 */
export async function toggleComputerUse() {
  const s = getSettings();
  const on = !(s.agent && s.agent.computerUse);
  const next = Object.assign({}, s, {
    agent: Object.assign({}, s.agent, { computerUse: on }),
  });
  // 先切缓存 + 界面，再落盘：开关必须「点下去就变」，不能等 IPC 往返。
  setSettingsCache(next);
  syncChip();
  renderPanel();
  toast(on ? t('agent.computerOn') : t('agent.computerOff'));
  try {
    await saveSettings(next);
  } catch (err) {
    setSettingsCache(s);
    syncChip();
    renderPanel();
    toast(String((err && err.message) || err));
  }
  return on;
}

/** 完整权限 / 跳过写入确认 / 授权模式：都落进同一份 agent.authorization */
async function saveAuth(patch) {
  const s = getSettings();
  const agent = s.agent || {};
  const current = normalizeAuthorization(agent.authorization || {}, { now: Date.now() });
  const nextAuth = normalizeAuthorization(Object.assign({}, current, patch, {
    revokedAt: null,
    grantedAt: Date.now(),
  }), { now: Date.now() });
  const next = Object.assign({}, s, { agent: Object.assign({}, agent, { authorization: nextAuth }) });
  setSettingsCache(next);
  renderPanel();
  if (controller && typeof controller.setAuthorization === 'function') controller.setAuthorization(nextAuth);
  try {
    await saveSettings(next);
  } catch (err) {
    setSettingsCache(s);
    renderPanel();
    toast(String((err && err.message) || err));
  }
}

async function saveAgentField(patch) {
  const s = getSettings();
  const next = Object.assign({}, s, { agent: Object.assign({}, s.agent, patch) });
  setSettingsCache(next);
  renderPanel();
  try {
    await saveSettings(next);
  } catch (err) {
    setSettingsCache(s);
    renderPanel();
    toast(String((err && err.message) || err));
  }
}

async function pickWorkspace() {
  if (!window.api || typeof window.api.agentChooseWorkspace !== 'function') {
    toast(t('agent.pickUnsupported'), true);
    return;
  }
  try {
    const res = await window.api.agentChooseWorkspace();
    if (!res || !res.workspace) return;
    await saveAgentField({ workspace: res.workspace });
    toast(t('agent.workspaceSaved'));
  } catch (err) {
    toast(String((err && err.message) || err), true);
  }
}

async function openWorkspace() {
  try {
    const res = await window.api.agentWorkspace();
    const ws = (res && res.workspace) || '';
    if (ws) await window.api.openPath(ws);
  } catch (err) { /* 打不开就算了，不值得打断 */ }
}

// ---------------- 五、检查点 ----------------

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

async function restoreCheckpoint() {
  const api = window.api || {};
  if (typeof api.agentCheckpoint !== 'function') return false;
  try {
    const res = await api.agentCheckpoint({ op: 'load' });
    const data = res && res.data;
    if (!data || !data.task || !data.checkpoint) return false;
    state.pendingCheckpoint = data;
    state.pendingCheckpointTask = String(data.task || '');
    patchAgentUi({ checkpoint: true, task: '' });
    return true;
  } catch (err) { return false; }
}

/** 断点续跑：用检查点重开一次任务（活动卡里那个「继续执行」按钮） */
export function resumeAgentTask() {
  if (!resumeHandler) return false;
  const cp = (controller && typeof controller.checkpoint === 'function' ? controller.checkpoint('budget') : null)
    || state.pendingCheckpoint;
  if (!cp) { toast(t('agent.noCheckpoint')); return false; }
  resumeHandler(cp);
  return true;
}

/** 注入「继续执行」的实现（main.js 里接 chat.js 的 resumeWithAgent） */
export function setResumeHandler(fn) {
  resumeHandler = typeof fn === 'function' ? fn : null;
}

// ---------------- 六、初始化 ----------------

/** 自检用：把当前界面状态说清楚（不返回 DOM 节点） */
export function agentUiSnapshot() {
  const s = agentUiState();
  const panel = panelEl();
  const steps = card ? card.querySelectorAll('.agc-step') : [];
  const approval = card ? card.querySelector('.agent-approval') : null;
  return {
    panelOpen: panelOpen && !!panel && !panel.classList.contains('hidden'),
    panelExists: !!panel,
    cardVisible: !!card && !!card.isConnected,
    cardRunning: !!card && card.classList.contains('is-running'),
    cardStatus: card ? String((card.querySelector('.agc-badge') || {}).textContent || '') : '',
    cardTask: card ? String((card.querySelector('.agc-title') || {}).textContent || '') : '',
    stepLines: steps.length,
    approvalVisible: !!approval && !approval.classList.contains('hidden'),
    approvalRisk: approval ? String((approval.querySelector('.agent-risk') || {}).textContent || '') : '',
    approvalText: approval ? String((approval.querySelector('.agent-approval-text') || {}).textContent || '') : '',
    chipOn: !!$('btn-agent-mode') && $('btn-agent-mode').classList.contains('on'),
    running: s.running,
    status: s.status,
    recent: s.recent.length,
  };
}

/** 自检专用：走**和真实事件同一条路**注入一个事件（不经过 LLM，不花额度） */
export function injectAgentEvent(type, payload) {
  handleAgentEvent(type, payload);
}

export function initAgentUI() {
  if (!$('agent-panel')) return;

  // 状态 → 界面：任何一处改了状态，活动卡与任务页都会跟着重画
  subscribeAgentUi(() => {
    if (card) updateControls();
  });

  const chip = $('btn-agent-mode');
  if (chip) chip.addEventListener('click', () => toggleAgentPanel());
  // 点空白处 / Esc 收起弹层（不拦点击：只用捕获阶段判断是否点在弹层或按钮里）
  document.addEventListener('mousedown', (e) => {
    if (!panelOpen) return;
    const el = panelEl();
    const target = e.target;
    if (!el || !target) return;
    if (el.contains(target) || (chip && chip.contains(target))) return;
    closeAgentPanel();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (panelOpen && e.key === 'Escape') { closeAgentPanel(); }
  });

  if ($('ap-enabled')) $('ap-enabled').addEventListener('change', () => toggleComputerUse());
  if ($('ap-full')) {
    $('ap-full').addEventListener('change', () => {
      const on = !!$('ap-full').checked;
      saveAuth(on
        ? { mode: AUTH_MODE.TRUST, scope: 'task', allowHighRisk: true }
        : { mode: AUTH_MODE.MANUAL, scope: 'task', allowHighRisk: false });
    });
  }
  if ($('ap-skipwrite')) {
    $('ap-skipwrite').addEventListener('change', () => {
      saveAgentField({ requireMedium: !$('ap-skipwrite').checked });
    });
  }
  if ($('btn-ap-pick')) $('btn-ap-pick').addEventListener('click', () => pickWorkspace());
  if ($('btn-ap-open')) $('btn-ap-open').addEventListener('click', () => openWorkspace());

  // 设备页的开关：和弹层主开关同一条路径
  if ($('btn-computer')) $('btn-computer').addEventListener('click', () => toggleComputerUse());
  // 设置页里的授权控件（和弹层共用同一份设置）
  if ($('ag-auth-mode')) {
    $('ag-auth-mode').addEventListener('change', () => {
      const mode = $('ag-auth-mode').value;
      saveAuth({ mode, scope: $('ag-auth-persist') && $('ag-auth-persist').checked ? 'persistent' : 'task' });
    });
  }
  if ($('ag-auth-persist')) {
    $('ag-auth-persist').addEventListener('change', () => {
      saveAuth({ scope: $('ag-auth-persist').checked ? 'persistent' : 'task' });
    });
  }
  if ($('ag-allow-high')) {
    $('ag-allow-high').addEventListener('change', () => saveAuth({ allowHighRisk: !!$('ag-allow-high').checked }));
  }
  if ($('ag-require-medium')) {
    $('ag-require-medium').addEventListener('change', () => saveAgentField({ requireMedium: !!$('ag-require-medium').checked }));
  }
  if ($('ag-auth-revoke')) {
    $('ag-auth-revoke').addEventListener('click', async () => {
      await saveAuth({ mode: AUTH_MODE.MANUAL, scope: 'task', allowHighRisk: false, revokedAt: Date.now() });
      toast(t('agent.revoked'));
    });
  }
  if ($('ag-workspace-edit')) {
    $('ag-workspace-edit').addEventListener('click', () => $('ag-workspace-box').classList.toggle('hidden'));
  }
  if ($('ag-workspace-save')) {
    $('ag-workspace-save').addEventListener('click', async () => {
      const value = ($('ag-workspace-input').value || '').trim();
      await saveAgentField({ workspace: value });
      $('ag-workspace-box').classList.add('hidden');
      toast(t('char.saved'));
    });
  }

  syncChip();
  renderPanel();
  restoreCheckpoint();
}
