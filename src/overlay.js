// ============================================================
// AILEEN — 无边框悬浮展台渲染层
// 只做三件事：显示角色、上报交互热区、处理拖拽/缩放/隐藏
// 鼠标穿透由主进程按「热区 + 真实光标位置」判定，这里负责告知热区
// ============================================================
import { loadOml2d } from 'oh-my-live2d';
import { t, setLang } from './lib/i18n.js';
import { applyIcons, iconSvg } from './lib/icons.js';
import { createDragCoalescer } from './lib/drag-coalescer.js';

const stageBox = document.getElementById('ov-stage');
// 悬浮 UI 容器：热区按这一整块算（收起时只有工具条那么大）
const ui = document.getElementById('ov-ui');
const tools = document.getElementById('ov-tools');
const grip = document.getElementById('ov-grip');
const lockBtn = document.getElementById('ov-lock');

let oml2d = null;
let overlayCfg = { scale: 0.15, opacity: 1 };
let currentModel = null;
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
    if (!hovering && !dragActive) tools.classList.remove('on');
  }, 2600);
}

function setInteractive(on) {
  if (askedInteractive === on) return;
  askedInteractive = on;
  window.api.overlaySetIgnore(!on);
}

document.addEventListener('mousemove', (e) => {
  if (dragActive) return;
  const inside = overTools(e.clientX, e.clientY);
  hovering = inside;
  if (inside) { showTools(); setInteractive(true); }
  else setInteractive(false);
});
document.addEventListener('mouseleave', () => { hovering = false; setInteractive(false); });
window.addEventListener('blur', () => setInteractive(false));

// ---------------- 拖拽移动 ----------------
// 拖动这件事以前有三个坑（真机表现：越拖越卡、松开后窗口还在飘、偶尔尺寸乱跳）：
//   1. `pointermove` / `pointerup` 的监听器是**在 pointerdown 里**addEventListener 的，
//      每拖一次就多一份 —— 拖到第三次，鼠标一动就是 3 个 IPC；
//   2. 每个 pointermove 直接发一个 IPC，不限并发，消息排队越来越长；
//   3. 结束时不作废待发的东西，松手之后队列里的旧位置还在应用。
// 现在：监听器只绑一次 + 用 rAF 合并 + 同一时刻只有一个 IPC 在途 + 结束即作废。
const dragCoalescer = createDragCoalescer({ call: () => window.api.overlayDragMove() });
let dragActive = false;
let dragPointerId = null;
let dragEndCalls = 0;
let dragMoveEvents = 0;

function beginDrag(e) {
  if (dragActive) return;
  e.preventDefault();
  dragActive = true;
  dragPointerId = e.pointerId;
  dragCoalescer.start();
  showTools();
  try { grip.setPointerCapture(e.pointerId); } catch (err) { /* 没有捕获也能拖 */ }
  // 先置位再等主进程：pointermove 可能在这之前就到，丢了第一下会「拖不动」
  Promise.resolve(window.api.overlayDragStart()).catch(() => { /* 窗口可能已经销毁 */ });
}

function onDragMove() {
  if (!dragActive) return;
  dragMoveEvents += 1;
  dragCoalescer.request();
}

function endDrag() {
  if (!dragActive) return;
  dragActive = false;
  dragEndCalls += 1;
  // 先作废待发的帧/排队标记：这样松手之后不会再多写一个旧位置
  dragCoalescer.end();
  if (dragPointerId !== null) {
    try { grip.releasePointerCapture(dragPointerId); } catch (err) { /* ignore */ }
    dragPointerId = null;
  }
  Promise.resolve(window.api.overlayDragEnd()).catch(() => { /* ignore */ });
  showTools();
}

// 监听器只在这里绑**一次**（以前在 pointerdown 里重复绑，导致 IPC 越拖越多）
grip.addEventListener('pointerdown', beginDrag);
grip.addEventListener('pointermove', onDragMove);
grip.addEventListener('pointerup', endDrag);
grip.addEventListener('pointercancel', endDrag);
grip.addEventListener('lostpointercapture', () => { if (dragActive) endDrag(); });

/** 自检用：这一轮的拖动状态与 IPC 次数（不返回 DOM） */
window.__AILEEN_OVERLAY_DRAG_STATS = () => Object.assign({
  active: dragActive,
  endCalls: dragEndCalls,
  moveEvents: dragMoveEvents,
}, dragCoalescer.stats());
/** 主进程的超时兜底会来问一句「人是不是还按着把手」 */
window.__AILEEN_OVERLAY_DRAGGING = () => dragActive;

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
/** 模型挂上舞台的时机不固定（冷启动 / 大模型更慢），用轮询等它出现 */
let fitPollTimer = null;
function stopFitPoll() {
  if (fitPollTimer) { clearInterval(fitPollTimer); fitPollTimer = null; }
}

// 自检用：真正「重建模型」的次数（模型连续性就靠它验证）
let overlayRenderCount = 0;

function destroyStage() {
  stopFitPoll();
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
      applyModelSize(w, h);
      if (typeof oml2d.setModelPosition === 'function') oml2d.setModelPosition({ x: w / 2, y: h * 0.55 });
    }
    return true;
  } catch (err) { return false; }
}

/**
 * 应用模型缩放，并且**保证模型装得进窗口**。
 *
 * 库里的 `scale` 是绝对的 PIXI 缩放（默认 0.1）；0.45 这种值会让模型比窗口大好几倍，
 * 溢出窗口的部分直接被裁掉（用户看到的就是「模型占满整个屏幕、手出了边界看不见」）。
 * 所以这里做两步：先用用户给的比例，再按模型**当前实际渲染尺寸**算一个「装得下」的上限，
 * 取两者较小值 —— 只缩小、不放大，用户的偏好仍然优先。
 *
 * 注意：不能拿 `oml2d.models.model` 量尺寸（它是库里的 Model 包装，没有 getBounds）；
 * 真正的显示对象挂在 `pixiApp.app.stage.children` 上，取其中面积最大的那个。
 */
