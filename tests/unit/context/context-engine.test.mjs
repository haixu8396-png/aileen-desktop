import { describe, it, expect } from 'vitest';
import {
  createContextEngine, assertPersonaFirst,
  LAYER, DEFAULT_BUDGET, estimateTokens, resolveBudget, scoreItem,
} from '../../../src/context/engine.js';
import { trimAll, trimLayer, trimMessages } from '../../../src/context/budget.js';

// ---------------------------------------------------------------------------
// 统一 Context Engine：所有模块的上下文都必须经过这里。
// 这组测试守三件事：
//   1) 人格永远是 system 的第一段（丢了就抛错，不许发出去）；
//   2) 每层有预算，Memory/Knowledge/ToolResult 不能无限注入；
//   3) 每一段都能说出「来自哪里、花了多少 token、被裁了什么」。
// ---------------------------------------------------------------------------

const CARD = {
  name: '星野空',
  description: '一个爱吐槽的天文社社长',
  personality: '嘴上不饶人，其实很护着人。',
  scenario: '深夜的天文台。',
  system_prompt: '',
};

const hist = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: '第' + (i + 1) + '条消息内容',
}));

describe('token 预算', () => {
  it('默认预算覆盖全部层，且总预算大于零', () => {
    expect(DEFAULT_BUDGET.total).toBeGreaterThan(0);
    for (const layer of Object.values(LAYER)) {
      if (layer === LAYER.SYSTEM) continue;
      expect(typeof DEFAULT_BUDGET[layer], layer).toBe('number');
    }
  });
  it('用户覆盖只认已知层，脏值被忽略', () => {
    const b = resolveBudget({ memory: 100, total: 5000, evil: 999, knowledge: -5 });
    expect(b.memory).toBe(100);
    expect(b.total).toBe(5000);
    expect(b.evil).toBeUndefined();
    expect(b.knowledge).toBe(2000);   // 负数不接受，回落默认
  });
  it('estimateTokens 是保守估算（中文 1 字约 1 token）', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('你好世界')).toBe(2);      // 4 字 → 2
    expect(estimateTokens('a'.repeat(100))).toBe(50);
  });
  it('scoreItem 方向正确：相关/重要/新鲜/高置信 分数更高', () => {
    const base = { relevance: 0.5, importance: 0.5, recency: 0.5, confidence: 0.5, priority: 0.5 };
    expect(scoreItem({ ...base, relevance: 0.9 })).toBeGreaterThan(scoreItem(base));
    expect(scoreItem({ ...base, importance: 0.9 })).toBeGreaterThan(scoreItem(base));
    expect(scoreItem({ ...base, recency: 0.9 })).toBeGreaterThan(scoreItem(base));
  });
});

describe('裁剪', () => {
  it('trimLayer 按分数裁，低分的先掉', () => {
    const items = [
      { text: '低分', relevance: 0.1 },
      { text: '高分', relevance: 0.95 },
    ];
    const r = trimLayer(items, 1);   // 每条 2 字 → 1 token，预算 1 只能留一条
    expect(r.kept.map((k) => k.text)).toEqual(['高分']);
    expect(r.dropped[0].text).toBe('低分');
  });
  it('trimLayer 保留原始顺序（裁剪只决定留不留，不重排内容）', () => {
    const items = [
      { text: 'AAA', relevance: 0.3 },
      { text: 'BBB', relevance: 0.9 },
      { text: 'CCC', relevance: 0.6 },
    ];
    const r = trimLayer(items, 100);
    expect(r.kept.map((k) => k.text)).toEqual(['AAA', 'BBB', 'CCC']);
  });
  it('trimLayer 预算为 0 时全裁，且给出原因', () => {
    const r = trimLayer([{ text: 'x' }], 0);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].droppedReason).toBe('no-budget');
  });
  it('trimMessages 从最新往回留，放不下的变占位而不是消失', () => {
    const msgs = hist(10).map((m) => ({ ...m, content: m.content + 'x'.repeat(40) }));
    const r = trimMessages(msgs, 40);   // 一条约 25 token：够放最新那条 + 若干占位
    expect(r.kept.filter((m) => m._omitted).length).toBeGreaterThan(0);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.omitNotice).toContain('已省略');
    expect(String(r.kept[0].content)).toBe('省略');
    expect(r.kept[r.kept.length - 1].content).not.toBe('省略');   // 最新的必须原样
  });
  it('trimMessages：最新那条整条超预算也原样保留（不能把用户刚说的省掉）', () => {
    const msgs = [{ role: 'user', content: 'x'.repeat(2000) }];
    const r = trimMessages(msgs, 10);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].content).toBe('x'.repeat(2000));
  });
  it('受保护层（人格）不受预算影响', () => {
    const long = '人格'.repeat(500);
    const r = trimAll(
      { [LAYER.CHARACTER]: [{ text: long }], [LAYER.MEMORY]: [{ text: 'm' }] },
      resolveBudget({ total: 10, [LAYER.CHARACTER]: 1 }),
      { protectedLayers: [LAYER.CHARACTER] },
    );
    expect(r.layers[LAYER.CHARACTER][0].text).toBe(long);   // 一个字都没掉
    expect(r.descriptors.find((d) => d.layer === LAYER.CHARACTER).protected).toBe(true);
  });
});

