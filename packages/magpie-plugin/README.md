# @magpie-community/plugin-wecom

> Magpie 网关的企业微信（WeCom）**多 Bot 角色管理 UI 页面与任务自动嗅探中间件**。

---

## 🌟 核心功能

1. **可视化多 Bot 管理面板（Page 插件）**：
   - 直接嵌入 Magpie 桌面侧边栏 **Plugins**。
   - 可视化配置多个企微 Bot、绑定不同 Agent（Claude Code / OpenCode / Shell）、设置人设前缀与权限白名单。
   - 提供服务运行状态显示与一键启停开关。

2. **全自动任务嗅探中间件（Middleware）**：
   - 零侵入监听 Magpie 网关（`127.0.0.1:3425`）的响应流。
   - 当检测到 Agent 思考与工具调用彻底结束时，**自动向手机企业微信推送任务总结与耗时卡片**。

---

## 📦 安装与配置

### 1. 安装插件到 Magpie

通过 GitHub 仓库一键安装：
```bash
magpie plugin add github:sungoku/magpie-plugin-wecom
```

或者本地源码调试安装：
```bash
magpie plugin add ./packages/magpie-plugin
```

### 2. 配置选项

可以通过 Magpie 桌面界面配置，也可以通过 CLI 命令配置选项：
```bash
magpie plugin options plugin-wecom '{"minDurationSec": 5, "notifyUrl": "http://127.0.0.1:9099/notify"}'
```

| 选项名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | 是否启用自动通知 |
| `notifyUrl` | `string` | `http://127.0.0.1:9099/notify` | 本地通知与管理服务接口地址 |
| `minDurationSec` | `number` | `3` | 最小触发耗时（秒），过滤极短的轻量提示请求 |
