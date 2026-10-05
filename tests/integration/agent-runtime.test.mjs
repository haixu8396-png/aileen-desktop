import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../../src/agent/runtime.js';
import { createToolRegistry, TOOL_SPECS, withBaseExecutors } from '../../src/agent/tool-registry.js';
import { RUN_STATUS, AGENT_EVENT, AGENT_STATUS } from '../../src/agent/events.js';

// ---------------------------------------------------------------------------
// 用真实文件系统 + 假 LLM 跑完整的 Agent 循环。
// 不需要 Electron、不需要密钥、不联网。
// ---------------------------------------------------------------------------

let workspace;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-run-'));
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n这里有一句关键说明\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'settings.json'), '{"llm":{"apiKey":"safe:v1:secret"}}', 'utf8');
});
afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const bridge = {
  readFile: (p, enc) => fs.promises.readFile(p, enc || 'utf8'),
  writeFile: (p, c, enc) => fs.promises.writeFile(p, c, enc || 'utf8'),
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  spawn: async () => ({
    done: Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }),
    cancel: () => {},
  }),
  git: async () => '',
  screenCapture: async () => ({ width: 10, height: 10 }),
};

/** 设置文件与任何带 secret 的路径算敏感 */
const isSensitive = (p) => /settings\.json|secret/i.test(p);

function registry() {
  const reg = createToolRegistry();
  reg.registerAll(withBaseExecutors(TOOL_SPECS));
  return reg;
}

/** 按脚本逐轮返回的假 LLM（步骤可以是对象，也可以是返回对象的函数） */
function scriptedLlm(script, hooks = {}) {
  let i = 0;
  return async (params) => {
    const step = script[Math.min(i, script.length - 1)];
    if (hooks.onCall) hooks.onCall(i, params);
    i += 1;
    const data = typeof step === 'function' ? step(params) : step;
    const delayMs = (data && data.__delayMs) || hooks.delayMs || 0;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return data;
  };
}

/**
 * 慢桥接：readdir 故意慢 300ms。
 * 这样「工具执行中」是一个足够宽的窗口，测试可以在循环中间按下暂停/取消
 * （真实应用里本来就有这个窗口：读写文件、跑命令都要时间）。
 */
function slowBridge(delayMs = 300) {
  return {
    ...bridge,
    readdir: async (p) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return fs.promises.readdir(p, { withFileTypes: true });
    },
  };
}

const userMsg = (messages) => (Array.isArray(messages) ? messages : [])
  .filter((m) => m && (m.role === 'user' || m.role === 'tool' || m.role === 'assistant'))
  .map((m) => m.content)
  .join('\n');

async function act(done, fn) {
  const api = await done;
  await fn(api);
  return api;
}

describe('Agent 循环：端到端', () => {
  it('executor 的方法名与工具名一一对应（接线自检）', () => {
    const { api } = runAgent({
      task: '接线检查',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: async () => ({ text: 'ok', toolCalls: [] }),
    });
    for (const n of registry().names()) {
      expect(typeof api.executor[n]).toBe('function');
    }
  });
  it('LLM → 工具 → 结果 → LLM → 终答（真读到文件）', async () => {
    const { api, done } = runAgent({
      task: '读一下 README 并总结',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([
        { text: '我先看看 README', toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] },
        { text: 'README 里说：这里有一句关键说明。', toolCalls: [] },
      ]),
    });
    const run = (await done).run;

    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(run.tool_calls).toHaveLength(1);
    expect(run.tool_calls[0].name).toBe('read_file');
    expect(run.tool_calls[0].ok).toBe(true);
    expect(run.answer).toContain('关键说明');
    expect(api.status).toBe(RUN_STATUS.COMPLETED);
  });

  it('第二轮请求里带着上一轮的工具结果（模型真的看得到）', async () => {
    const seen = [];
    const { done } = runAgent({
      task: '读文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
        { text: '看完了', toolCalls: [] },
      ], { onCall: (i, p) => seen.push(p.messages) }),
    });
    await done;
    expect(userMsg(seen[1])).toContain('这里有一句关键说明');
    // 工具结果必须是独立的 tool 消息（provider 认这个格式）
    expect(seen[1].some((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true);
  });

  it('改文件：write_file 真落盘，并记成产物', async () => {
    const { done } = runAgent({
      task: '写一个说明文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      permissionConfig: { requireMedium: false },
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 'w1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'NOTES.md', content: '你好' }) } }] },
        { text: '写好了', toolCalls: [] },
      ]),
    });
    const run = (await done).run;
    expect(fs.readFileSync(path.join(workspace, 'NOTES.md'), 'utf8')).toBe('你好');
    expect(run.artifacts.some((a) => a.path === 'NOTES.md')).toBe(true);
  });

  it('没有工具调用的回答直接收尾（不做多余的请求）', async () => {
    let calls = 0;
    const { done } = runAgent({
      task: '随便聊聊',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([{ text: '不需要动文件', toolCalls: [] }], { onCall: () => { calls += 1; } }),
    });
    const run = (await done).run;
    expect(calls).toBe(1);
    expect(run.answer).toBe('不需要动文件');
  });
});

