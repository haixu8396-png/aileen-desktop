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
// 字段名必须和**渲染层真正发的**一致：src/overlay.js 发的是 { x, y, w, h }
// （主进程处理器读的也是 w/h）。曾经这里写成 width/height，于是每一条热区上报都被
// 参数校验拒掉 —— 热区永远为 null，展台就不再鼠标穿透，直接挡住整个桌面。
const OVERLAY_RECT = v.object({
  x: v.num({ min: -20000, max: 20000, dflt: 0 }),
  y: v.num({ min: -20000, max: 20000, dflt: 0 }),
  w: v.num({ min: 0, max: 20000, dflt: 0 }),
  h: v.num({ min: 0, max: 20000, dflt: 0 }),
}, { allowUnknown: false });

const CHANNELS = {
  // ---- 应用与信息 ----
  'app:info': v.NO_ARGS,
  // 复制到剪贴板（渲染层 clipboard API 在 file:// 下会失败）
  'clipboard:write': v.args(v.str({ max: 2 * 1024 * 1024, allowEmpty: true })),
  // 自绘标题栏：主题切换时同步系统按钮区的颜色（只对 Windows 生效）
  'window:chrome': v.args(v.object({
    color: v.hexColor(),
    symbolColor: v.hexColor(),
  }, { allowUnknown: false })),

  // ---- 模型 ----
  'models:list': v.NO_ARGS,
  'models:addFolder': v.NO_ARGS,
  // 从 zip 直接导入模型：没有参数（文件路径由主进程的对话框给出）
  'models:importZip': v.NO_ARGS,
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
  // 渲染层实际传的是 { url, name, key }（stage.js 的 syncOverlayModel）；
  // 之前这里写成「一个字符串」，只是那条通道当时没走校验，一改校验就会把模型同步整个打死。
  'overlay:setModel': v.args(v.optional(v.object({
    url: v.optional(v.str({ max: 1000, allowEmpty: true })),
    name: v.optional(v.str({ max: 200, allowEmpty: true })),
    key: v.optional(v.str({ max: 500, allowEmpty: true })),
  }))),
  // Live2D 热键/部件状态的落盘（localStorage 在 file:// 下不保证落盘，改走设置文件）
  // 展台「上次用多大」：打开时按它恢复，不再自动重新适配
  'live2d:getLayout': v.args(v.object({
    modelKey: v.str({ max: 300 }),
  })),
  'live2d:setLayout': v.args(v.object({
    modelKey: v.str({ max: 300 }),
    scale: v.num({ min: 0.000001, max: 64 }),
    fx: v.num({ min: -1, max: 2 }),
    fy: v.num({ min: -1, max: 2 }),
    drawn: v.optional(v.arr(v.num({ min: 0, max: 100000 }), { max: 2 })),
  })),
  'live2d:getState': v.args(v.object({
    modelKey: v.str({ max: 300 }),
  })),
  'live2d:setState': v.args(v.object({
    modelKey: v.str({ max: 300 }),
    activeExpressions: v.optional(v.arr(v.str({ max: 200 }), { max: 400 })),
    hiddenParts: v.optional(v.arr(v.str({ max: 200 }), { max: 400 })),
  })),
  'overlay:getState': v.NO_ARGS,
  'overlay:resize': v.args(v.object({
    dw: v.optional(v.num({ min: -2000, max: 2000 })),
    dh: v.optional(v.num({ min: -2000, max: 2000 })),
  }, { allowUnknown: true })),
  // 拖右下角把手改大小：给绝对宽高，主进程照样过 clampOverlaySize
  'overlay:resizeTo': v.args(v.object({
    width: v.num({ min: 100, max: 4000 }),
    height: v.num({ min: 100, max: 4000 }),
  })),
  'overlay:reset': v.NO_ARGS,
  // 设置里的「展台大小」：绝对宽高（主进程还会再钳一次）
  'overlay:setSize': v.args(v.object({
    width: v.num({ min: 1, max: 20000 }),
    height: v.num({ min: 1, max: 20000 }),
  })),
  'overlay:dragStart': v.NO_ARGS,
  'overlay:dragMove': v.NO_ARGS,
  'overlay:dragEnd': v.NO_ARGS,
  // 展台工具条面板的模型微调倍率（落盘 live2d.zoom）
  'overlay:setZoom': v.args(v.object({
    zoom: v.num({ min: 0.4, max: 1.25 }),
  })),
  // 主窗口 → 展台：TTS 音量包络（0..1）
  'overlay:mouth': v.args(v.object({
    level: v.num({ min: 0, max: 1 }),
  })),
  // ---- 双窗口会话同步（0.8）----
  // 主窗口 → 主进程 → 展台：消息 / 状态 / 角色切换的**只读广播**
  'overlay:session': v.args(v.object({
    // motion / expression / scale：主窗口 → 展台的演出控制（模型在展台那边加载）
    type: v.oneOf(['messages', 'status', 'character', 'models', 'motion', 'expression', 'scale']),
    // 消息只允许 role + 纯文本（不带任何 HTML 片段，展台侧自己转义）
    messages: v.optional(v.arr(v.object({
      role: v.oneOf(['user', 'assistant']),
      text: v.str({ max: 4000 }),
    }, { allowUnknown: false }), { max: 20 })),
    status: v.optional(v.object({}, { allowUnknown: true })),
    character: v.optional(v.object({ name: v.optional(v.str({ max: 200 })) }, { allowUnknown: true })),
    models: v.optional(v.arr(v.object({ name: v.str({ max: 200 }) }, { allowUnknown: true }), { max: 100 })),
    name: v.optional(v.str({ max: 200, allowEmpty: true })),
    value: v.optional(v.num({ min: 0, max: 10 })),
  }, { allowUnknown: false })),
  // 展台 → 主进程 → 主窗口：用户在小面板里的操作请求
  'overlay:request': v.args(v.object({
    type: v.oneOf(['sync', 'chat', 'voice', 'model', 'motion', 'expression', 'openMain']),
    text: v.optional(v.str({ max: 4000, allowEmpty: true })),
    name: v.optional(v.str({ max: 200, allowEmpty: true })),
    index: v.optional(v.num({ min: 0, max: 999 })),
  }, { allowUnknown: false })),
  'overlay:openMain': v.NO_ARGS,
  // Agent 检查点（断点续跑）：只允许 save / load / clear 三种操作。
  // 内容按「不透明 JSON」处理 —— 结构校验在 src/main/storage/checkpoint-store.cjs 与
  // src/agent/state.js 里（那边才知道 checkpoint 的字段），这里只挡住类型与体积。
  'agent:checkpoint': v.args(v.object({
    op: v.oneOf(['save', 'load', 'clear']),
    data: v.optional(v.any()),
  }, { allowUnknown: false })),

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

  // ---- Agent（电脑控制 / 编码）----  'agent:workspace': v.NO_ARGS,
  // 让用户挑一个工作目录：没有参数，返回 { workspace } 或 null
  'agent:chooseWorkspace': v.NO_ARGS,
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
