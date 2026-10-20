// ============================================================
// AILEEN — 无边框悬浮展台渲染层
// 只做三件事：显示角色、上报交互热区、处理拖拽/缩放/隐藏
// 鼠标穿透由主进程按「热区 + 真实光标位置」判定，这里负责告知热区
// ============================================================
import { loadOml2d } from 'oh-my-live2d';
import { t, setLang } from './lib/i18n.js';
import { applyIcons, iconSvg } from './lib/icons.js';

const stageBox = document.getElementById('ov-stage');
// 悬浮 UI 容器：热区按这一整块算（收起时只有工具条那么大）
const ui = document.getElementById('ov-ui');
const tools = document.getElementById('ov-tools');
const grip = document.getElementById('ov-grip');
const lockBtn = document.getElementById('ov-lock');

let oml2d = null;
let overlayCfg = { scale: 0.45, opacity: 1 };
let currentModel = null;
let dragging = false;
let hovering = false;
let hideTimer = null;
let askedInteractive = null;

// ---------------- 交互热区 ----------------
/**
 * 热区 = 整个悬浮 UI 容器的矩形。
 * 收起面板时它就只剩工具条那么大（不会长期挡住桌面）；
 * 打开聊天/动作面板时它才会变大 —— 那是用户自己打开的区域，本来就该可点。
 */
function reportHitArea() {
  const box = ui || tools;
  const r = box.getBoundingClientRect();
  if (!r.width || !r.height) return false; // 还没排版，别上报全 0 热区
  window.api.overlaySetHitArea({ x: r.left, y: r.top, w: r.width, h: r.height });
  return true;
}

function overTools(x, y) {
  const box = ui || tools;
  const r = box.getBoundingClientRect();
  // 还没排版完（宽高为 0）时一律视为「不在把手上」，否则全 0 矩形会把整窗误判成可交互
  if (!r.width || !r.height) return false;
  const pad = 6; // 轻微外扩，保证不会碰到窗口边缘的系统缩放手柄
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

function showTools() {
  tools.classList.add('on');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!hovering && !dragging) tools.classList.remove('on');
  }, 2600);
}

function setInteractive(on) {
  if (askedInteractive === on) return;
  askedInteractive = on;
  window.api.overlaySetIgnore(!on);
}

document.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const inside = overTools(e.clientX, e.clientY);
  hovering = inside;
  if (inside) { showTools(); setInteractive(true); }
  else setInteractive(false);
});
document.addEventListener('mouseleave', () => { hovering = false; setInteractive(false); });
window.addEventListener('blur', () => setInteractive(false));

// ---------------- 拖拽移动 ----------------
grip.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  dragging = true;
  showTools();
  try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  await window.api.overlayDragStart();
});
grip.addEventListener('pointermove', () => { if (dragging) window.api.overlayDragMove(); });
async function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  await window.api.overlayDragEnd();
  showTools();
}
grip.addEventListener('pointerup', endDrag);
grip.addEventListener('pointercancel', endDrag);

// ---------------- 工具按钮 ----------------
document.getElementById('ov-smaller').onclick = () => { window.api.overlayResize({ dw: -40, dh: -64 }); showTools(); };
document.getElementById('ov-bigger').onclick = () => { window.api.overlayResize({ dw: 40, dh: 64 }); showTools(); };
lockBtn.onclick = async () => {
  const on = !lockBtn.classList.contains('on');
  lockBtn.classList.toggle('on', on);
  lockBtn.innerHTML = iconSvg(on ? 'lock' : 'pointer', 14);
  lockBtn.title = on ? t('overlay.lockOn') : t('overlay.lockOff');
  await window.api.overlaySetInteractive(on);
  showTools();
};
document.getElementById('ov-hide').onclick = () => window.api.overlayHide();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.overlayHide(); });

// ---------------- Live2D ----------------
function destroyStage() {
  if (oml2d) {
    try { if (oml2d.pixiApp) oml2d.pixiApp.destroy(true); } catch (err) { /* ignore */ }
    oml2d = null;
  }
  stageBox.innerHTML = '';
}

