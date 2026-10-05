import { describe, it, expect, beforeEach } from 'vitest';
import { TTS } from '../../src/lib/tts.js';

// 用一个假的 speechSynthesis 驱动 web TTS，专门盯「同一个 item 只能完成一次」。
// 真实的双重推进会出现在：onend 与 onerror 都触发、或者用户点停止时
// speechSynthesis.cancel() 同步抛出 onend、而我们自己又调了一次 _finish()。
let spoken = [];
let cancelCount = 0;

class FakeUtterance {
  constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
}

function installFakeSpeech() {
  spoken = [];
  cancelCount = 0;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  globalThis.window = {
    speechSynthesis: {
      speak(u) { spoken.push(u); if (u.onstart) u.onstart(); },
      cancel() {
        cancelCount += 1;
        // 真实环境里 cancel 会触发正在朗读那条的 onend —— 这正是旧代码双推进的现场
        spoken.forEach((u) => { if (u.onend) u.onend(); });
      },
      getVoices() { return [{ name: 'Test', lang: 'zh-CN' }]; },
    },
  };
}

const settings = () => ({ tts: { provider: 'web', voice: '', language: 'zh', rate: 1 } });

describe('TTS 队列 · 同一个 item 只能完成一次', () => {
  beforeEach(installFakeSpeech);

  it('onend 来两次也只推进一次', () => {
    const engine = new TTS();
    let ends = 0;
    engine.onEnd = () => { ends += 1; };
    engine.enqueue('a', settings());
    engine.enqueue('b', settings());
    expect(spoken).toHaveLength(1);

    const first = spoken[0];
    first.onend();
    expect(spoken).toHaveLength(2);          // 正常推进到第二条
    first.onend();                           // 迟到的重复回调
    expect(spoken).toHaveLength(2);          // 不该再推进
    expect(ends).toBe(0);

    spoken[1].onend();
    expect(ends).toBe(1);                    // 队列空了只报一次结束
    spoken[1].onend();
    expect(ends).toBe(1);
  });

  it('onend 与 onerror 都触发也只算一次', () => {
    const engine = new TTS();
    let ends = 0;
    engine.onEnd = () => { ends += 1; };
    engine.enqueue('a', settings());
    engine.enqueue('b', settings());
    spoken[0].onend();
    spoken[0].onerror();
    expect(spoken).toHaveLength(2);
    spoken[1].onend();
    expect(ends).toBe(1);
  });

  it('cancel 与它同步触发的 onend 不会双重推进，也不会把后续消息偷偷播出来', () => {
    const engine = new TTS();
    let ends = 0;
    engine.onEnd = () => { ends += 1; };
    engine.enqueue('a', settings());
    engine.enqueue('b', settings());
    expect(spoken).toHaveLength(1);

    engine.cancel();
    expect(cancelCount).toBe(1);
    expect(engine.queue).toHaveLength(0);
    expect(engine.playing).toBe(false);
    expect(spoken).toHaveLength(1);          // 第二条没有被播出来
    expect(ends).toBe(1);                    // 只报一次结束（旧实现会报两次）

    spoken[0].onend();                       // 迟到的回调
    expect(ends).toBe(1);
    expect(spoken).toHaveLength(1);
  });

  it('cancel 之后新入队的消息不会被旧回调吃掉', () => {
    const engine = new TTS();
    engine.enqueue('a', settings());
    engine.cancel();
    engine.enqueue('c', settings());
    expect(spoken).toHaveLength(2);
    expect(spoken[1].text).toBe('c');
    spoken[1].onend();
    expect(engine.idle).toBe(true);
  });

  it('空文本不入队', () => {
    const engine = new TTS();
    engine.enqueue('   ', settings());
    expect(spoken).toHaveLength(0);
    expect(engine.idle).toBe(true);
  });
});
