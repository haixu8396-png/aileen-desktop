'use strict';
// ============================================================
// AI 服务的语言码映射（主进程与渲染层共用；有单测）
// ============================================================

// 小米 ASR 的语言码。
// 曾经的写法是「不是 auto、不是 zh 就当作 en」—— 选日语/西班牙语会被当成英语送去识别，
// 出来的结果当然是垃圾，而用户完全看不出为什么。
// 现在按语言码原样透传；只有遇到不认识的值才退回 auto（交给服务端自己判断），
// 而不是硬说成 en。
const XIAOMI_ASR_LANGS = { auto: 'auto', zh: 'zh', en: 'en', ja: 'ja', es: 'es' };

function xiaomiAsrLang(language) {
  const key = String(language == null ? 'auto' : language).toLowerCase();
  return Object.prototype.hasOwnProperty.call(XIAOMI_ASR_LANGS, key) ? XIAOMI_ASR_LANGS[key] : 'auto';
}

module.exports = { XIAOMI_ASR_LANGS, xiaomiAsrLang };
