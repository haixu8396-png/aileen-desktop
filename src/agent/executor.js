// ============================================================
// Executor：唯一真正碰文件系统 / 进程 / git 的地方
//
// 三道闸门，顺序不能换：
//   1) Command Policy  —— 程序白名单 + 参数模式黑名单（危险参数直接拒）
//   2) Workspace 边界  —— path.resolve 后必须落在 workspace 内
//   3) Permission      —— 由 runtime 提前问过（这里只负责执行）
//
// 依赖全部注入（deps.bridge），所以这一层能在没有 Electron 的 vitest 里
// 用真实临时目录跑，也能用假桥接做边界与超时测试。
//
// 绝不做的事：child_process.exec(拼接字符串)。命令一律 spawn(程序, 参数数组)。
// ============================================================
import nodePath from 'node:path';
import util from '../../shared/util.cjs';

const { isInsidePath } = util;

/** 允许执行的程序（白名单）。不在表里的一律拒绝。 */
export const COMMAND_WHITELIST = [
  'node', 'npm', 'npx', 'git', 'pnpm', 'yarn',
  'python', 'python3', 'py', 'pip', 'uv',
  'cargo', 'go', 'dotnet', 'java', 'mvn', 'gradle',
  'rg', 'ls', 'dir', 'cat', 'type', 'echo', 'where', 'which',
];

/** 参数模式黑名单：命中就拒（这些参数能反过来执行任意命令/删盘） */
export const ARG_PATTERNS = [
  // -e / --exec / --eval 这类参数等于「把代码当参数传进去执行」，绕开一切白名单。
  // 注意不要加 -c：pip -c / gradle -c 是正常用法，把它拦掉会误伤正经命令。
  { re: /^-{1,2}(e|exec|eval)([=:].*)?$/i, why: '参数可以执行任意代码' },
  { re: /^-{1,2}(command|prefix)$/i, why: '参数可以改写要执行的程序' },
  { re: /^-{1,2}(global|g)$/i, why: '会改动全局环境' },
  { re: /^-{1,2}(force|f)$/i, why: '强制模式风险过高' },
  { re: /\bnpm\s+(i|install|add)\b/i, why: '安装依赖会执行 postinstall 脚本' },
];

