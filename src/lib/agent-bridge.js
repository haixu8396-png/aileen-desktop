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

/** executor 的桥接：能力全部来自主进程 */
export function createAgentBridge() {
  const api = window.api || {};
  return {
    async readdir(absPath) {
      const res = await api.agentFs({ op: 'list', path: absPath });
      return (res && res.entries) || [];
    },
    async readFile(absPath) {
      const res = await api.agentFs({ op: 'read', path: absPath });
      return (res && res.text) || '';
    },
    async writeFile(absPath, text) {
      return api.agentFs({ op: 'write', path: absPath, text: String(text == null ? '' : text) });
    },
    async stat(absPath) {
      return api.agentFs({ op: 'stat', path: absPath });
    },
    /**
     * 跑命令。返回 { done, cancel }：
     * executor 只 await done、cancel 时调 cancel。
     * 这里主进程是一次性 IPC（没有中途取消的通道），所以 cancel 只标记状态，
     * 让 executor 的 runningCount 能正确归零；真正的超时终止在主进程做。
     */
    async spawn({ command, args, cwd, timeoutMs }) {
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
      const res = await api.agentGit({ args, cwd, timeoutMs });
      return (res && res.text) || '';
    },
    async screenCapture({ withData }) {
      return api.agentScreenshot({ withData: !!withData });
    },

    // ---- 电脑控制 ----
    async windowList() {
      const res = await api.agentWindow({ op: 'list' });
      return (res && res.titles) || [];
    },
    async windowFocus({ title }) {
      return api.agentWindow({ op: 'focus', title });
    },
    async openApplication({ target, isUrl }) {
      return api.agentOpen({ target, isUrl });
    },
    async mouseMove({ x, y }) {
      return api.agentInput({ op: 'mouseMove', x, y });
    },
    async mouseClick({ button, double }) {
      return api.agentInput({ op: 'mouseClick', button, double });
    },
    async keyboardType({ text }) {
      return api.agentInput({ op: 'keyboardType', text });
    },
    async keyboardPress({ keys }) {
      return api.agentInput({ op: 'keyboardPress', keys });
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
