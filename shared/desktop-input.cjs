'use strict';
// ============================================================
// 电脑控制的输入注入（鼠标 / 键盘）—— Windows 平台
//
// 为什么走 PowerShell 而不是装 robotjs / nut.js：
//   · 那两个包都有原生模块，要 node-gyp 编译，会把打包和 CI 拖垮；
//   · 这个项目已经处处依赖 PowerShell（MC / 自检 / 构建），加一段 P/Invoke
//     是**零新依赖**的解法；
//   · 脚本是**参数化生成**的（坐标/按键都过严格校验），不是拼接用户输入。
//
// 安全：所有数值都收敛到合法范围，文本走 base64 传参（避免引号/中文注入），
//       按键只在白名单里。这一层不负责「要不要问用户」——那是权限层的事。
// ============================================================

const { spawn } = require('child_process');

/** 允许按下的键（白名单）：常用功能键 + 字母数字 + 少量符号 */
const KEY_WHITELIST = [
  'enter', 'tab', 'esc', 'escape', 'space', 'backspace', 'delete', 'insert',
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  'ctrl', 'control', 'alt', 'shift', 'win', 'meta',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '-', '=', ',', '.', '/',
  // 注意：**不要**把 ; & | > < $ ( ) [ ] { } ` \ 加进来 ——
  // 这些是 shell 元字符，任何要拼进命令行的东西都不该接受它们。
];

function isWindows() {
  return process.platform === 'win32';
}

/** 坐标收敛：防止把鼠标移到多屏之外或塞进奇怪的值 */
function clampCoord(v, max = 20000) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new Error('坐标必须是数字');
  return Math.max(-max, Math.min(max, n));
}

/** 按键规范化 + 白名单校验 */
function normalizeKey(k) {
  const s = String(k || '').trim().toLowerCase();
  if (!s) throw new Error('按键不能为空');
  if (!KEY_WHITELIST.includes(s)) throw new Error('不支持的按键：' + s);
  return s;
}

/** 把白名单按键翻成 SendKeys 能认的写法 */
function toSendKeys(key) {
  const map = {
    enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ',
    backspace: '{BACKSPACE}', delete: '{DELETE}', insert: '{INSERT}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    ctrl: '^', control: '^', alt: '%', shift: '+',
  };
  if (map[key]) return map[key];
  if (/^f\d{1,2}$/.test(key)) return '{' + key.toUpperCase() + '}';
  // 单字符直接用（SendKeys 对 + ^ % ~ ( ) { } [ ] 有特殊含义，做转义）
  if (key.length === 1) return /[+^%~(){}[\]]/.test(key) ? '{' + key + '}' : key;
  return '';
}

/** 跑一段 PowerShell 脚本，返回 { ok, out, err } */
function runPwsh(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, err: String((err && err.message) || err) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: String(e && e.message || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
  });
}

/** 鼠标动作的 P/Invoke 脚本（坐标与动作都是校验过的数值） */
function mouseHeader() {
  return [
    'Add-Type -Namespace A -Name N -MemberDefinition @\'',
    '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
    '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);',
    '\'@',
  ].join('\n');
}

function mouseFlags(action) {
  return {
    left: { down: '0x0002', up: '0x0004' },
    right: { down: '0x0008', up: '0x0010' },
    middle: { down: '0x0020', up: '0x0040' },
  }[action];
}

function mouseScript(action, x, y) {
  const header = mouseHeader();
  if (action === 'move') {
    return header + '\n[A.N]::SetCursorPos(' + x + ', ' + y + ')';
  }
  const flags = mouseFlags(action);
  if (!flags) throw new Error('未知的鼠标动作：' + action);
  return header + '\n[A.N]::mouse_event(' + flags.down + ',0,0,0,0)\n[A.N]::mouse_event(' + flags.up + ',0,0,0,0)';
}

/**
 * 点击脚本：可以在**同一次调用**里先移到坐标再点，并支持双击。
 *
 * 为什么必须合并成一次调用：移动与点击拆成两次 IPC 时，两次之间用户把鼠标
 * 挪走（或别的程序抢焦点），点下去的就是别的东西 —— 这类误操作不可撤销。
 * 以前 double 参数也只落在返回值里、脚本不认（点了两下变一下），一起修掉。
 */
