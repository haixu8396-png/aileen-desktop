import { describe, it, expect } from 'vitest';
import { createToolRegistry, defineTool, validateArgs, TOOL_SPECS, withBaseExecutors, attachExecutors } from '../../src/agent/tool-registry.js';
import { RISK } from '../../src/agent/permission.js';

const readTool = {
  name: 'read_file',
  description: '读文件',
  riskLevel: RISK.LOW,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer' },
      deep: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['path'],
  },
  execute: async () => 'ok',
};

describe('工具定义校验', () => {
  it('合法定义可以通过', () => {
    expect(defineTool(readTool).name).toBe('read_file');
  });
  it('工具名不规范直接拒绝', () => {
    expect(() => defineTool({ ...readTool, name: 'Read File' })).toThrow(/工具名不合法/);
    expect(() => defineTool({ ...readTool, name: 'a' })).toThrow(/工具名不合法/);
    expect(() => defineTool({ ...readTool, name: 'Run-Command' })).toThrow(/工具名不合法/);
  });
  it('缺 description / inputSchema / execute 都拒绝', () => {
    expect(() => defineTool({ ...readTool, description: '' })).toThrow(/缺少 description/);
    expect(() => defineTool({ ...readTool, inputSchema: undefined })).toThrow(/inputSchema/);
    expect(() => defineTool({ ...readTool, execute: undefined })).toThrow(/缺少 execute/);
  });
  it('inputSchema 必须是 object 且字段类型受支持', () => {
    expect(() => defineTool({ ...readTool, inputSchema: { type: 'array' } })).toThrow(/type 必须是 "object"/);
    expect(() => defineTool({
      ...readTool,
      inputSchema: { type: 'object', properties: { x: { type: 'function' } } },
    })).toThrow(/类型不支持/);
  });
  it('required 里不能出现未声明的字段', () => {
    expect(() => defineTool({
      ...readTool,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['nope'] },
    })).toThrow(/未声明的字段/);
  });
  it('没写 riskLevel 时按工具名查表补上', () => {
    expect(defineTool({ ...readTool, riskLevel: undefined }).riskLevel).toBe(RISK.LOW);
  });
});

describe('注册表', () => {
  it('重复注册同名工具直接抛错', () => {
    const reg = createToolRegistry();
    reg.register(readTool);
    expect(() => reg.register(readTool)).toThrow(/重复注册/);
  });
  it('list() 顺序稳定（按名字排序，保证 prompt 可缓存）', () => {
    const reg = createToolRegistry();
    reg.registerAll([
      { ...readTool, name: 'write_file' },
      { ...readTool, name: 'apply_patch' },
      { ...readTool, name: 'list_files' },
    ]);
    expect(reg.list().map((t) => t.name)).toEqual(['apply_patch', 'list_files', 'write_file']);
  });
  it('get / has / size', () => {
    const reg = createToolRegistry();
    reg.register(readTool);
    expect(reg.has('read_file')).toBe(true);
    expect(reg.has('nope')).toBe(false);
    expect(reg.get('nope')).toBeNull();
    expect(reg.size()).toBe(1);
  });
});

describe('参数校验', () => {
  const tool = defineTool(readTool);
  it('必填缺失报错但不抛异常', () => {
    const r = validateArgs(tool, {});
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('path');
  });
  it('类型不符报错', () => {
    expect(validateArgs(tool, { path: 'a', limit: {} }).ok).toBe(false);
  });
  it('数字写成字符串时宽松转换', () => {
    const r = validateArgs(tool, { path: 'a', limit: '20' });
    expect(r.ok).toBe(true);
    expect(r.value.limit).toBe(20);
  });
  it('未知参数被丢掉但不判失败', () => {
    const r = validateArgs(tool, { path: 'a', evil: 'x' });
    expect(r.ok).toBe(true);
    expect(r.value.evil).toBeUndefined();
  });
  it('参数不是对象直接失败', () => {
    expect(validateArgs(tool, 'nope').ok).toBe(false);
    expect(validateArgs(tool, null).ok).toBe(false);
  });
  it('enum 校验', () => {
    const t = defineTool({
      ...readTool,
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['path'] },
    });
    expect(validateArgs(t, { path: 'x', mode: 'c' }).ok).toBe(false);
    expect(validateArgs(t, { path: 'x', mode: 'b' }).ok).toBe(true);
  });
});

describe('第一版工具清单', () => {
  it('要求的工具都在，且都能注册', () => {
    const reg = createToolRegistry();
    reg.registerAll(withBaseExecutors(TOOL_SPECS));
    for (const name of [
      'list_files', 'search_files', 'read_file', 'write_file', 'apply_patch',
      'run_command', 'git_status', 'git_diff', 'screen_capture',
    ]) {
      expect(reg.has(name)).toBe(true);
    }
  });
  it('每个工具都有描述、schema 和风险等级', () => {
    for (const spec of TOOL_SPECS) {
      expect(spec.description.length).toBeGreaterThan(4);
      expect(spec.inputSchema.type).toBe('object');
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(spec.riskLevel);
    }
  });
});
