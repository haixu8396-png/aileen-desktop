'use strict';
// ============================================================
// 设置与 API Key 存储（主进程）
//
// 这个文件管三件事，它们本来就是一件事的三个面：
//
// 1) **设置读写**：白名单 + 类型/范围校验（未知字段丢弃），脏数据不会长期留存。
// 2) **API Key 加密落盘**：用 Electron safeStorage（Windows 走 DPAPI，密钥绑定当前
//    用户账户）。三条边界：
//      · 旧文件里的明文仍然可用，启动时会被自动加密回写（迁移，幂等）；
//      · safeStorage 不可用时退化为明文，功能不受影响（secretsEncrypted 会如实告知界面）；
//      · 解密失败（换机器/用户配置损坏）只当作「没配」，**绝不让整个设置读取失败**。
// 3) **送给渲染层的永远是脱敏副本**：密钥一律清空，只留 apiKeySet 布尔标记。
//
// 依赖全部注入（见 createSettingsStore 的 deps），所以能被单测直接跑，
// 不需要真的起 Electron。
//
// 纯逻辑（脱敏规则、密钥回传语义）在 shared/secrets.cjs，那边也有单测。
// ============================================================
const fs = require('fs');
const path = require('path');
const { deepMerge, normalizeSettings } = require('../../../shared/util.cjs');

/**
 * @param {object} deps
 *   settingsFile     settings.json 的绝对路径
 *   dataDir / modelsDir / charactersDir  迁移时要用到的目录
 *   appRoot          旧版数据会放在应用目录里，迁移要扫
 *   defaultSettings  DEFAULT_SETTINGS
 *   ensureDirs       () => void，确保目录存在
 *   safeStorage      Electron 的 safeStorage（可空 —— 测试里不传就走明文退化分支）
 *   secrets          shared/secrets.cjs 的导出
 *   log              可选日志
 */
