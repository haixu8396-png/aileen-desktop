// ============================================================
// 流式标记解析器
//
// 模型一边吐字，我们一边把输出拆成两类：
//   · 看得见的正文
//   · 控制标记（不动声色地从正文里摘掉）
//
// 标记有两种写法，解析器都要认：
//   <|motion:Tap|>              规范写法
//   <{'|'}motion:Tap{'|'}>      线上写法（推荐让模型用这个）
//
// 为什么推荐线上写法：<| 在很多分词器里是保留的特殊 token（<|endoftext|>、
// <|im_start|> 之类）。模型直接吐裸的 <|，有可能被分词器或对话模板截断吞掉。
// 把 | 包进 {'|'} 之后，token 流里不出现裸的 <|，就撞不上特殊 token。
//
// 两个关键实现点：
//
// 1) 扫描认两种写法，但「吐出去的是缓冲区原文」。
//    早期版本先 replaceAll 把线上写法改写成规范写法再解析，结果是：
//    一旦标记没闭合（模型写错），用户看到的就是被改写过的 <|motion，
//    而不是模型原本写的 <{'|'}motion。所以这里不做破坏性归一化。
//
// 2) 必须留回退尾巴，并让 inTag 状态跨 chunk 保持。
//    标记可能被切在两个 chunk 中间：chunk1 = '好的<|mo'，chunk2 = 'tion:Tap|>'。
//    见到 < 就当正文吐出去的话，这里会漏出一个 '<|mo'。
// ============================================================

const OPEN = '<|';
const CLOSE = '|>';
const WIRE_OPEN = "<{'|'}";
const WIRE_CLOSE = "{'|'}>";

// 回退尾巴：够容纳任一写法还没拼完的前缀
const HOLD_BACK = Math.max(OPEN.length, CLOSE.length, WIRE_OPEN.length, WIRE_CLOSE.length) - 1;

/** 找出缓冲区里最靠前的开标记，返回 { index, wire } 或 null */
function findOpen(s) {
  const a = s.indexOf(OPEN);
  const b = s.indexOf(WIRE_OPEN);
  if (a < 0 && b < 0) return null;
  if (a < 0) return { index: b, wire: true };
  if (b < 0 || a < b) return { index: a, wire: false };
  return { index: b, wire: true };
}

/**
 * 解析标记内容。两种写法、两种分隔都认：
 *   motion:Tap / motion Tap / expr:Happy / 单独的 act
 */
function parseMarker(raw) {
  const wire = raw.startsWith(WIRE_OPEN) && raw.endsWith(WIRE_CLOSE);
  const body = (wire
    ? raw.slice(WIRE_OPEN.length, raw.length - WIRE_CLOSE.length)
    : raw.slice(OPEN.length, raw.length - CLOSE.length)).trim();
  const m = /^([A-Za-z_][\w-]*)\s*(?::|\s)\s*([\s\S]*)$/.exec(body);
  if (!m) return { kind: body.toLowerCase(), value: '', raw };
  return { kind: m[1].toLowerCase(), value: m[2].trim(), raw };
}

/**
 * @param {{ onText?: (s: string) => void, onMarker?: (m: {kind:string,value:string,raw:string}) => void }} handlers
 */
export function createMarkerParser(handlers = {}) {
  const onText = typeof handlers.onText === 'function' ? handlers.onText : () => {};
  const onMarker = typeof handlers.onMarker === 'function' ? handlers.onMarker : () => {};
  let buf = '';
  let inTag = false;
  let closeTok = CLOSE;
  let done = false;

  function drain(final) {
    for (;;) {
      if (inTag) {
        const close = buf.indexOf(closeTok);
        if (close < 0) return;
        const raw = buf.slice(0, close + closeTok.length);
        buf = buf.slice(close + closeTok.length);
        inTag = false;
        onMarker(parseMarker(raw));
        continue;
      }
      const found = findOpen(buf);
      if (!found) {
        const keep = final ? 0 : HOLD_BACK;
        if (buf.length > keep) {
          onText(buf.slice(0, buf.length - keep));
          buf = buf.slice(buf.length - keep);
        }
        return;
      }
      if (found.index > 0) {
        onText(buf.slice(0, found.index));
        buf = buf.slice(found.index);
      }
      closeTok = found.wire ? WIRE_CLOSE : CLOSE;
      inTag = true;
    }
  }

  return {
    push(chunk) {
      if (done) return;
      const s = String(chunk == null ? '' : chunk);
      if (!s) return;
      buf += s;
      drain(false);
    },
    end() {
      if (done) return;
      done = true;
      // 收尾：没闭合的标记按原样当正文吐出来。
      // 宁可多显示一个残缺标记（且保持模型原本的写法），也不能吞掉角色的话。
      drain(true);
      if (buf) { onText(buf); buf = ''; }
      inTag = false;
    },
  };
}

/** 从一整段文本里摘掉所有标记（落库、复制、朗读都用清洗后的文本） */
export function stripMarkers(text) {
  let out = '';
  const p = createMarkerParser({ onText: (s) => { out += s; } });
  p.push(String(text == null ? '' : text));
  p.end();
  return out;
}

/** 收集一段文本里的所有标记（用于离线分析/测试） */
export function collectMarkers(text) {
  const list = [];
  const p = createMarkerParser({ onMarker: (m) => list.push(m) });
  p.push(String(text == null ? '' : text));
  p.end();
  return list;
}