function clickScript({ button = 'left', double = false, x = null, y = null } = {}) {
  const flags = mouseFlags(String(button || 'left'));
  if (!flags) throw new Error('未知的鼠标键：' + button);
  const parts = [mouseHeader()];
  if (Number.isFinite(x) && Number.isFinite(y)) {
    parts.push('[A.N]::SetCursorPos(' + Math.round(x) + ', ' + Math.round(y) + ')');
    parts.push('Start-Sleep -Milliseconds 60');
  }
  const click = '[A.N]::mouse_event(' + flags.down + ',0,0,0,0)\n[A.N]::mouse_event(' + flags.up + ',0,0,0,0)';
  parts.push(click);
  if (double) {
    parts.push('Start-Sleep -Milliseconds 90');
    parts.push(click);
  }
  return parts.join('\n');
}

/**
 * SendKeys 的**元字符**：+ ^ % ~ ( ) { } [ ]
 *
 * 它们在 SendKeys 里有特殊含义（修饰键 / 分组 / 快捷键语法），直接发过去
 * 会被当成按键指令而不是文字。真机踩过：让 Agent 往记事本里「敲」一段 HTML，
 * 代码里的 `{` `}` 让 SendKeys 当成按键组，敲到一半就炸了。
 */
const SENDKEYS_META = /[+^%~()[\]{}]/;

/** 把一段纯文本转成 SendKeys 能原样打出来的写法 */
function escapeSendKeys(text) {
  let out = '';
  for (const ch of String(text == null ? '' : text)) {
    if (ch === '\r') continue;
    if (ch === '\n') { out += '{ENTER}'; continue; }
    if (ch === '\t') { out += '{TAB}'; continue; }
    if (SENDKEYS_META.test(ch)) out += '{' + ch + '}';
    else out += ch;
  }
  return out;
}

/**
 * 键盘输入的脚本：文字走 base64，避免引号与中文被 PowerShell 吃掉。
 *
 * 两条路：
 *   · 短、纯单行的文字 → SendKeys（不碰剪贴板，快）
 *   · 长文本 / 带换行 / 带元字符（代码基本都带）→ 先写剪贴板再 Ctrl+V
 *     剪贴板这条路没有长度限制，也不会被任何元字符语义影响。
 */
function typeScript(text) {
  const raw = String(text == null ? '' : text);
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  const head = [
    'Add-Type -AssemblyName System.Windows.Forms',
    "$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
  ];
  const needClipboard = raw.length > 80 || /[\r\n\t]/.test(raw) || SENDKEYS_META.test(raw);
  if (needClipboard) {
    return head.concat([
      'Set-Clipboard -Value $t',
      'Start-Sleep -Milliseconds 120',
      "[System.Windows.Forms.SendKeys]::SendWait('^v')",
      'Start-Sleep -Milliseconds 200',
    ]).join('\n');
  }
  // 短文本也走 base64：原文不进脚本（引号 / 中文 / 元字符都不会被 PowerShell 吃掉）
  const escapedB64 = Buffer.from(escapeSendKeys(raw), 'utf8').toString('base64');
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    "$e = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + escapedB64 + "'))",
    '[System.Windows.Forms.SendKeys]::SendWait($e)',
  ].join('\n');
}

/** 快捷键脚本：**先逐个过白名单**，再译成 SendKeys 写法（不在白名单就抛错） */
function pressScript(keys) {
  const seq = (Array.isArray(keys) ? keys : []).map((k) => {
    const norm = normalizeKey(k);
    const mapped = toSendKeys(norm);
    if (!mapped) throw new Error('按键无法翻译成 SendKeys：' + norm);
    return mapped;
  }).join('');
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    "[System.Windows.Forms.SendKeys]::SendWait('" + seq.replace(/'/g, "''") + "')",
  ].join('\n');
}

/** 列窗口标题（用主窗口标题，零依赖） */
function listWindowsScript() {
  return [
    'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |',
    '  Select-Object -First 40 -ExpandProperty MainWindowTitle',
  ].join('\n');
}

/** 把匹配标题的窗口切到前台 */
function focusWindowScript(title) {
  const b64 = Buffer.from(String(title), 'utf8').toString('base64');
  return [
    'Add-Type -Namespace A -Name W -MemberDefinition @\'',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '\'@',
    "$k = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
    '$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$k*" } | Select-Object -First 1',
    'if (-not $p) { Write-Output "NOT_FOUND"; exit 3 }',
    '[A.W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null',
    '[A.W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
    'Write-Output $p.MainWindowTitle',
  ].join('\n');
}

/**
 * 列窗口（带句柄、进程名、窗口矩形），输出 JSON。
 *
 * 以前只有标题字符串：没法指定「第几个窗口」，也没法判断它多大、在哪个屏。
 * 标题里带引号/中文时也不能拼进命令行 —— 这里输出 JSON，由 Node 侧解析。
 * 只取前 40 个有标题的主窗口，够用且不会把提示词撑爆。
 */
