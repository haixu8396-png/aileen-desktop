// ============================================================
// Context：对话历史的预算管理
//
// 复用 history.js 那套压缩思路（最近若干轮保留原文，更早的压成摘要），
// 但 Agent 的上下文有自己的特点：**工具结果可能巨大**
// （一次 read_file 几百行、一次 git diff 几千行），不裁剪的话
// 第二轮就把预算吃光了。
//
// 这里只做「确定性的裁剪」，不调用模型做摘要 —— 摘要交给上层，
// 这样这一层是纯函数、可单测。
// ============================================================

/** 单条工具结果的上限（字符）。超出就掐头去尾，保留中间信息 */
export const TOOL_RESULT_LIMIT = 4000;

/** 整个工具结果历史的上限（字符） */
export const TOOL_TOTAL_LIMIT = 24000;

/** 保留最近多少条消息原文 */
export const KEEP_RECENT = 12;

/**
 * 裁剪单条工具结果：保留头部（通常是关键结论）+ 尾部（通常是错误/结尾），
 * 中间用一行说明省略了多少 —— 让模型知道自己看到的不全。
 */
export function clipToolResult(text, limit = TOOL_RESULT_LIMIT) {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return s;
  const headLen = Math.floor(limit * 0.7);
  const tailLen = limit - headLen;
  const omitted = s.length - headLen - tailLen;
  return (
    s.slice(0, headLen) +
    '\n…（此处省略 ' + omitted + ' 个字符，需要的话用更精确的参数重新读取）…\n' +
    s.slice(s.length - tailLen)
  );
}

/**
 * 按预算裁剪整个消息数组。
 * 规则：
 *   · 最近 KEEP_RECENT 条永远保留
 *   · 更早的 tool 消息按 TOOL_TOTAL_LIMIT 总量倒着保留，超出就替换成一行占位
 *   · system / user / assistant 消息不动（它们短，且是语义骨架）
 * 返回新数组，不改原数组。
 */
export function fitMessages(messages, opts = {}) {
  const keepRecent = Math.max(1, Number(opts.keepRecent) || KEEP_RECENT);
  const totalLimit = Math.max(1000, Number(opts.toolTotalLimit) || TOOL_TOTAL_LIMIT);
  // 历史里理论上不该有空洞，但「一条都不能少」比「崩在 filter 上」划算
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
  const cutoff = Math.max(0, list.length - keepRecent);

  let used = 0;
  const out = list.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const msg = out[i];
    if (!msg || msg.role !== 'tool') continue;
    const text = String(msg.content || '');
    if (i < cutoff) {
      // 老工具结果：只按预算决定留不留
      if (used + text.length > totalLimit) {
        out[i] = Object.assign({}, msg, {
          content: '（更早的工具结果已省略：' + text.length + ' 字符）',
        });
        continue;
      }
      used += text.length;
    } else {
      used += Math.min(text.length, TOOL_RESULT_LIMIT);
    }
  }
  return out;
}

export function estimateChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    n += String((m && m.content) || '').length;
    if (m && m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

/** 粗略 token 估算：中文约 1 字 1 token，英文约 4 字符 1 token，取保守值 */
export function estimateTokens(messages) {
  const chars = estimateChars(messages);
  return Math.ceil(chars / 2);
}

/**
 * workspace 摘要：让模型开工前知道自己面对的是个什么工程，
 * 而不用先浪费一轮去 list_files。
 */
export function workspaceDigest(info) {
  const i = info && typeof info === 'object' ? info : {};
  const lines = ['工作区概况：'];
  lines.push('- 路径：' + String(i.path || ''));
  if (i.appName) lines.push('- 项目：' + String(i.appName));
  if (i.packageScripts && Object.keys(i.packageScripts).length) {
    const names = Object.keys(i.packageScripts);
    lines.push('- 可用脚本（' + names.length + ' 个）：' + names.slice(0, 12).join(', '));
  }
  if (Array.isArray(i.topLevel) && i.topLevel.length) {
    lines.push('- 顶层条目：' + i.topLevel.slice(0, 20).join(', '));
  }
  if (i.gitBranch) lines.push('- git 分支：' + String(i.gitBranch));
  if (i.dirty) lines.push('- 注意：工作区有未提交改动');
  return lines.join('\n');
}

/**
 * 组装一次 LLM 请求的消息数组。
 * 结构：system →（更早的压缩摘要）→（对话历史）→ 最近的消息
 *
 * history 是「进入 Agent 之前的对话」——**它是旁证，不是人格**：
 * system 只有一条，而且开头就是角色人格。
 */
export function buildRequestMessages({ systemPrompt, summary, history, messages, budgetTokens }) {
  const head = [{ role: 'system', content: String(systemPrompt || '') }];
  if (summary) head.push({ role: 'system', content: '以下是更早对话的摘要：\n' + String(summary) });
  const prior = (Array.isArray(history) ? history : []).filter((m) => m && m.role && m.content != null);
  const base = head.concat(prior);
  let tail = fitMessages(messages);
  if (Number.isFinite(budgetTokens) && budgetTokens > 0) {
    // 预算不够就继续从最老的开始丢（system 永不丢）
    while (tail.length > 2 && estimateTokens(base.concat(tail)) > budgetTokens) {
      tail = tail.slice(1);
    }
  }
  return base.concat(tail);
}
