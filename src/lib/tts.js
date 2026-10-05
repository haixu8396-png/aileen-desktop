// TTS 模块：web（系统语音，本地）/ openai / fish / xiaomi（这三家的请求在主进程发出）
// 支持顺序播放队列、取消、语言选择（zh/en/ja/es）
//
// 职责划分：渲染层负责「排队、取消、解码、播放」，主进程负责「带着 API Key 去取音频字节」。
const LANG_CODES = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', es: 'es-ES' };

export class TTS {
  constructor() {
    this.queue = [];
    this.playing = false;
    this._provider = null;
    this._src = null;
    this._abort = null;
    this._audioCtx = null;
    // 当前正在播放的那一项的令牌。
    // 为什么需要它：一个 item 的结束信号可能来自多个地方 —— 音频的 onended、
    // speechSynthesis 的 onend/onerror、以及用户点「停止」时我们主动调用的 cancel()。
    // 这些信号会先后到达，以前每次到达都会 _finish() → _next()，
    // 于是队列被推进两次：轻则 onEnd 触发两次，重则跳过后面那条消息、
    // 甚至在 cancel 之后把新入队的消息当成「上一项的结束」直接播掉/丢掉。
    // 现在每个 item 有自己的令牌，完成是幂等的：只有「当前这一项的第一次完成」才推进队列。
    this._token = null;
    this._seq = 0;
    this.onStart = null; // (text) => void
    this.onEnd = null;   // () => void
    this.onError = null; // (err) => void
  }

  /** 取一个新的播放令牌 */
  _newToken() {
    this._seq += 1;
    this._token = { id: this._seq, done: false };
    return this._token;
  }

  /**
   * 结束当前项并推进队列。返回 false 表示「这个结束信号已经过期/重复」，
   * 调用方不需要做任何事 —— 这正是防双重推进的关键。
   */
  _finishCurrent(token) {
    if (!token || token.done || token !== this._token) return false;
    token.done = true;
    this._finish();
    return true;
  }

  get speaking() { return this.playing; }

  // 队列为空且当前没有在朗读
  get idle() { return !this.playing && this.queue.length === 0; }

  enqueue(text, settings) {
    const t = String(text || '').trim();
    if (!t) return;
    this.queue.push({ text: t, settings });
    if (!this.playing) this._next();
  }

  cancel() {
    this.queue = [];
    // 先让当前项「失效」，再触发底层的 cancel/stop。
    // 顺序反过来的话，speechSynthesis.cancel() / src.stop() 会同步抛出
    // onend/onended，那边就会推进一次队列，这里再推一次 —— 双重推进。
    const token = this._token;
    if (token) token.done = true;
    this._token = null;
    if (!this.playing) return;
    if (this._provider === 'web') {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    } else {
      try { if (this._src) this._src.stop(); } catch { /* ignore */ }
      if (this._abort) { try { this._abort.abort(); } catch { /* ignore */ } }
    }
    this._finish();
  }

  async _next() {
    if (this.queue.length === 0) {
      this.playing = false;
      if (this.onEnd) this.onEnd();
      return;
    }
    const item = this.queue.shift();
    const token = this._newToken();
    // 取到就立刻置为「在播」。
    // 真机上 speechSynthesis 的 onstart 是**异步**回调，靠它来置 playing 的话，
    // 连续 enqueue 两条时第二条会在 playing 还是 false 的时候又发起一次 _next() ——
    // 结果两条同时开口（而且令牌会被后者覆盖，前一条永远完不成）。
    this.playing = true;
    this._provider = item.settings.tts.provider || 'web';
    try {
      if (this._provider === 'web') this._speakWeb(item.text, item.settings, token);
      else await this._speakRemote(item.text, item.settings, token);
    } catch (err) {
      if (this.onError) this.onError(err);
      // 失败也要走同一条「幂等完成」通道，避免随后的 onended 再推进一次
      this._finishCurrent(token);
    }
  }

  _finish() {
    this._src = null;
    this._abort = null;
    this.playing = false;
    this._next();
  }

  // ---------- 系统语音 ----------
  _speakWeb(text, settings, token) {
    if (!('speechSynthesis' in window)) throw new Error('当前环境不支持系统语音合成');
    const u = new SpeechSynthesisUtterance(text);
    const voice = this._pickVoice(settings.tts.voice, settings.tts.language);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang || LANG_CODES[settings.tts.language] || 'zh-CN';
    } else {
      u.lang = LANG_CODES[settings.tts.language] || 'zh-CN';
    }
    u.rate = Number(settings.tts.rate) || 1;
    u.onstart = () => {
      // playing 已经在 _next() 里置好了，这里只负责通知界面
      this.playing = true;
      if (this.onStart) this.onStart(text);
    };
    // onend / onerror 都可能来，甚至先后都来；完成是幂等的，只有第一次算数
    u.onend = () => this._finishCurrent(token);
    u.onerror = () => this._finishCurrent(token);
    window.speechSynthesis.speak(u);
  }

  _pickVoice(preferred, language) {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const norm = (s) => String(s || '').toLowerCase();
    if (preferred) {
      const hit = voices.find((v) => norm(v.name) === norm(preferred) || norm(v.name).includes(norm(preferred)));
      if (hit) return hit;
    }
    if (language && LANG_CODES[language]) {
      const prefix = norm(LANG_CODES[language].split('-')[0]);
      const match = voices.filter((v) => norm(v.lang).startsWith(prefix));
      if (match.length) return match[0];
    }
    const zh = voices.filter((v) => /^zh/i.test(v.lang));
    return zh[0] || voices[0];
  }

  // ---------- 公共音频播放 ----------
  _getAudioCtx() {
    if (!this._audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new Ctx();
    }
    return this._audioCtx;
  }

  async _playBytes(buf, text, token) {
    const ctx = this._getAudioCtx();
    const audioBuf = await ctx.decodeAudioData(buf);
    // 解码是异步的：等它回来时这一项可能已经被 cancel 掉了。
    // 这时绝不能再开播 —— 否则用户点了「停止」却又听见一句。
    if (!token || token.done || token !== this._token) return;
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    this._src = src;
    this.playing = true;
    if (this.onStart) this.onStart(text);
    src.onended = () => this._finishCurrent(token);
    if (ctx.state === 'suspended') await ctx.resume();
    src.start();
  }

  /**
   * 联网 TTS（openai / fish / xiaomi）。
   *
   * 请求本身在主进程发出：这些接口都要带 API Key，而渲染层不允许持有密钥。
   * 这里只把「要读什么、用哪家」送上去，拿回音频字节再解码播放。
   */
  async _speakRemote(text, settings, token) {
    const provider = (settings.tts && settings.tts.provider) || 'openai';
    const bytes = await window.api.ttsFetchAudio({ provider, text });
    if (!bytes) throw new Error('TTS 没有返回音频数据');
    let buf = bytes;
    if (!(buf instanceof ArrayBuffer)) {
      if (buf.buffer instanceof ArrayBuffer) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      else buf = new Uint8Array(buf).buffer;
    }
    await this._playBytes(buf, text, token);
  }

  // openai / fish / xiaomi 的请求体都在主进程构造（见 shared/ai-ipc.cjs）——
  // 那些接口都要带 API Key，渲染层不允许持有，所以这里只保留 web（系统语音）这一条本地通路。
}
