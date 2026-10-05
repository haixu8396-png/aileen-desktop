# AILEEN Desktop —— 项目上下文

> 这份文档是 AILEEN 的「记忆本体」。给未来的自己/任何接手的人看：它是什么、怎么搭的、有哪些不能碰的规矩、现在卡在哪。
> 精简版在工作区根目录 `AGENTS.md`（每个会话自动加载）；历史与待办在 `工作日志.md`。
> 最后更新：根据 2026-10-05 之前的历史会话整理。

---

## 1. 它是什么

桌面 AI 伴侣（Windows）。核心主张：**桌面上的角色不该只是一个聊天窗口** —— 它在那儿呼吸、眨眼、看着你说话，你用挑好的声音跟它对话；它还能跟着你进 Minecraft、坐到棋盘对面，或者变成一个只装得下它自己的无边框窗口待在桌面上。

- 灵感：[Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)；致敬：[moeru-ai/Airi](https://github.com/moeru-ai/airi)（README 三语都要显眼地写，这是用户点名的）
- 仓库：https://github.com/haixu8396-png/aileen-desktop（MIT）
- 当前版本：**0.6.6**
- 平台：Windows 10/11 x64，NSIS 安装包 + 免安装便携版

### 功能面

| 模块 | 说明 |
| --- | --- |
| 对话 | 多服务商（DeepSeek / OpenAI / Moonshot / 硅基流动 / Groq / 智谱 / 阿里百炼 / 小米 MiMo / OpenRouter / Ollama），流式；上下文压缩（保留最近 N 轮 + 更早压成摘要）；用户消息带时间锚点 |
| 角色卡 | 名字/头像/简介/性格/场景/开场白/示例对话/自定义系统提示词；支持「人设生成室」自动生成（原型库：10 性格 + 10 身份；已有角色模式；对话者身份；500~1000 字提示词） |
| Live2D | oh-my-live2d 0.19.3，Cubism 2/3/4；导入文件夹或贴 `model3.json` URL；模型管理（可删，删到回收站）；可选「不使用模型」 |
| 表演 | 标记协议（动作/表情/停顿）由角色自己写；括号里的动作与心理活动**可调档位**（不用/极少/自然/较多）；回复节奏可调（单条/多条拆分），不做一刀切 |
| 语音 | TTS：系统语音 / OpenAI 兼容 / Fish Audio / 小米 MiMo；STT：小米 MiMo、Groq Whisper 等；语言 zh/en/ja/es |
| 视觉 | 屏幕/窗口截图发给多模态模型（`qwen-vl-plus` / `gpt-4o` / `glm-4v` / `MiMo-VL`） |
| Minecraft | mineflayer + pathfinder，机器人进 Java 服；**复用角色卡人格**（不是另写一段提示词） |
| 国际象棋 | js-chess-engine，五档难度、悔棋、翻转、角色点评 |
| 悬浮展台 | 无边框、透明、置顶、**默认整窗鼠标穿透**；拖动只用手柄，大小只用 −/＋ |
| Coding Agent | 单 Agent + 工具循环（第一版）：工作区内读写文件、白名单命令、git、截屏；LOW/MEDIUM/HIGH 三档权限；面板可暂停/继续/取消/批准 |
| i18n | 英文 / 日文 / 简体中文，**界面 + 原生菜单**全翻；`src/lib/i18n.js` 的 `EN` 是唯一真源，`i18n.ja.json` / `i18n.zh.json` 键数必须与它完全相等 |
| 安全 | Renderer 拿不到 API Key；LLM/TTS/STT 请求走主进程；IPC 发送方鉴权；safeStorage 加密落盘；DOMPurify 消毒 |

---

## 2. 技术栈与文件结构

Electron 44 · Vite 8（rolldown）· vitest 5 · jsdom · DOMPurify · 原生 JS（**没有 TypeScript，没有前端框架**）

```
aileen/
├─ main.js                主进程：窗口/展台/IPC/原生菜单/本地模型服务器/自检
├─ preload.js             contextBridge 暴露的 API
├─ mc-bot.cjs             Minecraft 机器人
├─ shared/                主进程与测试共用（CJS）
│   ├─ util.cjs           路径工具（isInsidePath 等）
│   ├─ llm.cjs            LLM/SSE 解析核心（从渲染层搬下来）
│   ├─ ai-ipc.cjs         LLM/TTS/STT 的 IPC 处理器（Key 只在主进程）
│   ├─ secrets.cjs        API Key 脱敏 / safeStorage 加解密 / 明文迁移
│   ├─ ipc-guard.cjs      IPC 发送方鉴权（纯函数，可单测）
│   ├─ ai-langs.cjs       语音语言映射（zh/en/ja/es/auto）
│   ├─ menu-i18n.cjs      原生菜单多语言
│   └─ ipc-guard / util / util.cjs …
├─ src/                   渲染层
│   ├─ index.html         主界面（32 KB）
│   ├─ main.js            入口与事件装配
│   ├─ styles.css / overlay.css
│   ├─ overlay.html/.js   无边框悬浮展台
│   ├─ agent/             Coding Agent 核心（宿主无关，可单测）
│   │   ├─ events.js      事件契约 + 总线（不认识 Live2D）
│   │   ├─ state.js       AgentRun 模型 + 状态机（白名单迁移）
│   │   ├─ runtime.js     主循环 LLM→ToolCall→Permission→Executor→Result
│   │   ├─ run.js         一次 run 的装配
│   │   ├─ planner.js     tools 参数转换 / tool_calls 解析 / 提示词
│   │   ├─ tool-registry.js  统一工具定义与参数校验
│   │   ├─ permission.js  LOW/MEDIUM/HIGH 三档决策
│   │   ├─ executor.js    唯一碰文件/进程的地方（边界 + 命令策略）
│   │   └─ context.js     工具结果裁剪 / token 预算
│   ├─ context/           统一上下文层（分层装配 + 预算裁剪 + 人格硬校验）
│   ├─ memory/            长期记忆（抽取/存储/向量/召回/重排/合并/预算，9 模块）
│   ├─ knowledge/         知识库（来源/解析/chunk/存储/检索/重排，9 模块，零依赖解析 pdf）
│   └─ lib/               控制器：state, dom, stage, chat, characters, characters-ui,
│                         modals, voice, tts, stt, minecraft, chess, i18n, markdown,
│                         marker-parser, reply-pacer, history, hash, persona,
│                         persona-studio, archetypes, style, settings, llm(纯代理),
│                         agent-bridge, agent-ui, agent-stage, agent-dashboard,
│                         generation(代际令牌), memory-host(引擎/检索适配/fs 桥)
├─ tests/                 vitest 单测/集成/e2e/自检（44 文件 / 693 项，分类见 tests/README.md）
├─ scripts/lint.mjs       自写 lint（语法 + 变量遮蔽 + 密钥边界 + AI 请求边界，不引新包）
└─ .github/workflows/build.yml   CI：装依赖 → 诊断 → npm test → build → 开发版自检
                                 → electron-builder → 打包版自检 → 源码 zip → Release
```

> `shared/` 里另外还有：`embeddings.cjs`（向量数学与本地降级，两边共用）、`embedding-ipc.cjs`（嵌入 IPC）、
> `ipc-validate.cjs` + `ipc-schemas.cjs`（IPC 参数验证，未登记的通道会被拒绝）、
> `store-ipc.cjs`（`store:fs` / `store:roots`，硬限定 `<userData>/memory` 与 `/knowledge`）。

构建产物 `dist/`；打包产物 `release/`（`win-unpacked/` + Setup exe + portable exe）。

---

## 3. 数据与运行环境

| 项 | 值 |
| --- | --- |
| 用户数据目录 | `D:\AileenData`（`D:/` 不存在时回退 `%APPDATA%`） |
| 覆盖变量 | `AILEEN_DATA_DIR`（识别旧名 `ELYSIA_DATA_DIR`） |
| 旧数据迁移 | 从 `D:/ElysiaData`、`%APPDATA%\Elysia`、APP_ROOT 拷贝缺失的 `data/settings.json`、`characters/`、`models/` |
| 自检变量 | `AILEEN_SELFTEST`、`AILEEN_SELFTEST_MS`、`AILEEN_SELFTEST_DIR`、`AILEEN_SELFTEST_OVERLAY`、`AILEEN_SELFTEST_LIVE_LLM`、`AILEEN_SELFTEST_SHOT` |
| 自检产物 | 渲染层 `shot.png` + `shot.json`；展台 `overlay.png` + `overlay.json` |
| 渲染层调试全局 | `__AILEEN_ERRORS`、`__AILEEN_MODEL_READY`、`__AILEEN_REFRESH`、`__AILEEN_OPEN` |
| Agent 环境变量 | `AILEEN_AGENT_WORKSPACE`（覆盖 Agent 工作区根） |
| Agent 数据 | 工具能力在主进程（`shared/agent-ipc.cjs`）；workspace 绑定与 `requireMedium` 存在 `settings.agent` |
| 本地 HTTP 服务 | 只 bind `127.0.0.1`，只服务 `models/`、`avatars/` 静态文件 —— Live2D 的 wasm 与贴图在 `file://` 下读不了，这是最不打扰人的解法 |

---

## 4. 踩过的坑（这些是知识，不是历史）

### Windows / Electron

- **`setBounds` 在 `resizable:false` 或 `thickFrame:false` 时会被忽略**。展台要「只能靠按钮改大小」，就得走「临时解锁 → setBounds → 立刻锁回」。
- **`setResizable()` 会重建窗口样式，并把 `setIgnoreMouseEvents` 的穿透状态一并重置**。任何一次尺寸变更/兜底弹回之后都必须重新申请一次穿透，否则展台会吃掉桌面所有点击。
- **frameless 窗口仍带 `WS_THICKFRAME`** → 拖到屏幕边缘触发 Aero Snap（半屏/最大化）。最终方案：保留缩放能力但用 `will-resize` 拦掉「用户发起的缩放」，再加一层尺寸兜底（`resize` 事件发现尺寸不是程序化设定值就弹回）。
- **无边框窗口的回读尺寸比请求值大 1~6 px**。曾经把这个回读值存进设置，导致每启动一次窗口就长大一点。持久化必须存「程序化设定的值」。
- `overlayDrag` 一旦收不到 `pointerup`（中途改尺寸、指针捕获失效）就永远是 set 状态 → 展台吃鼠标。加了 4 秒超时并在拖动中续期。
- 「角色可点击」不做持久化 —— 那是使用时临时开的开关；持久化会让下次启动的展台挡住桌面。
- 原生菜单的 `togglefullscreen` 角色**默认不绑 F11**，要显式绑。

### oh-my-live2d 0.19.3

- 它用 `matchMedia("screen and (max-width: 768px)")` 判断设备 —— 那是**窗口宽度**，不是屏幕宽度。展台窗口天生 400~600px，于是永远走「手机分支」，而手机分支下 `mobileDisplay` 默认 false 会**直接跳过整个模型加载**（`stageChildren` 一直是 0）。
  → 展台和主界面一律 `mobileDisplay: true` 并同时给 `mobileStageStyle`。
- 库的「滑入」动画会重写舞台元素的内联样式，把定位和尺寸整个清掉（舞台元素只剩 20 来像素高）→ 用 CSS `!important` 把舞台钉在容器里。
- 库创建 Pixi 应用时舞台元素还没插进文档，量到的是 0×0，而且之后只在 window resize 时才重新量 → 挂载完成后主动让渲染器重新量一次尺寸。
- 模型入口文件名正则曾经漏掉字面叫 `model.json` 的文件：`/^(?:model3?\.json|.+\.model3?\.json)$/i`。

### Agent 与人格（这一条是架构底线，别改坏）

- **Agent 不是另一个人。** 系统提示词的第 0 段**永远是角色卡拼出来的人格**（`characters.js` 的 `buildSystemPrompt`，含 Personality / Scenario / Example / 自定义 System Prompt），能力说明只能接在它后面。曾经的错误做法是给 Agent 写一份独立的「你是 Coding Agent」提示词 —— 那样进去就没有人格了，**已被 `assertPersonaPreserved` 挡死**（人格不在第一段就抛错、中止）。
- **Tool Result 没有写 system 的通路。** 工具结果一律走 provider 的 `tool` 消息，system 在整轮循环里保持不变。所以「工具结果覆盖角色提示词」不是靠自觉，而是结构上做不到。
- 分层顺序：`Character → Persona → Conversation history → Agent Task → Tool Context`，由 `src/agent/context-engine.js` 统一拼装；runtime 只接受注入好的 `systemPrompt`，自己不会去造人格。
- 电脑控制/工具上下文（屏幕尺寸、鼠标位置、窗口列表、工作区）放在**最后一条 user 消息**里，不进 system —— 进 system 就得每轮重写，人格迟早被挤掉。

### Coding Agent（第一版）

- **Chat 是入口，Agent 是能力**：侧栏「🖥 电脑控制」开关（`settings.agent.computerUse`）打开后，之后每条普通对话都走 `sendWithAgent()` —— 用户在聊天框说话，Agent 在背后调工具，最后**用角色的语气**把结果回填成一条普通回复。工具日志进 Dashboard，**不进聊天气泡**。
- **点亮开关的那一刻就要有反应**（用户明确提过）：`syncDashboardMode()` 让「控制模式」由**开关**决定，而不是等任务跑起来 —— 点亮的瞬间 ① 界面整体转蓝、② 右侧 Live2D 立刻换成 Dashboard。关掉开关立刻还原。
- 运行态（`running`）优先级高于开关：**正在跑的时候不能被关开关把面板抽走**。`FINISHED` 之后延迟 1.2 秒再按开关状态决定去留，让人看清最后结果。状态残留要用 `resetDashboard()` 清（自检流水线里踩过：上一个预览留下 `running=true`，导致关掉开关后面板不退）。
- 关闭时走原来的纯聊天路径，一行都不受影响。
- Dashboard 位置在**原 Live2D 展台区域**（`#agent-dashboard` 在 `#stage-panel` 里）：开关一开就常驻（Live2D 的舞台/模型条/控件全部让位），关掉即回来。

- **目录项跨 IPC 会丢方法**：`readdir` 的 `Dirent.isDirectory()` 是方法，经 structuredClone 之后只剩 `name`/`parentPath`，直接读会恒为 false（或恒为 true），表现是「搜索永远搜不到东西」。契约是 **桥接必须返回 `{ name, isDirectory: 布尔 }`**，主进程侧用 `toPlainDirents` 摊平。有真机形状的回归测试。
- **工具名 ≠ 方法名**：工具叫 `git_status`，executor 上却叫 `gitStatus`，少一个别名就是「这个工具还没有接到宿主实现」。有一张显式别名表 + 接线自检测试。
- **未知工具不能吃掉循环**：模型编了个不存在的工具名时，那一轮如果没有别的合法工具，收尾判定会误判成「没活干了」直接结束 —— 模型永远看不到那句纠错回执。只有「这一轮全是未知工具」时要强制再来一轮。
- `node -e` / `--exec=x` 这类参数等于把代码当参数传进去执行，必须进危险参数黑名单；但 `-c` 不能拦（`pip -c` / `gradle -c` 是正常用法），靠「run_command 一律要审批」兜底。
- 审批按钮的点击处理**必须先收卡片再 resolve**：先 `return` 后 `hide` 会让卡片卡在界面上点不掉（自检抓到的）。
- Agent 弹窗的表单不能复用设置弹窗的 `.form-col` / `.full` 规则（那套只作用于设置弹窗），否则 Task 输入框会塌成一个小方块。
- **改主题色要挂在 `<html>` 上，不能挂 `#app`**：`#agent-panel` 以及一堆弹窗都在 `#app` **之外**，挂 `#app` 的话它们继承不到新变量 —— 表现就是「`getComputedStyle` 说变量已变，但按钮还是旧色」。Agent 模式的主色切换就是这么踩的。
- **不要用 PowerShell 整文件读写源码**（会毁中文）；生成脚本时文本走 base64 传参，坐标/按键全部收敛与白名单校验。
- **按键白名单里不要放 shell 元字符**：`; & | > < $ ( ) [ ] { } \` 一个都不能进 —— 它们会被拼进命令行。曾经 `;` 和 `[` 混进白名单，被测试当场抓出来。
- `getComputedStyle(el).getPropertyValue('--x')` 在 `--x: var(--y)` 这种**变量引用**下返回的是原文 `var(--y)`，不是解析值 —— 想验证颜色要读链尾那个确定值（例如 `--accent-agent`）。
- 自检探针里取 DOM 要写成 `rootEl && rootEl.classList && ...`：探针抛错会让整个诊断阶段挂住、`shot.json` 永远不生成（比断言失败更难查）。
- 空字符串的坑：`'abc'.indexOf('') === 0`。校验「某段必须出现在开头」时要**先确认那段不是空的**，否则会把「什么都没有」判成通过。

### 其它

- `minecraft-data` 的 bedrock 版本目录要在打包时排除，但 `bedrock/common` 必须保留（`supportsFeature.js` 要用）。
- 推理模型（`deepseek-reasoner` 这类）的 `max_tokens` 是「思考 + 回答」的总预算：思考吃光时 `finish_reason=length` 而正文一个字都没有 —— 老代码会安静地返回空消息，界面留个空气泡。现在一个正文字都没有就报错，并把原因说清楚；有正文的截断不算失败。生成人设时起步额度单独放宽到 2048 并翻倍重试（封顶 8192）。
- `normalizeSettings` 曾把 `apiKey` 截断到 300 字符 —— 加密后的密文比明文长，会被截成解不开的串，等于把用户的 Key 弄丢。上限提到 4000。
- i18n 的 `DICTS` 在 `EN` 之前引用它（TDZ），源码直载必炸，靠打包重排才侥幸能跑；`EN` 必须提到最前。

### 渲染层与 Vite（**这条会白屏，务必先看**）

- **`src/` 里绝对不许用 `node:module` 的 `createRequire`**。Vite 会把 `node:*` 换成浏览器 stub，
  于是 `createRequire` 在**模块加载期**就是 `undefined`，整个渲染层 bundle 直接抛
  `Uncaught TypeError: (0 , K.createRequire) is not a function` —— 界面全白、
  `window.__AILEEN_OPEN` 为 `undefined`，而 `npm test` / `lint` / `build` **全是绿的**
  （它们跑在 Node 上，`createRequire` 正常）。2026-10-06 在 `src/memory/embeddings.js`、
  `src/knowledge/embeddings.js`、`src/memory/store.js` 四处踩到，靠真机自检截图才发现。
- 想引 CommonJS 的 `shared/*.cjs`，直接用普通 ESM 默认导入（`import x from '../../shared/x.cjs'`）。
- `node:fs/promises` 这类内置模块只能**在函数体内**用（模块顶层调用 = 白屏）；渲染层真机要碰文件
  一律走 `memory-host` 注入的 `store:fs` 桥。

---

## 5. 代码约定

- **原生 JS**，模块化 ES module，渲染层不放框架。
- 渲染层拿不到密钥：`settings:get` 返回脱敏副本（`apiKey` 置空 + `apiKeySet` 布尔）。LLM/TTS/STT 的联网请求都在主进程。
- IPC 一律过 `shared/ipc-guard.cjs` 的鉴权包装器，发送方必须是主窗口或展台窗口，且页面 URL 必须是自己的 dist 页面（开发模式按 dev URL 前缀）。
- 提示词全部由**角色的卡**拼出来（`buildSystemPrompt`），Minecraft / 象棋复用同一套人格，只额外叠加「正在玩 MC / 正在下棋」的上下文。
- 提示词文案跟随界面语言，不写死中文。
- 表演标记：规范写法 `<|motion:Tap|>`，推荐模型用 `<{'|'}motion:Tap|>`（避免 token 流里出现裸 `<|` 撞上分词器保留 token）；解析器必须正确处理标记被切在两个 chunk 中间的情况。
- 摘要缓存 key 用 SHA-256（纯 JS 实现，因为 `crypto.subtle` 是异步的、key 要同步当 Map 键），覆盖逐条 role+content、角色卡、system 提示词、界面语言、保留轮数、摘要提示词；缓存有 64 条上限。
- 文案三语键数必须相等（有单测把关）。
- 源文件禁用 PowerShell 整文件读写。

---

## 6. 当前状态（最新一次会话结束时）

### 已落地、但**还没 commit** 的 P0/P1 修复

`git status`：22 个已跟踪文件修改（含 `tests/llm.test.mjs` 被删）+ 16 个新增；`tests/llm.test.mjs` 的内容由 `llm-core` 取代。

验证结果（当时实测）：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 201 passed / 17 files（原 155，新增 46） |
| `npm run lint` | 通过（56 文件语法 + 3 条边界规则） |
| `npm run build` | 通过 |
| 自检（开发版 + 展台） | false 项为空、渲染层/主进程 errors 全空 |
| 真机链路 `AILEEN_SELFTEST_LIVE_LLM=1` | 渲染层发起 → 主进程带密钥 → DeepSeek 流式返回正常 |

修复细节见 `工作日志.md`。**未 commit、未 push、没动 README、没用子代理**（按用户当时的要求）。

### 没做完的

- 除 DeepSeek 外的服务商（OpenAI / 小米 / Fish）只有构造逻辑、没有真机验证。
- safeStorage 在没有 DPAPI 的环境（Linux 无 keyring）退化为明文这条路没环境可验。
- 非 Windows 平台没跑过。
- **Agent 的真机 LLM 链路**没跑过（会花用户额度），真实 provider 的工具调用只覆盖到「请求体带 tools + 解析回 tool_calls」。
- 记忆 / 知识库只有设置页，还没有浏览、编辑、删除记忆的专门界面。
- `main.js` 还能再拆 windows / ipc / security（2058 → 1147 行之后剩下的部分）。

> ⚠️ 曾经过时的一句话：「Agent 功能一行都没写」——那是 2026-10-05 之前的状态，
> 现在 Agent / 电脑控制 / Dashboard / 记忆库 / 知识库 / 嵌入设置都已落地，状态以本文件与 AGENTS.md 为准。

---

## 7. 相关历史会话（原文在 `../_ctx/`）

| 会话 | 内容 |
| --- | --- |
| `session-749250d6…`（2026-09-24，**主开发会话**） | 从零做到 0.6.6 的全过程：110 条用户指令 + 763 条助手结论，含全部需求变更、十二杀诊断修复、改名 Elysia→AILEEN、i18n、展台反复返工、人设生成室、最后的 P0/P1 修复与 Agent 计划 |
| `90d90259…` / `490d9716…` / `9f3e9af5…`（子代理） | 开源「好玩 AI 组件」调研（含许可证核实）、日/中文案翻译、i18n 键补齐 |
| `session-0a7bbd72…` | 用 Cordis 动态插件做的日产 400Z 资料查询（与本项目无关，但记录了 DSH 插件用法） |
| `session-935b749c…` | 「角色扮演应用上下文迁移」—— 本记忆文件的诞生会话 |
