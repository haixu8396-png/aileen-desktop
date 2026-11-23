// ============================================================
// 外部文件访问：整条链路（executor → bridge → 主进程 agent:fs → Windows 文件系统）
//
// 这个文件的每个用例都真的建目录、真的搬文件，最后用 fs 验证「目标里有什么、
// 源还在不在」—— 不靠工具返回的字符串。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutor } from '../../src/agent/executor.js';
import fsMove from '../../shared/fs-move.cjs';
import agentIpc from '../../shared/agent-ipc.cjs';
import authz from '../../shared/authz.cjs';

const { registerAgentIpc } = agentIpc;

let base;
let ws;
let desktop;
let documents;
let outside;

function makeDirs() {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-ext-'));
  ws = path.join(base, 'ws');
  desktop = path.join(base, 'Desktop');
  documents = path.join(base, 'Documents');
  outside = path.join(base, 'outside');
  for (const d of [ws, desktop, documents, outside]) fs.mkdirSync(d, { recursive: true });
}

/** 桥接：形状和主进程提供的一致（copy/move 走 shared/fs-move.cjs） */
function bridge() {
  return {
    readFile: (p, enc) => fs.promises.readFile(p, enc || 'utf8'),
    writeFile: (p, c, enc) => fs.promises.writeFile(p, c, enc || 'utf8'),
    readdir: async (p) => (await fs.promises.readdir(p, { withFileTypes: true }))
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
    stat: (p) => fs.promises.stat(p),
    copyPath: async ({ path: from, to, overwrite }) => fsMove.copyPath({ from, to, overwrite: !!overwrite }),
    movePath: async ({ path: from, to, overwrite }) => fsMove.movePath({ from, to, overwrite: !!overwrite }),
    deletePath: async ({ path: p }) => { fs.rmSync(p, { recursive: true, force: true }); return { ok: true }; },
    spawn: async () => { throw new Error('本测试不跑子进程'); },
    git: async () => '',
    screenCapture: async () => ({ width: 10, height: 10 }),
  };
}

const ex = (extra = {}) => createExecutor({
  workspace: ws,
  home: base,
  bridge: bridge(),
  ...extra,
});

const p = (...segs) => path.join(...segs);
const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);

beforeEach(makeDirs);
afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('executor：工作区仍是默认目录', () => {
  it('工作区内移动：相对路径', async () => {
    fs.writeFileSync(p(ws, 'a.txt'), 'hello', 'utf8');
    const e = ex();
    const msg = await e.movePath({ path: 'a.txt', to: 'b.txt' });
    expect(msg).toContain('已移动');
    expect(read(p(ws, 'b.txt'))).toBe('hello');
    expect(exists(p(ws, 'a.txt'))).toBe(false);
  });

  it('工作区内复制：内容校验通过', async () => {
    fs.writeFileSync(p(ws, 'a.txt'), 'copy', 'utf8');
    const e = ex();
    const msg = await e.copyPath({ path: 'a.txt', to: 'sub/a.txt' });
    expect(msg).toContain('内容校验通过');
    expect(read(p(ws, 'sub', 'a.txt'))).toBe('copy');
    expect(exists(p(ws, 'a.txt'))).toBe(true);
  });
});

