// ============================================================
// 授权模式的端到端：批量审批 / 逐项拒绝 / 参数变化重新审批 /
// 完全信任（含撤销、不可逆操作仍然问）/ 只读并行 / 失败重试 / 步骤校验
//
// 全部用真实文件系统 + 假 LLM，不需要 Electron、不需要密钥。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../../src/agent/runtime.js';
import { createToolRegistry, TOOL_SPECS, withBaseExecutors } from '../../src/agent/tool-registry.js';
import { RUN_STATUS, AGENT_EVENT, createEventBus } from '../../src/agent/events.js';
import { AUTH_MODE, AUTH_SCOPE } from '../../src/agent/authorization.js';

let workspace;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-auth-'));
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello\n', 'utf8');
});
afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const isSensitive = (p) => /settings\.json|secret/i.test(p);

function makeBridge(over = {}) {
  return Object.assign({
    readFile: (p, enc) => fs.promises.readFile(p, enc || 'utf8'),
    writeFile: (p, c, enc) => fs.promises.writeFile(p, c, enc || 'utf8'),
    readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
    spawn: async () => ({ done: Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }), cancel: () => {} }),
    git: async () => '',
    screenCapture: async () => ({ width: 10, height: 10 }),
  }, over);
}

function registry() {
  const reg = createToolRegistry();
  reg.registerAll(withBaseExecutors(TOOL_SPECS));
  return reg;
}

/** 逐轮脚本：每轮可以是一个对象，也可以是函数 */
function scriptedLlm(script) {
  let i = 0;
  return async () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step;
  };
}

const call = (name, args, id) => ({ id, function: { name, arguments: JSON.stringify(args) } });