// oml2d 建 Pixi 应用时舞台元素还没插进文档，量到的是 0x0，于是绘制缓冲就是空的
// （之后它只在 window resize 时才会重新量）。所以挂载完必须主动让它重量一次尺寸。
// 只调 Pixi 渲染器；模型的位置/缩放必须在「模型真的加载完」之后才能碰，
// 否则库内部的 this.model.x = ... 会打在 undefined 上，把整条加载链打断。
function syncStageSize(adjustModel) {
  try {
    const app = oml2d && oml2d.pixiApp;
    const w = stageBox.clientWidth;
    const h = stageBox.clientHeight;
    if (!app || !w || !h) return false;
    if (typeof app.resize === 'function') app.resize();
    if (adjustModel && oml2d.models && oml2d.models.model) {
      // 模型加载时舞台还是 0 尺寸，位置/缩放都是按那个算的 —— 必须重算一次
      if (typeof oml2d.setModelScale === 'function') oml2d.setModelScale(overlayCfg.scale || 0.45);
      if (typeof oml2d.setModelPosition === 'function') oml2d.setModelPosition({ x: w / 2, y: h * 0.55 });
    }
    return true;
  } catch (err) { return false; }
}

// 舞台样式：库默认是 position:fixed + 滑入动画，会盖住整屏；这里钉在容器内。
const STAGE_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  transform: 'none',
  zIndex: 1,
};

function renderStage(model) {
  destroyStage();
  currentModel = model;
  if (!model || !model.url) {
    stageBox.innerHTML = '<div class="ov-empty">' + t('overlay.empty') + '</div>';
    return;
  }
  const W = window.innerWidth;
  const H = window.innerHeight;
  oml2d = loadOml2d({
    parentElement: stageBox,
    primaryColor: '#ff7eb3',
    // oh-my-live2d 判断「是不是手机」用的是 matchMedia('screen and (max-width: 768px)') ——
    // 那是**窗口宽度**，不是屏幕宽度。展台窗口天生就窄（400~600px），于是永远被当成手机：
    // 而它在手机模式下 mobileDisplay 默认 false，会直接跳过整个模型加载（stageChildren=0），
    // 同时只认 mobileStageStyle、把我们给的 stageStyle 丢掉 —— 两条加起来就是「展台一片空白」。
    mobileDisplay: true,
    dockedPosition: 'right',
    transitionTime: 300,
    sayHello: false,
    menus: { disable: true },
    statusBar: { disable: true },
    tips: { idleTips: { message: ['……'], interval: 600000, duration: 2000 } },
    models: [{
      name: model.name || 'model',
      path: model.url,
      scale: overlayCfg.scale || 0.45,
      anchor: [0.5, 0.5],
      position: [W / 2, H * 0.55],
      motionPreloadStrategy: 'IDLE',
      stageStyle: STAGE_STYLE,
      mobileStageStyle: STAGE_STYLE,   // 窗口一窄就会被判成 mobile，这条必须同样给
    }],
    stageStyle: STAGE_STYLE,           // 全局兜底：两条分支都会合并它
  });
  if (oml2d && typeof oml2d.onLoad === 'function') {
    oml2d.onLoad((status) => { syncStageSize(status === 'success'); });
  }
  if (oml2d && typeof oml2d.then === 'function') oml2d.catch(() => { /* 失败静默 */ });
  // 立刻对一次尺寸，滑入动画（300ms）结束后再对一次，防止中途被重置
  syncStageSize(false);
  setTimeout(() => syncStageSize(false), 120);
  setTimeout(() => syncStageSize(false), 520);
}

// ---------------- 启动 ----------------
/** 展台与主窗口共享外观：跟随主窗口的主题模式（跟随系统时自己再判断一次） */
let overlayThemeApplied = 'light';
function applyOverlayAppearance(appearance) {
  const app = appearance || {};
  let mode = app.mode || 'light';
  if (mode === 'system') {
    try { mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (err) { mode = 'light'; }
  }
  overlayThemeApplied = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', overlayThemeApplied);
  document.documentElement.setAttribute('data-reduce-motion', app.reduceMotion ? 'true' : 'false');
}

async function init() {
  const st = await window.api.overlayGetState();
  if (st && st.language) setLang(st.language);
  applyOverlayAppearance(st && st.appearance);
  overlayCfg = Object.assign(overlayCfg, (st && st.overlay) || {});
  stageBox.style.opacity = String(overlayCfg.opacity || 1);
  const lockOn = !!(st && st.overlay && st.overlay.interactive);
  lockBtn.classList.toggle('on', lockOn);
  lockBtn.innerHTML = iconSvg(lockOn ? 'lock' : 'pointer', 14);
  // 图标：i18n 落位之后再补图形（顺序和主窗口一致）
  applyIcons();
  renderStage(st && st.model);
  reportHitArea();
  showTools();
  // 问主窗口要一份完整快照（它才是会话所有者）
  try { await window.api.overlayRequest({ type: 'sync' }); } catch (err) { /* 主窗口没开就算了 */ }
}

// 自检钩子：主进程要能问出「展台到底有没有把模型画出来」（这里没有日志通道，只能主动问）
// 展台的报错只在自己控制台里，收进数组供自检读出（否则「模型出不来」永远查不出原因）
window.__AILEEN_REJECTS = [];
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  if (window.__AILEEN_REJECTS.length < 5) window.__AILEEN_REJECTS.push(String((r && r.stack) || r));
});

