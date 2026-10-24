---
spec: 02-00-multi-source-session-migration
scene: 00-default
status: ready
priority: P0
created: '2026-10-24'
updated: '2026-10-24'
---

# 02-00 Multi Source Session Migration - 需求

## L0 摘要

将 Pi/Pi Web、Reasonix、Codex、ZCode、DeepSeekharness、Claude Code 六类会话统一转换为 PiG session v3，并由 PiG 实际打开、继续和分支验证。

## L1 概览

### 目标

建立可扩展的 `SessionSourceAdapter` 管线：发现来源、读取原始记录、规范化为 canonical session tree、生成 manifest/digest 并原子写入 `~/.pi-web/pig-agent/sessions`。导入过程幂等、可预览、可报告未知/损坏记录，默认排除凭据，且不覆盖源文件或已有目标会话。

### 用户故事

- 作为迁移用户，我希望从六类 Agent 工具导入历史会话后仍能在 PiG 中继续、分支和导出，以便不丢失既有工作上下文。
- 作为维护者，我希望每个来源有独立 parser、fixture 和错误报告，以便格式变化不会静默破坏导入。

### 范围

**包含**：
- canonical PiG session v3 类型、source adapter registry、discover/read/normalize/write 生命周期。
- Pi/Pi Web、Reasonix、Codex、ZCode、DeepSeekharness、Claude Code 六类来源的适配器边界、manifest、digest、幂等和冲突报告。
- tool/thinking/approval/bash/attachments/compaction/retry/custom/context_edit/tree/branch 等可映射记录的保留策略。

**不包含**：
- PiG Agent runtime、V4 流式 adapter 和生产进程生命周期（归 `01-00-pig-runtime-adapter`）。
- 默认迁移 API key、OAuth token、cookie 或其他 secret；未知来源 schema 不猜测字段语义。

## L2 详情

### 详细需求

#### F-01 Canonical session v3
- 描述：定义稳定的来源无关 session tree、消息/工具/附件/压缩/自定义记录及 provenance 元数据，输出符合 PiG session v3 的 JSONL。
- 验收：WHEN canonical session 写入临时文件 THEN header、parentId/branch、消息顺序、未知记录和 manifest 均可校验，且 PiG 可打开该文件。

#### F-02 六类来源适配器
- 描述：为 Pi/Pi Web、Reasonix、Codex、ZCode、DeepSeekharness、Claude Code 分别注册 discovery/parser/normalizer；来源未找到、版本未知或记录损坏时返回逐项报告。
- 验收：WHEN 对任一来源执行 discover/preview/import THEN 不支持或损坏记录不会静默丢失；六类来源均有最小有效 fixture 和失败 fixture。

#### F-03 幂等、冲突与原子写入
- 描述：用 sourceKind/sourceId/content digest 生成稳定目标身份；写入前校验，目标已存在时跳过或生成显式冲突结果，原始文件只读保留。
- 验收：WHEN 同一来源重复导入 THEN 不新增重复会话、不覆盖已有目标；写入中断 THEN 目标目录没有半文件且源文件未改变。

#### F-04 PiG 回读验证
- 描述：导入完成后通过 PiG session API/CLI 读取、列出、继续、Fork/clone/tree、compact 和导出，验证格式不是只在静态层面有效。
- 验收：WHEN 六类来源均完成导入 THEN 每类至少一个会话可由 PiG 打开、继续发送、创建分支并导出，失败时保留可定位 manifest。

#### F-05 安全与数据边界
- 描述：路径严格限制在来源根和 PiG agent root；secret 默认排除；原始附件以受控引用保存，不将大段二进制注入模型上下文。
- 验收：WHEN 输入包含路径穿越、secret 字段或未知二进制块 THEN 导入拒绝/脱敏/sidecar 保存并记录原因，不写出越界路径或凭据。

### 非功能性需求

- 性能：发现和预览采用有界读取；单个超大 transcript 不得一次性无上限载入内存，导入结果报告记录数、跳过数和耗时。
- 兼容性：Node 24+；PiG session v3；macOS/Windows/Linux 路径规则；不同来源缺失时其余来源仍可独立执行。

### 边界与依赖

- 依赖 `01-00-pig-runtime-adapter` 提供 PiG agent/session root 和回读接口；不依赖旧 TypeScript AgentSession 作为生产 runtime。
- 复用 `pi-web-QT/lib/import-reasonix.ts`、`lib/import-sources.ts` 的 Reasonix 解析语义；复用 `packages/services/src/session/claude-native/` 的 Claude Code 解析/修复能力。
- Codex、ZCode、DeepSeekharness 的精确文件 schema 需以阶段 0 fixture/文档确认；未知 schema 阻断该来源，不猜测。

### 验收标准

- [ ] 六类来源均有 discovery、parser/normalizer、manifest、最小有效 fixture 和失败 fixture。
- [ ] canonical session v3 通过结构校验，重复导入幂等且不覆盖源/目标已有数据。
- [ ] 每类来源至少一个会话由 PiG 实际打开、继续、分支和导出。
- [ ] 路径穿越、secret、未知字段/二进制和损坏记录均有可审计结果。