describe('未知工具与坏参数', () => {
  it('模型编的工具名会回执给它，不会静默死循环', async () => {
    // 三步脚本：编一个不存在的工具 → 换成真工具 → 收尾。
    // 关键断言是「第二次请求里带着『不存在这个工具』的回执」，
    // 所以脚本必须显式写出第二步，不能靠越界重复最后一步。
    const seen = [];
    const { done } = runAgent({
      task: '用不存在的工具',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([
        { text: '我试试', toolCalls: [{ id: 'x1', function: { name: 'teleport', arguments: '{}' } }] },
        { text: '那我换个办法', toolCalls: [{ id: 'x2', function: { name: 'list_files', arguments: '{}' } }] },
        { text: '好了', toolCalls: [] },
      ], { onCall: (i, p) => seen.push(p.messages) }),
    });
    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(seen.length).toBe(3);
    // 第一次请求里只有 system + user
    expect(userMsg(seen[0])).not.toContain('teleport');
    // 第二次请求里必须能看到「不存在这个工具」的回执（模型的纠错依据）
    expect(userMsg(seen[1])).toContain('不存在名为 "teleport" 的工具');
    // 未知工具被记进 tool_calls 且标成失败
    expect(run.tool_calls.some((t) => t.name === 'teleport' && !t.ok)).toBe(true);
    // 真工具照常执行
    expect(run.tool_calls.some((t) => t.name === 'list_files' && t.ok)).toBe(true);
  });

  it('参数不合法时回给模型错误，而不是把 run 打断', async () => {
    const seen = [];
    const { done } = runAgent({
      task: '缺参数的读文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 'b1', function: { name: 'read_file', arguments: '{}' } }] },
        { text: '我补上参数', toolCalls: [] },
      ], { onCall: (i, p) => seen.push(p.messages) }),
    });
    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(userMsg(seen[1])).toContain('参数错误');
  });

  it('工具执行抛错（越界）也变成工具结果回给模型', async () => {
    const seen = [];
    const { done } = runAgent({
      task: '越界读文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 'o1', function: { name: 'read_file', arguments: '{"path":"../../etc/passwd"}' } }] },
        { text: '不能越界，我知道了', toolCalls: [] },
      ], { onCall: (i, p) => seen.push(p.messages) }),
    });
    const run = (await done).run;
    expect(userMsg(seen[1])).toContain('越界');
    expect(run.tool_calls[0].ok).toBe(false);
  });

  it('敏感文件读不了（API Key 不在 Agent 的射程内）', async () => {
    const { done } = runAgent({
      task: '翻一下设置里的密钥',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 's1', function: { name: 'read_file', arguments: '{"path":"settings.json"}' } }] },
        { text: '那我不看了', toolCalls: [] },
      ]),
    });
    const run = (await done).run;
    expect(run.tool_calls[0].ok).toBe(false);
    expect(run.tool_calls[0].error).toMatch(/敏感/);
  });
});

