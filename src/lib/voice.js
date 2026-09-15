// ============================================================
// 实时语音对话：说话 → 识别 → 回复 → 朗读 → 继续听
// ============================================================
import { getSettings } from './settings.js';
import { state, hooks, tts, stt } from './state.js';
import { $, toast } from './dom.js';
import { runAssistantReply } from './chat.js';

export function setVoiceLoopUI() {
  const btn = $('btn-realtime');
  if (btn) btn.classList.toggle('active', state.voiceLoop);
  const typing = $('typing');
  if (state.voiceLoop) {
    typing.className = 'typing';
    typing.textContent = '实时对话中：请说话…（再次点击按钮停止）';
  }
}

export function startVoiceLoop() {
  if (!state.current) {
    toast('请先创建并选择一个角色卡', true);
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
    $('typing').textContent = '实时对话中：思考中…';
    runAssistantReply(t, true)
      .catch((err) => toast(String(err && err.message ? err.message : err), true))
      .then(() => {
        if (!state.voiceLoop) return;
        $('typing').textContent = '实时对话中：回复中…';
        waitTtsIdle().then(() => {
          if (!state.voiceLoop) return;
          $('typing').textContent = '实时对话中：请说话…';
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