function createSettingsStore(deps) {
  const {
    settingsFile, dataDir, modelsDir, charactersDir, appRoot,
    defaultSettings, ensureDirs, safeStorage, secrets,
  } = deps;
  const log = deps.log || (() => {});
  const { SECRET_PATHS, SECRET_PREFIX, redactSecrets } = secrets;

  function encryptionAvailable() {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
  }

  function encryptSecret(plain) {
    const value = String(plain == null ? '' : plain);
    if (!value) return '';
    if (value.startsWith(SECRET_PREFIX)) return value;      // 已经是密文，别二次加密
    if (!encryptionAvailable()) return value;
    try { return SECRET_PREFIX + safeStorage.encryptString(value).toString('base64'); } catch { return value; }
  }

  function decryptSecret(stored) {
    const value = String(stored == null ? '' : stored);
    if (!value) return '';
    if (!value.startsWith(SECRET_PREFIX)) return value;     // 旧版明文
    if (!encryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'));
    } catch {
      log('API Key 解密失败（换了机器或用户配置损坏），按未配置处理');
      return '';
    }
  }

  /** 内部视图：密钥是明文（只在主进程里流通） */
  function withDecryptedSecrets(settings) {
    const out = settings && typeof settings === 'object' ? settings : {};
    for (const [group, field] of SECRET_PATHS) {
      if (out[group] && typeof out[group] === 'object') out[group][field] = decryptSecret(out[group][field]);
    }
    return out;
  }

  /** 落盘视图：密钥是密文 */
  function withEncryptedSecrets(settings) {
    const out = deepMerge({}, settings && typeof settings === 'object' ? settings : {});
    for (const [group, field] of SECRET_PATHS) {
      if (out[group] && typeof out[group] === 'object' && typeof out[group][field] === 'string') {
        out[group][field] = encryptSecret(out[group][field]);
      }
    }
    return out;
  }

  /** 送给渲染层的设置：密钥清空，只留「配没配」 */
  function settingsForRenderer(settings) {
    return redactSecrets(settings, { secretsEncrypted: encryptionAvailable() });
  }

  /** 启动时把历史明文密钥就地加密（幂等：已经是密文的不重复加密） */
  function migrateSecretsToEncrypted() {
    if (!encryptionAvailable()) return false;
    try {
      if (!fs.existsSync(settingsFile)) return false;
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      let changed = 0;
      for (const [group, field] of SECRET_PATHS) {
        const v = raw[group] && raw[group][field];
        if (typeof v === 'string' && v && !v.startsWith(SECRET_PREFIX)) {
          const enc = encryptSecret(v);
          if (enc && enc.startsWith(SECRET_PREFIX)) { raw[group][field] = enc; changed += 1; }
        }
      }
      if (changed) {
        fs.writeFileSync(settingsFile, JSON.stringify(raw, null, 2), 'utf8');
        log('已把 ' + changed + ' 个明文 API Key 迁移为 safeStorage 密文');
      }
      return changed > 0;
    } catch (err) {
      log('密钥迁移失败: ' + ((err && err.message) || err));
      return false;
    }
  }

  function readSettings() {
    ensureDirs();
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      raw = {};   // 文件不存在/损坏 → 用默认值起步，绝不抛穿
    }
    // 白名单 + 类型/范围校验：未知字段丢弃，脏数据不会长期留存
    return withDecryptedSecrets(normalizeSettings(deepMerge(defaultSettings, raw), defaultSettings));
  }

  function copyDirRec(src, dst) {
    if (!fs.existsSync(src)) return;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyDirRec(s, d);
      } else if (e.isFile() && !fs.existsSync(d)) {
        fs.copyFileSync(s, d);   // 只补缺失的，不覆盖用户现有数据
      }
    }
  }

  /** 首次启动时把历史版本的数据迁到当前数据目录，之后以当前目录为准 */
  function migrateLegacyData() {
    try {
      // 历史数据位置：旧版 D 盘目录、旧版 %APPDATA%\Elysia、旧版应用目录
      const legacyRoots = [
        'D:/ElysiaData',
        path.join(process.env.APPDATA || '', 'Elysia'),
        appRoot,
      ].filter((p) => p && p !== dataDir);

      const hasSettings = () => fs.existsSync(settingsFile);
      const hasChars = () => fs.existsSync(charactersDir)
        && fs.readdirSync(charactersDir).some((n) => n.endsWith('.json'));
      // 注意：models/ 里只有 README.txt 时不算「已有模型」，否则会挡住旧版本模型的迁移
      const hasModels = () => fs.existsSync(modelsDir)
        && fs.readdirSync(modelsDir).some((n) => n !== 'README.txt' && !n.startsWith('.'));

      for (const root of legacyRoots) {
        if (!fs.existsSync(root)) continue;
        const legacySettings = path.join(root, 'data', 'settings.json');
        if (!hasSettings() && fs.existsSync(legacySettings)) {
          fs.copyFileSync(legacySettings, settingsFile);
        }
        const legacyChars = path.join(root, 'characters');
        if (!hasChars() && fs.existsSync(legacyChars)) copyDirRec(legacyChars, charactersDir);
        const legacyModels = path.join(root, 'models');
        if (!hasModels() && fs.existsSync(legacyModels)) copyDirRec(legacyModels, modelsDir);
      }
    } catch (err) {
      log('旧数据迁移出错（已忽略，不影响启动）: ' + ((err && err.message) || err));
    }
  }

  function writeSettings(settings) {
    ensureDirs();
    const current = readSettings();
    // 与现有设置合并后统一规范化：数组整体替换、未知字段丢弃、越界值收敛
    const next = normalizeSettings(deepMerge(current, settings || {}), defaultSettings);
    // 落盘前把密钥换成密文；内存里继续用明文那份
    fs.writeFileSync(settingsFile, JSON.stringify(withEncryptedSecrets(next), null, 2), 'utf8');
    return next;
  }

  return {
    encryptionAvailable,
    encryptSecret,
    decryptSecret,
    withDecryptedSecrets,
    withEncryptedSecrets,
    settingsForRenderer,
    migrateSecretsToEncrypted,
    readSettings,
    writeSettings,
    migrateLegacyData,
    copyDirRec,
  };
}

module.exports = { createSettingsStore };
