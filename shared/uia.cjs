'use strict';
// ============================================================
// Windows UI Automation（UIA）桥：主进程用 PowerShell + .NET 自带
// UIAutomationClient 读控件树、按控件执行语义动作。
//
// 为什么走这条路（而不是装 robotjs / nut.js）：
//   · 零新依赖（UIAutomationClient 是 Windows/.NET Framework 自带的）；
//   · 语义调用（Invoke / Value / Selection / Toggle / ExpandCollapse）
//     比坐标点击稳得多 —— 窗口挪了、缩放了、DPI 变了都还认；
//   · 拿不到控件时，退化成「点控件中心」的坐标点击，但由主进程统一执行。
//
// 约定：
//   · 所有输入（标题 / 选择器 / 文本）都用 JSON.stringify 或 base64 传，
//     不拼进 PowerShell 字符串（中文、引号、花括号都不能被吃掉）。
//   · 每个脚本都输出**一行 JSON**，Node 侧只解析 JSON，不解析人类文本。
//   · 读树有节点上限（默认 200）与深度上限（默认 4）：UIA 树可以上万节点，
//     不设限会把主进程和上下文一起撑爆。
// ============================================================

/** PowerShell 里统一的前缀：加载 UIA、定义 GetForegroundWindow、拿到根元素 */
function prelude() {
  return [
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    'Add-Type -Namespace A -Name Win -MemberDefinition @\'',
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
    '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '\'@',
    '$AE = [System.Windows.Automation.AutomationElement]',
    '$TS = [System.Windows.Automation.TreeScope]',
    '$root = $AE::RootElement',
  ].join('\n');
}

/**
 * 找窗口：先按标题（-like，取第一个），标题为空则取前台窗口。
 * 输出 $win（AutomationElement）与 $hwnd。
 */
function findWindowBlock(title) {
  const want = String(title || '');
  const b64 = Buffer.from(want, 'utf8').toString('base64');
  return [
    "$want = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
    '$hwnd = [IntPtr]::Zero',
    '$win = $null',
    'if ($want) {',
    '  foreach ($w in $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {',
    '    try { if ($w.Current.Name -like "*$want*") { $win = $w; $hwnd = [IntPtr]$w.Current.NativeWindowHandle; break } } catch { }',
    '  }',
    '}',
    'if (-not $win) {',
    '  $hwnd = [A.Win]::GetForegroundWindow()',
    '  try { $win = $AE::FromHandle($hwnd) } catch { $win = $null }',
    '}',
    'if (-not $win) { Write-Output "null"; exit 0 }',
  ].join('\n');
}

function rectOf(varName) {
  return [
    'function Get-Rect($el) {',
    '  $r = New-Object A.Win+RECT',
    '  $h = [IntPtr]$el.Current.NativeWindowHandle',
    '  if ($h -ne [IntPtr]::Zero) { [void][A.Win]::GetWindowRect($h, [ref]$r); return @{x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top)} }',
    '  $b = $el.Current.BoundingRectangle',
    '  return @{x=[int]$b.X; y=[int]$b.Y; width=[int]$b.Width; height=[int]$b.Height}',
    '}',
  ].join('\n');
}