// 轻量就绪问询：模型加载是异步的，自检要轮询这个，而不是固定等待
window.__AILEEN_OVERLAY_READY = () => {
  try {
    return !!(oml2d && oml2d.models && oml2d.models.model && oml2d.models.model.internalModel);
  } catch (err) { return false; }
};

window.__AILEEN_OVERLAY_PROBE = () => {
  const app = oml2d && oml2d.pixiApp;
  const canvas = document.querySelector('#ov-stage canvas');
  return {
    hasInstance: !!oml2d,
    themeApplied: overlayThemeApplied,
    themeAttr: document.documentElement.getAttribute('data-theme'),
    hasPixiApp: !!app,
    rendererSize: app && app.app && app.app.renderer ? [app.app.renderer.width, app.app.renderer.height] : null,
    canvasAttr: canvas ? [canvas.width, canvas.height] : null,
    canvasCss: canvas ? [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)] : null,
    stageRect: (function () { const s = document.getElementById('oml2d-stage'); if (!s) return null; const r = s.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    synced: syncStageSize(),
    hasModel: !!currentModel,
    rejects: window.__AILEEN_REJECTS.slice(0, 4),
    mqMobile: window.matchMedia('screen and (max-width: 768px)').matches,
    screenSize: [window.screen.width, window.screen.height],
    innerSize: [window.innerWidth, window.innerHeight],
    modelUrl: currentModel ? currentModel.url : null,
    stageChildren: app && app.app && app.app.stage ? app.app.stage.children.length : null,
    renderedOk: (function () {
      try {
        const r = app.app.renderer;
        const gl = r.gl;
        if (!gl) return false;
        const W = gl.drawingBufferWidth;
        const H = gl.drawingBufferHeight;
        r.render(app.app.stage);
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 3; i < px.length; i += 4 * 97) { if (px[i] > 8) n += 1; }
        return n > 20;
      } catch (e) { return 'err:' + e.message; }
    })(),
    modelTransform: (function () {
      try {
        const kids = app.app.stage.children;
        if (!kids || !kids.length) return null;
        const m = kids[0];
        return { x: Math.round(m.x), y: Math.round(m.y), sx: Number(m.scale.x.toFixed(3)), alpha: m.alpha, visible: m.visible, w: Math.round(m.width), h: Math.round(m.height) };
      } catch (e) { return 'err:' + e.message; }
    })(),
    status: (function () { try { return oml2d && oml2d.models && oml2d.models.model && oml2d.models.model.internalModel ? 'internalModel-ok' : 'no-internalModel'; } catch (e) { return 'err:' + e.message; } })(),
    fb: (function () {
      try {
        const r = app.app.renderer;
        const gl = r.gl;
        if (!gl) return 'no-gl';
        const W = gl.drawingBufferWidth;
        const H = gl.drawingBufferHeight;
        // 必须先同步渲染一帧再读：默认的绘制缓冲不保留，呈现之后再 readPixels 只会读到全 0
        r.render(app.app.stage);
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let nonzero = 0;
        for (let i = 3; i < px.length; i += 4 * 97) { if (px[i] > 8) nonzero += 1; }
        return { drawBuf: [W, H], sampled: Math.floor(px.length / (4 * 97)), nonzero };
      } catch (e) { return 'err:' + e.message; }
    })(),
    emptyHint: !!document.querySelector('.ov-empty'),
  };
};

