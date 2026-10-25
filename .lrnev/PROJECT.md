---
title: 'pi-zcode'
created: '2026-10-24'
---

# pi-zcode

## L0 摘要

ZCode 的桌面/Web/远程产品宿主，最终以 PiG RPC runtime 承担唯一 Agent 底层，并把多来源会话统一迁移到 PiG session 格式。

## L1 概览

### 项目目标

在保留 ZCode UI、V4 协议、服务契约、文件/Git/Worktree/任务分组、备份和远程能力的前提下，把 Pi Web 的用户可见能力迁入 ZCode；PiG 通过后端适配层最终完全替代原 TypeScript Pi Agent runtime。

### 核心用户

- 使用 ZCode 桌面、Web、远程控制和移动入口进行 AI 编程的用户
- 需要从 Pi/Pi Web、Reasonix、Codex、ZCode、DeepSeekharness、Claude Code 迁移历史会话的用户

### 当前阶段

- 迁移实施阶段：先建立 PiG 唯一 runtime 适配与统一数据目录，再完成六类会话导入、插件重做和宿主功能闭环。
- 当前仓库已有 PI 引擎适配改动，必须保留并在其上增量实施；PiG 本机命令尚未安装，需通过可注入 executable/fixture 先完成适配层和契约测试。

## L2 详情

### 背景

`pi-web-QT` 已实现大量 Pi Agent Web 工作台能力，但它的 Next.js/HTTP/SSE/Flutter/Tauri 架构不能直接并入 ZCode。`pi-zcode` 已在 ZCode 服务层挂入 TypeScript Pi runtime，当前仍存在会话交互、队列恢复、任务分组、插件生命周期和路径一致性缺口。产品要求最终由 PiG 作为唯一 Agent 底层，并将多种外部会话格式统一为 PiG 可继续使用的 session v3。

### 范围

**包含**：
- PiG stdin/stdout JSONL RPC 进程适配、事件归一化、重连、背压、审批和 extension UI 转发
- `~/.pi-web/pig-agent` 统一数据目录与旧数据只读导入
- Pi/Pi Web、Reasonix、Codex、ZCode、DeepSeekharness、Claude Code 会话发现、解析、规范化、幂等导入和 PiG 回读
- Pi Web 的会话、队列、模型、Skills、Pi package/extension、文件、Git/Worktree、任务看板、备份、主题和远程行为在 ZCode 宿主中的实现

**不包含**：
- 复制 Pi Web 的 Next.js API、Tauri/Flutter 客户端或建立第二套产品宿主
- 让旧 TypeScript Pi runtime 与 PiG 长期双轨运行或作为正式 fallback
- 默认迁移 API key、OAuth token、cookie 等凭据

### 关键约束

- PiG 是最终唯一生产 Agent runtime；旧 `AgentSession` 只能用于迁移期只读解析/转换，最终生产路径必须移除。
- ZCode V4/RPC/服务契约是前端唯一边界，PiG wire JSONL 不直接暴露给 UI。
- 所有 PI 新数据统一写入 `~/.pi-web/pig-agent`；旧 `~/.pi/agent` 及其他来源只读导入，不共写、不覆盖。
- 原始会话文件只读保留；导入采用 manifest、digest、临时文件、schema 校验和原子 rename。
- 当前工作树有既有未提交改动，任何实施不得 reset、checkout 或覆盖无关文件。

---

## 维护说明

- **更新时机**：项目定位、范围或团队治理约定变化时更新。
