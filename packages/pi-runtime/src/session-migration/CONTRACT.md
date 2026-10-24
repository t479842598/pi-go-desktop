# session-migration

## 意图

`session-migration` 把 Pi/Pi Web、Reasonix、Codex、ZCode、DeepSeekharness、Claude Code 的历史记录统一转换为 PiG 可打开的 session JSONL v3。来源 parser 保持只读；只有 canonical writer 可以发布 PiG session 文件。

## 不变量

- `CanonicalSession` 只允许 Pi v3 树形 entry；每个 entry 有唯一 `id`、合法 `parentId`、来源序号和 ISO 时间戳。
- writer 只写绝对 `sessionRoot` 下按 Pi cwd slug 计算的目录；会校验 realpath containment，不接受越界或符号链接目标。
- writer 先写唯一临时文件并 `sync`，再用同文件系统的排他 hard-link 发布；不会覆盖已有 session，临时文件最终清理。
- 稳定身份由 `sourceKind + sourceId + sourceDigest` 生成；重复导入读取已写入的 migration manifest `targetDigest`，相同内容返回 `duplicate`，不同内容返回 `skipped/conflicts`。
- 原生 Pi entry 不携带迁移审计字段；逐条来源 entry id、ordinal、record id 与 unmapped 标记进入 manifest custom entry 的 `sourceRecordMap`。未知字段不得静默变成模型上下文。
- secret 命名字段（API key、token、cookie、password、credential、private key 等）在 JSONL 前脱敏，并在 manifest 的 `secretFieldsExcluded` 中记录路径。
- PiG 回读、continue、branch、export 属于后续 verifier 阶段；writer 的 `committed` 只表示原子文件提交，不代表 PiG runtime 已验证。

## 与其它模块的交集

- `packages/services/src/paths.ts` 提供正式 PiG session root；生产数据不得回写旧 `~/.pi/agent`。
- 六类 source adapter 通过 `SessionSourceAdapter` 生成 canonical model，再调用统一 writer；adapter 不直接写文件。
- `pig-runtime` 后续负责打开、继续和分支验证；本模块不创建 TypeScript `AgentSession`，也不替代 PiG runtime。