// ============================================================
// 小聊天面板 / 状态提示 / 动作表情（0.8 双窗口）
//
// 分工很清楚：
//   · **主窗口是会话的唯一所有者**，这里只负责显示最近几条 + 把输入转交过去；
//   · 动作/表情在展台本地执行（模型就在这个窗口里，不必绕一圈）；
//   · 换模型要通知主窗口（模型列表与角色绑定都在那边），再走 overlay:model 回来。
// ============================================================
const chatPanel = document.getElementById('ov-chat');
const morePanel = document.getElementById('ov-more');
const msgsBox = document.getElementById('ov-msgs');
const inputEl = document.getElementById('ov-input');
const statusEl = document.getElementById('ov-status');
const micBtn = document.getElementById('ov-mic');
const charLabel = document.getElementById('ov-char');
const modelSelect = document.getElementById('ov-models');

let voiceOn = false;
let busy = false;
let agentLabel = '';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

/** 只画最近几条；内容只当纯文本（绝不用 innerHTML，避免把消息里的 HTML 执行进来） */
function renderMessages(list) {
  if (!msgsBox) return;
  msgsBox.innerHTML = '';
  const recent = (Array.isArray(list) ? list : []).slice(-6);
  if (!recent.length) {
    msgsBox.appendChild(el('div', 'ov-msg assistant', t('overlay.statusIdle')));
  } else {
    for (const m of recent) {
      msgsBox.appendChild(el('div', 'ov-msg ' + (m.role === 'user' ? 'user' : 'assistant'), String(m.text || '').slice(0, 600)));
    }
  }
  if (busy) msgsBox.appendChild(el('div', 'ov-msg thinking', t('overlay.statusThinking')));
  msgsBox.scrollTop = msgsBox.scrollHeight;
}

function setStatus(st) {
  if (!statusEl) return;
  const s = st || {};
  busy = !!s.busy;
  voiceOn = !!s.voice;
  agentLabel = String(s.label || '');
  const label = agentLabel || (voiceOn ? t('overlay.statusListening') : (busy ? t('overlay.statusThinking') : t('overlay.statusIdle')));
  const idle = !busy && !voiceOn && (!s.agent || s.agent === 'idle');
  statusEl.textContent = label;
  statusEl.className = 'ov-status'
    + (idle ? ' hidden' : '')
    + (s.agent === 'waiting_approval' ? ' approval' : '')
    + (voiceOn ? ' listening' : '')
    + (busy && s.agent !== 'waiting_approval' ? ' busy' : '');
  if (micBtn) micBtn.classList.toggle('on', voiceOn);
  reportHitArea();
}

function togglePanel(node) {
  if (!node) return;
  const willShow = node.classList.contains('hidden');
  for (const p of [chatPanel, morePanel]) if (p && p !== node) p.classList.add('hidden');
  node.classList.toggle('hidden', !willShow);
  if (willShow && node === morePanel) renderMore();
  reportHitArea();
  showTools();
}

/** 动作/表情 chip：打开面板时才去问模型，避免模型没加载好就崩 */
function renderMore() {
  const model = oml2d && oml2d.models && oml2d.models.model;
  const motionBox = document.getElementById('ov-motions');
  const exprBox = document.getElementById('ov-exprs');
  if (motionBox) {
    motionBox.innerHTML = '';
    let groups = [];
    try { groups = Object.keys((model && model.internalModel.motionManager.motionGroups) || {}); } catch (err) { groups = []; }
    if (!groups.length) motionBox.appendChild(el('span', 'ov-muted', t('overlay.none')));
    for (const g of groups.slice(0, 12)) {
      const b = el('button', null, g);
      b.onclick = () => { try { model.motion(g); } catch (err) { /* 忽略 */ } };
      motionBox.appendChild(b);
    }
  }
  if (exprBox) {
    exprBox.innerHTML = '';
    let defs = [];
    try {
      defs = ((model && model.internalModel.motionManager.expressionManager
        && model.internalModel.motionManager.expressionManager.definitions) || []).map((d) => d.name);
    } catch (err) { defs = []; }
    if (!defs.length) exprBox.appendChild(el('span', 'ov-muted', t('overlay.none')));
    for (const name of defs.slice(0, 12)) {
      const b = el('button', null, name);
      b.onclick = () => { try { model.expression(name); } catch (err) { /* 忽略 */ } };
      exprBox.appendChild(b);
    }
  }
  reportHitArea();
}

