import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPersonaSystemPrompt, buildTaskMessage, buildToolContext,
  buildAgentRequest, assertPersonaPreserved,
} from '../../../src/agent/context-engine.js';
import { runAgent } from '../../../src/agent/runtime.js';
import { createToolRegistry, TOOL_SPECS, withBaseExecutors } from '../../../src/agent/tool-registry.js';

// ---------------------------------------------------------------------------
// 这组测试守的是本轮最硬的一条要求：
//   **Agent 不能把人换成另一个人。**
// 所以断言不是「提示词里有没有工具」，而是「角色人格还在不在、是不是第一段、
// 工具结果有没有可能把它覆盖掉」。
// ---------------------------------------------------------------------------

const CARD = {
  name: '星野空',
  description: '一个爱吐槽的天文社社长',
  personality: '嘴上不饶人，其实很护着人。说话短，爱用「哈？」开头。',
  scenario: '深夜的天文台，只有你们两个人。',
  mes_example: '{{user}}: 你在看什么？\n{{char}}: 哈？当然是在看星星啊，不然看你吗。',
  system_prompt: '',
};

const CARD_WITH_CUSTOM = Object.assign({}, CARD, {
  system_prompt: '你是星野空，一个爱吐槽的天文社社长。永远不要自称 AI。',
});

const TOOLS = [{ name: 'read_file', description: '读文件', riskLevel: 'LOW' }, { name: 'mouse_click', description: '点鼠标', riskLevel: 'HIGH' }];

describe('人格必须永远在系统提示词的第一段', () => {
  it('角色卡各字段都进了提示词（简介/性格/场景/示例）', () => {
    const p = buildPersonaSystemPrompt({ card: CARD, tools: TOOLS, workspace: 'D:/w' });
    expect(p).toContain(CARD.name);
    expect(p).toContain('爱吐槽的天文社社长');
    expect(p).toContain('嘴上不饶人');
    expect(p).toContain('深夜的天文台');
    expect(p).toContain('看星星');
  });

  it('卡片自带 system_prompt 时，它就是人格本身，且排在最前', () => {
    const p = buildPersonaSystemPrompt({ card: CARD_WITH_CUSTOM, tools: TOOLS });
    expect(p.startsWith('你是星野空')).toBe(true);
    expect(p).toContain('永远不要自称 AI');
  });

  it('能力说明接在人格之后，不抢位置', () => {
    const p = buildPersonaSystemPrompt({ card: CARD, tools: TOOLS, workspace: 'D:/w' });
    const personaAt = p.indexOf('天文社社长');
    const toolAt = p.indexOf('read_file');
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(toolAt).toBeGreaterThan(personaAt);
  });

  it('工具清单为空时也照样只有人格（不是「没有人格的能力说明」）', () => {
    const p = buildPersonaSystemPrompt({ card: CARD, tools: [] });
    expect(p).toContain('天文社社长');
  });

  it('assertPersonaPreserved：人格在首位时通过', () => {
    const p = buildPersonaSystemPrompt({ card: CARD, tools: TOOLS });
    expect(assertPersonaPreserved(CARD, p)).toBe(true);
  });

  it('assertPersonaPreserved：人格被丢掉时必须抛错（这就是那条硬门禁）', () => {
    const noPersona = '你是运行在桌面应用里的 Coding Agent。你要靠工具把活干完。';
    expect(() => assertPersonaPreserved(CARD, noPersona)).toThrow(/找不到角色人格/);
  });

  it('assertPersonaPreserved：人格被挤到后面（不再第一段）也要抛错', () => {
    const persona = buildPersonaSystemPrompt({ card: CARD, tools: [] });
    const moved = '先是一段别的东西。\n\n' + persona;
    expect(() => assertPersonaPreserved(CARD, moved)).toThrow(/必须是系统提示词的第一段/);
  });

  it('参数为空时拒绝进入 Agent，而不是静默继续', () => {
    // 提示词空 → 直接拒（这时候「人格匹配」是无意义的）
    expect(() => assertPersonaPreserved({ name: 'x', system_prompt: '' }, '')).toThrow(/系统提示词为空/);
    expect(() => assertPersonaPreserved(CARD, null)).toThrow(/系统提示词为空/);
    // 提示词非空但里面没有人格 → 判定「人格被替换」
    expect(() => assertPersonaPreserved(CARD, '你是一个通用助手')).toThrow(/找不到角色人格/);
  });

  it('空卡片会走 i18n 兜底人格，但仍要求它出现在提示词里', () => {
    // 卡片字段都空时 buildSystemPrompt 会给一段通用开场白（不是空串）——
    // 这时候「人格」还在，只是很泛。真正要拦的是「提示词里没有它」。
    const blank = { name: '', system_prompt: '' };
    const p = buildPersonaSystemPrompt({ card: blank, tools: [] });
    expect(p.trim().length).toBeGreaterThan(0);
    expect(() => assertPersonaPreserved(blank, p)).not.toThrow();
    expect(() => assertPersonaPreserved(blank, '另一段完全不相干的提示词')).toThrow(/找不到角色人格/);
  });
});

