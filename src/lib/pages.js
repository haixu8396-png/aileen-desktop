// ============================================================
// 主页面渲染：角色库 / 记忆与知识库 / 任务 / 设备状态
//
// 约定：这些页面只负责「把状态画成人能看的东西」，
// 真正的动作（切换角色、清空对话、连接 Minecraft…）交给各自模块。
// ============================================================
import { state } from './state.js';
import { $, toast } from './dom.js';
import { t, getLang } from './i18n.js';
import { iconSvg } from './icons.js';
import { fillAvatar, setNavTaskCount } from './shell.js';
import { ensureEngines, lastError } from './memory-host.js';
import { parsePdf } from '../knowledge/parser.js';
import { getSettings } from './settings.js';
import { dashboardState } from './agent-dashboard.js';

// ---------------- 角色库 ----------------
let charFilter = '';
let pageHooks = { selectCharacter: null, openMenu: null, edit: null };

export function initCharactersPage(hooks = {}) {
  pageHooks = Object.assign(pageHooks, hooks);
  const search = $('char-search');
  if (search) {
    search.addEventListener('input', () => {
      charFilter = search.value || '';
      renderCharactersPage();
    });
  }
}

export function renderCharactersPage() {
  const grid = $('character-grid');
  if (!grid) return;
  const list = (state.characters || []).filter((c) => {
    if (!charFilter) return true;
    const q = charFilter.toLowerCase();
    const d = c.data || {};
    return [c.file, d.name, d.description].some((v) => String(v || '').toLowerCase().includes(q));
  });
  const count = $('char-count');
  if (count) count.textContent = t('characters.count', { n: list.length });
  const empty = $('character-empty');
  if (empty) empty.classList.toggle('hidden', list.length > 0 || !!charFilter);
  grid.innerHTML = '';
  for (const c of list) {
    const d = c.data || {};
    const card = document.createElement('article');
    card.className = 'char-card' + (state.current && state.current.file === c.file ? ' active' : '');
    card.tabIndex = 0;
    card.dataset.file = c.file;

    const av = document.createElement('span');
    av.className = 'avatar';
    av.alt = '';
    fillAvatar(av, d.name || c.file, d.avatar || '');

    const body = document.createElement('div');
    body.className = 'cc-body';
    const name = document.createElement('div');
    name.className = 'cc-name';
    name.textContent = d.name || c.file;
    const desc = document.createElement('div');
    desc.className = 'cc-desc';
    desc.textContent = d.description || t('characters.noDesc');
    const tags = document.createElement('div');
    tags.className = 'cc-tags';
    if (d.model) tags.appendChild(tag('layers', t('char.model')));
    if (d.voice) tags.appendChild(tag('speaker', t('char.voice')));
    body.appendChild(name);
    body.appendChild(desc);
    if (tags.children.length) body.appendChild(tags);

    const more = document.createElement('button');
    more.className = 'cc-more';
    more.innerHTML = iconSvg('more', 15);
    more.title = t('chat.menuTitle');
    more.onclick = (e) => {
      e.stopPropagation();
      if (pageHooks.openMenu) pageHooks.openMenu(c.file, e.clientX, e.clientY);
    };

    card.appendChild(av);
    card.appendChild(body);
    card.appendChild(more);
    card.onclick = () => {
      if (pageHooks.selectCharacter) pageHooks.selectCharacter(c.file);
    };
    card.ondblclick = () => {
      if (pageHooks.edit) pageHooks.edit(c.data, c.file);
    };
    grid.appendChild(card);
  }
}

function tag(icon, text) {
  const el = document.createElement('span');
  el.className = 'badge';
  el.innerHTML = iconSvg(icon, 12) + '<span></span>';
  el.lastChild.textContent = ' ' + text;
  return el;
}

// ---------------- 记忆与知识库 ----------------
export function initMemoryPage() {
  document.querySelectorAll('#mem-tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#mem-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('#page-memory .mem-panel').forEach((p) => {
        p.classList.toggle('on', p.id === 'mem-panel-' + b.dataset.tab);
      });
    };
  });
  const refresh = $('btn-memory-refresh');
  if (refresh) refresh.onclick = () => { renderMemoryPage(); };
  const imp = $('btn-knowledge-import');
  const file = $('knowledge-file-input');
  if (imp && file) {
    imp.onclick = () => file.click();
    file.onchange = async () => {
      const files = [...(file.files || [])];
      file.value = '';
      if (!files.length) return;
      imp.disabled = true;
      let ok = 0;
      for (const f of files) {
        try {
          await importKnowledgeFile(f);
          ok += 1;
        } catch (err) {
          toast(t('memory.importFailed', { name: f.name, msg: String((err && err.message) || err) }), true);
        }
      }
      imp.disabled = false;
      if (ok) toast(t('memory.imported', { n: ok }));
      renderMemoryPage();
    };
  }
}

