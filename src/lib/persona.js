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
import { PERSONALITIES, ROLES, GENDERS, RELATIONSHIPS, findArchetype, labelOf, specOf } from './archetypes.js';
import { streamChat } from './llm.js';

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

/**
 * 把「原型 + 锁定」写成给模型的约束块。
 *
 * 锁定的原型走硬约束口径（每一句台词都要能验证，偏离算失败），
 * 没锁的走参考口径（可以借鉴也可以另走一路）—— 两句话术完全不同，
 * 不是同一个模板换个词。
 */
function constraintBlock(opts, lang) {
  const p = findArchetype(PERSONALITIES, opts.personalityId);
  const r = findArchetype(ROLES, opts.roleId);
  const hard = [];
  const soft = [];

  // 「已有角色」模式：不是自由创作，而是回忆 + 整理。要求忠实，并且**允许它说不认识** ——
  // 不认识却说认识，出来的一定是一张套着名字的通用卡，那比失败更糟。
  if (opts.mode === 'known') {
    const charName = String(opts.charName || '').trim();
    const work = String(opts.work || '').trim();
    const strict = opts.fidelity !== 'loose';
    if (charName) hard.push(t('persona.knownChar', { v: charName }));
    if (work) hard.push(t('persona.knownWork', { v: work }));
    hard.push(t('persona.knownFidelity', { v: strict ? t('persona.knownStrict') : t('persona.knownLoose') }));
    hard.push(t('persona.knownRule'));
    hard.push(t('persona.knownUnknown'));
    const parts0 = t('persona.knownHeader') + '\n' + hard.join('\n');
    const relLines0 = relationshipLines(opts, lang);
    return relLines0.length
      ? parts0 + '\n\n' + t('persona.relHeader') + '\n' + relLines0.join('\n')
      : parts0;
  }

  if (p) {
    const line = t('persona.linePersonality', { v: labelOf(p, lang) + ' —— ' + specOf(p, lang) });
    (opts.lockPersonality === false ? soft : hard).push(line);
  }
  if (r) {
    const line = t('persona.lineRole', { v: labelOf(r, lang) + ' —— ' + specOf(r, lang) });
    (opts.lockRole === false ? soft : hard).push(line);
  }
  const parts = [];
  if (hard.length) parts.push(t('persona.lockHeader') + '\n' + hard.join('\n') + '\n' + t('persona.lockRule'));
  if (soft.length) parts.push(t('persona.softHeader') + '\n' + soft.join('\n') + '\n' + t('persona.softRule'));
  // 对话者的身份是硬约束：同一句台词，「恋人」和「刚认识的人」说出来的样子完全不同
  const relLines = relationshipLines(opts, lang);
  if (relLines.length) parts.push(t('persona.relHeader') + '\n' + relLines.join('\n') + '\n' + t('persona.relRule'));
  return parts.join('\n\n');
}

/** 对话者（用户）在这段关系里是谁 */
function relationshipLines(opts, lang) {
  const out = [];
  const rel = findArchetype(RELATIONSHIPS, opts.relationId);
  if (rel && rel.id !== 'any') out.push(t('persona.relLine', { v: labelOf(rel, lang) + ' —— ' + specOf(rel, lang) }));
  const who = String(opts.userName || '').trim();
  if (who) out.push(t('persona.relName', { v: who }));
  return out;
}

/** 名字/性别/年龄/其它要求 —— 用户明确写了的，就必须照做 */
function requirementLines(opts, lang) {
  const out = [];
  const name = String(opts.name || '').trim();
  if (name) out.push(t('persona.reqName', { v: name }));
  const g = findArchetype(GENDERS, opts.genderId);
  if (g && g.id !== 'any') out.push(t('persona.reqGender', { v: labelOf(g, lang) }));
  const age = String(opts.age || '').trim();
  if (age) out.push(t('persona.reqAge', { v: age }));
  const extra = String(opts.extra || '').trim();
  if (extra) out.push(t('persona.reqExtra', { v: extra }));
  return out;
}

/**
 * 发给模型的消息。
 * 可以只传一句灵感（字符串，老用法），也可以传完整的 { seed, personalityId, roleId, lock*, name, genderId, age, extra }。
 * seed 为空则随机挑一个灵感。
 */
