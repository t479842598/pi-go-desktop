# pi-zcode

ZCode 的界面，pi 的引擎。

这个仓库 fork 自 `zcode-selfhost/upstream`（ZCode 3.16.2），目标是换掉 ZCode 的 agent
后端，改由 `@earendil-works/pi-coding-agent` 驱动，同时保留 ZCode 的全部界面与交互。

## 当前进度

### 已跑通并验证

```
PI_ENGINE=pi PORT=3030 tsx packages/server/src/entry-http.ts
```

用这个命令启动后，**ZCode 的 Web 界面会完整渲染**（侧栏、项目、会话列表、命令面板），
并且界面发出的 RPC 全部落到 pi 实现上。

| 能力 | 状态 |
| --- | --- |
| ZCode UI 渲染 | ✅ 完整界面，无白屏 |
| RPC 握手（hello/initialize） | ✅ 通过官方 Zod 校验 |
| 会话订阅 + snapshot 帧 | ✅ 合法帧送达 UI |
| 会话列表（sessions-index） | ✅ 侧栏可见 |
| 模型列表 | ✅ 10 个 provider / 100 个模型 |
| 工作区准备 | ✅ readWorkspacePresentation |
| 真实模型流式输出 | ✅ 21 帧（经 WebSocket 直连验证） |
| **从 UI 点发送走完整条链路** | ❌ **未打通**，见下 |

### 未打通的一环

从界面发消息目前走不通。已定位到具体位置：

选中工作区后，ZCode 会弹出 **“选择文件夹”对话框**（`virtual-project-browse`），
它遮住输入框，用户无法完成一次正常发送。这个对话框是 UI 在拿不到可用项目数据时的
退路——真正的解法是让 **`projectService`** 对 pi 生效。

也就是说：**消息链路本身是通的（21 帧流式输出已证明），但 UI 的“进入可会话状态”这一
前置条件还没满足。**

## 为什么这样做

ZCode 的服务端通过一个唯一的注入点产出 `IServiceAccessor`：

```
createLocalServices() / createServerHostServices()   ← 唯一的组装点
        ↓
   ServiceCollection.register(descriptor, instance)   ← Map.set，同名即覆盖
        ↓
   ProxyChannel.fromService(instance)   ← 自动把对象方法映射为 RPC
        ↓
   ChannelServer / MessagePort / WebSocket / relay
```

所以换后端不改 UI，也不碰 `@zcode/rpc` 的二进制协议。用 `PI_ENGINE=pi` 时，
`mountPiAgentService()` 把 `zcode-agent`、`model-selection`、`zcode-session` 三个通道
换成 pi 实现，其余保持 ZCode 原样。

**不动的三层**（省掉协议翻译层的前提）：

1. `@zcode/rpc` —— VQL 序列化 + 13 字节帧头，原样复用
2. `@zcode/ui` —— 40 万行界面，一行不改
3. relay 的分片与 ACK —— 远程控制零改动复用

## 踩过的坑（都在代码注释里）

这些是运行真实 UI 才暴露的，单测看不见：

1. **未知 RPC 成员会杀死整个进程**，不是让单次调用失败。`ProxyChannel` 在 channel
   server 内部抛异常且无人捕获，而 UI 挂载时要订阅十几个 `onDynamic*` 事件。
   `withServiceFallbacks()` 兜住它们；方法仍然明确拒绝，让缺口可见。
2. **动态事件与普通事件元数不同**。`onDynamicXxx(param)` 返回一个 `Event`，再传 listener
   调用（两次调用）；`onXxx` 本身就是 `Event`（一次调用）。弄反会得到
   `source is not a function`。
3. **命令名在 `envelope.type`，不在 `payload.type`**。读错字段让所有命令看起来是
   undefined，`createSession` 永远拿不到会话 id，UI 无限重试却从不发消息。
4. **`createSession` 的 ACK 要从 `result.sessionId` 取**，顶层 `message` 会被忽略。
5. **远端存储身份会让 `prepareSession` 强要 projectId**（`project.remote-project-required`）。
   pi 引擎工作在普通本地目录，所以 `PI_ENGINE=pi` 时不传 `projectStorageHostId`。
6. **`readWorkspacePresentation` 失败会 throw**，整个工作区准备流程中断，composer
   永远停在 connecting。

## 协议映射

| pi | ZCode row |
| --- | --- |
| user message | `userInput` |
| assistant text block | `assistantText` |
| thinking block | `reasoning` |
| toolCall block | `toolCall` |
| toolResult message | 同一个 `toolCall` 行，回填输出 |
| `Agent` 工具调用 | `subagent`（独立行） |

一次 prompt = 一个 `turnHeader`，`agent_end` 关闭它。
pi 没有消息 id，投影按 `role:timestamp` 派生稳定 key，流式文本走 `row.delta` 只发增量。

## 验证方式

```bash
# 单元测试（12 个，含官方 Zod 契约校验）
fnm exec --using=24.18.0 npx tsx --test packages/pi-runtime/src/v4/*.test.ts

# 类型检查
fnm exec --using=24.18.0 npx tsc --noEmit -p packages/pi-runtime/tsconfig.json

# 真实链路冒烟（需要先起 server）
PI_ENGINE=pi PORT=3030 tsx packages/server/src/entry-http.ts
PORT=3030 SMOKE_TEXT="say hi" tsx packages/pi-runtime/src/smoke/ws-smoke.ts
```

注意：仓库要求 Node >= 24（`.nvmrc`），系统 Node 22 过不了引擎检查。

## 下一步

**最近的下一步是 `projectService`**，它解锁“从 UI 发送”这最后一环：

1. `projectService`：(a) 让工作区选择返回 pi 的项目而非弹“选择文件夹”；(b) 让
   `prepareSession` 给出可用的草稿目录
2. `zcodeTaskService`：侧栏任务列表（目前显示的是 ZCode 自己的历史记录）
3. 之后才是 P1–P6（会话全功能、外围面板、主题桥接、Electron 壳、远程中继、裁剪发布）

## 已知空缺

- 只有 `zcode-agent` / `model-selection` / `zcode-session` 三个通道是 pi 的，其余 55 个
  通道未注册，调用会抛 `Service not implemented by the pi host yet`
- workflow / plan / fileRewind 系列返回空（pi 没有对应概念，只读无状态查询，空是合法答复）
- 附件上传未实现
- 队列只在内存，host 重启即丢（pi-web 用侧车文件解决过，需要移植）
- fork 未接线。注意 pi-web 踩过的坑：`fork()` 原地改会话状态，fork 后必须立刻销毁旧
  wrapper，否则后续 fork 会产出损坏的 parentSession 链
