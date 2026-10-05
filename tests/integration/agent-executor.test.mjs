import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutor, checkCommand, resolveInsideWorkspace, withTimeout, COMMAND_WHITELIST } from '../../src/agent/executor.js';

/** 真实文件系统桥接（就是主进程里那份的形状） */
function realBridge() {
  return {
    readFile: (p, enc) => fs.promises.readFile(p, enc || 'utf8'),
    writeFile: (p, c, enc) => fs.promises.writeFile(p, c, enc || 'utf8'),
    readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
    spawn: async () => { throw new Error('本测试不跑子进程'); },
    git: async () => '',
    screenCapture: async () => ({ width: 100, height: 100 }),
  };
}

/**
 * 模拟**经过 IPC 之后**的目录项：主进程读目录后要主动把 isDirectory()
 * 的结果摊成布尔值再送出来，否则方法会在结构化克隆里丢掉。
 * 这是真机上踩过的坑（搜索永远搜不到东西），所以单测照着这个形状跑。
 */
function ipcBridge() {
  return {
    ...realBridge(),
    readdir: async (p) => (await fs.promises.readdir(p, { withFileTypes: true }))
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
  };
}

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-agent-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n找到我\n', 'utf8');
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const ex = (extra = {}) => createExecutor({ workspace: root, bridge: realBridge(), ...extra });

describe('Workspace 边界', () => {
  it('工作区内的相对路径放行', () => {
    expect(resolveInsideWorkspace(root, 'src/a.js')).toContain('a.js');
    expect(resolveInsideWorkspace(root, '.')).toBe(path.resolve(root));
  });
  it('.. 越界被拒', () => {
    expect(() => resolveInsideWorkspace(root, '../outside.txt')).toThrow(/越界/);
    expect(() => resolveInsideWorkspace(root, 'src/../../x')).toThrow(/越界/);
  });
  it('绝对路径越界被拒', () => {
    expect(() => resolveInsideWorkspace(root, path.join(os.tmpdir(), 'evil.txt'))).toThrow(/越界/);
  });
  it('空 workspace 直接拒绝', () => {
    expect(() => resolveInsideWorkspace('', 'a')).toThrow(/未绑定 workspace/);
  });
  it('含空字符的路径被拒', () => {
    expect(() => resolveInsideWorkspace(root, 'a\0b')).toThrow(/非法字符/);
  });
  it('所有工具都走同一道边界闸门', async () => {
    const e = ex();
    await expect(e.readFile({ path: '../secret.txt' })).rejects.toThrow(/越界/);
    await expect(e.writeFile({ path: '../secret.txt', content: 'x' })).rejects.toThrow(/越界/);
    await expect(e.listFiles({ path: '..' })).rejects.toThrow(/越界/);
    await expect(e.applyPatch({ path: '../x', old: 'a', new: 'b' })).rejects.toThrow(/越界/);
    await expect(e.searchFiles({ query: 'x', path: '../..' })).rejects.toThrow(/越界/);
  });
  it('敏感路径即便在工作区内也被拒（凭据/密钥/设置）', async () => {
    const sensitive = path.join(root, 'settings.json');
    fs.writeFileSync(sensitive, '{"apiKey":"safe:v1:xxx"}', 'utf8');
    const e = ex({ isSensitive: (p) => path.basename(p) === 'settings.json' });
    await expect(e.readFile({ path: 'settings.json' })).rejects.toThrow(/敏感文件/);
    await expect(e.writeFile({ path: 'settings.json', content: '{}' })).rejects.toThrow(/敏感文件/);
    // 不敏感的文件照常可读
    await expect(e.readFile({ path: 'README.md' })).resolves.toContain('找到我');
  });
});

describe('文件工具', () => {
  it('read_file 带行号，并提示还有多少行没读完', async () => {
    const out = await ex().readFile({ path: 'src/a.js' });
    expect(out).toMatch(/1\| const a = 1;/);
    expect(out).toMatch(/2\| const b = 2;/);
  });
  it('read_file 支持 offset / limit', async () => {
    const out = await ex().readFile({ path: 'src/a.js', offset: 2, limit: 1 });
    expect(out).toContain('const b = 2;');
    expect(out).not.toContain('const a = 1;');
    expect(out).toContain('共 3 行');
  });
  it('write_file 真写进去了', async () => {
    const e = ex();
    await e.writeFile({ path: 'src/new.txt', content: '你好' });
    expect(fs.readFileSync(path.join(root, 'src', 'new.txt'), 'utf8')).toBe('你好');
  });
  it('list_files 列出目录，node_modules/.git 只给个名字', async () => {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const out = await ex().listFiles({ path: '.', depth: 1 });
    expect(out).toContain('src/');
    expect(out).toContain('README.md');
    expect(out).toContain('已跳过内容');
  });
  it('search_files 命中带文件与行号', async () => {
    const out = await ex().searchFiles({ query: '找到我' });
    expect(out).toContain('README.md:2');
  });
  it('search_files / list_files 在「目录项经 IPC 克隆后没有 isDirectory 方法」时依然正确（真机回归）', async () => {
    const e = createExecutor({ workspace: root, bridge: ipcBridge() });
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'deep.txt'), '深处的目标\n', 'utf8');
    const found = await e.searchFiles({ query: '深处的目标' });
    expect(found).toContain('sub/deep.txt');
    const listed = await e.listFiles({ path: '.', depth: 2 });
    expect(listed).toContain('src/');
    expect(listed).not.toContain('a.js/');
  });
  it('search_files 没命中时给明确说法', async () => {
    expect(await ex().searchFiles({ query: '绝不可能出现的字符串xyz' })).toContain('没有找到');
  });
  it('search_files 缺 query 报错', async () => {
    await expect(ex().searchFiles({})).rejects.toThrow(/query/);
  });
});

