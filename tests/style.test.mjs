// 表演风格设置必须真的改变提示词 —— 否则「可调」就是摆设
import { describe, it, expect, beforeEach } from 'vitest';
import { buildStyleInstruction } from '../src/lib/style.js';
import { setLang } from '../src/lib/i18n.js';

const joined = (b) => buildStyleInstruction(b).join('\n');

describe('buildStyleInstruction · 括号动作/心理活动', () => {
  beforeEach(() => setLang('en'));

  it('off：明确要求不要写', () => {
    expect(joined({ narration: 'off' })).toContain('Do NOT write parenthetical asides');
  });

  it('rare：要求极少，且默认应该是没有', () => {
    const s = joined({ narration: 'rare' });
    expect(s).toContain('only rarely');
    expect(s).toContain('Most replies should have none');
  });

  it('natural：允许写，但明确禁止每条都写', () => {
    expect(joined({ narration: 'natural' })).toContain('Not every reply');
  });

  it('rich：放开写，但仍然要求变化（不能一刀切）', () => {
    const s = joined({ narration: 'rich' });
    expect(s).toContain('Write parenthetical asides freely');
    expect(s).toContain('vary them');
  });

  it('四档给出的是四段不同的指令', () => {
    const set = new Set(['off', 'rare', 'natural', 'rich'].map((l) => joined({ narration: l })));
    expect(set.size).toBe(4);
  });

  it('非法值回退到 natural', () => {
    expect(joined({ narration: 'nonsense' })).toBe(joined({ narration: 'natural' }));
    expect(joined({})).toBe(joined({ narration: 'natural' }));
  });
});

describe('buildStyleInstruction · 回复节奏', () => {
  beforeEach(() => setLang('en'));

  it('off：只许发一条，且不给 delay 的用法说明', () => {
    const s = joined({ pacing: 'off' });
    expect(s).toContain('single message');
    expect(s).not.toContain('shape the *rhythm*');
  });

  it('rare：给了节奏说明，但额外加上最多一处', () => {
    const s = joined({ pacing: 'rare' });
    expect(s).toContain('shape the *rhythm*');
    expect(s).toContain('At most one such break');
  });

  it('natural：给了节奏说明，不带额外限制', () => {
    const s = joined({ pacing: 'natural' });
    expect(s).toContain('shape the *rhythm*');
    expect(s).not.toContain('At most one such break');
  });
});

describe('buildStyleInstruction · 跟随界面语言', () => {
  it('中文与日文下用的是各自语言的指令', () => {
    setLang('zh');
    expect(joined({ narration: 'off' })).toContain('不要写括号里的补充');
    setLang('ja');
    expect(joined({ narration: 'off' })).toContain('かっこ書きの補足は書かないでください');
    setLang('en');
  });
});
