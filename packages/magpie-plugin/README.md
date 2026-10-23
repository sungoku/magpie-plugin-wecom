# @magpie-community/plugin-wecom

> [!WARNING]
> 🚧 **开发测试中 · 功能尚未完整（Work in Progress）**
>
> 本插件仍在开发与人工测试阶段，接口、配置项和行为可能随时调整，请勿直接用于生产环境。

> Magpie 的企业微信（WeCom）**管理页面 + 任务完成通知钩子**。

---

## 🌟 它做什么

1. **插件页（`magpie.page`）**
   - 在 Magpie 侧边栏的 Plugins 分组中出现。
   - 读写插件选项：通知开关、最小耗时、等待确认提醒、通知地址、是否自动启动本地网关。
   - 提供“打开管理界面”按钮，跳转到本地网关的完整管理页（`http://127.0.0.1:9099/`）。

2. **任务完成与等待确认通知（`magpie.hooks`）**
   - 运行在 Bun 插件宿主中，可以使用 `fetch`。
   - 一轮 Agent 请求结束后，向本地 `/notify` 推送耗时与**完整结果**（按 UTF-8 上限截断，不再截成 300 字）。
   - 跳过 Claude Code 的 WebSearch / 建议侧调用；只把**客户端**工具调用视为未完成，服务端工具（web_search 等）与最终文本同轮时仍推送最终文本。
   - 带**客户端**工具调用的中间回复不推送；错误回复、失败/不完整的请求、整轮过短的任务会被跳过；thinking/reasoning 不会被当成结果。
   - 客户端工具调用后若 `approvalWaitSec` 秒内没有下一步请求，推送“可能在等待确认/选择”提醒（附命令、文件或问题/选项）；下一个请求到达即取消。企微端只能提醒，不能代替客户端点击。

3. **选项即时生效 + 可选自动启动（`wecom.plugin.js`）**
   - 这是一个不注册任何钩子的 OpenCode 入口。Magpie 只根据 `main`/`exports` 判断“纯页面插件”；
     没有它时，插件页保存选项不会重启 Bun 宿主，通知仍使用启动时的旧值。
   - 有它之后，`magpie.options.set` 走普通 `SetOptions` 路径并重启宿主，新设置从下一轮请求起生效。
   - Magpie 会把插件选项作为第二个参数传给入口；开启 `autoStartService` 时，入口会先检查
     `/health`，再以 detached 方式启动网关（见下文）。

---

## ⚠️ Magpie 插件页的沙箱限制

Magpie 给插件页下发：

```
sandbox="allow-scripts"
default-src 'none'; script-src <页面自己的目录>; connect-src 'none'
```

因此：

- 页面里的内联 `<script>`、`onclick` 会被 CSP 丢弃 → 本项目所有脚本在 `page/app.js`；
- 页面无法访问任何网络地址（包括 `127.0.0.1`）→ 插件页不会尝试 `fetch`；
- `alert()`、`confirm()`、`localStorage` 在沙箱中不可用 → 页面使用内联状态提示和两步删除。

这不是配置问题，而是 Magpie 的固定策略。

---

## 📦 安装

```bash
# GitHub（把 <owner> 换成实际 GitHub 账号/组织）
magpie plugin add github:<owner>/magpie-plugin-wecom

# 本地源码（独立安装本目录）
magpie plugin add ./packages/magpie-plugin
```

从仓库根目录安装时使用根 `package.json`；它把 `page` 指向 `packages/magpie-plugin/page/index.html`，把 `hooks` 指向 `packages/magpie-plugin/wecom.hooks.js`。

---

## ⚙️ 选项

| 选项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | 是否启用任务完成通知 |
| `notifyUrl` | `string` | `http://127.0.0.1:9099/notify` | 本地通知服务地址 |
| `minDurationSec` | `number` | `3` | 整个轮次的最小触发耗时（秒），跨工具调用/侧调用累计 |
| `approvalWaitSec` | `number` | `10` | 工具调用后多少秒没有下一步请求就提醒“可能在等待确认/选择”；`0` 关闭 |
| `gatewayTimeoutMs` | `number` | `3000` | 通知 hook 最长等待时间（毫秒） |
| `autoStartService` | `boolean` | `false` | 网关未运行时，由 Magpie 插件宿主自动启动本地服务 |

```bash
magpie plugin options plugin-wecom '{"minDurationSec": 5, "approvalWaitSec": 10, "notifyUrl": "http://127.0.0.1:9099/notify"}'
```

---

## 🔗 与本地网关的关系

本插件不包含企业微信网关本身。Bot 凭证、Agent 绑定和白名单由 `wecom-agent-bridge` 管理：

```bash
cd ../..
npm install
npm start
# 管理界面 http://127.0.0.1:9099/
```

网关启动后，插件页的“打开管理界面”按钮即可进入完整管理页。

### 自动启动（可选）

在插件页勾选 **“网关未运行时自动启动本地服务”** 并保存后，Magpie 会重启 Bun 宿主，
`wecom.plugin.js` 读取选项并执行：

1. 请求 `notifyUrl` 对应的 `/health`；已经是本网关（`service: "wecom-agent-bridge"`）就不重复启动；
2. 只接受 `http://127.0.0.1` / `localhost` 的通知地址，远程地址直接跳过；
3. 从插件目录向上查找包含 `packages/core/dist/cli.js` 的仓库根目录，用 `process.execPath`
   （即 Magpie 自带的 Bun）以 detached 方式启动：`cli.js --config <root>/config.json --port <端口>`；
4. 子进程 PATH 会补上 `~/.local/bin`、Homebrew 等目录，保证 `claude` 等 Agent 命令可执行；
5. 日志写入 `~/.cache/wecom-agent-bridge/service.log`；服务在 Magpie 退出后继续运行。

约束与边界：

- 默认关闭；取消勾选只阻止以后自动启动，不会停止已在运行的服务；管理页的“停止服务”只断开
  Bot 连接，网关进程仍保留。要结束进程可执行 `lsof -ti tcp:9099 | xargs kill`；
- 需要本仓库已安装依赖；有 `dist/` 时优先运行构建产物，没有时由 Bun 直接运行 `src/cli.ts`；
- 从 npm/GitHub 单独安装本插件目录时，仓库里没有 `packages/core`，自动启动会跳过并写日志；
- 每 60 秒最多尝试一次，启动前一定先做健康检查；端口已被占用时不启动第二个进程，
  避免 `EADDRINUSE` 和重复网关。

---

## 🧪 测试

```bash
node --test packages/magpie-plugin/test/*.test.mjs
```

覆盖：CSP 合规（无内联脚本/事件/CDN）、Magpie 模式不发起 fetch、钩子的工具调用识别（客户端/服务端区分）、侧调用过滤、完整结果与 thinking 过滤、耗时过滤、单轮去重与失败过滤、等待确认计时/取消、通知载荷、清单文件/图标/入口，以及自动启动的 loopback 校验、健康检查、仓库定位、去重与真实 detached 子进程参数（测试使用假 CLI，不启动真实网关）。该目录可以独立复制安装；根目录的 `package.json` 是同一份清单的仓库根版本。
