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

export async function loadSettings() {
  settings = await window.api.getSettings();
  return settings;
}

export async function saveSettings(next) {
  settings = await window.api.setSettings(next);
  return settings;
}