if (chatPanel) {
  document.getElementById('ov-chat-toggle').onclick = () => togglePanel(chatPanel);
  document.getElementById('ov-chat-close').onclick = () => { chatPanel.classList.add('hidden'); reportHitArea(); };
}
if (morePanel) {
  document.getElementById('ov-more-toggle').onclick = () => togglePanel(morePanel);
}
if (inputEl) {
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}
if (document.getElementById('ov-send')) document.getElementById('ov-send').onclick = sendChat;
if (micBtn) {
  micBtn.onclick = () => {
    // 语音循环在主窗口里（STT/TTS 都在那边），这里只是开关 + 状态显示
    window.api.overlayRequest({ type: 'voice' });
    showTools();
  };
}
if (document.getElementById('ov-open-main')) {
  document.getElementById('ov-open-main').onclick = () => window.api.overlayOpenMain();
}
if (document.getElementById('ov-main-btn')) {
  document.getElementById('ov-main-btn').onclick = () => window.api.overlayOpenMain();
}
if (modelSelect) {
  modelSelect.onchange = () => window.api.overlayRequest({ type: 'model', index: Number(modelSelect.value) || 0 });
}
if (document.getElementById('ov-scale')) {
  document.getElementById('ov-scale').value = String(overlayCfg.scale || 0.45);
  document.getElementById('ov-scale').oninput = (e) => {
    const v = Number(e.target.value) || 0.45;
    overlayCfg.scale = v;
    try { if (oml2d && typeof oml2d.setModelScale === 'function') oml2d.setModelScale(v); } catch (err) { /* 忽略 */ }
    syncStageSize(false);
  };
}

function sendChat() {
  if (!inputEl) return;
  const text = String(inputEl.value || '').trim();
  if (!text) return;
  inputEl.value = '';
  window.api.overlayRequest({ type: 'chat', text });
  showTools();
}

// 主窗口广播过来的会话（只读展示）
if (typeof window.api.onOverlaySession === 'function') {
  window.api.onOverlaySession((s) => {
    if (!s || !s.type) return;
    if (s.type === 'messages') renderMessages(s.messages);
    else if (s.type === 'status') setStatus(s.status);
    else if (s.type === 'character') {
      const name = (s.character && s.character.name) || 'AILEEN';
      if (charLabel) charLabel.textContent = name;
    } else if (s.type === 'models') {
      if (!modelSelect) return;
      modelSelect.innerHTML = '';
      (s.models || []).forEach((m, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = String(m && m.name ? m.name : '#' + i);
        modelSelect.appendChild(opt);
      });
    } else if (s.type === 'motion') {
      // 主窗口（角色回复里的动作标记、Agent 状态演出）遥控展台的动作
      if (currentModel && s.name) { try { currentModel.motion(String(s.name)); } catch (err) { /* 模型不认这个名字 */ } }
    } else if (s.type === 'expression') {
      if (currentModel && s.name) { try { currentModel.expression(String(s.name)); } catch (err) { /* 同上 */ } }
    } else if (s.type === 'scale') {
      const v = Number(s.value);
      if (Number.isFinite(v)) {
        overlayCfg.scale = v;
        try { if (oml2d && typeof oml2d.setModelScale === 'function') oml2d.setModelScale(v); } catch (err) { /* 忽略 */ }
        const sc = document.getElementById('ov-scale');
        if (sc) sc.value = String(v);
        syncStageSize(false);
      }
    }
    reportHitArea();
  });
}

// 自检钩子：把悬浮面板摆出来（截图核对排版用；正常运行不会调用）
window.__AILEEN_OVERLAY_PANEL = (name) => {
  try {
    showTools();
    if (name === 'chat') {
      renderMessages([
        { role: 'user', text: '帮我看看这个报错' },
        { role: 'assistant', text: '好，我先看下堆栈，稍等。' },
      ]);
      setStatus({ busy: true, voice: true, agent: 'idle', label: '' });
      togglePanel(chatPanel);
      if (chatPanel) chatPanel.classList.remove('hidden');
    } else if (name === 'more') {
      if (morePanel) morePanel.classList.remove('hidden');
      renderMore();
    }
    reportHitArea();
    // 返回几何信息：自检会把它写进报告，排版不对时不用靠猜
    const r = (node) => { if (!node) return null; const b = node.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    return { chat: chatPanel ? chatPanel.className : null, chatRect: r(chatPanel), moreRect: r(morePanel), uiRect: r(ui), toolsRect: r(tools) };
  } catch (err) { return { error: String((err && err.message) || err) }; }
};

window.api.onOverlayModel((m) => renderStage(m));
window.addEventListener('resize', () => {
  reportHitArea();
  if (currentModel) renderStage(currentModel);
});
window.addEventListener('load', reportHitArea);
setTimeout(reportHitArea, 400);

init().catch((err) => console.error('[overlay] init failed', err));