describe('apply_patch', () => {
  it('唯一匹配时替换成功', async () => {
    const e = ex();
    const out = await e.applyPatch({ path: 'src/a.js', old: 'const b = 2;', new: 'const b = 3;' });
    expect(out).toContain('已修改');
    expect(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toContain('const b = 3;');
  });
  it('找不到原文时报错，不改文件', async () => {
    const before = fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8');
    await expect(ex().applyPatch({ path: 'src/a.js', old: '不存在的行', new: 'x' })).rejects.toThrow(/找不到/);
    expect(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toBe(before);
  });
  it('匹配到多处时拒绝执行（避免改错地方）', async () => {
    fs.writeFileSync(path.join(root, 'dup.txt'), 'same\nsame\n', 'utf8');
    await expect(ex().applyPatch({ path: 'dup.txt', old: 'same', new: 'x' })).rejects.toThrow(/多次/);
  });
  it('old 为空直接拒绝', async () => {
    await expect(ex().applyPatch({ path: 'src/a.js', old: '', new: 'x' })).rejects.toThrow(/不能为空/);
  });
});

describe('命令策略', () => {
  it('白名单里的程序放行', () => {
    expect(checkCommand('npm', ['run', 'test']).ok).toBe(true);
    expect(checkCommand('node', ['scripts/lint.mjs']).ok).toBe(true);
    expect(checkCommand('git', ['status']).ok).toBe(true);
  });
  it('白名单外的程序拒绝', () => {
    expect(checkCommand('curl', ['http://x']).ok).toBe(false);
    expect(checkCommand('rm', ['-rf', '/']).ok).toBe(false);
    expect(checkCommand('powershell', ['-Command', 'x']).ok).toBe(false);
  });
  it('危险参数模式被拦（-e / --exec / --force / -g）', () => {
    expect(checkCommand('node', ['-e', 'require("fs")']).ok).toBe(false);
    expect(checkCommand('npm', ['--force']).ok).toBe(false);
    expect(checkCommand('npm', ['-g', 'install', 'x']).ok).toBe(false);
    expect(checkCommand('git', ['--exec=x']).ok).toBe(false);
    expect(checkCommand('node', ['--eval=1+1']).ok).toBe(false);
  });
  it('python -c / pip -c 这类正常用法不要误伤（但我们靠「一律要审批」兜底）', () => {
    expect(checkCommand('python', ['-c', 'import os']).ok).toBe(true);
  });
  it('工具名与 executor 方法一一对应（少一个别名就是接线断了）', () => {
    const e = ex();
    for (const name of ['list_files', 'search_files', 'read_file', 'write_file', 'apply_patch', 'run_command', 'git_status', 'git_diff', 'git_commit', 'screen_capture']) {
      expect(typeof e[name]).toBe('function');
    }
  });
  it('shell 元字符被拦（这是不拼字符串执行的核心保障）', () => {
    expect(checkCommand('node', ['a.js', '&&', 'rm', '-rf', '/']).ok).toBe(false);
    expect(checkCommand('echo', ['a; b']).ok).toBe(false);
    expect(checkCommand('echo', ['$(whoami)']).ok).toBe(false);
    expect(checkCommand('echo', ['a | b']).ok).toBe(false);
    expect(checkCommand('echo', ['a > b']).ok).toBe(false);
  });
  it('参数里的换行/空字符被拦', () => {
    expect(checkCommand('node', ['a\nb']).ok).toBe(false);
    expect(checkCommand('node', ['a\0b']).ok).toBe(false);
  });
  it('不让直接执行脚本文件（.bat/.cmd/.ps1）', () => {
    expect(checkCommand('deploy.bat', []).ok).toBe(false);
    expect(checkCommand('C:/tools/x.cmd', []).ok).toBe(false);
  });
  it('git push 不走 run_command（另有高风险工具）', () => {
    expect(checkCommand('git', ['push']).ok).toBe(false);
  });
  it('空命令拒绝', () => {
    expect(checkCommand('', []).ok).toBe(false);
    expect(checkCommand(null, []).ok).toBe(false);
  });
  it('白名单本身不含危险程序', () => {
    for (const bad of ['sh', 'bash', 'cmd', 'powershell', 'pwsh', 'curl', 'wget', 'rm', 'del']) {
      expect(COMMAND_WHITELIST).not.toContain(bad);
    }
  });
});

describe('run_command 执行', () => {
  it('策略拒绝的命令不会碰到 bridge.spawn', async () => {
    let spawned = false;
    const e = createExecutor({
      workspace: root,
      bridge: { ...realBridge(), spawn: async () => { spawned = true; return { done: Promise.resolve({ exitCode: 0, stdout: '' }) }; } },
    });
    await expect(e.runCommand({ command: 'curl', args: ['x'] })).rejects.toThrow(/策略拒绝/);
    expect(spawned).toBe(false);
  });

  it('正常命令的结果带回 stdout / stderr / 退出码，并且跑完从 running 里清掉', async () => {
    const e = createExecutor({
      workspace: root,
      bridge: {
        ...realBridge(),
        spawn: async () => ({
          done: Promise.resolve({ exitCode: 0, stdout: '全部通过', stderr: '', timedOut: false }),
          cancel: () => {},
        }),
      },
    });
    const out = await e.runCommand({ command: 'npm', args: ['test'] });
    expect(out).toContain('全部通过');
    expect(out).toContain('退出码 0');
    expect(e.runningCount()).toBe(0);
  });

  it('超时会有明确标注', async () => {
    const e = createExecutor({
      workspace: root,
      bridge: {
        ...realBridge(),
        spawn: async () => ({
          done: Promise.resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: true }),
          cancel: () => {},
        }),
      },
    });
    expect(await e.runCommand({ command: 'node', args: ['x'] })).toContain('已超时终止');
  });

  it('cancelAll 会终止在跑的命令', async () => {
    let cancelled = 0;
    let release;
    const e = createExecutor({
      workspace: root,
      bridge: {
        ...realBridge(),
        spawn: async () => ({
          done: new Promise((resolve) => { release = () => resolve({ exitCode: 1, stdout: '', stderr: '' }); }),
          cancel: () => { cancelled += 1; release && release(); },
        }),
      },
    });
    const p = e.runCommand({ command: 'node', args: ['slow.js'] });
    await new Promise((r) => setTimeout(r, 10));
    expect(e.runningCount()).toBe(1);
    expect(e.cancelAll()).toBe(1);
    expect(cancelled).toBe(1);
    await p;
    expect(e.runningCount()).toBe(0);
  });
});

