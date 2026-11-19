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
// 绝对不要在这里 `import nodePath from 'node:path'`：
// 渲染层是浏览器 bundle，Vite 会把 node:path 换成 stub，调用时抛
// `nodePath.resolve is not a function` —— 真机上表现为「写文件 / 打补丁 /
// 列目录 / 读文件全部同一个内部错误」，而单测跑在 Node 上完全正常（抓不到）。
// 路径运算统一走 shared/path-util.cjs（纯 JS，渲染层与主进程都能用）。
import pathUtil from '../../shared/path-util.cjs';
// 命令策略只有一份（shared/command-policy.cjs），主进程出口处用的是同一个函数。
// 以前白名单只写在渲染层，主进程 agent:exec 什么命令都收 —— 那是「渲染层被注入
// 就等于任意命令执行」的根因。现在两边共用，渲染层这份只负责给出人话错误。
import commandPolicy from '../../shared/command-policy.cjs';

const { resolve: pathResolve, join: pathJoin, relative: pathRelative, isInside } = pathUtil;
const { COMMAND_WHITELIST, ARG_PATTERNS, baseName, checkCommand } = commandPolicy;

export { COMMAND_WHITELIST, ARG_PATTERNS, baseName, checkCommand };

/** 工作区边界：绝对路径 / .. / 符号链接都要落到 workspace 里 */
export function resolveInsideWorkspace(workspace, target) {
  const root = String(workspace || '').trim();
  if (!root) throw new Error('未绑定 workspace');
  if (typeof target !== 'string') throw new Error('路径必须是字符串');
  const raw = target.trim() === '' ? '.' : target.trim();
  if (raw.includes('\0')) throw new Error('路径含非法字符');
  const abs = pathResolve(root, raw);
  if (!isInside(abs, root)) {
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
 *   fullAccess 可选：完全放开时不再限制「必须落在 workspace 内」（敏感名单照旧拒绝），
 *              并且不再用命令白名单拦跑命令 —— 用户显式选择了「不要再问」，
 *              再拿白名单静默拦下来只会变成另一种「说不清为什么不行」。
 */
export function createExecutor(deps) {
  const workspace = String((deps && deps.workspace) || '');
  const bridge = (deps && deps.bridge) || {};
  const isSensitive = typeof (deps && deps.isSensitive) === 'function' ? deps.isSensitive : () => false;
  const fullAccess = !!(deps && deps.fullAccess);
  const running = new Set();

  function need(name) {
    if (typeof bridge[name] !== 'function') {
      throw new Error('宿主未提供能力：' + name);
    }
  }

  function guard(target) {
    if (!fullAccess) return resolveInsideWorkspace(workspace, target);
    // 完全放开：相对路径仍然相对 workspace，绝对路径原样用；
    // 唯一例外是敏感名单（凭据 / 密钥 / 设置文件），一律拒绝。
    if (!workspace) throw new Error('未绑定 workspace');
    const raw = String(target == null ? '' : target).trim() || '.';
    if (raw.includes('\0')) throw new Error('路径含非法字符');
    return pathResolve(workspace, raw);
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
      // 完全放开时不做命令白名单拦截（仍然不经 shell、参数数组直传）。
      // 严格模式下照旧：白名单 + 参数黑名单 + 危险参数一律拒绝。
      if (!fullAccess) {
        const check = checkCommand(command, args);
        if (!check.ok) {
          const e = new Error('命令被策略拒绝：' + check.why);
          e.code = check.code;
          throw e;
        }
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
      // 桥接可能回字符串（旧契约为标题列表）或 { title, process, rect }（新契约）。
      // 两个都认：模型看到的永远是「一行一个窗口、带进程与尺寸」，方便它挑目标。
      return list.map((w, i) => {
        if (typeof w === 'string') return (i + 1) + '. ' + w;
        const title = String(w.title || w.name || '（无标题）');
        const proc = w.process ? '｜进程 ' + w.process : '';
        const rect = w.rect && Number.isFinite(w.rect.width)
          ? '｜' + w.rect.width + '×' + w.rect.height + ' @' + w.rect.x + ',' + w.rect.y
          : '';
        return (i + 1) + '. ' + title + proc + rect;
      }).join('\n');
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

    async mouseClick({ button = 'left', double = false, x, y } = {}) {
      const btn = String(button || 'left').toLowerCase();
      if (!['left', 'right', 'middle'].includes(btn)) throw new Error('mouse_click 的 button 只能是 left / right / middle');
      // 允许「先移到目标再点」在一次调用里完成：分两次 IPC 时用户随手动一下鼠标，
      // 点下去的就是别的东西（非幂等误操作）。有坐标就必须一次性完成。
      let px = null;
      let py = null;
      if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
        const p = (typeof bridge.cursor === 'function') ? await bridge.cursor() : null;
        const scale = Number(p && p.scale) || 1;
        px = Math.round(Number(x) * scale);
        py = Math.round(Number(y) * scale);
      }
      need('mouseClick');
      await bridge.mouseClick({ button: btn, double: !!double, x: px, y: py });
      const where = px === null ? '' : '（先移到 ' + px + ', ' + py + '）';
      return '已' + (double ? '双击' : '单击') + '鼠标' + btn + where;
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

    async mouseScroll({ direction = 'down', amount = 3, x, y } = {}) {
      const dir = String(direction || 'down').toLowerCase();
      if (!['up', 'down'].includes(dir)) throw new Error('mouse_scroll 的 direction 只能是 up / down');
      const steps = Math.max(1, Math.min(50, Math.round(Number(amount) || 3)));
      let px = null;
      let py = null;
      if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
        const p = (typeof bridge.cursor === 'function') ? await bridge.cursor() : null;
        const scale = Number(p && p.scale) || 1;
        px = Math.round(Number(x) * scale);
        py = Math.round(Number(y) * scale);
      }
      need('mouseScroll');
      await bridge.mouseScroll({ direction: dir, amount: steps, x: px, y: py });
      return '已向' + (dir === 'up' ? '上' : '下') + '滚动 ' + steps + ' 格' + (px === null ? '' : '（在 ' + px + ',' + py + ' 处）');
    },

    async mouseDrag({ x, y, toX, toY, button = 'left' } = {}) {
      const nums = [x, y, toX, toY].map((v) => Math.round(Number(v)));
      if (nums.some((v) => !Number.isFinite(v))) throw new Error('mouse_drag 需要数字坐标 x / y / toX / toY');
      const btn = String(button || 'left').toLowerCase();
      if (!['left', 'right', 'middle'].includes(btn)) throw new Error('mouse_drag 的 button 只能是 left / right / middle');
      const p = (typeof bridge.cursor === 'function') ? await bridge.cursor() : null;
      const scale = Number(p && p.scale) || 1;
      const from = { x: Math.round(nums[0] * scale), y: Math.round(nums[1] * scale) };
      const to = { x: Math.round(nums[2] * scale), y: Math.round(nums[3] * scale) };
      need('mouseDrag');
      await bridge.mouseDrag({ x: from.x, y: from.y, toX: to.x, toY: to.y, button: btn });
      return '已从 (' + from.x + ',' + from.y + ') 拖到 (' + to.x + ',' + to.y + ')';
    },

    // ---- 文件操作（复制 / 移动 / 删除到回收站）----
    async copyPath({ path: from, to, overwrite = false } = {}) {
      need('copyPath');
      await bridge.copyPath({ path: String(from || ''), to: String(to || ''), overwrite: !!overwrite });
      return '已复制 ' + String(from || '') + ' → ' + String(to || '');
    },

    async movePath({ path: from, to, overwrite = false } = {}) {
      need('movePath');
      await bridge.movePath({ path: String(from || ''), to: String(to || ''), overwrite: !!overwrite });
      return '已移动 ' + String(from || '') + ' → ' + String(to || '');
    },

    async deletePath({ path: p } = {}) {
      need('deletePath');
      const res = await bridge.deletePath({ path: String(p || '') });
      return '已删除 ' + String(p || '') + '（移入回收站，可恢复）';
    },

    // ---- 窗口 / UIA / 应用 ----
    async windowActive() {
      need('windowActive');
      const res = await bridge.windowActive();
      const w = (res && res.window) || null;
      if (!w) return '当前没有前台窗口信息';
      return '当前前台窗口：' + (w.title || '（无标题）') + (w.process ? '｜进程 ' + w.process : '')
        + '｜' + (w.width || 0) + '×' + (w.height || 0) + ' @' + (w.x || 0) + ',' + (w.y || 0);
    },

    async windowControl({ op = 'restore', title } = {}) {
      const action = String(op || '').toLowerCase();
      if (!['focus', 'minimize', 'maximize', 'restore', 'close'].includes(action)) {
        throw new Error('window_control 的 op 只能是 focus / minimize / maximize / restore / close');
      }
      const t = String(title || '').trim();
      if (!t) throw new Error('window_control 需要 title（窗口标题关键词）');
      need('windowControl');
      if (action === 'focus') {
        const res = await bridge.windowFocus({ title: t });
        return (res && res.text) || ('已把匹配 "' + t + '" 的窗口切到前台');
      }
      const res = await bridge.windowControl({ op: action, title: t });
      return '已对窗口「' + ((res && res.title) || t) + '」执行 ' + action
        + (action === 'close' ? '（如果应用问「是否保存」，请自己看清楚再回答）' : '');
    },

    async uiTree({ window, depth = 3, maxNodes = 200 } = {}) {
      need('uiTree');
      const res = await bridge.uiTree({ window: String(window || ''), depth, maxNodes });
      const nodes = (res && res.nodes) || [];
      if (!nodes.length) return '这个窗口没有可读的控件（可能是自绘界面）。可以改用截图 + 坐标点击。';
      const lines = nodes.map((n) => {
        const indent = '  '.repeat(Math.max(0, Math.min(6, Number(n.level) || 0)));
        const bits = [];
        if (n.role) bits.push(n.role);
        if (n.name) bits.push('"' + n.name + '"');
        if (n.automationId) bits.push('#' + n.automationId);
        if (n.patterns && n.patterns.length) bits.push('[' + n.patterns.join('/') + ']');
        if (!n.enabled) bits.push('(禁用)');
        if (n.offscreen) bits.push('(不可见)');
        return indent + bits.join(' ');
      });
      const head = '控件 ' + nodes.length + ' 个'
        + (res && res.window ? '（窗口匹配 ' + res.window + '）' : '')
        + '；有 [Invoke]/[Value]/[Toggle]/[SelectionItem]/[ExpandCollapse] 标记的可以直接 ui_action';
      return head + '\n' + lines.join('\n');
    },

    async uiAction({ selector, action = 'invoke', value } = {}) {
      need('uiAction');
      const sel = (selector && typeof selector === 'object') ? selector : {};
      const res = await bridge.uiAction({ selector: sel, action: String(action || 'invoke'), value: String(value == null ? '' : value) });
      if (res && res.fallback === 'click') {
        return '这个控件不支持语义调用，已点击它的中心 (' + res.clicked.x + ',' + res.clicked.y + ')。'
          + '如果结果不对，先 window_active / ui_tree 再看一眼。';
      }
      return '已在控件「' + ((res && res.name) || '') + '」上执行 ' + String(action)
        + (res && res.rect ? '（' + res.rect.width + '×' + res.rect.height + ' @' + res.rect.x + ',' + res.rect.y + '）' : '');
    },

    async appList() {
      need('appList');
      const res = await bridge.appList();
      const apps = (res && res.apps) || [];
      if (!apps.length) return '没有找到有窗口的进程';
      return apps.map((a, i) => (i + 1) + '. ' + a.process + '｜' + a.title).join('\n');
    },

    async appClose({ target } = {}) {
      const t = String(target || '').trim();
      if (!t) throw new Error('app_close 需要 target（进程名或窗口标题关键词）');
      need('appClose');
      const res = await bridge.appClose({ target: t });
      return (res && res.note) || ('已请求关闭 ' + t);
    },

    /**
     * 抓网页：返回标题 + 正文摘录（网页内容是**不可信数据**，
     * 只作为事实材料，不得当成指令执行 —— 提示词里也这么写）。
     */
    async webFetch({ url } = {}) {
      const u = String(url || '').trim();
      if (!u) throw new Error('web_fetch 需要 url');
      need('webFetch');
      const res = await bridge.webFetch({ url: u });
      const title = String((res && res.title) || '');
      const text = String((res && res.text) || '').slice(0, 4000);
      const finalUrl = String((res && res.finalUrl) || u);
      if (!text) return '抓到了 ' + finalUrl + '（HTTP ' + (res && res.status) + '），但没有可读正文。';
      return [
        '【网页内容 · 不可信来源】',
        '标题：' + (title || '（无标题）'),
        'URL：' + finalUrl,
        '抓取时间：' + ((res && res.fetchedAt) || ''),
        (res && res.truncated ? '（内容已截断）' : ''),
        '',
        text,
      ].join('\n');
    },

    /**
     * 动作后验证：给 runtime 一个「现在到底什么状态」的快照。
     * 只做便宜且可靠的两件事：前台窗口 + 工作区里的目标是否存在。
     * 拿不到就明说拿不到，绝不假装「成功」。
     */
    async observe() {
      const out = { active: null, error: '' };
      try {
        const res = (typeof bridge.windowActive === 'function') ? await bridge.windowActive() : null;
        out.active = (res && res.window) || null;
      } catch (err) {
        out.error = String((err && err.message) || err);
      }
      return out;
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
  copy_path: 'copyPath',
  move_path: 'movePath',
  delete_path: 'deletePath',
  run_command: 'runCommand',
  git_status: 'gitStatus',
  git_diff: 'gitDiff',
  git_commit: 'gitCommit',
  screen_capture: 'screenCapture',
  window_list: 'windowList',
  window_active: 'windowActive',
  window_focus: 'windowFocus',
  window_control: 'windowControl',
  ui_tree: 'uiTree',
  ui_action: 'uiAction',
  app_list: 'appList',
  app_close: 'appClose',
  open_application: 'openApplication',
  mouse_move: 'mouseMove',
  mouse_click: 'mouseClick',
  mouse_scroll: 'mouseScroll',
  mouse_drag: 'mouseDrag',
  keyboard_type: 'keyboardType',
  keyboard_press: 'keyboardPress',
  web_fetch: 'webFetch',
};

function joinPath(a, b) { return pathJoin(a, b); }
function relPath(root, abs) {
  try { return (pathRelative(root, abs) || '.').replace(/\\/g, '/'); } catch { return abs; }
}