/** 当前前台窗口（给「动作后验证」用） */
function activeWindowScript() {
  return [
    prelude(),
    "Add-Type -AssemblyName System.Drawing",
    '$hwnd = [A.Win]::GetForegroundWindow()',
    '$r = New-Object A.Win+RECT',
    '[void][A.Win]::GetWindowRect($hwnd, [ref]$r)',
    '$win = $null',
    'try { $win = $AE::FromHandle($hwnd) } catch { }',
    '$title = ""',
    '$proc = ""',
    'if ($win) { try { $title = [string]$win.Current.Name } catch { } }',
    'try { $p = Get-Process -Id ([System.Diagnostics.Process]::GetCurrentProcess().Id) } catch { }',
    '$procId = 0',
    '[void][A.Win]::GetWindowThreadProcessId($hwnd, [ref]$procId)',
    'try { $proc = (Get-Process -Id $procId).ProcessName } catch { }',
    '$o = [pscustomobject]@{',
    '  id = [int64]$hwnd',
    '  title = $title',
    '  process = $proc',
    '  x = [int]$r.Left; y = [int]$r.Top',
    '  width = [int]($r.Right - $r.Left); height = [int]($r.Bottom - $r.Top)',
    '}',
    '$o | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
}

/**
 * 控件树。按可见控件（ControlView）走，深度/节点数都有上限。
 * 每个节点：level / role / name / automationId / className / rect / enabled / offscreen / patterns
 */
function treeScript({ depth = 3, maxNodes = 200 } = {}) {
  const dn = Number(depth);
  const nn = Number(maxNodes);
  const d = Math.max(1, Math.min(6, Number.isFinite(dn) ? Math.round(dn) : 3));
  const n = Math.max(10, Math.min(400, Number.isFinite(nn) ? Math.round(nn) : 200));
  return [
    prelude(),
    'function Walk($el, $level) {',
    '  if ($script:count -ge ' + n + ') { return }',
    '  $script:count += 1',
    '  $role = ""; $name = ""; $aid = ""; $cls = ""; $enabled = $false; $offscreen = $true',
    '  try { $role = [string]$el.Current.ControlType.ProgrammaticName -replace "ControlType\\.","" } catch { }',
    '  try { $name = [string]$el.Current.Name } catch { }',
    '  try { $aid = [string]$el.Current.AutomationId } catch { }',
    '  try { $cls = [string]$el.Current.ClassName } catch { }',
    '  try { $enabled = [bool]$el.Current.IsEnabled } catch { }',
    '  try { $offscreen = [bool]$el.Current.IsOffscreen } catch { }',
    '  $b = $null',
    '  try { $b = $el.Current.BoundingRectangle; } catch { }',
    '  $pats = @()',
    '  foreach ($pair in @(@("Invoke", [System.Windows.Automation.InvokePattern]::Pattern), @("Value", [System.Windows.Automation.ValuePattern]::Pattern), @("SelectionItem", [System.Windows.Automation.SelectionItemPattern]::Pattern), @("Toggle", [System.Windows.Automation.TogglePattern]::Pattern), @("ExpandCollapse", [System.Windows.Automation.ExpandCollapsePattern]::Pattern))) {',
    '    $obj = $null',
    '    try { if ($el.TryGetCurrentPattern($pair[1], [ref]$obj)) { $pats += $pair[0] } } catch { }',
    '  }',
    '  $null = $script:rows.Add([pscustomobject]@{',
    '    level = $level',
    '    role = $role',
    '    name = $name',
    '    automationId = $aid',
    '    className = $cls',
    '    x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height',
    '    enabled = $enabled',
    '    offscreen = $offscreen',
    '    patterns = $pats',
    '  })',
    '  if ($level -ge ' + d + ') { return }',
    '  $kids = $null',
    '  try { $kids = $el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return }',
    '  foreach ($k in $kids) { Walk $k ($level + 1) }',
    '}',
    findWindowBlock(''),
    '$script:rows = New-Object System.Collections.ArrayList',
    '$script:count = 0',
    'Walk $win 0',
    'if ($script:rows.Count -eq 0) { Write-Output "[]" } else { $script:rows | ConvertTo-Json -Compress -Depth 5 }',
  ].join('\n');
}

/** 选择器 → PowerShell 过滤表达式（在已经在树上的节点列表里筛） */
function selectorFilter(selector) {
  const s = (selector && typeof selector === 'object') ? selector : {};
  const parts = [];
  const b64 = (v) => Buffer.from(String(v == null ? '' : v), 'utf8').toString('base64');
  const lines = [];
  if (s.name !== undefined && String(s.name).length) {
    lines.push("$selName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(s.name) + "'))");
    parts.push('($_.name -eq $selName)');
  }
  if (s.nameContains !== undefined && String(s.nameContains).length) {
    lines.push("$selNameLike = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(s.nameContains) + "'))");
    parts.push('($_.name -like "*$selNameLike*")');
  }
  if (s.automationId !== undefined && String(s.automationId).length) {
    lines.push("$selAid = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(s.automationId) + "'))");
    parts.push('($_.automationId -eq $selAid)');
  }
  if (s.role !== undefined && String(s.role).length) {
    lines.push("$selRole = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(s.role) + "'))");
    parts.push('($_.role -eq $selRole)');
  }
  const idx = Number.isInteger(s.index) ? Math.max(0, s.index) : 0;
  return {
    lines,
    filter: parts.length ? parts.join(' -and ') : '$true',
    index: idx,
  };
}

/**
 * 按控件执行语义动作。
 * action: invoke | setValue | select | toggle | expand | collapse | focus | click
 * 拿不到对应 Pattern 时输出 { fallback: "click", x, y }，由 Node 侧用输入注入点中心。
 */
function actScript({ selector, action = 'invoke', value = '' } = {}) {
  const sel = selectorFilter(selector);
  const b64Value = Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
  const act = String(action || 'invoke').toLowerCase();
  return [
    prelude(),
    rectOf(),
    'function Walk($el, $level) {',
    '  if ($script:count -ge 400) { return }',
    '  $script:count += 1',
    '  $role = ""; $name = ""; $aid = ""',
    '  try { $role = [string]$el.Current.ControlType.ProgrammaticName -replace "ControlType\\.","" } catch { }',
    '  try { $name = [string]$el.Current.Name } catch { }',
    '  try { $aid = [string]$el.Current.AutomationId } catch { }',
    '  $b = $null',
    '  try { $b = $el.Current.BoundingRectangle } catch { }',
    '  $null = $script:rows.Add([pscustomobject]@{ el = $el; role = $role; name = $name; automationId = $aid; x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height })',
    '  if ($level -ge 6) { return }',
    '  $kids = $null',
    '  try { $kids = $el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return }',
    '  foreach ($k in $kids) { Walk $k ($level + 1) }',
    '}',
    findWindowBlock(''),
    '$script:rows = New-Object System.Collections.ArrayList',
    '$script:count = 0',
    'Walk $win 0',
    ...sel.lines,
    '$hits = @($script:rows | Where-Object { ' + sel.filter + ' })',
    'if ($hits.Count -eq 0) { Write-Output (@{ ok = $false; reason = "not-found" } | ConvertTo-Json -Compress); exit 0 }',
    '$hit = $hits[Math.Min(' + sel.index + ', $hits.Count - 1)]',
    '$el = $hit.el',
    '$res = @{ ok = $false; reason = "no-pattern"; action = "' + act + '"; name = $hit.name; role = $hit.role; x = $hit.x; y = $hit.y; width = $hit.width; height = $hit.height }',
    'if ("' + act + '" -eq "click") { $res.ok = $true; $res.fallback = "click"; $res.clickX = [int]($hit.x + $hit.width / 2); $res.clickY = [int]($hit.y + $hit.height / 2) }',
    'else {',
    '  try {',
    '    if ("' + act + '" -eq "invoke") { $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); $res.ok = $true }',
    '    elseif ("' + act + '" -eq "setValue") {',
    "      $v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64Value + "'))",
    '      $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $p.SetValue($v); $res.ok = $true',
    '    }',
    '    elseif ("' + act + '" -eq "select") { $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select(); $res.ok = $true }',
    '    elseif ("' + act + '" -eq "toggle") { $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $p.Toggle(); $res.ok = $true }',
    '    elseif ("' + act + '" -eq "expand") { $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $p.Expand(); $res.ok = $true }',
    '    elseif ("' + act + '" -eq "collapse") { $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $p.Collapse(); $res.ok = $true }',
    '    elseif ("' + act + '" -eq "focus") { $el.SetFocus(); $res.ok = $true }',
    '    else { $res.reason = "unknown-action" }',
    '  } catch { $res.reason = [string]$_.Exception.Message }',
    '}',
    'if (-not $res.ok -and -not $res.fallback) {',
    '  $res.fallback = "click"',
    '  $res.clickX = [int]($hit.x + $hit.width / 2)',
    '  $res.clickY = [int]($hit.y + $hit.height / 2)',
    '}',
    '$res | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
}

/** 窗口控制：minimize 6 / maximize 3 / restore 9 / close WM_CLOSE */
function windowControlScript({ op = 'restore', title = '' } = {}) {
  const map = { minimize: 6, maximize: 3, restore: 9 };
  const action = String(op || '').toLowerCase();
  if (action === 'close') {
    return [
      prelude(),
      findWindowBlock(title),
      '[void][A.Win]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)',
      '$title = ""',
      'try { $title = [string]$win.Current.Name } catch { }',
      '@{ ok = $true; op = "close"; title = $title; id = [int64]$hwnd } | ConvertTo-Json -Compress',
    ].join('\n');
  }
  const cmd = map[action];
  if (!cmd) throw new Error('未知的窗口操作：' + op);
  return [
    prelude(),
    findWindowBlock(title),
    '[A.Win]::ShowWindow($hwnd, ' + cmd + ') | Out-Null',
    '$title = ""',
    'try { $title = [string]$win.Current.Name } catch { }',
    '@{ ok = $true; op = "' + action + '"; title = $title; id = [int64]$hwnd } | ConvertTo-Json -Compress',
  ].join('\n');
}

module.exports = {
  activeWindowScript,
  treeScript,
  actScript,
  windowControlScript,
  selectorFilter,
};