describe('withTimeout', () => {
  it('到点会 abort，并标记 didTimeout', async () => {
    const t = withTimeout(undefined, 20);
    await new Promise((r) => setTimeout(r, 40));
    expect(t.signal.aborted).toBe(true);
    expect(t.didTimeout()).toBe(true);
    t.cleanup();
  });
  it('外部取消会传导进来，且不算超时', () => {
    const outer = new AbortController();
    const t = withTimeout(outer.signal, 10000);
    outer.abort();
    expect(t.signal.aborted).toBe(true);
    expect(t.didTimeout()).toBe(false);
    t.cleanup();
  });
});

describe('git 工具', () => {
  it('git_status 走 bridge.git，工作区干净时给明确说法', async () => {
    const e = createExecutor({ workspace: root, bridge: { ...realBridge(), git: async () => '' } });
    expect(await e.gitStatus()).toContain('干净');
  });
  it('git_diff 空改动时给明确说法', async () => {
    const e = createExecutor({ workspace: root, bridge: { ...realBridge(), git: async () => '' } });
    expect(await e.gitDiff({})).toContain('没有改动');
  });
  it('git_diff 指定越界路径会被拒', async () => {
    const e = ex();
    await expect(e.gitDiff({ path: '../x' })).rejects.toThrow(/越界/);
  });
  it('git_commit 缺 message 报错', async () => {
    await expect(ex().gitCommit({})).rejects.toThrow(/message/);
  });
  it('git_commit 不自动 add、也不 push（只调 commit -m）', async () => {
    const calls = [];
    const e = createExecutor({
      workspace: root,
      bridge: { ...realBridge(), git: async (o) => { calls.push(o.args); return 'committed'; } },
    });
    await e.gitCommit({ message: 'fix: 无' });
    expect(calls[0]).toEqual(['commit', '-m', 'fix: 无']);
  });
});

describe('缺失能力时给明确错误', () => {
  it('bridge 没提供 screenCapture 时报「未提供能力」', async () => {
    const e = createExecutor({ workspace: root, bridge: {} });
    await expect(e.screenCapture({})).rejects.toThrow(/未提供能力/);
  });
});
