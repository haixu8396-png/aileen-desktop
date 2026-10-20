// 设置管理：默认值只在主进程维护（shared/util.cjs + main.js DEFAULT_SETTINGS），
// 渲染层从主进程读取，避免两份默认配置不一致。
let settings = null;

export function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source || {})) {
    if (
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key]) &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

export function getSettings() {
  return settings;
}

/**
 * 某个分组（llm / tts / stt）是否已经配好 API Key。
 *
 * 渲染层从主进程拿到的设置里，apiKey 永远是空字符串 —— 主进程只回一个
 * apiKeySet 布尔标记。所以这里**不能**再看 s.llm.apiKey 来判断，
 * 否则无论用户配没配，界面都会说「没配」。
 */
export function hasApiKey(group) {
  const g = settings && settings[group];
  if (!g) return false;
  return !!(g.apiKeySet || g.apiKey);
}

export async function loadSettings() {
  settings = await window.api.getSettings();
  return settings;
}

export async function saveSettings(next) {
  settings = await window.api.setSettings(next);
  return settings;
}

/**
 * 只改本地缓存，不落盘。
 *
 * 给「点下去必须立刻有反应」的开关用（电脑控制这类）：IPC 往返要几十毫秒，
 * 光等它就够肉眼看出迟滞，自检里的 60ms 断言也会时真时假。
 *
 * 传进来的必须是**已经脱敏**的设置（就是用 getSettings() 那份改出来的），
 * 绝不要把带明文 Key 的对象塞进来 —— 缓存里的 Key 字段必须始终是空的。
 */
export function setSettingsCache(next) {
  settings = next;
  return settings;
}
