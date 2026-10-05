'use strict';
// ============================================================
// 所有 Renderer → Main 通道的参数校验规则（一处集中，便于审查）
//
// 每个通道一行：CHANNELS['通道名'] = v.args(参数1的规则, 参数2的规则...)
// 没登记规则的通道会被 validatedHandle 拦下来并报错 ——
// 「新加了 IPC 忘了写校验」必须是**显式失败**，而不是默认放行。
// ============================================================
const v = require('./ipc-validate.cjs');
const { KEY_WHITELIST } = require('./desktop-input.cjs');

/** 按键名：必须落在 desktop-input 的白名单里（防按键注入） */
const KEY = v.oneOf(KEY_WHITELIST);

const SETTINGS = v.object({}, { allowUnknown: true });   // 设置很宽，逐字段归一化在 normalizeSettings 里做
const OVERLAY_RECT = v.object({
  x: v.num({ dflt: 0 }),
  y: v.num({ dflt: 0 }),
  width: v.num({ min: 1, max: 20000, dflt: 1 }),
  height: v.num({ min: 1, max: 20000, dflt: 1 }),
}, { allowUnknown: false });

const CHANNELS = {
  // ---- 应用与信息 ----
  'app:info': v.NO_ARGS,

  // ---- 模型 ----
  'models:list': v.NO_ARGS,
  'models:addFolder': v.NO_ARGS,
  'models:addUrl': v.args(v.object({ url: v.url(), name: v.optional(v.str({ max: 120 })) })),
  'models:removeUrl': v.args(v.url()),
  // 注意 dir **不**用 fileName：这里刻意放行 ".."、分隔符、绝对路径，
  // 好让主进程自己的「只允许 models/ 下一层真实目录」那道闸门去拒绝它们，
  // 并且把拒绝行为留在可测试的业务逻辑里（CI 有专门的越界断言）。
  'models:delete': v.args(v.object({
    dir: v.str({ max: 200, allowEmpty: false }),
    name: v.optional(v.str({ max: 200 })),
  })),

  // ---- 屏幕 ----
  'screen:capture': v.NO_ARGS,

  // ---- 角色卡 ----
  'characters:list': v.NO_ARGS,
  'characters:write': v.args(v.object({
    file: v.optional(v.fileName({ max: 128 })),
    data: v.object({}, { allowUnknown: true }),
    mode: v.optional(v.oneOf(['create', 'update'])),
  })),
  'characters:delete': v.args(v.fileName({ max: 128 })),
  'characters:chooseAvatar': v.NO_ARGS,
  'characters:export': v.args(v.object({}, { allowUnknown: true })),
  'characters:import': v.NO_ARGS,

  // ---- 设置 ----
  'settings:get': v.NO_ARGS,
  'settings:set': v.args(SETTINGS),

  // ---- 文件系统（白名单目录）----
  'shell:openPath': v.args(v.absPath({ max: 1000 })),

  // ---- 聊天记录 ----
  'chat:read': v.args(v.fileName({ max: 128 })),
  'chat:write': v.args(v.object({
    file: v.fileName({ max: 128 }),
    messages: v.arr(v.message(), { max: 5000 }),
  })),
  'chat:clear': v.args(v.fileName({ max: 128 })),

  // ---- 悬浮展台 ----
  'overlay:status': v.NO_ARGS,
  'overlay:toggle': v.NO_ARGS,
  'overlay:hide': v.NO_ARGS,
  'overlay:hitArea': v.args(v.optional(OVERLAY_RECT)),
  'overlay:setIgnore': v.args(v.bool()),
  'overlay:interactive': v.args(v.bool()),
  'overlay:setModel': v.args(v.optional(v.str({ max: 1000, allowEmpty: true }))),
  'overlay:getState': v.NO_ARGS,
  'overlay:resize': v.args(v.object({
    dw: v.optional(v.num({ min: -2000, max: 2000 })),
    dh: v.optional(v.num({ min: -2000, max: 2000 })),
  }, { allowUnknown: true })),
  'overlay:reset': v.NO_ARGS,
  'overlay:dragStart': v.NO_ARGS,
  'overlay:dragMove': v.NO_ARGS,
  'overlay:dragEnd': v.NO_ARGS,

  // ---- Minecraft ----
  'mc:connect': v.args(v.object({
    host: v.str({ max: 200, allowEmpty: true }),
    port: v.dimension({ min: 1, max: 65535 }),
    username: v.str({ max: 32, allowEmpty: true }),
    auth: v.optional(v.oneOf(['offline', 'microsoft'])),
  }, { allowUnknown: true })),
  'mc:disconnect': v.NO_ARGS,
  'mc:status': v.NO_ARGS,
  'mc:say': v.args(v.str({ max: 500, allowEmpty: true })),
  'mc:follow': v.args(v.str({ max: 32, allowEmpty: true })),
  'mc:stopFollow': v.NO_ARGS,
  'mc:step': v.args(v.object({
    dir: v.oneOf(['forward', 'back', 'left', 'right']),
    ms: v.optional(v.num({ min: 0, max: 60000 })),
  }), v.optional(v.num({ min: 0, max: 60000 }))),
  'mc:jump': v.NO_ARGS,

  // ---- AI 网络请求（都由主进程发出）----
  'llm:stream': v.args(v.object({
    requestId: v.str({ max: 128, allowEmpty: false }),
    messages: v.arr(v.message(), { max: 500 }),
    tools: v.optional(v.arr(v.any(), { max: 64 })),
    llm: v.optional(v.object({
      baseUrl: v.optional(v.url()),
      model: v.optional(v.str({ max: 200 })),
      temperature: v.optional(v.num({ min: 0, max: 2 })),
      maxTokens: v.optional(v.num({ min: 1, max: 200000 })),
    }, { allowUnknown: true })),
  }, { allowUnknown: true })),
  'llm:abort': v.args(v.str({ max: 128, allowEmpty: false })),
  'llm:listModels': v.args(v.object({
    baseUrl: v.optional(v.url()),
    apiKey: v.optional(v.str({ max: 4000 })),
  }, { allowUnknown: true })),
  'llm:test': v.args(v.object({
    baseUrl: v.optional(v.url()),
    apiKey: v.optional(v.str({ max: 4000 })),
  }, { allowUnknown: true })),
  'tts:fetchAudio': v.args(v.object({
    text: v.str({ max: 5000, allowEmpty: false }),
    provider: v.optional(v.oneOf(['web', 'openai', 'fish', 'xiaomi'])),
  }, { allowUnknown: true })),
  'tts:listVoices': v.args(v.object({ apiKey: v.optional(v.str({ max: 4000 })) }, { allowUnknown: true })),
  'stt:transcribe': v.args(v.object({
    provider: v.optional(v.oneOf(['openai', 'xiaomi', 'web'])),
    format: v.optional(v.oneOf(['wav', 'webm'])),
    dataBase64: v.str({ max: 40 * 1024 * 1024, allowEmpty: false }),
    language: v.optional(v.oneOf(['auto', 'zh', 'en', 'ja', 'es'])),
    model: v.optional(v.str({ max: 200 })),
  }, { allowUnknown: true })),
  'stt:listModels': v.args(v.object({
    baseUrl: v.optional(v.url()),
    apiKey: v.optional(v.str({ max: 4000 })),
  }, { allowUnknown: true })),

  // ---- 嵌入模型（记忆 / 知识库的语义检索，与对话用的 Key 分开）----
  'embedding:listModels': v.args(v.object({
    baseUrl: v.optional(v.url()),
    apiKey: v.optional(v.str({ max: 4000 })),
  }, { allowUnknown: true })),
  'embedding:test': v.args(v.object({
    baseUrl: v.optional(v.url()),
    apiKey: v.optional(v.str({ max: 4000 })),
    model: v.optional(v.str({ max: 200 })),
  }, { allowUnknown: true })),
  // 渲染层只送文本、拿回向量；Key 在主进程那一侧
  'embedding:embed': v.args(v.object({
    texts: v.arr(v.str({ max: 8000 }), { max: 64 }),
    baseUrl: v.optional(v.url()),
    apiKey: v.optional(v.str({ max: 4000 })),
    model: v.optional(v.str({ max: 200 })),
  }, { allowUnknown: true })),

  // ---- 记忆库 / 知识库的存储通道（目录受限）----
  'store:roots': v.NO_ARGS,
  'store:fs': v.args(v.object({
    op: v.oneOf(['readText', 'readBytes', 'writeText', 'exists', 'mkdir', 'list', 'remove', 'rename', 'stat']),
    root: v.oneOf(['memory', 'knowledge']),
    path: v.str({ max: 500, allowEmpty: false }),
    text: v.optional(v.str({ max: 32 * 1024 * 1024 })),
    to: v.optional(v.str({ max: 500, allowEmpty: false })),
  }, { allowUnknown: true })),

  // ---- Agent（电脑控制 / 编码）----
  'agent:workspace': v.NO_ARGS,
  'agent:cursor': v.NO_ARGS,
  'agent:fs': v.args(v.object({
    op: v.oneOf(['list', 'read', 'write', 'stat']),
    path: v.str({ max: 1000, allowEmpty: true }),
    text: v.optional(v.str({ max: 8 * 1024 * 1024 })),
  }, { allowUnknown: true })),
  'agent:exec': v.args(v.object({
    command: v.commandName(),
    args: v.optional(v.arr(v.str({ max: 2000 }), { max: 200 })),
    timeoutMs: v.optional(v.num({ min: 1000, max: 600000 })),
  }, { allowUnknown: true })),
  'agent:git': v.args(v.object({
    args: v.arr(v.str({ max: 500 }), { max: 50 }),
    timeoutMs: v.optional(v.num({ min: 1000, max: 600000 })),
  }, { allowUnknown: true })),
  'agent:screenshot': v.args(v.object({ withData: v.optional(v.bool()) }, { allowUnknown: true })),
  'agent:window': v.args(v.object({
    op: v.oneOf(['list', 'focus']),
    title: v.optional(v.str({ max: 300 })),
  }, { allowUnknown: true })),
  'agent:open': v.args(v.object({
    target: v.str({ max: 500, allowEmpty: false }),
    isUrl: v.optional(v.bool()),
  }, { allowUnknown: true })),
  'agent:input': v.args(v.object({
    op: v.oneOf(['mouseMove', 'mouseClick', 'keyboardType', 'keyboardPress']),
    x: v.optional(v.num({ min: -20000, max: 20000 })),
    y: v.optional(v.num({ min: -20000, max: 20000 })),
    button: v.optional(v.oneOf(['left', 'right', 'middle'])),
    double: v.optional(v.bool()),
    text: v.optional(v.str({ max: 4000 })),
    keys: v.optional(v.arr(KEY, { max: 8 })),
  }, { allowUnknown: true })),
};

/**
 * 造一个「带校验的 handle」。
 * @param {Function} baseHandle 已经做了发送方鉴权的 handle
 * @param {(channel:string)=>void} [onError] 校验失败时的日志钩子
 */
function makeValidatedHandle(baseHandle, onError) {
  return function validatedHandle(channel, fn) {
    const schema = CHANNELS[channel];
    if (!schema) {
      // 没登记 = 新加的 IPC 忘了写校验。显式失败，别默认放行。
      throw new Error('IPC 通道未登记参数校验规则：' + channel);
    }
    return baseHandle(channel, (event, ...args) => {
      let clean;
      try {
        clean = schema.parse(args, channel);
      } catch (err) {
        if (typeof onError === 'function') onError(err, channel);
        throw err;
      }
      return fn(event, ...clean);
    });
  };
}

module.exports = { CHANNELS, makeValidatedHandle };
