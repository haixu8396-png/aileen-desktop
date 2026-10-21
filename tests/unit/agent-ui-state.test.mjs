// 界面状态层（src/lib/agent-state.js）—— 和 src/agent/state.js（runtime 状态）不是一回事：
// 这一层只服务界面（对话里的活动卡、任务页、权限弹层），不参与执行。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_STEPS, MAX_RECENT,
  agentUiState, subscribeAgentUi, patchAgentUi, resetAgentUi,
  addAgentStep, noteAgentDecision, setAgentApproval, finishAgentUi,
} from '../../src/lib/agent-state.js';

beforeEach(() => {
  resetAgentUi();
});

describe('agent-ui-state：Agent 界面状态的唯一来源', () => {
  it('初始是「没在跑」的干净状态', () => {
    const s = agentUiState();
    expect(s.running).toBe(false);
    expect(s.steps).toEqual([]);
    expect(s.approval).toBe(null);
    expect(s.recent).toEqual([]);
    expect(s.finished).toBe(false);
  });

  it('快照是副本：改它不会改内部状态', () => {
    patchAgentUi({ task: '整理下载目录' });
    const s = agentUiState();
    s.task = '被改了';
    s.steps.push({ text: '外部塞进来的' });
    expect(agentUiState().task).toBe('整理下载目录');
    expect(agentUiState().steps.length).toBe(0);
  });

  it('patch 合并字段并通知订阅者，退订之后不再收到', () => {
    const seen = [];
    const off = subscribeAgentUi((s) => seen.push(s.task));
    patchAgentUi({ task: 'a' });
    patchAgentUi({ status: 'thinking' });
    off();
    patchAgentUi({ task: 'b' });
    expect(seen).toEqual(['a', 'a']);
    expect(agentUiState().task).toBe('b');
    expect(agentUiState().status).toBe('thinking');
  });

  it('一个订阅者抛错不影响其它订阅者', () => {
    const seen = [];
    subscribeAgentUi(() => { throw new Error('boom'); });
    subscribeAgentUi((s) => seen.push(s.status));
    patchAgentUi({ status: 'working' });
    expect(seen).toEqual(['working']);
  });

  it('步骤按时间追加，超过上限丢最早的', () => {
    for (let i = 0; i < MAX_STEPS + 5; i += 1) addAgentStep({ kind: 'tool', text: 'step ' + i, ok: i % 2 === 0 });
    const steps = agentUiState().steps;
    expect(steps.length).toBe(MAX_STEPS);
    expect(steps[0].text).toBe('step 5');
    expect(steps[steps.length - 1].text).toBe('step ' + (MAX_STEPS + 4));
    expect(steps[0].ok).toBe(false);
    expect(steps[1].ok).toBe(true);
  });

  it('空步骤不会被塞进列表（避免日志里出现空行）', () => {
    addAgentStep({ kind: 'info', text: '' });
    addAgentStep(null);
    expect(agentUiState().steps.length).toBe(0);
  });

  it('最近的决定：新的在前，只留 MAX_RECENT 条', () => {
    for (let i = 0; i < MAX_RECENT + 2; i += 1) {
      noteAgentDecision({ name: 'tool' + i, riskLevel: 'high', approved: i % 2 === 0, remember: true });
    }
    const recent = agentUiState().recent;
    expect(recent.length).toBe(MAX_RECENT);
    expect(recent[0].name).toBe('tool' + (MAX_RECENT + 1));
    expect(recent[0].riskLevel).toBe('HIGH');
    expect(recent[0].approved).toBe(false);
  });

  it('审批请求可设置也可清空', () => {
    setAgentApproval({ id: 'a1', name: 'run_command', riskLevel: 'HIGH', preview: 'npm run build' });
    expect(agentUiState().approval.name).toBe('run_command');
    const s = agentUiState();
    s.approval.preview = '改了';
    expect(agentUiState().approval.preview).toBe('npm run build');
    setAgentApproval(null);
    expect(agentUiState().approval).toBe(null);
  });

  it('结束一轮：运行态关掉、审批清空、可带检查点', () => {
    patchAgentUi({ running: true, status: 'using_tool' });
    setAgentApproval({ id: 'a2', name: 'write_file', riskLevel: 'MEDIUM' });
    finishAgentUi({ status: 'completed' });
    const s = agentUiState();
    expect(s.running).toBe(false);
    expect(s.finished).toBe(true);
    expect(s.status).toBe('completed');
    expect(s.approval).toBe(null);

    resetAgentUi();
    patchAgentUi({ running: true, status: 'using_tool' });
    finishAgentUi({ status: 'failed', error: '磁盘满了', checkpoint: true });
    const s2 = agentUiState();
    expect(s2.error).toBe('磁盘满了');
    expect(s2.checkpoint).toBe(true);
    expect(s2.status).toBe('failed');
  });
});
