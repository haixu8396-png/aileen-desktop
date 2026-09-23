// ============================================================
// Minecraft AI 伙伴界面控制器
// 底层是 MIT 许可的 mineflayer（主进程运行），这里只做 UI + AI 自动回复
// ============================================================
import { getSettings, saveSettings } from './settings.js';
import { state } from './state.js';
import { $, toast } from './dom.js';
import { streamChat } from './llm.js';
import { t } from './i18n.js';

let autoReply = false;
let replying = false;
let bound = false;

function el(id) { return document.getElementById(id); }

// ---------------- 日志 ----------------
function appendLog(entry) {
  const box = el('mc-log');
  if (!box || !entry) return;
  const line = document.createElement('div');
  line.className = 'mc-line mc-' + (entry.type || 'info');
  const t = new Date(entry.t || Date.now());
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ts = document.createElement('span');
  ts.className = 'mc-ts';
  ts.textContent = hh + ':' + mm;
  const tx = document.createElement('span');
  tx.textContent = entry.text;
  line.appendChild(ts);
  line.appendChild(tx);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 300) box.removeChild(box.firstChild);
}

function clearLog() { const box = el('mc-log'); if (box) box.innerHTML = ''; }

// ---------------- 状态 ----------------
function renderStatus(st) {
  const box = el('mc-status');
  if (!box) return;
  if (!st) { box.textContent = t('mc.statusIdle'); box.className = 'mc-status'; return; }
  if (st.connected) {
    const bits = [
      t('mc.connected', { host: st.host, port: st.port }),
      t('mc.botName', { name: st.username }),
      st.health != null ? '❤ ' + Math.round(st.health) : '',
      st.food != null ? '🍗 ' + Math.round(st.food) : '',
      st.pos ? '坐标 ' + st.pos.x + ',' + st.pos.y + ',' + st.pos.z : '',
      st.players && st.players.length ? t('mc.online', { n: st.players.length }) : '',
      st.following ? t('mc.following', { name: st.following }) : '',
    ].filter(Boolean);
    box.textContent = bits.join(' · ');
    box.className = 'mc-status on';
  } else {
    box.textContent = st.lastError ? t('mc.statusIdle') + ' · ' + st.lastError : t('mc.statusIdle');
    box.className = 'mc-status' + (st.lastError ? ' err' : '');
  }
  const btn = el('mc-connect');
  if (btn) btn.textContent = st.connected ? t('mc.reconnect') : t('mc.connect');
}

// ---------------- AI 自动回复 ----------------
function parseChatLine(text) {
  // 兼容 <Name> msg / Name: msg / [Name] msg / Name » msg 几种服务端格式
  const m = /^[<\[]?([A-Za-z0-9_]{2,16})[>\]]?\s*(?::|»|>)\s*(.+)$/.exec(String(text || '').trim());
  if (!m) return null;
  return { player: m[1], message: m[2].trim() };
}

async function replyTo(player, message) {
  if (replying) return;
  if (!getSettings().llm.apiKey) { appendLog({ type: 'error', text: t('mc.needKey') }); return; }
  replying = true;
  appendLog({ type: 'info', text: t('mc.thinking', { name: player }) });
  try {
    const card = state.current && state.current.data ? state.current.data : null;
    const who = card && card.name ? card.name : 'AILEEN';
    const persona = card && card.personality ? card.personality : '';
    const myName = getSettings().mc.username || 'AILEEN';
    const sys = [
      '你正在和朋友一起玩 Minecraft，你的游戏角色名是 ' + myName + '。',
      '你的人设：' + who + '。' + persona,
      '别人在游戏里跟你说话，你要用一句中文口语回他。',
      '要求：不超过 40 个字，不加引号、括号、动作描写或任何解释，直接说台词。',
    ].join('\n');
    let out = '';
    await streamChat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: player + ' 在游戏里对你说：' + message },
      ],
      settings: getSettings(),
      onDelta: (d) => { out += d; },
    });
    const clean = String(out).replace(/[\r\n]+/g, ' ').replace(/^["「『]+|[」』"]+$/g, '').trim();
    if (!clean) { appendLog({ type: 'error', text: t('mc.noReply') }); return; }
    const res = await window.api.mcSay(clean.slice(0, 200));
    if (!res || !res.ok) appendLog({ type: 'error', text: t('mc.sayFailed') + ': ' + ((res && res.error) || '') });
  } catch (err) {
    appendLog({ type: 'error', text: t('llm.testFailed', { msg: String((err && err.message) || err) }) });
  } finally {
    replying = false;
  }
}

