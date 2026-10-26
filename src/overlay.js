// ============================================================
// AILEEN — 无边框悬浮展台渲染层
// 只做三件事：显示角色、上报交互热区、处理拖拽/缩放/隐藏
// 鼠标穿透由主进程按「热区 + 真实光标位置」判定，这里负责告知热区
// ============================================================
import { Application, extensions } from 'pixi.js';
import { Live2DModel, Live2DPlugin, MotionPriority, configureCubismSDK } from 'untitled-pixi-live2d-engine/cubism';
import { t, setLang } from './lib/i18n.js';
import { applyIcons, iconSvg } from './lib/icons.js';
import { createDragCoalescer } from './lib/drag-coalescer.js';
import { createLive2DController } from './lib/live2d/controller.js';
import { fitTransform, clampFill } from './lib/live2d/fit.js';

const stageBox = document.getElementById('ov-stage');
// 悬浮 UI 容器：热区按这一整块算（收起时只有工具条那么大）
const ui = document.getElementById('ov-ui');
const tools = document.getElementById('ov-tools');
const grip = document.getElementById('ov-grip');
const lockBtn = document.getElementById('ov-lock');

// 渲染引擎注册：必须在创建 renderer 之前执行一次（WebGL render pipe）
extensions.add(Live2DPlugin);
// Cubism 的工作内存默认 16MB，模型复杂/多模型时会不够（表现是模型停在上一帧不动）
try { configureCubismSDK({ memorySizeMB: 48 }); } catch (err) { /* 老核心没有这个接口就算了 */ }

let pixiApp = null;          // PIXI.Application（每个展台窗口一个）
let modelObj = null;         // Live2DModel 真身；currentModel 只是「数据」（url/name）
let stageGen = 0;            // 加载代际：旧模型的异步回调不许覆盖新模型
let idleTimer = null;        // 待机动作定时器
let mouthIncoming = 0;       // 主窗口送来的音量包络（0..1）
let mouthLevel = 0;          // 平滑之后的嘴部开合
let mouthPeak = 0;           // 自检用：这一轮驱动到过的最大开合
let drawnBox = null;         // 最近一次量到的「角色真的占了多少」（CSS 像素）
let overlayCfg = { scale: 0.15, opacity: 1 };
// 精细控制（来自 settings.live2d）：渲染层只读不改，改动一律走设置页/IPC
let hq = {
  fit: 0.95, zoom: 1, offsetY: 0,
  lipsync: true, lipsyncGain: 1.2,
  idleMotion: true, idleInterval: 14,
  focusFollow: true, physics: true,  quality: 'auto', fps: 60, lod: 'auto', mask: 'auto',
};
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

// ---------------- 右下角拖角改大小 ----------------
// 原生 resizable 是关掉的（和鼠标穿透/焦点打架），所以「用鼠标拖边框改大小」走渲染层把手：
// 拖 `#ov-resize` → 换算成绝对宽高 → 交给主进程的 clampOverlaySize + setBounds（和 −/＋ 同一个入口）。
// 高频 pointermove 用 rAF 合并 + 同一时刻只发一个（和拖动位置那套一样的道理）。
const resizeGrip = document.getElementById('ov-resize');
let resizeDrag = null;
let resizeRaf = 0;
let resizeInFlight = false;
let resizeWant = null;
let resizeCalls = 0;

function sendResizeNow() {
  resizeRaf = 0;
  const want = resizeWant;
  resizeWant = null;
  if (!want || resizeInFlight) return;
  resizeInFlight = true;
  resizeCalls += 1;
  Promise.resolve(window.api.overlayResizeTo(want))
    .catch(() => { /* 窗口可能已经销毁 */ })
    .then(() => {
      resizeInFlight = false;
      if (resizeWant) sendResizeNow();
    });
}

function queueResize(width, height) {
  resizeWant = {
    width: Math.max(160, Math.round(width)),
    height: Math.max(200, Math.round(height)),
  };
  if (!resizeRaf) resizeRaf = requestAnimationFrame(sendResizeNow);
}

if (resizeGrip) {
  resizeGrip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (resizeDrag) return;
    resizeDrag = {
      id: e.pointerId,
      w0: window.innerWidth,
      h0: window.innerHeight,
      x0: e.screenX,
      y0: e.screenY,
      last: { w: window.innerWidth, h: window.innerHeight },
    };
    showTools();
    try { resizeGrip.setPointerCapture(e.pointerId); } catch (err) { /* 没捕获也能拖 */ }
  });
  resizeGrip.addEventListener('pointermove', (e) => {
    if (!resizeDrag || e.pointerId !== resizeDrag.id) return;
    const w = resizeDrag.w0 + (e.screenX - resizeDrag.x0);
    const h = resizeDrag.h0 + (e.screenY - resizeDrag.y0);
    resizeDrag.last = { w, h };
    queueResize(w, h);
  });
  const endResize = (e) => {
    if (!resizeDrag || (e && e.pointerId !== undefined && e.pointerId !== resizeDrag.id)) return;
    const d = resizeDrag;
    resizeDrag = null;
    try { resizeGrip.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
    // 松手补一次最终尺寸（防止最后一帧还没发出去）
    if (d.last) queueResize(d.last.w, d.last.h);
    setTimeout(() => { reportHitArea(); syncStageSize(true); }, 60);
    showTools();
  };
  resizeGrip.addEventListener('pointerup', endResize);
  resizeGrip.addEventListener('pointercancel', endResize);
  resizeGrip.addEventListener('lostpointercapture', () => { if (resizeDrag) endResize(null); });
}

/** 自检：拖角改大小的调用次数（确认高频移动被合并了） */
window.__AILEEN_OVERLAY_RESIZE_STATS = () => ({ active: !!resizeDrag, calls: resizeCalls });

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

// ---------------- Live2D（PixiJS v8 + untitled-pixi-live2d-engine） ----------------
// 为什么换引擎：oh-my-live2d 封装的 pixi-live2d-display 是 PIXI v7 时代的东西，
// 没有音频口型、没有平行动作、没有纹理 LOD，模型缩放还是「绝对 PIXI scale」——
// 之前那批「模型占满窗口 / 手出边界 / 大小怎么调都不对」的坑，一半是从那儿来的。
//
// 现在这套（MIT）：
//   · 位置/缩放是正常的 Container 语义（anchor + scale），按**可见绘制区域**适配；
//   · 口型同步（主窗口把 TTS 音量包络送进来，见 overlay:mouth）；
//   · 待机动作自动播、平行动作、末帧冻结、纹理 LOD、自动高精度遮罩；
//   · Cubism 2/3/4/5 模型都能吃（Core 是 Live2D 官方可再分发的 live2dcubismcore.min.js）。

// 自检用：真正「重建模型」的次数（模型连续性就靠它验证）
let overlayRenderCount = 0;

/** 渲染倍率：auto = 跟随屏幕 DPR（最多 2x），其余是固定倍率 */
function stageResolution() {
  const dpr = Number(window.devicePixelRatio) || 1;
  if (hq.quality === '1') return 1;
  if (hq.quality === '1.5') return 1.5;
  if (hq.quality === '2') return 2;
  return Math.min(2, Math.max(1, dpr));
}

/** 纹理 LOD：auto 按实际屏幕尺寸降采样（4096 大图集省显存），full 原始，off 关掉 */
function textureLODOption() {
  if (hq.lod === 'off') return false;
  if (hq.lod === 'full') return 'full';
  return 'single-auto';
}

function pushStageError(what, err) {
  const msg = String((err && (err.stack || err.message)) || err);
  if (window.__AILEEN_REJECTS.length < 8) window.__AILEEN_REJECTS.push(what + ': ' + msg);
}

function stopIdleMotion() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function destroyStage() {
  stopIdleMotion();
  // 代际 +1：正在加载的旧模型回来时会被丢掉，不会把新模型盖掉
  stageGen += 1;
  modelObj = null;
  if (pixiApp) {
    try { pixiApp.destroy(true, { children: true, texture: true, textureSource: true }); }
    catch (err) { /* 已经销毁过 */ }
    pixiApp = null;
  }
  stageBox.innerHTML = '';
}

// 画布尺寸/模型位置：窗口变了只重排，**绝不重建模型**（重建会把动作/表情/口型全断掉）
function syncStageSize(adjustModel) {
  if (!pixiApp) return false;
  const w = stageBox.clientWidth || window.innerWidth;
  const h = stageBox.clientHeight || window.innerHeight;
  if (!w || !h) return false;
  try { pixiApp.renderer.resize(w, h); } catch (err) { /* 渲染器刚销毁 */ }
  if (adjustModel && modelObj) applyModelLayout();
  return true;
}

