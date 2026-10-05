'use strict';
// ============================================================
// Agent 工具能力层（Main Process）
//
// 渲染层的 Agent Runtime 只会「说要做什么」，真正碰文件系统、跑进程、
// 调 git、截屏都在这里。这么放有三个理由：
//   1) 渲染层没有 Node 能力（contextIsolation + 无 nodeIntegration）；
//   2) 危险动作必须有一道渲染层绕不过去的边界校验；
//   3) 审批要能用原生弹窗，而不是只靠页面里的一张卡片。
//
// 边界（三重，缺一不可）：
//   · workspace 边界 —— path.resolve 后必须落在 workspace 内
//   · 敏感路径     —— 凭据 / 密钥 / 浏览器数据 / 设置文件一律拒绝
//   · 命令策略     —— 白名单程序 + 参数黑名单，且**永远不经 shell 解析**
//
// 目录项契约（很重要）：readdir 的返回值必须是 [{ name, isDirectory }]。
// Node 的 Dirent.isDirectory() 是个方法，跨 IPC 结构化克隆后会丢掉，
// 只传 Dirent 过去会让对端把文件当目录 —— 这个坑真机踩过。
// ============================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isInsidePath } = require('./util.cjs');
const desktopInput = require('./desktop-input.cjs');

/** 输出上限（防止一条命令把内存和上下文都撑爆） */
const MAX_OUTPUT = 200 * 1024;

/** 敏感路径：命中即拒绝（读也不行 —— Agent 没有理由碰这些） */
const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /(^|[\\/])(Login Data|Cookies|Web Data)$/i,
  /(^|[\\/])(Google[\\/]Chrome|Microsoft[\\/]Edge|BraveSoftware|Mozilla[\\/]Firefox)/i,
  /(^|[\\/])settings\.json$/i,
  /(^|[\\/])secrets[^\\/]*\.json$/i,
  /(^|[\\/])\.credentials\.yaml$/i,
  /(^|[\\/])Windows[\\/]System32/i,
];

function isSensitivePath(p) {
  const s = String(p || '');
  if (!s) return false;
  for (const re of SENSITIVE_PATTERNS) if (re.test(s)) return true;
  return false;
}

/** 只允许 http(s) 之外的都拒掉？这里是给 workspace 用的，不需要 URL 校验 */

/** 把一个目录项摊平成 { name, isDirectory } —— 跨 IPC 后仍然可用 */
function toPlainDirents(entries) {
  return (entries || []).map((e) => ({
    name: typeof e === 'string' ? e : String(e.name),
    isDirectory: typeof e === 'string'
      ? false
      : (typeof e.isDirectory === 'function' ? !!e.isDirectory() : !!e.isDirectory),
  }));
}

/**
 * 跑一个进程：不用 shell，参数数组直传。
 * 处理 cwd / timeout / stdout / stderr / exit code / cancel / 清理。
 */
function runProcess({ command, args, cwd, timeoutMs, maxOutput = MAX_OUTPUT }) {
  return new Promise((resolve) => {
    let child;
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (exitCode, extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(Object.assign({
        exitCode: typeof exitCode === 'number' ? exitCode : -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      }, extra || {}));
    };

    const append = (which, chunk) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length + text.length > maxOutput) { truncated = true; stdout += text.slice(0, Math.max(0, maxOutput - stdout.length)); }
        else stdout += text;
      } else if (stderr.length + text.length > maxOutput) {
        truncated = true;
        stderr += text.slice(0, Math.max(0, maxOutput - stderr.length));
      } else {
        stderr += text;
      }
    };

    try {
      child = spawn(command, Array.isArray(args) ? args : [], {
        cwd: cwd || process.cwd(),
        shell: false,          // 关键：绝不经过 shell 解析
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(-1, { spawnError: String((err && err.message) || err) });
      return;
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs)
      : null;

    child.stdout.on('data', (c) => append('out', c));
    child.stderr.on('data', (c) => append('err', c));
    child.on('error', (err) => finish(-1, { spawnError: String((err && err.message) || err) }));
    child.on('close', (code) => finish(code == null ? -1 : code));

    // 供 executor.cancelAll() 使用
    runProcess.last = child;
  });
}

/** 杀掉整棵进程树（Windows 上 taskkill /T 最可靠，其它平台退回 SIGKILL） */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
  }
}

/**
 * 注册 Agent 相关的 IPC。
 * @param {object} deps
 *   handle               带来源鉴权的 ipcMain.handle 包装器
 *   getSettings          () => settings
 *   defaultWorkspace     () => string   默认工作区（用户数据目录等）
 *   askApproval          async ({ name, riskLevel, preview, args }) => boolean
 *   log                  可选的日志
 */
