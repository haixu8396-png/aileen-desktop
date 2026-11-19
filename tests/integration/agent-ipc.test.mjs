import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agentIpc from '../../shared/agent-ipc.cjs';
import authz from '../../shared/authz.cjs';

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
    // 注意：不能用 `-e`（把代码当参数）。主进程出口处现在一律拒绝这类参数，
    // 所以这里写一个脚本文件再跑 —— 这也是「真正该用的方式」。
    const script = path.join(workspace, 'cwd.js');
    fs.writeFileSync(script, 'console.log(process.cwd());\n', 'utf8');
    const r = await call('agent:exec', { command: process.execPath, args: [script], timeoutMs: 30000 });
    expect(r.stdout.trim().toLowerCase()).toBe(path.resolve(workspace).toLowerCase());
  }, 60000);
  it('exec 拒绝 -e 这类「把代码当参数」的调用（主进程出口策略）', async () => {
    await expect(call('agent:exec', { command: process.execPath, args: ['-e', '1'] }))
      .rejects.toThrow(/命令被策略拒绝/);
  });
  it('exec 拒绝白名单之外的程序', async () => {
    await expect(call('agent:exec', { command: 'powershell', args: ['-Command', 'whoami'] }))
      .rejects.toThrow(/不在白名单/);
  });
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

// ---------------------------------------------------------------------------
// 主进程授权闸门：渲染层说了不算，主进程按设置重新判定
// ---------------------------------------------------------------------------