describe('Context 分层', () => {
  it('buildAgentRequest：system 只有一条，且是人格那条', () => {
    const p = buildPersonaSystemPrompt({ card: CARD, tools: TOOLS });
    const msgs = buildAgentRequest({ systemPrompt: p, history: [{ role: 'user', content: '早' }, { role: 'assistant', content: '哈？' }], taskMessage: '帮我打开浏览器' });
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(msgs[0].content).toContain('天文社社长');
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '帮我打开浏览器' });
  });

  it('buildTaskMessage：任务是任务，工具上下文是工具上下文，人格不参与', () => {
    const t = buildTaskMessage({ task: '帮我打开浏览器搜索 AILEEN', toolContext: '- 屏幕：1920×1080' });
    expect(t).toContain('帮我打开浏览器搜索 AILEEN');
    expect(t).toContain('1920×1080');
    expect(t).not.toContain('天文社');
  });

  it('buildToolContext：只装外部事实（工作区/屏幕/鼠标/窗口）', () => {
    const ctx = buildToolContext({
      workspace: 'D:/w',
      screen: { count: 2, width: 1920, height: 1080 },
      cursor: { x: 100, y: 200, scale: 1.5 },
      windows: ['记事本', 'Chrome'],
    });
    expect(ctx).toContain('D:/w');
    expect(ctx).toContain('1920×1080');
    expect(ctx).toContain('(100, 200)');
    expect(ctx).toContain('Chrome');
    expect(ctx).not.toContain('天文社');
  });
});

// ---------------------------------------------------------------------------
// 真跑一遍循环，验证「工具结果不可能覆盖人格」这条是结构性的
// ---------------------------------------------------------------------------

let workspace;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-persona-'));
  fs.writeFileSync(path.join(workspace, 'a.txt'), '文件内容\n', 'utf8');
});
afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const bridge = {
  readFile: (p, enc) => fs.promises.readFile(p, enc || 'utf8'),
  writeFile: (p, c, enc) => fs.promises.writeFile(p, c, enc || 'utf8'),
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  spawn: async () => ({ done: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) }),
  git: async () => '',
  screenCapture: async () => ({ width: 10, height: 10 }),
  cursor: async () => ({ x: 0, y: 0, scale: 1 }),
};

function registry() {
  const reg = createToolRegistry();
  reg.registerAll(withBaseExecutors(TOOL_SPECS));
  return reg;
}

describe('整轮循环里人格始终在，工具结果只走 tool 消息', () => {
  it('两次请求的 system 都是同一段人格；工具结果出现在 tool 消息里', async () => {
    const seen = [];
    const persona = buildPersonaSystemPrompt({ card: CARD, tools: registry().list(), workspace });
    expect(() => assertPersonaPreserved(CARD, persona)).not.toThrow();

    const script = [
      { text: '哈？我去看看。', toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { text: '哈？文件里就写了一行「文件内容」。', toolCalls: [] },
    ];
    let i = 0;
    const { done } = runAgent({
      task: '看看 a.txt',
      taskMessage: '看看 a.txt（工作区：' + workspace + '）',
      systemPrompt: persona,
      workspace,
      registry: registry(),
      bridge,
      isSensitive: () => false,
      llm: async (params) => {
        seen.push(params.messages);
        const step = script[Math.min(i, script.length - 1)];
        i += 1;
        return step;
      },
    });
    const run = (await done).run;

    // 1) 每次请求都有且只有一条 system，内容就是带人格的那段
    expect(seen.length).toBe(2);
    for (const msgs of seen) {
      const systems = msgs.filter((m) => m.role === 'system');
      expect(systems).toHaveLength(1);
      expect(systems[0].content).toContain('天文社社长');
      expect(systems[0].content.startsWith(persona)).toBe(true);
    }

    // 2) 工具结果只以 tool 消息出现（没有任何「工具内容进了 system」的可能）
    const second = seen[1];
    expect(second.some((m) => m.role === 'tool' && String(m.content).includes('文件内容'))).toBe(true);
    expect(second.filter((m) => m.role === 'system').every((m) => !String(m.content).includes('文件内容'))).toBe(true);

    // 3) 汇报用角色语气（脚本里写的就是角色的说法），run 正常收尾
    expect(run.status).toBe('completed');
    expect(run.answer).toContain('哈？');
  });

  it('没有传 systemPrompt 时退化成纯能力说明（兜底路径，不静默丢人格）', async () => {
    const seen = [];
    let i = 0;
    const { done } = runAgent({
      task: 'x',
      workspace,
      registry: registry(),
      bridge,
      isSensitive: () => false,
      llm: async (params) => {
        seen.push(params.messages);
        i += 1;
        return i === 1 ? { text: 'ok', toolCalls: [] } : { text: 'ok', toolCalls: [] };
      },
    });
    await done;
    expect(seen[0][0].role).toBe('system');
    // 兜底里说的是「你可以使用工具」，而不是某个具体人格
    expect(seen[0][0].content).toContain('工具');
  });
});
