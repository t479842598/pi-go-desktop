---
spec: '01-00-pig-runtime-adapter'
scene: '00-default'
created: '2026-10-24'
---

# 01-00 Pig Runtime Adapter - 任务清单

> 任务由 lrnev `task_create` 工具创建，不要手编。
> 状态机：pending → in_progress → completed / failed；blocked 可回 in_progress；failed 可回 pending 重试。

## 阶段 1

<!-- FILL: 使用 task_create 追加任务；任务会以 `### T-XXX 标题 <!-- lrnev-task: ... -->` 形式追加到这里 -->

## 验收标准（整体）

- <!-- FILL: 按本 Spec 调整整体验收清单 -->
- [ ] 所有任务完成
- [ ] 单元测试通过
- [ ] 集成测试通过

### T-001 Initialize PiG adapter and data-root boundary <!-- lrnev-task: status=completed, created=2026-10-24T14:15:36.412Z, updated=2026-10-24T15:14:18.962Z, validates=F-01|F-04|D-01|D-04 -->
<!-- lrnev-task-history: [{"from":"pending","to":"in_progress","at":"2026-10-24T14:17:23.946Z"},{"from":"in_progress","to":"completed","at":"2026-10-24T15:14:18.962Z"}] -->

Create the PiG backend interface and unified PI data-root helpers without adding a TypeScript AgentSession production path.

**验收**：
- PiG backend interface and path helpers compile in the pi-runtime package
- All new PI paths resolve under the dedicated pig-agent root
- Existing uncommitted files remain untouched outside the scoped changes

### T-002 Lock PiG protocol and binary <!-- lrnev-task: status=completed, created=2026-10-25T03:03:39.215Z, updated=2026-10-25T03:38:49.071Z, validates=F-01|F-02|F-03|D-01|D-02 -->
<!-- lrnev-task-history: [{"from":"pending","to":"in_progress","at":"2026-10-25T03:05:01.502Z"},{"from":"in_progress","to":"completed","at":"2026-10-25T03:38:49.071Z","reason":"已锁定 PiG commit，完成真实版本构建，并通过隔离 RPC get_state/get_commands smoke 与 transport 回归测试。"}] -->

Fetch the pinned PiG main commit, inspect RPC/session contracts, build the native pig executable, and record verified command/event shapes.

**验收**：
- PiG commit b6d8ab0bfab082857274770e69eda0d477b263b2 is recorded
- pig --version runs from the built binary
- RPC and session shapes are covered by a local fixture

### T-003 Switch production runtime to PiG <!-- lrnev-task: status=in_progress, created=2026-10-25T03:04:23.005Z, updated=2026-10-25T04:01:42.757Z, validates=F-01|F-02|F-05|D-03|D-04 -->
<!-- lrnev-task-history: [{"from":"pending","to":"in_progress","at":"2026-10-25T04:01:42.757Z","reason":"开始将生产装配从 TypeScript AgentSession 切换到唯一 PiG backend；先建立 V4 隔离 adapter 与不可用时明确失败路径。"}] -->

Replace production AgentSession creation with PiG backend wiring while preserving ZCode V4 contracts and explicit failure states.

**验收**：
- Production mount has no AgentSession creation path
- V4 service consumes PiG normalized events
- PiG unavailable does not silently fallback

### T-004 Fix desktop sourcemap cleanup race <!-- lrnev-task: status=completed, created=2026-10-25T11:44:41.176Z, updated=2026-10-25T11:51:08.075Z, validates=F-01|F-05 -->
<!-- lrnev-task-history: [{"from":"pending","to":"in_progress","at":"2026-10-25T11:46:35.258Z","reason":"开始修复 afterPack sourcemap 清理目录遍历的 ENOENT 容错。"},{"from":"in_progress","to":"completed","at":"2026-10-25T11:51:08.075Z","reason":"已修复 afterPack sourcemap 清理目录遍历的 ENOENT 容错；定向回归 4/4、格式检查、相关 lint 和 git diff --check 全部通过。"}] -->

修复 Electron Builder afterPack 清理临时 ASAR 解包目录时遇到失效符号链接或瞬时消失路径导致 ENOENT 中断 macOS arm64 打包；仅跳过不存在路径，其他文件系统错误继续抛出。

**验收**：
- 遍历遇到 ENOENT 时继续清理
- 失效符号链接不会触发 stat 失败
- 非 ENOENT 文件系统错误仍抛出
- 现有 sourcemap 清理回归通过

### T-005 Bundle pinned PiG runtime in Desktop app <!-- lrnev-task: status=completed, created=2026-10-25T12:09:21.450Z, updated=2026-10-25T14:22:12.731Z, validates=F-01|F-04|F-05 -->
<!-- lrnev-task-history: [{"from":"pending","to":"in_progress","at":"2026-10-25T12:09:39.379Z","reason":"开始接入固定 PiG 二进制的 Desktop 随包资源与 packaged host 路径解析。"},{"from":"in_progress","to":"completed","at":"2026-10-25T14:22:12.731Z","reason":"PiG 固定版本 staging、resources/tools/pig、packaged PIG_EXECUTABLE 注入、产物机械校验与 CI Go 1.27.3 已落地；Host 38/38、PiG 11/11、格式/lint/tsc/空白全通过；提交 7301c9ff。"}] -->

将固定 PiG runtime 随 Desktop 资源打包，并让 packaged host 解析到该资源路径；开发态允许显式覆盖，production 不依赖系统 PATH，也不回退到旧 TypeScript Pi runtime。

**验收**：
- macOS arm64 production app 包含可执行 pig 文件
- packaged PiG host 使用 resources 中的 pig 路径
- 缺少打包资源时错误明确，不静默回退到 PATH 或 TypeScript Pi
- 路径解析与打包资源有回归测试
