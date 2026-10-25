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

## 2026-10-24 状态：打包桌面版 + 远程中继全通

- `/Applications/PI.app` v0.19.2（appId dev.pi.app）已装可用；数据源=pi 已验证（modelSelectionView providers=10+，composer 全功能）。
- **启动四层坑**（全修复并固化进构建配置）：asar 悬空符号链接、userData 身份撞 ZCode 单实例锁（`__ZCODE_PRODUCT_NAME__` define 按 resolveDesktopProductIdentity 注入 main+vite）、ARMS init 劫持首窗（PI 关闭上报 + 3s 超时）、`@pi/runtime` 闭包缺包（REQUIRED_ASAR_RUNTIME_MODULES/bundle.mjs 校验名单）。
- **免登录**：pi-runtime `oauth-service.ts` 恒返回 authenticated 本地用户。
- **数据分离**：`getZCodeDataRootDir()` 按 PI_ENGINE 走 `.pi-web`；settingService bootstrap 原硬编码 `~/.zcode/v2/setting.json` 已改走 getAppConfigDir()。PI 数据全在 `~/.pi-web`。
- **远程中继（zcode.tang74.top 同一套）端到端验收通过**：设备身份按数据根独立（不再与 ZCode 互踢）；远程任务列表=pi 会话（host resolveTasks 分支）；会话标题=头部扫描+session_info 优先；resync 恢复契约=ACK 必须伴随 `deliveryKind:"recovery"` 帧（`wrapRecovery`/`emitRecoverySnapshot`），否则空闲流必报 recoveryFrameTimedOut。
- **设置页**：skills 分区接 pi（`skills-service.ts`，SKILL.md 双根扫描 + disable-model-invocation 翻转）；模型分区在 PI 下渲染 `PiModelsSettings`（读 models.json/auth.json/runtime）；ZCode 专有分区（memory/subagents/plugin/mcp/commands/hooks/remoteDevices/computerUse/backup/usage/archives）按 `__ZCODE_PRODUCT_NAME__` 在构建期裁掉（lib/settingsNavigation.ts）。
- 未竟：ZCode SettingsView 深度编辑（provider 配置编辑器）、插件市场 UI、Windows 打包验证、G 的许可合规与发版。

## 2026-10-24 午后：Pro 编辑器接管（用户需求：直接搬 ZCode 的，配 PI 数据）

`packages/pi-runtime/src/provider-settings-service.ts` 实现完整 `IProviderSettingsService`，ZCode 的 Pro 编辑器原样使用：
- **数据层**：复用 `NodePersonalProviderConfigRepository`（同一 provider_config.json），编辑走 ZCode 原生写入/加锁。
- **双向同步**：启动时 models.json→overlay 导入（`group: "standard-personal"` 必须设置，否则 UI 表单投影过滤掉全部 provider）；每次变更 overlay→models.json 合并回写并刷新 model-selection。
- **安全设计（两次真实事故换来的）**：导出用**合并语义**（现有内容为基底，永不重建整个 providers 对象）；**白名单**只认 pi 命名空间 id（导入原样 id / `pi-` 前缀，UUID 形态拒绝）；导出投影剥离 ZCode 字段（enabled/properties/optionSpecs 不落 pi 文件）；删除登记 deleted 集合、只删目标。
- **验收**：UI 改 baseUrl→"保存成功"→models.json 秒级同步；模型编辑器（ID/上下文/最大 Token/智能配置）完整；幂等+删除隔离+12/12 测试。
- ⚠排障教训：测试同步必须 `PI_ENGINE=pi`（否则 getAppConfigDir 回落 .zcode，写的不是应用的 overlay），且先杀净所有 PI 进程（旧实例 2s 轮询会洗掉测试写入）。

## 2026-10-24 傍晚：新中继 pi.tang74.top 上线 + 功能补齐

**新中继（阿里云 182.92.127.90）**：
- relay 实例 `/opt/pi-relay`（systemd `pi-relay`，127.0.0.1:8788，独立 devices.json）
- nginx `pi.tang74.top`：443(acme.sh 证书) + /ws→8788 + /api/→zcode.z.ai 反代 + /remote/v4 静态
- 桌面默认已切 `wss://pi.tang74.top/ws`；实测：连接稳定(0 重连)、配对、任务列表、历史渲染、发送→引擎执行→思考块流回全部通过
- **关键坑：现役 web 源码是 V2 token 制**（parse ExternalQrParams 见 hash/t 即 null；设备列表强依赖 JWT），与桌面的 V1(sid/hash/t) relay 桥不兼容。**解法=克隆 zcode 站现役 V1 产物到 pi 域并 sed 重写域名**（/tmp/pi-clone-v1.sh，保留 .orig）。V2 web 免登录改造（已起头：webRemoteControlEntry piPairing 跳过首页 JWT）是后续工作，完成后 PI 新 UI（主题菜单/会话数据/分区裁剪）才能上远程站——桌面端不受影响已全部就绪。
- 远程站入口 HTML 已加 no-cache。

**功能补齐（桌面端已入包 v17+）**：
- 主题切换：侧栏底部 Palette 菜单新增「PI 主题」子菜单（23 套，`html[data-pi-theme]` 覆盖层，localStorage 持久，store 字段 piTheme/setPiTheme）
- 会话导入导出：设置→数据分组→「会话数据」（PiTaskGroupService.exportSessionsData/importSessionsData，883 会话导出实测；导入只写本机不存在的文件）
- 「官方版本动态/官方活动」按 PI 产品隐藏（SettingsPage isPiProduct 分支）
- 草稿署名组件改「PI · 青棠」+ 指向 t479842598/pi-zcode（仓库未建，git 未推）

**未竟（按优先级）**：V2 web 免登录补完（PI UI 上远程站）；插件市场桥接 pi 包管理器；队列导入导出（pi-web QueueRecoveryDialog 同款）；会话 HTML 导出；GitHub 推送/CI/发版（用户暂缓）。

## 2026-10-24 晚：全量收尾（用户指令：全部做完测试完再打包替换）

- **回复失败根因**：打包 asar 缺 `openai` 包（pi-ai 运行时 import，会话文件里 assistant errorMessage 实锤）。已补进 asar 并重装；远程发送"只回复两个字：成功"→ 模型回复"成功"→ 实时流回，会话持久化，全链路闭环。
- **主题预览无颜色根因**：pi-themes.css 的选择器是 `html[data-pi-theme]`，预览卡片是普通 div 挂不进去。generate-pi-themes.mjs 改双选择器（`[data-pi-theme=x].dark` 容器级 + html 级），PiThemePicker 预览块带 `dark` class + `data-pi-theme-mode="dark"`，44 块重新生成。侧栏菜单与外观网格两处入口都在。
- **V2 web 免登录最终结论**：代码层修了三处（首页 gate 键名 bug `t?.sid`→`t?.deviceSid`、shared 解析器 hash 放行 define、getToken hash 透传），但 V2 web 与 V1 桌面桥的**协议代差在 token 交换层**（web 连 /api/v1/remote/ws2 用 JWT 换 token，桌面桥只认 V1 hash）——回退用 V1 克隆产物（实测配对/列表/对话/回复流回全通）。PI 新 UI 上远程站需先做 V1↔V2 桥（未竟）。
- 应用已替换 /Applications/PI.app 并运行中（0 断线 0 错误）；远程站 pi.tang74.top 用 V1 产物。
