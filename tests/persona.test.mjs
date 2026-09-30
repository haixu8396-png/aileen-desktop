// 模型返回的 JSON 从来不可靠 —— 这些用例都是线上真会遇到的形态
import { describe, it, expect } from 'vitest';
import { parsePersonaResponse, PERSONA_FIELDS, personaBudgets, withPersonaBudget } from '../src/lib/persona.js';

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
    expect(r.personality.length).toBe(1200);
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
  it('用户设得很小时，起步就给到 2048（思考很占额度）', () => {
    expect(personaBudgets(0)).toEqual([2048, 4096]);
    expect(personaBudgets(300)).toEqual([2048, 4096]);
  });

  it('用户设得大时，尊重用户的设置并翻倍一次', () => {
    expect(personaBudgets(3000)).toEqual([3000, 6000]);
  });

  it('封顶 8192，且到顶之后不再给第二级', () => {
    expect(personaBudgets(8192)).toEqual([8192]);
    expect(personaBudgets(99999)).toEqual([8192]);
  });

  it('脏值（undefined / NaN / 负数）按 0 处理', () => {
    expect(personaBudgets(undefined)).toEqual([2048, 4096]);
    expect(personaBudgets(NaN)).toEqual([2048, 4096]);
    expect(personaBudgets(-5)).toEqual([2048, 4096]);
  });
});

describe('withPersonaBudget · 额度不够时自动重试', () => {
  const emptyReply = () => { const e = new Error('思考吃光了'); e.code = 'EMPTY_REPLY'; return e; };

  it('第一次思考把额度吃光 → 翻倍再试一次，用户只看到成功', async () => {
    const tried = [];
    const out = await withPersonaBudget(300, async (budget) => {
      tried.push(budget);
      if (budget === 2048) throw emptyReply();
      return 'OK@' + budget;
    });
    expect(tried).toEqual([2048, 4096]);
    expect(out).toBe('OK@4096');
  });

  it('第一次就成功的话不会多花钱', async () => {
    const tried = [];
    await withPersonaBudget(300, async (budget) => { tried.push(budget); return 'ok'; });
    expect(tried).toEqual([2048]);
  });

  it('两次都被吃光 → 抛最后一次的错误（上层会toast给用户看）', async () => {
    const tried = [];
    await expect(withPersonaBudget(2048, async (budget) => { tried.push(budget); throw emptyReply(); }))
      .rejects.toThrow(/思考吃光了/);
    expect(tried).toEqual([2048, 4096]);
  });

  it('其它错误（比如没配 key、HTTP 401）绝不重试', async () => {
    const tried = [];
    const boom = new Error('HTTP 401 unauthorized');
    await expect(withPersonaBudget(2048, async (budget) => { tried.push(budget); throw boom; }))
      .rejects.toThrow(/401/);
    expect(tried).toEqual([2048]);
  });

  it('封顶时只跑一次，不会拿同一个额度重复烧钱', async () => {
    const tried = [];
    await expect(withPersonaBudget(8192, async (budget) => { tried.push(budget); throw emptyReply(); }))
      .rejects.toThrow();
    expect(tried).toEqual([8192]);
  });
});
