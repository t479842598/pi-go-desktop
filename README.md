# PI

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="PI" width="128" height="128" />
</div>

> **PI 是基于 [ZCode](https://github.com/zai-org/ZCode) 源码改造的 AI 编程工作台。**
> 界面、桌面壳、远程控制、文件 / Git / 任务等宿主能力来自 ZCode；
> **Agent 底层被完整替换为 [PiG](https://github.com/MichaelKinsy/PiG)（Pi in Go）**，
> 一个用 Go 重写的 Pi 编码 Agent。旧的 TypeScript Pi runtime 已不在生产路径上。

当前版本 **0.19.2**，仅发布 macOS arm64。

---

## 一句话架构

```
┌─────────────────────────────────────────────────────────┐
│  ZCode 产品层（保留）                                    │
│  Desktop (Electron) · Web · 手机远控 · 设置 · 任务分组    │
│  文件 / Git / Worktree / SQLite / 备份 / relay           │
└───────────────────────┬─────────────────────────────────┘
                        │ ZCode V4 RPC（前端唯一协议）
┌───────────────────────▼─────────────────────────────────┐
│  PiG Adapter（packages/pi-runtime）                      │
│  PiGSessionHost · PigProcessHost · V4 事件归一化          │
└───────────────────────┬─────────────────────────────────┘
                        │ stdin/stdout JSONL（`pig --mode rpc`）
┌───────────────────────▼─────────────────────────────────┐
│  PiG（Go）                                               │
│  Agent loop · Provider · Tool · Extension · Session      │
└─────────────────────────────────────────────────────────┘
```

**关键边界**：UI 永远不接触 PiG 的 wire 格式。V4 的 snapshot / delta / ACK 全部由
adapter 维护，PiG 的 JSONL 只存在于 `packages/pi-runtime/src/pig/` 内部。

---

## 底层：PiG

### 版本锁定

| 项                    | 值                                         |
| --------------------- | ------------------------------------------ |
| Go module             | `github.com/MichaelKinsy/PiG`              |
| 固定 commit           | `b6d8ab0bfab082857274770e69eda0d477b263b2` |
| module pseudo-version | `v0.3.1-0.20261025020319-b6d8ab0bfab0`     |
| CLI `--version`       | `0.5.3+1.4.0.74f46864`                     |
| Go toolchain          | `1.27.3`（CI 显式 `actions/setup-go`）     |

版本是三段独立标识，不能混用：

- **module pseudo-version** 锁定源码输入（`go install` 用）；
- **Build SHA**（`b6d8ab0bfab0`）由 `-ldflags -X .../coding/cli.Build=` 注入；
- **CLI 版本** 是 `PigVersion + "+" + UpstreamVersion`，由固定源码里的
  `internal/coding/pigversion/pigversion.go` 决定。

### 随包方式

安装包内的位置：

```
PI.app/Contents/Resources/tools/pig/pig
```

构建链（`packages/desktop/scripts/prepare-pig-runtime.mjs`）：

1. 来源优先级：`PIG_EXECUTABLE`（显式二进制）→ `PIG_SOURCE_DIR`（本地源码）
   → 固定 Go module（`go install`）。
2. 写入 `<stage>.tmp-<pid>`，校验通过后才原子 `rename` 到目标位置，
   避免失败时留下半成品。
3. 校验分两层：
   - `go version -m` 检查 `path` / `mod` / pseudo-version —— 所有目标平台都做；
   - 执行 `pig --version` 检查 CLI 版本 —— 仅当目标平台等于当前 host 时做
     （交叉编译时不能执行）。
4. 任一校验失败即构建失败，不会把错版本打进包。

### 运行时解析

`packages/desktop/src/main/desktopRuntimeEnv.ts`：

- **packaged 态**：无论文件是否存在，`PIG_EXECUTABLE` 都固定指向
  `process.resourcesPath/tools/pig/pig`。缺失时启动即失败，**不回退系统 PATH**，
  也不回退旧 TypeScript runtime。
- **开发态**：`resolveBundledRuntimeToolBinaryPath` 依次尝试
  `bundled-tools/<platform>/pig`、仓库根、`packages/desktop` 等候选，
  再回退显式环境变量。
- 注入点：`buildHostProcessEnv()`，因此 main 和 fork 出来的 host
  utilityProcess 拿到同一份路径。

### 数据目录

```
~/.pi-web/pig-agent/          ← PiG 唯一数据根
├── models.json               ← provider 配置
├── auth.json                 ← 凭据
├── sessions/                 ← 会话 JSONL
└── extensions/               ← 本地扩展
```

由 `packages/services/src/paths.ts` 的 `getPiGAgentDir()` 统一派生，
通过 `PIG_CODING_AGENT_DIR` 传给子进程。旧 `~/.pi/agent` 只作为迁移的**只读输入**，
不再共写。

### PiG 契约不变量

来自 `packages/pi-runtime/src/pig/CONTRACT.md`：

- `PigProcessHost` 是 PiG 子进程的**唯一 owner**；调用方只能通过
  `PigRuntimeContract` 发命令或订阅事件。
- 一个 request id 只结算一次；超时、abort、进程退出都清理 pending 表，
  **不自动重发**未知是否已接受的写命令。
- response 只按 `id` 结算；未带 id 的行一律作为事件；未知 id 和非法 JSON
  只产生诊断，不伪造成功响应。
- `agent_settled` 是一轮运行的终态；`accepted` / `queued` 只代表命令已接收，
  不能提前结束 V4 busy 状态。
- **PiG 故障不回退到旧 TypeScript AgentSession**，上层必须显示可识别的
  runtime 错误或恢复状态。

### 子进程生命周期

`PiGSessionHost` 为每个活跃会话持有一个独立的 `PigProcessHost`：

| 操作               | 行为                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `open()`           | `start()` → `switch_session` 或 `new_session` → `get_state` → `get_messages`                                          |
| `fork(entryId)`    | PiG 的 `fork` 会替换当前 runtime 并可能分配新 session file，因此 fork 后**重新读取快照并返回新 ID**，同时注销旧注册项 |
| `setSessionName()` | 设置会话显示名                                                                                                        |
| 进程退出           | 所有 pending 请求以 `pig-process-exited` 结算，广播 `runtime_exited`                                                  |

Fork 后的清理是必须的：旧 projection / subscription / queue 映射若不清，
旧会话的事件会继续生成消息帧。

---

## 打包链的关键修复

macOS 包在真实环境启动时连续暴露了三个依赖注入缺陷，均已修复并有回归。

### 1. 版本冲突未嵌套

`proper-lockfile@4.1.2` 声明 `signal-exit@^3`，但 asar 顶层是 `4.1.0`。
v4 改为具名导出，`require("signal-exit")` 返回对象而非函数，
运行时报 `onExit is not a function`，host 启动阶段直接 `sql_failed`。

**修复**：`afterPack` 按每个父包声明的区间与 asar 实际布局比对，
冲突时把真实版本复制到**父包自身的** `node_modules`。实测注入 5 条：

```
signal-exit@3.0.7                → proper-lockfile/node_modules/
semver@7.8.5                     → @earendil-works/pi-coding-agent/node_modules/
undici@8.10.2                    → @earendil-works/pi-coding-agent/node_modules/
get-east-asian-width@1.6.0       → @earendil-works/pi-tui/node_modules/
@larksuiteoapi/node-sdk@1.64.0   → @zcode/services/node_modules/
```

### 2. 空目录被当成已安装

`files` 规则里的 `!node_modules/@zcode/**` 排除了整个 `@zcode` 作用域，
但会留下 `node_modules/@zcode/zcode-cua` 这样的**空占位目录**。
旧的缺失判定只看"有没有同名条目"，于是跳过注入，运行时
`ERR_MODULE_NOT_FOUND`。

**修复**：判定改为**必须存在 `package.json`**，`afterPack` 注入与
`bundle.mjs` 产物校验同口径。

### 3. pnpm 符号链接未解引用

workspace 包（`@zcode/*`）和 pnpm 提升包（`@aws-sdk/*`）在 `node_modules`
下都是**符号链接**。`cpSync` 默认不跟随，导致复制失败或只得到空目录。

**修复**：注入复制统一加 `dereference: true`。

### 打包后自检

`bundle.mjs` 在 Electron Builder 之后做机械校验，任一项失败即构建失败：

- `app.asar` 存在；
- 最终产物含 `resources/tools/pig/pig`；
- 运行时依赖闭包内每个包都有 `package.json`；
- 无越界 native 资源；
- 产物体积在限制内。

---

## 会话迁移

`packages/pi-runtime/src/session-migration/` 提供统一的迁移管线：

```
discover(root) → read(reference) → normalize(document) → write(canonical, agentDir)
```

支持的来源（`SessionSourceKind`）：

| 来源              | 状态                                    |
| ----------------- | --------------------------------------- |
| `pi`              | ✅ 已完成真实迁移（884 个会话，0 失败） |
| `reasonix`        | 适配器就绪，未做全量验收                |
| `codex`           | 适配器就绪，未做全量验收                |
| `zcode`           | 适配器就绪，未做全量验收                |
| `deepseekharness` | 适配器就绪，未做全量验收                |
| `claude-code`     | 适配器就绪，未做全量验收                |

迁移规则：

- 原始来源**只读保留**，不改写；
- 先写临时文件，校验 JSONL / schema / digest 后原子 rename；
- 会话 ID 由 `sourceKind + sourceId + digest` 稳定映射，重复导入幂等；
- 冲突只跳过并报告，不覆盖已有会话；
- 凭据默认不迁移。

---

## 供应商配置

`models.json` 结构：

```json
{
  "providers": {
    "<id>": {
      "api": "openai-chat-completions | openai-responses | anthropic-messages",
      "baseUrl": "https://...",
      "apiKey": "...",
      "name": "显示名",
      "models": [{ "id": "...", "contextWindow": 128000 }]
    }
  }
}
```

从 Magpie 导入：

```bash
node scripts/import-magpie-providers.mjs --dry-run   # 先看计划
node scripts/import-magpie-providers.mjs             # 写入
```

- 读 `~/.config/magpie/providers.json`，写到 `~/.pi-web/pig-agent/models.json`；
- 缺 `baseUrl` / `apiKey` / `models` 的条目跳过并报告原因；
- 默认**不覆盖**已存在的同名 provider（`--overwrite` 才覆盖）。

---

## 目录结构

```
packages/
├── pi-runtime/          ← PI 引擎适配层（核心）
│   ├── pig/             ← PiG 子进程 host、RPC 契约、服务桥接
│   ├── v4/              ← V4 事件归一化与投影
│   └── session-migration/  ← 六源会话迁移管线
├── desktop/             ← Electron 桌面壳（打包、原生集成）
├── ui/                  ← 共享 React 组件与 Zustand store
├── services/            ← 业务服务（文件、Git、任务、设置、远控）
├── server/ web/         ← Web 服务端与客户端
├── shared/ rpc/         ← 协议、类型、RPC 框架
└── zcode-cua/           ← Computer Use 桥接
apps/zcode-cli/          ← Agent CLI（桌面内置 bundle 的来源）
```

---

## 开发

环境版本以 [mise.toml](mise.toml) 为准：Node **24.14.0**、pnpm **10.33.2**。

```bash
pnpm bootstrap          # 安装依赖 + 初始化
pnpm dev:desktop        # 桌面开发
pnpm dev:web            # Web 开发
```

### 校验

```bash
pnpm typecheck
pnpm lint
pnpm db:schema:check
pnpm architecture:check --changed
pnpm verify:pre-push    # 上面几项的组合，push 前跑
```

### 打包

```bash
# 需要先准备固定版本 PiG 二进制
PIG_EXECUTABLE=/path/to/pig ZCODE_ENV=production \
  pnpm bundle:desktop -- --os mac --arch arm64
```

产物在 `packages/desktop/dist/`：`.dmg`、`.zip` 和两个 `.blockmap`。

CI 会从固定 Go module 自行编译 PiG（`actions/setup-go` 锁 `1.27.3`），
本地也可用 `PIG_SOURCE_DIR` 指向已 checkout 的 PiG 源码。

---

## 已知限制

- **未做 Apple 公证**：使用 adhoc 签名，首次打开需在
  「系统设置 → 隐私与安全性」选择「仍要打开」。
- **仅 macOS arm64**：Windows / Linux 打包路径未验证。
- **六源迁移只完成 `pi`**：其余五个来源的适配器存在，但未做全量真实导入验收。
- **`typecheck` 有既有 `TS2883` 错误**：`packages/ui` 下若干 hook 的推断类型
  无法在不显式注解的情况下命名，属既有问题，不影响构建产物。
- **旧 TypeScript Pi 依赖仍在**：`@earendil-works/pi-*` 仍作为依赖存在并被
  打进包，生产路径已不调用，但尚未移除。

---

## 与 ZCode 的关系

| 层                                                           | 来源    |
| ------------------------------------------------------------ | ------- |
| UI、桌面壳、Web、远控、设置、任务、文件、Git、Worktree、备份 | ZCode   |
| V4 RPC 协议与投影                                            | ZCode   |
| Agent runtime、provider 调用、工具执行、会话存储、扩展       | **PiG** |

ZCode 原有的 Coding Plan 订阅、账号体系等商业化能力在 PI 中已关闭
（PI 无账号系统）。

## 许可

继承上游 ZCode 的许可条款。PiG 为独立项目，遵循其自身许可。
