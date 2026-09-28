import { describe, it, expect } from 'vitest';
import { splitForCompaction, buildContextMessages, buildSummaryRequest, summaryKey, formatTimePrefix } from '../src/lib/history.js';

const msg = (role, content, at) => ({ role, content, at });
function convo(turns) {
  const out = [];
  for (let i = 0; i < turns; i += 1) {
    const base = 1730000000000 + i * 60000;
    out.push(msg('user', 'u' + i, base));
    out.push(msg('assistant', 'a' + i, base + 1000));
  }
  return out;
}

describe('splitForCompaction', () => {
  it('轮数不够时不压缩', () => {
    const { older, kept } = splitForCompaction(convo(3), 8);
    expect(older).toHaveLength(0);
    expect(kept).toHaveLength(6);
  });

  it('只保留最近 N 轮，且切点落在 user 上', () => {
    const { older, kept } = splitForCompaction(convo(12), 4);
    expect(kept[0].role).toBe('user');
    expect(kept).toHaveLength(8);
    expect(older).toHaveLength(16);
    expect(older[older.length - 1].role).toBe('assistant');
  });

  it('空数组 / 非法输入安全', () => {
    expect(splitForCompaction([], 5).kept).toEqual([]);
    expect(splitForCompaction(null, 5).older).toEqual([]);
  });
});

describe('buildContextMessages', () => {
  it('只给 user 加时间戳（给 assistant 加会让模型学着带）', () => {
    const out = buildContextMessages({ kept: [msg('user', '早', 1730000000000), msg('assistant', '早呀', 1730000001000)] });
    expect(out[0].content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 早$/);
    expect(out[1].content).toBe('早呀');
  });

  it('摘要作为 system 放在最前面', () => {
    const out = buildContextMessages({ kept: [msg('user', '在吗', 1)], summary: '之前聊过猫。' });
    expect(out[0]).toEqual({ role: 'system', content: '之前聊过猫。' });
    expect(out).toHaveLength(2);
  });

  it('没有摘要时不插空消息', () => {
    const out = buildContextMessages({ kept: [msg('user', 'x', 1)], summary: '   ' });
    expect(out).toHaveLength(1);
  });
});

describe('formatTimePrefix', () => {
  it('YYYY-MM-DD HH:MM 且带尾空格', () => {
    const s = formatTimePrefix(new Date(2026, 8, 24, 9, 5).getTime());
    expect(s).toBe('[2026-09-24 09:05] ');
  });
});

describe('buildSummaryRequest', () => {
  it('按角色排版并带上 system', () => {
    const r = buildSummaryRequest([msg('user', '我喜欢猫'), msg('assistant', '我也喜欢')], 'SYS');
    expect(r.system).toBe('SYS');
    expect(r.body).toContain('User: 我喜欢猫');
    expect(r.body).toContain('Character: 我也喜欢');
  });
});

describe('summaryKey', () => {
  it('内容变了 key 就变，能避免重复总结', () => {
    const a = summaryKey([msg('user', 'a')]);
    const b = summaryKey([msg('user', 'ab')]);
    expect(a).not.toBe(b);
    expect(summaryKey([msg('user', 'a')])).toBe(a);
  });
});
