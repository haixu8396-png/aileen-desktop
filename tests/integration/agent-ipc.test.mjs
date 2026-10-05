import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agentIpc from '../../shared/agent-ipc.cjs';

const { registerAgentIpc, isSensitivePath, toPlainDirents, runProcess } = agentIpc;

// ---------------------------------------------------------------------------
// 主进程的 Agent 能力层：workspace 边界、敏感路径、目录项契约、命令执行。
// 这里用假 handle 直接拿到注册的处理器，不需要 Electron。
// ---------------------------------------------------------------------------

let workspace;
let handlers;

function register(settings = {}) {
  handlers = new Map();
  registerAgentIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    getSettings: () => Object.assign({ agent: { workspace, requireMedium: true } }, settings),
    defaultWorkspace: () => workspace,
    captureScreen: async ({ withData } = {}) => ({ count: 1, width: 10, height: 10, dataUrl: withData ? 'data:image/png;base64,AA' : '' }),
    log: () => {},
  });
  return handlers;
}

const call = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-agentipc-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.js'), 'const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n', 'utf8');
  register();
});
afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('目录项契约', () => {
  it('toPlainDirents 把 Dirent 摊成布尔字段', () => {
    const fake = [
      { name: 'src', isDirectory: () => true },
      { name: 'a.js', isDirectory: () => false },
      'plain.txt',
    ];
    expect(toPlainDirents(fake)).toEqual([
      { name: 'src', isDirectory: true },
      { name: 'a.js', isDirectory: false },
      { name: 'plain.txt', isDirectory: false },
    ]);
  });
  it('agent:fs list 返回的是可直接跨 IPC 的形状（这是真机踩过的坑）', async () => {
    const res = await call('agent:fs', { op: 'list', path: '.' });
    for (const e of res.entries) {
      expect(typeof e.name).toBe('string');
      expect(typeof e.isDirectory).toBe('boolean');
    }
    const src = res.entries.find((e) => e.name === 'src');
    expect(src.isDirectory).toBe(true);
  });
});

describe('敏感路径', () => {
  it('认得出凭据与密钥', () => {
    expect(isSensitivePath('C:/Users/x/.ssh/id_rsa')).toBe(true);
    expect(isSensitivePath('/home/x/.aws/credentials')).toBe(true);
    expect(isSensitivePath('/home/x/.git-credentials')).toBe(true);
    expect(isSensitivePath('C:/proj/.npmrc')).toBe(true);
    expect(isSensitivePath('C:/app/data/settings.json')).toBe(true);
    expect(isSensitivePath('C:/Users/x/.dsh/.credentials.yaml')).toBe(true);
  });
  it('普通源码不算敏感', () => {
    expect(isSensitivePath('C:/proj/src/main.js')).toBe(false);
    expect(isSensitivePath('C:/proj/README.md')).toBe(false);
  });
});

describe('workspace 边界', () => {
  it('agent:workspace 报告当前绑定目录', async () => {
    expect(await call('agent:workspace')).toEqual({ workspace: path.resolve(workspace) });
  });
  it('越界读被拒（.. / 绝对路径）', async () => {
    await expect(call('agent:fs', { op: 'read', path: '../outside.txt' })).rejects.toThrow(/越界/);
    await expect(call('agent:fs', { op: 'read', path: path.join(os.tmpdir(), 'x.txt') })).rejects.toThrow(/越界/);
  });
  it('越界写被拒', async () => {
    await expect(call('agent:fs', { op: 'write', path: '../evil.txt', text: 'x' })).rejects.toThrow(/越界/);
  });
  it('含空字符的路径被拒', async () => {
    await expect(call('agent:fs', { op: 'read', path: 'a\0b' })).rejects.toThrow(/非法字符/);
  });
  it('workspace 内的敏感文件名照样被拒（读也不行）', async () => {
    fs.writeFileSync(path.join(workspace, 'settings.json'), '{"apiKey":"safe:v1:x"}', 'utf8');
    await expect(call('agent:fs', { op: 'read', path: 'settings.json' })).rejects.toThrow(/敏感文件/);
    await expect(call('agent:fs', { op: 'write', path: 'settings.json', text: '{}' })).rejects.toThrow(/敏感文件/);
  });
  it('设置里的 workspace 不存在时回落到默认工作区', async () => {
    register({ agent: { workspace: 'Z:/definitely/not/here', requireMedium: true } });
    expect(await call('agent:workspace')).toEqual({ workspace: path.resolve(workspace) });
  });
});

