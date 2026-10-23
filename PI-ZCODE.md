# pi-zcode 交接

ZCode 的界面，pi 的引擎。fork 自 `zcode-selfhost/upstream`（ZCode 3.16.2）。

## 一句话状态

**协议层完全打通，UI 完整渲染，但"从界面点发送"仍未跑通。** 卡点已精确定位到 ZCode
composer 的提交门禁，不是 pi 侧的问题。

验证方式：`PI_ENGINE=pi PORT=3030 tsx packages/server/src/entry-http.ts` 起服务，
界面完整加载，侧栏列出 pi 的会话与项目，模型选择器显示 `deepseek/deepseek-flash`。

## 已确认可用（不要重复验证）

| 环节 | 证据 |
| --- | --- |
| RPC 握手 | `hello` / `initialize` 通过官方 Zod |
| 会话订阅 | `acknowledged` + `activated`，无 fault |
| snapshot 帧 | wire 格式合法，UI 应用成功 |
| 会话列表 | 侧栏可见 pi 目录派生的项目 |
| 模型列表 | 10 providers / 100 models，`effectiveSelection` 生效 |
| 工作区准备 | `readWorkspacePresentation` 不再阻塞 |
| 引擎本身 | 直连 RPC 发消息，21 帧流式输出 |
| 单元测试 | 12/12 通过，`tsc` 零错误 |

## 卡点：composer 提交门禁

`sendConversationCommandV4` 收得到 `createSession` / `setFollowupMode` / `deleteSession`，
但**从不收到 `sendText`**。发送按钮存在（`v4-composer-send`）且持续 `disabled: true`，
20 秒轮询无变化。

已排除的假设：

- ~~模型列表为空~~ —— `effectiveConfig` 已变为 `{provider: deepseek, model: deepseek-flash}`
- ~~wire 帧格式错误~~ —— 已修复，订阅正常
- ~~phase 报 running~~ —— 已改为 idle，停止按钮已变回发送按钮
- ~~sessionId 传递丢失~~ —— 已从 `envelope.sessionId` 读取，命令带上了正确 id

剩余候选（未验证）：

1. `submissionReady` —— composer 内部状态，来源未追踪到
2. 草稿会话每 ~8 秒重建一次，可能在提交落地前重置 composer
   （时序：`createSession` ×2 → `deleteSession` ×1 → 循环）
3. `attachmentsReady` —— `attachmentsApi.hasUnreadyAttachments`

**注意**：`disabled` 与 `canSend` 是两个独立条件。`disabled` 来自 `SessionPane`
传入的 `connecting || draftRuntimeRebuilding || queueEditActive || quotaBanner.blocksSubmit`；
`canSend` 来自 composer 内部。当前 `disabled: true` 说明是**前者**，不是 composer 内部。

下一步应从 `SessionPane.tsx:5443` 的 `disabled` 表达式入手，逐个排除那四个因子。
`draftRuntimeRebuilding` 最可疑，因为它与观察到的 8 秒重建循环吻合。

## 一轮里修掉的 10 个真实缺陷

全部是运行真实 UI 才暴露的，单测看不见。按发现顺序：

1. **未知 RPC 成员杀死整个进程** —— `ProxyChannel` 在 channel server 内抛异常无人捕获，
   UI 挂载订阅十几个 `onDynamic*`。`withServiceFallbacks()` 兜底。
2. **动态事件与普通事件元数不同** —— `onDynamicXxx(p)` 返回 Event 再传 listener（两次调用）；
   `onXxx` 本身是 Event（一次）。弄反得 `source is not a function`。
3. **命令名在 `envelope.type`** —— 不在 `payload.type`。读错让所有命令看起来是 undefined。
4. **`createSession` 的 id 在 `result.sessionId`** —— 顶层 `message` 被忽略，UI 无限重试。
5. **远端存储身份让 `prepareSession` 强要 projectId** —— `PI_ENGINE=pi` 时不传
   `projectStorageHostId`。
6. **`readWorkspacePresentation` 失败会 throw** —— 工作区准备中断，composer 永久 connecting。
7. **`runtimeInitialization` 缺失被判为未就绪** —— snapshot 必须显式给 `{status: "ready"}`。
8. **帧必须是 wire 格式** —— `onDynamicConversationFrame` 载的是 `...WireCandidate`；
   裸帧被判为 invalid payload → content fault → 丢弃草稿绑定。
9. **命令目标是 `envelope.sessionId`** —— 外层 `params.sessionId` 恒为 null。
10. **新会话是 idle 不是 running** —— phase 错报让 composer 显示停止按钮而非发送按钮。

另外两个形状错误（会让 UI 丢弃整个 model view）：

11. `optionSpecs.*.map` 是 CEL 表达式**字符串**，不是对象。
12. `providerName` 是普通 id 字符串，不是本地化 map。

## 代码地图

```
packages/pi-runtime/src/
  session-host.ts              活会话注册表
  session-locator.ts           UUID → 文件 + cwd
  session-list.ts              会话摘要扫描（头尾有界读）
  session-service.ts           readWorkspacePresentation
  project-service.ts           项目由会话目录派生
  model-selection.ts           pi 模型 → ZCode view
  service-fallbacks.ts         缺失成员兜底（事件返回空订阅）
  v4/
    projection.ts              pi 消息 → ZCode row
    snapshot.ts                snapshot 构造（宽对象，字段多）
    session-view.ts            会话状态适配
    frames.ts                  裸帧 + wire 包装
    conversation-projection.ts 事件桥 + 订阅生命周期
    pi-agent-service.ts        IZCodeAgentService 的 v4 面
```

装配点：`packages/services/src/node.ts` 的 `mountPiAgentService()`，
`PI_ENGINE=pi` 时替换 `zcode-agent` / `model-selection` / `zcode-session` / `project` 四个通道。

## 开发命令

```bash
# 依赖（Node >= 24，.nvmrc）
fnm exec --using=24.18.0 pnpm install

# 测试 + 类型
fnm exec --using=24.18.0 npx tsx --test packages/pi-runtime/src/v4/*.test.ts
fnm exec --using=24.18.0 npx tsc --noEmit -p packages/pi-runtime/tsconfig.json

# 起服务（3030 便于 Vite 默认代理）
PI_ENGINE=pi PORT=3030 fnm exec --using=24.18.0 npx tsx packages/server/src/entry-http.ts

# 前端
cd packages/web && npx vite --port 5199

# UI 验收（playwright 在兄弟仓库 pi-web-QT 里）
cd ../pi-web-QT && NODE_PATH=$PWD/node_modules node <脚本路径>
```

## 剩余工作

- **A（当前）** composer 门禁 — 见上文候选
- **B** 会话全功能：分支 fork/navigate、队列持久化、审批、子代理
- **C** 设置面板：provider 配置、插件、skills、MCP
- **D** 主题桥接：pi 25 套 → ZCode 语义 token
- **E** Electron 壳：Win + macOS
- **F** 远程：桌面 device + 自建 relay（用 v1 HMAC，不是 v2）
- **G** 裁剪 ZCode 专有入口 + 许可合规 + 发版