describe('executor：外部路径需要授权', () => {
  it('未授权：读写移动全部拒绝，且错误码明确', async () => {
    fs.writeFileSync(p(ws, 'a.txt'), 'x', 'utf8');
    const e = ex();
    await expect(e.writeFile({ path: p(desktop, 'x.txt'), content: 'x' })).rejects.toThrow(/EXTERNAL_ACCESS_REQUIRED/);
    await expect(e.movePath({ path: p(ws, 'a.txt'), to: p(desktop, 'a.txt') })).rejects.toThrow(/工作区之外/);
    await expect(e.listFiles({ path: desktop })).rejects.toThrow(/工作区之外/);
    expect(exists(p(desktop, 'x.txt'))).toBe(false);
  });

  it('这一次批准过（approvedExternal）→ 允许并真的搬过去', async () => {
    fs.writeFileSync(p(ws, 'a.txt'), 'move me', 'utf8');
    const e = ex();
    await e.movePath({ path: p(ws, 'a.txt'), to: p(desktop, 'a.txt') }, { approvedExternal: true });
    expect(read(p(desktop, 'a.txt'))).toBe('move me');
    expect(exists(p(ws, 'a.txt'))).toBe(false);
  });

  it('策略放行（信任模式 / 完整权限）→ 桌面 ↔ 工作区 双向都能搬', async () => {
    const e = ex({ allowExternal: () => true });
    fs.writeFileSync(p(ws, 'to-desktop.txt'), 'A', 'utf8');
    await e.movePath({ path: 'to-desktop.txt', to: p(desktop, 'to-desktop.txt') });
    expect(read(p(desktop, 'to-desktop.txt'))).toBe('A');
    expect(exists(p(ws, 'to-desktop.txt'))).toBe(false);

    await e.movePath({ path: p(desktop, 'to-desktop.txt'), to: 'back-in-workspace.txt' });
    expect(read(p(ws, 'back-in-workspace.txt'))).toBe('A');
    expect(exists(p(desktop, 'to-desktop.txt'))).toBe(false);
  });

  it('桌面 → 文档：两个都在外部时也能复制', async () => {
    const e = ex({ allowExternal: () => true });
    fs.writeFileSync(p(desktop, 'report.txt'), 'R', 'utf8');
    const msg = await e.copyPath({ path: p(desktop, 'report.txt'), to: p(documents, 'report.txt') });
    expect(msg).toContain('工作区外');
    expect(read(p(documents, 'report.txt'))).toBe('R');
    expect(exists(p(desktop, 'report.txt'))).toBe(true);
  });

  it('目标已存在：默认拒绝；overwrite 才覆盖', async () => {
    const e = ex({ allowExternal: () => true });
    fs.writeFileSync(p(ws, 'a.txt'), 'NEW', 'utf8');
    fs.writeFileSync(p(desktop, 'a.txt'), 'OLD', 'utf8');
    await expect(e.movePath({ path: 'a.txt', to: p(desktop, 'a.txt') })).rejects.toThrow(/目标已存在/);
    expect(read(p(desktop, 'a.txt'))).toBe('OLD');
    await e.movePath({ path: 'a.txt', to: p(desktop, 'a.txt'), overwrite: true }, { approvedExternal: true });
    expect(read(p(desktop, 'a.txt'))).toBe('NEW');
  });

  it('敏感路径在工作区外也一样拒绝（即使有外部授权）', async () => {
    const e = ex({ allowExternal: () => true });
    await expect(e.writeFile({ path: p(desktop, '.ssh', 'id_rsa'), content: 'x' })).rejects.toThrow(/敏感/);
    await expect(e.writeFile({ path: p(desktop, 'settings.json'), content: '{}' })).rejects.toThrow(/敏感/);
  });
});