function listWindowsJsonScript() {
  return [
    'Add-Type -Namespace A -Name R -MemberDefinition @\'',
    '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '\'@',
    '$items = @()',
    'foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne "" } | Select-Object -First 40)) {',
    '  $r = New-Object A.R+RECT',
    '  [void][A.R]::GetWindowRect($p.MainWindowHandle, [ref]$r)',
    '  $items += [pscustomobject]@{',
    '    id = [int64]$p.MainWindowHandle',
    '    title = [string]$p.MainWindowTitle',
    '    process = [string]$p.ProcessName',
    '    x = [int]$r.Left',
    '    y = [int]$r.Top',
    '    width = [int]($r.Right - $r.Left)',
    '    height = [int]($r.Bottom - $r.Top)',
    '  }',
    '}',
    'if ($items.Count -eq 0) { Write-Output "[]"; exit 0 }',
    '$items | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
}

/**
 * 滚轮脚本：mouse_event MOUSEEVENTF_WHEEL(0x0800)，delta 正=向上、负=向下。
 * 一次滚动量按 Windows 的 WHEEL_DELTA=120 换算，模型给的是「格数」。
 */
function scrollScript({ direction = 'down', amount = 3, x = null, y = null } = {}) {
  const dir = String(direction || 'down').toLowerCase();
  if (!['up', 'down'].includes(dir)) throw new Error('未知的滚动方向：' + direction);
  const steps = Math.max(1, Math.min(50, Math.round(Number(amount) || 3)));
  const delta = (dir === 'up' ? 1 : -1) * 120 * steps;
  const parts = [mouseHeader()];
  if (Number.isFinite(x) && Number.isFinite(y)) {
    parts.push('[A.N]::SetCursorPos(' + Math.round(x) + ', ' + Math.round(y) + ')');
    parts.push('Start-Sleep -Milliseconds 60');
  }
  parts.push('[A.N]::mouse_event(0x0800, 0, 0, ' + delta + ', 0)');
  return { script: parts.join('\n'), direction: dir, amount: steps, delta };
}

/**
 * 拖拽脚本：按下 → 分步移动 → 松开。分步是为了让目标应用收到连续的拖动事件
 * （一次跳到终点，很多应用只会当成「点了两下」）。
 */
function dragScript({ x = 0, y = 0, toX = 0, toY = 0, button = 'left', steps = 12 } = {}) {
  const flags = mouseFlags(String(button || 'left'));
  if (!flags) throw new Error('未知的鼠标键：' + button);
  const fromX = Math.round(Number(x) || 0);
  const fromY = Math.round(Number(y) || 0);
  const endX = Math.round(Number(toX) || 0);
  const endY = Math.round(Number(toY) || 0);
  const n = Math.max(4, Math.min(40, Math.round(Number(steps) || 12)));
  return [
    mouseHeader(),
    '[A.N]::SetCursorPos(' + fromX + ', ' + fromY + ')',
    'Start-Sleep -Milliseconds 60',
    '[A.N]::mouse_event(' + flags.down + ',0,0,0,0)',
    'Start-Sleep -Milliseconds 40',
    'for ($i = 1; $i -le ' + n + '; $i++) {',
    '  [A.N]::SetCursorPos(' + fromX + ' + [int](((' + endX + ' - ' + fromX + ') * $i) / ' + n + '), ' + fromY + ' + [int](((' + endY + ' - ' + fromY + ') * $i) / ' + n + '))',
    '  Start-Sleep -Milliseconds 15',
    '}',
    'Start-Sleep -Milliseconds 40',
    '[A.N]::mouse_event(' + flags.up + ',0,0,0,0)',
  ].join('\n');
}

/**
 * 删除到回收站（可恢复）。
 * 为什么不直接 unlink：Agent 删错东西不该是不可恢复的 —— 任务书要求
 * 「删除优先进入回收站/隔离区；永久删除必须独立确认」。
 * 走 Microsoft.VisualBasic.FileIO.FileSystem 的 SendToRecycleBin，路径 base64 传入。
 */
function recycleScript(absPath, isDirectory = false) {
  const b64 = Buffer.from(String(absPath), 'utf8').toString('base64');
  return [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    "$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
    isDirectory
      ? "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')"
      : "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  ].join('\n');
}

module.exports = {
  isWindows,
  clampCoord,
  normalizeKey,
  toSendKeys,
  escapeSendKeys,
  runPwsh,
  mouseScript,
  clickScript,
  scrollScript,
  dragScript,
  typeScript,
  pressScript,
  listWindowsScript,
  listWindowsJsonScript,
  focusWindowScript,
  recycleScript,
  KEY_WHITELIST,
};
