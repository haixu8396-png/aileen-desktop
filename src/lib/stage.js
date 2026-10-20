// ============================================================
// Live2D 控制（0.8 重构后）
//
// 重要变化：**主窗口不再渲染 Live2D**。
//   角色只显示在独立的透明展台窗口（src/overlay.js）里，
//   这里保留的是「模型数据 + 选择 + 模型管理 + 给展台下命令」。
//
// 为什么拆开：旧版主窗口右侧常驻 400px 的展台，聊天被挤成窄条，
// Agent 面板又要和它抢位置。现在主窗口专心做对话与任务，
// 角色安静地待在桌面上 —— 两者的生命周期互不干扰。
// ============================================================
import { state, hooks } from './state.js';
import { $, toast } from './dom.js';
import { getSettings, saveSettings } from './settings.js';
import { escapeHtml } from './markdown.js';
import { iconSvg } from './icons.js';
import { t } from './i18n.js';
import { gotoSettings } from './shell.js';

/** 模型下拉框（设置页与快捷弹窗各一个） */
const MODEL_SELECTS = ['m-model', 'q-model'];

export function stageScale() {
  const s = getSettings();
  const v = s && s.stage && s.stage.scale;
  return Number.isFinite(Number(v)) ? Number(v) : 0.45;
}

/** 启动：把设置页的模型控件填好，并把模型推给展台 */
export function initLive2D() {
  populateStageModelSelect();
  renderLocalList();
  renderUrlList();
  bindStageScale();
  updateStageModelName();
  syncOverlayModel();
}

/** 主窗口里没有模型实例了 —— 保留接口给旧调用点，明确返回 null */
export function getLive2dModel() {
  return null;
}

export function talkMotionName() { return null; }
export function idleMotionName() { return null; }

/** 模型换了：推给展台（展台自己重建） */
export function rebuildLive2D() {
  syncOverlayModel();
}

export function refreshStageControls() { /* 动作/表情列表在展台的「⋯」面板里，主窗口不再画 */ }

export function bindTtsMotion() { /* 口型跟随由展台自己处理 */ }

export function stageModelDisabled() {
  const sel = $('m-model');
  return !!(sel && sel.value === '-1');
}

/** 模型下拉框 / 输入区标签 同步 */
export function updateStageModelName() {
  const main = $('m-model');
  if (!main) return;
  const opt = main.options[main.selectedIndex];
  const label = opt && opt.value !== '-1' ? opt.textContent : t('stage.noModel');
  for (const id of MODEL_SELECTS) {
    const el = $(id);
    if (!el || el === main) continue;
    if (el.querySelector('option[value="' + main.value + '"]')) el.value = main.value;
  }
  const tip = $('composer-model');
  if (tip) tip.textContent = main.value === '-1' ? '' : String(label || '');
}

function modelOptionsHtml() {
  const cur = $('m-model');
  const prev = cur ? cur.value : '';
  const parts = ['<option value="-1">' + escapeHtml(t('stage.noModelOption')) + '</option>'];
  state.models.forEach((m, i) => {
    parts.push('<option value="' + i + '">' + escapeHtml(String(m.name || '模型 ' + (i + 1))) + '</option>');
  });
  return { html: parts.join(''), prev };
}

export function populateStageModelSelect() {
  const { html, prev } = modelOptionsHtml();
  for (const id of MODEL_SELECTS) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = html;
    const wanted = prev || el.value;
    if (wanted && el.querySelector('option[value="' + wanted + '"]')) el.value = wanted;
    else el.value = state.models.length ? '0' : '-1';
  }
  const main = $('m-model');
  if (main) {
    main.onchange = () => {
      updateStageModelName();
      syncOverlayModel();
    };
  }
  updateStageModelName();
}

export function setStageModelIndex(idx) {
  for (const id of MODEL_SELECTS) {
    const sel = $(id);
    if (sel && !isNaN(idx) && idx >= 0) sel.value = String(idx);
  }
  updateStageModelName();
  syncOverlayModel();
}

/** 当前应显示的模型：下拉框 → 角色卡绑定 → 第一个 */
export function currentStageModel() {
  const sel = $('m-model');
  const raw = sel ? sel.value : '';
  const idx = parseInt(raw, 10);
  if (raw === '-1') return null;
  if (!isNaN(idx) && idx >= 0 && state.models[idx]) return state.models[idx];
  const cur = state.current;
  if (cur && cur.data && cur.data.model) {
    const found = state.models.find((m) => m.file === cur.data.model);
    if (found) return found;
  }
  return state.models[0] || null;
}

/** 把当前模型推给展台；顺带把缩放也推过去 */
export function syncOverlayModel() {
  try {
    const m = currentStageModel();
    window.api.overlaySetModel(m ? { url: m.url, name: m.name } : null);
    pushStageScale(stageScale());
  } catch (err) { /* 展台不可用不影响主流程 */ }
}

/** 主窗口 → 展台：动作 / 表情 / 缩放（走受控 IPC 广播） */
export function stageMotion(name) {
  const v = String(name || '').trim();
  if (!v) return false;
  try { window.api.overlaySendSession({ type: 'motion', name: v }); return true; } catch (err) { return false; }
}

export function stageExpression(name) {
  const v = String(name || '').trim();
  if (!v) return false;
  try { window.api.overlaySendSession({ type: 'expression', name: v }); return true; } catch (err) { return false; }
}

export function pushStageScale(scale) {
  const v = Number(scale);
  if (!Number.isFinite(v)) return false;
  try { window.api.overlaySendSession({ type: 'scale', value: v }); return true; } catch (err) { return false; }
}

