---
spec: '02-00-multi-source-session-migration'
scene: '00-default'
created: '2026-10-24'
---

# 02-00 Multi Source Session Migration - 任务清单

> 任务由 lrnev `task_create` 工具创建，不要手编。
> 状态机：pending → in_progress → completed / failed；blocked 可回 in_progress；failed 可回 pending 重试。

## 阶段 1

<!-- FILL: 使用 task_create 追加任务；任务会以 `### T-XXX 标题 <!-- lrnev-task: ... -->` 形式追加到这里 -->

## 验收标准（整体）

- <!-- FILL: 按本 Spec 调整整体验收清单 -->
- [ ] 所有任务完成
- [ ] 单元测试通过
- [ ] 集成测试通过

### T-001 Implement canonical session v3 model and atomic writer <!-- lrnev-task: status=completed, created=2026-10-24T15:24:24.873Z, updated=2026-10-24T16:53:14.426Z, validates=F-01|F-03|F-05|D-01|D-03 -->
<!-- lrnev-task-history: [{"from":"pending","to":"in_progress","at":"2026-10-24T15:29:34.658Z"},{"from":"in_progress","to":"completed","at":"2026-10-24T16:53:14.426Z","reason":"canonical Pi session v3、来源审计映射、secret 脱敏、路径与符号链接校验、排他原子写入和幂等冲突处理均已实现并验证"}] -->

Create the canonical session model, source registry contract, manifest, digest, path-safe atomic writer, idempotency and conflict reporting for PiG session imports.

**验收**：
- Canonical session and manifest types compile
- Writer rejects traversal and preserves existing targets
- Repeated import is idempotent and writes atomically