describe('人格门禁（硬要求）', () => {
  it('人格为空 → 直接抛错，不组装', async () => {
    const eng = createContextEngine();
    // 注意：空的「字段」会走 i18n 兜底开场白，所以真正会抛的是**提示词为空**
    await expect(eng.buildContext({ card: null, query: 'hi' })).rejects.toThrow(/角色卡/);
    await expect(eng.buildContext({ card: { name: 'x', system_prompt: '' }, query: 'hi', budget: {} }))
      .resolves.toBeTruthy();   // 兜底人格仍在 → 正常组装
    expect(() => assertPersonaFirst('', [{ role: 'system', content: 'x' }])).toThrow(/人格为空/);
  });

  it('assertPersonaFirst：人格不在第一段就抛错', () => {
    const persona = '你是星野空';
    expect(() => assertPersonaFirst(persona, [{ role: 'system', content: '你是星野空，另外…' }])).not.toThrow();
    expect(() => assertPersonaFirst(persona, [{ role: 'system', content: '别的\n你是星野空' }])).toThrow(/第一段/);
    expect(() => assertPersonaFirst(persona, [{ role: 'user', content: '你是星野空' }])).toThrow(/没有 system/);
    expect(() => assertPersonaFirst('', [{ role: 'system', content: 'x' }])).toThrow(/人格为空/);
  });

  it('组装结果里 system 只有一条，且第一段就是人格', async () => {
    const eng = createContextEngine();
    const r = await eng.buildContext({ card: CARD, query: '晚上好', messages: hist(4) });
    const systems = r.messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(systems[0].content.startsWith(r.persona)).toBe(true);
    expect(r.persona).toContain('天文社社长');
  });

  it('走 Agent 时人格仍在第一段，能力说明接在后面', async () => {
    const eng = createContextEngine();
    const r = await eng.buildContext({
      card: CARD,
      query: '打开浏览器',
      messages: hist(2),
      agent: {
        enabled: true,
        task: '打开浏览器搜索 AILEEN',
        workspace: 'D:/w',
        tools: [{ name: 'open_application', description: '打开程序', riskLevel: 'HIGH' }],
      },
    });
    const sys = r.messages.find((m) => m.role === 'system').content;
    expect(sys.startsWith(r.persona)).toBe(true);
    expect(sys.indexOf('open_application')).toBeGreaterThan(sys.indexOf(r.persona));
  });
});

describe('各层注入', () => {
  it('Memory 候选进了上下文，并带上来源与 token 花费', async () => {
    const memory = { search: async () => [{ text: '用户喜欢初音未来', relevance: 0.9, importance: 0.9 }] };
    const eng = createContextEngine({ memory });
    const r = await eng.buildContext({ card: CARD, query: '推荐点歌', messages: hist(2) });
    const sys = r.messages.find((m) => m.role === 'system').content;
    expect(sys).toContain('用户喜欢初音未来');
    const seg = r.segments.find((s) => s.layer === LAYER.MEMORY);
    expect(seg.source).toBe('memory-engine');
    expect(seg.tokenCost).toBeGreaterThan(0);
  });

  it('Knowledge 候选带来源元数据，且 system 里提示要说明出处', async () => {
    const knowledge = { search: async () => [{ text: 'AILEEN 是一个桌面伴侣项目', source: 'readme.md', document_id: 'd1', chunk_id: 'c1' }] };
    const eng = createContextEngine({ knowledge });
    const r = await eng.buildContext({ card: CARD, query: 'AILEEN 是什么', messages: hist(2) });
    const sys = r.messages.find((m) => m.role === 'system').content;
    expect(sys).toContain('AILEEN 是一个桌面伴侣项目');
    expect(sys).toContain('知识库');
  });

  it('检索报错不会让整轮发不出去，而是记进 retrievalErrors', async () => {
    const memory = { search: async () => { throw new Error('后端挂了'); } };
    const eng = createContextEngine({ memory });
    const r = await eng.buildContext({ card: CARD, query: 'hi', messages: hist(2) });
    expect(r.messages.length).toBeGreaterThan(0);
    expect(r.retrievalErrors[0].message).toContain('后端挂了');
  });

  it('工具结果只以消息形式出现，不进 system（结构性保证）', async () => {
    const eng = createContextEngine();
    const r = await eng.buildContext({
      card: CARD,
      query: '看看文件',
      messages: hist(2),
      agent: {
        enabled: true,
        task: '读文件',
        toolResults: [{ role: 'tool', tool_call_id: 'c1', content: '文件内容：SECRET' }],
      },
    });
    const sys = r.messages.find((m) => m.role === 'system').content;
    expect(sys).not.toContain('SECRET');
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('c1');
  });

  it('没有 tool_call_id 的工具结果退化成 user 消息，仍然不进 system', async () => {
    const eng = createContextEngine();
    const r = await eng.buildContext({
      card: CARD,
      query: 'x',
      messages: hist(2),
      agent: { enabled: true, task: 't', toolResults: [{ text: '屏幕摘要：SECRET2' }] },
    });
    const sys = r.messages.find((m) => m.role === 'system').content;
    expect(sys).not.toContain('SECRET2');
    expect(r.messages.some((m) => m.role === 'user' && m.content.includes('SECRET2'))).toBe(true);
  });
});

