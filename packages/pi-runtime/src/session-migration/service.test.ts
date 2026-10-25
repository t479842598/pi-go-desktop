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

  it("preserves Codex function calls and results as Pi tool entries", async () => {
    const { sources } = await makeWorkspace();
    const sourceDir = join(sources, "codex");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
    const sourcePath = join(sourceDir, "rollout.jsonl");
    const records = [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-42",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-42",
          output: "readme contents",
        },
      },
    ];
    await writeFile(
      sourcePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const adapter = new FileSessionSourceAdapter("codex");
    const [reference] = await adapter.discover({ root: sourceDir });
    expect(reference).toBeDefined();
    const session = await adapter.normalize(await adapter.read(reference!), reference!);
    const assistantEntry = session.entries[0];
    const resultEntry = session.entries[1];

    expect(assistantEntry).toMatchObject({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-42",
            name: "read_file",
            arguments: { path: "README.md" },
          },
        ],
      },
    });
    expect(resultEntry).toMatchObject({
      type: "message",
      parentId: assistantEntry?.id,
      message: {
        role: "toolResult",
        toolCallId: "call-42",
        toolName: "read_file",
        content: [{ type: "text", text: "readme contents" }],
      },
    });
  });

  it("preserves Reasonix reasoning, tool calls, and tool results", async () => {
    const { sources } = await makeWorkspace();
    const sourceDir = join(sources, "reasonix");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
    const sourcePath = join(sourceDir, "session.jsonl");
    const records = [
      {
        role: "assistant",
        reasoning_content: "Read the requested file.",
        tool_calls: [
          { id: "reasonix-call-1", name: "read_file", arguments: '{"path":"README.md"}' },
        ],
      },
      {
        role: "tool",
        tool_call_id: "reasonix-call-1",
        name: "read_file",
        content: "readme contents",
      },
    ];
    await writeFile(
      sourcePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const adapter = new FileSessionSourceAdapter("reasonix");
    const [reference] = await adapter.discover({ root: sourceDir });
    expect(reference).toBeDefined();
    const session = await adapter.normalize(await adapter.read(reference!), reference!);
    const assistantEntry = session.entries[0];
    const resultEntry = session.entries[1];

    expect(assistantEntry).toMatchObject({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Read the requested file." },
          {
            type: "toolCall",
            id: "reasonix-call-1",
            name: "read_file",
            arguments: { path: "README.md" },
          },
        ],
      },
    });
    expect(resultEntry).toMatchObject({
      type: "message",
      parentId: assistantEntry?.id,
      message: {
        role: "toolResult",
        toolCallId: "reasonix-call-1",
        toolName: "read_file",
        content: [{ type: "text", text: "readme contents" }],
      },
    });
  });

  it("preserves Claude Code tool_use and tool_result linkage", async () => {
    const { sources } = await makeWorkspace();
    const sourceDir = join(sources, "claude-code");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
    const sourcePath = join(sourceDir, "session.jsonl");
    const records = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the file." },
            { type: "tool_use", id: "toolu-7", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu-7", content: "readme contents" },
            { type: "text", text: "Continue with the summary." },
          ],
        },
      },
    ];
    await writeFile(
      sourcePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const adapter = new FileSessionSourceAdapter("claude-code");
    const [reference] = await adapter.discover({ root: sourceDir });
    expect(reference).toBeDefined();
    const session = await adapter.normalize(await adapter.read(reference!), reference!);
    const assistantEntry = session.entries[0];
    const resultEntry = session.entries[1];
    const followupUserEntry = session.entries[2];

    expect(assistantEntry).toMatchObject({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the file." },
          {
            type: "toolCall",
            id: "toolu-7",
            name: "Read",
            arguments: { file_path: "README.md" },
          },
        ],
      },
    });
    expect(followupUserEntry).toMatchObject({
      type: "message",
      parentId: resultEntry?.id,
      message: { role: "user", content: [{ type: "text", text: "Continue with the summary." }] },
    });
    expect(resultEntry).toMatchObject({
      type: "message",
      parentId: assistantEntry?.id,
      message: {
        role: "toolResult",
        toolCallId: "toolu-7",
        toolName: "Read",
        content: [{ type: "text", text: "readme contents" }],
      },
    });
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

  it("preserves JSONL line ordinals after malformed records and counts source records", async () => {
    const { sources, target } = await makeWorkspace();
    const sourceDir = join(sources, "codex");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
    const sourcePath = join(sourceDir, "rollout.jsonl");
    const validRecord = {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    };
    await writeFile(sourcePath, `{not-json}\n${JSON.stringify(validRecord)}\n`, "utf8");

    const service = new SessionMigrationService({ sessionRoot: target });
    const [reference] = await service.discover("codex", sourceDir);
    expect(reference).toBeDefined();
    const manifest = await service.import(reference!);

    expect(manifest.state).toBe("committed");
    expect(manifest.sourceRecordMap).toMatchObject([{ sourceOrdinal: 1 }]);
    expect(manifest.counts).toMatchObject({ sourceRecords: 2, skippedRecords: 1 });
    expect(manifest.skipped).toContainEqual({ ordinal: 0, reason: "malformed-json-line" });
  });

  it("preserves Pi parent references when a parent appears later in the source file", async () => {
    const { sources } = await makeWorkspace();
    const sourceDir = join(sources, "pi");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
    const sourcePath = join(sourceDir, "session.jsonl");
    const records = [
      {
        type: "message",
        id: "child-entry",
        parentId: "later-parent",
        timestamp: createdAt,
        message: { role: "assistant", content: [{ type: "text", text: "branch reply" }] },
      },
      {
        type: "message",
        id: "later-parent",
        parentId: null,
        timestamp: createdAt,
        message: { role: "user", content: [{ type: "text", text: "branch prompt" }] },
      },
    ];
    await writeFile(
      sourcePath,
      `${JSON.stringify({ type: "session", version: 3, id: "pi-source", cwd: "/workspace" })}\n${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const adapter = new FileSessionSourceAdapter("pi");
    const [reference] = await adapter.discover({ root: sourceDir });
    expect(reference).toBeDefined();
    const session = await adapter.normalize(await adapter.read(reference!), reference!);

    expect(session.entries[0]).toMatchObject({ id: "child-entry", parentId: "later-parent" });
    expect(session.entries[1]).toMatchObject({ id: "later-parent", parentId: null });
    expect(session.skippedRecords).toEqual([]);
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
