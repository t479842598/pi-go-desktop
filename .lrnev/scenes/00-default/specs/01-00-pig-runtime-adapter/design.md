---
spec: "01-00-pig-runtime-adapter"
scene: "00-default"
created: "2026-10-24"
---

# 01-00 Pig Runtime Adapter - 设计

## L0 摘要

用 PiG 子进程实现唯一 Agent runtime，并通过 adapter 保持 ZCode V4 契约及 PI 专属数据目录一致。

## L1 概览

### 架构思路

ZCode 服务装配层只依赖统一的 `PiGBackend` 接口。Node host 管理一个 PiG RPC 子进程（后续按宿主/窗口生命周期确定复用范围）；adapter 负责 JSONL framing、请求 id correlation、事件规范化、V4 projection 输入和 shutdown。UI、V4 协议和 ZCode 原生服务不直接依赖 PiG RPC schema。

正式目录由 `packages/services/src/paths.ts` 的 ZCode data root 派生为 `pig-agent`；runtime、session index、模型/认证/资源、迁移器共享同一个 resolver。Desktop 构建固定 PiG Go module 版本，按 `ZCODE_TARGET_OS` / `ZCODE_TARGET_ARCH` 编译到 `bundled-tools/<platform>/pig/pig[.exe]`，并复制到安装包 `resources/tools/pig`。Host 从 `process.resourcesPath` 注入绝对 `PIG_EXECUTABLE`；production 缺失资源仍固定指向预期随包路径并启动失败，不退回用户 PATH。开发/Server 可用显式 `PIG_EXECUTABLE` 或 PATH；测试注入 fake executable。

### 主要模块

- `packages/pi-runtime/src/pig/`: `PiGBackend`、process host、JSONL decoder、RPC correlator、event normalizer。
- `packages/pi-runtime/src/v4/`: 保留 V4 服务/投影，由 normalized PiEvent 驱动；逐步移除现有 `AgentSession` 直接引用。
- `packages/services/src/paths.ts`: PiG 专属 agent/session root 的唯一 resolver。
- `packages/services/src/node.ts` 与 `packages/pi-runtime/src/mount.ts`: PI 产品装配 PiG 服务；不修改 ZCode 默认 Agent 服务路径。
- `packages/pi-runtime/test/` 或包内 `*.test.ts`: fake PiG JSONL fixture 和契约测试。

### 关键决策

| 决策          | 选项                                                          | 倾向                                                   | 是否产 ADR                                     |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| Agent runtime | in-process TypeScript Pi / PiG JSONL subprocess               | PiG 唯一生产 runtime，TypeScript Pi 只保留离线迁移需要 | 是，重大底层替换；执行前按治理约定取得用户确认 |
| 数据根        | 共用 `~/.pi/agent` / PI 专属 ZCode data root 下的 `pig-agent` | PI 专属目录，旧目录只读导入                            | 是，数据所有权与迁移边界                       |

### L2 详情

### 模块详细设计

#### D-01 PiG process host

创建 child process 时设置 `PIG_CODING_AGENT_DIR` 为统一 resolver 的绝对路径，stdin/stdout 按行处理，stderr 独立进入 ZCode service logger。host 保留进程状态、pending request 表和 listener 集合；dispose 时拒收新命令、发送 PiG shutdown（若协议支持）、超时后关闭进程并 reject 未完成请求。Desktop production 从 `process.resourcesPath/tools/pig` 解析固定随包二进制，缺失时启动失败并给稳定错误码，不回退到 PATH 或旧 AgentSession；开发/Server 可从显式配置或 PATH 查找。

#### D-02 JSONL RPC correlator

每个 request 使用唯一 id；解析响应后按 id 结算 promise。事件无 id 时作为通知投递；未知响应 id、无效 JSON 行、stderr 和退出码进入诊断通道。stdout buffer 以换行拆帧并保留不完整尾块；单帧与待处理请求均设界限，避免无限内存增长。prompt 接受 ACK 不代表 turn 完成，最终以 `agent_settled` 或明确失败事件结算运行态。

#### D-03 V4 event normalization

将 PiG message/tool/bash/queue/compaction/retry/approval/extension UI/session 事件投影为现有 `PiEvent` vocabulary，再交给 V4 projection。跨进程 partial message 可能是快照而非 delta，adapter 以 session + message key + sequence/digest 去重/覆盖，不把快照重复追加。V4 topic、snapshot/delta、deliveryKind 和 sequence 仍由 ZCode adapter 维护。

#### D-04 路径与生产装配

`getPiGAgentDir()` 派生自 ZCode PI data root，`getPiGSessionDir()` 派生自 agent dir。配置注入 runtime、session list、model/auth/resource services。PI 引擎分支装配 PiG backend；运行时端口不得将 TypeScript `AgentSession` 当作 fallback。迁移期旧 adapter 文件可留在工作树供离线转换使用，但最终生产依赖图必须移除。

### 数据模型

- `PiGProcessState`: `starting | ready | stopping | exited | failed`。
- `PendingRpc`: request id、command、deadline、resolve/reject；settled 后立即删除。
- `PiGEvent`: raw event type/payload 与 monotonic local receive sequence；仅 adapter 持有 raw payload。
- Session registry: PiG session id → cwd/workspace identity/active subscription metadata，不把 ZCode task id 当作 PiG session id。

### 接口契约

`PiGBackend` 至少提供 `start()`、`request(command, payload, signal?)`、`subscribe(listener)`、`getState(sessionId)`、`shutdown()`。PI service 使用此接口，不调用 child_process 或 parse JSONL。V4 service 对外 schema 不变。路径 helper 返回绝对目录；调用者不能自行拼 `~/.pi/agent`。

### 错误处理

- binary 缺失/无法启动：启动错误并保留 PI 服务不可用状态；不 fallback 到 TypeScript Pi。
- 非法 JSONL、未知 response id、command timeout：拒绝对应请求、记录脱敏诊断，继续读取后续合法帧。
- 子进程意外退出：所有 pending 请求以 `pig-process-exited` 结算，广播 runtime lifecycle；由调用方显式重建/恢复，不能自动重发非幂等命令。
- 重连恢复只恢复查询/订阅；prompt 等写命令必须基于 request id/持久 admission 状态判断是否可安全重试。

### 测试策略

使用可注入 fake executable 或 in-memory line transport；测试 split UTF-8/chunk 行、多个响应、事件无 id、accepted→settled、乱序响应、未知 id、无效 JSON、背压/超长行、abort、退出、stderr 脱敏、dispose 与 pending reject。service contract 测试验证 normalized events 仍产出合法 V4 wire frame；路径测试覆盖 ZCODE_DATA_BASE_DIR、PI data root 与 sessionDir 注入。
