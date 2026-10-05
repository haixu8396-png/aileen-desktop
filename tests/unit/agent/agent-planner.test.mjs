import { describe, it, expect } from 'vitest';
import {
  toolsToProviderSpecs, normalizeToolCall, parseToolCalls, assistantMessage,
  toolResultMessage, unknownToolMessage, shouldFinish, buildAgentSystemPrompt,
} from '../../../src/agent/planner.js';
import { createToolRegistry, TOOL_SPECS, withBaseExecutors } from '../../../src/agent/tool-registry.js';

function registry() {
  const reg = createToolRegistry();
  reg.registerAll(withBaseExecutors(TOOL_SPECS));
  return reg;
}

describe('toolsToProviderSpecs', () => {
  it('转成 OpenAI 兼容的 tools 参数', () => {
    const specs = toolsToProviderSpecs([{ name: 'read_file', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }]);
    expect(specs[0].type).toBe('function');
    expect(specs[0].function.name).toBe('read_file');
    expect(specs[0].function.parameters.properties.path.type).toBe('string');
  });
  it('没有 schema 时给一个空 object（provider 不接受 undefined）', () => {
    const specs = toolsToProviderSpecs([{ name: 'x', description: 'd' }]);
    expect(specs[0].function.parameters).toEqual({ type: 'object', properties: {} });
  });
  it('空表返回空数组', () => {
    expect(toolsToProviderSpecs()).toEqual([]);
  });
});

describe('normalizeToolCall', () => {
  it('解析 JSON 字符串参数', () => {
    const call = normalizeToolCall({ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } });
    expect(call.name).toBe('read_file');
    expect(call.args).toEqual({ path: 'a.js' });
  });
  it('参数是对象时直接收下', () => {
    expect(normalizeToolCall({ id: 'c', function: { name: 'x', arguments: { a: 1 } } }).args).toEqual({ a: 1 });
  });
  it('空参数当成 {}', () => {
    expect(normalizeToolCall({ id: 'c', function: { name: 'git_status', arguments: '' } }).args).toEqual({});
  });
  it('JSON 被截断时不丢调用，标记 parseError 交给模型改', () => {
    const call = normalizeToolCall({ id: 'c', function: { name: 'write_file', arguments: '{"path":"a", "content":"未写完' } });
    expect(call.name).toBe('write_file');
    expect(call.parseError).toBeTruthy();
    expect(call.args).toEqual({});
  });
  it('没有工具名的返回 null', () => {
    expect(normalizeToolCall({ id: 'c', function: {} })).toBeNull();
    expect(normalizeToolCall(null)).toBeNull();
  });
});

describe('parseToolCalls', () => {
  const reg = registry();
  it('拆出已知工具与「模型编的工具名」两类', () => {
    const { calls, unknown } = parseToolCalls({
      tool_calls: [
        { id: 'a', function: { name: 'read_file', arguments: '{"path":"x"}' } },
        { id: 'b', function: { name: 'teleport', arguments: '{}' } },
      ],
    }, reg);
    expect(calls.map((c) => c.name)).toEqual(['read_file']);
    expect(unknown.map((c) => c.name)).toEqual(['teleport']);
  });
  it('没有 tool_calls 时返回空', () => {
    expect(parseToolCalls({}, reg)).toEqual({ calls: [], unknown: [] });
    expect(parseToolCalls(null, reg)).toEqual({ calls: [], unknown: [] });
  });
});

describe('消息拼装', () => {
  it('assistant 消息带回 tool_calls（否则模型以为自己没调过）', () => {
    const msg = assistantMessage('我来看看', [{ id: 'c1', name: 'read_file', args: { path: 'a.js' } }]);
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('我来看看');
    expect(msg.tool_calls[0].function.name).toBe('read_file');
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ path: 'a.js' });
  });
  it('没有工具调用时不带 tool_calls 字段', () => {
    expect(assistantMessage('就这样', []).tool_calls).toBeUndefined();
  });
  it('tool 结果消息带上 tool_call_id', () => {
    expect(toolResultMessage('c1', '文件内容')).toEqual({ role: 'tool', tool_call_id: 'c1', content: '文件内容' });
  });
  it('未知工具回执告诉模型有哪些工具', () => {
    const msg = unknownToolMessage('teleport', registry());
    expect(msg).toContain('teleport');
    expect(msg).toContain('read_file');
  });
});

describe('shouldFinish', () => {
  it('没有工具调用就该收尾', () => {
    expect(shouldFinish('答案', [], 1, 20)).toBe(true);
  });
  it('还有工具调用就继续', () => {
    expect(shouldFinish('', [{ name: 'read_file' }], 1, 20)).toBe(false);
  });
  it('到轮数上限强制收尾（防止无限循环）', () => {
    expect(shouldFinish('', [{ name: 'read_file' }], 20, 20)).toBe(true);
  });
});

describe('Agent 系统提示词', () => {
  const prompt = buildAgentSystemPrompt({ task: '修个 bug', workspace: 'D:/w', tools: registry().list() });

  it('带上任务、工作区和工具清单', () => {
    expect(prompt).toContain('修个 bug');
    expect(prompt).toContain('D:/w');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('run_command');
  });
  it('写死了 workspace 边界与凭据禁令', () => {
    expect(prompt).toContain('workspace');
    expect(prompt).toMatch(/API Key|凭据/);
  });
  it('提醒「改文件前先读」和「被拒绝别重试」', () => {
    expect(prompt).toMatch(/先读/);
    expect(prompt).toMatch(/被拒绝|拒绝/);
  });
});
