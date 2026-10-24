---
spec: '02-00-multi-source-session-migration'
scene: '00-default'
created: '2026-10-24'
---

# 02-00 Multi Source Session Migration - 设计

## L0 摘要

通过来源适配器 registry、canonical session v3、原子 writer 与 PiG 回读，把六类会话来源统一导入。

## L1 概览

### 架构思路

导入层是离线迁移服务，不参与生产 Agent runtime。生命周期为 `discover → read → normalize → validate → write → verify`。每个来源由独立 adapter 负责格式识别和转换；writer 只接受 canonical model，校验后写入 PiG 的统一 session root。原始来源保持只读，所有无法映射字段通过 provenance/custom 或受控 sidecar 保存并报告，不静默丢弃。

### 主要模块

- `packages/pi-runtime/src/session-migration/contract.ts`：SourceKind、reference、canonical model、report、adapter 接口。
- `registry.ts`：sourceKind 到 adapter 的单一注册表。
- `canonical.ts` / `validate.ts`：PiG session v3 entry union 与结构/引用校验。
- `writer.ts`：稳定 ID、digest、manifest、原子落盘、冲突/重复处理。
- `sources/{pi,reasonix,codex,zcode,deepseekharness,claude-code}.ts`：六种独立解析入口。
- `packages/services/src/session/claude-native/`：复用 Claude Code 发现、parser 和 repair，不复用其 ZCode task-file 终点作为 PiG session 文件。
- Pi/Pi Web JSONL 经 adapter 转换后写入 PiG `agentDir/sessions`；Reasonix 复用 `pi-web-QT/lib/import-reasonix.ts` 与 `lib/import-sources.ts` 的语义参考，不直接依赖外部仓库运行时代码。

### 关键决策

| 决策 | 选项 | 倾向 | 是否产 ADR |
|---|---|---|---|
| 统一写入格式 | 每来源直接写 PiG JSONL / canonical model 再写 | canonical model；边界 parser 负责来源差异，writer 保持单一 | 否 |
| ID 冲突 | 覆盖 / 静默跳过 / 幂等身份加冲突报告 | source identity + content digest 稳定 ID；从不覆盖 | 否 |
| 未知记录 | 丢弃 / 伪映射 / provenance custom 或 sidecar | 原始引用和计数可审计；不可映射数据不进模型上下文 | 否 |

## L2 详情

### 模块详细设计

#### D-01 Canonical PiG session v3 model

定义 session header、entry union、message content blocks、parent/branch/leaf、附件引用和 source provenance。每个 entry 携带 source ordinal 与 source record id；PiG 可表达的类型映射到原生 v3 entries；无法映射的内容存成 custom/provenance 或 sidecar，并标注 `unmapped`，不放入模型 context。Secret 字段由统一 redactor 按字段白名单排除，不依赖来源 parser 猜测。

#### D-02 Source adapter registry

`SessionSourceAdapter` 包含 `sourceKind`、`discover(input)`、`read(reference)`、`normalize(document)` 和 `validate(canonical)`。六类 adapter 独立版本化，registry 只按 sourceKind 派发；单个来源 unavailable 或 parser 失败不阻塞其他来源。Codex/ZCode/DeepSeekharness schema 只有检测到已知版本并匹配 fixture 才导入，否则报告 unsupported。

#### D-03 Stable identity and atomic writer

用 `sourceKind + sourceId + sourceDigest` 生成可重复目标 session id 与 manifest key。写入先在 PiG session root 下的专用临时目录构建 JSONL、附件引用和 manifest，做 schema/path/digest 校验后原子 rename。目标 session identity 与 digest 相同返回 identical skip；身份相同但 digest 不同返回 conflict/new-revision decision，绝不覆盖。manifest 与 session 文件一起提交或都不落盘。目标根从 `getPiGSessionDir()` 注入。

#### D-04 PiG round-trip verifier

导入 writer 成功不是完成状态。`PiGSessionVerifier` 使用 PiG session list/open/read/branch/export 命令或经 adapter 暴露的等价 RPC，验证 header、branch、entry ids、可继续 prompt 和可导出；验证失败清理未提交 artifact，保留 manifest 与原始源。

### 数据模型

```text
SourceKind = pi | reasonix | codex | zcode | deepseekharness | claude-code
SourceReference = { sourceKind, sourceId, sourcePath, workspacePath?, size, digest }
CanonicalSession = { version: 3, sessionId, cwd, createdAt, entries[], branches, provenance }
ImportManifest = { source, parserVersion, sourceDigest, counts, skipped[], conflicts[], secretFieldsExcluded[], targetDigest?, verifyState }
ImportState = discovered → previewed → validated → staged → committed → verified
```

所有时间统一为 ISO 时间戳或 PiG schema 指定数值；taskId、workspaceIdentity、sessionId 分字段保留。Attachment 以受控相对引用写入迁移资源目录，禁止原始绝对路径逃逸。

### 接口契约

- `SessionSourceAdapter.discover(input): Promise<SourceReference[]>`
- `SessionSourceAdapter.read(reference): AsyncIterable<SourceRecord>`，便于大文件有界流式解析。
- `SessionSourceAdapter.normalize(records, context): Promise<CanonicalSession>`
- `CanonicalSessionWriter.preview(session): ImportPreview`
- `CanonicalSessionWriter.commit(session, manifest): ImportResult`
- `PiGSessionVerifier.verify(sessionId): Promise<VerifiedSessionResult>`

调用者只能通过 `SessionMigrationService.preview/import/report` 入口，不直接访问 parser 或 writer。所有入口参数包含 source root 和 PiG session root；root 校验由 service 执行。

### 错误处理

来源根不存在返回 unavailable；未知版本返回 unsupported-version；header 不可解析或 session identity 无法确认则该 session failed；坏 entry 按行记录 skipped 并继续；路径穿越/非法附件直接拒绝；目标 conflict 显式返回；PiG round-trip 失败标记 `written-unverified`，不能报告导入完成。任何失败不修改原始来源，也不覆盖原目标。

### 测试策略

每个 source adapter 建立最小/完整/损坏/未知版本/重复导入 fixture；canonical/writer 测试覆盖字段映射、branch/order、unknown provenance、secret exclusion、路径穿越、稳定 ID、digest、冲突、原子 rename 故障。集成测试使用 mock PiG 进程覆盖 list/open/continue/fork/export，再以锁定 PiG binary 做每类至少一条真实 round-trip。
