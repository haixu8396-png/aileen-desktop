// 角色卡：数据结构与提示词构建
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

export function buildSystemPrompt(card) {
  if (card.system_prompt && card.system_prompt.trim()) return card.system_prompt.trim();
  const lines = [];
  const name = card.name || 'AI 角色';
  lines.push('你是「' + name + '」，正在与用户进行一对一的中文对话。请始终以该角色的身份、语气和性格回应，不要提及自己是一个 AI 模型或语言模型。');
  if (card.description) lines.push('角色简介：' + card.description);
  if (card.personality) lines.push('性格与说话方式：' + card.personality);
  if (card.scenario) lines.push('当前场景：' + card.scenario);
  if (card.mes_example) lines.push('参考示例（模仿其中的语气与风格）：\n' + card.mes_example);
  lines.push('回复应当自然、口语化、贴合角色设定，长度适中，不要使用 Markdown 以外的复杂格式。');
  return lines.join('\n\n');
}

export function cardFileName(card) {
  const safe = String(card.name || '角色').replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
  return safe || 'character';
}
