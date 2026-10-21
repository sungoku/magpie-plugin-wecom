# Magpie Plugin WeCom (企业微信 AI 伴侣与多 Bot 网关) 🚀

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue.svg)](https://github.com/yetone/magpie)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/sungoku/magpie-plugin-wecom/pulls)

> 基于企业微信官方 WebSocket 长连接的 **AI 编程 Agent 手机远程遥控与多角色中心**。  
> 专为 **Claude Code、OpenCode、Antigravity** 设计，原生提供 **Magpie 桌面 UI 设置页面与任务嗅探中间件**。

---

## 🌟 核心特性 (v1.1)

- ⚡ **零公网 IP / 免内网穿透**：直连企业微信官方 `wss://openws.work.weixin.qq.com` 长连接通道，由本地主动连出，告别任何端口映射与 frp/Cloudflare Tunnel。
- 🤖 **多 Bot 多角色矩阵（Multi-Bot）**：
  - **角色 1（架构重构助手）** $\rightarrow$ 绑定 Claude Code
  - **角色 2（终端运维助手）** $\rightarrow$ 绑定原生 Shell
  - **角色 3（业务开发助手）** $\rightarrow$ 绑定 OpenCode
  - 每个 Bot 可独立配置提示词前缀与白名单，在手机上与不同助手聊天互不干扰。
- 🖥️ **原生 Magpie 界面管理（Page 插件）**：
  - 安装后直接在 Magpie 桌面端的 **Plugins** 侧边栏拥有独立管理控制台。
  - 可视化添加/删除 Bot，输入 `Bot ID` 和 `Secret`，一键启停服务。
- 🕵️ **全自动任务完成嗅探（Middleware 中间件）**：
  - Magpie 代理的 Coding 任务跑完后，自动向企微推送耗时、任务与结果卡片，无感秒知。
- 🛠️ **原生 MCP 支持**：内置标准 MCP Server，工具名 `wecom_send_notification`。

---

## 🚀 安装与使用指南

### 第一步：安装 Magpie 插件

#### 方式 A：直接通过 GitHub 仓库一键安装（推荐）
在终端中执行：
```bash
magpie plugin add github:sungoku/magpie-plugin-wecom
```

#### 方式 B：本地源码安装（适合二次开发与定制）
```bash
git clone https://github.com/sungoku/magpie-plugin-wecom.git
cd magpie-plugin-wecom
magpie plugin add ./packages/magpie-plugin
```

---

### 第二步：启动核心桥接服务

克隆代码并启动核心调度网关（负责与企业微信官方保持 WebSocket 通信并驱动本地 Agent）：

```bash
git clone https://github.com/sungoku/magpie-plugin-wecom.git
cd magpie-plugin-wecom/packages/core
npm install
npm run start
```
> 💡 *开发调试时可使用 `npm run dev`，支持热重载。*

---

### 第三步：在 Magpie 界面中配置与应用

1. 打开 **Magpie** 桌面客户端（或 Web 端）；
2. 点击左侧边栏 **Plugins** $\rightarrow$ **“企微 AI 伴侣”**；
3. 点击 **[+ 添加新 Bot 角色]**，填入你的企业微信 `Bot ID` 和 `Secret`，并选择绑定的 Agent 引擎（Claude Code / OpenCode / Shell）；
4. 点击 **[保存并应用]**，长连接将自动握手上线！

---

## 💡 如何在企业微信后台获取 Bot ID 与 Secret？

1. 登录企业微信管理后台（或手机客户端）进入 **工作台** $\rightarrow$ **智能机器人**；
2. 点击 **创建机器人**，模式选择 **“API 模式”**；
3. 在接入方式中勾选 **“使用长连接”**；
4. 保存后，即可复制专属于该机器人的 **`Bot ID`** 和 **`Secret`**。

---

## 💬 手机端交互示例

- **与【架构重构助手】对话**：
  * 发送：`帮我梳理 auth 模块的架构设计并画出时序图` $\rightarrow$ 自动触发 Claude Code 执行并实时流式打字机回显。
- **与【终端运维助手】对话**：
  * 发送：`git status` 或 `npm test` $\rightarrow$ 自动在本地终端执行并返回执行日志。
- **查看指令帮助**：
  * 发送 `/help` $\rightarrow$ 机器人返回当前所有可用 Agent 列表及使用说明。

---

## 🗺️ 架构路线图

- [x] **v1.0**：WSS 长连接、流式回显、CLI 适配器、本地通知接口、MCP 协议支持。
- [x] **v1.1**：多 Bot 角色矩阵支持、Magpie 独立 UI Page 插件。
- [ ] **v1.2**：手机端交互式审批确认卡片（点击按钮执行高危命令）。

---

## 📄 License

MIT License © 2026
