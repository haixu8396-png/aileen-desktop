import { describe, it, expect } from 'vitest';
import { fitTransform, clampFill, overflowRatio, FILL_MIN, FILL_MAX } from '../../src/lib/live2d/fit.js';

const STAGE = { w: 656, h: 752 };

describe('fit：clampFill', () => {
  it('收敛到 0.3~1.25，坏值退回默认 0.95', () => {
    expect(clampFill(0.95)).toBe(0.95);
    expect(clampFill(0.1)).toBe(FILL_MIN);
    expect(clampFill(9)).toBe(FILL_MAX);
    expect(clampFill('0.8')).toBe(0.8);
    expect(clampFill(Number.NaN)).toBe(0.95);
    expect(clampFill(undefined)).toBe(0.95);
  });
});

describe('fit：默认姿势', () => {
  // 真机量到的默认姿势：344×713（窗口 656×752），测量时比例 0.05
  const box = { x: 156, y: 19.5, w: 344, h: 713 };

  it('按高的那个方向铺满 fill（0.95）', () => {
    const t = fitTransform({ box, scale0: 0.05, stage: STAGE, fill: 0.95 });
    expect(t).not.toBe(null);
    expect(t.drawn.h).toBeCloseTo(STAGE.h * 0.95, 1);
    expect(t.drawn.w).toBeLessThan(STAGE.w);
    expect(t.scale).toBeGreaterThan(0);
  });

  it('内容盒中心对齐到窗口中心（没有垂直偏移时）', () => {
    const t = fitTransform({ box, scale0: 0.05, stage: STAGE, fill: 0.95 });
    // 测量时是居中放置的，内容盒中心就在窗口中心 → 位置也应该是窗口中心
    expect(t.x).toBeCloseTo(STAGE.w / 2, 1);
    expect(t.y).toBeCloseTo(STAGE.h / 2, 1);
  });

  it('垂直偏移按窗口高度算', () => {
    const a = fitTransform({ box, scale0: 0.05, stage: STAGE, fill: 0.95, offsetY: 0 });
    const b = fitTransform({ box, scale0: 0.05, stage: STAGE, fill: 0.95, offsetY: 0.1 });
    expect(b.y - a.y).toBeCloseTo(STAGE.h * 0.1, 1);
  });
});

describe('fit：拿道具之后（内容变大）', () => {
  // 真机量到「Overhead Staff Raise」：597×733（窗口 656×752）—— 举权杖后左右/上下都顶出去了
  const propBox = { x: 30, y: 4, w: 597, h: 733 };

  it('按更紧的那个方向铺满 fill，另一个方向留白（否则会被裁）', () => {
    const t = fitTransform({ box: propBox, scale0: 0.05, stage: STAGE, fill: 0.95 });
    // 597×733 在 656×752 里：高度更紧，所以高度铺满 95%、宽度只到 ~89%
    expect(t.drawn.h / STAGE.h).toBeCloseTo(0.95, 3);
    expect(t.drawn.w / STAGE.w).toBeLessThan(0.95);
    expect(t.drawn.h).toBeLessThanOrEqual(STAGE.h * 0.95 + 0.5);
  });

  it('算出来的内容一定落在窗口里（fill ≤ 1 时）', () => {
    for (const fill of [0.5, 0.8, 0.95, 1]) {
      const t = fitTransform({ box: propBox, scale0: 0.05, stage: STAGE, fill });
      expect(t.drawn.w).toBeLessThanOrEqual(STAGE.w * fill + 0.5);
      expect(t.drawn.h).toBeLessThanOrEqual(STAGE.h * fill + 0.5);
    }
  });

  it('和默认姿势比，道具状态的比例必须更小（不然就是没适配）', () => {
    const base = fitTransform({ box: { x: 156, y: 19.5, w: 344, h: 713 }, scale0: 0.05, stage: STAGE, fill: 0.95 });
    const prop = fitTransform({ box: propBox, scale0: 0.05, stage: STAGE, fill: 0.95 });
    expect(prop.scale).toBeLessThan(base.scale);
  });
});

describe('fit：边界与兜底', () => {
  it('盒子/窗口无效时返回 null（调用方要退回保守估计，而不是把角色弄丢）', () => {
    const ok = { x: 0, y: 0, w: 100, h: 100 };
    expect(fitTransform({ box: null, scale0: 0.05, stage: STAGE, fill: 0.95 })).toBe(null);
    expect(fitTransform({ box: { x: 0, y: 0, w: 0, h: 100 }, scale0: 0.05, stage: STAGE, fill: 0.95 })).toBe(null);
    expect(fitTransform({ box: ok, scale0: 0.05, stage: { w: 0, h: 752 }, fill: 0.95 })).toBe(null);
    expect(fitTransform({ box: ok, scale0: 0, stage: STAGE, fill: 0.95 })).toBe(null);
    expect(fitTransform({ box: ok, scale0: 0.05, stage: STAGE, fill: 0.95 })).not.toBe(null);
  });

  it('比例被钳在 0.001~64（极端模型不会把画布算成 0 或爆炸）', () => {
    const tiny = fitTransform({ box: { x: 0, y: 0, w: 1e-6, h: 1e-6 }, scale0: 0.05, stage: STAGE, fill: 1 });
    expect(tiny.scale).toBeLessThanOrEqual(64);
    const huge = fitTransform({ box: { x: 0, y: 0, w: 1e9, h: 1e9 }, scale0: 0.05, stage: STAGE, fill: 1 });
    expect(huge.scale).toBeGreaterThanOrEqual(0.001);
  });

  it('内容偏左/偏上时把中心拉回窗口中心', () => {
    const t = fitTransform({ box: { x: 0, y: 0, w: 200, h: 200 }, scale0: 0.05, stage: STAGE, fill: 0.5 });
    expect(t.x).toBeGreaterThan(STAGE.w / 2);   // 内容在左上 → 模型要往右移
    expect(t.y).toBeGreaterThan(STAGE.h / 2);
  });
});

describe('fit：overflowRatio（要不要重新适配）', () => {
  it('刚好铺满 = 1，超出 > 1', () => {
    expect(overflowRatio({ w: 656, h: 752 }, STAGE)).toBeCloseTo(1, 5);
    expect(overflowRatio({ w: 597, h: 733 }, STAGE)).toBeLessThan(1);
    expect(overflowRatio({ w: 900, h: 752 }, STAGE)).toBeGreaterThan(1);
    expect(overflowRatio({ w: 656, h: 1200 }, STAGE)).toBeGreaterThan(1);
  });

  it('坏输入当 0（不触发适配）', () => {
    expect(overflowRatio(null, STAGE)).toBe(0);
    expect(overflowRatio({ w: 0, h: 0 }, STAGE)).toBe(0);
    expect(overflowRatio({ w: 100, h: 100 }, null)).toBe(0);
  });
});
