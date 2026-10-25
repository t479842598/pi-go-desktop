---
title: 'pi-zcode Architecture'
created: '2026-10-24'
---

# pi-zcode 架构

## L0 摘要

ZCode UI/平台服务通过 V4/RPC 连接 PiGBackendAdapter，PiG 以 JSONL 子进程提供唯一 Agent runtime，ZCode 原生服务继续拥有文件、Git、Worktree、任务分组、备份和远程状态。

## L1 概览

### 技术栈

- Node.js 24、pnpm workspace、TypeScript、React 19、Vite、Electron、ZCode RPC
- PiG `pig --mode rpc` stdin/stdout JSONL runtime（最终目标；本机当前未安装 binary）
- SQLite/ZCode services、Git/Worktree、桌面/浏览器/远程控制和 Android 入口
- 现有 `@pi/runtime` TypeScript Pi SDK 0.87.1 适配代码作为迁移期参考，不作为最终生产 Agent runtime

### 主要模块

- `packages/services`：服务装配、设置、路径、文件、Git、Worktree、任务分组、MCP、备份和平台能力
- `packages/pi-runtime`：当前 PI 适配、会话/模型/Skills/插件投影；将演进为 PiGBackendAdapter、PiGProcessHost 和会话迁移模块
- `packages/shared` / `packages/rpc` / `packages/client`：共享协议、RPC transport 和客户端类型
- `packages/ui` / `packages/web` / `packages/desktop`：ZCode UI、Web、Electron 与远程宿主
- `packages/provider` / `packages/provider-node`：Provider 配置、模型能力与凭据桥接
- `packages/services/src/session/claude-native`：已有 Claude Code 原生会话导入能力，可复用到 canonical session 管线

### 数据流

1. ZCode UI 通过 `ServiceCollection` 和 V4 协议发送命令。
2. `services/src/node.ts` 在 PI 产品路径装配 PiG-backed channels。
3. `PiGBackendAdapter` 启动/管理 `pig --mode rpc`，将命令编码为 JSONL，并把响应/事件归一化为 V4 snapshot/delta/ACK。
4. PiG 读写 `~/.pi-web/pig-agent` 下的 models/auth/settings/extensions/skills/sessions；ZCode 原生服务继续管理其自身数据域。
5. 六类外部会话先经 source adapter 生成 canonical session v3，再原子写入 PiG sessions，随后由 PiG 实际打开、继续和导出验证。

## L2 详情

### 目录结构

```text
packages/
  pi-runtime/src/        PiG adapter、进程 host、canonical session、V4 projection
  services/src/          ZCode 服务、路径、文件/Git/任务/MCP/备份
  shared/src/            V4/RPC/shared types
  rpc/ client/           transport 与 client contracts
  ui/ web/ desktop/      产品入口与平台宿主
  provider/ provider-node/ 供应商与配置桥
```

### 关键设计约束

- Agent engine 与产品宿主分离：PiG 负责 Agent/Provider/Tool/Extension，ZCode 负责产品服务和 UI。
- PiG RPC 是内部边界；前端只依赖 ZCode V4 协议。
- PiG 事件可能是跨进程 snapshot，adapter 必须处理 partial-message 去重、终态 `agent_settled`、背压和重连。
- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件/cwd/Git；session、task、worktree ID 不得混用。
- 操作型服务不可用时不能用空结果/成功 ACK 伪装；必须真实实现或返回可识别错误。
- 插件统一按 Pi package/resource/extension 语义管理，区分 User/Workspace scope、trust 和插件 MCP 边界。

### 外部依赖

- PiG 可执行程序及其 JSONL RPC、session v3、provider 和 extension contracts
- ZCode 原生 SQLite schema、Git、Electron/Web/Android/relay 平台
- 六类会话来源的本地文件格式：Pi/Pi Web、Reasonix、Codex、ZCode、DeepSeekharness、Claude Code

---

## 维护说明

- **更新时机**：PiG adapter、数据所有权、跨包边界或平台架构变化时更新。