/** 模型画布尺寸（moc3 里定义的画布，和「角色实际占多少」不是一回事） */
function canvasSizeOf() {
  const im = modelObj && modelObj.internalModel;
  if (!im) return null;
  const w = Number(im.originalWidth || im.width) || 0;
  const h = Number(im.originalHeight || im.height) || 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * 量「角色此刻真的画在窗口的哪一块」（CSS 像素，左上角原点）。
 *
 * 为什么不能信模型的包围盒：这个模型的画布是 6000×7501，但引擎算出来的 drawable bounds
 * 是 18168×13724（有些网格顶点跑到很远的地方），按它适配只会把角色缩成窗口里的一个小点。
 * 直接读一帧真实像素求 alpha 包围盒，才是「看起来多大」的唯一真相。
 */
function measureRenderedBox() {
  const app = pixiApp;
  if (!app || !modelObj) return null;
  let box = null;
  try {
    const gl = app.renderer.gl;
    if (!gl) return null;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    if (!W || !H) return null;
    app.renderer.render(app.stage);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let minX = W; let minY = H; let maxX = -1; let maxY = -1;
    for (let y = 0; y < H; y += 1) {
      const row = y * W * 4;
      for (let x = 0; x < W; x += 1) {
        if (px[row + x * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const res = Number(app.renderer.resolution) || 1;
    box = {
      // GL 原点在左下角，换成 CSS 像素 + 左上原点
      x: minX / res,
      y: H / res - (maxY + 1) / res,
      w: (maxX - minX + 1) / res,
      h: (maxY - minY + 1) / res,
    };
  } catch (err) {
    return null;
  }
  return box;
}

/**
 * 量「这一次的真实内容盒」。
 *
 * 关键：**必须先把模型临时缩到很小再量**。因为内容超出窗口时，读到的像素包围盒会被裁成
 * 窗口本身（看起来「刚好铺满」），拿它算比例就会以为没问题 —— 这正是「拿着超出板框的道具
 * 显示不完全」的成因：比例是按默认姿势量出来的，一换姿势/一拿道具内容变大，就顶出窗口被裁。
 *
 * 缩到一半大小再量，几乎不可能被裁（真被裁了还会继续缩），而且只花一次 readPixels。
 */
function measureContentBox(W, H, canvas) {
  let s = Math.min(W / canvas.w, H / canvas.h) * 0.5;
  let box = null;
  for (let i = 0; i < 4; i += 1) {
    modelObj.scale.set(s);
    modelObj.position.set(W / 2, H / 2);
    box = measureRenderedBox();
    if (!box) return { box: null, scale: s };
    const clipped = box.x <= 0.5 || box.y <= 0.5 || box.x + box.w >= W - 0.5 || box.y + box.h >= H - 0.5;
    if (!clipped) return { box, scale: s };
    s *= 0.6;
  }
  return { box, scale: s, clipped: true };
}

// 测量次数（自检用）：打开时走「按存档恢复」这条路，不允许偷偷再量一遍
let fitMeasureCount = 0;

/** 直接落位（不做动画） */
function applyTransformNow(scale, x, y) {
  modelObj.scale.set(scale);
  modelObj.position.set(x, y);
}

// 改姿势 / 拿道具时比例会变，硬跳一下很晃眼；用 180ms ease-out 过渡（减少动效时直接跳）
let layoutTween = 0;
function animateTransformTo(scale, x, y, from, ms) {
  if (layoutTween) { cancelAnimationFrame(layoutTween); layoutTween = 0; }
  const reduce = document.documentElement.getAttribute('data-reduce-motion') === 'true';
  if (reduce || !from || ms <= 0) { applyTransformNow(scale, x, y); return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) * (1 - k);
    applyTransformNow(
      from.s + (scale - from.s) * e,
      from.x + (x - from.x) * e,
      from.y + (y - from.y) * e,
    );
    layoutTween = k < 1 ? requestAnimationFrame(step) : 0;
  };
  layoutTween = requestAnimationFrame(step);
}

/**
 * 模型在窗口里的布局（唯一入口）。
 *
 * 两步：
 *   1) 先把模型缩到一半大小量出**这次的真实内容盒**（measureContentBox），保证量的是完整内容；
 *   2) 按「内容盒 × fill」把内容缩放到目标占比，并把盒子中心对齐到窗口中心
 *      （顺带补上实时量出来的偏移，所以不同模型/不同姿势都能居中）。
 *
 * fill = 设置里的 live2d.fit × 展台面板里的 live2d.zoom，钳在 0.3~1.25。
 * 1.0 = 内容刚好铺满窗口；>1 允许略微出血（看着更有临场感）。
 *
 * 注意：`fill` 是相对**当前内容**算的，所以换了姿势、拿了更大的道具之后必须重新跑一遍
 * 不自动改（用户要求手动），被裁了只给提示，由用户点「按当前姿势适配」（refitToContent）。
 */
function layoutToContent({ animate = false } = {}) {
  if (!pixiApp || !modelObj) return false;
  const W = stageBox.clientWidth || window.innerWidth;
  const H = stageBox.clientHeight || window.innerHeight;
  if (!W || !H) return false;
  const canvas = canvasSizeOf();
  if (!canvas) return false;
  const zoom = Number(hq.zoom) || 1;
  const fill = clampFill((Number(hq.fit) || 0.95) * zoom);
  const offsetY = Number(hq.offsetY) || 0;
  const from = { s: modelObj.scale.x, x: modelObj.position.x, y: modelObj.position.y };

  fitMeasureCount += 1;
  const probed = measureContentBox(W, H, canvas);
  let target = null;
  if (probed.box) {
    target = fitTransform({
      box: probed.box,
      scale0: probed.scale,
      stage: { w: W, h: H },
      fill,
      offsetY,
    });
  }
  let measuredKind = 'pixels';
  if (!target) {
    // 量不到就别把角色弄丢：退回「按画布装进窗口」这个保守估计
    const s = Math.min(W / canvas.w, H / canvas.h) * fill;
    target = {
      scale: s,
      x: W / 2,
      y: H / 2 + offsetY * H,
      drawn: { w: canvas.w * s, h: canvas.h * s },
      factor: s,
    };
    measuredKind = 'canvas';
  }

  if (animate) animateTransformTo(target.scale, target.x, target.y, from, 180);
  else applyTransformNow(target.scale, target.x, target.y);
  // 测量时把模型临时缩到一半大小时**已经画过一帧**（readPixels 必须先渲染），
  // 这里立刻按最终状态再画一次，否则用户会看到一帧「模型突然变小」的闪跳。
  try { pixiApp.renderer.render(pixiApp.stage); } catch (err) { /* 渲染器刚销毁 */ }

  drawnBox = target.drawn;
  // 调试快照：自检要看得出「基线占比 / 量到的内容盒 / 最终比例 / 实际画出来多大 / 量的时候有没有被裁」
  window.__AILEEN_FIT_DEBUG = {
    fill,
    scale: Number(target.scale.toFixed(5)),
    stage: [Math.round(W), Math.round(H)],
    canvas: [Math.round(canvas.w), Math.round(canvas.h)],
    box: probed.box ? [Math.round(probed.box.x), Math.round(probed.box.y), Math.round(probed.box.w), Math.round(probed.box.h)] : null,
    measureScale: Number(Number(probed.scale).toFixed(5)),
    measureClipped: !!probed.clipped,
    kind: measuredKind,
    drawn: [Math.round(target.drawn.w), Math.round(target.drawn.h)],
    pos: [Math.round(target.x), Math.round(target.y)],
    animated: !!animate,
    hq: { fit: hq.fit, zoom: hq.zoom, offsetY: hq.offsetY, quality: hq.quality, lod: hq.lod, mask: hq.mask },
  };
  const slider = document.getElementById('ov-scale');
  if (slider && document.activeElement !== slider) slider.value = String(zoom.toFixed(2));
  // 这次是「真的量过算过」的结果 —— 存下来，下次打开直接按它恢复，不再自动适配
  scheduleLayoutSave(400);
  return true;
}

// ---------------- 「上次用多大」的存档 ----------------
// 用户明确要求：**打开展台不要自动重新适配**。所以打开时先按存档恢复（不测量、不重算），
// 只有第一次（没存档）或用户点「按当前姿势适配」/改设置时，才真的重新量一遍。
let savedLayout = null;      // { scale, fx, fy, drawn }
let layoutSaveTimer = null;

function layoutModelKey() {
  return String((currentModel && (currentModel.key || currentModel.url)) || '');
}

/** 从主进程设置文件里读这个模型上次的比例（读不到就是 null） */
async function loadSavedLayout() {
  const key = layoutModelKey();
  savedLayout = null;
  if (!key || !window.api || !window.api.live2dGetLayout) return null;
  try {
    const v = await window.api.live2dGetLayout({ modelKey: key });
    if (v && Number(v.scale) > 0 && Number.isFinite(Number(v.fx)) && Number.isFinite(Number(v.fy))) {
      savedLayout = {
        scale: Number(v.scale),
        fx: Number(v.fx),
        fy: Number(v.fy),
        drawn: Array.isArray(v.drawn) ? v.drawn : null,
      };
    }
  } catch (err) { /* 主进程没起来就退回自动适配一次 */ }
  return savedLayout;
}

// 自检临时改基准比例时置位：不允许把测试用的布局写成用户的存档
let layoutPersistSuppressed = false;

/** 把当前变换存下来（防抖：改尺寸/拖动时不要每次写设置） */
function scheduleLayoutSave(delay = 500) {
  if (layoutPersistSuppressed) return false;
  const key = layoutModelKey();
  if (!key || !modelObj || !window.api || !window.api.live2dSetLayout) return false;
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    if (!modelObj) return;
    const W = stageBox.clientWidth || window.innerWidth;
    const H = stageBox.clientHeight || window.innerHeight;
    if (!W || !H) return;
    const payload = {
      modelKey: key,
      scale: modelObj.scale.x,
      fx: modelObj.position.x / W,
      fy: modelObj.position.y / H,
      drawn: drawnBox ? [Math.round(drawnBox.w), Math.round(drawnBox.h)] : undefined,
    };
    savedLayout = { scale: payload.scale, fx: payload.fx, fy: payload.fy, drawn: payload.drawn || null };
    try {
      Promise.resolve(window.api.live2dSetLayout(payload)).catch(() => { /* 写不进就下次再说 */ });
    } catch (err) { /* ignore */ }
  }, Math.max(0, Number(delay) || 0));
  return true;
}

/** 按存档恢复（**不测量**）；没有存档返回 false，让调用方退回自动适配一次 */
function applySavedLayout() {
  if (!pixiApp || !modelObj || !savedLayout) return false;
  const W = stageBox.clientWidth || window.innerWidth;
  const H = stageBox.clientHeight || window.innerHeight;
  if (!W || !H) return false;
  const s = Number(savedLayout.scale);
  if (!(s > 0)) return false;
  applyTransformNow(s, savedLayout.fx * W, savedLayout.fy * H);
  if (savedLayout.drawn) drawnBox = { w: savedLayout.drawn[0], h: savedLayout.drawn[1] };
  try { pixiApp.renderer.render(pixiApp.stage); } catch (err) { /* 渲染器刚销毁 */ }
  window.__AILEEN_FIT_DEBUG = {
    fill: clampFill((Number(hq.fit) || 0.95) * (Number(hq.zoom) || 1)),
    scale: Number(s.toFixed(5)),
    stage: [Math.round(W), Math.round(H)],
    restored: true,
    pos: [Math.round(savedLayout.fx * W), Math.round(savedLayout.fy * H)],
    drawn: savedLayout.drawn ? savedLayout.drawn.slice() : null,
    hq: { fit: hq.fit, zoom: hq.zoom, offsetY: hq.offsetY, quality: hq.quality, lod: hq.lod, mask: hq.mask },
  };
  return true;
}

/** 布局入口：默认**先按存档恢复**（打开/改窗口大小），不会自动重新适配 */
function applyModelLayout({ refit = false } = {}) {
  if (layoutTween) { cancelAnimationFrame(layoutTween); layoutTween = 0; }
  if (!refit && applySavedLayout()) return true;
  return layoutToContent({ animate: false });
}

// 内容变了（换姿势 / 拿道具 / 开关部件 / 播动作）**不自动改比例**（用户要求：改手动）。
// 只做一件事：悄悄量一下现在有没有被窗口裁到，被裁了就在「大小」那一栏给个提示，
// 由用户自己点「按当前姿势适配」。不量的话用户根本不知道道具出框了。
let clipHintTimer = null;
let clipHintOn = false;
function setClipHint(on) {
  if (on === clipHintOn) return;
  const was = clipHintOn;
  clipHintOn = on;
  const note = document.getElementById('ov-fit-note');
  const btn = document.getElementById('ov-fit-now');
  if (note) note.classList.toggle('hidden', !on);
  if (btn) btn.classList.toggle('is-attn', on);
  // 第一次发现出框时在状态条上提示一句（面板里那行字要滚到底才看得到）
  if (on && !was) flashStatus(t('overlay.fitClipHint'));
  reportHitArea();
}

/** 量一次「现在有没有被窗口裁」：贴着窗口边就算裁（正常铺 95% 时四边都还有余量） */
function checkContentClipped() {
  if (!pixiApp || !modelObj) return false;
  const W = stageBox.clientWidth || window.innerWidth;
  const H = stageBox.clientHeight || window.innerHeight;
  if (!W || !H) return false;
  const box = measureRenderedBox();
  if (!box) return false;
  const clipped = box.x <= 0.5 || box.y <= 0.5 || box.x + box.w >= W - 0.5 || box.y + box.h >= H - 0.5;
  setClipHint(clipped);
  return clipped;
}

function scheduleClipHint(delay = 200) {
  if (!pixiApp || !modelObj) return false;
  if (clipHintTimer) clearTimeout(clipHintTimer);
  clipHintTimer = setTimeout(() => {
    clipHintTimer = null;
    if (!pixiApp || !modelObj) return;
    checkContentClipped();
  }, Math.max(0, Number(delay) || 0));
  return true;
}

/** 手动适配：按**当前姿势**重新量内容盒并重算比例（拿大道具时点一下就好） */
function refitToContent({ animate = true } = {}) {
  const ok = layoutToContent({ animate });
  if (ok) setClipHint(false);
  return ok;
}

// ---- VTube Studio 热键（表情栈） ----
// 模型目录里的 `<模型名>.vtube.json` 是 VTS 自己的配置文件，里面有一份热键表。
// 引擎的「按字符串 id 读写参数」是坏的（根因见 src/lib/live2d/driver.js 顶部），所以这里
// 所有的参数读写都交给 controller —— 它只按下标干活。规矩：
//   · 表达式文件先解析、再核对参数**是否真的在这个模型里**，不在就明确报错，不假装成功；
//   · Overwrite / Add / Multiply 三种 Blend 按激活顺序叠加（和 VTS 一致）；
//   · 关掉 / 清空时把参数还原成「我们记录的基线」，模型不会卡在换好的形态上；
//   · 状态按模型分开存（localStorage 键里带 modelUrl），换模型不会串味。
const l2d = createLive2DController({
  fetchJson: (url) => fetchJson(url),
  // 状态落盘走主进程（设置文件），localStorage 只当缓存：
  // file:// 下的 localStorage 只在正常退出时才落盘，强杀/崩溃就丢，用户看到的就是「热键记不住」
  persist: {
    load: (modelKey) => (window.api && window.api.live2dGetState
      ? window.api.live2dGetState({ modelKey })
      : Promise.resolve(null)),
    save: (modelKey, state) => (window.api && window.api.live2dSetState
      ? window.api.live2dSetState({
        modelKey,
        activeExpressions: state.activeExpressions,
        hiddenParts: state.hiddenParts,
      })
      : Promise.resolve(false)),
  },
});

/** 取 JSON：模型目录里的配置（vtube/cdi3/exp3）都是外部数据，读不到就返回 null */
async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (err) { return null; }
}

/** 当前模型的 coreModel（引擎内部对象，用到时再取，不长期缓存） */
function coreModelOf() {
  try {
    const im = modelObj && modelObj.internalModel;
    return (im && im.coreModel) || null;
  } catch (err) { return null; }
}

/** 上一次 Live2D 状态加载有没有失败（自检要能看见，不能让「没热键」和「加载炸了」长一个样） */
let l2dLoadError = null;

/** 模型挂上之后调一次：建表 → 读 vtube/cdi3 → 恢复上次状态 → 重画面板 */
async function loadLive2DState(model) {
  const cm = coreModelOf();
  const secH = document.getElementById('ov-hotkey-sec');
  const secP = document.getElementById('ov-parts-sec');
  l2dLoadError = null;
  if (!model || !model.url || !cm) {
    l2d.reset();
    if (secH) secH.classList.add('hidden');
    if (secP) secP.classList.add('hidden');
    renderHotkeys();
    renderParts();
    return { hotkeys: 0, parts: 0 };
  }
  let res = { hotkeys: 0, parts: 0 };
  try {
    res = await l2d.load(model, cm);
  } catch (err) {
    l2dLoadError = String((err && err.message) || err);
    pushStageError('live2d-state', err);
  }
  if (res && res.stale) return res;   // 读配置期间换了模型：这次结果作废
  const fatal = (res && Array.isArray(res.errors) ? res.errors : []).find((e) => e && e.scope === 'model');
  if (!l2dLoadError && fatal) l2dLoadError = fatal.message;
  renderHotkeys();
  renderParts();
  reportHitArea();
  // 恢复出来的姿势可能带着道具（手上多了根权杖），比例要按恢复后的内容重新算
  scheduleClipHint(220);
  return res;
}

/** 正在读表达式文件的热键（防止连点 + 给按钮一个「正在加载」的样子） */
const hotkeyPending = new Set();

/** 打开/关闭一个热键：真的去读表达式、真的核对参数，失败要说出原因 */
async function toggleHotkey(h) {
  if (!h || !h.file) return false;
  if (hotkeyPending.has(h.file)) return false;   // 上一次还没读完，别重复发
  const on = !l2d.active.has(h.file);
  hotkeyPending.add(h.file);
  renderHotkeys();
  let r = { ok: false, error: '未知错误' };
  try {
    r = await l2d.setHotkeyActive(h, on);
  } catch (err) {
    r = { ok: false, error: String((err && err.message) || err) };
  } finally {
    hotkeyPending.delete(h.file);
    renderHotkeys();
    reportHitArea();
  }
  if (!r.ok && r.error) flashStatus(r.error);
  // 姿势变了，内容盒也会变（拿道具最常见）：重新适配一次，别按上一个姿势的比例画
  if (r.ok) scheduleClipHint(160);
  return on && r.ok;
}

/** 全部关掉（参数还原成基线，不只是清按钮） */
function clearHotkeys() {
  l2d.clearHotkeys();
  renderHotkeys();
  reportHitArea();
  scheduleClipHint(160);
}

function renderHotkeys() {
  const sec = document.getElementById('ov-hotkey-sec');
  const box = document.getElementById('ov-hotkeys');
  if (!box || !sec) return;
  const list = l2d.hotkeys || [];
  const bad = (l2d.unsupported || []).length;
  if (!list.length && !bad) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  box.innerHTML = '';
  for (const h of list) {
    const b = el('button', null, h.name);
    if (l2d.active.has(h.file)) b.classList.add('on');
    if (hotkeyPending.has(h.file)) {
      b.classList.add('is-loading');   // 读表达式文件是异步的，期间禁用，别让人以为是没反应
      b.disabled = true;
      b.title = t('overlay.loading');
    }
    if (h.error) {
      b.classList.add('is-bad');
      b.title = h.error;
    }
    b.onclick = () => { toggleHotkey(h).catch((err) => flashStatus(String((err && err.message) || err))); };
    box.appendChild(b);
  }
  // 明确不支持的动作也要让用户看见（灰着 + 说明原因），而不是悄悄消失
  for (const u of (l2d.unsupported || [])) {
    const b = el('button', 'is-off', u.name);
    b.disabled = true;
    b.title = u.reason || t('overlay.unsupported');
    box.appendChild(b);
  }
  reportHitArea();
}

// ---------------- 部件开关（cdi3 的中文部件名） ----------------
// 有些模型的「换装 / 拔道具 / 换姿势」不是参数驱动，而是**直接切部件显隐**。
// 部件名来自模型目录里的 `<模型名>.cdi3.json`，解析（去占位名、重名加序号）在
// src/lib/live2d/vts-format.js 的 parseParts 里，隐藏/恢复在 controller 里：
// 隐藏前记下这个部件**原始的不透明度**，恢复时原样写回去 —— 不是一律写 1。
/** 读部件不透明度（引擎接口 + core 数组兜底），读不到返回 null（不编一个 1 出来） */
function readPartOpacityCm(cm, index) {
  try {
    if (cm && typeof cm.getPartOpacityByIndex === 'function') {
      const v = Number(cm.getPartOpacityByIndex(index));
      return Number.isFinite(v) ? v : null;
    }
    const arr = cm && cm._model && cm._model.parts && cm._model.parts.opacities;
    if (arr) {
      const v = Number(arr[index]);
      return Number.isFinite(v) ? v : null;
    }
  } catch (err) { /* 下面返回 null */ }
  return null;
}

function renderParts() {
  const sec = document.getElementById('ov-parts-sec');
  const box = document.getElementById('ov-parts');
  if (!box || !sec) return;
  const list = l2d.parts || [];
  if (!list.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  box.innerHTML = '';
  for (const p of list) {
    const b = el('button', null, p.label || p.name);
    // 亮着 = 显示中（和热键一致：亮 = 生效）
    if (!l2d.isPartHidden(p.id)) b.classList.add('on');
    b.onclick = () => { togglePart(p); };
    box.appendChild(b);
  }
  reportHitArea();
}

function togglePart(p) {
  if (!p) return false;
  const hiding = !l2d.isPartHidden(p.id);
  const r = hiding ? l2d.hidePart(p) : l2d.showPart(p);
  renderParts();
  reportHitArea();
  if (r && r.ok === false && r.error) flashStatus(r.error);
  if (r && r.ok) scheduleClipHint(160);   // 部件显隐也会改内容盒
  return hiding && !!(r && r.ok);
}

/** 全部显示：把每个部件的原始不透明度写回去，不只是清记录 */
function clearParts() {
  l2d.showAllParts();
  renderParts();
  reportHitArea();
  scheduleClipHint(160);
}

/** 每帧：被隐藏的部件持续压 0；激活中的表达式重新写成参数（都在 model.update() 之前） */
let l2dApplyFrames = 0;      // 自检：这一帧到底有没有被调到
let l2dLastApply = null;     // 自检：上一次写了几个参数 / 几个部件
function applyLive2DState() {
  const cm = coreModelOf();
  if (!cm) return;
  const r = l2d.apply(cm);
  l2dApplyFrames += 1;
  if (r.params || r.parts || l2d.active.size) {
    l2dLastApply = { params: r.params, parts: r.parts, active: [...l2d.active], at: Math.round(performance.now()) };
  }
}

// ---- 口型同步 ----
// 主窗口在朗读时把音量包络（0..1）送过来，这里在**动作更新之后**覆盖嘴部参数，
// 这样既不会和动作/表情打架，也不会被它们每帧覆盖掉。
function onMouthLevel(level) {
  const v = Number(level);
  mouthIncoming = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function applyMouthParam() {
  if (!modelObj || !modelObj.internalModel) return;
  const im = modelObj.internalModel;
  if (!hq.lipsync) { mouthLevel = 0; return; }
  const gain = Number(hq.lipsyncGain) || 1.2;
  // 包络按 25Hz 送进来，帧率更高：帧间做一点平滑，嘴才不会一格一格跳；
  // 同时按 0.85 衰减兜底（万一对端来不及送 0，嘴也会自己闭上）。
  const target = Math.min(1, Math.max(0, mouthIncoming * gain));
  mouthLevel += (target - mouthLevel) * 0.5;
  mouthIncoming *= 0.85;
  const value = Math.min(1, Math.max(0, mouthLevel));
  if (value > mouthPeak) mouthPeak = value;
  let id = 'ParamMouthOpenY';
  try {
    const ids = im.motionManager && im.motionManager.lipSyncIds;
    if (ids && ids.length) id = ids[0];
  } catch (err) { /* 用默认参数名 */ }
  // 必须按下标写：引擎的 ById 写的是幻影表（实测见 driver.js 顶部）
  l2d.setParamValue(im.coreModel, id, value);
}

// ---- 物理开关 ----
// 引擎在 internalModel.update() 里是 `if (this.physics) this.physics.evaluate(...)`，
// 所以「关物理」= 把引用摘下来（原对象存起来，随时能装回去），不动库内部状态机。
function applyPhysicsSetting() {
  if (!modelObj || !modelObj.internalModel) return false;
  const im = modelObj.internalModel;
  try {
    if (!im.__aileenPhysicsRef && im.physics) im.__aileenPhysicsRef = im.physics;
    if (hq.physics) {
      if (im.__aileenPhysicsRef) im.physics = im.__aileenPhysicsRef;
    } else {
      im.physics = null;
    }
    return true;
  } catch (err) { return false; }
}

// ---- 待机动作 ----
function idleGroupName() {
  if (!modelObj || !modelObj.internalModel) return null;
  try {
    const mm = modelObj.internalModel.motionManager;
    if (mm.groups && mm.groups.idle) return mm.groups.idle;
    const defs = (mm.definitions) || {};
    const keys = Object.keys(defs);
    return keys.find((k) => /idle/i.test(k)) || keys[0] || null;
  } catch (err) { return null; }
}

function playIdleMotion() {
  const group = idleGroupName();
  if (!group || !modelObj) return false;
  try {
    const defs = (modelObj.internalModel.motionManager.definitions || {})[group] || [];
    const n = defs.length || 1;
    modelObj.motion(group, Math.floor(Math.random() * n), MotionPriority.IDLE);
    return true;
  } catch (err) { return false; }
}

function scheduleIdleMotion() {
  stopIdleMotion();
  if (!hq.idleMotion || !modelObj) return;
  const seconds = Math.min(180, Math.max(3, Number(hq.idleInterval) || 14));
  idleTimer = setTimeout(() => {
    idleTimer = null;
    playIdleMotion();
    scheduleIdleMotion();
  }, seconds * 1000);
}

// ---- 视线跟随 ----
// 展台窗口大部分时间是鼠标穿透的，自己收不到 pointermove；主进程在穿透监控那一拍里
// 把真实光标（相对窗口的坐标）送过来（overlay:gaze）。
function onGaze(pt) {
  if (!hq.focusFollow || !modelObj || !pt) return;
  const x = Number(pt.x);
  const y = Number(pt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  try { modelObj.focus(x, y); } catch (err) { /* 模型还没 ready */ }
}


function bindModelHooks() {
  if (!modelObj || !modelObj.internalModel) return;
  const im = modelObj.internalModel;
  if (im.__aileenHooked) return;
  im.__aileenHooked = true;
  try { im.on('afterMotionUpdate', applyMouthParam); } catch (err) { pushStageError('hook', err); }
  // 表达式压在「参数」、部件压在「部件不透明度」上：都要排在物理/姿势之后、model.update() 之前
  try { im.on('beforeModelUpdate', applyLive2DState); } catch (err) { pushStageError('hook-live2d', err); }
}

async function renderStage(model) {
  destroyStage();
  const gen = stageGen;
  currentModel = model;
  if (!model || !model.url) {
    stageBox.innerHTML = '<div class="ov-empty">' + t('overlay.empty') + '</div>';
    return;
  }
  overlayRenderCount += 1;
  const app = new Application();
  try {
    await app.init({
      resizeTo: stageBox,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: stageResolution(),
      preference: 'webgl',
      width: stageBox.clientWidth || window.innerWidth,
      height: stageBox.clientHeight || window.innerHeight,
    });
  } catch (err) {
    pushStageError('appInit', err);
    stageBox.innerHTML = '<div class="ov-empty">' + t('overlay.empty') + '</div>';
    try { app.destroy(true); } catch (e2) { /* ignore */ }
    return;
  }
  if (gen !== stageGen) { try { app.destroy(true); } catch (err) { /* ignore */ } return; }
  pixiApp = app;
  try { app.ticker.maxFPS = Math.round(Math.min(60, Math.max(15, Number(hq.fps) || 60))); } catch (err) { /* ignore */ }
  stageBox.appendChild(app.canvas);
  try {
    const m = await Live2DModel.from(model.url, {
      // 自己接管更新：ticker 用 app 的，指针交互全部关掉（展台本来就是穿透的，
      // 视线跟随由 overlay:gaze 显式驱动，不依赖 pointer 事件）
      ticker: app.ticker,
      autoUpdate: true,
      autoInteract: false,
      autoHitTest: false,
      autoFocus: false,
      anchorMode: 'drawable',
      textureOptions: { lod: textureLODOption() },
    });
    if (gen !== stageGen) { try { m.destroy({ children: true, texture: true, textureSource: true }); } catch (err) { /* ignore */ } return; }
    modelObj = m;
    m.anchor.set(0.5, 0.5);
    app.stage.addChild(m);    bindModelHooks();
    applyPhysicsSetting();
    // 打开时**先按存档恢复**（不测量、不重算）；没有存档才自动适配一次（第一次用这个模型）
    await loadSavedLayout();
    applyModelLayout();
    scheduleIdleMotion();
    // 热键 + 部件：一次加载（含上次的状态恢复），状态全在 controller 里
    loadLive2DState(model).catch((err) => pushStageError('live2d-state', err));
    // 尺寸在第一帧之前可能还是 0（窗口刚显示），补两次重排
    // 窗口刚显示时尺寸可能还是 0：这里只按存档恢复（或必要时重排），不重新适配
    setTimeout(() => { if (gen === stageGen) applyModelLayout(); }, 120);
    setTimeout(() => { if (gen === stageGen) applyModelLayout(); }, 480);
  } catch (err) {
    pushStageError('modelLoad', err);
    stageBox.innerHTML = '<div class="ov-empty">' + t('overlay.empty') + '</div>';
  }
}

/**
 * 精细控制发生变化时的统一入口（设置页保存 / 展台自己改 zoom）。
 * 只做必要的重建：分辨率(画质)与纹理 LOD 改了必须重建（纹理是按当时的 LOD 生成的），
 * 帧率上限、物理、占比、偏移、待机间隔、视线跟随都能就地生效。
 */
function applyLive2DConfig(next, prev) {
  const before = prev || hq;
  hq = Object.assign({}, hq, next || {});
  const needRebuild = hq.quality !== before.quality || hq.lod !== before.lod;
  if (needRebuild) {
    renderStage(currentModel);
    return true;
  }
  if (pixiApp) {
    try { pixiApp.ticker.maxFPS = Math.round(Math.min(60, Math.max(15, Number(hq.fps) || 60))); }
    catch (err) { /* ignore */ }
  }
  applyPhysicsSetting();
  // 用户自己改了占比/偏移 → 才重新量一次（refit）
  applyModelLayout({ refit: true });
  scheduleIdleMotion();
  return true;
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
  if (st && st.live2d) hq = Object.assign(hq, st.live2d);
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
window.__AILEEN_ERRORS = [];
window.addEventListener('error', (e) => {
  if (window.__AILEEN_ERRORS.length < 8) {
    window.__AILEEN_ERRORS.push(String((e && e.error && e.error.stack) || (e && e.message) || e));
  }
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  if (window.__AILEEN_REJECTS.length < 5) window.__AILEEN_REJECTS.push(String((r && r.stack) || r));
});

// 轻量就绪问询：模型加载是异步的，自检要轮询这个，而不是固定等待
window.__AILEEN_OVERLAY_READY = () => {
  try { return !!(modelObj && modelObj.internalModel && pixiApp); } catch (err) { return false; }
};

/** 读一次 GL 后向缓冲，数「有多少不透明像素」—— 判定「真的画出来了」而不是只挂了对象 */
function sampleDrawnPixels(renderer, stage) {
  try {
    const gl = renderer && renderer.gl;
    if (!gl) return { error: 'no-gl' };
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    // 必须先同步渲染一帧再读：默认的绘制缓冲不保留，呈现之后再 readPixels 只会读到全 0
    renderer.render(stage);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let nonzero = 0;
    for (let i = 3; i < px.length; i += 4 * 97) { if (px[i] > 8) nonzero += 1; }
    return { drawBuf: [W, H], sampled: Math.floor(px.length / (4 * 97)), nonzero };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

window.__AILEEN_OVERLAY_PROBE = () => {
  const app = pixiApp;
  const canvas = document.querySelector('#ov-stage canvas');
  const stage = app && app.stage;
  const fb = app && app.renderer ? sampleDrawnPixels(app.renderer, stage) : null;
  return {
    engine: 'untitled-pixi-live2d-engine',
    hasInstance: !!modelObj,
    themeApplied: overlayThemeApplied,
    themeAttr: document.documentElement.getAttribute('data-theme'),
    hasPixiApp: !!app,
    rendererSize: app && app.renderer ? [app.renderer.width, app.renderer.height] : null,
    rendererScreen: app && app.renderer ? [Math.round(app.screen.width), Math.round(app.screen.height)] : null,
    resolution: app && app.renderer ? app.renderer.resolution : null,
    canvasAttr: canvas ? [canvas.width, canvas.height] : null,
    canvasCss: canvas ? [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)] : null,
    stageRect: (function () { const r = stageBox.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    synced: syncStageSize(),
    hasModel: !!currentModel,
    rejects: window.__AILEEN_REJECTS.slice(0, 4),
    errors: window.__AILEEN_ERRORS.slice(0, 4),
    screenSize: [window.screen.width, window.screen.height],
    innerSize: [window.innerWidth, window.innerHeight],
    modelUrl: currentModel ? currentModel.url : null,
    fitDebug: window.__AILEEN_FIT_DEBUG || null,
    hq: {
      fit: hq.fit, zoom: hq.zoom, offsetY: hq.offsetY, lipsync: hq.lipsync, lipsyncGain: hq.lipsyncGain,
      idleMotion: hq.idleMotion, idleInterval: hq.idleInterval, focusFollow: hq.focusFollow,
      physics: hq.physics,
      quality: hq.quality, fps: hq.fps, lod: hq.lod, mask: hq.mask,
    },    ticker: app ? { maxFPS: app.ticker.maxFPS, started: !!app.ticker.started } : null,
    mouth: { incoming: Number(mouthIncoming.toFixed(3)), level: Number(mouthLevel.toFixed(3)) },
    idle: { scheduled: !!idleTimer, group: idleGroupName(), playing: !!(modelObj && modelObj.internalModel && modelObj.internalModel.motionManager && modelObj.internalModel.motionManager.playing) },
    hotkeys: { count: (l2d.hotkeys || []).length, active: [...l2d.active], cached: [...l2d.expressionCache.keys()] },
    live2dFrames: { count: l2dApplyFrames, last: l2dLastApply, loadError: l2dLoadError },
    parts: { count: (l2d.parts || []).length, hidden: [...l2d.hiddenParts.keys()] },
    physicsApplied: !!(modelObj && modelObj.internalModel && modelObj.internalModel.physics),
    stageChildren: stage ? stage.children.length : null,
    renderedOk: fb ? (typeof fb.nonzero === 'number' ? fb.nonzero > 20 : false) : false,
    fb,
    modelTransform: (function () {
      try {
        if (!modelObj) return null;
        const canvas = canvasSizeOf();
        return {
          x: Math.round(modelObj.x), y: Math.round(modelObj.y),
          sx: Number(modelObj.scale.x.toFixed(5)),
          alpha: modelObj.alpha, visible: modelObj.visible,
          canvas: canvas ? [Math.round(canvas.w), Math.round(canvas.h)] : null,
          drawn: drawnBox ? [Math.round(drawnBox.w), Math.round(drawnBox.h)] : null,
        };
      } catch (e) { return 'err:' + e.message; }
    })(),
    status: (function () { try { return modelObj && modelObj.internalModel ? 'internalModel-ok' : 'no-internalModel'; } catch (e) { return 'err:' + e.message; } })(),
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

// 一条过几秒自动消失的提示（错误原因、适配结果）。不能直接用 setStatus：
// 那个是会话状态（忙碌/语音/Agent），传字符串进去会把状态栏弄成空。
let flashTimer = null;
function flashStatus(msg) {
  if (!statusEl || !msg) return;
  const text = String(msg);
  if (flashTimer) clearTimeout(flashTimer);
  statusEl.textContent = text;
  statusEl.className = 'ov-status';
  flashTimer = setTimeout(() => {
    flashTimer = null;
    if (statusEl.textContent !== text) return;   // 中途来了真状态，别抢
    statusEl.textContent = '';
    statusEl.className = 'ov-status hidden';
    reportHitArea();
  }, 4200);
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
  const motionBox = document.getElementById('ov-motions');
  const exprBox = document.getElementById('ov-exprs');
  const mm = (function () { try { return modelObj ? modelObj.internalModel.motionManager : null; } catch (err) { return null; } })();
  if (motionBox) {
    motionBox.innerHTML = '';
    let groups = [];
    try {
      // definitions 里有「组名 → 动作数组」，没加载完就退回 motionGroups 的键
      const defs = (mm && mm.definitions) || {};
      groups = Object.keys(defs).length ? Object.keys(defs) : Object.keys((mm && mm.motionGroups) || {});
    } catch (err) { groups = []; }
    if (!groups.length) motionBox.appendChild(el('span', 'ov-muted', t('overlay.none')));
    for (const g of groups.slice(0, 12)) {
      const b = el('button', null, g);
      b.onclick = () => {
        if (modelObj) { try { modelObj.motion(g); } catch (err) { /* 忽略 */ } }
        scheduleClipHint(520);   // 动作里可能掏出道具，等姿势稳定后再量一次
      };
      motionBox.appendChild(b);
    }
  }
  if (exprBox) {
    exprBox.innerHTML = '';
    let defs = [];
    try {
      const em = mm && mm.expressionManager;
      defs = ((em && em.definitions) || []).map((d) => (d && d.Name) || (d && d.name) || String(d));
    } catch (err) { defs = []; }
    if (!defs.length) exprBox.appendChild(el('span', 'ov-muted', t('overlay.none')));
    for (const name of defs.slice(0, 12)) {
      const b = el('button', null, name);
      b.onclick = () => {
        if (modelObj) { try { modelObj.expression(name); } catch (err) { /* 忽略 */ } }
        scheduleClipHint(420);
      };
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
  const clearBtn = document.getElementById('ov-hotkey-clear');
  if (clearBtn) clearBtn.onclick = () => clearHotkeys();
  const partsReset = document.getElementById('ov-parts-reset');
  if (partsReset) partsReset.onclick = () => clearParts();
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
  const slider = document.getElementById('ov-scale');
  slider.value = String(hq.zoom || 1);
  slider.oninput = (e) => {
    const v = Math.min(1.25, Math.max(0.4, Number(e.target.value) || 1));
    hq.zoom = v;
    applyModelLayout({ refit: true });
    // 落盘（live2d.zoom）：下次开窗口还是这个大小；主进程会再推一次配置回来
    Promise.resolve(window.api.overlaySetZoom(v)).catch(() => { /* 主窗口没开 */ });
    reportHitArea();
  };
}

// 「按当前姿势适配」：拿大道具时手动点一下（不自动缩放，用户要的是手动）
if (document.getElementById('ov-fit-now')) {
  const fitBtn = document.getElementById('ov-fit-now');
  fitBtn.onclick = () => {
    const ok = refitToContent({ animate: true });
    if (!ok) flashStatus(t('overlay.fitFailed'));
    else flashStatus(t('overlay.fitDone'));
    reportHitArea();
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
      // 主窗口（角色回复里的动作标记、Agent 状态演出）遥控展台的动作。
      // 注意打的是 modelObj（真身），currentModel 只是数据 —— 以前这里打在数据对象上，
      // 被 try/catch 静默吞掉，等于「主窗口发的动作从来没生效过」。
      if (modelObj && s.name) {
        try { modelObj.motion(String(s.name)); } catch (err) { /* 模型不认这个名字 */ }
        scheduleClipHint(520);
      }
    } else if (s.type === 'expression') {
      if (modelObj && s.name) {
        try { modelObj.expression(String(s.name)); } catch (err) { /* 同上 */ }
        scheduleClipHint(420);
      }
    } else if (s.type === 'scale') {
      const v = Number(s.value);
      if (Number.isFinite(v)) {
        // 主窗口的「角色大小」滑块 = 精细控制里的 zoom（0.4~1.25）
        hq.zoom = Math.min(1.25, Math.max(0.4, v));
        applyModelLayout({ refit: true });
        const sc = document.getElementById('ov-scale');
        if (sc) sc.value = String(hq.zoom);
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
// 精细控制（设置页保存后主进程会推）/
// 口型包络（主窗口 TTS 播放时送）/ 视线跟随（主进程按光标位置送）
if (typeof window.api.onOverlayLive2D === 'function') {
  window.api.onOverlayLive2D((cfg) => { if (cfg && typeof cfg === 'object') applyLive2DConfig(cfg, hq); });
}
if (typeof window.api.onOverlayMouth === 'function') window.api.onOverlayMouth((level) => onMouthLevel(level));
if (typeof window.api.onOverlayGaze === 'function') window.api.onOverlayGaze((pt) => onGaze(pt));

// 自检：模型被重建了几次 / 现在有没有模型（用来验证「改尺寸不重置模型」）
window.__AILEEN_OVERLAY_STAGE_INFO = () => ({ renders: overlayRenderCount, hasModel: !!currentModel, engine: 'pixi8' });
// 自检：手工灌一口型包络，验证「嘴部参数真的被驱动」。
// 口令包络是衰减的，所以自检不能只看「此刻的值」—— 顺手记一个峰值。
window.__AILEEN_OVERLAY_MOUTH = (level) => {
  mouthPeak = 0;
  onMouthLevel(level);
  return { incoming: mouthIncoming, level: mouthLevel };
};
// 自检：当前模型的口型参数值（判断动作更新之后有没有被覆盖）
window.__AILEEN_MOUTH_VALUE = () => {
  try {
    const im = modelObj && modelObj.internalModel;
    if (!im || !im.coreModel) return null;
    let id = 'ParamMouthOpenY';
    const ids = im.motionManager && im.motionManager.lipSyncIds;
    if (ids && ids.length) id = ids[0];
    const v = l2d.readParamValue(im.coreModel, id);
    return { id, value: v, peak: Number(mouthPeak.toFixed(3)), level: Number(mouthLevel.toFixed(3)) };
  } catch (err) { return null; }
};
;






// 自检 / 调试：VTS 热键与部件（状态全部来自 controller，不另存一份）
window.__AILEEN_HOTKEYS = () => ({
  count: (l2d.hotkeys || []).length,
  base: l2d.dirUrl || null,
  active: [...l2d.active],
  names: (l2d.hotkeys || []).slice(0, 60).map((h) => h.name),
  cached: [...l2d.expressionCache.keys()],
  unsupported: (l2d.unsupported || []).length,
  errors: (l2d.hotkeys || []).filter((h) => h.error).map((h) => ({ name: h.name, error: h.error })),
  params: l2d.paramTable ? l2d.paramTable.count : 0,
  loadError: l2dLoadError,
});
// 自检 / 调试用：走**和面板按钮同一条路径**（toggleHotkey），否则量不到适配效果
window.__AILEEN_HOTKEY_TOGGLE = async (name) => {
  const h = (l2d.hotkeys || []).find((x) => x.name === name);
  if (!h) return { ok: false, error: 'not-found' };
  const on = !l2d.active.has(h.file);
  const ok = await toggleHotkey(h);
  await waitFrames(2);
  return {
    ok: on ? !!ok : l2d.active.has(h.file) === false,
    error: h.error || null,
    missing: [],
    active: l2d.active.has(h.file),
  };
};
window.__AILEEN_HOTKEY_CLEAR = () => { clearHotkeys(); return [...l2d.active]; };

// 读参数一律走「id → 下标」表；引擎那套 ById 读的是幻影表（见 driver.js 顶部）
window.__AILEEN_PARAM_VALUE = (id) => {
  const cm = coreModelOf();
  if (!cm) return null;
  return l2d.readParamValue(cm, id);
};

window.__AILEEN_PARTS = () => ({
  count: (l2d.parts || []).length,
  hidden: [...l2d.hiddenParts.keys()],
  names: (l2d.parts || []).slice(0, 80).map((p) => p.name),
  ids: (l2d.parts || []).slice(0, 80).map((p) => p.id),
});
// 自检：把「被隐藏的部件」全部恢复（持久化之后，上一轮的隐藏会留到这一轮）
window.__AILEEN_PARTS_RESET = () => { clearParts(); return [...l2d.hiddenParts.keys()]; };
window.__AILEEN_PART_TOGGLE = (key) => {
  const list = l2d.parts || [];
  const p = list.find((x) => x.id === key) || list.find((x) => x.label === key) || list.find((x) => x.name === key);
  if (!p) return 'not-found';
  return togglePart(p);
};
window.__AILEEN_PART_OPACITY = (key) => {
  try {
    const list = l2d.parts || [];
    const p = list.find((x) => x.id === key) || list.find((x) => x.label === key) || list.find((x) => x.name === key);
    const cm = coreModelOf();
    if (!p || !cm) return null;
    return Number(readPartOpacityCm(cm, p.index).toFixed(3));
  } catch (err) { return null; }
};

/** 引擎级「画面状态」指纹：部件不透明度 + 绘制不透明度 + 顶点采样。
 *  注意不能用参数值当证据：引擎每帧 update() 之后会 loadParameters() 把参数恢复成
 *  动作前的基线，所以在帧外读参数永远是基线值（看起来像「没写进去」）。
 *  这三个数组才是 update() 真正拿去画东西的东西。 */
function l2dDigest() {
  try {
    const cm = coreModelOf();
    if (!cm) return null;
    const partCount = Number(cm.getPartCount()) || 0;
    const drawableCount = Number(cm.getDrawableCount()) || 0;
    const parts = [];
    for (let i = 0; i < partCount; i += 1) parts.push(Number((readPartOpacityCm(cm, i) || 0).toFixed(4)));
    const opacities = [];
    let vertSum = 0;
    let vertN = 0;
    for (let i = 0; i < drawableCount; i += 1) {
      let o = 0;
      try { o = Number(cm.getDrawableOpacity(i)) || 0; } catch (err) { o = -1; }
      opacities.push(Number(o.toFixed(4)));
      try {
        const v = cm.getDrawableVertexPositions && cm.getDrawableVertexPositions(i);
        if (v && v.length) { vertSum += Number(v[0]) || 0; vertSum += Number(v[Math.floor(v.length / 2)]) || 0; vertN += 2; }
      } catch (err) { /* 顶点读不到就算了 */ }
    }
    return { parts, opacities, vertSum: Number(vertSum.toFixed(2)), vertN };
  } catch (err) { return { error: String((err && err.message) || err) }; }
}

/** 指纹差异：返回变了多少个部件/绘制，以及顶点和差了多少（判断「画面真的变了」用） */
function l2dDigestDiff(a, b) {
  if (!a || !b || a.error || b.error) return null;
  const cmp = (x, y) => {
    let changed = 0;
    let maxDelta = 0;
    const n = Math.min((x || []).length, (y || []).length);
    for (let i = 0; i < n; i += 1) {
      const d = Math.abs(x[i] - y[i]);
      if (d > 0.01) changed += 1;
      if (d > maxDelta) maxDelta = d;
    }
    return { changed, maxDelta: Number(maxDelta.toFixed(4)), n };
  };
  return {
    parts: cmp(a.parts, b.parts),
    opacities: cmp(a.opacities, b.opacities),
    vertDelta: Number(Math.abs((a.vertSum || 0) - (b.vertSum || 0)).toFixed(2)),
  };
}

/** 等 n 帧（让 ticker 真的跑一遍 update()） */
function waitFrames(n) {
  return new Promise((resolve) => {
    let left = Math.max(1, n | 0);
    const step = () => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

window.__AILEEN_L2D_DIGEST = () => l2dDigest();
window.__AILEEN_L2D_DIGEST_DIFF = (a, b) => l2dDigestDiff(a, b);

/** 引擎级「角色此刻真的画在哪一块」（CSS 像素）：拿来判断有没有被窗口裁掉 */
window.__AILEEN_CONTENT_BOX = () => {
  const W = stageBox.clientWidth || window.innerWidth;
  const H = stageBox.clientHeight || window.innerHeight;
  const box = measureRenderedBox();
  if (!box) return null;
  const clippedLeft = box.x <= 0.5;
  const clippedTop = box.y <= 0.5;
  const clippedRight = box.x + box.w >= W - 0.5;
  const clippedBottom = box.y + box.h >= H - 0.5;
  return {
    stage: [Math.round(W), Math.round(H)],
    box: [Number(box.x.toFixed(1)), Number(box.y.toFixed(1)), Number(box.w.toFixed(1)), Number(box.h.toFixed(1))],
    clipped: clippedLeft || clippedTop || clippedRight || clippedBottom,
    sides: { left: clippedLeft, top: clippedTop, right: clippedRight, bottom: clippedBottom },
    fill: window.__AILEEN_FIT_DEBUG ? window.__AILEEN_FIT_DEBUG.fill : null,
  };
};

/**
 * 热键「画面真的变了」测试（引擎级，不看按钮）：
 *   清空 → 等帧 → 指纹 A → 打开热键 → 等帧 → 指纹 B → 清空 → 等帧 → 指纹 C
 *   判定：B 与 A 必须有绘制/部件差异，且 C 必须回到 A（还原是真的）。
 */
window.__AILEEN_L2D_TEST_HOTKEY_VISUAL = async (name) => {
  try {
    const list = l2d.hotkeys || [];
    const hk = list.find((h) => h.name === name) || list.find((h) => h.supported && h.kind === 'toggle-expression');
    if (!hk) return { ok: false, error: 'no-hotkey' };
    l2d.clearHotkeys();
    await waitFrames(3);
    const a = l2dDigest();
    const r = await l2d.setHotkeyActive(hk, true);
    await waitFrames(4);
    const b = l2dDigest();
    const on = l2dDigestDiff(a, b);
    l2d.clearHotkeys();
    await waitFrames(4);
    const c = l2dDigest();
    const back = l2dDigestDiff(a, c);
    const changedDrawables = (on && on.opacities.changed) || 0;
    const changedParts = (on && on.parts.changed) || 0;
    const afterChanged = ((back && back.opacities.changed) || 0) + ((back && back.parts.changed) || 0);
    return {
      ok: !!r.ok && (changedDrawables + changedParts) >= 1 && afterChanged === 0,
      name: hk.name,
      toggleOk: !!r.ok,
      error: r.error || null,
      changedDrawables,
      changedParts,
      afterClearChanged: afterChanged,
      vertDeltaOn: on ? on.vertDelta : null,
      vertDeltaBack: back ? back.vertDelta : null,
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

/** 上一帧真正写进模型并参与渲染的参数值（帧外读参数只能读到基线，这个才是「画面上生效的值」） */
window.__AILEEN_PARAM_WRITTEN = (id) => {
  const v = l2d.lastWritten.get(String(id));
  return v === undefined ? null : v;
};

/**
 * 「道具出框」的引擎级验证 —— **手动适配**语义（用户要求：不要自动改比例）。
 *
 * 对每个道具/姿势类热键：
 *   清空 → 量 A（默认姿势）→ 打开热键 → 等帧 → 量 B（**不该被自动改**：比例必须和之前一样）
 *   → 点「按当前姿势适配」（refitToContent，和面板按钮同一个函数）→ 量 C（现在必须完整）
 *   → 关掉 + 还原。
 * 判定：① 打开道具后比例没被自动改（autoResized === false）；② 手动适配后不再被裁。
 */
window.__AILEEN_L2D_TEST_PROP_FIT = async (name) => {
  try {
    const list = (l2d.hotkeys || []).filter((h) => h.supported && h.kind === 'toggle-expression');
    if (!list.length) return { ok: false, error: 'no-prop-hotkey' };
    const PREFER = ['Overhead Staff Raise', 'Item Behind Back2', 'Item Behind Back', 'axe', 'crowbar', 'stun baton', 'Hold Staff1'];
    let tries;
    if (name) tries = [list.find((h) => h.name === name)].filter(Boolean);
    else {
      tries = PREFER.map((n) => list.find((h) => h.name === n)).filter(Boolean);
      if (!tries.length) {
        const fallback = list.find((h) => /staff|item|tool|axe|bat|hammer|pose/i.test(h.name)) || list[0];
        tries = [fallback];
      }
    }
    const rows = [];
    let judged = null;
    // 用户可能把占比调到 >1（主动出血），那种情况下「手动适配后被裁」是预期结果，
    // 不能拿来判假。这里临时用「刚好铺满」的基准跑，跑完还原（并且不写存档）。
    const hqBackup = { fit: hq.fit, zoom: hq.zoom, offsetY: hq.offsetY };
    layoutPersistSuppressed = true;
    hq.fit = 0.95;
    hq.zoom = 1;
    for (const hk of tries) {
      l2d.clearHotkeys();
      refitToContent({ animate: false });
      await waitFrames(3);
      const scaleBase = modelObj ? Number(modelObj.scale.x) : 0;
      const before = window.__AILEEN_CONTENT_BOX();
      const r = await l2d.setHotkeyActive(hk, true);
      await waitFrames(5);                                   // 等一会儿：确认**没有**任何自动缩放
      const scaleAfterToggle = modelObj ? Number(modelObj.scale.x) : 0;
      const raw = window.__AILEEN_CONTENT_BOX();             // 自动适配被关掉了：这里可能被裁
      const manualOk = refitToContent({ animate: false });    // 点「按当前姿势适配」
      await waitFrames(3);
      const after = window.__AILEEN_CONTENT_BOX();
      const row = {
        name: hk.name,
        toggleOk: !!r.ok,
        error: r.error || null,
        autoResized: Math.abs(scaleAfterToggle - scaleBase) > 1e-6,
        scaleBase: Number(scaleBase.toFixed(5)),
        scaleAfterToggle: Number(scaleAfterToggle.toFixed(5)),
        beforeClipped: before ? before.clipped : null,
        rawClipped: raw ? raw.clipped : null,
        manualOk: !!manualOk,
        afterClipped: after ? after.clipped : null,
        beforeBox: before ? before.box : null,
        afterBox: after ? after.box : null,
        stage: after ? after.stage : null,
      };
      rows.push(row);
      if (raw && raw.clipped) { judged = row; break; }        // 找到真会出框的那个就用它判定
    }
    if (!judged) judged = rows[0] || null;
    l2d.clearHotkeys();
    // 还原基准比例 + 用户自己的布局存档（整个测试期间没有写入任何存档）
    Object.assign(hq, hqBackup);
    layoutPersistSuppressed = false;
    savedLayout = null;
    await loadSavedLayout();
    applyModelLayout();
    await waitFrames(2);
    return {
      ok: !!(judged && judged.toggleOk && judged.afterClipped === false && judged.autoResized === false),
      name: judged ? judged.name : null,
      regressionProven: !!(judged && judged.rawClipped === true),   // 证明「不点按钮就会出框」
      judged,
      tried: rows.map((r) => r.name + (r.rawClipped ? '(出框)' : '(未出框)') + '·' + (r.autoResized ? '自动改了' : '没自动改') + '→' + (r.afterClipped ? '手动也裁' : '手动后完整')),
      fitDebug: window.__AILEEN_FIT_DEBUG || null,
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

// ============================================================
// 引擎级自检：证明「参数真的写进模型了」，而不是只看按钮亮没亮。
// 这几个钩子返回的是 core model 里读回来的真实值，自检据此下判断。
// ============================================================

/** ① 按名字写参数 → 用下标读回来，必须是新值（证明 id→下标这条路是通的） */
window.__AILEEN_L2D_TEST_PARAM_WRITE = () => {
  try {
    const cm = coreModelOf();
    const table = l2d.paramTable;
    if (!cm || !table || !table.count) return { ok: false, error: 'no-model' };
    // 挑一个「范围够大、能看出差别」的参数，别挑 0..1 的开关
    let idx = -1;
    for (let i = 0; i < table.count; i += 1) {
      const lo = Number(table.min[i]);
      const hi = Number(table.max[i]);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi - lo >= 5) { idx = i; break; }
    }
    if (idx < 0) return { ok: false, error: 'no-suitable-param' };
    const id = table.ids[idx];
    const before = Number(cm.getParameterValueByIndex(idx));
    const target = Number(table.max[idx]);
    const wrote = l2d.setParamValue(cm, id, target);
    const readBack = Number(cm.getParameterValueByIndex(idx));
    cm.setParameterValueByIndex(idx, before);            // 还原
    return {
      ok: Number.isFinite(readBack) && Math.abs(readBack - target) < 1e-6 && Math.abs(before - target) > 1e-6,
      id, index: idx, before, target, wrote, readBack,
      byIdBroken: Number(cm.getParameterValueById(id)) !== readBack,
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

/** ② 表达式：激活 → 参数真的变成表达式值；关闭 → 参数回到基线（证明 Blend 与还原都对） */
window.__AILEEN_L2D_TEST_EXPRESSION = () => {
  try {
    const cm = coreModelOf();
    const table = l2d.paramTable;
    if (!cm || !table || !table.count) return { ok: false, error: 'no-model' };
    let idx = -1;
    for (let i = 0; i < table.count; i += 1) {
      const lo = Number(table.min[i]);
      const hi = Number(table.max[i]);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi - lo >= 5 && !l2d.baseValues.has(table.ids[i])) { idx = i; break; }
    }
    if (idx < 0) return { ok: false, error: 'no-suitable-param' };
    const id = table.ids[idx];
    const base = Number(cm.getParameterValueByIndex(idx));
    const target = Number(table.max[idx]);
    const file = '__selftest__.exp3.json';
    const hk = { name: '__selftest__', file, supported: true, params: [{ id, value: target, blend: 'Overwrite' }], error: null, warnings: [] };
    l2d.hotkeys.push(hk);
    l2d.active.add(file);
    l2d.apply(cm);
    const applied = Number(cm.getParameterValueByIndex(idx));
    l2d.clearHotkeys();                                   // 关掉 → 应该还原成基线
    const after = Number(cm.getParameterValueByIndex(idx));
    const at = l2d.hotkeys.indexOf(hk);
    if (at >= 0) l2d.hotkeys.splice(at, 1);
    return {
      ok: Math.abs(applied - target) < 1e-6 && Math.abs(after - base) < 1e-6,
      id, index: idx, base, target, applied, after,
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

/** ③ 表达式里带了模型没有的参数 → 必须明确报 missing，不许当成功 */
window.__AILEEN_L2D_TEST_MISSING = async () => {
  try {
    const cm = coreModelOf();
    if (!cm) return { ok: false, error: 'no-model' };
    const file = '__selftest_missing__.exp3.json';
    const hk = { name: '__selftest_missing__', file, supported: true, params: null, error: null, warnings: [] };
    const orig = l2d.loadExpression;
    l2d.loadExpression = async () => ({ ok: true, params: [{ id: '__no_such_param__', value: 1, blend: 'Overwrite' }], warnings: [], error: null });
    const r = await l2d.setHotkeyActive(hk, true, { silent: true });
    l2d.loadExpression = orig;
    l2d.active.delete(file);
    l2d.releaseParameters(hk.params);
    l2d.saveState();                       // 把测试用的激活状态从存档里抹掉
    return { ok: r.ok === false && Array.isArray(r.missing) && r.missing.length === 1, error: r.error || null, missing: r.missing || [] };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

/** ④ 部件：隐藏 → 不透明度 0；恢复 → 回到**原来那个值**（不是一律写 1） */
window.__AILEEN_L2D_TEST_PART_RESTORE = () => {
  try {
    const cm = coreModelOf();
    const list = l2d.parts || [];
    if (!cm || !list.length) return { ok: false, error: 'no-parts' };
    // 挑一个当前不透明度不是 1 的部件最能说明问题；没有就随便挑一个
    let pick = null;
    for (const p of list) {
      const o = readPartOpacityCm(cm, p.index);
      if (o !== null && o < 0.99) { pick = { part: p, original: o }; break; }
    }
    if (!pick) pick = { part: list[0], original: readPartOpacityCm(cm, list[0].index) };
    const p = pick.part;
    const h = l2d.hidePart(p, { silent: true });
    const hidden = readPartOpacityCm(cm, p.index);
    const s = l2d.showPart(p);
    const restored = readPartOpacityCm(cm, p.index);
    return {
      ok: h.ok === true && hidden === 0 && Math.abs(restored - (pick.original === null ? 1 : pick.original)) < 1e-6,
      id: p.id, label: p.label || p.name, original: pick.original, hidden, restored, restore: s.restored,
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

/**
 * 「打开时不要自动适配」的引擎级验证。
 *
 * 用户明确要求：打开展台不要重新算比例。所以打开走「按存档恢复」这条路：
 * 不测量、不重算，直接把上次的比例和位置套上去。
 * 这里模拟一次打开（清掉内存里的存档 → 重新从设置文件读 → 应用），要求：
 *   ① 真的走的是恢复路径（回归到存档里的 scale）
 *   ② **没有触发测量**（fitMeasureCount 不变）—— 这条才是「不自动适配」的硬证据
 */
window.__AILEEN_L2D_TEST_LAYOUT_RESTORE = async () => {
  try {
    if (!modelObj) return { ok: false, error: 'no-model' };
    const before = { scale: modelObj.scale.x, x: modelObj.position.x, y: modelObj.position.y };
    // ① 先用当前状态写一条存档（相当于用户上次调好的样子）
    scheduleLayoutSave(0);
    await waitFrames(3);
    if (!savedLayout) return { ok: false, error: 'no-saved-layout' };
    const saved = { scale: savedLayout.scale, fx: savedLayout.fx, fy: savedLayout.fy };
    // ② 把模型改成一个明显不同的比例（模拟「刚打开、比例还没摆」）
    applyTransformNow(before.scale * 0.6, before.x, before.y);
    const measures0 = fitMeasureCount;
    // ③ 模拟打开：清掉内存 → 从设置文件重新读 → 应用
    savedLayout = null;
    await loadSavedLayout();
    const restored = applyModelLayout();
    await waitFrames(2);
    const measures = fitMeasureCount - measures0;
    const after = { scale: modelObj.scale.x, x: modelObj.position.x, y: modelObj.position.y };
    const close = (a, b) => Math.abs(a - b) < 1e-6;
    return {
      ok: !!restored && measures === 0 && close(after.scale, saved.scale),
      restored: !!restored,
      measures,
      savedScale: saved.scale,
      scaleBeforeDisturb: before.scale,
      scaleAfterRestore: after.scale,
      posAfter: [Math.round(after.x), Math.round(after.y)],
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

/** ⑤ 状态持久化：存一次 → 读回来一致；换模型必须清空（不能串味） */
window.__AILEEN_L2D_TEST_STATE = async () => {
  try {
    const out = { modelUrl: l2d.modelUrl, stateId: l2d.stateId ? l2d.stateId() : null, hasStore: true };
    const saved = await l2d.readState();
    out.saved = saved;
    const beforeActive = [...l2d.active];
    const beforeHidden = [...l2d.hiddenParts.keys()];
    l2d.saveState();
    const again = await l2d.readState();
    out.roundTrip = JSON.stringify(again.activeExpressions.slice().sort()) === JSON.stringify(beforeActive.slice().sort())
      && JSON.stringify(again.hiddenParts.slice().sort()) === JSON.stringify(beforeHidden.slice().sort());
    out.ok = out.roundTrip === true;
    return out;
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

/**
 * 「下次打开还记不记得」的引擎级验证（这一版修的真 bug）。
 *
 * 背景：模型 URL 里带本地静态服务的端口，而端口是每次启动随机分配的（listen(0)）。
 * 以前拿整个 URL 当 localStorage 键 → 每次开应用都是一份新存档，
 * 用户看到的就是「热键状态记不住、时好时坏」。
 * 现在键用相对 models/ 的稳定路径，并且能迁移带端口的老存档。
 *
 * 验证三件事：① 存档键里不能有端口；② 模拟重开应用后状态要回来；
 * ③ 把存档改名成「带假端口的老键」再 load，也要能迁移回来（老用户存档不能丢）。
 */
window.__AILEEN_L2D_TEST_PERSIST = async () => {
  try {
    const cm = coreModelOf();
    const list = (l2d.hotkeys || []).filter((h) => h.supported && h.kind === 'toggle-expression');
    if (!cm || !list.length) return { ok: false, error: 'no-model-or-hotkey' };
    const hk = list.find((h) => /school uniform/i.test(h.name)) || list[0];
    const key = l2d.modelKey || '';
    const url = l2d.modelUrl;
    const model = { url, key, name: (currentModel && currentModel.name) || '' };

    // ① 打开一个热键 → 存档
    l2d.clearHotkeys();
    const opened = await l2d.setHotkeyActive(hk, true);
    const savedId = l2d.stateId();
    const keyHasPort = /:\d{2,5}\//.test(String(savedId)) || /:\d{2,5}\//.test(String(key));

    // ② 模拟重开应用：清空内存 → 用同一个模型重新 load
    l2d.reset();
    await l2d.load(model, cm);
    const restoredAfterReload = l2d.active.has(hk.file);

    // ③ 模拟老存档（键里带随机端口）→ 必须迁移回来，且老键被清掉。
    // 自己写老键（状态取自 durable 的 readState），不依赖 localStorage 里原来有没有东西。
    let restoredFromLegacy = false;
    let legacySkipped = false;
    try {
      const state = await l2d.readState();
      const legacyKey = 'aileen.live2d.v2.http://127.0.0.1:6553/models/' + key;
      localStorage.removeItem('aileen.live2d.v2.' + savedId);
      localStorage.setItem(legacyKey, JSON.stringify({ version: 2, activeExpressions: state.activeExpressions, hiddenParts: state.hiddenParts }));
      l2d.clearHotkeys();
      l2d.reset();
      await l2d.load(model, cm);
      restoredFromLegacy = l2d.active.has(hk.file) && localStorage.getItem(legacyKey) === null;
    } catch (err) { legacySkipped = true; /* 隐私模式写不进 localStorage */ }

    l2d.clearHotkeys();
    return {
      ok: !!opened.ok && !keyHasPort && restoredAfterReload && (restoredFromLegacy || legacySkipped),
      name: hk.name,
      savedId,
      keyHasPort,
      restoredAfterReload,
      restoredFromLegacy,
      legacySkipped,
    };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

// 窗口尺寸变了：**只重排画布 + 模型位置/缩放，绝不重建模型**。
// 以前这里是 `renderStage(currentModel)` —— 每改一次尺寸、每次跨屏 DPI 变化都把角色
// 重新加载一遍：动作、表情、口型全断（用户原话「每次移动位置模型都会重置」）。
// 换了引擎之后同样只有这一条路：live2d 布局是纯几何的，重排是毫秒级的。
let stageResizeTimer = null;
window.addEventListener('resize', () => {
  reportHitArea();
  if (!currentModel) return;
  if (stageResizeTimer) clearTimeout(stageResizeTimer);
  stageResizeTimer = setTimeout(() => {
    stageResizeTimer = null;
    syncStageSize(true);
  }, 60);
});
window.addEventListener('load', reportHitArea);
setTimeout(reportHitArea, 400);

init().catch((err) => console.error('[overlay] init failed', err));
