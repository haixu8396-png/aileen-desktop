// ============================================================
// Extractor：从对话里判断「值不值得长期记住」，产出候选记忆
//
// 这是整个 Long-term Memory 的第一道闸门，也是最重要的一道：
// **不能把每句聊天都存成长期记忆**，否则记忆库会被「哈哈」「在吗」
// 淹没，检索时真正有用的东西反而排不上来。
//
// 设计取舍：
//   · **规则驱动**（不是模型驱动）—— 离线可用、可单测、可解释。
//     每一条打分都对应一个 reason 字符串，测试和排查都能指着它说话。
//   · 中英日三语并列支持：原型句式、长期意图词表都是三份。
//   · 打分 0~1，**阈值 0.55**（见 DECISION_THRESHOLD）——
//     低于它的不进入候选，理由也会被记下来（便于回答「为什么不记」）。
//
// 打分构成（全部累加后 clamp 到 0~1）：
//   0.35 基底（只要有原型句式命中就算「关于人的陈述」）
//   + 触发强度（0.10~0.16，看是哪类句式）
//   + 具名实体 / 数值 / 长期意图 / 重复出现 / 明确要求记住
//   − 寒暄、一次性提问、纯情绪宣泄、过短
// ============================================================
import {
  MEMORY_TYPES, contentFingerprint, normalizeContent, clamp01,
} from './types.js';

/** 决定「存 / 不存」的阈值。取 0.55 的理由：
 *  单靠寒暄(0)或一次性提问(≤0.30)永远够不到；
 *  单靠一次弱触发(0.45 左右)也够不到，必须再有实体/意图/重复之类的证据。
 *  这与「宁可漏记，也不要让噪声进长期记忆」的取向一致。 */
export const DECISION_THRESHOLD = 0.55;

/** 基底分：命中原型句式 = 这句话在说「关于某人/某事」的稳定信息 */
export const BASE_SCORE = 0.35;

