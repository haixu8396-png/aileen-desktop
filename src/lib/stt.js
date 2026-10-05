// STT 模块：openai（Whisper 兼容 /audio/transcriptions）/ xiaomi（小米 MiMo ASR，chat/completions + input_audio）/ web（浏览器识别）
// 小米仅支持 wav/mp3，因此为其使用 WAV（PCM16）录音器
const WEB_LANGS = { auto: 'zh-CN', zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', es: 'es-ES' };



function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// 将 Int16 PCM 分块编码为 WAV Blob
function encodeWav(chunks, sampleRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, total * 2, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) { view.setInt16(off, c[i], true); off += 2; }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class STT {
  constructor() {
    this.recognizing = false;
    this._mediaRecorder = null;
    this._stream = null;
    this._chunks = [];
    this._webRec = null;
    // WAV 录音器状态
    this._wavCtx = null;
    this._wavSource = null;
    this._wavProcessor = null;
    this._wavChunks = [];
    this._wavSampleRate = 16000;
    this._wavStopping = false;
    this._wavActive = false;
    this._settings = null;
    this.onResult = null; // (text) => void
    this.onError = null;  // (err) => void
    this.onState = null;  // (bool) => void
  }

  async start(settings) {
    if (this.recognizing) return;
    const provider = settings.stt.provider || 'openai';
    this._settings = settings;
    try {
      if (provider === 'web') {
        this._startWeb(settings);
      } else {
        await this._startRecord(settings);
      }
      this.recognizing = true;
      if (this.onState) this.onState(true);
    } catch (err) {
      if (this.onError) this.onError(err);
    }
  }

  stop() {
    if (this._wavActive) {
      this._finishWav().then(() => { /* transcribe 在内部完成 */ });
    } else if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      this._mediaRecorder.stop();
    }
    if (this._webRec) {
      try { this._webRec.stop(); } catch { /* ignore */ }
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
  }

  _setIdle() {
    this.recognizing = false;
    this._mediaRecorder = null;
    this._webRec = null;
    if (this.onState) this.onState(false);
  }

  // ---------- web（浏览器识别）----------
  _startWeb(settings) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('当前环境不支持浏览器语音识别');
    const rec = new SR();
    this._webRec = rec;
    rec.lang = WEB_LANGS[settings.stt.language] || 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript;
      if (text && this.onResult) this.onResult(text);
      this._setIdle();
    };
    rec.onerror = (e) => {
      if (this.onError) this.onError(new Error('语音识别失败: ' + (e.error || 'unknown')));
      this._setIdle();
    };
    rec.onend = () => this._setIdle();
    rec.start();
  }

  // ---------- 录音（openai 用 MediaRecorder webm，xiaomi 用 WAV）----------
  async _startRecord(settings) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前环境不支持录音');
    }
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (settings.stt.provider === 'xiaomi') {
      this._startWavRecorder();
    } else {
      this._startMediaRecorder();
    }
  }

  _startMediaRecorder() {
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    this._chunks = [];
    const rec = new MediaRecorder(this._stream, mime ? { mimeType: mime } : undefined);
    this._mediaRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) this._chunks.push(e.data); };
    rec.onstop = async () => {
      try {
        const blob = new Blob(this._chunks, { type: mime || 'audio/webm' });
        if (blob.size === 0) throw new Error('未捕获到声音');
        const text = await this._transcribe(blob, 'webm', this._settings);
        if (text && this.onResult) this.onResult(text);
      } catch (err) {
        if (this.onError) this.onError(err);
      } finally {
        this._setIdle();
      }
    };
    rec.start();
  }

  _startWavRecorder() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._wavCtx = new Ctx();
    this._wavSampleRate = this._wavCtx.sampleRate || 16000;
    this._wavChunks = [];
    this._wavStopping = false;
    this._wavSource = this._wavCtx.createMediaStreamSource(this._stream);
    const proc = this._wavCtx.createScriptProcessor(4096, 1, 1);
    this._wavProcessor = proc;
    const gain = this._wavCtx.createGain();
    gain.gain.value = 0; // 静音，避免回声
    proc.onaudioprocess = (e) => {
      if (this._wavStopping) return;
      const input = e.inputBuffer.getChannelData(0);
      const buf = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this._wavChunks.push(buf);
    };
    this._wavSource.connect(proc);
    proc.connect(gain);
    gain.connect(this._wavCtx.destination);
    this._wavActive = true;
  }

  async _finishWav() {
    this._wavStopping = true;
    this._wavActive = false;
    await new Promise((r) => setTimeout(r, 80)); // 等待最后一帧
    try { this._wavProcessor.disconnect(); } catch { /* ignore */ }
    try { this._wavSource.disconnect(); } catch { /* ignore */ }
    try { this._wavCtx.close(); } catch { /* ignore */ }
    this._wavCtx = null;
    try {
      const blob = encodeWav(this._wavChunks, this._wavSampleRate);
      if (blob.size <= 44) throw new Error('未捕获到声音');
      const text = await this._transcribe(blob, 'wav', this._settings);
      if (text && this.onResult) this.onResult(text);
    } catch (err) {
      if (this.onError) this.onError(err);
    } finally {
      this._setIdle();
    }
  }

  // ---------- 识别请求 ----------
  //
  // 录音留在渲染层（要用麦克风与 AudioContext），但**发请求在主进程**：
  // STT 接口要带 API Key，渲染层不允许持有。这里只把音频字节送上去，拿回文本。
  // 语言码映射也一并搬到主进程（shared/ai-langs.cjs），那边有单测盯着
  // 「不能把日语/西语当成英语」这件事。
  async _transcribe(blob, format, settings) {
    const stt = settings.stt || {};
    const dataBase64 = await blobToBase64(blob);
    if (!dataBase64) throw new Error('未捕获到声音');
    const res = await window.api.sttTranscribe({
      provider: stt.provider,
      format,
      dataBase64,
      language: stt.language,
      model: stt.model,
    });
    return (res && res.text) || '';
  }
}
