<h1 align="center">✦ AILEEN</h1>

<p align="center">
  <b>数据完全保存在本机的桌面 AI 助手 / AI Agent。</b><br/>
  Live2D 角色 · 多服务商 LLM 对话 · 长期记忆 ·<br/>
  工具调用与电脑控制。
</p>

<p align="center">
  AILEEN 也可以替你写角色卡 ——<b>说出角色名字，它就整理出可直接使用的性格、经历与说话方式</b>；<br/>
  或从一句灵感开始，生成一个原创角色。
</p>

<p align="center">
  灵感来自 <a href="https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA">Neuro-sama</a>，
  致敬 <a href="https://github.com/moeru-ai/airi">moeru-ai/Airi</a>。
</p>

<p align="center">
  [<a href="./README.md">English</a>]
  [<a href="./README.ja.md">日本語</a>]
  [<a href="./README.zh-CN.md">简体中文</a>]
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-ff7eb3.svg"></a>
  <a href="../../releases"><img src="https://img.shields.io/github/downloads/haixu8396-png/aileen-desktop/total?color=38b0de"></a>
  <a href="#开始使用"><img src="https://img.shields.io/badge/platform-Windows-9aa0b4.svg"></a>
  <a href="#界面与语言"><img src="https://img.shields.io/badge/languages-English%20%C2%B7%20日本語%20%C2%B7%20简体中文-a78bfa.svg"></a>
</p>

<p align="center">
  <a href="../../releases/latest"><b>⬇️ 下载 Windows 版</b></a>
  · <a href="https://github.com/haixu8396-png/aileen-desktop/releases">全部版本</a>
  · <a href="./CHANGELOG.md">更新日志</a>
</p>

---

## 概览

AILEEN 是一个面向 Windows 桌面环境的 AI Assistant / AI Agent 项目，把 AI 对话、角色系统、长期记忆、工具调用、电脑控制与可视化角色整合到同一个交互环境中。它以 Electron 应用的形式运行：界面使用原生 JavaScript，涉及 API Key 的请求全部在主进程中完成，用户数据只保存在本机。

项目不设账号，也没有自建后端：AILEEN 只与你自行配置的模型、语音与嵌入服务商通信。

当前重点方向：

- **AI 对话与角色系统** —— 角色卡（性格、场景、开场白、示例对话）、人格提示词装配、TTS/STT，以及多服务商 LLM 支持（DeepSeek、OpenAI、Moonshot、SiliconFlow、Groq、智谱、通义千问、小米、OpenRouter、Ollama 或任何兼容接口）。
- **长期记忆与上下文管理** —— 对话记忆、本地知识库，以及统一的上下文引擎：把系统提示词、角色卡、历史、记忆、知识与工具输出装配成一份带 token 预算的请求。
- **Agent 与工具调用** —— 单 Agent 工具循环，包含工具注册表、三档风险等级与显式审批流程。
- **文件与电脑操作** —— 读写文件、执行白名单命令、查看 git 状态，以及桌面输入（鼠标、键盘、窗口切换）；全部受工作区边界约束，并按操作逐次授权。
- **桌面环境交互** —— 无边框、默认鼠标穿透的悬浮展台，以及 Minecraft 与国际象棋两个可交互环境。
- **可视化角色** —— Live2D 模型，动作与表情由对话内容驱动。
- **图像与视觉** —— 屏幕截图交由支持视觉的模型处理。
- **可扩展性** —— Agent 核心与宿主无关，工具注册表由数据驱动；MCP、浏览器工具与更多环境是后续方向，目前尚未实现。

AILEEN 仍在持续开发中。目标是为 AI 对话、记忆、Agent 执行与电脑控制提供一个统一的桌面环境，而不只是一个单一用途的聊天客户端。

> [!NOTE]
> 所有数据都留在本机：API Key、聊天记录、角色卡与模型都不会上传，也不需要注册账号。

## 功能

### AI 对话与角色系统

