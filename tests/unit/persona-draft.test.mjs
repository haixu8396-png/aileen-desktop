// ============================================================
// R4 单测：结构化人设草稿（来源 / 事实分级 / 版权自检 / 字段重生成提示词）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  buildDraftMessages, parsePersonaDraft, copyrightWarning,
  formatSourcesForPrompt, DRAFT_FIELDS,
} from '../../src/lib/persona.js';

function draftJson(over = {}) {
  return JSON.stringify(Object.assign({
    name: '博丽灵梦',
    work: '东方 Project',
    identity: { work: '东方 Project', role: '巫女', world: '幻想乡' },
    personality: { traits: ['懒散', '认真起来很强'], flaws: ['贪财'], values: ['平衡'] },
    language: { tone: '随性', formality: 'casual', length: 'medium' },
    address: { selfName: '我', userTerm: '你' },
    catchphrases: [{ text: '真是的，麻烦死了。', scenes: ['angry'] }],
    emotions: [{ emotion: 'angry', triggers: '被硬塞工作', expression: 'Angry' }],
    backstory: { story: '守着博丽神社' },
    relationships: { stage: '刚见面', boundaries: '不提异变' },
    habits: ['喝茶', '午睡'],
    interaction: { initiative: 'low', style: '先抱怨再动手' },
    legacy: { description: '懒散的巫女', scenario: '神社', first_mes: '……又是你啊', mes_example: '灵梦: 随便坐。' },
    confidence: {
      confirmedFacts: ['是博丽神社的巫女'],
      secondaryClaims: ['贪财这个说法来自二创'],
      inferences: ['可能不太会照顾自己'],
      unknowns: ['生日'],
    },
  }, over));
}

describe('资料块', () => {
  it('编号 + 标题 + 类型 + URL + 摘要', () => {
    const text = formatSourcesForPrompt([
      { title: '官方角色页', type: 'official', url: 'https://example.com/a', snippet: '她是巫女。' },
    ]);
    expect(text).toContain('[1] 官方角色页');
    expect(text).toContain('official');
    expect(text).toContain('https://example.com/a');
    expect(text).toContain('她是巫女。');
  });

  it('没有资料时是空串（提示词里不能出现空的「已知资料」标题）', () => {
    expect(formatSourcesForPrompt([])).toBe('');
    expect(formatSourcesForPrompt(null)).toBe('');
  });

  it('最多 8 条、每条都有上限（防止把整页塞进提示词）', () => {
    const many = new Array(20).fill(0).map((_, i) => ({ title: 't' + i, snippet: 'x'.repeat(2000) }));
    const text = formatSourcesForPrompt(many);
    expect(text).toContain('[8]');
    expect(text).not.toContain('[9]');
    expect(text.length).toBeLessThan(8 * 900);
  });
});

describe('草稿提示词', () => {
  it('要求 JSON 输出 + 事实分级 + 不编造', () => {
    const msgs = buildDraftMessages({ mode: 'known', charName: '博丽灵梦', work: '东方 Project' });
    const system = msgs[0].content;
    expect(system).toContain('confirmedFacts');
    expect(system).toContain('unknowns');
    expect(system).toContain('不要为了填满字段而编造');
    expect(system).toContain('不得复述原作台词');
    expect(msgs[1].content).toContain('博丽灵梦');
  });

  it('原创模式下给的是灵感，不是「回忆」', () => {
    const msgs = buildDraftMessages({ mode: 'original', seed: '夜班图书管理员' });
    expect(msgs[1].content).toContain('灵感');
    // 没有真实资料块（规则里会提到这四个字，但不该有编号来源）
    expect(msgs[0].content).not.toMatch(/【已知资料】\n\[1\]/);
  });

  it('有资料时才出现资料块', () => {
    const msgs = buildDraftMessages({ mode: 'known', charName: 'x' }, { sources: [{ title: '官方页' }] });
    expect(msgs[0].content).toContain('【已知资料】');
    expect(msgs[0].content).toContain('官方页');
  });
});

describe('草稿解析', () => {
  it('解析出完整草稿：persona / legacy / confidence / 来源', () => {
    const r = parsePersonaDraft(draftJson(), {
      sources: [{ title: '官方角色页', url: 'https://example.com/a', type: 'official' }],
    });
    expect(r.kind).toBe('draft');
    const d = r.draft;
    expect(d.status).toBe('draft');
    expect(d.persona.identity.role).toBe('巫女');
    expect(d.persona.catchphrases[0].text).toContain('麻烦');
    expect(d.legacy.first_mes).toContain('又是你');
    expect(d.confidence.unknowns).toContain('生日');
    expect(d.sourceCharacter.sources).toHaveLength(1);
    expect(d.sourceCharacter.sources[0].type).toBe('official');
    expect(d.sourceCharacter.sources[0].retrievedAt).toBeTruthy();
  });

  it('模型说「不认识」→ unknown（不重试、不硬编）', () => {
    expect(parsePersonaDraft('{"unknown": true}').kind).toBe('unknown');
  });

  it('不是 JSON → bad', () => {
    expect(parsePersonaDraft('我不太确定这个角色').kind).toBe('bad');
    expect(parsePersonaDraft('').kind).toBe('bad');
  });

  it('包在代码围栏里也能解析', () => {
    const r = parsePersonaDraft('```json\n' + draftJson() + '\n```');
    expect(r.kind).toBe('draft');
  });

  it('空草稿（一个字段都没有）判 bad，不返回一张空壳卡', () => {
    expect(parsePersonaDraft('{}').kind).toBe('bad');
  });

  it('草稿字段白名单是稳定的（多出来的字段不会进卡）', () => {
    const r = parsePersonaDraft(draftJson({ hacker: 'DROP TABLE', apiKey: 'sk-x' }));
    expect(r.kind).toBe('draft');
    expect(JSON.stringify(r.draft)).not.toContain('DROP TABLE');
    expect(JSON.stringify(r.draft)).not.toContain('sk-x');
    expect(DRAFT_FIELDS).toContain('confidence');
  });
});

describe('版权自检', () => {
  it('普通对话不报警', () => {
    expect(copyrightWarning('「你好呀。」她笑着说。').ok).toBe(true);
    expect(copyrightWarning('随便一句没有引号的话').ok).toBe(true);
  });

  it('单段引用超过 80 字就报警', () => {
    const long = '「' + '啊'.repeat(120) + '」';
    const r = copyrightWarning(long);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('80');
  });

  it('多段短引用但总量过大也报警', () => {
    const text = '「' + '一'.repeat(80) + '」「' + '二'.repeat(80) + '」「' + '三'.repeat(80) + '」';
    expect(copyrightWarning(text).ok).toBe(false);
  });

  it('解析草稿时会把版权自检结果带上', () => {
    const r = parsePersonaDraft(draftJson({ legacy: { first_mes: '「' + '台'.repeat(150) + '」' } }));
    expect(r.kind).toBe('draft');
    expect(r.draft.copyright.checked).toBe(true);
    expect(r.draft.copyright.ok).toBe(false);
  });
});