describe('权限与审批', () => {
  it('MEDIUM 工具在默认设置下会先问；批准后执行', async () => {
    const asked = [];
    const { done } = runAgent({
      task: '写文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      requestApproval: async (req) => { asked.push(req); return { approved: true }; },
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"x"}' } }] },
        { text: 'done', toolCalls: [] },
      ]),
    });
    const run = (await done).run;
    expect(asked).toHaveLength(1);
    expect(asked[0].name).toBe('write_file');
    expect(asked[0].riskLevel).toBe('MEDIUM');
    expect(asked[0].preview).toContain('a.txt');
    expect(run.approvals[0].approved).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'a.txt'))).toBe(true);
  });

  it('用户拒绝后：不执行、记下拒绝、并明确告诉模型别重试', async () => {
    const seen = [];
    const { done } = runAgent({
      task: '跑命令',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      requestApproval: async () => ({ approved: false }),
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 'r', function: { name: 'run_command', arguments: '{"command":"npm","args":["test"]}' } }] },
        { text: '那我换个做法', toolCalls: [] },
      ], { onCall: (i, p) => seen.push(p.messages) }),
    });
    const run = (await done).run;
    expect(run.approvals[0].approved).toBe(false);
    expect(run.tool_calls[0].ok).toBe(false);
    expect(userMsg(seen[1])).toContain('拒绝了');
    // 被拒绝的高风险命令没有真的执行
    expect(run.tool_calls.some((t) => t.name === 'run_command' && t.ok)).toBe(false);
  });

  it('HIGH 工具即便被「记住批准」也依然会问', async () => {
    let asks = 0;
    const { done } = runAgent({
      task: '连跑三条命令',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      requestApproval: async () => { asks += 1; return { approved: true, remember: true }; },
      llm: scriptedLlm([
        {
          text: '开始',
          toolCalls: [
            { id: '1', function: { name: 'run_command', arguments: '{"command":"node","args":["--version"]}' } },
            { id: '2', function: { name: 'run_command', arguments: '{"command":"npm","args":["--version"]}' } },
          ],
        },
        { text: '跑完了', toolCalls: [] },
      ]),
    });
    await done;
    expect(asks).toBe(2);
  });

  it('LOW 工具不问', async () => {
    let asks = 0;
    const { done } = runAgent({
      task: '看目录',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      requestApproval: async () => { asks += 1; return { approved: true }; },
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 'l', function: { name: 'list_files', arguments: '{}' } }] },
        { text: '看完了', toolCalls: [] },
      ]),
    });
    await done;
    expect(asks).toBe(0);
  });
});

describe('暂停 / 继续 / 取消', () => {
  // 让每一轮 LLM 慢一点，测试才有机会在循环中间插进去按暂停/取消
  // （真实的流式请求本来就要几百毫秒，这里只是把这个时间窗口显式化）
  const twoStep = (delayMs = 30) => scriptedLlm([
    { text: '', toolCalls: [{ id: '1', function: { name: 'list_files', arguments: '{}' } }] },
    { text: '', toolCalls: [{ id: '2', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
    { text: '完成', toolCalls: [] },
  ], { delayMs });

  async function waitFor(fn, ms = 2000) {
    const start = Date.now();
    for (;;) {
      try {
        if (fn()) return true;
      } catch {
        // run 可能还没建好/已经收尾，继续等
      }
      if (Date.now() - start > ms) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('pause() 之后循环真的停住，resume() 之后接着跑', async () => {
    const { api, done } = runAgent({
      task: '两步活',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: twoStep(),
    });
    await waitFor(() => api.run.tool_calls.length >= 1);
    expect(api.pause()).toBe(true);
    expect(api.run.status).toBe(RUN_STATUS.PAUSED);
    const atPause = api.run.tool_calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(api.run.tool_calls.length).toBe(atPause); // 确实没继续
    expect(api.resume()).toBe(true);
    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(run.tool_calls.length).toBeGreaterThan(atPause);
  });

  it('pause 后 cancel：不会被 resume 救回来，直接进 cancelled', async () => {
    const { api, done } = runAgent({
      task: '两步活',
      workspace,
      registry: registry(),
      bridge: slowBridge(),
      isSensitive,
      llm: twoStep(0),
    });
    // 工具正在执行（慢桥接）——这正是用户按暂停的时刻
    await waitFor(() => api.run.status === RUN_STATUS.RUNNING && api.run.tool_calls.length === 0);
    api.pause();
    api.cancel();
    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.CANCELLED);
    expect(api.resume()).toBe(false);
  });

  it('运行中 cancel：循环停下、不会再执行后续工具、终态是 cancelled', async () => {
    let calls = 0;
    const { api, done } = runAgent({
      task: '很多步',
      workspace,
      registry: registry(),
      bridge: slowBridge(),
      isSensitive,
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: '1', function: { name: 'list_files', arguments: '{}' } }] },
        { text: '不该到这一步', toolCalls: [] },
      ], { onCall: () => { calls += 1; }, delayMs: 0 }),
    });
    await waitFor(() => calls >= 1);
    expect(api.cancel()).toBe(true);
    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.CANCELLED);
    // 取消后不再发起新的 LLM 轮次
    expect(calls).toBe(1);
  });

  it('外部 AbortSignal 也能取消', async () => {
    const ctrl = new AbortController();
    const { done } = runAgent({
      task: '两步活',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      signal: ctrl.signal,
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: '1', function: { name: 'list_files', arguments: '{}' } }] },
        { text: '不该到这一步', toolCalls: [] },
      ]),
    });
    ctrl.abort();
    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.CANCELLED);
  });
});

