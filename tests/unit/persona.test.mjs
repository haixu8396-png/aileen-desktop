// 模型返回的 JSON 从来不可靠 —— 这些用例都是线上真会遇到的形态
import { describe, it, expect } from 'vitest';
import { parsePersonaResponse, parsePersonaOutcome, PERSONA_FIELDS, personaBudgets, withPersonaBudget, buildPersonaMessages } from '../../src/lib/persona.js';
import { setLang } from '../../src/lib/i18n.js';

const full = { name: '阿岚', description: '一句话', personality: '你是……', scenario: '场景', first_mes: '你好', mes_example: '阿岚: 嗨\nUser: 嗨' };

describe('parsePersonaResponse · 容错', () => {
  it('干净的 JSON 直接过', () => {
    expect(parsePersonaResponse(JSON.stringify(full))).toEqual(full);
  });

  it('裹在 ```json 围栏里也能过', () => {
    const s = '```json\n' + JSON.stringify(full) + '\n```';
    expect(parsePersonaResponse(s)).toEqual(full);
  });

  it('围栏不带语言标注也能过', () => {
    expect(parsePersonaResponse('```\n' + JSON.stringify(full) + '\n```')).toEqual(full);
  });

  it('前面后面有废话也能过（模型特别爱加）', () => {
    const s = '好的，这是为你设计的角色：\n\n' + JSON.stringify(full) + '\n\n希望你喜欢！';
    expect(parsePersonaResponse(s)).toEqual(full);
  });

  it('字符串里带大括号 / 转义引号，按大括号配平要能正确收尾', () => {
    const tricky = { name: 'A', personality: '你喜欢 {花括号} 和 \\"引号\\"', description: 'd' };
    const s = '前言 ' + JSON.stringify(tricky) + ' 后记 { 这不是 JSON }';
    const r = parsePersonaResponse(s);
    expect(r.name).toBe('A');
    expect(r.personality).toContain('{花括号}');
  });

  it('嵌套对象不会截断', () => {
    const s = '{"name":"N","personality":"P","meta":{"a":{"b":1}}}';
    expect(parsePersonaResponse(s).name).toBe('N');
  });

  it('少给字段时只返回有的，不编造', () => {
    const r = parsePersonaResponse('{"name":"只有名字"}');
    expect(r).toEqual({ name: '只有名字' });
  });

  it('空字符串字段被丢掉', () => {
    const r = parsePersonaResponse('{"name":"N","scenario":"   ","description":"d"}');
    expect(r.scenario).toBeUndefined();
    expect(r.description).toBe('d');
  });

  it('数组会拼成多行，数字/布尔直接忽略', () => {
    const r = parsePersonaResponse('{"name":"N","personality":["第一句","第二句"],"scenario":42,"first_mes":true}');
    expect(r.personality).toBe('第一句\n第二句');
    expect(r.scenario).toBeUndefined();
    expect(r.first_mes).toBeUndefined();
  });

  it('太长的字段会被截断（别让模型灌一篇小作文进来）', () => {
    const r = parsePersonaResponse(JSON.stringify({ name: 'x'.repeat(200), personality: 'y'.repeat(5000) }));
    expect(r.name.length).toBe(40);
    expect(r.personality.length).toBe(2500);   // personality 现在要装 500~1000 字的提示词
  });

  it('救不回来的一律返回 null', () => {
    expect(parsePersonaResponse('')).toBeNull();
    expect(parsePersonaResponse('完全没有大括号')).toBeNull();
    expect(parsePersonaResponse('{ 不是合法 JSON }')).toBeNull();
    expect(parsePersonaResponse('{"name":"N"')).toBeNull();   // 没闭合
    expect(parsePersonaResponse('[1,2,3]')).toBeNull();          // 不是对象
    expect(parsePersonaResponse(null)).toBeNull();
    expect(parsePersonaResponse('{"unknown":"x"}')).toBeNull(); // 一个白名单字段都没有
  });

  it('白名单只有这六个字段', () => {
    expect(PERSONA_FIELDS).toEqual(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']);
  });
});
describe('personaBudgets · 推理模型的额度阶梯', () => {
  it('用户设得很小时，起步就给到 4096（一张卡光正文就 1000+ 字）', () => {
    expect(personaBudgets(0)).toEqual([4096, 8192]);
    expect(personaBudgets(300)).toEqual([4096, 8192]);
  });

  it('用户设得大时，尊重用户的设置并在封顶内翻倍', () => {
    expect(personaBudgets(5000)).toEqual([5000, 8192]);
  });

  it('封顶 8192，且到顶之后不再给第二级', () => {
    expect(personaBudgets(8192)).toEqual([8192]);
    expect(personaBudgets(99999)).toEqual([8192]);
  });

  it('脏值（undefined / NaN / 负数）按 0 处理', () => {
    expect(personaBudgets(undefined)).toEqual([4096, 8192]);
    expect(personaBudgets(NaN)).toEqual([4096, 8192]);
    expect(personaBudgets(-5)).toEqual([4096, 8192]);
  });
});

describe('withPersonaBudget · 额度不够时自动重试', () => {
  const emptyReply = () => { const e = new Error('思考吃光了'); e.code = 'EMPTY_REPLY'; return e; };

  it('第一次思考把额度吃光 → 翻倍再试一次，用户只看到成功', async () => {
    const tried = [];
    const out = await withPersonaBudget(300, async (budget) => {
      tried.push(budget);
      if (budget === 4096) throw emptyReply();
      return 'OK@' + budget;
    });
    expect(tried).toEqual([4096, 8192]);
    expect(out).toBe('OK@8192');
  });

  it('第一次就成功的话不会多花钱', async () => {
    const tried = [];
    await withPersonaBudget(300, async (budget) => { tried.push(budget); return 'ok'; });
    expect(tried).toEqual([4096]);
  });

  it('两次都被吃光 → 抛最后一次的错误（上层会toast给用户看）', async () => {
    const tried = [];
    await expect(withPersonaBudget(4096, async (budget) => { tried.push(budget); throw emptyReply(); }))
      .rejects.toThrow(/思考吃光了/);
    expect(tried).toEqual([4096, 8192]);
  });

  it('JSON 被截断（TRUNCATED_REPLY）也要加大额度重来一次', async () => {
    const tried = [];
    const truncated = () => { const e = new Error('括号没闭合'); e.code = 'TRUNCATED_REPLY'; return e; };
    const out = await withPersonaBudget(300, async (budget) => {
      tried.push(budget);
      if (budget === 4096) throw truncated();
      return 'OK@' + budget;
    });
    expect(tried).toEqual([4096, 8192]);
    expect(out).toBe('OK@8192');
  });

  it('解析不出来但不是截断（UNPARSABLE）→ 不重试，直接失败', async () => {
    const tried = [];
    const bad = () => { const e = new Error('模型在说废话'); e.code = 'UNPARSABLE'; return e; };
    await expect(withPersonaBudget(4096, async (budget) => { tried.push(budget); throw bad(); })).rejects.toThrow(/废话/);
    expect(tried).toEqual([4096]);
  });

  it('其它错误（比如没配 key、HTTP 401）绝不重试', async () => {
    const tried = [];
    const boom = new Error('HTTP 401 unauthorized');
    await expect(withPersonaBudget(4096, async (budget) => { tried.push(budget); throw boom; }))
      .rejects.toThrow(/401/);
    expect(tried).toEqual([4096]);
  });

  it('封顶时只跑一次，不会拿同一个额度重复烧钱', async () => {
    const tried = [];
    await expect(withPersonaBudget(8192, async (budget) => { tried.push(budget); throw emptyReply(); }))
      .rejects.toThrow();
    expect(tried).toEqual([8192]);
  });
});
describe('buildPersonaMessages · 原型锁定', () => {
  it('锁定性格原型 → 硬约束口径，并且带上「怎么演」的具体约束', () => {
    setLang('zh');
    const m = buildPersonaMessages({ personalityId: 'tsundere', lockPersonality: true, seed: '测试' });
    const sys = m[0].content;
    expect(sys).toContain('硬约束');
    expect(sys).not.toContain('参考方向');
    expect(sys).toContain('傲娇');
    expect(sys).toContain('嘴硬');          // 具体约束，不是光有个标签
    expect(sys).not.toContain('冷淡寡言');   // 没选的原型不许混进来
    setLang('en');
  });

  it('不锁 → 还是同一个原型，但口径换成「可以参考」', () => {
    setLang('zh');
    const m = buildPersonaMessages({ personalityId: 'tsundere', lockPersonality: false, seed: '测试' });
    const sys = m[0].content;
    expect(sys).toContain('参考方向');
    expect(sys).not.toContain('硬约束');
    expect(sys).toContain('傲娇');
    setLang('en');
  });

  it('性格 + 身份可以同时锁，顺序稳定', () => {
    setLang('zh');
    const m = buildPersonaMessages({ personalityId: 'kuudere', roleId: 'librarian', seed: '' });
    const sys = m[0].content;
    expect(sys).toContain('性格原型');
    expect(sys).toContain('身份原型');
    expect(sys.indexOf('性格原型')).toBeLessThan(sys.indexOf('身份原型'));
    setLang('en');
  });

  it('名字 / 性别 / 年龄 / 其它要求都变成硬性指定', () => {
    setLang('zh');
    const m = buildPersonaMessages({ name: '沈砚', genderId: 'female', age: '17', extra: '怕打雷', seed: '' });
    const user = m[1].content;
    expect(user).toContain('沈砚');
    expect(user).toContain('女');
    expect(user).toContain('17');
    expect(user).toContain('怕打雷');
    setLang('en');
  });

  it('性别选「不限」时不会写进要求里', () => {
    setLang('zh');
    const m = buildPersonaMessages({ genderId: 'any', seed: 'x' });
    expect(m[1].content).not.toContain('性别');
    setLang('en');
  });

  it('切语言后约束跟着换语言', () => {
    setLang('ja');
    const ja = buildPersonaMessages({ personalityId: 'tsundere', seed: 'x' });
    expect(ja[0].content).toContain('厳守');
    setLang('en');
    const en = buildPersonaMessages({ personalityId: 'tsundere', seed: 'x' });
    expect(en[0].content).toContain('LOCKED');
    setLang('en');
  });

  it('老用法（只给一句字符串）照旧能用 —— 编辑器里那颗快捷生成走的就是它', () => {
    const m = buildPersonaMessages('冷淡一点，别话多');
    expect(m).toHaveLength(2);
    expect(m[1].content).toContain('冷淡一点，别话多');
    expect(m[0].content).not.toContain('硬约束');
  });

  it('两种模式都要求写 500~1000 字的完整提示词', () => {
    setLang('zh');
    for (const opts of [{ seed: 'x' }, { mode: 'known', charName: 'X' }]) {
      const sys = buildPersonaMessages(opts)[0].content;
      expect(sys).toContain('500~1000 字');
      expect(sys).toContain('角色扮演提示词');
    }
    setLang('en');
  });

  it('personality 的字段上限容得下 1000 字（别再被自己截断）', () => {
    const long = '你'.repeat(1000) + '。结尾';
    const card = parsePersonaResponse(JSON.stringify({ name: 'X', personality: long }));
    expect(card.personality.length).toBe(long.length);
    expect(card.personality.endsWith('结尾')).toBe(true);
  });

  it('种子留空时也会给一个具体灵感，不会发空字符串过去', () => {
    const m = buildPersonaMessages({ seed: '   ' });
    expect(m[1].content.length).toBeGreaterThan(20);
    expect(m[1].content).not.toMatch(/灵感：\s*$/m);
  });
});
describe('buildPersonaMessages · 已有角色 / 对话者身份', () => {
  it('已有角色模式：角色名、作品、忠实度，以及「不认识就别编」的协议', () => {
    setLang('zh');
    const m = buildPersonaMessages({ mode: 'known', charName: '凉宫春日', work: '凉宫春日的忧郁', fidelity: 'strict', seed: '' });
    const sys = m[0].content;
    expect(sys).toContain('已有角色');
    expect(sys).toContain('凉宫春日');
    expect(sys).toContain('凉宫春日的忧郁');
    expect(sys).toContain('严格照搬');
    expect(sys).toContain('unknown');        // 不认识时只回 {"unknown": true}
    expect(sys).not.toContain('性格原型');    // 已有角色模式不该再拿原型约束
    setLang('en');
  });

  it('已有角色 + 适度演绎 → 口径明显不同', () => {
    setLang('zh');
    const strict = buildPersonaMessages({ mode: 'known', charName: 'X', fidelity: 'strict' })[0].content;
    const loose = buildPersonaMessages({ mode: 'known', charName: 'X', fidelity: 'loose' })[0].content;
    expect(strict).toContain('严格照搬');
    expect(loose).toContain('补一点细节');
    expect(loose).not.toContain('严格照搬');
    expect(loose).not.toBe(strict);
    setLang('en');
  });

  it('已有角色模式不再需要原型，但关系照样生效', () => {
    setLang('zh');
    const sys = buildPersonaMessages({ mode: 'known', charName: 'X', relationId: 'lover' })[0].content;
    expect(sys).toContain('恋人');
    expect(sys).toContain('对话者');
    setLang('en');
  });

  it('对话者身份会写成硬约束，并带上这层关系该有的语气', () => {
    setLang('zh');
    const m = buildPersonaMessages({ relationId: 'lover', userName: '小满', seed: 'x' });
    const sys = m[0].content;
    expect(sys).toContain('恋人');
    expect(sys).toContain('吃醋');    // 关系自带的具体语气约束，不是光有个标签
    expect(sys).toContain('小满');
    setLang('en');
  });

  it('关系选「不限」时不会写进提示词', () => {
    setLang('zh');
    const sys = buildPersonaMessages({ relationId: 'any', seed: 'x' })[0].content;
    expect(sys).not.toContain('对话者与你的关系');
    setLang('en');
  });

  it('关系也有具体约束数据（不是空壳）', () => {
    const sys = buildPersonaMessages({ relationId: 'spouse', userName: '' })[0].content;
    expect(sys.length).toBeGreaterThan(200);
  });
});

describe('parsePersonaOutcome · 三种结果', () => {
  it('模型回 {"unknown": true} → unknown（而不是「再试一次」）', () => {
    expect(parsePersonaOutcome('{"unknown": true}')).toEqual({ kind: 'unknown' });
    expect(parsePersonaOutcome('好的\n\u0060\u0060\u0060json\n{"unknown":true}\n\u0060\u0060\u0060')).toEqual({ kind: 'unknown' });
  });

  it('正常卡 → card', () => {
    const raw = JSON.stringify({ name: '阿岚', personality: '你是阿岚' });
    const r = parsePersonaOutcome(raw);
    expect(r.kind).toBe('card');
    expect(r.card.name).toBe('阿岚');
  });

  it('垃圾输出 → bad', () => {
    expect(parsePersonaOutcome('我不知道该说什么').kind).toBe('bad');
    expect(parsePersonaOutcome('').kind).toBe('bad');
    expect(parsePersonaOutcome(null).kind).toBe('bad');
  });

  it('字段正文里出现 unknown 这个词，不算「不认识」', () => {
    const raw = JSON.stringify({ name: 'X', personality: '你喜欢 unknown 这个单词，也喜欢 unknown 这种感觉' });
    expect(parsePersonaOutcome(raw).kind).toBe('card');
  });
});
