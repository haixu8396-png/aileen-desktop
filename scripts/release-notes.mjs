// ============================================================
// 从 CHANGELOG.md 生成 GitHub Release 的说明文字。
//
// 为什么要有这个：release 一发布，页面上的说明就是**用户第一眼看到的东西**。
// 之前用的是 action 自带的 generate_release_notes，它只列提交标题 ——
// 没有新功能、没有下载表、没有协议说明，等于什么都没写（0.7.0 第一版就是这样，
// 91 个字符）。
//
// 用法：node scripts/release-notes.mjs v0.7.0 .release-body.md
//   · 版本号带不带 v 都行；
//   · CHANGELOG 里找不到这一版时**不报错**，退化成一句「见 CHANGELOG」，
//     免得整个发布流程因为一句文案卡住。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'haixu8396-png/aileen-desktop';

const [, , rawVersion, outArg] = process.argv;
if (!rawVersion) {
  console.error('用法：node scripts/release-notes.mjs v0.7.0 [输出文件]');
  process.exit(1);
}
const version = String(rawVersion).trim().replace(/^v/, '');
const outFile = path.resolve(ROOT, outArg || '.release-body.md');

/** 取出 CHANGELOG 里 ## [version] 到下一个 ## [ 之间的内容 */
function changelogSection(ver) {
  const file = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const head = new RegExp('^##\\s*\\[' + ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]');
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s*\[/.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}

const section = changelogSection(version);
const exe = `AILEEN.${version}.exe`;
const setup = `AILEEN.Setup.${version}.exe`;
const zip = `AILEEN-v${version}-full-source.zip`;

const parts = [];
if (section) {
  parts.push(section);
} else {
  parts.push(`# AILEEN ${version}\n\n> 这一版的逐条改动见 [CHANGELOG.md](https://github.com/${repo}/blob/main/CHANGELOG.md)。`);
}

parts.push([
  '## 📦 下载',
  '',
  '| 文件 | 说明 |',
  '| --- | --- |',
  `| \`${setup}\` | 安装版（推荐），一次点击装好并创建快捷方式 |`,
  `| \`${exe}\` | 免安装绿色版，双击即用 |`,
  `| \`${zip}\` | 完整源码 |`,
  '',
  '> 数据仍然保存在 `D:/AileenData`（没有 D 盘则用 `%APPDATA%\\AILEEN`），**覆盖安装不会动你的角色卡、聊天记录和设置**。',
  '',
  `逐条改动见 [CHANGELOG.md](https://github.com/${repo}/blob/main/CHANGELOG.md)。`,
  '',
].join('\n'));

fs.writeFileSync(outFile, parts.join('\n\n') + '\n', 'utf8');
console.log(`[release-notes] 版本 ${version} → ${path.relative(ROOT, outFile)}（${fs.statSync(outFile).size} 字节，CHANGELOG ${section ? '命中' : '未命中'}）`);