// ---------------- 打开 / 绑定 ----------------
export async function openMcModal() {
  const mc = getSettings().mc || {};
  el('mc-host').value = mc.host || '127.0.0.1';
  el('mc-port').value = mc.port || 25565;
  el('mc-username').value = mc.username || 'AILEEN';
  autoReply = !!mc.autoReply;
  el('mc-autoreply').checked = autoReply;
  el('modal-mc').classList.remove('hidden');
  renderStatus(await window.api.mcStatus());
}

async function saveMcSettings(patch) {
  const next = Object.assign({}, getSettings());
  next.mc = Object.assign({}, next.mc || {}, patch);
  await saveSettings(next);
}

export function bindMc() {
  if (bound) return;
  bound = true;

  el('mc-connect').onclick = async () => {
    const host = el('mc-host').value.trim();
    const port = parseInt(el('mc-port').value, 10) || 25565;
    const username = el('mc-username').value.trim() || 'AILEEN';
    await saveMcSettings({ host, port, username, autoReply });
    clearLog();
    const res = await window.api.mcConnect({ host, port, username, auth: 'offline' });
    if (res && res.ok === false) { toast(res.error || t('mc.connectFailed'), true); appendLog({ type: 'error', text: res.error || t('mc.connectFailed') }); }
    else toast(t('mc.connecting', { host, port }));
  };

  el('mc-disconnect').onclick = async () => { await window.api.mcDisconnect(); renderStatus(await window.api.mcStatus()); };
  el('mc-close').onclick = () => el('modal-mc').classList.add('hidden');

  el('mc-autoreply').onchange = async (e) => {
    autoReply = e.target.checked;
    await saveMcSettings({ autoReply });
    toast(autoReply ? t('mc.autoOn') : t('mc.autoOff'));
  };

  el('mc-follow').onclick = async () => {
    const name = prompt(t('mc.follow'), '');
    if (!name) return;
    const res = await window.api.mcFollow(name.trim());
    if (!res || !res.ok) toast((res && res.error) || t('mc.followFailed'), true);
    renderStatus(await window.api.mcStatus());
  };
  el('mc-stopfollow').onclick = async () => { await window.api.mcStopFollow(); renderStatus(await window.api.mcStatus()); };

  document.querySelectorAll('#modal-mc [data-mc-dir]').forEach((b) => {
    b.onclick = () => window.api.mcStep({ dir: b.dataset.mcDir, ms: 700 });
  });
  const jump = document.querySelector('#modal-mc [data-mc-jump]');
  if (jump) jump.onclick = () => window.api.mcJump();

  el('mc-say-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const input = el('mc-say-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const res = await window.api.mcSay(text);
    if (!res || !res.ok) toast((res && res.error) || t('mc.sayFailed'), true);
  });

  window.api.onMcEvent((ev) => {
    if (!ev) return;
    if (ev.kind === 'state') { renderStatus(ev.state); return; }
    if (ev.kind === 'log') { appendLog(ev.entry); return; }
    if (ev.kind === 'chat') {
      const parsed = parseChatLine(ev.text);
      const myName = getSettings().mc.username || 'AILEEN';
      if (autoReply && parsed && parsed.player !== myName) replyTo(parsed.player, parsed.message);
    }
  });
}