describe('循环上限与失败', () => {
  it('到轮数上限会停下并给出提示（不会无限循环）', async () => {
    const notices = [];
    const { api, done } = runAgent({
      task: '永远在调工具的模型',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      maxRounds: 3,
      llm: scriptedLlm([{ text: '', toolCalls: [{ id: 'loop', function: { name: 'list_files', arguments: '{}' } }] }]),
    });
    api.bus.on(AGENT_EVENT.NOTICE, (n) => notices.push(n));
    const run = (await done).run;
    expect(run.rounds).toBe(3);
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(notices.some((n) => n.code === 'MAX_ROUNDS')).toBe(true);
  });

  it('LLM 报错：run 进 failed，错误信息保留', async () => {
    const { done } = runAgent({
      task: '会失败的任务',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: async () => { throw Object.assign(new Error('LLM 炸了'), { code: 'HTTP_ERROR' }); },
    });
    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.FAILED);
    expect(run.error).toContain('LLM 炸了');
  });
});

describe('事件流', () => {
  it('run_created / step / tool_call / tool_result / finished 都发出来了', async () => {
    const seen = [];
    const { api, done } = runAgent({
      task: '读文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([
        { text: '看', toolCalls: [{ id: 'c', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
        { text: '看完了', toolCalls: [] },
      ]),
    });
    // 订阅要在循环跑起来之前挂上（runAgent 是同步启动的，所以这里立刻挂）
    for (const type of Object.values(AGENT_EVENT)) api.bus.on(type, (p) => seen.push([type, p]));
    await done;
    const types = seen.map((s) => s[0]);
    expect(types).toContain(AGENT_EVENT.RUN_UPDATED);
    expect(types).toContain(AGENT_EVENT.STEP);
    expect(types).toContain(AGENT_EVENT.TOOL_CALL);
    expect(types).toContain(AGENT_EVENT.TOOL_RESULT);
    expect(types).toContain(AGENT_EVENT.FINISHED);
    // Live2D 要的状态信号也发出来了（但 runtime 不认识 Live2D）
    expect(types).toContain(AGENT_EVENT.STATUS);
    const statuses = seen.filter((s) => s[0] === AGENT_EVENT.STATUS).map((s) => s[1].status);
    expect(statuses).toContain(AGENT_STATUS.THINKING);
    expect(statuses).toContain(AGENT_STATUS.USING_TOOL);
    expect(statuses).toContain(AGENT_STATUS.SUCCESS);
  });

  it('runtime 不 import Live2D / DOM（守护这条边界）', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'agent', 'runtime.js'), 'utf8');
    // 只看 import/require 语句与全局对象用法，避免误伤注释里提到的名字
    expect(src).not.toMatch(/from\s+'[^']*(stage|live2d|oml2d)/i);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bdocument\.|\bwindow\./);
  });
});

describe('approval 回填（内联卡片那条路）', () => {
  it('resolveApproval 能放行等待中的审批', async () => {
    let approvalId = null;
    const { api, done } = runAgent({
      task: '写文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llm: scriptedLlm([
        { text: '', toolCalls: [{ id: 'w', function: { name: 'write_file', arguments: '{"path":"b.txt","content":"y"}' } }] },
        { text: '写好了', toolCalls: [] },
      ]),
    });
    api.bus.on(AGENT_EVENT.APPROVAL_REQUEST, (req) => { approvalId = req.id; });
    const start = Date.now();
    while (!approvalId) {
      if (Date.now() - start > 2000) throw new Error('没等到审批请求');
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(api.run.status).toBe(RUN_STATUS.WAITING_APPROVAL);
    expect(api.resolveApproval(approvalId, true)).toBe(true);
    const run = (await done).run;
    expect(fs.existsSync(path.join(workspace, 'b.txt'))).toBe(true);
    expect(run.approvals[0].approved).toBe(true);
  });
});
