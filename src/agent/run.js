// ============================================================
// run.js：一次 Agent Run 的装配
//
// runtime.js 负责「怎么跑」，这里负责「跑之前把东西装好」：
//   工具表 + executor + 权限设置 + 事件总线 → runAgent
//
// 装配逻辑只有这一份，界面与主进程走同一条路。
// ============================================================
import { AGENT_EVENT, createEventBus } from './events.js';
import { runAgent, buildAgentTools } from './runtime.js';
import { createExecutor } from './executor.js';
import { createToolRegistry, TOOL_SPECS } from './tool-registry.js';

const EVENT_TYPES = Object.values(AGENT_EVENT);

/**
 * 建立并启动一次 Agent Run。
 *
 * @param {object} opts
 *   task, workspace, llm, bridge, permissionConfig, requestApproval,
 *   isSensitive, bus, maxRounds, budgetTokens, summary, signal, specs
 *   onEvent  (type, payload) => void   便捷订阅（内部转成 bus.on）
 * @returns {{ controller, done, bus }}
 *   controller 立刻可用（pause / resume / cancel / resolveApproval / run）
 *   done       Promise，跑完后 resolve 成同一个 controller
 */
export function startRun(opts = {}) {
  const bus = opts.bus || createEventBus();
  if (typeof opts.onEvent === 'function') {
    for (const type of EVENT_TYPES) {
      bus.on(type, (payload) => {
        try {
          opts.onEvent(type, payload);
        } catch { /* 界面自己的错不该影响 Agent */ }
      });
    }
  }

  const registry = opts.registry || createToolRegistry();
  if (registry.size() === 0) {
    for (const spec of opts.specs || TOOL_SPECS) registry.register(spec);
  }

  const executor = opts.executor || createExecutor({
    workspace: opts.workspace,
    bridge: opts.bridge || {},
    isSensitive: opts.isSensitive,
  });

  const tools = opts.tools || buildAgentTools({ specs: registry.list(), executor });

  const { api, done } = runAgent(Object.assign({}, opts, { bus, registry, tools, executor }));
  return { controller: api, done, bus };
}

export { TOOL_SPECS, createToolRegistry, createExecutor, buildAgentTools };