function findModelDisplayObject() {
  try {
    const stage = oml2d && oml2d.pixiApp && oml2d.pixiApp.app && oml2d.pixiApp.app.stage;
    const kids = stage && stage.children ? stage.children : null;
    if (!kids || !kids.length) return null;
    let best = null;
    for (const k of kids) {
      if (!k || typeof k.getBounds !== 'function' || k.visible === false) continue;
      let b = null;
      try { b = k.getBounds(); } catch (err) { b = null; }
      if (!b || !(b.width > 0) || !(b.height > 0)) continue;
      const area = b.width * b.height;
      if (!best || area > best.area) best = { area, bounds: b };
    }
    return best ? best.bounds : null;
  } catch (err) {
    return null;
  }
}

function applyModelSize(stageW, stageH) {
  if (!oml2d || typeof oml2d.setModelScale !== 'function') return;
  const want = Number(overlayCfg.scale) || 0.15;
  let next = want;
  try {
    if (stageW > 0 && stageH > 0) {
      oml2d.setModelScale(want);
      const b = findModelDisplayObject();
      if (b) {
        // 留一点余量：模型边缘的头发/手别贴着窗口线
        const fit = Math.min((stageW * 0.96) / b.width, (stageH * 0.96) / b.height);
        if (Number.isFinite(fit) && fit > 0 && fit < 1) next = Math.max(0.02, want * fit);
      }
    }
  } catch (err) { next = want; }
  // 调试快照：自检要能看出「想用的比例 / 量到的尺寸 / 最终比例」
  window.__AILEEN_FIT_DEBUG = {
    want,
    next,
    stage: [stageW, stageH],
    measured: (function () { try { const b = findModelDisplayObject(); return b ? [Math.round(b.width), Math.round(b.height)] : null; } catch (err) { return null; } })(),
  };
  oml2d.setModelScale(next);
  const slider = document.getElementById('ov-scale');
  if (slider && document.activeElement !== slider) slider.value = String(next.toFixed(2));
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
  // 记下这次用的是哪套布局分支（手机 / 桌面）；只有分支真的变了才值得重建
  try { stageLayoutBranch = window.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop'; } catch (err) { stageLayoutBranch = 'desktop'; }
  if (!model || !model.url) {
    stageBox.innerHTML = '<div class="ov-empty">' + t('overlay.empty') + '</div>';
    return;
  }
  overlayRenderCount += 1;
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
      scale: overlayCfg.scale || 0.15,
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
  // onLoad 有时比「模型真的挂到舞台上」早一步（冷启动、大模型更明显），那时量不到对象，
  // 缩放适配会落空 —— 表现为「模型比窗口大、手出了边界看不见」。所以轮询到量出来为止（最多 20 秒）。
  stopFitPoll();
  let fitTries = 0;
  fitPollTimer = setInterval(() => {
    fitTries += 1;
    if (!oml2d || currentModel !== model) { stopFitPoll(); return; }
    syncStageSize(true);
    const dbg = window.__AILEEN_FIT_DEBUG;
    if ((dbg && dbg.measured) || fitTries >= 50) stopFitPoll();
  }, 400);
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
    fitDebug: window.__AILEEN_FIT_DEBUG || null,
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
  document.getElementById('ov-scale').value = String(overlayCfg.scale || 0.15);
  document.getElementById('ov-scale').oninput = (e) => {
    const v = Number(e.target.value) || 0.15;
    overlayCfg.scale = v;
    // 走同一个入口：用户在面板里拉大也会被「装得进窗口」的上限拦住
    applyModelSize(stageBox.clientWidth, stageBox.clientHeight);
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
        applyModelSize(stageBox.clientWidth, stageBox.clientHeight);
        const sc = document.getElementById('ov-scale');
        if (sc) sc.value = String(v);
        reportHitArea();
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
// 自检：模型被重建了几次 / 现在有没有模型（用来验证「改尺寸不重置模型」）
window.__AILEEN_OVERLAY_STAGE_INFO = () => ({ renders: overlayRenderCount, hasModel: !!currentModel });

// 窗口尺寸变了：**只重新对一次画布尺寸 + 模型位置/缩放，绝不重建模型**。
// 以前这里是 `renderStage(currentModel)` —— 等于每改一次尺寸、每次跨屏 DPI 变化、
// 甚至拖动结束的窗口重排，都把角色重新加载一遍：动作、表情、口型全断，
// 用户看到的就是「每次移动位置模型都会重置」。
// 只有「手机布局 ↔ 桌面布局」这种结构分支真的变了（库按 matchMedia 选了另一套 stageStyle）
// 才必须重建。
let stageLayoutBranch = null;
function stageLayoutBranchName() {
  try { return window.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop'; } catch (err) { return 'desktop'; }
}
let stageResizeTimer = null;
window.addEventListener('resize', () => {
  reportHitArea();
  if (!currentModel) return;
  const branch = stageLayoutBranchName();
  if (stageLayoutBranch && branch !== stageLayoutBranch) {
    renderStage(currentModel);
    return;
  }
  stageLayoutBranch = branch;
  if (stageResizeTimer) clearTimeout(stageResizeTimer);
  stageResizeTimer = setTimeout(() => {
    stageResizeTimer = null;
    syncStageSize(true);
  }, 60);
});
window.addEventListener('load', reportHitArea);
setTimeout(reportHitArea, 400);

init().catch((err) => console.error('[overlay] init failed', err));
