import { describe, it, expect } from 'vitest';
import {
  extract, shouldRemember, scoreSentence, DECISION_THRESHOLD,
} from '../../../src/memory/extractor.js';

/** 打分助手：把 opts 透传下去（repeats 之类的参数必须能传进来） */
function scoreMap(text, opts = {}) {
  return scoreSentence(text, opts);
}

describe('extraction：值得长期记住的会被提取出来', () => {
  it('偏好似句（中文）→ preference，分数过阈值', () => {
    const out = extract([{ role: 'user', content: '我喜欢初音未来，以后想去 Magical Mirai 现场' }]);
    expect(out.candidates).toHaveLength(1);
    const c = out.candidates[0];
    expect(c.type).toBe('preference');
    expect(c.importance).toBeGreaterThanOrEqual(0.8);
    expect(c.content).toContain('初音未来');
    // reasons 必须说清「为什么存」
    expect(c.reasons.join('|')).toContain('命中原型句式');
    expect(c.reasons.join('|')).toContain('具名实体');
  });

  it('事实似句（中文姓名/地点/生日）→ user_fact', () => {
    const out = extract([{ role: 'user', content: '记住：我叫林小满，2001年3月14日生日，住在杭州' }]);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].type).toBe('user_fact');
    expect(out.candidates[0].importance).toBeGreaterThanOrEqual(DECISION_THRESHOLD);
  });

  it('英文句式（I live in / my name is / I love）也能提取', () => {
    const out = extract([{ role: 'user', content: 'My name is Ken and I live in Osaka, I really like jazz music' }]);
    const texts = out.candidates.map((c) => c.content);
    expect(texts.some((x) => /Ken/.test(x))).toBe(true);
    const fact = out.candidates.find((c) => /Ken/.test(c.content));
    expect(['user_fact', 'preference']).toContain(fact.type);
    expect(fact.importance).toBeGreaterThanOrEqual(DECISION_THRESHOLD);
  });

  it('日文句式（〜が好き / 住んでいます）也能提取', () => {
    const out = extract([{
      role: 'user',
      content: '私は初音ミクが好きです。東京に住んでいます。',
    }]);
    const texts = out.candidates.map((c) => c.content);
    expect(texts.some((x) => x.includes('好き'))).toBe(true);
    expect(texts.some((x) => x.includes('住んで'))).toBe(true);
    const pref = out.candidates.find((c) => c.content.includes('好き'));
    expect(pref.type).toBe('preference');
  });

  it('长期意图 + 型号数字会加权（准备买 RTX 4070）', () => {
    const out = extract([{ role: 'user', content: '我准备买 RTX 4070，等我攒够钱就下单' }]);
    expect(out.candidates).toHaveLength(1);
    const joined = out.candidates[0].reasons.join('|');
    expect(joined).toContain('数值/型号/日期锚点');
    expect(out.candidates[0].importance).toBeGreaterThanOrEqual(0.85);
  });

  it('对话里重复出现的信息会额外加分', () => {
    const once = scoreMap('我最喜欢的乐队是 King Gnu');
    const twice = scoreMap('我最喜欢的乐队是 King Gnu', { repeats: 1 });
    expect(once.score).toBeLessThan(1);
    expect(twice.score).toBeGreaterThan(once.score);
    expect(twice.reasons.join('|')).toContain('重复出现');
  });
});

describe('extraction：寒暄 / 一次性问答 / 情绪宣泄被拒', () => {
  const chitchat = [
    '在吗？', '早上好呀', '谢谢你！', '哈哈哈哈哈', '晚安～',
    '今天天气怎么样？', '现在几点了？', '嗯嗯', '好的好的',
    'hi', 'thanks!', 'おはよう', '今日の天気はどうですか',
  ];

  it.each(chitchat)('「%s」不入库，且理由写清楚', (text) => {
    const decision = shouldRemember(text);
    expect(decision.store).toBe(false);
    expect(decision.score).toBeLessThan(DECISION_THRESHOLD);
    // 理由必须能解释「为什么不记」
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reason).toContain('阈值');
  });

  it('纯情绪宣泄被拒（但不会把「事实」一起误杀）', () => {
    expect(shouldRemember('今天好累啊，烦死了').store).toBe(false);
    // 同一句话里若有稳定事实，仍然要能记下来
    expect(shouldRemember('今天好累，不过我已经搬到上海住了').store).toBe(true);
  });

  it('一轮寒暄对话整体不产出候选，rejected 里留下原因', () => {
    const out = extract([
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的呀' },
      { role: 'user', content: '早上好' },
      { role: 'user', content: '哈哈哈哈' },
      { role: 'user', content: '谢谢你' },
    ]);
    expect(out.candidates).toHaveLength(0);
    expect(out.rejected.length).toBeGreaterThanOrEqual(4);
    expect(out.rejected.every((r) => r.reasons.length > 0)).toBe(true);
  });

  it('助手的话默认不提取（避免把模型的胡说记成用户事实）', () => {
    const out = extract([
      { role: 'assistant', content: '我最喜欢的颜色是蓝色，我住在火星' },
    ]);
    expect(out.candidates).toHaveLength(0);
    // 显式打开时才允许
    const withAssistant = extract([{ role: 'assistant', content: '我住在火星基地' }], { includeAssistant: true });
    expect(withAssistant.candidates).toHaveLength(1);
  });

  it('阈值是公开常量，边界可断言', () => {
    expect(DECISION_THRESHOLD).toBe(0.55);
    expect(shouldRemember('我喜欢猫').score).toBeGreaterThanOrEqual(DECISION_THRESHOLD);
    expect(shouldRemember('好的').score).toBeLessThan(DECISION_THRESHOLD);
  });

  it('同一句话重复出现只产出一条候选（去重）', () => {
    const out = extract([
      { role: 'user', content: '我养了一只猫叫 Luna' },
      { role: 'user', content: '我养了一只猫叫 Luna' },
    ]);
    expect(out.candidates).toHaveLength(1);
  });
});
