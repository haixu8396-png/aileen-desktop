// ============================================================
// 轻量 lint：不引第三方包，只做两件事
//   1) 所有源码必须能通过语法检查（ESM 走临时 .mjs 再 node --check）
//   2) 把这次修过的三类问题固化成规则，防止回归：
//      · 变量遮蔽 i18n 的 t()      → 会直接 TypeError: t is not a function
//      · 渲染层出现 apiKey 明文    → API Key 只允许存在于主进程
//      · 渲染层自己 fetch AI 接口  → LLM/TTS/STT 请求必须在主进程发出
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = [];
for (const d of ['src', 'shared', 'tests', 'scripts']) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walk(full, files);
}
for (const f of ['main.js', 'preload.js', 'mc-bot.cjs', 'vite.config.mjs', 'vitest.config.mjs']) {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full)) files.push(full);
}

// ---- 1) 语法检查 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-lint-'));
let checked = 0;
files.forEach((file, i) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const isCjs = file.endsWith('.cjs');
  const target = path.join(tmp, 'f' + i + (isCjs ? '.cjs' : '.mjs'));
  fs.copyFileSync(file, target);
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    checked += 1;
  } catch (err) {
    const msg = String((err && err.stderr) || (err && err.message) || err).split('\n').slice(0, 6).join('\n');
    problems.push('语法错误 ' + rel + '\n' + msg);
  }
});
fs.rmSync(tmp, { recursive: true, force: true });

// ---- 2) 规则 ----
const rendererFiles = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  return rel.startsWith('src/');
});

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const importsT = /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'[^']*i18n/.test(text) || /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'[^']*i18n/.test(text);

  lines.forEach((line, idx) => {
    const n = idx + 1;
    // 规则 A：遮蔽 i18n 的 t（本案：voice.js 里 const t = String(text)，下面 t('...') 直接炸）
    if (importsT && /(^|[\s;{(])const\s+t\s*=/.test(line)) {
      problems.push(rel + ':' + n + ' 变量遮蔽了 i18n 的 t()：' + line.trim());
    }
    if (importsT && /(^|[\s;{(])(let|var)\s+t\s*=/.test(line)) {
      problems.push(rel + ':' + n + ' 变量遮蔽了 i18n 的 t()：' + line.trim());
    }
  });

  // i18n 字典里本来就有 "llm.apiKey" 这样的「翻译键」，那不是引用密钥，跳过
  const isI18nDict = /src\/lib\/i18n(\.[a-z-]+)?\.(js|json)$/.test(rel);

  if (rendererFiles.includes(file) && !isI18nDict) {
    // 规则 B：渲染层不允许碰明文 apiKey（apiKeySet / SECRET_CLEAR 例外）
    if (/\.apiKey\b/.test(text) && !/apiKeySet|SECRET_CLEAR|keyPatch|typedKey|setKeyField|hasApiKey/.test(text)) {
      problems.push(rel + ' 渲染层直接引用了 apiKey（只允许 apiKeySet 标记）');
    }
    // 规则 C：LLM/TTS/STT 的网络请求必须在主进程
    if (/src\/lib\/(llm|tts|stt)\.js$/.test(rel)) {
      if (/\bfetch\(/.test(text)) problems.push(rel + ' 里出现了直接 fetch —— AI 请求必须在主进程发出');
      if (/Authorization/.test(text)) problems.push(rel + ' 里出现了 Authorization 头 —— API Key 不该经过渲染层');
    }
  }
}

if (problems.length) {
  console.error('lint 未通过（' + problems.length + ' 处）：');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log('lint 通过：' + checked + ' 个文件语法检查 + 遮蔽/密钥/AI 请求边界规则');