async function importKnowledgeFile(file) {
  const { knowledge } = ensureEngines();
  if (!knowledge) throw new Error(lastError() || 'knowledge engine unavailable');
  const name = file.name || 'document';
  const lower = name.toLowerCase();
  let text = '';
  if (lower.endsWith('.pdf')) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const parsed = parsePdf(buf, { fallbackTitle: name });
    text = String((parsed && parsed.text) || '');
    if (!text.trim()) throw new Error(t('memory.pdfNoText'));
  } else {
    text = await file.text();
  }
  if (!text.trim()) throw new Error(t('memory.emptyFile'));
  await knowledge.addText({
    text,
    name,
    filename: name,
    mime: file.type || '',
    size: file.size || 0,
  });
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return '';
  try {
    return new Date(v).toLocaleString(getLang() === 'zh' ? 'zh-CN' : getLang() === 'ja' ? 'ja-JP' : 'en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

function memRow(mainText, metaText, actions) {
  const row = document.createElement('div');
  row.className = 'mem-row';
  const main = document.createElement('div');
  main.className = 'mr-main';
  const name = document.createElement('div');
  name.className = 'mr-name';
  name.textContent = mainText;
  const meta = document.createElement('div');
  meta.className = 'mr-meta';
  meta.textContent = metaText;
  main.appendChild(name);
  main.appendChild(meta);
  const acts = document.createElement('div');
  acts.className = 'mr-actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.innerHTML = iconSvg(a.icon, 14);
    b.title = a.title;
    b.onclick = a.onClick;
    acts.appendChild(b);
  }
  row.appendChild(main);
  row.appendChild(acts);
  return row;
}

export async function renderMemoryPage() {
  renderMemoryList();
  renderKnowledgeList();
}

async function renderMemoryList() {
  const box = $('memory-list');
  if (!box) return;
  const status = $('memory-status');
  const badge = $('memory-scope-badge');
  const cfg = (getSettings().memoryCfg || {});
  if (badge) {
    const perChar = cfg.perCharacter !== false;
    badge.textContent = perChar ? t('memory.perCharShort') : t('memory.sharedShort');
  }
  const { memory } = ensureEngines();
  if (!memory) {
    box.innerHTML = '<div class="mem-empty">' + esc(t('memory.unavailable', { msg: lastError() || '-' })) + '</div>';
    return;
  }
  try {
    const records = await memory.list({ limit: 200 });
    const list = Array.isArray(records) ? records : (records && records.records) || [];
    if (status) {
      let stats = null;
      try { stats = await memory.stats(); } catch (err) { /* 统计失败不影响列表 */ }
      status.textContent = stats ? t('memory.stats', { n: list.length, imp: Math.round(Number(stats.averageImportance || stats.avgImportance || 0) * 100) || 0 }) : '';
    }
    if (!list.length) {
      box.innerHTML = '<div class="mem-empty">' + esc(t('memory.memoryEmpty')) + '</div>';
      return;
    }
    box.innerHTML = '';
    for (const r of list.slice(0, 200)) {
      const text = String(r.content || r.text || '').replace(/\s+/g, ' ').trim();
      const when = fmtTime(r.created_at || r.createdAt);
      const meta = [when, t('memory.importance', { n: Math.round(Number(r.importance || 0) * 100) })].filter(Boolean).join(' · ');
      box.appendChild(memRow(text.slice(0, 120) || '(空)', meta, [{
        icon: 'trash',
        title: t('memory.delete'),
        onClick: async () => {
          if (!confirm(t('memory.confirmDelete'))) return;
          try {
            await memory.forget(r.id);
            toast(t('memory.deleted'));
            renderMemoryList();
          } catch (err) {
            toast(String((err && err.message) || err), true);
          }
        },
      }]));
    }
  } catch (err) {
    box.innerHTML = '<div class="mem-empty">' + esc(String((err && err.message) || err)) + '</div>';
  }
}

async function renderKnowledgeList() {
  const box = $('knowledge-list');
  if (!box) return;
  const status = $('knowledge-status');
  const { knowledge } = ensureEngines();
  if (!knowledge) {
    box.innerHTML = '<div class="mem-empty">' + esc(t('memory.unavailable', { msg: lastError() || '-' })) + '</div>';
    return;
  }
  try {
    const docs = await knowledge.listDocuments();
    const list = Array.isArray(docs) ? docs : (docs && docs.documents) || [];
    if (status) status.textContent = t('memory.knowledgeCount', { n: list.length });
    if (!list.length) {
      box.innerHTML = '<div class="mem-empty">' + esc(t('memory.knowledgeEmpty')) + '</div>';
      return;
    }
    box.innerHTML = '';
    for (const d of list) {
      const named = d.name || d.filename || d.id;
      const chunks = Number(d.chunk_count || d.chunks || 0);
      const meta = [String(d.format || d.extension || '').toUpperCase(), fmtSize(d.size), t('memory.chunks', { n: chunks }), fmtTime(d.created_at)].filter(Boolean).join(' · ');
      box.appendChild(memRow(named, meta, [{
        icon: 'regenerate',
        title: t('memory.reindex'),
        onClick: async () => {
          try {
            await knowledge.reindexDocument(d.id);
            toast(t('memory.reindexed', { name: named }));
            renderKnowledgeList();
          } catch (err) {
            toast(String((err && err.message) || err), true);
          }
        },
      }, {
        icon: 'trash',
        title: t('memory.delete'),
        onClick: async () => {
          if (!confirm(t('memory.confirmDeleteSource', { name: named }))) return;
          try {
            await knowledge.removeDocument(d.id);
            toast(t('memory.deleted'));
            renderKnowledgeList();
          } catch (err) {
            toast(String((err && err.message) || err), true);
          }
        },
      }]));
    }
  } catch (err) {
    box.innerHTML = '<div class="mem-empty">' + esc(String((err && err.message) || err)) + '</div>';
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 任务页 ----------------
/** 本次运行期间的任务历史（还没有落盘的任务历史，所以只记内存） */
const taskHistory = [];
const MAX_HISTORY = 30;

export function noteTaskStart(goal) {
  taskHistory.unshift({
    id: 'task-' + Date.now(),
    goal: String(goal || ''),
    startedAt: Date.now(),
    status: 'running',
  });
  if (taskHistory.length > MAX_HISTORY) taskHistory.length = MAX_HISTORY;
  renderTasksPage();
}

export function noteTaskEnd(status) {
  const cur = taskHistory.find((x) => x.status === 'running');
  if (cur) {
    cur.status = status || 'completed';
    cur.endedAt = Date.now();
  }
  renderTasksPage();
}

export function renderTasksPage() {
  const st = dashboardState();
  const badge = $('task-state-badge');
  const title = $('task-title');
  const goal = $('task-goal');
  const round = $('task-round');
  const ws = $('task-workspace');
  const dot = $('task-dot');
  const running = taskHistory.find((x) => x.status === 'running');
  if (badge) badge.textContent = st.status || t('dash.idle');
  if (title) title.textContent = running ? running.goal || '—' : t('tasks.none');
  if (goal) goal.textContent = st.task && st.task !== '—' ? st.task : (running ? running.goal : '');
  if (round) round.textContent = $('ag-round') && $('ag-round').textContent ? $('ag-round').textContent : '';
  if (ws) {
    const w = $('ag-workspace');
    ws.textContent = w && w.textContent ? w.textContent : '';
  }
  if (dot) dot.className = 'status-dot' + (running ? ' warn' : ' off');
  setNavTaskCount(taskHistory.filter((x) => x.status === 'running').length);
  const box = $('task-list');
  if (!box) return;
  box.innerHTML = '';
  const past = taskHistory.filter((x) => x.status !== 'running');
  if (!past.length) {
    box.innerHTML = '<div class="mem-empty">' + esc(t('tasks.historyEmpty')) + '</div>';
    return;
  }
  for (const item of past) {
    const row = document.createElement('div');
    row.className = 'task-row';
    const main = document.createElement('span');
    main.className = 'tr-main';
    main.textContent = item.goal || '—';
    const meta = document.createElement('span');
    meta.className = 'tr-meta';
    meta.textContent = [String(item.status || ''), fmtTime(item.startedAt)].filter(Boolean).join(' · ');
    row.appendChild(main);
    row.appendChild(meta);
    box.appendChild(row);
  }
}

// ---------------- 设备页 ----------------
export function syncDevicesPage() {
  const s = getSettings();
  const on = !!(s && s.agent && s.agent.computerUse);
  const badge = $('computer-badge');
  if (badge) badge.textContent = on ? t('devices.on') : t('devices.off');
  const stateEl = $('set-computer-state');
  if (stateEl) stateEl.textContent = on ? t('devices.on') : t('devices.off');
  const btn = $('btn-computer');
  if (btn) btn.classList.toggle('computer-on', on);
}