直接使用你已有的模型 —— DeepSeek、OpenAI、Moonshot、硅基流动、Groq、智谱、阿里百炼、小米 MiMo、OpenRouter；想完全离线，可以接本地 Ollama。

每个角色由一张角色卡定义，卡里包含名字、头像、性格、场景、开场白与示例对话。同一个模型配两张卡，就是两个不同的角色。提示词完全由这张卡拼出：如果你写了自定义系统提示词，则以它为准。

**角色卡生成。** 说出已有角色的名字，或只给一句灵感，AILEEN 会把这些字段草拟出来。结果是一份可以继续修改的草稿，而不是写死的预设。

### 语音输入与输出

按下麦克风说话，回答会以语音播放，并继续聆听，因此对话可以来回进行，而不必按住说话。以打字为主时，也可以使用单次语音输入。

四种语音引擎，覆盖你可能已有的凭据：系统语音（离线、免费）、任何 OpenAI 兼容接口、用于音色克隆的 Fish Audio，以及小米 MiMo。全程支持中文、英语、日语与西班牙语。

### 长期记忆与知识库

对话会被提炼成记忆，保存在本地，并在相关时被召回，而不是把整段聊天记录反复重放。

**知识库。** 可以加入文本、Markdown、HTML、JSON 与 PDF 文件；它们会被切块并保存在本地，与当前对话相关的片段会进入请求。PDF 解析由本项目自行实现，为了读取文档没有引入额外依赖。

两者都使用在 **设置 → 🧠 记忆与知识库** 中选择的小型**嵌入模型**（OpenAI、硅基流动、阿里云百炼、智谱、本地 Ollama 或任何兼容接口），因此检索是**按语义**进行的，而不只是匹配关键词。没有配置嵌入模型时，检索会退化为关键词匹配，并保持全程离线。

记忆与知识库数据存放在应用数据目录中，且只有属于它们的那两个文件夹可写。

> [!NOTE]
> 嵌入模型的 Key 与应用内其它 Key 同等对待：界面永远看不到它。请求由主进程发出，渲染层只收到一个表示「已配置」的布尔值。

### Agent 与工具调用

在侧栏打开 **🖥 电脑控制**。**入口仍然是普通聊天框**：你照常说话，由 Agent 判断何时需要工具、执行并把结果汇报回来。

权限按三档风险等级执行。读取不受限制；任何会触及电脑的操作每次都会请求批准，而且这一要求**刻意做成在设置里也无法关闭**。

> [!IMPORTANT]
> 任务执行期间，右侧展台会变成 **Agent 控制仪表板**：任务、当前步骤、带时间戳的操作日志、每一次工具调用、截取到的屏幕，以及批准按钮。工具日志**不会**被插入聊天气泡。

> [!NOTE]
> 角色人格会被保留：系统提示词的第一段永远是角色卡，无论它正在聊天、下棋还是操作桌面；一旦发现人格丢失，硬性检查会直接中止本次运行。

### 电脑控制

可用的工具包括读写文件、执行白名单命令、查看 git 状态、截取屏幕、移动鼠标、键盘输入、启动程序与切换窗口。任务完成后，结果会以角色自己的语气汇报，而不是一句通用的完成提示。

Agent 触及的一切都受工作区边界约束（边界之外的路径一律拒绝），并经过上一节的授权流程。

### 可视化角色

任意 Live2D 模型（Cubism 2 / 3 / 4）都可以作为角色：待机动画、呼吸、动作、表情，以及说话时的口型变化。可以导入模型文件夹，也可以直接填入 `model3.json` 的网址。

> [!TIP]
> 添加模型只需两步：**设置 → 🎀 Live2D 模型设置 → 📁 从文件夹导入**。舞台面板上也有同样的按钮。

### 悬浮展台

悬浮展台把角色放到桌面上：一个无边框、透明、始终置顶的窗口。它**默认整窗鼠标穿透**，因此下方窗口不会丢失任何点击；手柄只在指针靠近时出现。

