// ============================================================
// sync-installed.mjs —— 把当前源码同步到「已安装版」（桌面快捷方式指向的那个）
//
// 为什么需要它：
//   桌面/AILEEN.lnk 指向 %LOCALAPPDATA%\Programs\AILEEN\AILEEN.exe，
//   那是 electron-builder 打出来的包里的一份 **app.asar**。
//   平时改源码 + npm run build 只更新 dist/，装好的那份完全不动 ——
//   于是「我明明改了，桌面打开还是老版本」。
//
// 它做的事：
//   1) 先把界面构建一遍（npm run build）
//   2) 把已安装版里的 app.asar 解开放到临时目录
//   3) 只替换**应用文件**：main.js / preload.js / mc-bot.cjs / package.json
//      / shared/ / dist/
//      —— 这就是 electron-builder files 白名单里除 node_modules 之外的全部
//   4) **保留原 node_modules 不动**（几百 MB，且依赖没变，不重下）
//   5) 重打包、备份旧的、换进去
//
// 用法：
//   node scripts/sync-installed.mjs            # 构建 + 同步
//   node scripts/sync-installed.mjs --no-build # 只同步（dist 已经构好了）
//   双击 sync-installed.bat 也行
//
// 注意：更新前请先关掉 AILEEN（文件被占用会写不进去）。
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_FILES = ['main.js', 'preload.js', 'mc-bot.cjs', 'package.json'];
// dist/ = 界面构建产物；src/main/ = **主进程**用到的模块（不是前端代码，
// 所以不会被打进 dist）—— 漏了它真机上就是 "Cannot find module self-test.cjs"，
// 表现成窗口标题变成 Error。这个坑踩过一次。
const APP_DIRS = ['shared', 'dist', 'src/main'];

/** 找到已安装版的位置（和桌面快捷方式指向的一致） */
function findInstalled() {
  const candidates = [
    process.env.AILEEN_INSTALL_DIR,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'AILEEN'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'aileen'),
    path.join(process.env.ProgramFiles || '', 'AILEEN'),
  ].filter(Boolean);
  for (const dir of candidates) {
    const exe = path.join(dir, 'AILEEN.exe');
    const asar = path.join(dir, 'resources', 'app.asar');
    if (fs.existsSync(exe) && fs.existsSync(asar)) return { dir, exe, asar };
  }
  return null;
}

function log(...a) {
  console.log('[sync]', ...a);
}

function step(title) {
  log('— ' + title);
}

function main() {
  const noBuild = process.argv.includes('--no-build');
  const target = findInstalled();
  if (!target) {
    console.error('[sync] 没找到已安装版（找不到 AILEEN.exe + resources/app.asar）。');
    console.error('       如果你用的是免安装版，直接跑 npm run dev 就行。');
    process.exit(1);
  }
  log('已安装版:', target.dir);
  return run(target, noBuild);
}

async function run(target, noBuild) {

  step('确定 asar 工具');
  let asar;
  try {
    asar = require('@electron/asar');
  } catch {
    console.error('[sync] 缺少 @electron/asar（它是 electron-builder 的依赖，正常情况下应该有）。');
    process.exit(1);
  }

  if (!noBuild) {
    step('构建界面（npm run build）');
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } else {
    log('跳过构建（--no-build）');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-sync-'));
  const outDir = path.join(tmp, 'app');
  try {
    step('解包已安装的 app.asar');
    asar.extractAll(target.asar, outDir);

    step('替换应用文件（保留 node_modules）');
    for (const f of APP_FILES) {
      const from = path.join(ROOT, f);
      if (!fs.existsSync(from)) throw new Error('源文件不存在: ' + f);
      fs.copyFileSync(from, path.join(outDir, f));
      log('  文件', f);
    }
    for (const d of APP_DIRS) {
      const from = path.join(ROOT, d);
      if (!fs.existsSync(from)) throw new Error('源目录不存在: ' + d);
      const to = path.join(outDir, d);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
      log('  目录', d);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    log('  版本', pkg.version, '/', pkg.productName);

    step('重打包 app.asar');
    const newAsar = path.join(tmp, 'app.asar');
    // 注意：createPackageWithOptions 返回 Promise，**必须等**，
    // 否则下面拷贝时临时文件还没生成（踩过：ENOENT app.asar）。
    await packAsar(asar, outDir, newAsar);
    if (!fs.existsSync(newAsar)) throw new Error('打包没有产出 app.asar');

    step('备份并替换');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = path.join(path.dirname(target.asar), `app.asar.bak-${stamp}`);
    fs.copyFileSync(target.asar, backup);
    log('  备份:', backup);
    fs.copyFileSync(newAsar, target.asar);
    log('  已替换:', target.asar, '(' + Math.round(fs.statSync(target.asar).size / 1024 / 1024) + ' MB)');

    step('完成');
    log('现在从桌面快捷方式打开就是最新版了。');
    log('不满意可以还原：把备份复制回 ' + target.asar);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** @electron/asar 的打包函数在不同版本里名字不同，这里都兼容 */
function packAsar(asar, src, dest) {
  if (typeof asar.createPackageWithOptions === 'function') {
    return asar.createPackageWithOptions(src, dest, {});
  }
  if (typeof asar.createPackage === 'function') {
    return asar.createPackage(src, dest);
  }
  throw new Error('@electron/asar 没有可用的打包函数');
}

main().catch((err) => {
  console.error('[sync] 失败:', (err && err.message) || err);
  process.exit(1);
});
