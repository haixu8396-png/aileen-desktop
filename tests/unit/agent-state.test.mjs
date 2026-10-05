import { describe, it, expect } from 'vitest';
import {
  RUN_STATUS, AGENT_STATUS, AGENT_EVENT, createEventBus, isTerminal,
} from '../../src/agent/events.js';
import {
  createRun, transition, canTransition, recordToolCall, recordApproval,
  addArtifact, snapshot, isFinished, TRANSITIONS,
} from '../../src/agent/state.js';

describe('事件总线', () => {
  it('on 返回取消订阅函数', () => {
    const bus = createEventBus();
    let n = 0;
    const off = bus.on(AGENT_EVENT.TEXT, () => { n += 1; });
    bus.emit(AGENT_EVENT.TEXT, { text: 'a' });
    off();
    bus.emit(AGENT_EVENT.TEXT, { text: 'b' });
    expect(n).toBe(1);
  });
  it('一个订阅者抛错不影响其它订阅者，也不冒出 emit', () => {
    const bus = createEventBus();
    const seen = [];
    bus.on(AGENT_EVENT.STEP, () => { throw new Error('订阅者自己炸了'); });
    bus.on(AGENT_EVENT.STEP, (p) => seen.push(p));
    expect(() => bus.emit(AGENT_EVENT.STEP, { step: 1 })).not.toThrow();
    expect(seen).toHaveLength(1);
  });
  it('终态判定', () => {
    expect(isTerminal(RUN_STATUS.COMPLETED)).toBe(true);
    expect(isTerminal(RUN_STATUS.CANCELLED)).toBe(true);
    expect(isTerminal(RUN_STATUS.RUNNING)).toBe(false);
    expect(isTerminal(RUN_STATUS.WAITING_APPROVAL)).toBe(false);
  });
});

describe('AgentRun 数据模型', () => {
  it('缺少 task 直接拒绝', () => {
    expect(() => createRun({ task: '   ' })).toThrow(/缺少 task/);
  });
  it('字段齐全，初始状态 queued', () => {
    const run = createRun({ task: '改个 bug', workspace: 'D:/w', now: 1000 });
    expect(run.run_id).toMatch(/^run-/);
    expect(run.status).toBe(RUN_STATUS.QUEUED);
    expect(run.workspace).toBe('D:/w');
    expect(run.messages).toEqual([]);
    expect(run.tool_calls).toEqual([]);
    expect(run.approvals).toEqual([]);
    expect(run.artifacts).toEqual([]);
    expect(run.created_at).toBe(1000);
    expect(run.updated_at).toBe(1000);
    expect(run.maxRounds).toBe(20);
  });
  it('maxRounds 收敛到 1~50', () => {
    expect(createRun({ task: 't', maxRounds: 999 }).maxRounds).toBe(50);
    expect(createRun({ task: 't', maxRounds: 0 }).maxRounds).toBe(1);
  });
});

describe('状态机', () => {
  it('合法迁移', () => {
    const run = createRun({ task: 't' });
    transition(run, RUN_STATUS.RUNNING);
    transition(run, RUN_STATUS.WAITING_APPROVAL);
    transition(run, RUN_STATUS.RUNNING);
    transition(run, RUN_STATUS.PAUSED);
    transition(run, RUN_STATUS.RUNNING);
    transition(run, RUN_STATUS.COMPLETED);
    expect(run.status).toBe(RUN_STATUS.COMPLETED);
    expect(isFinished(run)).toBe(true);
  });
  it('paused → completed 必须被拒（没跑完的活不能算完成）', () => {
    const run = createRun({ task: 't' });
    transition(run, RUN_STATUS.RUNNING);
    transition(run, RUN_STATUS.PAUSED);
    expect(() => transition(run, RUN_STATUS.COMPLETED)).toThrow(/非法的状态迁移/);
    expect(run.status).toBe(RUN_STATUS.PAUSED);
  });
  it('queued 不能直接跳到 completed', () => {
    const run = createRun({ task: 't' });
    expect(() => transition(run, RUN_STATUS.COMPLETED)).toThrow();
  });
  it('终态不可逆', () => {
    for (const end of [RUN_STATUS.COMPLETED, RUN_STATUS.FAILED, RUN_STATUS.CANCELLED]) {
      const run = createRun({ task: 't' });
      transition(run, RUN_STATUS.RUNNING);
      transition(run, end);
      expect(() => transition(run, RUN_STATUS.RUNNING)).toThrow(/非法的状态迁移/);
    }
  });
  it('同状态重复设置是幂等的', () => {
    const run = createRun({ task: 't' });
    transition(run, RUN_STATUS.RUNNING);
    expect(() => transition(run, RUN_STATUS.RUNNING)).not.toThrow();
  });
  it('迁移表覆盖全部状态', () => {
    for (const status of Object.values(RUN_STATUS)) {
      expect(Array.isArray(TRANSITIONS[status])).toBe(true);
    }
  });
  it('canTransition 对未知状态返回 false', () => {
    expect(canTransition('nonsense', RUN_STATUS.RUNNING)).toBe(false);
  });
});

describe('记录：工具调用 / 审批 / 产物', () => {
  it('工具调用无论成败都留痕', () => {
    const run = createRun({ task: 't' });
    recordToolCall(run, { name: 'read_file', callId: 'c1', ok: true, riskLevel: 'LOW', durationMs: 12, summary: 'ok' });
    recordToolCall(run, { name: 'run_command', callId: 'c2', ok: false, riskLevel: 'HIGH', error: '用户拒绝' });
    expect(run.tool_calls).toHaveLength(2);
    expect(run.tool_calls[0].ok).toBe(true);
    expect(run.tool_calls[1].error).toBe('用户拒绝');
    expect(run.tool_calls[1].riskLevel).toBe('HIGH');
  });
  it('审批记录保留批没批与原因', () => {
    const run = createRun({ task: 't' });
    recordApproval(run, { id: 'a1', name: 'run_command', riskLevel: 'HIGH', approved: false, reason: '看起来危险' });
    expect(run.approvals[0].approved).toBe(false);
    expect(run.approvals[0].reason).toBe('看起来危险');
  });
  it('产物记录', () => {
    const run = createRun({ task: 't' });
    addArtifact(run, { name: 'write_file', kind: 'file', path: 'src/a.js', summary: '已写入' });
    expect(run.artifacts[0].path).toBe('src/a.js');
  });
  it('snapshot 不泄露内部活对象', () => {
    const run = createRun({ task: 't', workspace: 'D:/w' });
    run.messages.push({ role: 'user', content: 'hi' });
    const snap = snapshot(run);
    expect(snap.messageCount).toBe(1);
    expect(snap.messages).toBeUndefined();
    snap.answer = '改了';
    expect(run.answer).toBe('');
  });
  it('snapshot(null) 返回 null', () => {
    expect(snapshot(null)).toBeNull();
  });
});
