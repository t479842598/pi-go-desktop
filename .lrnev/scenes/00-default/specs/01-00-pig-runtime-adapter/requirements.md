---
spec: 01-00-pig-runtime-adapter
scene: 00-default
status: ready
priority: P0
created: "2026-10-24"
updated: "2026-10-24"
---

# 01-00 Pig Runtime Adapter - 需求

## L0 摘要

以 PiG JSONL RPC 完全替代 TypeScript Pi Agent runtime，同时保持 ZCode V4 服务契约稳定。

## L1 概览

### 目标

PiG 成为唯一生产 Agent 底层。ZCode UI、V4 协议和原生服务继续作为产品宿主；所有 Agent 创建、prompt、工具、模型调用、事件流、恢复和扩展运行都经 PiG 子进程及 adapter 完成。旧 TypeScript Pi runtime 仅可用于迁移期离线读取，不得保留为运行 fallback。

### 用户故事

- 作为 ZCode 用户，我希望会话由 PiG 驱动且 UI/API 契约不变，以便完整保留桌面、Web 和远程工作流。
- 作为维护者，我希望 PiG 进程故障、重连和协议错误有明确状态与诊断，以便会话不会静默丢失或被重复执行。

### 范围

**包含**：

- PiG 子进程生命周期、JSONL stdin/stdout、命令响应关联、事件归一化、partial snapshot 去重、重连与背压。
- ZCode V4 命令/事件与 PiG RPC/事件的映射，覆盖 prompt、abort、state、model、fork/tree、compact、queue、tools、approval、extension UI 和 bash。
- PI 专属数据目录配置与生产构建中旧 TypeScript AgentSession 路径的移除门禁。

**不包含**：

- 六类外部会话格式的 parser/importer（归 `02-00-multi-source-session-migration`）。
- PiG 自身未提供的跨产品 UI 和 ZCode 原生文件、Git、Worktree、SQLite 服务的替代实现。

## L2 详情

### 详细需求

#### F-01 PiG 唯一 runtime

- 描述：生产 Agent 请求全部经 PiG RPC 子进程；V4 前端不得直接接触 PiG wire 协议。Desktop 安装包必须包含固定 PiG 版本的目标平台可执行文件，packaged Host 必须显式指向该文件。
- 验收：WHEN PI runtime 初始化并收到新会话/发送请求 THEN 命令由 PiG 子进程执行且返回可关联的 V4 ACK/事件；最终生产构建不存在 TypeScript AgentSession 创建/运行路径；正式 Desktop 产物含可运行的固定版本 PiG 二进制。

#### F-02 RPC 与 V4 事件映射

- 描述：adapter 对 PiG JSONL 响应和事件做 framing、response-id correlation、状态生命周期转换和错误归一化。
- 验收：WHEN PiG 返回 accepted/queued 并随后发出 agent_settled THEN V4 状态先保持 busy/queued，收到终态后才结束；重复或乱序 partial snapshot 不产生重复消息。

#### F-03 故障与恢复

- 描述：支持子进程关闭、无效 JSONL、超时、管道背压、客户端重连及 session 重开，并通过 ZCode 服务事件可见。
- 验收：WHEN PiG 异常退出或连接中断 THEN 所属会话进入明确错误/恢复状态，不误报成功、不静默丢弃已接受命令，也不自动重复执行不确定命令。

#### F-04 专属数据目录

- 描述：所有 PiG runtime/config/session/resource 路径从单一配置源解析，生产根目录为 `<ZCode data root>/pig-agent`。
- 验收：WHEN PiG host、会话列表、模型/认证、插件/技能与导入导出同时读取目录 THEN 均解析到同一 pig-agent 根，且不会写入 `~/.pi/agent`。

#### F-05 唯一底层发布门禁

- 描述：清除生产路径对旧 TypeScript Pi runtime 的创建与 fallback，只保留迁移期离线解析入口。
- 验收：WHEN 构建产物和架构依赖扫描完成 THEN 生产 Agent 调用只指向 PiG adapter，旧 Pi SDK 不可从生产服务装配路径到达。

### 非功能性需求

- 性能：prompt 命令 ACK 与事件转发不引入无界缓冲；测试记录 spawn、首事件与 settled 的耗时基线，不预设未测数字。
- 兼容性：Node 24+、macOS/Windows/Linux；Desktop continuous 与远程 replayable 两种 stream 语义均保留。

### 边界与依赖

- PiG executable/RPC 具体版本、命令字段和扩展能力需通过锁定版本与 fixture 确认；当前本机未安装 PiG binary。
- 依赖 ZCode V4 `IZCodeAgentService`/`ServiceCollection` 契约，以及后续多来源会话 Spec 的 canonical PiG session v3。
- 不修改或重置目标仓库已有未提交改动；新 adapter 与现存 `packages/pi-runtime` 逐步并行替换，但不可保留双运行时生产 fallback。

### 验收标准

- [ ] mock PiG RPC golden traces 覆盖 response correlation、accepted/queued/settled、tool/bash/approval、abort、错误、重连和背压。
- [ ] ZCode V4 service contract 与真实 UI 发送/恢复 E2E 通过。
- [ ] macOS / Windows / Linux production Desktop 产物包含与目标 GOOS/GOARCH 匹配的固定 PiG 二进制；packaged Host 的 `PIG_EXECUTABLE` 指向安装包资源目录，资源缺失时构建或启动明确失败，不查询用户 PATH。
- [ ] 专属目录测试证明所有生产 PI 数据读写到 pig-agent 根，旧 `~/.pi/agent` 只读。
- [ ] 最终生产构建无 TypeScript Pi AgentSession 创建或 fallback；PiG 为唯一生产 runtime。
