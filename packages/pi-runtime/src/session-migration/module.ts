/**
 * session-migration 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const sessionMigrationModule = {
  id: "session-migration",
  requires: ["pig-runtime", "services", "shared"],
  provides: ["session-migration"],
  publicEntrypoints: ["index.ts", "contract.ts", "canonical.ts", "writer.ts"],
} as const;