> [!TIP]
> `Ctrl+Shift+S`（或菜单中的 **展台 → 显示 / 隐藏无边框展台**）可随时开关。支持拖动、用 `−` / `＋` 按钮调整尺寸，或从菜单复位回角落；位置与大小都会被记住。

### 视觉

可以把任意窗口或显示器的截图连同问题一起发送，常用于读取报错堆栈或查看图表。视觉能力需要多模态模型：`qwen-vl-plus`、`gpt-4o`、`glm-4v`、`MiMo-VL` 均可；纯文本模型会忽略图片。

### 可交互环境

**Minecraft。** 角色会以机器人身份加入 Java 版服务器：跟随你移动、接受手动操控、在服务器聊天栏发言；开启自动回复后，还会用自己的语气与人格回应其他玩家。

**国际象棋。** 五档难度、可选择执白或执黑、悔棋、翻转棋盘，并能在你思考时对局面作出评论。

## 架构与设计

### 设计要点

- **角色卡是提示词的唯一来源。** 名字、头像、性格、场景、开场白与示例对话全部来自同一张卡；自定义系统提示词优先于生成的人格。
- **人格在所有场景中复用。** Minecraft 与国际象棋沿用角色的人格，而不是各自使用一次性的提示词。
- **悬浮展台默认鼠标穿透**，这一行为是自检最先检查的项目之一。
- **源码保持可读。** 没有压缩过的第三方代码块，也没有隐藏服务：任何行为都可以在本仓库中定位。
- **API Key 不会进入渲染层。** 面向模型、语音与嵌入服务商的请求全部由主进程发出，界面只拿到脱敏后的设置。

### 目录结构

```
main.js               Electron 主进程 —— 应用生命周期与装配
preload.js            contextBridge 暴露的 API
mc-bot.cjs            Minecraft 机器人
shared/               主进程、渲染层与测试共用的代码
  ipc-guard.cjs       谁可以调用 IPC
  ipc-validate.cjs    允许传入什么
  ipc-schemas.cjs     每个通道一条校验规则
  llm.cjs             流式对话核心（API Key 不离开主进程）
  agent-ipc.cjs       Agent 工具允许对你的机器做什么
  embeddings.cjs      向量计算与离线降级
  store-ipc.cjs       记忆与知识库允许写入的两个目录
src/
  main/               主进程模块
    self-test.cjs     诊断，仅在 AILEEN_SELFTEST=1 时运行
    server/           为模型与头像提供服务的本地静态服务
    storage/          设置与 API Key 存储
  agent/              Agent 核心：runtime、planner、工具、权限、executor
  context/            统一上下文引擎（提示词分层与 token 预算）
  memory/             长期记忆：抽取、存储、召回、合并
  knowledge/          本地知识库：解析、切块、检索
  lib/                界面层 —— state、dom、stage、chat、characters、modals、
                      voice、minecraft、chess、agent-dashboard、agent-ui、i18n
  overlay.*           悬浮展台窗口
tests/                单元 / 集成 / 端到端（见 tests/README.md）
```

### 模型与头像为什么走本地 HTTP 服务

模型与头像通过一个很小的本地 HTTP 服务提供，而不是 `file://`。这不是风格选择：Live2D 的 WebAssembly 与贴图在 `file://` 下无法加载，而这是当时侵入性最小的方案。该服务只绑定 localhost，永远不会监听本机以外的地址。

## 开始使用

到 **[Releases](../../releases)** 下载最新版本。

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **安装版** —— 自动创建桌面与开始菜单快捷方式。绝大多数人需要的是这个。 |
| `AILEEN x.x.x.exe` | **免安装便携版** —— 双击即用，不写入注册表。 |

支持 Windows 10 / 11（64 位）。

### 界面与语言

应用提供 **English / 日本語 / 简体中文** 三种界面，是完整翻译而非部分翻译。默认启动为英文，一键即可切换。

随时在 **设置 → 🌐 Language** 或原生菜单（按 `Alt`）中切换。**应用程序菜单本身也已本地化**。

