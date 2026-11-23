// ============================================================
// Agent 宿主桥接（渲染层）
//
// executor 不直接碰 Node —— 它只认一个「能力对象」。这里把
// window.api.agent* 那组 IPC 包成那个对象，于是：
//   · 单测可以塞一个真实文件系统的桥接，整个循环照跑；
//   · 真机跑的是同一份 executor 逻辑，只是能力换成了主进程提供的。
//
// 约定（很重要）：
//   · readdir 必须回 { name, isDirectory } —— Dirent 的 isDirectory()
//     是方法，跨 IPC 会丢，只剩 name/parentPath 会让对端把文件当目录。
//   · spawn 要回一个 { done, cancel } 句柄，超时/取消由 executor 控制。
// ============================================================
import { streamChat } from './llm.js';
import pathUtil from '../../shared/path-util.cjs';

/**
 * 动作类能力的授权闸门（渲染层这一侧）。
 *
 * 主进程对 fs.write / exec / git commit / 窗口切换 / 启动应用 / 输入注入
 * 要求一张一次性凭证；凭证只能由这里在「用户已经批准」之后去换。
 * 主进程会按设置重新判一遍，HIGH / CRITICAL 还会自己弹原生确认框 ——
 * 也就是说渲染层说了不算，主进程说了才算。
 *
 * 拿不到凭证就抛错（错误会作为工具结果回给模型，它不会当成「做成了」）。
 */
async function requireGrant(capability, args) {
  const api = (typeof window !== 'undefined' && window.api) ? window.api : null;
  if (!api || typeof api.agentGrant !== 'function') return; // 旧 preload / 单测环境：不拦
  let res = null;
  try {
    res = await api.agentGrant({ capability, args: args || {} });
  } catch (err) {
    const e = new Error('授权请求失败：' + String((err && err.message) || err));
    e.code = 'AUTH_ERROR';
    throw e;
  }
  if (!res || res.allowed !== true) {
    const reason = String((res && res.reason) || 'denied');
    const e = new Error(reason === 'user-rejected'
      ? '用户拒绝了这次操作（主进程确认框里选了拒绝）。不要重试，换一个做法或说明做不到。'
      : '这次操作没有得到授权（' + reason + '）。请让用户在 Agent 权限里批准或切到信任模式。');
    e.code = reason === 'user-rejected' ? 'USER_REJECTED' : 'AUTH_DENIED';
    throw e;
  }
}

