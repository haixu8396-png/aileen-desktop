// ============================================================
// Planner：决定「现在该回答还是该用工具」
//
// 这里全是纯函数 —— 不碰网络、不碰磁盘：
//   toolsToProviderSpecs() 把工具表转成 provider 的 tools 参数
//   parseToolCalls()       解析模型回流的 tool_calls
//   assistantMessage()     把「模型这轮说的话」拼成一条可回填的 assistant 消息
//   toolResultMessage()    把工具结果拼成回给模型的 tool 消息
//
// 拼对话历史（尤其是带 reasoning_content 的推理模型）很容易踩格式的坑，
// 所以这部分单独放出来，好单测。
// ============================================================

/** OpenAI 兼容的 tools 参数格式 */
export function toolsToProviderSpecs(tools) {
  return (tools || []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

/** 模型给的是「工具名 + 参数」，这里转成内部结构 */
export function normalizeToolCall(call) {
  if (!call || typeof call !== 'object') return null;
  const fn = call.function || {};
  const name = String(fn.name || call.name || '').trim();
  if (!name) return null;
  let args = fn.arguments !== undefined ? fn.arguments : call.arguments;
  if (typeof args === 'string') {
    const s = args.trim();
    if (s === '') args = {};
    else {
      try {
        args = JSON.parse(s);
      } catch {
        // 模型偶尔给出截断的 JSON —— 不丢，包一层交给 validateArgs 报错回给模型
        return { id: String(call.id || ''), name, args: {}, rawArguments: s, parseError: '参数不是合法 JSON' };
      }
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { id: String(call.id || ''), name, args };
}

/**
 * 从一轮模型回复里取工具调用。
 * 返回 { calls, unknown } —— unknown 是「模型编了个不存在的工具名」，
 * 这个要作为工具结果回给它，而不是静默丢弃（丢了下游就死循环了）。
 */
export function parseToolCalls(message, registry) {
  const list = (message && Array.isArray(message.tool_calls)) ? message.tool_calls : [];
  const calls = [];
  const unknown = [];
  for (const raw of list) {
    const call = normalizeToolCall(raw);
    if (!call) continue;
    if (registry && typeof registry.has === 'function' && !registry.has(call.name)) {
      unknown.push(call);
      continue;
    }
    calls.push(call);
  }
  return { calls, unknown };
}

/** 助手消息（回填历史时必须带上这轮的 tool_calls，否则模型会以为自己没调过） */
export function assistantMessage(text, toolCalls) {
  const msg = { role: 'assistant', content: String(text || '') };
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  const calls = list.map((c) => ({
    id: c.id,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
  }));
  if (calls.length) msg.tool_calls = calls;
  return msg;
}

/** 工具结果消息 */
export function toolResultMessage(callId, content) {
  return {
    role: 'tool',
    tool_call_id: String(callId || ''),
    content: String(content == null ? '' : content),
  };
}

/** 未知工具的回执（教模型别编工具名，并给出可选项） */
export function unknownToolMessage(name, registry) {
  const available = registry && typeof registry.names === 'function' ? registry.names().join(', ') : '';
  return '错误：不存在名为 "' + name + '" 的工具。可用的工具只有：' + available;
}

/** 是否该收尾：没有工具调用、或者到了轮数上限 */
export function shouldFinish(text, calls, rounds, maxRounds) {
  if (!calls || calls.length === 0) return true;
  return Number(rounds) >= Number(maxRounds);
}

/**
 * Agent 的**能力说明**（能力清单 + 硬规矩）。
 *
 * 注意它是什么、不是什么：
 *   · 它**不是**人格。人格永远来自角色卡（characters.js 的 buildSystemPrompt），
 *     由调用方拼在它前面一起作为 system prompt 注入 runtime。
 *   · 单独调用它（不传 task）时只产出「你有哪些工具、边界在哪」这一段，
 *     适合被拼到角色提示词后面。传了 task 才会多一段任务描述。
 *
 * 铁律那几条是刻意写死的 —— 模型自己不会知道 workspace 边界。
 */
export function buildAgentSystemPrompt({ task, workspace, tools } = {}) {
  const lines = [
    '你可以使用工具**真正动手**去完成任务，而不是只给建议：工具的结果会回到你这里，你可以据此继续下一步。',
    '',
  ];
  if (task) {
    lines.push('本次任务：' + String(task));
    lines.push('');
  }
  if (workspace) {
    lines.push('工作区（workspace）：' + String(workspace));
    lines.push('');
  }
  lines.push(
    '先判断需不需要动手：只是聊天、解释、给建议、回答问题，就**不要调用任何工具**，直接像平常那样回答。',
    '只有确实要读写文件、跑命令、看屏幕、动鼠标键盘时才调用工具。',
    '',
    '使用工具的硬规矩：',
    '1. 所有路径都必须是相对 workspace 的路径（除非用户把权限放开到可以写任意位置）。越界的路径会被直接拒绝，不要尝试。',
    '2. 不要读取或修改 API Key、凭据、系统目录、浏览器数据 —— 这些一律被禁止。',
    '3. 改文件之前先读它。不要凭猜测重写整个文件。',
    '4. 一次只做一件事；做完一件事再决定下一步。',
    '5. 需要跑命令、控制鼠标键盘时可能弹给用户确认，被拒绝就换个办法，不要反复重试同一个操作。',
    '6. 干完后用一两句话汇报你做了什么、结果如何 —— **用你自己的说话方式**，不要贴大段代码。',
    '',
    '关于「真的做过没有」（很重要，用户明确要求过）：',
    '· 只有工具返回成功才算做成。没有调用工具就不要说「已经打开了」「已经写好了」。',
    '· 工具报错就把**报错原文的关键部分**说出来，并说清楚你下一步换什么办法。',
    '· 不要编造报错原因，也不要把「没试过」说成「试过但坏了」。',
    '· 写文件一律用 write_file；**不要**用键盘模拟往记事本里敲代码（花括号、引号这类字符极易出错）。',
    '',
    '可用工具：',
  );
  for (const tool of tools || []) {
    lines.push('- ' + tool.name + '（' + tool.riskLevel + '）：' + tool.description);
  }
  return lines.join('\n');
}
