// 角色卡：数据结构与提示词构建
import { t, getLang } from './i18n.js';
import { compilePersonaPrompt, migrateCardToV2 } from './persona-v2.js';

export const CARD_SPEC = 'aileen-card-v2';

export function emptyCard() {
  const now = Date.now();
  return {
    spec: CARD_SPEC,
    name: '',
    avatar: '',          // 相对路径 avatars/xxx.png
    description: '',     // 一句话简介
    personality: '',     // 性格人设（v1 的自由文本；v2 仍保留，并与结构化字段并列）
    scenario: '',        // 场景
    first_mes: '',       // 开场白
    mes_example: '',     // 示例对话
    system_prompt: '',   // 可选自定义系统提示词（非空时整段覆盖）
    persona: null,       // v2 结构化人格（见 persona-v2.js）
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
 *
 * 0.7.9：结构化人格（card.persona）编译成正文插在这里；
 * 旧的 personality 自由文本仍然保留在后面 —— 迁移不能丢掉用户写过的字。
 */
export function buildSystemPrompt(card) {
  if (!card) return t('prompt.noCard');
  if (card.system_prompt && card.system_prompt.trim()) return card.system_prompt.trim();
  const lines = [];
  const name = card.name || 'AILEEN';
  lines.push(t('prompt.intro', { name }));
  if (card.description) lines.push(t('prompt.desc', { v: card.description }));
  const compiled = card.persona ? compilePersonaPrompt(card.persona, { lang: getLang() }) : '';
  if (compiled) lines.push(compiled);
  if (card.personality) lines.push(t('prompt.persona', { v: card.personality }));
  if (card.scenario) lines.push(t('prompt.scenario', { v: card.scenario }));
  if (card.mes_example) lines.push(t('prompt.example', { v: card.mes_example }));
  lines.push(t('prompt.outro'));
  return lines.join('\n\n');
}

/** 读取时统一迁移到 v2（幂等：已经 v2 的卡原样返回） */
export function normalizeCard(card) {
  return migrateCardToV2(card);
}

export function cardFileName(card) {
  const safe = String(card.name || '角色').replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
  return safe || 'character';
}
