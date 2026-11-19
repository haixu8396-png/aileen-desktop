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
// 命令策略与授权策略各只有一份，渲染层用的是同一批文件（见 shared/command-policy.cjs）
const commandPolicy = require('./command-policy.cjs');
const authzLib = require('./authz.cjs');
const uia = require('./uia.cjs');

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
  // 授权闸门：只有宿主把 authz 模块传进来才启用（旧测试不传，行为不变）。
  // 生产由 main.js 传 shared/authz.cjs + 审计日志 + 原生确认框。
  const authz = deps.authz && typeof deps.authz.decide === 'function' ? deps.authz : null;
  const audit = deps.audit && typeof deps.audit.append === 'function' ? deps.audit : null;
  const confirmAction = typeof deps.confirmAction === 'function' ? deps.confirmAction : null;
  const grants = (authz && typeof authz.createGrants === 'function') ? authz.createGrants({}) : null;

  function agentConfig() {
    try {
      const s = getSettings() || {};
      return (s && s.agent) || {};
    } catch {
      return {};
    }
  }

  function auditWrite(entry) {
    if (!audit) return;
    try { audit.append(entry); } catch { /* 审计坏了不影响业务 */ }
  }

  /** 这是一次「按设置要不要先批准」的动作吗？ */
  function gate(channel, capability, payload) {
    if (!authz || !grants) return { allowed: true, legacy: true };
    const cfg = authz.normalizeCfg(agentConfig().authorization || {});
    const risk = authz.riskOf(capability);
    const d = authz.decide({
      capability, risk, cfg, now: Date.now(),
      requireMedium: agentConfig().requireMedium !== false,
    });
    const base = { channel, capability, risk, reason: d.reason, summary: authz.summarize(capability, payload) };
    if (d.decision === 'allow') {
      auditWrite(Object.assign({ decision: 'allow' }, base));
      return { allowed: true, decision: d };
    }
    if (d.decision === 'deny') {
      auditWrite(Object.assign({ decision: 'deny' }, base));
      const e = new Error('授权已失效（' + d.reason + '），这次操作没有执行');
      e.code = 'AUTH_DENIED';
      throw e;
    }
    // ask：必须有一张「这一次、这个参数」的一次性凭证
    const hash = authz.argsHash(capability, payload);
    if (grants.consume({ capability, argsHash: hash })) {
      auditWrite(Object.assign({ decision: 'grant' }, base));
      return { allowed: true, decision: d };
    }
    auditWrite(Object.assign({ decision: 'deny', reason: 'no-grant' }, base));
    const e = new Error('这次操作需要先获得批准（主进程没有收到有效授权凭证）。请在 Agent 权限面板里批准，或改用信任模式。');
    e.code = 'NEEDS_APPROVAL';
    throw e;
  }

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

  /** 完全放开（用户在设置里显式打开）：路径不再被 workspace 边界挡住 */
  function fullAccessEnabled() {
    try {
      const s = getSettings() || {};
      const auth = (s.agent && s.agent.authorization) || {};
      return auth.fullAccess === true && auth.revokedAt == null;
    } catch {
      return false;
    }
  }

  /** 绝对路径必须落在 workspace 内，且不是敏感路径；完全放开时只剩敏感名单 */
  function resolveSafe(target) {
    const root = workspaceRoot();
    const raw = String(target == null ? '' : target).trim() || '.';
    if (raw.includes('\0')) throw new Error('路径含非法字符');
    const abs = path.resolve(root, raw);
    if (isSensitivePath(abs)) throw new Error('该路径属于敏感文件（凭据 / 密钥 / 设置），Agent 不允许访问');
    if (fullAccessEnabled()) return abs;
    if (!isInsidePath(abs, root)) {
      throw new Error('路径越界（不在工作区内）：' + raw + '。当前工作区是 ' + root
        + '，要么用相对路径，要么让用户在设置里把工作目录改成目标目录。');
    }
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
      gate('agent:fs', authzLib.CAPABILITY.FS_WRITE, p);
      const text = String(p.text == null ? '' : p.text);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, text, 'utf8');
      return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
    }
    if (op === 'stat') {
      const stat = await fs.promises.stat(abs);
      return { size: stat.size, isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs };
    }
    // ---- 复制 / 移动 / 重命名 / 删除（源和目标**两边**都过边界与敏感名单）----
    if (op === 'copy' || op === 'move' || op === 'rename') {
      const from = abs;
      const to = resolveSafe(p.to);
      if (from === to) throw new Error('源路径和目标路径相同');
      const cap = op === 'copy' ? authzLib.CAPABILITY.FS_COPY : authzLib.CAPABILITY.FS_MOVE;
      gate('agent:fs', cap, Object.assign({}, p, { path: p.path, to: p.to }));
      const fromStat = await fs.promises.stat(from);
      if (op === 'copy') {
        if (fromStat.isDirectory()) {
          await fs.promises.cp(from, to, { recursive: true, force: false, errorOnExist: true });
        } else {
          await fs.promises.mkdir(path.dirname(to), { recursive: true });
          if (fs.existsSync(to) && !p.overwrite) throw new Error('目标已存在：' + p.to + '（要覆盖请显式传 overwrite: true）');
          await fs.promises.copyFile(from, to);
        }
        return { ok: true, op: 'copy', from: p.path, to: p.to };
      }
      if (fs.existsSync(to) && !p.overwrite) throw new Error('目标已存在：' + p.to + '（要覆盖请显式传 overwrite: true）');
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.rename(from, to);
      return { ok: true, op, from: p.path, to: p.to };
    }
    if (op === 'remove') {
      gate('agent:fs', authzLib.CAPABILITY.FS_DELETE, { op: 'remove', path: p.path });
      const stat = await fs.promises.stat(abs);
      // 删除一律走回收站：Agent 删错东西不该是不可恢复的。
      // 永久删除这一轮不提供（任务书要求它必须独立确认，界面还没做那个确认）。
      const script = desktopInput.recycleScript(abs, stat.isDirectory());
      const res = await desktopInput.runPwsh(script, 20000);
      if (!res.ok) throw new Error('删除失败：' + (res.err || '未知错误'));
      return { ok: true, op: 'remove', path: p.path, recycle: true, isDirectory: stat.isDirectory() };
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
    // 命令策略在**出口处**再判一次（渲染层那份只是提前给人话错误）：
    // 这一道绕不过去 —— 渲染层被注入、devtools 直接调，都过不了白名单。
    if (!fullAccessEnabled()) {
      const policy = commandPolicy.checkCommand(command, args);
      if (!policy.ok) {
        auditWrite({
          channel: 'agent:exec', capability: authzLib.CAPABILITY.EXEC, risk: authzLib.RISK.HIGH,
          decision: 'deny', reason: 'command-policy:' + policy.code,
          summary: authzLib.summarize(authzLib.CAPABILITY.EXEC, { command, args }),
        });
        const err = new Error('命令被策略拒绝：' + policy.why);
        err.code = policy.code;
        throw err;
      }
    }
    gate('agent:exec', authzLib.CAPABILITY.EXEC, { command, args });
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
    if (sub === 'commit') gate('agent:git', authzLib.CAPABILITY.GIT_COMMIT, { args });
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
      const res = await desktopInput.runPwsh(desktopInput.listWindowsJsonScript(), 15000);
      if (!res.ok) throw new Error('列窗口失败：' + (res.err || '未知错误'));
      let rows = [];
      try {
        const parsed = JSON.parse(res.out || '[]');
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // 老脚本兜底：退回「一行一个标题」
        rows = res.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((title) => ({ title }));
      }
      const windows = rows.filter((w) => w && w.title).map((w) => ({
        id: Number(w.id) || 0,
        title: String(w.title || ''),
        process: String(w.process || ''),
        rect: {
          x: Number(w.x) || 0,
          y: Number(w.y) || 0,
          width: Number(w.width) || 0,
          height: Number(w.height) || 0,
        },
      }));
      // titles 是老契约（chat.js 的工具上下文在用），保留；windows 是新契约（带句柄/进程/矩形）
      return { titles: windows.map((w) => w.title), windows };
    }
    if (op === 'focus') {
      const title = String(p.title || '').trim();
      if (!title) throw new Error('window_focus 需要 title');
      gate('agent:window', authzLib.CAPABILITY.WINDOW_CONTROL, { op: 'focus', title });
      const res = await desktopInput.runPwsh(desktopInput.focusWindowScript(title), 15000);
      if (/NOT_FOUND/.test(res.out)) throw new Error('没有找到标题包含 "' + title + '" 的窗口');
      if (!res.ok) throw new Error('切窗口失败：' + (res.err || '未知错误'));
      return { text: '已切到窗口：' + res.out };
    }
    // 读取前台窗口（动作后验证 + 让模型知道「现在焦点在谁身上」）
    if (op === 'active') {
      const res = await desktopInput.runPwsh(uia.activeWindowScript(), 15000);
      if (!res.ok) throw new Error('读前台窗口失败：' + (res.err || '未知错误'));
      try {
        return { window: JSON.parse(res.out || 'null') };
      } catch {
        throw new Error('前台窗口信息解析失败');
      }
    }
    // 最小化 / 最大化 / 还原 / 关闭（关闭前由权限层要求确认；这里只负责执行）
    if (['minimize', 'maximize', 'restore', 'close'].includes(op)) {
      const title = String(p.title || '').trim();
      if (!title) throw new Error('window ' + op + ' 需要 title（窗口标题关键词）');
      gate('agent:window', authzLib.CAPABILITY.WINDOW_CONTROL, { op, title });
      const res = await desktopInput.runPwsh(uia.windowControlScript({ op, title }), 15000);
      if (!res.ok) throw new Error('窗口 ' + op + ' 失败：' + (res.err || '未知错误'));
      let info = null;
      try { info = JSON.parse(res.out || 'null'); } catch { info = null; }
      if (info && info.ok === false) throw new Error('没有找到标题包含 "' + title + '" 的窗口');
      return { ok: true, op, title: (info && info.title) || title, id: info ? info.id : 0 };
    }
    throw new Error('未知的 agent:window 操作：' + op);
  });

  // ---- UIA 控件树 / 按控件执行语义动作 ----
  // 读树是 LOW（等价于「看屏幕」）；按控件执行动作是 HIGH（等价于「操作电脑」）。
  handle('agent:uia', async (_e, payload) => {
    if (!desktopInput.isWindows()) throw new Error('UIA 目前只支持 Windows');
    const p = payload && typeof payload === 'object' ? payload : {};
    const op = String(p.op || 'tree');
    if (op === 'tree') {
      const depth = Number.isInteger(p.depth) ? p.depth : 3;
      const maxNodes = Number.isInteger(p.maxNodes) ? p.maxNodes : 200;
      const res = await desktopInput.runPwsh(uia.treeScript({ depth, maxNodes }), 25000);
      if (!res.ok) throw new Error('读控件树失败：' + (res.err || '未知错误'));
      let nodes = [];
      try {
        const parsed = JSON.parse(res.out || '[]');
        nodes = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw new Error('控件树解析失败（不是合法 JSON）');
      }
      auditWrite({
        channel: 'agent:uia', capability: authzLib.CAPABILITY.UIA_READ, risk: authzLib.RISK.LOW,
        decision: 'allow', reason: 'low-risk',
        summary: 'tree ' + String(p.window || '') + ' (' + nodes.length + ' nodes)',
      });
      return { window: String(p.window || ''), count: nodes.length, nodes };
    }
    if (op === 'act') {
      const selector = (p.selector && typeof p.selector === 'object') ? p.selector : {};
      const action = String(p.action || 'invoke');
      const value = String(p.value == null ? '' : p.value);
      gate('agent:uia', authzLib.CAPABILITY.UIA_ACT, { op, action, selector, value });
      const res = await desktopInput.runPwsh(uia.actScript({ selector, action, value }), 20000);
      if (!res.ok) throw new Error('控件动作失败：' + (res.err || '未知错误'));
      let info = null;
      try { info = JSON.parse(res.out || 'null'); } catch { info = null; }
      if (!info) throw new Error('控件动作结果解析失败');
      if (info.ok !== true) {
        // 语义调用失败：退回「点控件中心」——由主进程直接注入点击（不经过渲染层）
        if (info.fallback === 'click') {
          const click = await desktopInput.runPwsh(
            desktopInput.clickScript({ button: 'left', x: info.clickX, y: info.clickY }), 10000,
          );
          if (!click.ok) throw new Error('控件不支持语义调用，坐标点击也失败：' + (click.err || '未知错误'));
          return {
            ok: true, action, fallback: 'click', clicked: { x: info.clickX, y: info.clickY },
            element: { name: info.name, role: info.role },
            note: '该控件不支持语义调用（' + String(info.reason || '') + '），已点击它的中心点',
          };
        }
        throw new Error('控件动作失败：' + String(info.reason || 'unknown'));
      }
      return {
        ok: true, action, name: info.name, role: info.role,
        rect: { x: info.x, y: info.y, width: info.width, height: info.height },
      };
    }
    throw new Error('未知的 agent:uia 操作：' + op);
  });

  // ---- 应用：列出有窗口的进程 / 请求退出（优雅关闭，不强杀） ----
  handle('agent:app', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const op = String(p.op || 'list');
    if (op === 'list') {
      const res = await desktopInput.runPwsh(desktopInput.listWindowsJsonScript(), 15000);
      if (!res.ok) throw new Error('列进程失败：' + (res.err || '未知错误'));
      let rows = [];
      try {
        const parsed = JSON.parse(res.out || '[]');
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch { rows = []; }
      const apps = rows.filter((w) => w && w.title).map((w) => ({
        windowId: Number(w.id) || 0,
        title: String(w.title || ''),
        process: String(w.process || ''),
      }));
      return { apps };
    }
    if (op === 'close') {
      const target = String(p.target || '').trim();
      if (!target) throw new Error('app close 需要 target（进程名或窗口标题关键词）');
      gate('agent:app', authzLib.CAPABILITY.APP_CONTROL, { op: 'close', target });
      const b64 = Buffer.from(target, 'utf8').toString('base64');
      const script = [
        "$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
        '$hit = Get-Process | Where-Object { ($_.ProcessName -like "*$t*" -or $_.MainWindowTitle -like "*$t*") -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
        'if (-not $hit) { Write-Output "NOT_FOUND"; exit 3 }',
        '$ok = $hit.CloseMainWindow()',
        'if ($ok) { Start-Sleep -Milliseconds 400 }',
        '@{ ok = [bool]$ok; process = $hit.ProcessName; id = [int]$hit.Id; title = $hit.MainWindowTitle } | ConvertTo-Json -Compress',
      ].join('\n');
      const res = await desktopInput.runPwsh(script, 15000);
      if (/NOT_FOUND/.test(res.out)) throw new Error('没有找到要关闭的应用或窗口：' + target);
      if (!res.ok) throw new Error('关闭应用失败：' + (res.err || '未知错误'));
      let info = null;
      try { info = JSON.parse(res.out || 'null'); } catch { info = null; }
      return {
        ok: !!(info && info.ok),
        process: info ? info.process : '',
        note: info && info.ok ? '已请求关闭（应用可能还要弹「是否保存」）' : '应用没有响应关闭请求，可能正在等用户确认',
      };
    }
    throw new Error('未知的 agent:app 操作：' + op);
  });

  handle('agent:open', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const target = String(p.target || '').trim();
    if (!target) throw new Error('缺少要打开的目标');
    // 再次独立校验（不信任渲染层的判断）：只放行 http(s) 与「干净的程序名」
    if (/^https?:\/\//i.test(target)) {
      gate('agent:open', authzLib.CAPABILITY.APP_LAUNCH, { target });
      const { shell } = deps.electron || {};
      if (!shell || typeof shell.openExternal !== 'function') throw new Error('宿主未提供打开外部链接的能力');
      await shell.openExternal(target);
      return { text: '已在默认浏览器打开 ' + target };
    }
    if (!/^[\w .-]{1,80}$/.test(target)) {
      throw new Error('只允许 http(s) 链接或程序名（不要路径与参数）');
    }
    gate('agent:open', authzLib.CAPABILITY.APP_LAUNCH, { target });
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
      gate('agent:input', authzLib.CAPABILITY.INPUT_POINTER, { op, x, y });
      const res = await desktopInput.runPwsh(desktopInput.mouseScript('move', x, y), 10000);
      if (!res.ok) throw new Error('移动鼠标失败：' + (res.err || '未知错误'));
      return { ok: true, x, y };
    }
    if (op === 'mouseClick') {
      const btn = String(p.button || 'left').toLowerCase();
      if (!['left', 'right', 'middle'].includes(btn)) throw new Error('不支持的鼠标键：' + btn);
      // 带坐标 = 移动与点击合并成一次调用（中间不会被人挪走指针）
      const hasPoint = Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
      const x = hasPoint ? desktopInput.clampCoord(p.x) : null;
      const y = hasPoint ? desktopInput.clampCoord(p.y) : null;
      const double = p.double === true;
      gate('agent:input', authzLib.CAPABILITY.INPUT_POINTER, { op, x, y, button: btn, double });
      const res = await desktopInput.runPwsh(desktopInput.clickScript({ button: btn, double, x, y }), 10000);
      if (!res.ok) throw new Error('点击失败：' + (res.err || '未知错误'));
      return { ok: true, button: btn, double, x, y };
    }
    if (op === 'keyboardType') {
      const text = String(p.text == null ? '' : p.text);
      if (!text) throw new Error('没有要输入的文字');
      gate('agent:input', authzLib.CAPABILITY.INPUT_KEYBOARD, { op, text });
      const res = await desktopInput.runPwsh(desktopInput.typeScript(text), 30000);
      if (!res.ok) throw new Error('输入失败：' + (res.err || '未知错误'));
      return { ok: true, chars: text.length };
    }
    if (op === 'keyboardPress') {
      const keys = Array.isArray(p.keys) ? p.keys.map((k) => desktopInput.normalizeKey(k)) : [];
      if (!keys.length) throw new Error('没有要按下的键');
      gate('agent:input', authzLib.CAPABILITY.INPUT_KEYBOARD, { op, keys });
      const res = await desktopInput.runPwsh(desktopInput.pressScript(keys), 15000);
      if (!res.ok) throw new Error('按键失败：' + (res.err || '未知错误'));
      return { ok: true, keys };
    }
    if (op === 'scroll') {
      const direction = String(p.direction || 'down').toLowerCase();
      const hasPoint = Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
      const x = hasPoint ? desktopInput.clampCoord(p.x) : null;
      const y = hasPoint ? desktopInput.clampCoord(p.y) : null;
      gate('agent:input', authzLib.CAPABILITY.INPUT_POINTER, { op, x, y, direction });
      const plan = desktopInput.scrollScript({ direction, amount: p.amount, x, y });
      const res = await desktopInput.runPwsh(plan.script, 10000);
      if (!res.ok) throw new Error('滚动失败：' + (res.err || '未知错误'));
      return { ok: true, direction: plan.direction, amount: plan.amount, delta: plan.delta, x, y };
    }
    if (op === 'drag') {
      const x = desktopInput.clampCoord(p.x);
      const y = desktopInput.clampCoord(p.y);
      const toX = desktopInput.clampCoord(p.toX);
      const toY = desktopInput.clampCoord(p.toY);
      const button = String(p.button || 'left').toLowerCase();
      gate('agent:input', authzLib.CAPABILITY.INPUT_POINTER, { op, x, y, toX, toY, button });
      const res = await desktopInput.runPwsh(
        desktopInput.dragScript({ x, y, toX, toY, button, steps: p.steps }), 15000,
      );
      if (!res.ok) throw new Error('拖拽失败：' + (res.err || '未知错误'));
      return { ok: true, from: { x, y }, to: { x: toX, y: toY }, button };
    }
    throw new Error('未知的 agent:input 操作：' + op);
  });

  // ---- 授权凭证：渲染层在「用户批准之后」来换一张一次性票 ----
  // 语义：主进程按**设置**重新判一遍（不看渲染层说了什么），
  // 判定为 ask 的动作必须有票才能执行；票绑定「能力 + 参数投影」，用完即焚。
  handle('agent:grant', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const capability = String(p.capability || '');
    const args = (p.args && typeof p.args === 'object' && !Array.isArray(p.args)) ? p.args : {};
    if (!authz || !grants) return { allowed: true, capability, legacy: true };
    if (!authz.isActionCapability(capability)) throw new Error('未知的授权能力：' + capability);

    const risk = authz.riskOf(capability);
    const cfg = authz.normalizeCfg(agentConfig().authorization || {});
    const d = authz.decide({
      capability, risk, cfg, now: Date.now(),
      requireMedium: agentConfig().requireMedium !== false,
    });
    const base = { channel: 'agent:grant', capability, risk, reason: d.reason, summary: authz.summarize(capability, args) };

    if (d.decision === 'allow') {
      auditWrite(Object.assign({ decision: 'allow' }, base));
      return { allowed: true, capability, risk, decision: 'allow' };
    }
    if (d.decision === 'deny') {
      auditWrite(Object.assign({ decision: 'deny' }, base));
      return { allowed: false, capability, risk, reason: d.reason };
    }

    // ask：HIGH / CRITICAL 由主进程自己弹原生确认框（渲染层的卡片是体验层，
    // 真正「用户点过同意」这件事只有主进程自己能证明）。
    if ((risk === 'HIGH' || risk === 'CRITICAL') && confirmAction) {
      let ok = false;
      try {
        ok = !!(await confirmAction({
          capability, risk,
          summary: authz.summarize(capability, args, 400),
          decision: d,
        }));
      } catch {
        ok = false;
      }
      if (!ok) {
        auditWrite(Object.assign({ decision: 'deny', reason: 'user-rejected' }, base));
        return { allowed: false, capability, risk, reason: 'user-rejected' };
      }
    }

    grants.issue({ capability, argsHash: authz.argsHash(capability, args) });
    auditWrite(Object.assign({ decision: 'grant' }, base));
    return { allowed: true, capability, risk, decision: 'grant' };
  });

  // 任务结束：把还没用掉的凭证一次清空（scope=task 的「本任务全部批准」必须真的随任务结束失效）
  handle('agent:grantsRevoke', () => {
    if (grants) grants.clear();
    auditWrite({ channel: 'agent:grantsRevoke', capability: '', decision: 'revoke', reason: 'task-finished', summary: '' });
    return { ok: true };
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
