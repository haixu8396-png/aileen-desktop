// ============================================================
// 展台「内容适配」的纯数学（可单测，不碰 DOM / WebGL）
//
// 为什么需要它：角色换姿势、拿道具之后，内容包围盒会比默认姿势大一圈
// （实测：默认 344×713 → `Overhead Staff Raise` 之后 597×733，窗口是 656×752），
// 按默认姿势算好的比例再画，道具就会顶出窗口被裁掉 —— 用户看到的就是
// 「拿着一个超出板框的道具，显示不完全」。
//
// 这里的规矩：比例只由「这一次量到的真实内容盒」决定，不是由模型的画布
// 或引擎给的 drawable bounds 决定（这个模型两者都不可信，见 overlay.js 顶部说明）。
// ============================================================

/** 角色占比允许范围（和设置里的 fit × 展台 zoom 保持一致） */
export const FILL_MIN = 0.3;
export const FILL_MAX = 1.25;

export function clampFill(fill) {
  const f = Number(fill);
  if (!Number.isFinite(f)) return 0.95;
  return Math.min(FILL_MAX, Math.max(FILL_MIN, f));
}

/**
 * 由「测量时用的缩放」和「那次测量到的内容盒」算出最终缩放与位置。
 *
 * @param {object} p
 * @param {{x:number,y:number,w:number,h:number}} p.box    测量到的内容盒（CSS 像素，左上原点）
 * @param {number} p.scale0                                测量时用的缩放
 * @param {{w:number,h:number}} p.stage                    窗口（CSS 像素）
 * @param {number} p.fill                                  目标占比（1 = 刚好铺满一个方向）
 * @param {number} [p.offsetY]                             垂直偏移（-0.3~0.3，按窗口高度算）
 * @returns {{scale:number, x:number, y:number, drawn:{w:number,h:number}, factor:number}|null}
 *          factor 就是「相对测量时放大了多少倍」；内容比窗口大时它会 < 1（也就是自动缩小到装得下）
 */
export function fitTransform({ box, scale0, stage, fill, offsetY = 0 }) {
  const b = box || {};
  const st = stage || {};
  const bw = Number(b.w);
  const bh = Number(b.h);
  const sw = Number(st.w);
  const sh = Number(st.h);
  const s0 = Number(scale0);
  if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0 || bh <= 0) return null;
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) return null;
  if (!Number.isFinite(s0) || s0 <= 0) return null;
  const f = clampFill(fill);
  const factor = Math.min((sw * f) / bw, (sh * f) / bh);
  const scale = Math.min(64, Math.max(0.001, s0 * factor));
  const bx = Number(b.x) || 0;
  const by = Number(b.y) || 0;
  const off = Number(offsetY) || 0;
  return {
    scale,
    // 内容盒中心对齐窗口中心（同一坐标系，所以用 factor 缩放偏移）
    x: sw / 2 + (sw / 2 - (bx + bw / 2)) * factor,
    y: sh / 2 + (sh / 2 - (by + bh / 2)) * factor + off * sh,
    drawn: { w: bw * factor, h: bh * factor },
    factor,
  };
}

/**
 * 内容盒超出窗口多少（1 = 刚好铺满，>1 = 会被裁掉）。
 * 用来判断「这一次要不要重新适配」。留了 0.5px 的浮点容差。
 */
export function overflowRatio(box, stage) {
  const bw = Number(box && box.w);
  const bh = Number(box && box.h);
  const sw = Number(stage && stage.w);
  const sh = Number(stage && stage.h);
  if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0 || bh <= 0) return 0;
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) return 0;
  return Math.max(bw / sw, bh / sh);
}
