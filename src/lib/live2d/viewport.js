// ============================================================
// Live2D Viewport：显示区域（裁切）的纯几何（渲染层入口）
//
// 规则只有一份：shared/viewport.cjs（主进程也用它做归一化）。
// 这里只做 ESM 再导出，避免两套实现漂移。
// ============================================================
import viewport from '../../../shared/viewport.cjs';

export const VIEWPORT_MAX = viewport.VIEWPORT_MAX;
export const VIEWPORT_COMBINED_MAX = viewport.VIEWPORT_COMBINED_MAX;
export const normalizeViewport = viewport.normalizeViewport;
export const isViewportNeutral = viewport.isViewportNeutral;
export const viewportRect = viewport.viewportRect;
export const viewportClipPath = viewport.viewportClipPath;
export const isInsideViewport = viewport.isInsideViewport;
export const describeViewport = viewport.describeViewport;

export default viewport;