function baseName(cmd) {
  const s = String(cmd || '').trim();
  const parts = s.split(/[\\/]/);
  return (parts[parts.length - 1] || '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * 命令策略校验。
 * @returns {{ok:boolean, why?:string, code?:string}}
 */
export function checkCommand(command, args) {
  const base = baseName(command);
  if (!base) return { ok: false, code: 'NO_COMMAND', why: '没有指定要执行什么命令' };
  if (base.includes('.') && /\.(bat|cmd|ps1|vbs|js)$/i.test(String(command))) {
    return { ok: false, code: 'SCRIPT_FILE', why: '不允许直接执行脚本文件（请用 node/npm 等解释器）' };
  }
  if (!COMMAND_WHITELIST.includes(base)) {
    return { ok: false, code: 'NOT_WHITELISTED', why: '程序 "' + base + '" 不在白名单里' };
  }
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  for (const arg of list) {
    if (/[\r\n\0]/.test(arg)) return { ok: false, code: 'BAD_ARG', why: '参数里含有换行或空字符' };
    if (/[;&|`$><]/.test(arg)) {
      return { ok: false, code: 'SHELL_META', why: '参数里含有 shell 元字符：' + arg.slice(0, 40) };
    }
    for (const p of ARG_PATTERNS) {
      if (p.re.test(arg)) return { ok: false, code: 'DANGEROUS_ARG', why: p.why + '（' + arg + '）' };
    }
  }
  if (base === 'git' && list[0] === 'push') {
    return { ok: false, code: 'GIT_PUSH', why: 'git push 由单独的高风险工具负责，这里不允许' };
  }
  return { ok: true };
}

/** 工作区边界：绝对路径 / .. / 符号链接都要落到 workspace 里 */
export function resolveInsideWorkspace(workspace, target) {
  const root = String(workspace || '').trim();
  if (!root) throw new Error('未绑定 workspace');
  if (typeof target !== 'string') throw new Error('路径必须是字符串');
  const raw = target.trim() === '' ? '.' : target.trim();
  if (raw.includes('\0')) throw new Error('路径含非法字符');
  const abs = nodePath.resolve(root, raw);
  if (!isInsidePath(abs, root)) {
    const e = new Error('路径越界（不在工作区内）：' + raw);
    e.code = 'OUTSIDE_WORKSPACE';
    throw e;
  }
  return abs;
}

/** 合并 run 的 AbortSignal 与超时，导出单一 signal + 清理函数 */
export function withTimeout(signal, timeoutMs) {
  const ctrl = new AbortController();
  const ms = Math.max(0, Number(timeoutMs) || 0);
  let timer = null;
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (ms > 0) {
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  }
  return {
    signal: ctrl.signal,
    didTimeout: () => timedOut,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 判断一个目录项是不是目录。
 *
 * 为什么这里要这么啰嗦（这是真机上踩过的坑）：
 * Node 的 readdir({withFileTypes:true}) 返回的 Dirent，其 isDirectory()
 * 是个**方法**；一旦结果经由 IPC / structuredClone 传出去，方法就没了，
 * 只剩 name 和 parentPath —— 直接写 !!entry.isDirectory 会恒为 false
 * （或恒为 true，取决于写法），表现就是「搜索永远搜不到东西」。
 *
 * 所以桥接契约是：**每个条目必须带 name 与布尔 isDirectory**。
 * 这里同时兼容三种形态，谁都不会静默走错：
 *   · { name, isDirectory: true|false }   ← 约定形状（IPC 传这个）
 *   · Dirent（isDirectory 是方法）        ← 主进程内直接读时
 *   · 'name' 字符串                       ← 最简单的情形
 */
function isDirEntry(entry) {
  if (typeof entry === 'string') return false;
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.isDirectory === 'function') return !!entry.isDirectory();
  if (typeof entry.isDirectory === 'boolean') return entry.isDirectory;
  if (typeof entry.isFile === 'function') return !entry.isFile();
  return false;
}

/**
 * 建立 executor。
 * @param {object} deps
 *   workspace  工作区绝对路径
 *   bridge     宿主注入的能力：{ readFile, writeFile, readdir, stat, spawn, git, screenCapture }
 *   isSensitive 可选：判断某个绝对路径是否属于「敏感（不许读/写）」名单
 */
export function createExecutor(deps) {
  const workspace = String((deps && deps.workspace) || '');
  const bridge = (deps && deps.bridge) || {};
  const isSensitive = typeof (deps && deps.isSensitive) === 'function' ? deps.isSensitive : () => false;
  const running = new Set();

  function need(name) {
    if (typeof bridge[name] !== 'function') {
      throw new Error('宿主未提供能力：' + name);
    }
  }

  function guard(target) {
    return resolveInsideWorkspace(workspace, target);
  }

  function denySensitive(abs) {
    if (isSensitive(abs)) {
      const e = new Error('该路径属于敏感文件（凭据 / 密钥 / 设置），Agent 不允许访问');
      e.code = 'SENSITIVE_PATH';
      throw e;
    }
  }

  const api = {
    workspace,
    /** 当前有几次子进程在跑（取消后要确认都清干净） */
    runningCount() {
      return running.size;
    },

    async listFiles({ path: p = '.', depth = 1 } = {}) {
      const abs = guard(p);
      denySensitive(abs);
      need('readdir');
      const maxDepth = Math.max(1, Math.min(6, Number(depth) || 1));
      const out = [];
      async function walk(dir, level, prefix) {
        if (level > maxDepth) return;
        const entries = await bridge.readdir(dir);
        for (const entry of entries) {
          const name = typeof entry === 'string' ? entry : entry.name;
          const isDir = isDirEntry(entry);
          if (name === '.git' || name === 'node_modules') {
            out.push(prefix + name + '/' + (isDir ? ' （已跳过内容）' : ''));
            continue;
          }
          out.push(prefix + name + (isDir ? '/' : ''));
          if (isDir && level < maxDepth) {
            const sub = await bridge.readdir(joinPath(dir, name)).catch(() => []);
            for (const child of sub) {
              const cn = typeof child === 'string' ? child : child.name;
              const cd = isDirEntry(child);
              out.push(prefix + name + '/' + cn + (cd ? '/' : ''));
            }
          }
          if (out.length > 800) return;
        }
      }
      await walk(abs, 1, p === '.' ? '' : String(p).replace(/\\/g, '/') + '/');
      return out.slice(0, 800).join('\n');
    },

    async searchFiles({ query, path: p = '.', maxResults = 50 } = {}) {
      const needle = String(query || '');
      if (!needle) throw new Error('search_files 缺少 query');
      const abs = guard(p);
      denySensitive(abs);
      need('readdir');
      need('readFile');
      const limit = Math.max(1, Math.min(200, Number(maxResults) || 50));
      const hits = [];
      const skipDirs = new Set(['.git', 'node_modules', 'dist', 'release', '.vite']);
      async function walk(dir, level) {
        if (hits.length >= limit || level > 6) return;
        const entries = await bridge.readdir(dir).catch(() => []);
        for (const entry of entries) {
          if (hits.length >= limit) return;
          const name = typeof entry === 'string' ? entry : entry.name;
          const isDir = isDirEntry(entry);
          if (isDir) {
            if (skipDirs.has(name)) continue;
            await walk(joinPath(dir, name), level + 1);
            continue;
          }
          if (!/\.(js|mjs|cjs|json|md|txt|yml|yaml|html|css|ts|ps1|bat)$/i.test(name)) continue;

          const file = joinPath(dir, name);
          const text = await bridge.readFile(file).catch(() => '');
          if (!text) continue;
          const lines = String(text).split('\n');
          for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
            if (lines[i].includes(needle)) {
              hits.push(relPath(workspace, file) + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 200));
            }
          }
        }
      }
      await walk(abs, 1);
      if (!hits.length) return '没有找到包含 "' + needle + '" 的位置';
      return hits.join('\n');
    },

    async readFile({ path: p, offset = 1, limit = 400 } = {}) {
      const abs = guard(p);
      denySensitive(abs);
      need('readFile');
      const text = await bridge.readFile(abs, 'utf8');
      const lines = String(text == null ? '' : text).split('\n');
      const start = Math.max(1, Number(offset) || 1);
      const count = Math.max(1, Math.min(2000, Number(limit) || 400));
      const slice = lines.slice(start - 1, start - 1 + count);
      const numbered = slice.map((line, i) => String(start + i).padStart(5, ' ') + '| ' + line).join('\n');
      const tail = start - 1 + count < lines.length ? '\n…（文件共 ' + lines.length + ' 行，还没读完）' : '';
      return numbered + tail;
    },

    async writeFile({ path: p, content } = {}) {
      const abs = guard(p);
      denySensitive(abs);
      need('writeFile');
      const text = String(content == null ? '' : content);
      await bridge.writeFile(abs, text, 'utf8');
      return '已写入 ' + relPath(workspace, abs) + '（' + text.length + ' 字符）';
    },

    async applyPatch({ path: p, old: oldText, new: newText } = {}) {
      const abs = guard(p);
      denySensitive(abs);
      need('readFile');
      need('writeFile');
      const src = String(oldText == null ? '' : oldText);
      if (!src) throw new Error('apply_patch 的 old 不能为空');
      const text = String(await bridge.readFile(abs, 'utf8'));
      const first = text.indexOf(src);
      if (first < 0) throw new Error('在 ' + relPath(workspace, abs) + ' 里找不到要替换的原文');
      if (text.indexOf(src, first + src.length) >= 0) {
        throw new Error('要替换的原文在该文件里出现了多次，请给出更长的上下文');
      }
      const next = text.slice(0, first) + String(newText == null ? '' : newText) + text.slice(first + src.length);
      await bridge.writeFile(abs, next, 'utf8');
      return '已修改 ' + relPath(workspace, abs) + '（替换 ' + src.length + ' 字符）';
    },

    async runCommand({ command, args = [], timeoutMs = 60000 } = {}) {
      const check = checkCommand(command, args);
      if (!check.ok) {
        const e = new Error('命令被策略拒绝：' + check.why);
        e.code = check.code;
        throw e;
      }
      need('spawn');
      const ms = Math.max(1000, Math.min(600000, Number(timeoutMs) || 60000));
      const handle = await bridge.spawn({
        command: String(command),
        args: (Array.isArray(args) ? args : []).map((a) => String(a)),
        cwd: workspace,
        timeoutMs: ms,
      });
      running.add(handle);
      try {
        const result = await handle.done;
        const parts = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push('【stderr】\n' + result.stderr);
        parts.push('（退出码 ' + result.exitCode + (result.timedOut ? '，已超时终止' : '') + '）');
        return parts.join('\n');
      } finally {
        running.delete(handle);
      }
    },

    async gitStatus() {
      need('git');
      const out = await bridge.git({ args: ['status', '--short', '--branch'], cwd: workspace });
      return out || '（工作区干净）';
    },

    async gitDiff({ path: p = '', staged = false } = {}) {
      need('git');
      const args = ['diff'];
      if (staged) args.push('--staged');
      if (p) args.push('--', relPath(workspace, guard(p)));
      const out = await bridge.git({ args, cwd: workspace });
      return out || '（没有改动）';
    },

    async gitCommit({ message } = {}) {
      const msg = String(message || '').trim();
      if (!msg) throw new Error('git_commit 缺少 message');
      need('git');
      const out = await bridge.git({ args: ['commit', '-m', msg], cwd: workspace, timeoutMs: 60000 });
      return out || '（提交完成，无输出）';
    },

    async screenCapture({ withData = false } = {}) {
      need('screenCapture');
      return bridge.screenCapture({ withData: !!withData });
    },

    // ---- 电脑控制（鼠标 / 键盘 / 窗口 / 启动应用）----
    // 全部走桥接：渲染层不知道 Windows API 长什么样，主进程也不认识权限层。
    // 权限分级在 permission.js 里定：读类 LOW，动作类 HIGH（默认必须确认）。

    async windowList() {
      need('windowList');
      const list = await bridge.windowList();
      if (!Array.isArray(list) || !list.length) return '没有可用的窗口信息';
      return list.map((w, i) => (i + 1) + '. ' + w).join('\n');
    },

    async windowFocus({ title } = {}) {
      const t = String(title || '').trim();
      if (!t) throw new Error('window_focus 需要 title');
      need('windowFocus');
      const res = await bridge.windowFocus({ title: t });
      return (res && res.text) || ('已把匹配 "' + t + '" 的窗口切到前台');
    },

    async openApplication({ target } = {}) {
      const t = String(target || '').trim();
      if (!t) throw new Error('open_application 需要 target');
      // 只允许 http(s) 链接与「像程序名」的短字符串：
      // 这一条挡住把任意路径/参数塞进来的做法。
      const isUrl = /^https?:\/\//i.test(t);
      if (!isUrl && !/^[\w .-]{1,80}$/.test(t)) {
        throw new Error('open_application 只接受 http(s) 链接或程序名（不要路径和参数）');
      }
      need('openApplication');
      const res = await bridge.openApplication({ target: t, isUrl });
      return (res && res.text) || ('已打开 ' + t);
    },

    async mouseMove({ x, y } = {}) {
      const logicalX = Math.round(Number(x));
      const logicalY = Math.round(Number(y));
      if (!Number.isFinite(logicalX) || !Number.isFinite(logicalY)) {
        throw new Error('mouse_move 需要数字坐标 x / y');
      }
      need('mouseMove');
      // 模型看到的是**逻辑像素**（截屏/DOM 的坐标系），而 SetCursorPos 要物理像素。
      // 不乘缩放因子的话，125% / 150% 缩放的屏幕上会点偏。
      const p = (typeof bridge.cursor === 'function') ? await bridge.cursor() : null;
      const scale = Number(p && p.scale) || 1;
      const px = Math.round(logicalX * scale);
      const py = Math.round(logicalY * scale);
      await bridge.mouseMove({ x: px, y: py });
      return '鼠标已移动到 (' + px + ', ' + py + ')' + (scale !== 1 ? '（逻辑坐标 ' + logicalX + ', ' + logicalY + ' × 缩放 ' + scale + '）' : '');
    },

    async mouseClick({ button = 'left', double = false } = {}) {
      const btn = String(button || 'left').toLowerCase();
      if (!['left', 'right', 'middle'].includes(btn)) throw new Error('mouse_click 的 button 只能是 left / right / middle');
      need('mouseClick');
      await bridge.mouseClick({ button: btn, double: !!double });
      return '已' + (double ? '双击' : '单击') + '鼠标' + btn;
    },

    async keyboardType({ text } = {}) {
      const s = String(text == null ? '' : text);
      if (!s) throw new Error('keyboard_type 需要 text');
      if (s.length > 2000) throw new Error('一次输入最多 2000 字符');
      need('keyboardType');
      await bridge.keyboardType({ text: s });
      return '已输入 ' + s.length + ' 个字符';
    },

    async keyboardPress({ keys } = {}) {
      const list = Array.isArray(keys) ? keys.map((k) => String(k)) : [];
      if (!list.length) throw new Error('keyboard_press 需要 keys 数组，例如 ["ctrl","c"]');
      need('keyboardPress');
      await bridge.keyboardPress({ keys: list });
      return '已按下 ' + list.join('+');
    },

    /** 取消：终止所有在跑的子进程 */
    cancelAll() {
      let n = 0;
      for (const handle of Array.from(running)) {
        try { if (handle && typeof handle.cancel === 'function') handle.cancel(); n += 1; } catch { /* 忽略 */ }
      }
      return n;
    },
  };

  // 把 camelCase 实现挂成工具名（snake_case）—— runtime 是按工具名找实现的
  for (const [toolName, method] of Object.entries(TOOL_METHOD_ALIASES)) {
    if (typeof api[method] === 'function' && typeof api[toolName] !== 'function') {
      api[toolName] = api[method].bind(api);
    }
  }

  return api;
}

/**
 * 工具名 → executor 方法的适配表。
 *
 * 为什么需要它：runtime 是按**工具名**（snake_case）去找实现的，
 * 而内部方法名是 camelCase。少一个别名就是「这个工具还没有接到宿主实现」，
 * 所以这里显式列全，并在下面挂上去。
 */
export const TOOL_METHOD_ALIASES = {
  list_files: 'listFiles',
  search_files: 'searchFiles',
  read_file: 'readFile',
  write_file: 'writeFile',
  apply_patch: 'applyPatch',
  run_command: 'runCommand',
  git_status: 'gitStatus',
  git_diff: 'gitDiff',
  git_commit: 'gitCommit',
  screen_capture: 'screenCapture',
  window_list: 'windowList',
  window_focus: 'windowFocus',
  open_application: 'openApplication',
  mouse_move: 'mouseMove',
  mouse_click: 'mouseClick',
  keyboard_type: 'keyboardType',
  keyboard_press: 'keyboardPress',
};

function joinPath(a, b) { return nodePath.join(a, b); }
function relPath(root, abs) {
  try { return nodePath.relative(root, abs).replace(/\\/g, '/') || '.'; } catch { return abs; }
}
