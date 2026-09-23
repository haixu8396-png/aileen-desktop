// 角色卡：数据结构与提示词构建
import { t } from './i18n.js';

export const CARD_SPEC = 'aileen-card-v1';

export function emptyCard() {
  const now = Date.now();
  return {
    spec: CARD_SPEC,
    name: '',
    avatar: '',          // 相对路径 avatars/xxx.png
    description: '',     // 一句话简介
    personality: '',     // 性格人设
    scenario: '',        // 场景
    first_mes: '',       // 开场白
    mes_example: '',     // 示例对话
    system_prompt: '',   // 可选自定义系统提示词
    model: '',           // 相对路径 models/xxx.model3.json
    voice: '',           // 系统 TTS 语音名
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 角色人设系统提示词。
 * 关键：文案跟随界面语言（英文 / 日文 / 中文），否则切了语言角色仍被要求说中文。
 * 卡片自带 system_prompt 时优先整段使用。
 */
export function buildSystemPrompt(card) {
  if (!card) return t('prompt.noCard');
  if (card.system_prompt && card.system_prompt.trim()) return card.system_prompt.trim();
  const lines = [];
  const name = card.name || 'AILEEN';
  lines.push(t('prompt.intro', { name }));
  if (card.description) lines.push(t('prompt.desc', { v: card.description }));
  if (card.personality) lines.push(t('prompt.persona', { v: card.personality }));
  if (card.scenario) lines.push(t('prompt.scenario', { v: card.scenario }));
  if (card.mes_example) lines.push(t('prompt.example', { v: card.mes_example }));
  lines.push(t('prompt.outro'));
  return lines.join('\n\n');
}

export function cardFileName(card) {
  const safe = String(card.name || '角色').replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
  return safe || 'character';
}
