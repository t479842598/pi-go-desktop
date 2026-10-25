import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { asSessionMigrationId, type SessionSourceKind } from "./contract.js";
import { FileSessionSourceAdapter } from "./adapters.js";
import { encodeCwd } from "./writer.js";
import { SESSION_SOURCE_KINDS, SessionSourceAdapterRegistry } from "./registry.js";
import { SessionMigrationService } from "./service.js";

const roots: string[] = [];
const createdAt = "2026-01-01T00:00:00.000Z";

async function makeWorkspace(): Promise<{ root: string; sources: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-zcode-migration-service-"));
  roots.push(root);
  const sources = join(root, "sources");
  const target = join(root, "pig-agent", "sessions");
  return { root, sources, target };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session migration adapters", () => {
  it("registers every required source kind", () => {
    const registry = new SessionSourceAdapterRegistry();
    expect(registry.list()).toEqual(SESSION_SOURCE_KINDS);
  });

  it.each([
    [
      "pi",
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: createdAt,
        message: { role: "user", content: "hello", timestamp: Date.parse(createdAt) },
      },
    ],
    ["reasonix", { role: "user", content: "hello", createdAt: Date.parse(createdAt) }],
    [
      "codex",
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      },
    ],
    ["zcode", { role: "user", content: "hello", timestamp: createdAt }],
    ["deepseekharness", { role: "user", content: "hello", timestamp: createdAt }],
    [
      "claude-code",
      {
        type: "user",
        message: { role: "user", content: "hello", timestamp: createdAt },
        cwd: "/workspace/claude",
      },
    ],
  ] as const)("normalizes the %s source fixture", async (sourceKind, fixture) => {
    const { sources } = await makeWorkspace();
    const sourceDir = join(sources, sourceKind);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
    const sourcePath = join(sourceDir, "session.jsonl");
    await writeFile(sourcePath, `${JSON.stringify(fixture)}\n`, "utf8");
    const adapter = new FileSessionSourceAdapter(sourceKind as SessionSourceKind);
    const references = await adapter.discover({ root: sourceDir });
    expect(references).toHaveLength(1);
    const document = await adapter.read(references[0]!);
    const session = await adapter.normalize(document, references[0]!);
    expect(session.version).toBe(3);
    expect(session.provenance.sourceKind).toBe(sourceKind);
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0]).toMatchObject({ type: "message", message: { role: "user" } });
  });

  it("imports, records excluded secret fields, and reads its manifest back", async () => {
    const { sources, target } = await makeWorkspace();
    const sourceDir = join(sources, "zcode");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
    const sourcePath = join(sourceDir, "session.jsonl");
    const records = [
      { role: "user", content: "hello", timestamp: createdAt },
      { type: "tool_call", apiKey: "must-not-leak", id: "tool-1", timestamp: createdAt },
    ];
    await writeFile(
      sourcePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const service = new SessionMigrationService({ sessionRoot: target });
    const [reference] = await service.discover("zcode", sourceDir);
    expect(reference).toBeDefined();
    const preview = await service.preview(reference!);
    expect(preview.entries.some((entry) => entry.unmapped)).toBe(true);
    const manifest = await service.import(reference!);
    expect(manifest.state).toBe("committed");
    expect(manifest.secretFieldsExcluded).toContain("data.record.apiKey");
    const contents = await readFile(await manifestPath(target, manifest.targetSessionId), "utf8");
    expect(contents).not.toContain("must-not-leak");
    expect(await service.report(asSessionMigrationId(manifest.targetSessionId))).toMatchObject({
      state: "committed",
    });
  });

  it("persists malformed-only sources as failed audit reports", async () => {
    const { sources, target } = await makeWorkspace();
    const sourceDir = join(sources, "codex");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
    const sourcePath = join(sourceDir, "broken.jsonl");
    await writeFile(sourcePath, "{not-json}\n", "utf8");

    const service = new SessionMigrationService({ sessionRoot: target });
    const [reference] = await service.discover("codex", sourceDir);
    const manifest = await service.import(reference!);
    expect(manifest.state).toBe("failed");
    expect(manifest.error).toContain("No importable records");
    expect(await service.report(asSessionMigrationId(manifest.targetSessionId))).toMatchObject({
      state: "failed",
    });
  });
});

async function manifestPath(sessionRoot: string, sessionId: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const projectDirs = await readdir(sessionRoot);
  for (const projectDir of projectDirs) {
    const files = await readdir(join(sessionRoot, projectDir));
    const match = files.find((file) => file.endsWith(`_${sessionId}.jsonl`));
    if (match) return join(sessionRoot, projectDir, match);
  }
  return join(sessionRoot, encodeCwd("/missing"), `${sessionId}.jsonl`);
}
