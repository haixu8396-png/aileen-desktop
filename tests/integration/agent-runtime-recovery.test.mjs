// ============================================================
// Agent Runtime 稳定性：0.7.12 的执行流程修复
//
// 覆盖任务书的测试项：连续工具调用、审批等待、暂停恢复、取消、
// 工具失败、超时、停滞识别、空转（重复调用）检测、动态预算。
//
// 全部用真实文件系统 + 假 LLM，不需要 Electron / 密钥 / 网络。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../../src/agent/runtime.js';
import { createToolRegistry, TOOL_SPECS, withBaseExecutors } from '../../src/agent/tool-registry.js';
import { RUN_STATUS, AGENT_EVENT, AGENT_STATUS } from '../../src/agent/events.js';

let workspace;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-recover-'));
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n关键说明\n', 'utf8');
});
afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const bridge = {
  readFile: (p, enc) => fs.promises.readFile(p, enc || 'utf8'),
  writeFile: (p, c, enc) => fs.promises.writeFile(p, c, enc || 'utf8'),
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  spawn: async () => ({ done: Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }), cancel: () => {} }),
  git: async () => '',
  screenCapture: async () => ({ width: 10, height: 10 }),
};
const isSensitive = (p) => /settings\.json|secret/i.test(p);

function registry() {
  const reg = createToolRegistry();
  reg.registerAll(withBaseExecutors(TOOL_SPECS));
  return reg;
}

/** 每轮按脚本返回的假 LLM */
function scriptedLlm(script) {
  let i = 0;
  return async () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step;
  };
}

const toolCall = (id, name, args) => ({
  text: '',
  toolCalls: [{ id, function: { name, arguments: JSON.stringify(args || {}) } }],
});

const done = { text: '完成了', toolCalls: [] };

describe('连续工具调用（测试 A）', () => {
  it('连续多轮不同工具：每次结果都回给模型，并且继续下一轮', async () => {
    const statuses = [];
    const results = [];
    const { api, done: p } = runAgent({
      task: '连续做三件事',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      maxRounds: 10,
      roundBudget: 10,
      llm: scriptedLlm([
        toolCall('c1', 'list_files', { path: '.' }),
        toolCall('c2', 'read_file', { path: 'README.md' }),
        toolCall('c3', 'git_status', {}),
        done,
      ]),
    });
    api.bus.on(AGENT_EVENT.STATUS, (s) => statuses.push(s.status));
    api.bus.on(AGENT_EVENT.TOOL_RESULT, (r) => results.push(r));
    const run = (await p).run;

    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    // 每一轮的 tool 结果都必须进消息（顺序不能乱）
    const toolMsgs = run.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3']);
    // 阶段事件：执行 / 观察 / 验证 都出现过
    expect(statuses).toContain(AGENT_STATUS.EXECUTING);
    expect(statuses).toContain(AGENT_STATUS.OBSERVING);
    expect(statuses).toContain(AGENT_STATUS.VERIFYING);
  });
});

describe('审批等待不会把任务挂死（测试 E）', () => {
  it('没有任何人点批准时，超时按「拒绝这一次」处理并继续跑完', async () => {
    const notices = [];
    const { api, done: p } = runAgent({
      task: '写文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      approvalTimeoutMs: 80,
      maxRounds: 5,
      roundBudget: 5,
      llm: scriptedLlm([
        toolCall('w1', 'write_file', { path: 'a.txt', content: 'hi' }),
        done,
      ]),
      // 注意：这里**故意不提供 requestApproval**，也不回填 —— 模拟「卡片没挂出来/用户没看见」
    });
    api.bus.on(AGENT_EVENT.NOTICE, (n) => notices.push(n));
    const run = (await p).run;

    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(notices.some((n) => n.code === 'APPROVAL_TIMEOUT')).toBe(true);
    // 被拒绝 → 文件没写，但任务继续走到终答
    expect(fs.existsSync(path.join(workspace, 'a.txt'))).toBe(false);
    expect(run.answer).toBe('完成了');
  });
});

