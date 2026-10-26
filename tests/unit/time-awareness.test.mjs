import { describe, it, expect } from 'vitest';
import { buildTimeAwareness } from '../../src/context/engine.js';

const at = (iso) => new Date(iso);

describe('时间感知：buildTimeAwareness', () => {
  it('中文：日期、星期、时间、时段都有', () => {
    const s = buildTimeAwareness(at('2026-10-26T09:05:00'), 'zh');
    expect(s).toContain('2026-10-26');
    expect(s).toContain('星期一'.replace('一', ['日', '一', '二', '三', '四', '五', '六'][new Date('2026-10-26T09:05:00').getDay()]));
    expect(s).toContain('09:05');
    expect(s).toMatch(/上午|中午|下午|早上/);
  });

  it('时段跟着小时变', () => {
    const h = (n) => buildTimeAwareness(new Date(2026, 9, 26, n, 0, 0), 'zh');
    expect(h(3)).toContain('凌晨');
    expect(h(9)).toContain('上午');
    expect(h(12)).toContain('中午');
    expect(h(15)).toContain('下午');
    expect(h(20)).toContain('晚上');
    expect(h(23)).toContain('深夜');
  });

  it('日语 / 英语各自成形（不是中文直接搬过去）', () => {
    const ja = buildTimeAwareness(new Date(2026, 9, 26, 9, 5), 'ja');
    expect(ja).toMatch(/2026-10-26/);
    expect(ja).toMatch(/月|火|水|木|金|土|日/);
    expect(ja).toContain('09:05');
    const en = buildTimeAwareness(new Date(2026, 9, 26, 21, 5), 'en');
    expect(en).toMatch(/It is now 2026-10-26/);
    expect(en).toMatch(/evening|afternoon/);
  });

  it('坏时间不抛错（退回当前时间）', () => {
    for (const bad of [undefined, null, 'x', new Date('nope')]) {
      const s = buildTimeAwareness(bad, 'zh');
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(5);
    }
  });
});
