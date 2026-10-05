'use strict';
// ============================================================
// API Key 的存储约定（纯逻辑，便于单测）
//
// 密钥字段：settings.llm.apiKey / tts.apiKey / stt.apiKey / embedding.apiKey
// 落盘时是 safeStorage 密文（前缀 safe:v1:），只有主进程能解密。
// 渲染层永远只看到 apiKey 为空字符串 + apiKeySet 布尔标记。
// ============================================================

// embedding 与其它三个同等对待：它也是一个要带 Key 出去的联网服务，
// 渲染层没有理由拿到它的明文（漏掉它的话设置接口会把明文递出去）。
const SECRET_PATHS = [
  ['llm', 'apiKey'],
  ['tts', 'apiKey'],
  ['stt', 'apiKey'],
  ['embedding', 'apiKey'],
];
const SECRET_PREFIX = 'safe:v1:';
// 渲染层想清除密钥时送这个哨兵值。空字符串表示「保持原样」——
// 表单留空是很常见的动作，不该因此把用户已经配好的密钥抹掉。
const SECRET_CLEAR = '__AILEEN_CLEAR_SECRET__';

// 送给渲染层的设置：密钥清空，只留 apiKeySet 标记
function redactSecrets(settings, extras) {
  const out = JSON.parse(JSON.stringify(settings && typeof settings === 'object' ? settings : {}));
  for (const [group, field] of SECRET_PATHS) {
    if (!out[group] || typeof out[group] !== 'object') continue;
    const has = !!String(out[group][field] || '');
    out[group][field] = '';
    out[group][field + 'Set'] = has;
  }
  return Object.assign(out, extras || {});
}

// 密钥是不是密文
function isEncryptedSecret(value) {
  return typeof value === 'string' && value.indexOf(SECRET_PREFIX) === 0;
}

// 需要迁移的只有「非空明文」
function isPlaintextSecret(value) {
  return typeof value === 'string' && value.length > 0 && !isEncryptedSecret(value);
}

// 把渲染层回传的设置里的 apiKey 归一化成「最终要写入的明文值」：
//   空字符串 / undefined / 非字符串 -> 保持 current 里的值
//   哨兵值                          -> 清空
//   其它字符串                      -> 用新值
// 同时剥掉只读标记（apiKeySet / secretsEncrypted），避免被打回文件。
function resolveSecretPatch(patch, current) {
  const out = JSON.parse(JSON.stringify(patch && typeof patch === 'object' ? patch : {}));
  const cur = current && typeof current === 'object' ? current : {};
  for (const [group, field] of SECRET_PATHS) {
    if (!out[group] || typeof out[group] !== 'object') continue;
    const inc = out[group][field];
    if (inc === SECRET_CLEAR) out[group][field] = '';
    else if (typeof inc !== 'string' || !inc) out[group][field] = (cur[group] && cur[group][field]) || '';
    delete out[group][field + 'Set'];
  }
  delete out.secretsEncrypted;
  return out;
}

module.exports = {
  SECRET_PATHS,
  SECRET_PREFIX,
  SECRET_CLEAR,
  redactSecrets,
  isEncryptedSecret,
  isPlaintextSecret,
  resolveSecretPatch,
};