/** executor 的桥接：能力全部来自主进程 */
export function createAgentBridge() {
  const api = window.api || {};

  /**
   * 工作区缓存 + 「这个绝对路径在不在工作区外」。
   *
   * 主进程对外部路径要求一张 `fs.external` 凭证（HIGH），读也要 ——
   * 所以渲染层在发请求之前得先判断范围，否则外部读取会被主进程拒掉，
   * 模型只会看到一句「需要批准」却不知道批准的是哪一步。
   */
  let workspaceCache = null;
  const workspaceOf = async () => {
    if (workspaceCache !== null) return workspaceCache;
    try {
      const res = await api.agentWorkspace();
      workspaceCache = String((res && res.workspace) || '');
    } catch {
      workspaceCache = '';
    }
    return workspaceCache;
  };
  const isExternalAbs = async (absPath) => {
    const ws = await workspaceOf();
    if (!ws) return false;
    return !pathUtil.isInside(absPath, ws);
  };
  /** 外部路径先要「外部访问」凭证（能力名与主进程 gate 的那张一致） */
  const requireExternalGrant = async (payload, absPath) => {
    if (!(await isExternalAbs(absPath))) return;
    await requireGrant('fs.external', payload);
  };

  return {
    async readdir(absPath) {
      await requireExternalGrant({ op: 'list', path: String(absPath || '') }, absPath);
      const res = await api.agentFs({ op: 'list', path: absPath });
      return (res && res.entries) || [];
    },
    async readFile(absPath) {
      await requireExternalGrant({ op: 'read', path: String(absPath || '') }, absPath);
      const res = await api.agentFs({ op: 'read', path: absPath });
      return (res && res.text) || '';
    },
    async writeFile(absPath, text) {
      await requireExternalGrant({ op: 'write', path: String(absPath || '') }, absPath);
      await requireGrant('fs.write', { op: 'write', path: absPath });
      return api.agentFs({ op: 'write', path: absPath, text: String(text == null ? '' : text) });
    },
    async stat(absPath) {
      await requireExternalGrant({ op: 'stat', path: String(absPath || '') }, absPath);
      return api.agentFs({ op: 'stat', path: absPath });
    },
    /**
     * 跑命令。返回 { done, cancel }：
     * executor 只 await done、cancel 时调 cancel。
     * 这里主进程是一次性 IPC（没有中途取消的通道），所以 cancel 只标记状态，
     * 让 executor 的 runningCount 能正确归零；真正的超时终止在主进程做。
     */
    async spawn({ command, args, cwd, timeoutMs }) {
      await requireGrant('exec.run', { command, args });
      let cancelled = false;
      const done = api.agentExec({ command, args, cwd, timeoutMs })
        .then((r) => (r && typeof r === 'object' ? r : { exitCode: -1, stdout: '', stderr: '' }))
        .catch((err) => ({
          exitCode: -1,
          stdout: '',
          stderr: String((err && err.message) || err),
        }))
        .then((r) => Object.assign({ timedOut: false, truncated: false }, r, cancelled ? { exitCode: -1 } : {}));
      return { done, cancel: () => { cancelled = true; } };
    },
    async git({ args, cwd, timeoutMs }) {
      const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
      if (list[0] === 'commit') await requireGrant('git.commit', { args: list });
      const res = await api.agentGit({ args, cwd, timeoutMs });
      return (res && res.text) || '';
    },
    async screenCapture({ withData }) {
      return api.agentScreenshot({ withData: !!withData });
    },

    // ---- 文件操作 ----
    // 外部路径要两张凭证：fs.external（这次碰工作区外的这个路径）+ 动作本身的能力
    async copyPath({ path: from, to, overwrite }) {
      const payload = { op: 'copy', path: from, to };
      await requireExternalGrant(payload, from);
      await requireExternalGrant(payload, to);
      await requireGrant('fs.copy', payload);
      return api.agentFs({ op: 'copy', path: from, to, overwrite: !!overwrite });
    },
    async movePath({ path: from, to, overwrite }) {
      const payload = { op: 'move', path: from, to };
      await requireExternalGrant(payload, from);
      await requireExternalGrant(payload, to);
      await requireGrant('fs.move', payload);
      return api.agentFs({ op: 'move', path: from, to, overwrite: !!overwrite });
    },
    async deletePath({ path }) {
      await requireExternalGrant({ op: 'remove', path }, path);
      await requireGrant('fs.delete', { op: 'remove', path });
      return api.agentFs({ op: 'remove', path });
    },

    // ---- 电脑控制 ----
    async windowList() {
      const res = await api.agentWindow({ op: 'list' });
      // 新契约带 windows（id/进程/矩形），老契约只有 titles —— 两个都往上抛
      if (res && Array.isArray(res.windows) && res.windows.length) return res.windows;
      return (res && res.titles) || [];
    },
    async windowFocus({ title }) {
      await requireGrant('window.control', { op: 'focus', title: String(title || '') });
      return api.agentWindow({ op: 'focus', title });
    },
    async openApplication({ target, isUrl }) {
      await requireGrant('app.launch', { target: String(target || '') });
      return api.agentOpen({ target, isUrl });
    },
    async mouseMove({ x, y }) {
      await requireGrant('input.pointer', { op: 'mouseMove', x, y });
      return api.agentInput({ op: 'mouseMove', x, y });
    },
    async mouseClick({ button, double, x = null, y = null }) {
      await requireGrant('input.pointer', { op: 'mouseClick', x, y, button, double: !!double });
      const payload = { op: 'mouseClick', button, double: !!double };
      // 只有真的带了坐标才传 x/y（否则和老主进程的行为一致：在当前位置点）
      if (Number.isFinite(x) && Number.isFinite(y)) { payload.x = x; payload.y = y; }
      return api.agentInput(payload);
    },
    async mouseScroll({ direction, amount, x = null, y = null }) {
      await requireGrant('input.pointer', { op: 'scroll', x, y, direction, amount });
      return api.agentInput({ op: 'scroll', direction, amount, x, y });
    },
    async mouseDrag({ x, y, toX, toY, button }) {
      await requireGrant('input.pointer', { op: 'drag', x, y, toX, toY, button });
      return api.agentInput({ op: 'drag', x, y, toX, toY, button });
    },

    // ---- 窗口 / UIA / 应用 ----
    async windowActive() {
      return api.agentWindow({ op: 'active' });
    },
    async windowControl({ op, title }) {
      await requireGrant('window.control', { op, title });
      return api.agentWindow({ op, title });
    },
    async uiTree({ window, depth, maxNodes }) {
      return api.agentUia({ op: 'tree', window, depth, maxNodes });
    },
    async uiAction({ selector, action, value }) {
      await requireGrant('desktop.uia.act', { op: 'act', action, selector, value });
      return api.agentUia({ op: 'act', selector, action, value });
    },
    async appList() {
      return api.agentApp({ op: 'list' });
    },
    async appClose({ target }) {
      await requireGrant('app.control', { op: 'close', target });
      return api.agentApp({ op: 'close', target });
    },
    /** 抓网页：只读公网，LOW，不需要凭证（主进程有 SSRF 防护） */
    async webFetch({ url }) {
      if (typeof api.webFetch !== 'function') throw new Error('宿主未提供联网能力');
      return api.webFetch({ url });
    },
    async keyboardType({ text }) {
      const s = String(text == null ? '' : text);
      await requireGrant('input.keyboard', { op: 'keyboardType', text: s });
      return api.agentInput({ op: 'keyboardType', text: s });
    },
    async keyboardPress({ keys }) {
      const list = Array.isArray(keys) ? keys.map((k) => String(k)) : [];
      await requireGrant('input.keyboard', { op: 'keyboardPress', keys: list });
      return api.agentInput({ op: 'keyboardPress', keys: list });
    },
    /** 鼠标当前位置与屏幕尺寸（给模型定位用） */
    async cursor() {
      try { return await api.agentCursor(); } catch { return null; }
    },
  };
}

