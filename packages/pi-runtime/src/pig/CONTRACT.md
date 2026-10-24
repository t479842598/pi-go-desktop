# pig-runtime

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

不变量：

- `PigProcessHost` 是 PiG 子进程的唯一 owner；调用方只能通过 `PigRuntimeContract` 发命令或订阅事件。
- 一个 request id 只能结算一次；超时、abort、进程退出都会清理 pending 表，不自动重发未知是否已接受的写命令。
- PiG response 只按 id 结算，未带 id 的 JSONL 行一律作为事件；未知 id 和非法 JSON 只产生诊断，不伪造成功响应。
- PiG 进程环境必须收到统一的 `PIG_CODING_AGENT_DIR`，路径由 ZCode data root 派生，不得回落到 `~/.pi/agent`。
- PiG runtime 故障不能回退到旧 TypeScript AgentSession；上层必须显示可识别的 runtime 错误或恢复状态。
- `agent_settled` 是一轮运行的终态信号；prompt accepted/queued 只代表命令已接收，不能提前结束 V4 busy 状态。
- 契约测试只依赖 `PigRuntimeContract`，process host 测试通过 fake child process 验证真实 JSONL 生命周期。

交集 hook：

- `packages/services/src/node.ts` 在 PI 产品装配 `PiGBackend`，`packages/pi-runtime/src/v4` 只消费 normalized events。
- ZCode V4 的 snapshot/delta/ACK 由 adapter 维护，UI 不读取 PiG wire JSONL。
