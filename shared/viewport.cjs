'use strict';
// ============================================================
// Live2D Viewport：显示区域（裁切）的纯几何（CJS 版，主进程也用）
//
// 与 src/lib/live2d/viewport.js 是同一套规则（那份只是 ESM 再导出）。
//   · 只算「窗口里哪一块矩形可见」，完全不碰模型 scale / position
//   · 百分比以舞台（窗口）为基准 → 模型放大/缩小不改变裁切范围
//   · 上下左右可分别裁；默认 0 = 不裁
// ============================================================

const VIEWPORT_MAX = 0.9;
const VIEWPORT_COMBINED_MAX = 0.95;

function num(v, dflt = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(VIEWPORT_MAX, Math.max(0, n));
}

function normalizeViewport(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  let top = num(r.top);
  let bottom = num(r.bottom);
  let left = num(r.left);
  let right = num(r.right);
  if (top + bottom > VIEWPORT_COMBINED_MAX) {
    const k = VIEWPORT_COMBINED_MAX / (top + bottom);
    top *= k; bottom *= k;
  }
  if (left + right > VIEWPORT_COMBINED_MAX) {
    const k = VIEWPORT_COMBINED_MAX / (left + right);
    left *= k; right *= k;
  }
  return {
    enabled: r.enabled === true,
    top: Number(top.toFixed(4)),
    bottom: Number(bottom.toFixed(4)),
    left: Number(left.toFixed(4)),
    right: Number(right.toFixed(4)),
  };
}

function isViewportNeutral(cfg) {
  const v = normalizeViewport(cfg);
  if (!v.enabled) return true;
  return v.top === 0 && v.bottom === 0 && v.left === 0 && v.right === 0;
}

function viewportRect(stageW, stageH, rawCfg) {
  const W = Number(stageW);
  const H = Number(stageH);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return null;
  const v = normalizeViewport(rawCfg);
  if (!v.enabled) return null;
  if (v.top === 0 && v.bottom === 0 && v.left === 0 && v.right === 0) return null;
  const x = v.left * W;
  const y = v.top * H;
  const width = (1 - v.left - v.right) * W;
  const height = (1 - v.top - v.bottom) * H;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/**
 * 直接给画布元素用的 CSS `clip-path: inset(...)`。
 *
 * 为什么裁在画布上、而不是用 PIXI 的 container.mask：
 *   这个 Live2D 引擎（untitled-pixi-live2d-engine）在 mask 下**照常整只画出来** ——
 *   `viewportRoot.mask` 有值、矩形也对，但真机截图里一点没被裁（静默失效，不报错）。
 *   CSS clip-path 由浏览器合成阶段裁，实测有效，而且和引擎渲染管线完全无关。
 *
 * 返回 '' 表示不裁（enabled=false 或四边全 0），调用方要把 clipPath 清空。
 */
function viewportClipPath(stageW, stageH, rawCfg) {
  const rect = viewportRect(stageW, stageH, rawCfg);
  if (!rect) return '';
  const W = Number(stageW);
  const H = Number(stageH);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return '';
  const right = Math.max(0, W - rect.x - rect.width);
  const bottom = Math.max(0, H - rect.y - rect.height);
  const px = (v) => String(Math.round(v * 100) / 100) + 'px';
  return 'inset(' + px(rect.y) + ' ' + px(right) + ' ' + px(bottom) + ' ' + px(rect.x) + ')';
}

function isInsideViewport(rect, x, y) {
  if (!rect) return true;
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
  return px >= rect.x && py >= rect.y && px <= rect.x + rect.width && py <= rect.y + rect.height;
}

function describeViewport(cfg) {
  const v = normalizeViewport(cfg);
  if (!v.enabled) return 'viewport:off';
  return 'viewport:top=' + v.top + ',bottom=' + v.bottom + ',left=' + v.left + ',right=' + v.right;
}

module.exports = {
  VIEWPORT_MAX, VIEWPORT_COMBINED_MAX,
  normalizeViewport, isViewportNeutral, viewportRect, viewportClipPath,
  isInsideViewport, describeViewport,
};
