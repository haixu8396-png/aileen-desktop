# ✦ AILEEN —— 开源桌面 AI 伴侣

<div align="center">

**多模型 LLM 对话 · Live2D 看板娘 · TTS/STT 语音 · 角色卡 · 实时语音 · 屏幕视觉**

全部本地运行，数据私有 · 开源免费（MIT）

[⬇️ 下载安装包](../../releases/latest) · [📋 更新日志](./CHANGELOG.md) · [🤝 参与贡献](./CONTRIBUTING.md) · [🔒 安全策略](./SECURITY.md)

</div>

---

## 📖 项目简介

AILEEN 是一款开源的桌面 AI 伴侣应用，把「会说话、会动、能看屏幕的二次元角色」带进你的电脑：

- 💬 **多模型对话**：接入 DeepSeek、OpenAI、Moonshot、硅基流动、Groq、智谱、阿里百炼、小米 MiMo、OpenRouter、本地 Ollama 等 10+ 供应商，一键切换、流式输出。
- 🎀 **Live2D 看板娘**：内置 Cubism 2/3/4 运行时，角色会说话、会做动作、会换表情，TTS 朗读时自动「对口型」。
- 🎙 **实时语音对话**：说话 → 自动识别 → 角色回复 → 语音朗读 → 继续聆听，真正的连续语音聊天。
- 🔊 **TTS**：系统语音 / OpenAI 兼容 / Fish Audio / 小米 MiMo，多语言（中文 / 英语 / 日语 / 西班牙语）。
- 🎤 **STT**：Whisper 兼容 / 小米 MiMo ASR / 浏览器识别。
- 📷 **屏幕视觉**：一键截图发给角色，让 AI「看」你的屏幕。
- 🗂 **角色卡**：可视化的角色卡系统，新建 / 编辑 / 复制 / 导入 / 导出，绑定专属模型与音色。
- 🎨 **主题调色**：多套配色预设 + 自定义主辅色。
- 🪟 **无边框悬浮展台**：把角色放进一个无边框透明窗口浮在桌面上，**默认整窗鼠标穿透、绝不挡操作**；右下角手柄随用随现、静止自动隐藏，可拖动、缩放、调整透明度和可点击性，位置自动记忆。
- 🧩 **中文应用菜单**：按 Alt 呼出原生菜单（角色 / 设置 / 展台 / 视图），`Ctrl+,` 直达设置。
- 🎮 **Minecraft AI 伙伴**：基于 MIT 许可的 [mineflayer](https://github.com/PrismarineJS/mineflayer)，让角色真的进游戏陪你玩 —— 跟着你走（mineflayer-pathfinder，MIT）、方向键手动操控、聊天栏说话；开启「AI 自动回复」后，别人在服务器里跟它说话，它会用**你自己角色的性格** + 你的 LLM 现场回话。
- 🔒 **数据私有**：API Key、聊天记录、角色卡、模型全部保存在本机，不经过任何第三方。

> 灵感来自 [moeru-ai/Airi](https://github.com/moeru-ai/airi) 与 AI 主播 [Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)。

## 📸 预览

<!-- TODO: 在这里贴截图，例如： -->
<!-- ![screenshot](docs/screenshot.png) -->

## 🚀 快速开始

### 📦 一键安装（推荐，Windows）

到 [Releases](../../releases) 下载最新的 `AILEEN Setup x.x.x.exe`（安装包），双击即完成安装（会自动创建桌面快捷方式）。

> 另有免安装的 `AILEEN x.x.x.exe`（便携版），下载后双击直接运行。

### 🔧 从源码运行

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

> 需要 Node.js ≥ 18；首次安装会下载 Electron（国内可配置镜像加速）。
> Windows 用户也可直接双击 `install.bat`（自动安装依赖并启动）。

### 📦 自行打包安装包

```bash
npm run dist        # 生成 NSIS 安装包 + 便携版，输出到 release/ 目录
```

> Windows 用户也可双击 `build-installer.bat`。

### 配置 API

启动后点左侧「⚙ 设置」：

1. **💬 对话设置**：选供应商 → 填 API Key →（可选）点「⚡ 获取模型列表」「🔌 测试连接」。
2. **🔊 TTS 设置**：选引擎（Fish Audio 需填 fish.audio 的 Key 和声音 ID）。
3. **🎤 STT 设置**：选引擎、语言。

### 添加 Live2D 模型

⚙ 设置 → 🎀 Live2D 模型设置 → 从文件夹导入 / 从网址加载。

## 🧩 角色卡格式

角色卡是 JSON 文件（保存在用户数据目录的 `characters/`），结构如下：

```json
{
  "spec": "aileen-card-v1",
  "name": "角色名",
  "avatar": "avatars/xxx.png",
  "description": "一句话简介",
  "personality": "性格人设",
  "scenario": "场景",
  "first_mes": "开场白",
  "mes_example": "示例对话",
  "system_prompt": "",
  "model": "绑定的 Live2D 模型路径",
  "voice": "绑定的系统 TTS 语音"
}
```

## 🛠 技术栈

- **Electron**：跨平台桌面框架
- **Vite**：渲染层构建
- **oh-my-live2d**：Live2D 运行时（内置 Cubism 2/3/4）
- **原生 Web API**：Web Speech / MediaRecorder / fetch，无重型依赖

## 📁 目录结构

```
aileen/
├─ main.js                 # Electron 主进程
├─ preload.js              # contextBridge 安全桥接
├─ src/                    # 渲染进程（Vite 构建）
│  ├─ index.html / styles.css / main.js
│  └─ lib/                 # llm / tts / stt / characters / settings / markdown
├─ CONTRIBUTING.md
├─ LICENSE
└─ README.md
```

> 用户数据（设置、API Key、角色卡、模型）保存在系统用户数据目录，应用内点「📂 数据目录」即可打开。

## 🗺 Roadmap

- [ ] 打包成安装包（electron-builder）
- [ ] 多角色 / 房间
- [ ] 插件系统
- [ ] 长期记忆
- [ ] 更多 TTS/STT 供应商
- [ ] i18n 国际化

## 📋 更新日志

完整版本历史见 **[CHANGELOG.md](./CHANGELOG.md)**，每个版本的安装包在 [Releases](../../releases) 页面。

**最近更新（v0.1.4）**
- 渲染层拆分为 7 个控制器（`state` / `dom` / `stage` / `chat` / `characters-ui` / `modals` / `voice`），`src/main.js` 由 1325 行降到约 330 行
- CI 加入**单元测试**与**自检冒烟**双重门禁，不通过不发布

**v0.1.3**
- 安全：Markdown 输出统一经 DOMPurify 消毒；`shell:openPath` 收敛为白名单；设置写入走白名单校验
- 修复：角色卡同名不再静默覆盖、日文名不再乱码、聊天记录改存文件（清缓存不丢）
- 新增：TTS 语速贯通全部引擎、21 项单元测试

**更早版本**：v0.1.2 GitHub Actions 自动构建与发布 · v0.1.1 一键安装包 + D 盘数据目录 · v0.1.0 首个公开版本

## 🤝 维护与贡献

欢迎提 Issue、Pull Request，或加入共同维护：

- 💬 **微信**（维护联系）：`Am112211HGHE`
- 🐧 **QQ 讨论群**：`815615686`

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 📄 开源许可

本项目采用 [MIT](./LICENSE) 协议。

## 🙏 致谢

- [moeru-ai/Airi](https://github.com/moeru-ai/airi) —— 灵感来源（自托管 AI 伴侣项目）
- [Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA) —— AI 虚拟主播，追寻「AI 的灵魂」的方向
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d) —— Live2D 运行时
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)