/**
 * 主进程侧的敏感路径判定：渲染层也留一份同名规则。
 * 主进程那道闸门才是权威（渲染层绕不过它），这里只是让单测与
 * executor 的 isSensitive 钩子在没有主进程时也能工作。
 */
export function isSensitivePath(p) {
  const s = String(p || '');
  if (!s) return false;
  const patterns = [
    /(^|[\\/])\.ssh([\\/]|$)/i,
    /(^|[\\/])\.aws([\\/]|$)/i,
    /(^|[\\/])\.gnupg([\\/]|$)/i,
    /(^|[\\/])\.git-credentials$/i,
    /(^|[\\/])\.npmrc$/i,
    /(^|[\\/])\.netrc$/i,
    /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
    /(^|[\\/])(Login Data|Cookies|Web Data)$/i,
    /(^|[\\/])(Google[\\/]Chrome|Microsoft[\\/]Edge|Mozilla[\\/]Firefox)/i,
    /(^|[\\/])settings\.json$/i,
    /(^|[\\/])\.credentials\.yaml$/i,
  ];
  return patterns.some((re) => re.test(s));
}

/**
 * Agent 的 LLM 调用：复用主进程那条链路（Key 不出主进程），只是带上 tools。
 *
 * 为什么要在这里累积正文：streamChat 只把增量交给 onDelta，不让它同时返回
 * 拼好的字符串（那样会变成两份真相）。Agent 需要完整的这一轮正文来回填历史，
 * 所以在代理这一层顺手拼起来。
 */
export function createAgentLlm(getSettings) {
  return async ({ messages, tools, signal, onDelta, onReasoning }) => {
    const settings = getSettings();
    let text = '';
    const res = await streamChat({
      messages,
      settings,
      tools,
      signal,
      onDelta: (chunk) => {
        text += chunk;
        if (onDelta) onDelta(chunk);
      },
      onReasoning,
    });
    return { text, toolCalls: (res && res.toolCalls) || [] };
  };
}