describe('批量确认（batch）', () => {
  it('一轮里多个需要确认的调用 → 只发一次审批事件，整批放行后全部执行', async () => {
    const bus = createEventBus();
    const requests = [];
    bus.on(AGENT_EVENT.APPROVAL_REQUEST, (r) => requests.push(r));

    const { done } = runAgent({
      task: '一次写两个文件',
      workspace,
      registry: registry(),
      bridge: makeBridge(),
      isSensitive,
      bus,
      authorization: { mode: AUTH_MODE.BATCH, workspace },
      llm: scriptedLlm([
        { text: '', toolCalls: [call('write_file', { path: 'a.txt', content: 'A' }, 'c1'), call('write_file', { path: 'b.txt', content: 'B' }, 'c2')] },
        { text: '写好了', toolCalls: [] },
      ]),
      requestApproval: async () => ({ approved: true }),
    });

    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(requests).toHaveLength(1);            // 关键：只问了一次
    expect(requests[0].batch).toBe(true);
    expect(requests[0].items).toHaveLength(2);
    expect(requests[0].items.map((i) => i.name)).toEqual(['write_file', 'write_file']);
    // 每一项都带指纹、风险与「是否不可逆」，界面上要给用户看的就是这些
    expect(requests[0].items[0].fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(requests[0].items[0].riskLevel).toBe('MEDIUM');
    expect(requests[0].items[0].irreversible).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toBe('B');
  });

  it('逐项拒绝：只执行被批准的那几个，被拒的明确告诉模型别重试', async () => {
    const bus = createEventBus();
    let batchReq = null;
    bus.on(AGENT_EVENT.APPROVAL_REQUEST, (r) => { batchReq = r; });

    const { done } = runAgent({
      task: '批量里拒绝一个',
      workspace,
      registry: registry(),
      bridge: makeBridge(),
      isSensitive,
      bus,
      authorization: { mode: AUTH_MODE.BATCH, workspace },
      llm: scriptedLlm([
        { text: '', toolCalls: [call('write_file', { path: 'keep.txt', content: 'K' }, 'c1'), call('write_file', { path: 'drop.txt', content: 'D' }, 'c2')] },
        { text: '好', toolCalls: [] },
      ]),
      requestApproval: async (req) => {
        // 逐项：第一条批准，第二条拒绝
        const first = req.items[0].id;
        return { decisions: { [first]: true, [req.items[1].id]: false } };
      },
    });

    const run = (await done).run;
    expect(fs.existsSync(path.join(workspace, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'drop.txt'))).toBe(false);
    expect(batchReq.items).toHaveLength(2);
    // 被拒的那条记成「用户拒绝」，模型会收到「别重试」的说明
    const denied = run.tool_calls.find((c) => String(c.args.path) === 'drop.txt');
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe('用户拒绝');
  });

  it('参数变了就是新操作，必须重新审批（批准只对确认过的那一次生效）', async () => {
    const bus = createEventBus();
    const requested = [];
    bus.on(AGENT_EVENT.APPROVAL_REQUEST, (r) => requested.push(r));

    let round = 0;
    const { done } = runAgent({
      task: '先写 A 再写 B',
      workspace,
      registry: registry(),
      bridge: makeBridge(),
      isSensitive,
      bus,
      authorization: { mode: AUTH_MODE.BATCH, workspace },
      llm: async () => {
        round += 1;
        if (round === 1) return { text: '', toolCalls: [call('write_file', { path: 'x.txt', content: '第一版' }, 'c1')] };
        if (round === 2) return { text: '', toolCalls: [call('write_file', { path: 'x.txt', content: '第二版' }, 'c2')] };
        return { text: '完成', toolCalls: [] };
      },
      requestApproval: async () => ({ approved: true }),
    });

    await done;
    // 两次内容不同 → 两次都要问（第二次不能被第一次的批准覆盖）
    expect(requested).toHaveLength(2);
    expect(requested[0].fingerprint).not.toBe(requested[1].fingerprint);
    expect(fs.readFileSync(path.join(workspace, 'x.txt'), 'utf8')).toBe('第二版');
  });
});

describe('完全信任（trust）', () => {
  it('范围内 MEDIUM 自动执行，不再逐次打断', async () => {
    const bus = createEventBus();
    const requested = [];
    bus.on(AGENT_EVENT.APPROVAL_REQUEST, (r) => requested.push(r));

    const { done } = runAgent({
      task: '信任模式下直接写',
      workspace,
      registry: registry(),
      bridge: makeBridge(),
      isSensitive,
      bus,
      authorization: { mode: AUTH_MODE.TRUST, workspace },
      llm: scriptedLlm([
        { text: '', toolCalls: [call('write_file', { path: 'trust.txt', content: 'T' }, 'c1')] },
        { text: '好了', toolCalls: [] },
      ]),
      requestApproval: async () => ({ approved: false }),
    });

    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(requested).toHaveLength(0);            // 一次都没打断
    expect(fs.readFileSync(path.join(workspace, 'trust.txt'), 'utf8')).toBe('T');
  });

  it('高危命令（危险参数）在信任模式下**仍然要问**', async () => {
    const bus = createEventBus();
    const requested = [];
    bus.on(AGENT_EVENT.APPROVAL_REQUEST, (r) => requested.push(r));

    const { done } = runAgent({
      task: '信任模式也不能随便跑高危命令',
      workspace,
      registry: registry(),
      bridge: makeBridge(),
      isSensitive,
      bus,
      authorization: { mode: AUTH_MODE.TRUST, workspace, allowHighRisk: true },
      llm: scriptedLlm([
        { text: '', toolCalls: [call('run_command', { command: 'node', args: ['-e', 'process.exit(1)'] }, 'c1')] },
        { text: '好，那我不跑了', toolCalls: [] },
      ]),
      requestApproval: async () => ({ approved: false }),
    });

    const run = (await done).run;
    expect(requested.length).toBeGreaterThan(0);
    expect(requested[0].irreversible).toBe(true);
    expect(requested[0].riskLevel).toBe('HIGH');
    expect(run.tool_calls.some((c) => c.name === 'run_command' && c.ok === false)).toBe(true);
  });

  it('信任 + allowHighRisk：安全命令自动跑，不再打断', async () => {
    const bus = createEventBus();
    let asked = 0;
    bus.on(AGENT_EVENT.APPROVAL_REQUEST, () => { asked += 1; });

    const { done } = runAgent({
      task: '信任模式下跑个安全命令',
      workspace,
      registry: registry(),
      bridge: makeBridge(),
      isSensitive,
      bus,
      authorization: { mode: AUTH_MODE.TRUST, workspace, allowHighRisk: true },
      llm: scriptedLlm([
        { text: '', toolCalls: [call('run_command', { command: 'npm', args: ['run', 'build'] }, 'c1')] },
        { text: '跑完了', toolCalls: [] },
      ]),
      requestApproval: async () => ({ approved: false }),
    });

    const run = (await done).run;
    expect(asked).toBe(0);
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(run.tool_calls.some((c) => c.name === 'run_command' && c.ok === true)).toBe(true);
  });

  it('运行中撤销信任 → 后续调用退回逐项审批', async () => {
    const bus = createEventBus();
    let asked = 0;
    bus.on(AGENT_EVENT.APPROVAL_REQUEST, () => { asked += 1; });

    let round = 0;
    let apiRef = null;
    const { api, done } = runAgent({
      task: '写到一半撤销信任',
      workspace,
      registry: registry(),
      bridge: makeBridge(),
      isSensitive,
      bus,
      authorization: { mode: AUTH_MODE.TRUST, workspace },
      llm: async () => {
        round += 1;
        if (round === 1) return { text: '', toolCalls: [call('write_file', { path: 't1.txt', content: '1' }, 'c1')] };
        if (round === 2) {
          // 第二轮开始前撤销
          apiRef.setAuthorization({ mode: AUTH_MODE.TRUST, workspace, revokedAt: Date.now() });
          return { text: '', toolCalls: [call('write_file', { path: 't2.txt', content: '2' }, 'c2')] };
        }
        return { text: '完成', toolCalls: [] };
      },
      requestApproval: async () => ({ approved: true }),
    });
    apiRef = api;

    await done;
    expect(asked).toBeGreaterThan(0);                 // 撤销后开始打断
    expect(fs.existsSync(path.join(workspace, 't1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 't2.txt'))).toBe(true); // 批准后照常执行
  });
});

describe('只读并行与失败恢复', () => {
  it('同一轮多个只读工具会并行执行（回填给模型的顺序仍然是调用顺序）', async () => {
    const bus = createEventBus();
    const notices = [];
    bus.on(AGENT_EVENT.NOTICE, (n) => notices.push(n));

    const { done } = runAgent({
      task: '同时读两个文件',
      workspace,
      registry: registry(),
      bridge: makeBridge(),
      isSensitive,
      bus,
      llm: scriptedLlm([
        { text: '', toolCalls: [call('read_file', { path: 'a.txt' }, 'c1'), call('list_files', {}, 'c2')] },
        { text: '都读到了', toolCalls: [] },
      ]),
    });

    const run = (await done).run;
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(notices.some((n) => n.code === 'PARALLEL_READS')).toBe(true);
    // 并行执行完成顺序不保证，但**回填给模型的 tool 消息顺序**必须与调用顺序一致
    const toolMsgs = run.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(toolMsgs).toEqual(['c1', 'c2']);
  });

  it('只读工具失败会有限次自动重试；写操作失败不重试', async () => {
    const bus = createEventBus();
    const retries = [];
    bus.on(AGENT_EVENT.TOOL_RETRY, (r) => retries.push(r));

    let reads = 0;
    const flaky = makeBridge({
      readFile: async (p, enc) => {
        reads += 1;
        if (reads === 1) throw new Error('EAGAIN 暂时读不到');
        return fs.promises.readFile(p, enc || 'utf8');
      },
    });

    const { done } = runAgent({
      task: '读文件（第一次失败）',
      workspace,
      registry: registry(),
      bridge: flaky,
      isSensitive,
      bus,
      maxRetries: 1,
      llm: scriptedLlm([
        { text: '', toolCalls: [call('read_file', { path: 'a.txt' }, 'c1')] },
        { text: '读到了', toolCalls: [] },
      ]),
    });

    const run = (await done).run;
    expect(retries).toHaveLength(1);
    expect(retries[0].attempt).toBe(1);
    // 重试后成功：工具结果里没有失败记录
    expect(run.tool_calls.every((c) => c.ok)).toBe(true);
  });

  it('写文件后会做一次读回校验，内容没落盘时给出提示', async () => {
    const bus = createEventBus();
    const notices = [];
    bus.on(AGENT_EVENT.NOTICE, (n) => notices.push(n));

    // 桥接「写成功但读回来是空的」—— 模拟写到了别处/被别的东西覆盖
    const lying = makeBridge({
      writeFile: async () => {},
      readFile: async () => '（空）',
    });

    const { done } = runAgent({
      task: '写一个文件',
      workspace,
      registry: registry(),
      bridge: lying,
      isSensitive,
      bus,
      authorization: { mode: AUTH_MODE.TRUST, workspace },
      llm: scriptedLlm([
        { text: '', toolCalls: [call('write_file', { path: 'ghost.txt', content: '这一段应该出现' }, 'c1')] },
        { text: '写完了', toolCalls: [] },
      ]),
    });

    await done;
    expect(notices.some((n) => n.code === 'STEP_UNVERIFIED')).toBe(true);
  });
});
