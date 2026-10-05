import { describe, it, expect } from 'vitest';
import {
  clipToolResult, fitMessages, estimateChars, estimateTokens,
  workspaceDigest, buildRequestMessages, TOOL_RESULT_LIMIT,
} from '../../../src/agent/context.js';

describe('工具结果裁剪', () => {
  it('短结果原样返回', () => {
    expect(clipToolResult('短')).toBe('短');
  });
  it('超长结果掐头去尾，并说明省略了多少', () => {
    const long = 'A'.repeat(TOOL_RESULT_LIMIT * 2);
    const out = clipToolResult(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('省略');
    expect(out.startsWith('A')).toBe(true);
  });
  it('null / undefined 不会炸', () => {
    expect(clipToolResult(null)).toBe('');
    expect(clipToolResult(undefined)).toBe('');
  });
});

describe('消息预算', () => {
  it('最近的消息永远保留', () => {
    const messages = [
      { role: 'user', content: '任务' },
      { role: 'tool', tool_call_id: '1', content: 'X'.repeat(50000) },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    const out = fitMessages(messages, { keepRecent: 2, toolTotalLimit: 1000 });
    expect(out[out.length - 1].content).toBe('b');
    expect(out[out.length - 2].content).toBe('a');
  });
  it('超预算的老工具结果替换成占位说明', () => {
    const messages = [
      { role: 'tool', tool_call_id: '1', content: 'Y'.repeat(30000) },
      ...Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'm' + i })),
    ];
    const out = fitMessages(messages, { keepRecent: 12, toolTotalLimit: 500 });
    expect(out[0].content).toContain('已省略');
  });
  it('不修改原数组', () => {
    const messages = [{ role: 'tool', tool_call_id: '1', content: 'Z'.repeat(30000) }, { role: 'user', content: 'x' }];
    fitMessages(messages, { keepRecent: 1, toolTotalLimit: 10 });
    expect(messages[0].content).toHaveLength(30000);
  });
  it('estimateChars / estimateTokens 计入 tool_calls', () => {
    const messages = [{ role: 'assistant', content: 'abc', tool_calls: [{ id: '1' }] }];
    expect(estimateChars(messages)).toBeGreaterThan(3);
    expect(estimateTokens(messages)).toBeGreaterThan(0);
  });
});

describe('workspace 概况', () => {
  it('带上路径、项目名、脚本、顶层条目', () => {
    const text = workspaceDigest({
      path: 'D:/w',
      appName: 'AILEEN 0.6.6',
      packageScripts: { test: 'vitest', build: 'vite build' },
      topLevel: ['src', 'tests'],
      gitBranch: 'main',
      dirty: true,
    });
    expect(text).toContain('D:/w');
    expect(text).toContain('AILEEN 0.6.6');
    expect(text).toContain('test');
    expect(text).toContain('src');
    expect(text).toContain('main');
    expect(text).toContain('未提交');
  });
  it('空信息也能给出一行', () => {
    expect(workspaceDigest({})).toContain('工作区概况');
  });
});

describe('请求消息组装', () => {
  it('system 在最前，摘要紧随其后', () => {
    const out = buildRequestMessages({ systemPrompt: '你是 Agent', summary: '之前聊过 X', messages: [{ role: 'user', content: 'hi' }] });
    expect(out[0].role).toBe('system');
    expect(out[0].content).toBe('你是 Agent');
    expect(out[1].content).toContain('之前聊过 X');
    expect(out[out.length - 1].content).toBe('hi');
  });
  it('预算不够时从最老的开始丢，system 永不丢', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: '消息' + i + 'X'.repeat(50) }));
    const out = buildRequestMessages({ systemPrompt: 'SYS', messages, budgetTokens: 50 });
    expect(out[0].content).toBe('SYS');
    expect(out.length).toBeLessThan(messages.length + 1);
  });
});
