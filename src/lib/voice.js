// ============================================================
// 实时语音对话：说话 → 识别 → 回复 → 朗读 → 继续听
// ============================================================
import { getSettings } from './settings.js';
import { state, hooks, tts, stt } from './state.js';
import { $, toast } from './dom.js';
import { t } from './i18n.js';
import { runAssistantReply } from './chat.js';

export function setVoiceLoopUI() {
  const btn = $('btn-realtime');
  if (btn) btn.classList.toggle('active', state.voiceLoop);
  const typing = $('typing');
  if (state.voiceLoop) {
    typing.className = 'typing';
    typing.textContent = t('voice.talking');
  }
}

export function startVoiceLoop() {
  if (!state.current) {
    toast(t('chat.needChar'), true);
    hooks.openCharModal(null, null);
    return;
  }
  state.voiceLoop = true;
  setVoiceLoopUI();
  voiceListen();
}

export function stopVoiceLoop() {
  state.voiceLoop = false;
  stt.stop();
  setVoiceLoopUI();
  $('typing').className = 'typing hidden';
}

export async function voiceListen() {
  if (!state.voiceLoop) return;
  stt.onResult = (text) => {
    if (!state.voiceLoop) return;
    const t = String(text || '').trim();
    if (!t) { setTimeout(voiceListen, 300); return; }
    $('typing').textContent = t('voice.thinking');
    runAssistantReply(t, true)
      .catch((err) => toast(String(err && err.message ? err.message : err), true))
      .then(() => {
        if (!state.voiceLoop) return;
        $('typing').textContent = t('voice.replying');
        waitTtsIdle().then(() => {
          if (!state.voiceLoop) return;
          $('typing').textContent = t('voice.talking');
          setTimeout(voiceListen, 250);
        });
      });
  };
  stt.onError = (err) => {
    toast('语音识别: ' + (err && err.message ? err.message : err), true);
    if (state.voiceLoop) setTimeout(voiceListen, 900);
  };
  stt.start(getSettings());
}

export function waitTtsIdle() {
  return new Promise((resolve) => {
    if (tts.idle) return resolve();
    const iv = setInterval(() => { if (tts.idle) { clearInterval(iv); resolve(); } }, 150);
    setTimeout(() => { clearInterval(iv); resolve(); }, 180000);
  });
}
