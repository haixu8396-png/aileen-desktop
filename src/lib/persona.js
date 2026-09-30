// ============================================================
// 人设自动生成
//
// 让模型从「一句话灵感」长出一整张角色卡。
//
// 真正麻烦的不是提示词，是**解析**：模型几乎不会老老实实只回一个 JSON ——
// 常见的有：裹在 ```json 围栏里、前面加一段「好的，这是你的角色：」、
// 少给几个字段、把某字段写成数组或数字。所以这里不 JSON.parse 一把梭，
// 而是先剥围栏、再按大括号配平截取第一个对象（字符串里的括号要跳过），
// 然后逐字段类型校验 + 截断。
// ============================================================
import { t, getLang } from './i18n.js';

export const PERSONA_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

// 字段长度上限，防止模型灌一篇小作文进角色卡
const MAX_LEN = { name: 40, description: 120, personality: 1200, scenario: 600, first_mes: 600, mes_example: 1200 };

const LANG_NAME = { en: 'English', ja: '日本語', zh: '简体中文' };

/** 灵感留空时，从当前语言的候选里随机挑一个，保证每次生成的东西不重样 */
export function randomHint() {
  const raw = String(t('persona.hints') || '');
  const list = raw.split('|').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return 'an original character';
  return list[Math.floor(Math.random() * list.length)];
}

/** 发给模型的消息。seed 为空则随机挑一个灵感。 */
export function buildPersonaMessages(seed) {
  const lang = LANG_NAME[getLang()] || 'English';
  return [
    { role: 'system', content: t('persona.system', { lang }) },
    { role: 'user', content: t('persona.user', { seed: String(seed || '').trim() || randomHint() }) },
  ];
}

// 生成一张卡要花的额度（思考很占），以及撞到上限后允许翻到的天花板
export const PERSONA_MIN_TOKENS = 2048;
export const PERSONA_MAX_TOKENS = 8192;

/**
 * 额度阶梯：起步不低于 2048（不动用户自己设的聊天上限），最多翻一次倍，封顶 8192。
 * 只在「思考把额度吃光、一个字正文都没写出来」时才会用到第二级。
 */
export function personaBudgets(userMax) {
  const base = Math.min(Math.max(Number(userMax) || 0, PERSONA_MIN_TOKENS), PERSONA_MAX_TOKENS);
  return base >= PERSONA_MAX_TOKENS ? [base] : [base, Math.min(base * 2, PERSONA_MAX_TOKENS)];
}

/**
 * 按额度阶梯跑生成。run(budget, attempt) 抛出的错误如果 code 是 EMPTY_REPLY
 * （推理模型把预算全用在思考上），就翻倍再试一次；别的错误照常往上抛。
 */
export async function withPersonaBudget(userMax, run) {
  const budgets = personaBudgets(userMax);
  for (let i = 0; i < budgets.length; i += 1) {
    try {
      return await run(budgets[i], i);
    } catch (err) {
      if (!err || err.code !== 'EMPTY_REPLY' || i === budgets.length - 1) throw err;
    }
  }
  return null;
}

/**
 * 从模型回复里把角色卡抠出来。
 * 返回 { name?, description?, personality?, scenario?, first_mes?, mes_example? }，
 * 一个字段都救不回来时返回 null。
 */
export function parsePersonaResponse(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  // 1) 剥掉 ``` 围栏（可能有语言标注）
  const fence = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  // 2) 从第一个 { 开始，按大括号配平找完整对象；字符串里的括号、转义引号都要跳过
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;

  let obj = null;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch (err) { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  // 3) 只挑白名单字段，且必须是字符串；长的截断，空字符串丢掉
  const out = {};
  let got = 0;
  for (const key of PERSONA_FIELDS) {
    let v = obj[key];
    if (Array.isArray(v)) v = v.filter((x) => typeof x === 'string').join('\n');
    if (typeof v !== 'string') continue;
    const s = v.replace(/\r\n/g, '\n').trim();
    if (!s) continue;
    out[key] = s.slice(0, MAX_LEN[key] || 1000);
    got += 1;
  }
  return got ? out : null;
}