function registerAgentIpc(deps) {
  const { handle, getSettings, defaultWorkspace } = deps;
  const log = deps.log || (() => {});

  /** 工作区根：设置优先，其次环境变量，最后默认 */
  function workspaceRoot() {
    try {
      const s = getSettings() || {};
      const fromSettings = (s.agent && s.agent.workspace) || '';
      if (fromSettings && fs.existsSync(fromSettings)) return path.resolve(fromSettings);
    } catch { /* 设置读不出来就走兜底 */ }
    const env = process.env.AILEEN_AGENT_WORKSPACE;
    if (env && fs.existsSync(env)) return path.resolve(env);
    const fallback = typeof defaultWorkspace === 'function' ? defaultWorkspace() : process.cwd();
    return path.resolve(fallback);
  }

  /** 绝对路径必须落在 workspace 内，且不是敏感路径 */
  function resolveSafe(target) {
    const root = workspaceRoot();
    const raw = String(target == null ? '' : target).trim() || '.';
    if (raw.includes('\0')) throw new Error('路径含非法字符');
    const abs = path.resolve(root, raw);
    if (!isInsidePath(abs, root)) throw new Error('路径越界（不在工作区内）');
    if (isSensitivePath(abs)) throw new Error('该路径属于敏感文件（凭据 / 密钥 / 设置），Agent 不允许访问');
    return abs;
  }

  handle('agent:workspace', () => ({ workspace: workspaceRoot() }));

  // 鼠标当前位置 + 屏幕尺寸：让模型知道该点哪儿（否则只能瞎猜坐标）
  handle('agent:cursor', () => {
    if (typeof deps.cursorPoint !== 'function') return { x: 0, y: 0, scale: 1, size: null };
    try { return deps.cursorPoint(); } catch { return { x: 0, y: 0, scale: 1, size: null }; }
  });

  // ---- 一次调用干一件事，避免渲染层自由组合出越权路径 ----
  handle('agent:fs', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const op = String(p.op || '');
    const abs = resolveSafe(p.path);
    if (op === 'list') {
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      return { entries: toPlainDirents(entries) };
    }
    if (op === 'read') {
      const stat = await fs.promises.stat(abs);
      if (stat.isDirectory()) throw new Error('这是一个目录，不是文件');
      if (stat.size > 4 * 1024 * 1024) throw new Error('文件太大（超过 4MB），Agent 不适合整份读入');
      return { text: await fs.promises.readFile(abs, 'utf8') };
    }
    if (op === 'write') {
      const text = String(p.text == null ? '' : p.text);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, text, 'utf8');
      return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
    }
    if (op === 'stat') {
      const stat = await fs.promises.stat(abs);
      return { size: stat.size, isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs };
    }
    throw new Error('未知的 agent:fs 操作：' + op);
  });

  // ---- 跑命令 ----
  handle('agent:exec', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const command = String(p.command || '');
    if (!command) throw new Error('缺少要执行的命令');
    const args = Array.isArray(p.args) ? p.args.map((a) => String(a)) : [];
    const timeoutMs = Math.max(1000, Math.min(600000, Number(p.timeoutMs) || 60000));
    const result = await runProcess({ command, args, cwd: workspaceRoot(), timeoutMs });
    log('agent:exec', command, args.join(' '), '->', result.exitCode);
    return result;
  });

  // ---- git（只允许读类与 commit；push 这类高风险动作不在工具清单里）----
  handle('agent:git', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const args = Array.isArray(p.args) ? p.args.map((a) => String(a)) : [];
    const sub = args[0] || '';
    const allowed = ['status', 'diff', 'log', 'show', 'commit', 'rev-parse', 'branch', 'ls-files'];
    if (!allowed.includes(sub)) throw new Error('git 子命令不在允许范围内：' + sub);
    // push / reset --hard / clean 这类不在 allowlist 里，进不来
    if (sub === 'commit' && !args.includes('-m')) throw new Error('git commit 必须带 -m');
    const timeoutMs = Math.max(1000, Math.min(120000, Number(p.timeoutMs) || 30000));
    const result = await runProcess({ command: 'git', args, cwd: workspaceRoot(), timeoutMs });
    const parts = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(result.stderr);
    if (result.exitCode !== 0 && !parts.length) parts.push('git 退出码 ' + result.exitCode);
    return { text: parts.join('\n').trim(), exitCode: result.exitCode };
  });

  // ---- 截屏（Agent 的「眼睛」；复用 desktopCapturer，只回尺寸/名称或缩略图）----
  handle('agent:screenshot', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (typeof deps.captureScreen !== 'function') throw new Error('宿主未提供截屏能力');
    return deps.captureScreen({ withData: !!p.withData });
  });

  // ---- 电脑控制：窗口 / 启动应用 / 输入注入 ----
  // 这些是**高权限**能力，但这里不做「要不要问」的判断 —— 那是权限层的事，
  // 主进程只保证「被调用时怎么安全地执行」。

  handle('agent:window', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const op = String(p.op || 'list');
    if (op === 'list') {
      const res = await desktopInput.runPwsh(desktopInput.listWindowsScript(), 15000);
      if (!res.ok) throw new Error('列窗口失败：' + (res.err || '未知错误'));
      return { titles: res.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
    }
    if (op === 'focus') {
      const title = String(p.title || '').trim();
      if (!title) throw new Error('window_focus 需要 title');
      const res = await desktopInput.runPwsh(desktopInput.focusWindowScript(title), 15000);
      if (/NOT_FOUND/.test(res.out)) throw new Error('没有找到标题包含 "' + title + '" 的窗口');
      if (!res.ok) throw new Error('切窗口失败：' + (res.err || '未知错误'));
      return { text: '已切到窗口：' + res.out };
    }
    throw new Error('未知的 agent:window 操作：' + op);
  });

  handle('agent:open', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const target = String(p.target || '').trim();
    if (!target) throw new Error('缺少要打开的目标');
    // 再次独立校验（不信任渲染层的判断）：只放行 http(s) 与「干净的程序名」
    if (/^https?:\/\//i.test(target)) {
      const { shell } = deps.electron || {};
      if (!shell || typeof shell.openExternal !== 'function') throw new Error('宿主未提供打开外部链接的能力');
      await shell.openExternal(target);
      return { text: '已在默认浏览器打开 ' + target };
    }
    if (!/^[\w .-]{1,80}$/.test(target)) {
      throw new Error('只允许 http(s) 链接或程序名（不要路径与参数）');
    }
    const res = await desktopInput.runPwsh('Start-Process -FilePath ' + JSON.stringify(target), 15000);
    if (!res.ok) throw new Error('打开 ' + target + ' 失败：' + (res.err || '未知错误'));
    return { text: '已启动 ' + target };
  });

  handle('agent:input', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const op = String(p.op || '');
    if (!desktopInput.isWindows()) throw new Error('电脑控制目前只支持 Windows');

    if (op === 'mouseMove') {
      const x = desktopInput.clampCoord(p.x);
      const y = desktopInput.clampCoord(p.y);
      const res = await desktopInput.runPwsh(desktopInput.mouseScript('move', x, y), 10000);
      if (!res.ok) throw new Error('移动鼠标失败：' + (res.err || '未知错误'));
      return { ok: true, x, y };
    }
    if (op === 'mouseClick') {
      const btn = String(p.button || 'left').toLowerCase();
      if (!['left', 'right', 'middle'].includes(btn)) throw new Error('不支持的鼠标键：' + btn);
      const res = await desktopInput.runPwsh(desktopInput.mouseScript(btn, 0, 0), 10000);
      if (!res.ok) throw new Error('点击失败：' + (res.err || '未知错误'));
      return { ok: true, button: btn, double: !!p.double };
    }
    if (op === 'keyboardType') {
      const text = String(p.text == null ? '' : p.text);
      if (!text) throw new Error('没有要输入的文字');
      const res = await desktopInput.runPwsh(desktopInput.typeScript(text), 30000);
      if (!res.ok) throw new Error('输入失败：' + (res.err || '未知错误'));
      return { ok: true, chars: text.length };
    }
    if (op === 'keyboardPress') {
      const keys = Array.isArray(p.keys) ? p.keys.map((k) => desktopInput.normalizeKey(k)) : [];
      if (!keys.length) throw new Error('没有要按下的键');
      const res = await desktopInput.runPwsh(desktopInput.pressScript(keys), 15000);
      if (!res.ok) throw new Error('按键失败：' + (res.err || '未知错误'));
      return { ok: true, keys };
    }
    throw new Error('未知的 agent:input 操作：' + op);
  });
}

module.exports = {
  registerAgentIpc,
  isSensitivePath,
  toPlainDirents,
  runProcess,
  killTree,
  SENSITIVE_PATTERNS,
};
