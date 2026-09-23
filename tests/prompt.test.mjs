// 人格提示词回归测试：
// 1) 必须来自角色卡（简介 / 性格 / 场景 / 示例），不是软件自带的通用人格
// 2) 必须跟随界面语言，切了语言不能让角色继续说中文
import { describe, it, expect, beforeEach } from 'vitest';
import { buildSystemPrompt } from '../src/lib/characters.js';
import { setLang } from '../src/lib/i18n.js';

const card = {
  name: '洛',
  description: '一只慵懒的黑猫娘',
  personality: '说话慢悠悠，喜欢用省略号，偶尔毒舌',
  scenario: '深夜的网吧包间',
  mes_example: '洛：……你又在熬夜。',
  system_prompt: '',
};

describe('buildSystemPrompt', () => {
  beforeEach(() => setLang('en'));

  it('把角色卡的人设全部带进提示词', () => {
    const p = buildSystemPrompt(card);
    expect(p).toContain('洛');
    expect(p).toContain('一只慵懒的黑猫娘');
    expect(p).toContain('说话慢悠悠');
    expect(p).toContain('深夜的网吧包间');
    expect(p).toContain('……你又在熬夜');
  });

  it('卡片自带 system_prompt 时整段优先', () => {
    const p = buildSystemPrompt({ ...card, system_prompt: '  只许喵喵叫  ' });
    expect(p).toBe('只许喵喵叫');
  });

  it('提示词跟随界面语言（英文）', () => {
    setLang('en');
    const p = buildSystemPrompt(card);
    expect(p).toContain('never mention that you are an AI');
  });

  it('提示词跟随界面语言（日文）', () => {
    setLang('ja');
    const p = buildSystemPrompt(card);
    expect(p).toContain('言語モデル');
  });

  it('提示词跟随界面语言（中文）', () => {
    setLang('zh');
    const p = buildSystemPrompt(card);
    expect(p).toContain('不要提及自己是一个 AI 模型');
  });

  it('没有选中角色卡时退化为中性人格，而不是空提示词', () => {
    setLang('en');
    const p = buildSystemPrompt(null);
    expect(p.length).toBeGreaterThan(20);
    expect(p).toContain('AILEEN');
  });
});
