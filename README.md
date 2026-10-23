# Magpie Plugin WeCom (企业微信 AI 伴侣与多 Bot 网关) 🚀

![status: WIP / incomplete](https://img.shields.io/badge/status-WIP%20%2F%20incomplete-orange)

> [!WARNING]
> 🚧 **开发测试中 · 功能尚未完整（Work in Progress）**
>
> 本项目仍处于开发与人工测试阶段，部分功能、配置格式、接口和文档可能不完整或随时调整。
> 请勿直接用于生产环境；欢迎测试并反馈问题。

> 基于企业微信官方 WebSocket 长连接的 **AI 编程 Agent 手机远程遥控与多角色中心**。
> 专为 **Claude Code、OpenCode、Antigravity** 设计，提供 **Magpie 桌面端插件页** 与 **任务完成通知**。

---

## 🌟 核心特性 (v1.1.1)

- ⚡ **零公网 IP / 免内网穿透**：本地主动连接企业微信官方 `wss://openws.work.weixin.qq.com`。
- 🤖 **多 Bot 多角色矩阵**：每个 Bot 可独立绑定 Agent、提示词前缀和白名单。
- 🖥️ **本地可视化管理界面**：`http://127.0.0.1:9099/`，支持增删 Bot、热重载、启停服务。
- 🚀 **可选自动启动**：在插件页勾选后，Magpie 的 Bun 宿主会在网关未运行时拉起本地服务；默认关闭。
- 🔔 **任务完成通知**：Magpie 异步网关钩子（Bun）在一轮任务结束后推送耗时与**完整结果**；跳过 Claude Code 内部搜索/建议侧调用；工具调用后长时间没有下一步请求时推送“等待确认/选择”提醒。
- 🛠️ **原生 MCP 支持**：`wecom-bridge mcp` 提供 `wecom_send_notification` 工具。
- 🔐 **默认安全**：管理接口需要本次会话令牌；`GET /api/config` 永不返回 Secret；配置文件权限 `0600`。

---

## ⚠️ 先读：Magpie 插件页为什么不能直接连本地服务

Magpie 会把插件页放进 `sandbox="allow-scripts"` 的 iframe，并下发如下 CSP：

```
default-src 'none'; script-src <插件页自己的目录>; connect-src 'none';
```

这意味着：

- **内联脚本和 `onclick` 会被丢弃** —— 所以本项目的脚本全部放在 `page/app.js` 中；
- **页面不能发任何网络请求** —— 所以插件页不能直接调用 `127.0.0.1:9099`。

因此插件页在 Magpie 内承担三件事：

1. 读写 Magpie 插件选项（通知开关、最小耗时、等待确认提醒、通知地址、是否自动启动网关）；
2. 提供“打开管理界面”按钮，把 iframe 导航到本地管理服务，完整的 Bot 管理在该页面完成；
3. 可选地让 Bun 插件宿主在网关未运行时启动本地服务（`autoStartService`，默认关闭）。

> 这不是权限问题，而是 Magpie 的固定安全策略；任何插件页都无法绕过。
> 如果你在第三方文章里看到“插件页直接 fetch 本地端口”的写法，它在当前 Magpie 上不会生效。

---

## 📦 安装与使用

### 第一步：安装 Magpie 插件

```bash
# 从 GitHub 安装（需要先推送本仓库；把 <owner> 换成实际 GitHub 账号/组织）
magpie plugin add github:<owner>/magpie-plugin-wecom

# 或本地源码安装
git clone https://github.com/<owner>/magpie-plugin-wecom.git
cd magpie-plugin-wecom
magpie plugin add ./packages/magpie-plugin
```

> 通知功能使用 `magpie.hooks`（异步网关钩子，运行在 Bun 中）。
> Magpie 需要支持异步网关钩子；旧版本只支持 `magpie.middleware`，而中间件运行在 moejs 里，**没有 `fetch`**，无法访问本地服务。

### 第二步：启动本地网关

```bash
cd magpie-plugin-wecom
npm install
npm start          # 开发/运行 TypeScript 源码
# 或者构建后运行
npm run build
node packages/core/dist/cli.js --config ./config.json
```

首次运行前复制配置模板：

```bash
cp config.example.json config.json
# 编辑 config.json，填入 Bot ID / Secret
```

启动后：

- 管理界面：<http://127.0.0.1:9099/>
- 健康检查：<http://127.0.0.1:9099/health>

> 如果希望 Magpie 自动拉起网关，请在插件页勾选 **“网关未运行时自动启动本地服务”** 并保存。
> 该功能默认关闭，需要先在仓库根目录执行 `npm run build`；详见下方“自动启动本地网关”。

### 第三步：在管理界面添加 Bot

1. 打开 <http://127.0.0.1:9099/>（页面内已注入本次启动的令牌）；
2. 点击 **+ 添加 Bot**，填写 `Bot ID`、`Secret`，选择 Agent；
3. 建议填写 **授权用户白名单**（逗号分隔的企微 userid）；留空表示不限制；
4. 点击 **保存并应用**。若服务已在运行，Bot 会自动热重载并建立长连接；若首次启动时还没有 Bot，请再点击右上角的 **启动服务**。

也可以在 Magpie 的插件页里先配置通知选项，再点击“打开管理界面”。

---

## 💡 获取 Bot ID 与 Secret

1. 登录企业微信管理后台（或手机客户端）进入 **工作台 → 智能机器人**；
2. 点击 **创建机器人**，模式选择 **“API 模式”**；
3. 接入方式勾选 **“使用长连接”**；
4. 保存后复制 **`Bot ID`** 和 **`Secret`**。

---

## 💬 手机端交互示例

- 与【架构重构助手】对话：`帮我梳理 auth 模块的架构设计` → 触发 Claude Code，进度与结果流式回显。
- 与【终端运维助手】对话：`git status` / `npm test` → 在本地终端执行并返回日志。
- 指定 Agent：`/sh git status`、`/claude 优化这段代码`。
- 查看帮助：`/help`。

---

## 🔔 企微通知（任务完成与等待确认）

钩子文件：`packages/magpie-plugin/wecom.hooks.js`

- `onRequest`：记录本轮开始时间，不修改请求；
- `onResponse`：一轮回复结束后判断：
  - Claude Code 的内部侧调用（WebSearch 的 `Perform a web search for the query: ...`、`[SUGGESTION MODE: ...]`）→ 跳过，避免把搜索结果摘要当成任务结果；
  - 回复里带**客户端**工具调用（`tool_calls` / `tool_use` / `function_call` / `functionCall`）→ 不推送，等待最终回复；
  - 回复同时带**服务端**工具（web_search 等）和最终文本 → 推送最终文本；
  - 只有 thinking / reasoning 内容 → 不作为结果推送；
  - 错误回复 → 不推送；
  - 整轮耗时（跨工具调用与侧调用累计）低于 `minDurationSec` → 不推送；
  - 同一轮重复回调 → 去重（按 Magpie 传给该次请求的 `ctx.state`，不会误伤并发请求）；
  - 请求失败或回复不完整（`ctx.success === false`）→ 不推送（但客户端工具调用已完整出现时，仍会启动“等待确认”计时）；
  - 其余情况 `POST {notifyUrl}`，推送标题、耗时、任务和**完整结果**（最多约 18 KB UTF-8，不再截成 300 字）。

#### 等待确认 / 选择提醒

客户端工具调用（`Bash`、`Read`、`Write`、`Edit`、`MultiEdit`、`NotebookEdit`、`WebFetch`、`Task`、`ExitPlanMode`、`AskUserQuestion`、`mcp__*` 等；`Glob` / `Grep` / `LS` / `TodoWrite` / `WebSearch` 等快速只读工具除外）出现后，如果 `approvalWaitSec` 秒内同一会话没有新请求，就推送：

- “⏸️ Agent 可能在等待确认”——附工具名和命令/文件路径；
- “⏸️ Agent 正在等待你的选择”——`AskUserQuestion` / `ExitPlanMode` 会附上问题和选项。

下一个请求到达（批准、拒绝或自动执行完成）会立即取消计时。企微端只能收到提醒，**不能代替客户端点击允许/拒绝**；看到提醒后请回到 Magpie/终端处理。这是启发式判断：已自动批准但运行较久的工具（例如耗时较长的 Bash 命令）也可能触发提醒，可将 `approvalWaitSec` 调大或设为 `0` 关闭。

插件选项（Magpie 设置页或插件页均可修改）：

| 选项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | 是否启用自动通知 |
| `notifyUrl` | `string` | `http://127.0.0.1:9099/notify` | 本地通知服务地址 |
| `minDurationSec` | `number` | `3` | 整个轮次的最小触发耗时（秒），跨工具调用/侧调用累计 |
| `approvalWaitSec` | `number` | `10` | 工具调用后多少秒没有下一步请求就提醒“可能在等待确认/选择”；`0` 关闭 |
| `gatewayTimeoutMs` | `number` | `3000` | 通知 hook 的最长等待时间（毫秒） |
| `autoStartService` | `boolean` | `false` | 网关未运行时，由 Magpie 插件宿主自动启动本地服务 |

> 钩子在 Bun 宿主启动时读取一次选项。仓库里的 `wecom.plugin.js` 是一个不注册任何钩子的
> OpenCode 插件入口，它让 Magpie 在插件页保存选项时按普通插件处理并重启宿主，因此新设置
> 从下一轮 Agent 请求起生效。没有这个入口时，Magpie 会把本插件当成纯页面插件，只写
> `plugins.json` 而不重启宿主，旧的 `notifyUrl` / `enabled` 会继续生效。

也可以用 CLI 设置：

```bash
magpie plugin options plugin-wecom '{"minDurationSec": 5, "approvalWaitSec": 10, "notifyUrl": "http://127.0.0.1:9099/notify"}'
```

### 自动启动本地网关（可选）

插件页的 iframe 不能启动进程，所以这一步由同一仓库的 Bun 宿主完成：

1. 在插件页勾选 **“网关未运行时自动启动本地服务”**，点击 **“保存设置”**；
2. Magpie 保存选项后会重启 Bun 宿主；`wecom.plugin.js` 读取选项，先请求
   `http://127.0.0.1:9099/health`，确认服务未运行后才启动；
3. 启动命令等价于：

   ```bash
   <Magpie 自带的 Bun> packages/core/dist/cli.js --config ./config.json --port 9099
   ```

   使用宿主自己的运行时（`process.execPath`），不依赖 GUI 的 PATH；子进程 PATH 还会补上
   `~/.local/bin`、Homebrew 等目录，保证 `claude` 等 Agent 命令可执行。
   未构建 `dist/` 时，Magpie 的 Bun 会直接运行 `packages/core/src/cli.ts`（需要已安装依赖）。
4. 网关以 detached 方式运行，**Magpie 退出后仍继续运行**；日志在
   `~/.cache/wecom-agent-bridge/service.log`。
5. 取消勾选只会阻止以后自动启动，**不会停止**已在运行的网关；管理页的“停止服务”会断开
   Bot 连接，但网关进程仍在（继续接收通知、提供管理页）。要结束进程可执行
   `lsof -ti tcp:9099 | xargs kill`。

注意：

- 只有“从本仓库/本地路径安装”的插件能找到 `packages/core`。从 npm/GitHub 单独安装插件包时，
  网关本体不在包内，自动启动会跳过并写一条日志；
- 启动前一定先做健康检查，且每 60 秒最多尝试一次；端口已被占用时不启动第二个进程，
  避免 `EADDRINUSE` 与重复网关；
- 该选项默认关闭：自动启动的网关会持有企微凭证并可以执行 Agent 命令，应由你明确开启。

---

## 🛠️ MCP 与 CLI

```bash
# 启动网关（仓库内使用 npx，或 ./node_modules/.bin/wecom-bridge）
npx wecom-bridge --config ./config.json --port 9099

# 以 stdio MCP Server 运行（供 Claude Code / Cursor 挂载）
npx wecom-bridge mcp --port 9099
```

MCP 工具：`wecom_send_notification({ content, title? })`，转发到本地 `/notify`。

---

## 🔐 安全说明

- **管理令牌**：每次启动随机生成，仅注入到本地管理页；`/api/*` 必须携带 `X-Bridge-Token`。令牌随重启变化，旧页面需刷新。
- **Secret 脱敏**：`GET /api/config` 只返回 `secretSet` 和 `secretMasked`；保存时留空或提交掩码值都会保留磁盘上的原 Secret。
- **白名单**：留空 = 任何能联系该 Bot 的企微用户都可执行指令。使用 `sh`（原生 Shell）时务必设置白名单。
- **命令注入**：除显式配置为 `{prompt}` 的 `sh` Agent 外，提示词会作为单个参数安全引用，`$()`、反引号、`;` 不会被展开。
- **配置文件**：`config.json` 含明文密钥，权限 `0600`，已被 `.gitignore` 排除。

---

## 🧪 测试

```bash
npm test
```

包含：

- 核心单元测试：UTF-8 截断、Secret 脱敏、Bot 配置合并、命令转义；
- 端到端测试：启动真实管理服务，验证令牌鉴权、Secret 不回传、掩码保存、静态页面、通知接口；
- 插件页 CSP 合规测试：无内联脚本、无内联事件、无 CDN 外链；
- 钩子行为测试：四种协议的 tool-call 识别（客户端/服务端区分）、侧调用过滤、完整结果与 thinking 过滤、耗时过滤、去重、等待确认计时与取消、通知载荷；
- 自动启动测试：loopback 校验、健康检查、仓库定位、不重复启动，以及真实 detached 子进程的
  参数/PATH/日志（测试用假 CLI，不会启动真实网关）。

---

## 🗺️ 架构与路线图

- [x] **v1.0**：WSS 长连接、流式回显、CLI 适配器、本地通知接口、MCP 协议支持。
- [x] **v1.1**：多 Bot 角色矩阵、Magpie 插件页、任务完成通知。
- [x] **v1.1.1**：修复 Magpie CSP 导致插件页失效；通知从 moejs 中间件迁移到 Bun 钩子；管理接口鉴权与 Secret 脱敏；白名单/断线事件/命令注入修复；插件页可选自动启动本地网关。
- [ ] **v1.2**：手机端交互式审批确认卡片。

---

## 📁 目录结构

```
.
├── package.json                  # Magpie 插件清单（page + hooks）
├── config.example.json           # 配置模板
├── packages/
│   ├── core/                     # 企业微信网关（TypeScript）
│   │   ├── src/
│   │   │   ├── cli.ts            # wecom-bridge 命令
│   │   │   ├── index.ts          # startBridge
│   │   │   ├── config.ts         # 配置读写 / 脱敏 / 校验
│   │   │   ├── util.ts           # UTF-8 截断、掩码
│   │   │   ├── wecom/client.ts   # 多 Bot 长连接
│   │   │   ├── router/router.ts  # Agent 路由
│   │   │   ├── adapters/         # CLI Agent 适配器
│   │   │   ├── server/           # 管理 API + 管理页
│   │   │   └── mcp/server.ts     # stdio MCP Server
│   │   └── test/
│   └── magpie-plugin/
│       ├── page/                 # 插件页（index.html / app.js / style.css / icon.svg）
│       ├── wecom.hooks.js        # Magpie 异步网关钩子
│       ├── wecom.plugin.js       # OpenCode 入口（选项保存后重启宿主 + 可选自动启动）
│       ├── service.js            # 健康检查与 detached 启动本地网关
│       └── test/
└── README.md
```

---

## 🩺 常见问题

**插件页一片空白或按钮没反应？**
检查页面是否加载了 `app.js`。Magpie 的 CSP 会丢弃任何内联 `<script>` 和 `onclick`，本项目已全部外置；如果你改过页面，请保持外置脚本。

**点击“打开管理界面”没反应？**
确认网关已运行、端口 9099 可访问。可以在插件页勾选“网关未运行时自动启动本地服务”并保存，
让 Magpie 的宿主自动拉起；也可以手动执行 `npm start`。若 Wails 窗口阻止了 iframe 导航，
请复制页面显示的管理服务地址到浏览器打开。

**管理页提示“管理令牌已失效”？**
网关重启后令牌会变化，刷新页面即可。

**Bot 状态一直是“已停止”？**
在管理页点击“启动服务”，或检查 `config.json` 中 Bot 的 `botId` / `secret` 是否完整。

**通知没有推送？**
- 确认 Magpie 版本支持 `magpie.hooks`；
- 确认 `notifyUrl` 指向正在运行的网关；
- 工具调用中的中间回复不会推送，只有最终回复会推送；
- Claude Code 的 WebSearch / 建议侧调用会被跳过，最终答案会在主轮单独推送；
- 任务耗时低于 `minDurationSec` 会被过滤。

**通知内容只有“无文本回显”？**
模型这一轮没有返回可见文本（只有 thinking/reasoning 或工具调用）。钩子不会把思考过程当成结果。

**收到“等待确认”提醒，但客户端并没有弹窗？**
这是启发式判断：工具已被自动批准、但运行时间超过 `approvalWaitSec`（例如较慢的 Bash 命令）也会触发。调大 `approvalWaitSec` 或设为 `0` 可关闭。

**端口被占用？**
`EADDRINUSE` 时修改 `config.json` 的 `server.port`，并用 `--port` 或配置同步修改 Magpie 的 `notifyUrl`。

---

## 📄 License

MIT License © 2026