describe('预算真的生效（不能无限注入）', () => {
  it('Memory 超量时被裁，且报告里说明裁了几条', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      text: '记忆条目 ' + i + '：' + '内容'.repeat(30),
      relevance: 1 - i / 100,
      importance: 0.5,
    }));
    const memory = { search: async () => many };
    const eng = createContextEngine({ memory });
    const r = await eng.buildContext({
      card: CARD, query: 'q', messages: hist(2),
      budget: { total: 4000, [LAYER.MEMORY]: 200 },
    });
    const seg = r.segments.find((s) => s.layer === LAYER.MEMORY);
    expect(seg.tokenCost).toBeLessThanOrEqual(200);
    expect(seg.dropped).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes('memory'))).toBe(true);
  });

  it('Knowledge 超量时也被裁', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ text: '资料 ' + i + '：' + '正文'.repeat(40), relevance: 1 - i / 100 }));
    const knowledge = { search: async () => many };
    const eng = createContextEngine({ knowledge });
    const r = await eng.buildContext({
      card: CARD, query: 'q', messages: hist(2),
      budget: { total: 4000, [LAYER.KNOWLEDGE]: 150 },
    });
    expect(r.segments.find((s) => s.layer === LAYER.KNOWLEDGE).tokenCost).toBeLessThanOrEqual(150);
  });

  it('超长历史被压成占位，总量受控', async () => {
    const eng = createContextEngine();
    const r = await eng.buildContext({
      card: CARD,
      query: 'q',
      messages: hist(200).map((m) => ({ ...m, content: m.content + 'x'.repeat(100) })),
      budget: { total: 3000, [LAYER.RECENT]: 300 },
    });
    const seg = r.segments.find((s) => s.layer === LAYER.RECENT);
    expect(seg.tokenCost).toBeLessThanOrEqual(300);
    expect(r.warnings.some((w) => w.includes('recent'))).toBe(true);
  });

  it('总量不会超过总预算（人格层除外的部分受控）', async () => {
    const eng = createContextEngine({
      memory: { search: async () => Array.from({ length: 30 }, (_, i) => ({ text: 'm' + i + '内容'.repeat(20), relevance: 0.5 })) },
    });
    const r = await eng.buildContext({
      card: CARD, query: 'q', messages: hist(50),
      budget: { total: 5000 },
    });
    // 人格 + 其余各层；这里只断言「非人格部分确实被预算压住了」
    const nonPersona = r.segments.filter((s) => s.layer !== 'character');
    const sum = nonPersona.reduce((n, s) => n + s.tokenCost, 0);
    expect(sum).toBeLessThanOrEqual(5000);
  });
});

describe('报告与可观测性', () => {
  it('每一段都带 source / priority / tokenCost', async () => {
    const eng = createContextEngine({ memory: { search: async () => [{ text: '记得你爱喝咖啡', relevance: 0.8 }] } });
    const r = await eng.buildContext({ card: CARD, query: 'q', messages: hist(4) });
    for (const seg of r.segments) {
      expect(typeof seg.layer).toBe('string');
      expect(typeof seg.source).toBe('string');
      expect(typeof seg.priority).toBe('string');
      expect(typeof seg.tokenCost).toBe('number');
    }
  });
  it('recentUsage 能回答「上下文怎么突然变大了」', async () => {
    const eng = createContextEngine();
    await eng.buildContext({ card: CARD, query: 'a', messages: hist(2) });
    await eng.buildContext({ card: CARD, query: 'b', messages: hist(10) });
    const usage = eng.recentUsage();
    expect(usage).toHaveLength(2);
    expect(usage[1].totalTokens).toBeGreaterThan(usage[0].totalTokens);
  });
});
