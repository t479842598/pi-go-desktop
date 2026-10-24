/**
 * session-migration 标准调用示例：来源 adapter 只负责解析，调用方只通过统一契约预览和导入。
 */
import { asSessionMigrationId, type SessionMigrationContract } from "./contract.js";

export async function exampleSessionMigration(
  contract: SessionMigrationContract,
  sourceKind: "pi" | "reasonix" | "codex" | "zcode" | "deepseekharness" | "claude-code",
  sourceRoot: string,
): Promise<void> {
  const references = await contract.discover(sourceKind, sourceRoot);
  const first = references[0];
  if (!first) return;

  // Preview never writes the source or PiG session root.
  const preview = await contract.preview(first);
  void preview;

  const manifest = await contract.import(first);
  const report = await contract.report(asSessionMigrationId(manifest.targetSessionId));
  void report;
}