describe('暂停与审批的竞争（测试 F）', () => {
  it('审批中暂停：批准后仍保持 paused，不会被改回 running', async () => {
    let controller = null;
    /** 等审批事件出现后，先 pause 再回填批准 */
    const requestApproval = () => new Promise((resolve) => {
      setTimeout(() => {
        controller.pause();
        controller.resolveApproval(pendingId, true, false);
        resolve({ approved: true });
      }, 20);
      pendingId = 'ap-unknown'; // 占位，真实 id 由事件带出
    });
    let pendingId = '';
    const { api, done: p } = runAgent({
      task: '写文件',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      maxRounds: 5,
      roundBudget: 5,
      llm: scriptedLlm([toolCall('w1', 'write_file', { path: 'p.txt', content: 'x' }), done]),
      requestApproval,
    });
    controller = api;
    api.bus.on(AGENT_EVENT.APPROVAL_REQUEST, (r) => { pendingId = r.id; });
    await new Promise((r) => setTimeout(r, 200));
    const run = api.run;
    // 结果只可能停在 paused（等用户继续），绝不能显示 running
    expect(run.status).toBe(RUN_STATUS.PAUSED);
    expect(run.pauseReason).toBeDefined();
    api.resume();
    await p;
  });
});

describe('空转检测（重复调用）', () => {
  it('同一工具+同参数+同结果连续多次：给出明确提醒，结果里带提示', async () => {
    const notices = [];
    const results = [];
    const { api, done: p } = runAgent({
      task: '原地打转',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      repeatLimit: 3,
      maxRounds: 6,
      roundBudget: 6,
      llm: scriptedLlm([
        toolCall('r1', 'list_files', { path: '.' }),
        toolCall('r2', 'list_files', { path: '.' }),
        toolCall('r3', 'list_files', { path: '.' }),
        toolCall('r4', 'list_files', { path: '.' }),
        done,
      ]),
    });
    api.bus.on(AGENT_EVENT.NOTICE, (n) => notices.push(n));
    api.bus.on(AGENT_EVENT.TOOL_RESULT, (r) => results.push(r));
    await p;

    expect(notices.some((n) => n.code === 'REPEAT_DETECTED')).toBe(true);
    const toolMsgs = api.run.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.some((m) => String(m.content).includes('不要再重复同样的调用'))).toBe(true);
  });
});

describe('停滞看门狗', () => {
  it('长时间没有任何进展：暂停并保存检查点（reason=stalled），不会假装还在跑', async () => {
    const notices = [];
    const checkpoints = [];
    // LLM 永远不返回：模拟「请求挂住」
    const { api, done: p } = runAgent({
      task: '永远不返回的模型',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      stallMs: 120,
      llmTimeoutMs: 5000,
      maxRounds: 3,
      roundBudget: 3,
      // 永远不返回，但遵守 abort（真实链路里 streamChat 也会因 signal 中止而 reject）
      llm: ({ signal }) => new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        if (signal && signal.aborted) { abort(); return; }
        if (signal) signal.addEventListener('abort', abort, { once: true });
      }),
    });
    api.bus.on(AGENT_EVENT.NOTICE, (n) => notices.push(n));
    api.bus.on(AGENT_EVENT.CHECKPOINT, (c) => checkpoints.push(c));
    await new Promise((r) => setTimeout(r, 500));
    expect(notices.some((n) => n.code === 'STALL_SUSPECTED')).toBe(true);
    expect(checkpoints.some((c) => c.reason === 'stalled')).toBe(true);
    expect(api.run.status).toBe(RUN_STATUS.PAUSED);
    expect(api.run.pauseReason).toBe('stalled');
    // 手动收尾，避免挂着的 Promise 影响用例
    api.cancel();
    await p;
  });
});