describe('主进程授权闸门（authz）', () => {
  let auditRows;

  /**
   * 用真实的 shared/authz.cjs 注册一套 handler。
   * confirmAction 是可注入的「用户点没点同意」——生产里是原生确认框。
   */
  function registerWithAuthz({ agent = {}, confirm = null } = {}) {
    handlers = new Map();
    auditRows = [];
    registerAgentIpc({
      handle: (channel, fn) => handlers.set(channel, fn),
      getSettings: () => ({
        agent: Object.assign({ workspace, requireMedium: true, authorization: { mode: 'manual' } }, agent),
      }),
      defaultWorkspace: () => workspace,
      authz,
      audit: { append: (row) => { auditRows.push(row); return { ok: true }; } },
      confirmAction: confirm || undefined,
      log: () => {},
    });
    return handlers;
  }

  const g = (capability, args) => handlers.get('agent:grant')({ sender: {} }, { capability, args });

  it('手动模式：写文件没有凭证 → 主进程拒绝（NEEDS_APPROVAL）', async () => {
    registerWithAuthz();
    await expect(call('agent:fs', { op: 'write', path: 'a.txt', text: 'hi' }))
      .rejects.toThrow(/需要先获得批准/);
    expect(fs.existsSync(path.join(workspace, 'a.txt'))).toBe(false);
  });

  it('手动模式：批准一次（拿凭证）→ 只能写这一个文件，且凭证用一次就没了', async () => {
    registerWithAuthz();
    const r = await g('fs.write', { op: 'write', path: 'a.txt' });
    expect(r.allowed).toBe(true);
    const w = await call('agent:fs', { op: 'write', path: 'a.txt', text: 'hi' });
    expect(w.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('hi');

    // 同一张票不能再用第二次
    await expect(call('agent:fs', { op: 'write', path: 'a.txt', text: 'again' }))
      .rejects.toThrow(/需要先获得批准/);
    // 换一个路径也不行（凭证绑定参数）
    await g('fs.write', { op: 'write', path: 'b.txt' });
    await expect(call('agent:fs', { op: 'write', path: 'c.txt', text: 'x' }))
      .rejects.toThrow(/需要先获得批准/);
  });

  it('信任 + 允许高风险：写文件不再要凭证，审计里记 allow', async () => {
    registerWithAuthz({ agent: { authorization: { mode: 'trust', allowHighRisk: true } } });
    const w = await call('agent:fs', { op: 'write', path: 'trusted.txt', text: 'ok' });
    expect(w.ok).toBe(true);
    const row = auditRows.find((x) => x.capability === 'fs.write' && x.decision === 'allow');
    expect(row).toBeTruthy();
    // MEDIUM 在信任模式下按模式放行（HIGH 才走 allowHighRisk 那条分支）
    expect(row.reason).toBe('medium-allowed-by-mode');
  });

  it('授权已撤销：直接拒绝，不弹任何确认', async () => {
    registerWithAuthz({ agent: { authorization: { mode: 'trust', allowHighRisk: true, revokedAt: Date.now() } } });
    await expect(call('agent:fs', { op: 'write', path: 'x.txt', text: 'x' }))
      .rejects.toThrow(/授权已失效/);
  });

  it('HIGH 动作：原生确认框拒绝 → 不发凭证，也不执行', async () => {
    const asked = [];
    registerWithAuthz({ confirm: async (info) => { asked.push(info.capability); return false; } });
    const r = await g('input.keyboard', { op: 'keyboardType', text: 'hello' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('user-rejected');
    expect(asked).toEqual(['input.keyboard']);
  });

  it('HIGH 动作：凭证绑定参数 —— 换了文字就要重新批准', async () => {
    let approvalsLeft = 1;
    registerWithAuthz({ confirm: async () => { approvalsLeft -= 1; return approvalsLeft >= 0; } });
    const first = await g('input.keyboard', { op: 'keyboardType', text: 'hello' });
    expect(first.allowed).toBe(true);
    // 换一段文字：确认框这次不给过 → 拿不到凭证
    const second = await g('input.keyboard', { op: 'keyboardType', text: 'other' });
    expect(second.allowed).toBe(false);
  });

  it('命令策略先于授权：即使拿到凭证，白名单之外的命令也执行不了', async () => {
    registerWithAuthz({ agent: { authorization: { mode: 'trust', allowHighRisk: true } } });
    await expect(call('agent:exec', { command: 'powershell', args: ['-Command', 'whoami'] }))
      .rejects.toThrow(/不在白名单/);
  });

  it('完整权限：白名单之外的命令放行（这是用户显式打开的）', async () => {
    registerWithAuthz({ agent: { authorization: { mode: 'trust', allowHighRisk: true, fullAccess: true } } });
    // 用 node 跑一个 -e 也会被命令策略放行（fullAccess 时跳过白名单与参数黑名单）
    const r = await call('agent:exec', { command: process.execPath, args: ['-e', 'console.log(42)'], timeoutMs: 30000 });
    expect(String(r.stdout).trim()).toBe('42');
  }, 60000);

  it('复制 / 移动：源和目标都要过边界，且各自要一张凭证', async () => {
    fs.writeFileSync(path.join(workspace, 'src.txt'), 'hello', 'utf8');
    registerWithAuthz();

    // 没有凭证 → 拒绝
    await expect(call('agent:fs', { op: 'copy', path: 'src.txt', to: 'dst.txt' }))
      .rejects.toThrow(/需要先获得批准/);

    await g('fs.copy', { op: 'copy', path: 'src.txt', to: 'dst.txt' });
    const r = await call('agent:fs', { op: 'copy', path: 'src.txt', to: 'dst.txt' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'dst.txt'), 'utf8')).toBe('hello');

    // 目标越界 → 即使有凭证也拒绝（resolveSafe 在 gate 之前）
    await g('fs.move', { op: 'move', path: 'dst.txt', to: '../escape.txt' });
    await expect(call('agent:fs', { op: 'move', path: 'dst.txt', to: '../escape.txt' }))
      .rejects.toThrow(/越界/);
  });

  it('删除走回收站，且没有凭证不执行', async () => {
    fs.writeFileSync(path.join(workspace, 'trash-me.txt'), 'x', 'utf8');
    registerWithAuthz();
    await expect(call('agent:fs', { op: 'remove', path: 'trash-me.txt' }))
      .rejects.toThrow(/需要先获得批准/);
    expect(fs.existsSync(path.join(workspace, 'trash-me.txt'))).toBe(true);
  });

  it('窗口控制是 HIGH：确认框拒绝就不执行', async () => {
    registerWithAuthz({ confirm: async () => false });
    const r = await g('window.control', { op: 'close', title: 'notepad' });
    expect(r.allowed).toBe(false);
    // 没有凭证 → 直接拒绝（不会真的去关窗口）
    await expect(call('agent:window', { op: 'close', title: 'notepad' }))
      .rejects.toThrow(/需要先获得批准/);
  });

  it('UIA 读树是 LOW、执行动作是 HIGH', async () => {
    registerWithAuthz({ confirm: async () => false });
    const act = await g('desktop.uia.act', { op: 'act', action: 'invoke', selector: { name: 'OK' }, value: '' });
    expect(act.allowed).toBe(false);
    await expect(call('agent:uia', { op: 'act', action: 'invoke', selector: { name: 'OK' } }))
      .rejects.toThrow(/需要先获得批准/);
  });

  it('任务结束清票：agent:grantsRevoke 之后旧凭证失效', async () => {
    registerWithAuthz();
    await g('fs.write', { op: 'write', path: 'revoked.txt' });
    const revoke = await handlers.get('agent:grantsRevoke')({ sender: {} });
    expect(revoke.ok).toBe(true);
    await expect(call('agent:fs', { op: 'write', path: 'revoked.txt', text: 'x' }))
      .rejects.toThrow(/需要先获得批准/);
  });
});
