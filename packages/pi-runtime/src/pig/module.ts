/**
 * pig-runtime 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const pigRuntimeModule = {
  id: "pig-runtime",
  requires: ["provider", "provider-node", "rpc", "services", "shared"],
  provides: ["pig-runtime"],
  publicEntrypoints: ["index.ts", "contract.ts", "session-host.ts"],
} as const;