// ---------------------------------------------------------------------------
// 主进程这一侧：外部路径 = 独立能力 fs.external（HIGH）+ 动作本身的能力
// ---------------------------------------------------------------------------
describe('主进程：外部文件访问的授权与执行', () => {
  let handlers;

  function register({ authorization = { mode: 'manual' }, settingsFile = '' } = {}) {
    handlers = new Map();
    registerAgentIpc({
      handle: (channel, fn) => handlers.set(channel, fn),
      getSettings: () => ({ agent: { workspace: ws, requireMedium: true, authorization } }),
      defaultWorkspace: () => ws,
      paths: () => ({ home: base, desktop, documents }),
      settingsFile: () => settingsFile,
      authz,
      audit: { append: () => ({ ok: true }) },
      log: () => {},
    });
    return handlers;
  }
  const call = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);
  const grant = (capability, args) => call('agent:grant', { capability, args });

  it('信任 + 允许高风险：外部写入/移动直接执行', async () => {
    register({ authorization: { mode: 'trust', allowHighRisk: true } });
    const res = await call('agent:fs', { op: 'write', path: p(desktop, 'trusted.txt'), text: 'ok' });
    expect(res.ok).toBe(true);
    expect(res.scope).toBe('external');
    expect(read(p(desktop, 'trusted.txt'))).toBe('ok');

    fs.writeFileSync(p(ws, 'from-ws.txt'), 'W', 'utf8');
    const moved = await call('agent:fs', { op: 'move', path: p(ws, 'from-ws.txt'), to: p(desktop, 'from-ws.txt') });
    expect(moved.ok).toBe(true);
    expect(moved.scope).toBe('external');
    expect(read(p(desktop, 'from-ws.txt'))).toBe('W');
    expect(exists(p(ws, 'from-ws.txt'))).toBe(false);
  });

  it('手动模式：外部写要两张凭证（fs.external + fs.write），少一张都不执行', async () => {
    register();
    // 只有动作凭证 → 仍然被 outer 拒绝
    await grant('fs.write', { op: 'write', path: p(desktop, 'manual.txt') });
    await expect(call('agent:fs', { op: 'write', path: p(desktop, 'manual.txt'), text: 'x' }))
      .rejects.toThrow(/需要先获得批准/);
    expect(exists(p(desktop, 'manual.txt'))).toBe(false);

    // 补齐外部凭证 → 通过
    await grant('fs.external', { op: 'write', path: p(desktop, 'manual.txt') });
    await grant('fs.write', { op: 'write', path: p(desktop, 'manual.txt') });
    const res = await call('agent:fs', { op: 'write', path: p(desktop, 'manual.txt'), text: 'x' });
    expect(res.ok).toBe(true);
    expect(read(p(desktop, 'manual.txt'))).toBe('x');
  });

  it('授权过期 / 已撤销：外部操作直接拒绝', async () => {
    register({ authorization: { mode: 'trust', allowHighRisk: true, expiresAt: Date.now() - 1000 } });
    await expect(call('agent:fs', { op: 'write', path: p(desktop, 'expired.txt'), text: 'x' }))
      .rejects.toThrow(/授权已失效/);
    expect(exists(p(desktop, 'expired.txt'))).toBe(false);

    register({ authorization: { mode: 'trust', allowHighRisk: true, revokedAt: Date.now() } });
    await expect(call('agent:fs', { op: 'write', path: p(desktop, 'revoked.txt'), text: 'x' }))
      .rejects.toThrow(/授权已失效/);
  });

  it('敏感文件：完整权限也不许读（保护 AILEEN 自己的设置与凭据）', async () => {
    register({ authorization: { mode: 'trust', allowHighRisk: true, fullAccess: true } });
    fs.writeFileSync(p(desktop, 'settings.json'), '{"apiKey":"x"}', 'utf8');
    await expect(call('agent:fs', { op: 'read', path: p(desktop, 'settings.json') })).rejects.toThrow(/敏感/);
    await expect(call('agent:fs', { op: 'write', path: p(desktop, '.ssh', 'id_rsa'), text: 'x' })).rejects.toThrow(/敏感/);
  });

  it('protectedRoots（settingsFile）整条路径敏感', async () => {
    const settingsFile = p(base, 'private', 'settings.json');
    fs.mkdirSync(p(base, 'private'), { recursive: true });
    fs.writeFileSync(settingsFile, '{}', 'utf8');
    register({ authorization: { mode: 'trust', allowHighRisk: true, fullAccess: true }, settingsFile });
    await expect(call('agent:fs', { op: 'read', path: settingsFile })).rejects.toThrow(/敏感/);
  });

  // junction：工作区里放一个指向外部的链接，看主进程会不会被绕过
  it('junction 指向工作区外：仍然按外部路径处理（realpath 兜底）', async () => {
    const link = p(ws, 'jump');
    let created = false;
    try { fs.symlinkSync(outside, link, 'junction'); created = true; } catch { /* 没权限就算了 */ }
    if (!created) return;

    fs.writeFileSync(p(outside, 'secret.txt'), 'outside', 'utf8');
    register(); // 手动模式：外部操作需要凭证
    await expect(call('agent:fs', { op: 'read', path: p(link, 'secret.txt') }))
      .rejects.toThrow(/需要先获得批准/);
    // 授权之后可以正常读（说明挡的是「外部」，不是「junction 本身」）
    register({ authorization: { mode: 'trust', allowHighRisk: true } });
    const res = await call('agent:fs', { op: 'read', path: p(link, 'secret.txt') });
    expect(res.text).toBe('outside');
    expect(res.scope).toBe('external');
  });

  it('junction 指向敏感目录：即使信任模式也拒绝', async () => {
    const link = p(ws, 'to-ssh');
    const fakeSsh = p(base, '.ssh');
    fs.mkdirSync(fakeSsh, { recursive: true });
    fs.writeFileSync(p(fakeSsh, 'id_rsa'), 'KEY', 'utf8');
    let created = false;
    try { fs.symlinkSync(fakeSsh, link, 'junction'); created = true; } catch { /* 没权限就算了 */ }
    if (!created) return;
    register({ authorization: { mode: 'trust', allowHighRisk: true, fullAccess: true } });
    await expect(call('agent:fs', { op: 'read', path: p(link, 'id_rsa') })).rejects.toThrow(/敏感/);
  });
});
