// ============================================================
// 实时语音对话：说话 → 识别 → 回复 → 朗读 → 继续听
//
// 这一块是**竞态最密集**的地方：一个循环里套着定时器、异步识别、流式回复、
// TTS 朗读四层。所以用 `generation.js` 的代际令牌统一管理，规矩只有两条：
//
//   1) **回调动状态之前先确认自己还是当前代** —— 否则会出现
//      「已经停了，但上一次识别的结果回来又把循环拉起来」（stale callback）。
//   2) **定时器一律登记** —— 停止时统一清掉。
//      以前 `setTimeout(voiceListen, 300)` 没有句柄，stop 之后照样到期触发，
//      每触发一次就多一个待处理的识别循环。
// ============================================================
import { getSettings } from './settings.js';
import { state, hooks, tts, stt } from './state.js';
import { $, toast } from './dom.js';
import { t } from './i18n.js';
import { runAssistantReply } from './chat.js';
import { createGeneration } from './generation.js';

const gen = createGeneration();

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
  // 重复点「开始」不该起两个循环
  if (gen.begin() === null) return;
  state.voiceLoop = true;
  setVoiceLoopUI();
  voiceListen();
}

export function stopVoiceLoop() {
  // 顺序重要：先换代际（让在途回调失效）→ 再清定时器 → 再停底层
  gen.end(clearTimeout);
  state.voiceLoop = false;
  stt.stop();
  // 识别回调也解掉，避免下一次 start 之前有残留回调可跑
  stt.onResult = null;
  stt.onError = null;
  // 正在流式回复的话一起停 —— 否则「已停止」之后角色还在继续说
  if (state.busy && state.abortCtrl) {
    try { state.abortCtrl.abort(); } catch { /* 已结束 */ }
  }
  setVoiceLoopUI();
  $('typing').className = 'typing hidden';
}

export async function voiceListen() {
  const token = gen.current();
  if (!gen.isCurrent(token)) return;
  stt.onResult = (text) => {
    if (!gen.isCurrent(token)) return;
    // 注意：这里以前叫 t，把 i18n 的 t() 遮蔽成了字符串，
    // 于是下面 t('voice.thinking') 直接 TypeError: t is not a function。
    const said = String(text || '').trim();
    if (!said) { gen.schedule(voiceListen, 300, setTimeout, clearTimeout); return; }
    $('typing').textContent = t('voice.thinking');
    runAssistantReply(said, true)
      .catch((err) => {
        if (!gen.isCurrent(token)) return;
        toast(String(err && err.message ? err.message : err), true);
      })
      .then(() => {
        if (!gen.isCurrent(token)) return;
        $('typing').textContent = t('voice.replying');
        return waitTtsIdle(token).then(() => {
          if (!gen.isCurrent(token)) return;
          $('typing').textContent = t('voice.talking');
          gen.schedule(voiceListen, 250, setTimeout, clearTimeout);
        });
      });
  };
  stt.onError = (err) => {
    if (!gen.isCurrent(token)) return;
    toast('语音识别: ' + (err && err.message ? err.message : err), true);
    gen.schedule(voiceListen, 900, setTimeout, clearTimeout);
  };
  stt.start(getSettings());
}

/**
 * 等 TTS 队列空。
 * 这里也要认代际：停止循环后不该继续等，也不该把定时器留在后台跑 3 分钟。
 */
export function waitTtsIdle(token = gen.current()) {
  return new Promise((resolve) => {
    if (tts.idle) return resolve();
    const iv = setInterval(() => {
      if (tts.idle || !gen.isCurrent(token)) {
        clearInterval(iv);
        clearTimeout(guard);
        resolve();
      }
    }, 150);
    // 兜底：会话被中止/换代时也要解开，不然这个 Promise 会挂 3 分钟
    const guard = setTimeout(() => { clearInterval(iv); resolve(); }, 180000);
    // 两个都登记进本代：stopVoiceLoop() 会把它们一并清掉
    gen.adopt({ id: iv, clearFn: clearInterval });
    gen.adopt({ id: guard, clearFn: clearTimeout });
  });
}
