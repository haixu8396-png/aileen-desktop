// ============================================================
// 全局共享状态 / 实例 / 跨模块回调
// 说明：设置对象由 lib/settings.js 单独持有（单一来源），此处不重复保存。
// ============================================================
import { TTS } from './tts.js';
import { STT } from './stt.js';

// LLM 供应商预设（选择供应商时自动填充地址与模型）
export const LLM_PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  qwen: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  xiaomi: { label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'MiMo-V2.5' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  ollama: { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  custom: { label: '自定义', baseUrl: '', model: '' },
};

export function presetLlmBase(provider) {
  const p = LLM_PROVIDERS[provider];
  return (p && p.baseUrl) || '';
}

/**
 * 嵌入模型供应商预设（长期记忆 / 知识库的语义检索用）。
 *
 * 为什么单独一份、不共用 LLM 的预设：算向量用便宜的小模型就够，
 * 而且各家「哪个模型能算向量」和「哪个模型能对话」经常不是同一个。
 * 默认给的都是各自平台上的主流嵌入模型，用户可以自己改。
 */
export const EMBEDDING_PROVIDERS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
  siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
  qwen: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3' },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'embedding-3' },
  ollama: { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text' },
  custom: { label: '自定义', baseUrl: '', model: '' },
};

export function presetEmbeddingBase(provider) {
  const p = EMBEDDING_PROVIDERS[provider];
  return (p && p.baseUrl) || '';
}

export function presetEmbeddingModel(provider) {
  const p = EMBEDDING_PROVIDERS[provider];
  return (p && p.model) || '';
}

/** 可变运行时状态 */
export const state = {
  appInfo: null,
  models: [],        // [{name, file, url, source}]
  characters: [],    // [{file, data}]
  current: null,     // {file, data}
  messages: [],      // [{role, content}]
  oml2d: null,
  busy: false,
  abortCtrl: null,
  lastAssistantText: '',
  editorCard: null,
  editorFile: null,
  pendingImage: null,
  currentMenuFile: null,
  quickFile: null,
  voiceLoop: false,
};

export const tts = new TTS();
export const stt = new STT();

/**
 * 跨模块回调：由 main.js 在启动时注入，避免模块间循环依赖。
 */
export const hooks = {
  openCharModal: () => {},
  renderMessages: () => {},
  renderEmptyState: () => {},
  refreshCharacters: async () => {},
  selectCharacter: async () => {},
  populateModelSelect: () => {},
  populateStageModelSelect: () => {},
  setBusy: () => {},
  autoGrowInput: () => {},
  ttsSettingsForCharacter: () => null,
  renderCharList: () => {},
  updateStageModelName: () => {},
  setStageModelIndex: () => {},
  rebuildLive2D: () => {},
  openLlmModal: () => {},
  setAttachUI: () => {},
  /** Agent 事件出口：由 main.js 指到 Agent Control Dashboard */
  agentEvent: () => {},
};
