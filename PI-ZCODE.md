# pi-zcode

ZCode 的界面，pi 的引擎。

这个仓库 fork 自 `zcode-selfhost/upstream`（ZCode 3.16.2），目标是换掉 ZCode 的 agent
后端，改由 `@earendil-works/pi-coding-agent` 驱动，同时保留 ZCode 的全部界面与交互。

## 当前状态：P0 骨架已完成

P0 的目标是打通一条垂直切片——一条消息能从输入走到流式输出——用来证伪最大的技术
风险：**pi 的会话事件能否投影成 ZCode 的 conversation 帧**。答案是能，且已验证。

### 已完成

| 成果 | 位置 |
| --- | --- |
| pi 会话管理（打开/创建/订阅/销毁） | `packages/pi-runtime/src/session-host.ts` |
| 会话文件定位（UUID → 文件 + cwd） | `packages/pi-runtime/src/session-locator.ts` |
| pi 消息 → ZCode row 投影 | `packages/pi-runtime/src/v4/projection.ts` |
| snapshot 构造（填满 ZCode 的必需结构） | `packages/pi-runtime/src/v4/snapshot.ts` |
| 帧装配（snapshot / deltas，seq + revision） | `packages/pi-runtime/src/v4/frames.ts` |
| 事件桥（AgentSession 事件 → 投影） | `packages/pi-runtime/src/v4/conversation-projection.ts` |
| `IZCodeAgentService` 的 v4 面实现 | `packages/pi-runtime/src/v4/pi-agent-service.ts` |
| 服务装配（注册到 `zcode-agent` 通道） | `packages/pi-runtime/src/services-assembly.ts` |

### 验证结果

`pnpm --filter @pi/runtime test` 等价命令：

```bash
fnm exec --using=24.18.0 npx tsx --test packages/pi-runtime/src/v4/*.test.ts
```

12/12 通过，`tsc --noEmit` 零错误。关键断言：

- **snapshot 通过 ZCode 官方 Zod schema 校验**（空态、带文本行、带工具行三种）
- **deltas 帧通过校验**，且流式文本走 `row.delta` 增量而非整行重发
- **真实 pi 会话**能 subscribe 并发出合法的 opening snapshot
- **`zcode-agent` 通道**可通过 `ServiceCollection` 按真实 channel 名解析

这些测试跑在临时目录里，不会碰开发者的真实会话。

## 为什么这样做

ZCode 的服务端通过一个唯一的注入点产出 `IServiceAccessor`：

```
createLocalServices() / createServerHostServices()   ← 唯一的组装点
        ↓
   ServiceCollection.register(descriptor, instance)
        ↓
   ProxyChannel.fromService(instance)   ← 自动把对象方法映射为 RPC
        ↓
   ChannelServer / MessagePort / WebSocket / relay
```

所以换后端不需要改 UI，也不需要碰 `@zcode/rpc` 的二进制协议。注册 pi 实现即可。

**不动的三层**（这是省掉"协议翻译层"的前提）：

1. `@zcode/rpc` —— VQL 序列化 + 13 字节帧头，原样复用
2. `@zcode/ui` —— 408k 行界面，一行不改
3. relay 的分片与 ACK —— 远程控制零改动复用

## 协议映射

pi 的消息块与 ZCode 的 row 几乎一一对应：

| pi | ZCode row |
| --- | --- |
| user message | `userInput` |
| assistant text block | `assistantText` |
| thinking block | `reasoning` |
| toolCall block | `toolCall` |
| toolResult message | 同一个 `toolCall` 行，回填输出 |
| `Agent` 工具调用 | `subagent`（独立行，不是工具卡） |

一次 prompt = 一个 `turnHeader`（`beginTurn`），`agent_end` 关闭它。

pi 没有消息 id，所以投影按 `role:timestamp` 派生稳定 key——`message_update` 反复重发
整条消息时，更新会落到同一行而不是新建行。

## 已知空缺

这些在 P0 是有意的，不是遗漏：

- **只有 `zcode-agent` 通道是活的。** 其余 57 个通道（设置、文件、git、插件、skills、
  MCP、任务）未注册，调用会抛 `Service not registered`。这是刻意选的行为：明确的缺口
  好过返回貌似合理的空数据。
- **workflow / plan / fileRewind 系列返回空。** pi 没有对应概念，这些是只读无状态查询，
  返回空是合法答复而非撒谎。UI 侧对应入口在 P2 会隐藏。
- **附件上传未实现。** `attachmentBegin/Chunk/Commit` 还没有。
- **队列只在内存。** pi 的 steer/follow-up 队列不持久化，host 重启即丢。pi-web 用
  `lib/queue-store.ts` 的侧车文件解决过这个问题，需要移植。
- **fork 未接线。** 必须注意 pi-web 踩过的坑：`fork()` 会原地改会话状态，fork 后必须
  立刻销毁旧 wrapper，否则下一次请求拿到的是已 fork 的状态、后续 fork 会产出损坏的
  parentSession 链。

## 下一步（P1–P6）

见 `docs/adr/` 与仓库根的进度记录。优先顺序：

1. **P1 会话全功能** —— `zcodeTaskService`（会话列表/树）、分支、队列持久化、审批、子代理
2. **P2 外围面板** —— 保留 pi-web 的既有功能，按 ZCode 的信息架构重排入口
3. **P3 主题桥接** —— 把 pi 的 25 套主题映射到 ZCode 的 ~200 个语义 token
4. **P4 Electron 壳** —— 沿用 ZCode 桌面壳，重做 pi-web 已解决的 Windows 平台适配
5. **P5 远程控制** —— 桌面作 device 连自建 relay（注意：必须用 v1 HMAC 协议，不是 v2）
6. **P6 裁剪与发布** —— 移除 ZCode 专有入口，处理 Apache-2.0 / MIT 许可合规

## 本地开发

```bash
fnm exec --using=24.18.0 pnpm install
fnm exec --using=24.18.0 pnpm --filter @pi/runtime exec tsc --noEmit -p tsconfig.json
```

注意：仓库要求 Node >= 24（`.nvmrc`），系统 Node 22 无法通过引擎检查。