describe('文件操作', () => {
  it('读文件', async () => {
    const res = await call('agent:fs', { op: 'read', path: 'README.md' });
    expect(res.text).toContain('# demo');
  });
  it('写文件（含自动建目录）', async () => {
    const res = await call('agent:fs', { op: 'write', path: 'deep/nested/x.txt', text: '你好' });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'deep', 'nested', 'x.txt'), 'utf8')).toBe('你好');
  });
  it('读目录会明确报错而不是返回一堆二进制', async () => {
    await expect(call('agent:fs', { op: 'read', path: 'src' })).rejects.toThrow(/目录/);
  });
  it('超大文件拒绝整份读入', async () => {
    fs.writeFileSync(path.join(workspace, 'big.txt'), 'x'.repeat(5 * 1024 * 1024), 'utf8');
    await expect(call('agent:fs', { op: 'read', path: 'big.txt' })).rejects.toThrow(/太大/);
  });
  it('未知 op 报错', async () => {
    await expect(call('agent:fs', { op: 'delete', path: 'src/a.js' })).rejects.toThrow(/未知的 agent:fs 操作/);
  });
  it('stat 可用', async () => {
    const res = await call('agent:fs', { op: 'stat', path: 'src' });
    expect(res.isDirectory).toBe(true);
  });
});

describe('git', () => {
  it('只允许读类与 commit 子命令', async () => {
    await expect(call('agent:git', { args: ['push'] })).rejects.toThrow(/不在允许范围内/);
    await expect(call('agent:git', { args: ['reset', '--hard'] })).rejects.toThrow(/不在允许范围内/);
    await expect(call('agent:git', { args: ['clean', '-fd'] })).rejects.toThrow(/不在允许范围内/);
  });
  it('commit 必须带 -m', async () => {
    await expect(call('agent:git', { args: ['commit'] })).rejects.toThrow(/必须带 -m/);
  });
  it('worktree 不是 git 仓库时会如实返回非 0 退出码而不是抛异常', async () => {
    const res = await call('agent:git', { args: ['status', '--short'] });
    expect(typeof res.exitCode).toBe('number');
    expect(typeof res.text).toBe('string');
  }, 60000);
});

describe('runProcess', () => {
  it('拿到 stdout 与退出码', async () => {
    const r = await runProcess({ command: process.execPath, args: ['-e', 'console.log("hi")'], cwd: workspace, timeoutMs: 30000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hi');
  });
  it('非 0 退出码如实带回，stderr 也留着', async () => {
    const r = await runProcess({ command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'], cwd: workspace, timeoutMs: 30000 });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
  });
  it('超时会被终止并标记 timedOut', async () => {
    const r = await runProcess({ command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], cwd: workspace, timeoutMs: 1200 });
    expect(r.timedOut).toBe(true);
  }, 30000);
  it('不存在的程序不会把进程带崩', async () => {
    const r = await runProcess({ command: 'definitely-not-a-real-program-xyz', args: [], cwd: workspace, timeoutMs: 5000 });
    expect(r.exitCode).toBe(-1);
    expect(r.spawnError || r.stderr).toBeTruthy();
  });
  it('输出超限会被截断标记', async () => {
    const r = await runProcess({ command: process.execPath, args: ['-e', 'console.log("x".repeat(300000))'], cwd: workspace, timeoutMs: 30000, maxOutput: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
  });
});

describe('agent:exec 与 agent:screenshot', () => {
  it('exec 缺命令直接拒绝', async () => {
    await expect(call('agent:exec', {})).rejects.toThrow(/缺少要执行的命令/);
  });
  it('exec 在 workspace 里跑（cwd 就是工作区）', async () => {
    const r = await call('agent:exec', { command: process.execPath, args: ['-e', 'console.log(process.cwd())'], timeoutMs: 30000 });
    expect(r.stdout.trim().toLowerCase()).toBe(path.resolve(workspace).toLowerCase());
  }, 60000);
  it('screenshot 不带数据时只回尺寸与名字', async () => {
    const r = await call('agent:screenshot', {});
    expect(r.width).toBe(10);
    expect(r.dataUrl).toBe('');
  });
  it('screenshot 需要数据时回 dataUrl', async () => {
    const r = await call('agent:screenshot', { withData: true });
    expect(r.dataUrl).toContain('data:image/png');
  });
});