describe('模型请求超时（测试 H）', () => {
  it('单次 LLM 超过 llmTimeoutMs：run 进 failed，错误说清是超时', async () => {
    const notices = [];
    const { api, done: p } = runAgent({
      task: '模型超时',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      llmTimeoutMs: 80,
      stallMs: 10000,
      maxRounds: 3,
      roundBudget: 3,
      llm: () => new Promise(() => {}),
    });
    api.bus.on(AGENT_EVENT.NOTICE, (n) => notices.push(n));
    const run = (await p).run;
    expect(run.status).toBe(RUN_STATUS.FAILED);
    expect(String(run.error)).toMatch(/超时/);
    expect(notices.some((n) => n.code === 'LLM_TIMEOUT')).toBe(true);
  });
});

describe('工具失败与恢复（测试 D）', () => {
  it('工具抛错：错误原文作为结果回给模型，任务继续而不是中断', async () => {
    const results = [];
    const { api, done: p } = runAgent({
      task: '工具失败后继续',
      workspace,
      registry: registry(),
      bridge: {
        ...bridge,
        readFile: async () => { throw new Error('EACCES: 没有权限'); },
      },
      isSensitive,
      maxRounds: 5,
      roundBudget: 5,
      llm: scriptedLlm([
        toolCall('e1', 'read_file', { path: 'README.md' }),
        done,
      ]),
    });
    api.bus.on(AGENT_EVENT.TOOL_RESULT, (r) => results.push(r));
    const run = (await p).run;
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(results[0].ok).toBe(false);
    const toolMsg = run.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg.content)).toContain('EACCES');
  });
});

describe('动态预算（测试 C）', () => {
  it('打开 autoExtendBudget 且有进展：预算用尽后自动追加，任务能跑完', async () => {
    const notices = [];
    // 每一轮读不同的文件 → 每次都算「真实进展」（不会被空转检测拦下）
    for (let i = 0; i < 6; i += 1) {
      fs.writeFileSync(path.join(workspace, 'f' + i + '.txt'), '内容' + i, 'utf8');
    }
    let calls = 0;
    const script = [];
    for (let i = 0; i < 6; i += 1) script.push(toolCall('x' + i, 'read_file', { path: 'f' + i + '.txt' }));
    script.push(done);
    const { api, done: p } = runAgent({
      task: '复杂任务',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      maxRounds: 2,
      roundBudget: 2,
      autoExtendBudget: true,
      hardRoundCap: 10,
      llm: async () => { calls += 1; return script[Math.min(calls - 1, script.length - 1)]; },
    });
    api.bus.on(AGENT_EVENT.NOTICE, (n) => notices.push(n));
    const run = (await p).run;
    expect(notices.some((n) => n.code === 'BUDGET_EXTENDED')).toBe(true);
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(run.rounds).toBeGreaterThan(2);
  });

  it('没打开 autoExtendBudget：行为与旧版一致（预算用尽 → paused，可继续）', async () => {
    let calls = 0;
    const { api, done: p } = runAgent({
      task: '预算用尽',
      workspace,
      registry: registry(),
      bridge,
      isSensitive,
      maxRounds: 2,
      roundBudget: 2,
      llm: async () => { calls += 1; return toolCall('y' + calls, 'list_files', { path: '.' }); },
    });
    const run = (await p).run;
    expect(run.status).toBe(RUN_STATUS.PAUSED);
    expect(run.pauseReason).toBe('budget');
    expect(api.budget.canContinue).toBe(true);
  });
});

describe('取消（测试 G）', () => {
  it('执行中取消：状态 cancelled，不再执行后续轮次', async () => {
    let calls = 0;
    const { api, done: p } = runAgent({
      task: '取消我',
      workspace,
      registry: registry(),
      bridge: {
        ...bridge,
        readdir: async (dir) => {
          await new Promise((r) => setTimeout(r, 120));
          return fs.promises.readdir(dir, { withFileTypes: true });
        },
      },
      isSensitive,
      maxRounds: 8,
      roundBudget: 8,
      llm: async () => { calls += 1; return toolCall('z' + calls, 'list_files', { path: '.' }); },
    });
    setTimeout(() => api.cancel(), 150);
    const run = (await p).run;
    expect(run.status).toBe(RUN_STATUS.CANCELLED);
    expect(calls).toBeLessThan(8);
  });
});
