// ============================================================
// Live2D Viewport 纯几何单测
//
// 三条核心性质：
//   1) 百分比按舞台算 → 模型 scale 变化不影响裁切矩形（与缩放彻底分离）
//   2) 四边独立；非法/越界值收敛；两边之和过大时等比压缩
//   3) 命中测试只认可见区域
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  normalizeViewport, viewportRect, viewportClipPath, isInsideViewport, isViewportNeutral,
  VIEWPORT_MAX, VIEWPORT_COMBINED_MAX, describeViewport,
} from '../../src/lib/live2d/viewport.js';
import utilCjs from '../../shared/util.cjs';

const { deepMerge } = utilCjs;

describe('normalizeViewport', () => {
  it('默认关、四边为 0', () => {
    expect(normalizeViewport(null)).toEqual({ enabled: false, top: 0, bottom: 0, left: 0, right: 0 });
    expect(normalizeViewport({})).toEqual({ enabled: false, top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('单边收敛到 0~0.9，非法值按 0', () => {
    const v = normalizeViewport({ enabled: true, top: 5, bottom: -1, left: 'abc', right: 0.2 });
    expect(v.top).toBe(VIEWPORT_MAX);
    expect(v.bottom).toBe(0);
    expect(v.left).toBe(0);
    expect(v.right).toBe(0.2);
  });

  it('上下/左右各自之和过大时等比压缩，不出现 0 或负', () => {
    const v = normalizeViewport({ enabled: true, top: 0.8, bottom: 0.8, left: 0.9, right: 0.9 });
    expect(v.top + v.bottom).toBeCloseTo(VIEWPORT_COMBINED_MAX, 3);
    expect(v.left + v.right).toBeCloseTo(VIEWPORT_COMBINED_MAX, 3);
    expect(v.top).toBeCloseTo(v.bottom, 4);
  });
});

describe('viewportRect', () => {
  it('关闭 / 全 0 → null（不裁）', () => {
    expect(viewportRect(400, 600, { enabled: false, top: 0.12 })).toBeNull();
    expect(viewportRect(400, 600, { enabled: true })).toBeNull();
    expect(isViewportNeutral({ enabled: true })).toBe(true);
  });

  it('顶部裁 12%：y 下移、高度减少，x/宽度不变', () => {
    const r = viewportRect(400, 600, { enabled: true, top: 0.12 });
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo(72, 6);
    expect(r.width).toBeCloseTo(400, 6);
    expect(r.height).toBeCloseTo(528, 6);
  });

  it('四边分别生效', () => {
    const r = viewportRect(1000, 800, { enabled: true, top: 0.1, bottom: 0.2, left: 0.05, right: 0.15 });
    expect(r.x).toBeCloseTo(50, 6);
    expect(r.y).toBeCloseTo(80, 6);
    expect(r.width).toBeCloseTo(800, 6);
    expect(r.height).toBeCloseTo(560, 6);
  });

  it('与模型缩放无关：同一份配置在任意 scale 下算出的矩形完全相同', () => {
    const cfg = { enabled: true, top: 0.12, bottom: 0.03, left: 0.02, right: 0.04 };
    const a = viewportRect(400, 600, cfg);
    // 模型放大 150% / 缩小到 50% 不参与这个函数 —— 矩形只由舞台与配置决定
    const b = viewportRect(400, 600, cfg);
    expect(b).toEqual(a);
  });

  it('尺寸非法时返回 null，不抛错', () => {
    expect(viewportRect(0, 600, { enabled: true, top: 0.1 })).toBeNull();
    expect(viewportRect('x', 600, { enabled: true, top: 0.1 })).toBeNull();
  });
});

describe('命中测试', () => {
  const rect = viewportRect(400, 600, { enabled: true, top: 0.12 });
  it('裁掉的区域不算命中', () => {
    expect(isInsideViewport(rect, 10, 10)).toBe(false);
    expect(isInsideViewport(rect, 10, 100)).toBe(true);
  });
  it('不裁时任何点都算命中', () => {
    expect(isInsideViewport(null, -999, -999)).toBe(true);
  });
});

describe('describeViewport', () => {
  it('关闭/开启各有一句话', () => {
    expect(describeViewport({ enabled: false })).toBe('viewport:off');
    expect(describeViewport({ enabled: true, top: 0.12 })).toContain('top=0.12');
  });
});

// 真正的裁切是画布上的 CSS clip-path（PIXI mask 在这个引擎上静默失效，见 overlay.js 顶部注释）。
// 这里钉住「百分比 → inset 像素」的换算：四边各自独立，且不裁时必须是空串（调用方要清空样式）。
describe('viewportClipPath', () => {
  it('不裁 → 空串（调用方据此清空 clip-path）', () => {
    expect(viewportClipPath(400, 600, { enabled: false })).toBe('');
    expect(viewportClipPath(400, 600, { enabled: true })).toBe('');
    expect(viewportClipPath(0, 600, { enabled: true, top: 0.1 })).toBe('');
  });

  it('只裁上面 12% → inset(72px 0px 0px 0px)', () => {
    expect(viewportClipPath(400, 600, { enabled: true, top: 0.12 })).toBe('inset(72px 0px 0px 0px)');
  });

  it('四边各裁 → 右边/下边按「剩余」算', () => {
    // 1000×800，左 5% 右 15% → 右边剩 800-50-150=... 实际: x=50,w=800 → right=150；上 10% 下 20% → bottom=160
    expect(viewportClipPath(1000, 800, { enabled: true, top: 0.1, bottom: 0.2, left: 0.05, right: 0.15 }))
      .toBe('inset(80px 150px 160px 50px)');
  });

  it('四边之和被压缩时，inset 各边都是正数且总和不超尺寸', () => {
    const clip = viewportClipPath(500, 500, { enabled: true, top: 0.9, bottom: 0.9, left: 0, right: 0 });
    expect(clip.startsWith('inset(')).toBe(true);
    const nums = clip.slice(6, -1).split(' ').map((s) => parseFloat(s));
    expect(nums).toHaveLength(4);
    expect(nums[0] + nums[2]).toBeLessThan(500);
    expect(nums.every((n) => n >= 0)).toBe(true);
  });
});

// 真机踩到过：点「恢复默认」后界面不裁了，但 settings.json 里那条百分比又回来了。
// 根因不是展台，是 writeSettings 走 deepMerge —— 传「少了某个键」的对象等于没删。
// 这两条把「必须用 undefined 删」的语义钉住，避免以后又写回 delete。
describe('删除每模型记录（writeSettings 是 deepMerge）', () => {
  const cur = () => ({ live2dViewport: { byModel: { 'a.model3.json': { enabled: true, top: 0.4 } } } });

  it('置 undefined 才会真的把键删掉', () => {
    const before = cur();
    const next = Object.assign({}, before.live2dViewport.byModel);
    next['a.model3.json'] = undefined;
    const merged = deepMerge(before, { live2dViewport: { byModel: next } });
    // 合并结果里这个键的值是 undefined（不是对象）→ normalize 会跳过它、JSON.stringify 也不会写
    expect(merged.live2dViewport.byModel['a.model3.json']).toBeUndefined();
    expect(JSON.stringify(merged)).not.toContain('a.model3.json');
  });

  it('delete 掉键再合并 = 没删（这就是那个 bug）', () => {
    const before = cur();
    const next = Object.assign({}, before.live2dViewport.byModel);
    delete next['a.model3.json'];
    const merged = deepMerge(before, { live2dViewport: { byModel: next } });
    expect(merged.live2dViewport.byModel['a.model3.json']).toBeTruthy();
  });
});