/** 设置页的缩放滑杆：实时推给展台，松手后落盘 */
export function applyStageScale(scale) {
  pushStageScale(scale);
  return true;
}

function bindStageScale() {
  const el = $('stage-scale');
  if (!el) return;
  el.value = String(stageScale());
  let timer = null;
  el.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value) || stageScale();
    pushStageScale(v);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = getSettings();
      saveSettings(Object.assign({}, s, { stage: Object.assign({}, s.stage, { scale: v }) })).catch(() => {});
    }, 400);
  });
}

// ---------------- 展台窗口 ----------------
export async function stageStatus() {
  try { return await window.api.overlayStatus(); } catch (err) { return null; }
}

export async function toggleStage() {
  try {
    const on = await window.api.overlayToggle();
    toast(on ? t('stage.shown') : t('stage.hidden'));
    return on;
  } catch (err) {
    toast(String((err && err.message) || err), true);
    return null;
  }
}

export async function resetStagePosition() {
  try {
    await window.api.overlayReset();
    toast(t('stage.resetDone'));
    return true;
  } catch (err) {
    toast(String((err && err.message) || err), true);
    return false;
  }
}

// ---------------- 模型管理（设置 → Live2D 与展台） ----------------
export function openModelModal() {
  populateStageModelSelect();
  renderLocalList();
  renderUrlList();
  gotoSettings('stage');
}

export function renderLocalList() {
  const box = $('m-local-list');
  if (!box) return;
  const locals = (state.models || []).filter((m) => m.source !== 'url');
  box.innerHTML = '';
  if (!locals.length) {
    box.innerHTML = '<div class="mem-empty">' + escapeHtml(t('model.noLocal')) + '</div>';
    return;
  }
  for (const m of locals) {
    const item = document.createElement('div');
    item.className = 'url-item';
    const nm = document.createElement('span');
    nm.className = 'ui-name';
    nm.textContent = m.name;
    const file = document.createElement('span');
    file.className = 'ui-url';
    file.textContent = m.file;
    const rm = document.createElement('button');
    rm.innerHTML = iconSvg('trash', 13);
    rm.title = t('model.delete');
    rm.dataset.delModel = m.file;
    rm.onclick = () => deleteLocalModel(m);
    item.appendChild(nm);
    item.appendChild(file);
    item.appendChild(rm);
    box.appendChild(item);
  }
}

export async function deleteLocalModel(m) {
  const used = (state.characters || []).filter((c) => c.data && c.data.model === m.file).length;
  let msg = t('model.deleteConfirm', { name: m.name });
  if (used) msg += '\n\n' + t('model.deleteInUse', { n: used });
  // eslint-disable-next-line no-alert
  if (!confirm(msg)) return;
  try {
    state.models = await window.api.deleteModel({ dir: m.dir || m.file, name: m.name });
    hooks.populateModelSelect();
    populateStageModelSelect();
    rebuildLive2D();
    renderLocalList();
    renderUrlList();
    toast(t('model.deleted', { name: m.name }));
  } catch (err) {
    toast(t('model.deleteFailed', { msg: String((err && err.message) || err) }), true);
  }
}

export async function addModelFromFolder() {
  try {
    const list = await window.api.addModelFolder();
    await refreshModelsAfterAdd();
    if (list) toast(t('model.imported', { n: Array.isArray(list) ? list.length : 0 }));
  } catch (err) {
    toast(t('model.deleteFailed', { msg: String((err && err.message) || err) }), true);
  }
}

export function showUrlForm() {
  const form = $('m-url-form');
  if (form) form.classList.remove('hidden');
}

export async function submitUrlForm() {
  const url = $('m-url-input').value.trim();
  const name = $('m-url-name').value.trim();
  if (!url) return;
  try {
    state.models = await window.api.addModelUrl({ url, name: name || undefined });
    const form = $('m-url-form');
    if (form) form.classList.add('hidden');
    await refreshModelsAfterAdd();
    toast(t('model.urlAdded', { name: name || url }));
  } catch (err) {
    toast(String((err && err.message) || err), true);
  }
}

export function renderUrlList() {
  const box = $('m-url-list');
  if (!box) return;
  const urls = (state.models || []).filter((m) => m.source === 'url');
  box.innerHTML = '';
  if (!urls.length) {
    box.innerHTML = '<div class="mem-empty">' + escapeHtml(t('model.noUrl')) + '</div>';
    return;
  }
  for (const m of urls) {
    const item = document.createElement('div');
    item.className = 'url-item';
    const nm = document.createElement('span');
    nm.className = 'ui-name';
    nm.textContent = m.name;
    const url = document.createElement('span');
    url.className = 'ui-url';
    url.textContent = m.url;
    const rm = document.createElement('button');
    rm.innerHTML = iconSvg('close', 13);
    rm.title = t('model.removeUrl');
    rm.onclick = async () => {
      state.models = await window.api.removeModelUrl(m.url);
      hooks.populateModelSelect();
      populateStageModelSelect();
      rebuildLive2D();
      renderUrlList();
      renderLocalList();
      toast(t('model.urlRemoved', { name: m.name }));
    };
    item.appendChild(nm);
    item.appendChild(url);
    item.appendChild(rm);
    box.appendChild(item);
  }
}

export async function refreshModelsAfterAdd() {
  state.models = await window.api.listModels();
  hooks.populateModelSelect();
  populateStageModelSelect();
  rebuildLive2D();
  renderLocalList();
  renderUrlList();
  const current = state.current;
  if (current && current.data && current.data.model) {
    const idx = state.models.findIndex((m) => m.file === current.data.model);
    if (idx >= 0) setStageModelIndex(idx);
  }
}