export function buildPersonaMessages(input) {
  const opts = typeof input === 'string' ? { seed: input } : (input || {});
  const lang = getLang();
  const langName = LANG_NAME[lang] || 'English';

  const known = opts.mode === 'known';
  // 关键：两种模式的「底稿」必须不同。共用一份「创造一个角色」的提示词时，
  // 模型会照字面执行 —— 于是你输入「凉宫春日」，它给你编一个潜水员出来。
  const blocks = [known ? t('persona.systemKnown', { lang: langName }) : t('persona.system', { lang: langName })];
  const c = constraintBlock(opts, lang);
  if (c) blocks.push(c);

  const lines = [];
  if (known) {
    const nm = String(opts.charName || '').trim();
    const wk = String(opts.work || '').trim();
    if (nm) lines.push(t('persona.knownAsk', { v: nm }));
    if (wk) lines.push(t('persona.knownAskWork', { v: wk }));
    const kReqs = requirementLines(opts, lang);
    if (kReqs.length) lines.push(t('persona.reqHeader'), ...kReqs.map((x) => '- ' + x));
    // 已有角色模式绝不能给「随机灵感」：那等于让模型改去编一个新角色
    lines.push(t('persona.knownGo'));
    return [
      { role: 'system', content: blocks.join('\n\n') },
      { role: 'user', content: lines.join('\n') },
    ];
  }

  const seed = String(opts.seed || '').trim();
  const reqs = requirementLines(opts, lang);
  if (reqs.length) lines.push(t('persona.reqHeader'), ...reqs.map((x) => '- ' + x));
  lines.push(seed ? t('persona.hintLine', { seed }) : t('persona.hintNone') + ' ' + t('persona.hintRandom', { v: randomHint() }));
  lines.push(t('persona.userGo'));

  return [
    { role: 'system', content: blocks.join('\n\n') },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** 老接口：只要种子 */
export function buildSeedMessages(seed) {
  return buildPersonaMessages(seed);
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

// 值得「加大额度重来一次」的两种失败：
//   EMPTY_REPLY      —— 思考把预算吃光，一个字正文都没写出来
//   TRUNCATED_REPLY  —— 正文写了，但 JSON 被截断（括号没闭合），解析必然失败
const RETRYABLE = { EMPTY_REPLY: true, TRUNCATED_REPLY: true };

/**
 * 按额度阶梯跑生成。run(budget, attempt) 抛出的错误 code 属于上面两种，就翻倍再试一次；
 * 别的错误（没配 key、401、网络断了）照常往上抛，绝不重试。
 */
export async function withPersonaBudget(userMax, run) {
  const budgets = personaBudgets(userMax);
  for (let i = 0; i < budgets.length; i += 1) {
    try {
      return await run(budgets[i], i);
    } catch (err) {
      if (!err || !RETRYABLE[err.code] || i === budgets.length - 1) throw err;
    }
  }
  return null;
}

/**
 * 解析结果分三种，而不只是「成功 / 失败」：
 *   card    —— 拿到可用角色卡
 *   unknown —— 模型明确表示它不认识这个角色（我们已经要求它这么说，而不是硬编）
 *   bad     —— 输出根本没法用
 * 区分 unknown 的意义在于提示词完全不同：前者要告诉用户「换个写法」，后者才是「再试一次」。
 */
export function parsePersonaOutcome(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return { kind: 'bad' };
  if (/"unknown"\s*:\s*true/i.test(text)) return { kind: 'unknown' };
  const card = parsePersonaResponse(text);
  return card ? { kind: 'card', card } : { kind: 'bad' };
}

/**
 * 生成一张角色卡（两个入口共用：角色编辑器里的快捷键、设置里的人设生成室）。
 *
 * 这里把两种「其实只是额度不够」的失败自己扛掉，不让用户看到「再试一次吧」：
 *   思考吃光预算 → 加额度重来；JSON 被截断 → 加额度重来。封顶 8192。
 */
export async function generatePersonaCard(settings, options) {
  const messages = buildPersonaMessages(options);
  return withPersonaBudget(settings.llm.maxTokens, async (budget) => {
    let out = '';
    let truncated = false;
    await streamChat({
      messages,
      settings: { ...settings, llm: { ...settings.llm, maxTokens: budget } },
      onDelta: (d) => { out += d; },
      onFinish: (info) => { truncated = !!(info && info.finishReason === 'length'); },
    });
    const r = parsePersonaOutcome(out);
    if (r.kind === 'card') return r.card;
    if (r.kind === 'unknown') {
      // 不认识就是不认识：绝不重试、绝不硬编一张卡出来（重试只会烧钱，还可能逼出幻觉）
      const e = new Error(t('studio.unknownChar'));
      e.code = 'UNKNOWN_CHARACTER';
      throw e;
    }
    const err = new Error(t('char.genFail'));
    err.code = truncated ? 'TRUNCATED_REPLY' : 'UNPARSABLE';
    throw err;
  });
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