/** 触发句式 → 类型 + 分值。按「这句话有多像长期事实」排，而不是按语法分类。 */
export const TRIGGERS = [
  // —— 偏好（用户对什么有稳定倾向）：0.30
  { id: 'preference-like', type: 'preference', weight: 0.30,
    re: /我(?:很|超|最|特别|非常|挺|真的)?(?:喜欢|爱|讨厌|不喜欢|反感|偏爱|钟爱|迷上|推)/ },
  { id: 'preference-like-en', type: 'preference', weight: 0.30,
    re: /\b(?:i|we)\s+(?:really\s+|super\s+|absolutely\s+)?(?:like|love|hate|prefer|enjoy|adore|can'?t\s+stand|am\s+into)\b/i },
  { id: 'preference-like-ja', type: 'preference', weight: 0.30,
    re: /(?:私|僕|俺)(?:は|が)?[^。]{0,8}(?:が|は)?[^。]{0,8}(?:好き|嫌い|大好き|苦手|好み)/ },

  // —— 事实（身份、住宿、年龄、生日、职业…）：0.28
  // 只收需求里点名的原型句式（我叫/我住在/我的生日/我来自…）。
  // 刻意不收泛泛的「我是 X」——「我是学生」这种一次性自我介绍既不具体也留不住，
  // 收了只会让记忆库变脏。
  { id: 'fact-identity', type: 'user_fact', weight: 0.28,
    re: /我(?:已经)?(?:叫|是叫|住(?:在|的)|来自)|我(?:已经)?(?:搬到|移居|定居)[^。]{0,8}(?:住|定居)|我的(?:生日|年龄|职业|工作|名字|家乡|家庭|学校|专业)/ },
  { id: 'fact-identity-en', type: 'user_fact', weight: 0.28,
    re: /\b(?:my\s+name\s+is|i\s+live\s+in|i'?m\s+from|my\s+birthday\s+is|i\s+work\s+as|my\s+job\s+is|i\s+am\s+a\s+\w+)\b/i },
  { id: 'fact-identity-ja', type: 'user_fact', weight: 0.28,
    re: /(?:私|僕|俺)(?:の名前は|の誕生日は|は[^。]{0,10}(?:歳|才)|は[^。]{0,10}住んで|は[^。]{0,10}出身|は[^。]{0,10}呼んで)/ },
  // 日语常常省略主语：「東京に住んでいます」没有「私は」也是标准说法。
  // 只在句首看「地点/组织 + に + 住む」这类搭配，避免把「〜に行きます」误判成居住。
  { id: 'fact-residence-ja', type: 'user_fact', weight: 0.28,
    re: /^[^。、]{1,10}(?:に|へ)(?:住んで|住む|在住|引っ越し)/ },

  // —— 经历（做过/去过/经历过的事）：0.22
  { id: 'experience', type: 'experience', weight: 0.22,
    re: /我(?:曾经|以前|去年|上次|上个月|小时候|大学时|第一次)?[^。]{0,6}(?:去过|做过|见过|参加过|玩过|吃过|买过|试过|经历|拿到了|学会了|考上了)/ },
  { id: 'experience-en', type: 'experience', weight: 0.22,
    re: /\b(?:i|we)\s+(?:have\s+|had\s+)?(?:been\s+to|visited|tried|played|bought|learned|studied|worked\s+on|went\s+to)\b/i },

  // —— 关系（人/宠物/组织）：0.26
  { id: 'relationship', type: 'relationship', weight: 0.26,
    re: /我(?:的)?[^。]{0,6}(?:老婆|老公|女朋友|男朋友|女友|男友|女儿|儿子|妹妹|姐姐|哥哥|弟弟|妈妈|爸爸|父母|猫|狗|宠物)|我的(?:朋友|同事|搭档|团队)/ },
  { id: 'relationship-en', type: 'relationship', weight: 0.26,
    re: /\bmy\s+(?:wife|husband|girlfriend|boyfriend|daughter|son|sister|brother|mother|father|mom|dad|cat|dog|pet|partner|friend)\b/i },
  { id: 'relationship-ja', type: 'relationship', weight: 0.26,
    re: /(?:私|僕|俺)の(?:妻|夫|彼女|彼氏|娘|息子|姉|妹|兄|弟|母|父|猫|犬|ペット)/ },

  // —— 打算/计划（有长期承诺的意图）：0.20
  { id: 'intent-plan', type: 'preference', weight: 0.20,
    re: /我(?:打算|计划|准备|想要|想|希望|决定|以后要|将来要|一定要)/ },
  { id: 'intent-plan-en', type: 'preference', weight: 0.20,
    re: /\b(?:i|we)\s+(?:plan\s+to|intend\s+to|am\s+going\s+to|want\s+to|hope\s+to|decided\s+to|will\s+\w+)\b/i },
  { id: 'intent-plan-ja', type: 'preference', weight: 0.20,
    re: /(?:私|僕|俺)(?:は|が)?[^。]{0,12}(?:つもり|予定|したい|欲しい|計画)/ },

  // —— 明确要求记住：0.24（用户自己说「记一下」，那当然要记）
  { id: 'explicit-memo', type: null, weight: 0.24,
    re: /(?:记住|记得|别忘了|帮我记|要记得|以后记住)/ },
  { id: 'explicit-memo-en', type: null, weight: 0.24,
    re: /\b(?:remember\s+(?:that|this)|keep\s+in\s+mind|note\s+that|don'?t\s+forget)\b/i },
  { id: 'explicit-memo-ja', type: null, weight: 0.24,
    re: /(?:覚えて|忘れないで|メモして)/ },

  // —— 知识性陈述（用户教的、关于世界的稳定信息）：0.18
  { id: 'knowledge', type: 'knowledge', weight: 0.18,
    re: /(?:其实|事实上|一般来说|众所周知|原理是|定义是|规则是|意思是说)/ },
];

/** 触发类型 → 记忆类型的优先级（一句里命中多个时取「更值得记」的那个） */
const TYPE_PRIORITY = ['relationship', 'preference', 'user_fact', 'experience', 'knowledge'];

/** 长期意图词：出现即说明这句话的时效不是「这一秒」 */
export const LONGTERM_MARKERS = [
  /以后|将来|未来|永远|一直|长期|下次|每次|从此|常年|每年|每天都?|平时|通常|习惯/,
  /\b(?:always|forever|from\s+now\s+on|in\s+the\s+future|every\s+day|usually|normally|next\s+time)\b/i,
  /これから|ずっと|いつも|今後|毎日|普段|将来/,
  // 日语的「住んでいる / 〜ている」是**持续状态**，不是一次性动作 —— 语义上等同「一直」
  /住んで(?:いる|います|ます)|独身です|結婚しています/,
];

/** 数值/型号锚点：日期、年龄、型号、金额 —— 这类信息最容易过期，也最值得记 */
const NUMERIC_ANCHOR = /(\d{1,4}\s*(?:年|月|日|号|岁|才|岁|块|元|円|ドル|GB|TB|mm|cm|kg))|(?:RTX|GTX|RX|i[3579]|R[3579]|M\d)\s?\d{3,4}|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\b/i;

/** 具名实体：专有名词白名单 + 中文姓名（姓氏表）+ 拉丁大写词 */
const PROPER_NOUN_LATIN = /\b[A-Z][A-Za-z]{2,}\b/;
const PROPER_NOUN_LIST = [
  '初音未来', '初音ミク', 'ミク', 'Magical Mirai', 'マジカルミライ',
  '上海', '北京', '广州', '深圳', '杭州', '成都', '南京', '武汉', '西安',
  '东京', '東京', '大阪', '京都', '北海道', '沖縄', '名古屋', '福岡',
  '原神', '明日方舟', '崩坏', '蔚蓝档案', 'LOL', '英雄联盟', 'Minecraft', 'Steam',
  '考研', '高考', '雅思', '托福',
];

/**
 * 中文姓氏表：中文人名没法靠「大写字母」认出来，只能靠姓氏。
 * 只收常见姓，宁可漏（名字不算实体分），也不要误判（「我是学生」的「学」不在表里）。
 */
const CN_SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡林郭何高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';
const CN_NAME_RE = new RegExp('[' + CN_SURNAMES + '][\\u4e00-\\u9fa5]{1,2}(?![\\u4e00-\\u9fa5])');

/** 是否含具名实体（专有名词 / 中文姓名 / 大写词） */
export function hasProperNoun(sentence) {
  const s = String(sentence || '');
  for (const name of PROPER_NOUN_LIST) {
    if (s.includes(name)) return name;
  }
  const m = s.match(PROPER_NOUN_LATIN);
  if (m && !['The', 'This', 'That', 'And', 'But', 'You', 'Are', 'Was'].includes(m[0])) return m[0];
  // 只有出现在「我叫/名字是/my name is」这类上下文里才认中文姓名，
  // 否则「我是学生」也可能被姓氏表误伤
  const nameCtx = /(?:我叫|名字是|名字叫|是叫|my\s+name\s+is)/i.test(s);
  if (nameCtx) {
    const cn = s.match(CN_NAME_RE);
    if (cn) return cn[0];
  }
  return '';
}

/** 寒暄/客套：这些内容不值得长期记住，命中即扣分 */
const CHITCHAT = [
  /^(?:在吗|在不在|早上?好|中午好|晚上好|晚安|你好|您好|嗨|哈喽|hi|hello|hey|yo|おはよう|こんにちは|こんばんは|おやすみ|やあ)[!！。~～,.，。]*$/i,
  /^(?:谢谢|多谢|感谢|辛苦了|好的|好嘞|行|收到|明白了|嗯嗯|哦哦|哈哈+|嘿嘿|嘻嘻|草|笑死|ありがとう|thanks?|thank\s+you|ok(?:ay)?|got\s+it)[!！。~～,.，。\s]*$/i,
  /^(?:哈+|草+|awsl|233+|lol|lmao|w{3,})[!！。~～,.，。\s]*$/i,
];

/** 纯情绪宣泄：发泄完了就过去了，不构成长期事实 */
export const VENTING = [
  /(?:好累|累死|烦死|气死|崩溃|难受|不开心|好难过|心情不好|撑不住|无语|emo|哭了|疼|痛)/,
  /\b(?:so\s+tired|exhausted|fed\s+up|annoyed|depressed|so\s+sad|stressed)\b/i,
  /(?:疲れた|つらい|しんどい|悲しい|ムカつく)/,
];

/** 一次性提问的信号（结尾疑问 + 没有别的证据时判掉） */
const QUESTION_TAIL = /[?？]\s*$|(?:吗|呢|么|吧|でしょうか|ですか|ますか)[?？。!！]*\s*$/;

/** 疑问词/语气词：Query Rewrite 也用这一份，保证「问句」和「改写」口径一致 */
export const QUESTION_WORDS = [
  '请问', '请', '帮我', '告诉我', '吗', '呢', '吧', '啊', '呀', '哦', '嘛', '的话',
  '什么', '怎么', '怎样', '如何', '为什么', '为啥', '哪个', '哪些', '哪里', '哪儿',
  '谁', '什么时候', '多少', '几点', '是不是', '能不能', '可不可以', '有没有',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'is', 'are', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'please', 'tell', 'me',
  'なに', '何', 'どこ', 'いつ', 'だれ', '誰', 'どう', 'なぜ', 'ですか', 'ますか',
];

/** 触发命中：返回该句命中的全部触发项 */
function matchTriggers(sentence) {
  const hits = [];
  for (const trig of TRIGGERS) {
    if (trig.re.test(sentence)) hits.push(trig);
  }
  return hits;
}

/** 一句里命中多个类型时，取优先级最高的那个（关系 > 偏好 > 事实 > 经历 > 知识） */
function pickType(hits) {
  for (const wanted of TYPE_PRIORITY) {
    const hit = hits.find((h) => h.type === wanted);
    if (hit) return hit.type;
  }
  for (const hit of hits) if (hit.type) return hit.type;
  return 'user_fact';
}

/** 是否含长期意图标记 */
export function hasLongtermIntent(sentence) {
  return LONGTERM_MARKERS.some((re) => re.test(String(sentence || '')));
}

/** 拆句：按中英日标点切；没标点的整句算一句 */
export function splitSentences(text) {
  return String(text == null ? '' : text)
    .split(/(?<=[。！？!?；;\n])|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从对话里取出所有「人说的话」文本，用于统计重复信息 */
function collectHumanTexts(conversation) {
  const out = [];
  for (const msg of conversation || []) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role && msg.role !== 'user') continue;
    out.push(String(msg.content == null ? '' : msg.content));
  }
  return out;
}

/**
 * 对单句打分。
 *
 * @param {string} sentence 一句话（extractor 已经拆好的）
 * @param {object} opts { repeats:number, now:number }
 * @returns {{ score:number, type:string, reasons:string[], triggerIds:string[] }}
 */
export function scoreSentence(sentence, opts = {}) {
  const text = String(sentence == null ? '' : sentence).trim();
  const reasons = [];
  if (!text) return { score: 0, type: 'user_fact', reasons: ['空内容，不评分'], triggerIds: [] };

  let score = 0;
  const hits = matchTriggers(text);
  const triggerIds = hits.map((h) => h.id);

  if (hits.length) {
    // 同一句命中多个触发时，只取最强的一个作为主分（避免「我喜欢的猫是我女儿的」堆到 1.0）
    const best = hits.reduce((a, b) => (b.weight > a.weight ? b : a));
    score += BASE_SCORE;
    reasons.push('命中原型句式（' + best.id + '），语句在陈述关于人的稳定信息 +' + BASE_SCORE.toFixed(2));
    if (best.weight > 0) {
      score += best.weight;
      reasons.push('句式强度 ' + best.id + ' +' + best.weight.toFixed(2));
    }
    if (hits.length > 1) {
      const extra = Math.min(0.06, 0.03 * (hits.length - 1));
      score += extra;
      reasons.push('同句命中 ' + hits.length + ' 类句式（' + triggerIds.join('/') + '）+' + extra.toFixed(2));
    }
  } else {
    reasons.push('未命中任何原型句式 +0.00');
  }

  const proper = hasProperNoun(text);
  if (proper) {
    score += 0.18;
    reasons.push('含具名实体「' + proper + '」（有具体对象，不是泛泛而谈）+0.18');
  }

  // 信息量：够长的一句话通常带着具体细节（主语 + 谓语 + 宾语），
  // 而不是「我很好」这种两三个字的应答
  if (text.length >= 12) {
    score += 0.05;
    reasons.push('句子长度 ≥ 12 字，含具体细节 +0.05');
  }

  if (NUMERIC_ANCHOR.test(text)) {
    score += 0.12;
    reasons.push('含数值/型号/日期锚点 +0.12');
  }

  if (hasLongtermIntent(text)) {
    score += 0.14;
    reasons.push('含长期意图标记（以后/将来/一直/每次/always/ずっと…）+0.14');
  }

  const repeats = Number(opts.repeats) || 0;
  if (repeats > 0) {
    score += 0.15;
    reasons.push('本次对话中重复出现 ' + (repeats + 1) + ' 次（重复提到 = 用户在意）+0.15');
    // 重复本身就是一个独立的「值得记」信号：哪怕句子没命中原型句式，
    // 只要反复出现，也应当被提取（比如反复提到的乐队名）。
    if (!hits.length) {
      score += 0.25;
      reasons.push('无原型句式但重复出现，按「反复提及」补足 +0.25');
    }
  }

  // —— 扣分项
  if (CHITCHAT.some((re) => re.test(text))) {
    score -= 0.6;
    reasons.push('寒暄/客套，不构成长期事实 −0.60');
  }
  if (VENTING.some((re) => re.test(text))) {
    score -= 0.25;
    reasons.push('纯情绪宣泄，会随时间失效 −0.25');
  }
  if (text.length < 6 && !hits.length) {
    score -= 0.25;
    reasons.push('过短且无信息量 −0.25');
  }
  // 疑问句只有在「没有任何长期证据」时才判掉 —— 否则「我叫什么来着？」这种
  // 反而会把真实事实误杀（它命中了 fact-identity）
  if (QUESTION_TAIL.test(text) && !hits.length && !proper && !NUMERIC_ANCHOR.test(text)) {
    score -= 0.35;
    reasons.push('一次性提问，答案不需要长期保留 −0.35');
  }

  const final = clamp01(score, 0);
  reasons.push('合计 ' + final.toFixed(2) + '（阈值 ' + DECISION_THRESHOLD + '）');
  return { score: final, type: pickType(hits), reasons, triggerIds };
}

/**
 * 判断「值不值得长期记住」。
 * @returns {{ store:boolean, reason:string, score:number, type:string, reasons:string[] }}
 */
export function shouldRemember(sentence, opts = {}) {
  const scored = scoreSentence(sentence, opts);
  const store = scored.score >= DECISION_THRESHOLD;
  const reason = store
    ? '分数 ' + scored.score.toFixed(2) + ' ≥ 阈值 ' + DECISION_THRESHOLD + '，值得长期记住'
    : '分数 ' + scored.score.toFixed(2) + ' < 阈值 ' + DECISION_THRESHOLD + '，属于寒暄/一次性问答/情绪宣泄，不入库';
  return {
    store,
    reason,
    score: scored.score,
    type: scored.type,
    reasons: scored.reasons.slice(),
  };
}

/**
 * 从一段对话里提取候选记忆。
 *
 * @param {Array<{role:string, content:string, at?:number}>} conversation 对话消息
 * @param {object} opts { now, threshold, includeAssistant, minScore }
 * @returns {{ candidates:Array, rejected:Array, stats:object }}
 *   candidates：值得记的候选（按分数降序）
 *   rejected  ：被拒的句子 + 理由（回答「为什么不记」，测试与排查都要用）
 */
export function extract(conversation, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DECISION_THRESHOLD;
  const includeAssistant = opts.includeAssistant === true;

  const humanTexts = collectHumanTexts(conversation);
  // 重复信息统计：同一内容在整段对话里出现过几次（≥2 次算「重复提到」）
  const counts = new Map();
  for (const text of humanTexts) {
    for (const sentence of splitSentences(text)) {
      const fp = contentFingerprint(sentence);
      if (fp) counts.set(fp, (counts.get(fp) || 0) + 1);
    }
  }

  const byFingerprint = new Map();
  const rejected = [];
  const messages = Array.isArray(conversation) ? conversation : [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || 'user');
    if (!includeAssistant && role !== 'user') continue;
    const at = Number.isFinite(msg.at) ? msg.at : now;

    for (const sentence of splitSentences(msg.content)) {
      const fp = contentFingerprint(sentence);
      if (!fp) continue;
      const repeats = Math.max(0, (counts.get(fp) || 1) - 1);
      const scored = scoreSentence(sentence, { repeats, now });
      const decided = {
        content: sentence,
        type: scored.type,
        importance: scored.score,
        confidence: role === 'user' ? 0.8 : 0.6,
        reasons: scored.reasons,
        fingerprints: fp,
        at,
        role,
      };

      if (scored.score < threshold) {
        rejected.push({
          content: sentence,
          reason: '分数 ' + scored.score.toFixed(2) + ' < 阈值 ' + threshold,
          reasons: scored.reasons.slice(),
        });
        continue;
      }

      // 同内容多次出现只留一条，取分更高的那条（重复本身已经在打分里加过分了）
      const prev = byFingerprint.get(fp);
      if (!prev || decided.importance > prev.importance) byFingerprint.set(fp, decided);
    }
  }

  const candidates = Array.from(byFingerprint.values())
    .sort((a, b) => b.importance - a.importance)
    .map((c) => ({
      content: c.content,
      type: MEMORY_TYPES.includes(c.type) ? c.type : 'user_fact',
      importance: clamp01(c.importance, 0),
      confidence: clamp01(c.confidence, 0.5),
      source: 'conversation',
      created_at: c.at,
      reasons: c.reasons,
    }));

  return {
    candidates,
    rejected,
    stats: {
      messages: messages.length,
      candidates: candidates.length,
      rejected: rejected.length,
      threshold,
      now,
    },
  };
}