> [!TIP]
> 想添加第四种语言：所有文案都在 `src/lib/i18n.js`，每种语言对应一个 JSON 文件，整个界面都从那里读取。新增一个文件、在 `LANGS` 中增加一行即可。欢迎提交 PR。

## 开发

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start        # 构建界面并启动
```

需要 Node.js 18 或更高版本。首次运行会下载 Electron；如果较慢，可以先设置 `ELECTRON_MIRROR` 指向镜像。Windows 用户也可以直接双击 `install.bat`。

```bash
npm run dist     # 生成安装包 + 便携版到 release/
npm test         # 单元测试
npm run lint     # 语法与项目自定义的边界规则
```

在 Windows 上，`build-installer.bat` 与 `npm run dist` 等效。

## 致谢

### 站在谁的肩膀上

致敬 **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** —— 没有它，就不会有 AILEEN。是它让「开源的 AI 伴侣」听上去像一件真事而不是一个愿望。这个仓库公开地照着 Airi 学：README 的组织方式、做事习惯，以及那份「虚拟角色值得被认真做」的笃定。如果你还没看过 Airi，它值得那些 star。

而这一切的起点是 **[Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)** —— 这位 AI VTuber 证明了：一个有声线、有记忆、有性格的角色，可以让人忘记自己在看软件。那就是标杆。AILEEN 只是朝这个方向做出的一次小得多的尝试，目前离它还很远。

### 用到的开源项目

- [mineflayer](https://github.com/PrismarineJS/mineflayer) 与 [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)：一个没有手的角色之所以能在 Minecraft 里跟着你跑、并且和大家一样卡在栅栏上，全靠它们。PrismarineJS 多年来一直在维护整个 JavaScript 版 Minecraft 生态。
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine)：零依赖，却是有真实搜索的棋力引擎。我们至今仍怀疑它为何这么小，而它每次都在赢。
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d)：无需与构建系统纠缠即可把 Live2D 放进页面。我们整套 Cubism 2/3/4 支持也来自这里。
- [DOMPurify](https://github.com/cure53/DOMPurify)：能把模型输出安全地按 Markdown 渲染，靠的是它。
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) —— BSD-3-Clause。替我们实现 Minecraft 网络协议。

Live2D Cubism Core 运行时适用 Live2D 公司自己的许可条款。你添加的每个 Live2D 模型也各有其规约，请尊重原作者的授权 —— 尤其是打算用于直播时。

## 类似的项目

- **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** —— 自托管，浏览器 / 桌面 / 手机三端，范围与野心都远大于本项目。
- **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)** —— 本地 LLM + Live2D，主打离线；如果你要的正是这种形态，它是很好的起点。
- **[BongoCat](https://github.com/ayangweb/BongoCat)** —— 一只在细节上做过认真打磨的桌宠。

## 许可证

AILEEN 采用 **PolyForm Noncommercial License 1.0.0** 发布，具有约束力的是 [LICENSE](./LICENSE) 中的协议原文。

默认许可证不授予商业使用权：个人使用、学习、爱好项目、学校以及公益组织等非商业用途均可使用；但不允许将本软件出售，也不允许在其之上构建商业产品。

如需商业使用、商业发行或其他形式的商业授权，必须事先取得 AILEEN 开发者的书面许可，可通过 [SECURITY.md](./SECURITY.md) 中列出的方式联系我们。

许可变更说明：0.7.0 起，本项目许可证由 MIT 变更为 PolyForm Noncommercial 1.0.0。在 MIT 期间已获得副本的用户，就该副本仍享有 MIT 授予的权利 —— 许可证不追溯。

## 联系方式

- **缺陷报告与功能建议** —— [GitHub Issues](../../issues)
- **代码、文档与翻译贡献** —— [Pull Request](../../pulls)
- **安全问题与其他联系方式** —— [SECURITY.md](./SECURITY.md)
- **商业授权** —— 见[许可证](#许可证)一节
