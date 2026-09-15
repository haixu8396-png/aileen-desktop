// TTS 模块：web（系统语音）/ openai（OpenAI 兼容 /audio/speech）/ fish（Fish Audio /v1/tts）/ xiaomi（小米 MiMo chat/completions）
// 支持顺序播放队列、取消、语言选择（zh/en/ja/es）
const LANG_CODES = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', es: 'es-ES' };

export class TTS {
  constructor() {
    this.queue = [];
    this.playing = false;
    this._provider = null;
    this._src = null;
    this._abort = null;
    this._audioCtx = null;
    this.onStart = null; // (text) => void
    this.onEnd = null;   // () => void
    this.onError = null; // (err) => void
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
    if (!this.playing) return;
    if (this._provider === 'web') {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      this._finish();
    } else {
      try { if (this._src) this._src.stop(); } catch { /* ignore */ }
      if (this._abort) { try { this._abort.abort(); } catch { /* ignore */ } }
      this._finish();
    }
  }

  async _next() {
    if (this.queue.length === 0) {
      this.playing = false;
      if (this.onEnd) this.onEnd();
      return;
    }
    const item = this.queue.shift();
    this._provider = item.settings.tts.provider || 'web';
    try {
      if (this._provider === 'openai') {
        await this._speakOpenai(item.text, item.settings);
      } else if (this._provider === 'fish') {
        await this._speakFish(item.text, item.settings);
      } else if (this._provider === 'xiaomi') {
        await this._speakXiaomi(item.text, item.settings);
      } else {
        this._speakWeb(item.text, item.settings);
      }
    } catch (err) {
      if (this.onError) this.onError(err);
      this._next();
    }
  }

  _finish() {
    this._src = null;
    this._abort = null;
    this.playing = false;
    this._next();
  }

  // ---------- 系统语音 ----------
  _speakWeb(text, settings) {
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
      this.playing = true;
      if (this.onStart) this.onStart(text);
    };
    u.onend = () => this._finish();
    u.onerror = () => this._finish();
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

  async _playBytes(buf, text, onEnd) {
    const ctx = this._getAudioCtx();
    const audioBuf = await ctx.decodeAudioData(buf);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    this._src = src;
    this.playing = true;
    if (this.onStart) this.onStart(text);
    src.onended = () => { if (onEnd) onEnd(); };
    if (ctx.state === 'suspended') await ctx.resume();
    src.start();
  }

  _bearer(key) {
    return { Authorization: 'Bearer ' + key };
  }

  async _fetchAudio(url, opts, text) {
    const controller = new AbortController();
    this._abort = controller;
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new Error('TTS HTTP ' + res.status + ' ' + detail.slice(0, 200));
    }
    const buf = await res.arrayBuffer();
    await this._playBytes(buf, text, () => this._finish());
  }

  // ---------- OpenAI 兼容 /audio/speech ----------
  async _speakOpenai(text, settings) {
    const { baseUrl, apiKey, model, voice, rate } = settings.tts;
    if (!apiKey) throw new Error('TTS（OpenAI 兼容）未配置 API Key');
    const url = (baseUrl || '').replace(/\/+$/, '') + '/audio/speech';
    await this._fetchAudio(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._bearer(apiKey) },
      body: JSON.stringify({
        model: model || 'tts-1',
        voice: voice || 'alloy',
        input: text,
        response_format: 'mp3',
        speed: Math.min(4, Math.max(0.25, Number(rate) || 1)),
      }),
    }, text);
  }

  // ---------- Fish Audio（https://api.fish.audio/v1/tts）----------
  async _speakFish(text, settings) {
    const { apiKey, voice, model, rate } = settings.tts;
    if (!apiKey) throw new Error('TTS（Fish Audio）未配置 API Key');
    const body = { text, format: 'mp3', latency: 'normal' };
    if (voice) body.reference_id = voice;
    body.prosody = { speed: Math.min(2, Math.max(0.5, Number(rate) || 1)) };
    const headers = { 'Content-Type': 'application/json', ...this._bearer(apiKey) };
    // model 可选用 header 指定（s1 / s2-pro 等），留空则用平台默认
    if (model && model !== 'tts-1') headers['model'] = model;
    await this._fetchAudio('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, text);
  }

  // ---------- 小米 MiMo（chat/completions 返回 base64 音频）----------
  async _speakXiaomi(text, settings) {
    const { apiKey, model, voice } = settings.tts;
    if (!apiKey) throw new Error('TTS（小米 MiMo）未配置 API Key');
    const controller = new AbortController();
    this._abort = controller;
    const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._bearer(apiKey) },
      body: JSON.stringify({
        model: model && model !== 'tts-1' ? model : 'mimo-v2.5-tts',
        messages: [
          { role: 'user', content: '请用自然、富有感情的语气朗读以下内容。' },
          { role: 'assistant', content: text },
        ],
        audio: { format: 'mp3', voice: voice || 'mimo_default' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new Error('小米 TTS HTTP ' + res.status + ' ' + detail.slice(0, 200));
    }
    const j = await res.json();
    const audioData =
      (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.audio && j.choices[0].message.audio.data) ||
      (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.audio && j.choices[0].message.audio.base64);
    if (!audioData) throw new Error('小米 TTS 响应中未找到音频数据');
    const bin = atob(audioData);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await this._playBytes(bytes.buffer, text, () => this._finish());
  }
}
