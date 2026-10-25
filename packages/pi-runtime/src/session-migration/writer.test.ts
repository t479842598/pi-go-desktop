import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256, validateCanonicalSession } from "./canonical.js";
import { encodeCwd, writeCanonicalSession } from "./writer.js";
import type { CanonicalSession, SessionSourceReference } from "./contract.js";

const createdAt = "2026-01-01T00:00:00.000Z";
const updatedAt = "2026-01-01T00:01:00.000Z";
const importedAt = "2026-01-01T00:02:00.000Z";
const sourceDigest = sha256("fixture-source-v1");
const roots: string[] = [];

function makeSession(workspace: string): CanonicalSession {
  return {
    version: 3,
    sessionId: "source-session-001" as CanonicalSession["sessionId"],
    cwd: workspace,
    createdAt,
    updatedAt,
    entries: [
      {
        type: "message",
        id: "user-001",
        parentId: null,
        timestamp: createdAt,
        sourceOrdinal: 0,
        message: {
          role: "user",
          content: "Keep this message",
          timestamp: Date.parse(createdAt),
        },
      },
      {
        type: "custom",
        id: "source-001",
        parentId: "user-001",
        timestamp: updatedAt,
        sourceOrdinal: 1,
        customType: "fixture-source-state",
        data: {
          apiKey: "secret-value",
          nested: { password: "secret-password", retained: "visible" },
        },
      },
    ],
    leafId: "source-001",
    provenance: {
      sourceKind: "codex",
      sourceId: "source-session-001",
      sourcePath: "/fixtures/codex/session.jsonl",
      parserVersion: "test/1",
      sourceDigest,
      importedAt,
    },
  };
}

function makeSource(): SessionSourceReference {
  return {
    sourceKind: "codex",
    sourceId: "source-session-001",
    sourcePath: "/fixtures/codex/session.jsonl",
    sourceDigest,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical session validation", () => {
  it("rejects unsupported source kinds and missing tree references", () => {
    const session = makeSession("/tmp/pi-zcode-migration-workspace");
    const invalid = {
      ...session,
      provenance: { ...session.provenance, sourceKind: "unknown" },
      entries: [{ ...session.entries[1], parentId: "missing-parent" }],
    } as unknown as CanonicalSession;

    const issues = validateCanonicalSession(invalid);
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["provenance.sourceKind", "entries[0].parentId"]),
    );
  });
});

describe("writeCanonicalSession", () => {
  it("writes a Pi v3 JSONL file atomically, redacts secrets, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zcode-migration-"));
    roots.push(root);
    const session = makeSession(join(root, "workspace"));
    const first = await writeCanonicalSession({
      sessionRoot: root,
      session,
      source: makeSource(),
      parserVersion: "test/1",
      now: () => new Date("2026-01-01T01:00:00.000Z"),
    });

    expect(first.duplicate).toBe(false);
    expect(first.manifest.state).toBe("committed");
    expect(first.manifest.secretFieldsExcluded).toEqual(["data.apiKey", "data.nested.password"]);
    expect(first.manifest.sourceRecordMap).toEqual([
      { entryId: "user-001", sourceOrdinal: 0, unmapped: false },
      { entryId: "source-001", sourceOrdinal: 1, unmapped: false },
    ]);
    expect(encodeCwd(session.cwd)).toMatch(/^--.*--$/);

    const contents = await readFile(first.sessionPath, "utf8");
    const records = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({ type: "session", version: 3, cwd: session.cwd });
    expect(contents).toContain("retained");
    expect(contents).not.toContain("secret-value");
    expect(contents).not.toContain("secret-password");
    expect(
      (records.at(-1)?.data as { secretFieldsExcluded: string[] }).secretFieldsExcluded,
    ).toEqual(["data.apiKey", "data.nested.password"]);

    const second = await writeCanonicalSession({
      sessionRoot: root,
      session,
      source: makeSource(),
      parserVersion: "test/1",
      now: () => new Date("2026-01-01T02:00:00.000Z"),
    });
    expect(second.duplicate).toBe(true);
    expect(second.sessionPath).toBe(first.sessionPath);
    expect(second.manifest.createdAt).toBe(first.manifest.createdAt);
    expect(
      (await readdir(join(root, encodeCwd(session.cwd)))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("does not overwrite an existing target that is not an imported session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zcode-migration-"));
    roots.push(root);
    const session = makeSession(join(root, "workspace"));
    const first = await writeCanonicalSession({
      sessionRoot: root,
      session,
      source: makeSource(),
      parserVersion: "test/1",
    });
    await writeFile(first.sessionPath, "existing-user-file\n", "utf8");

    const conflict = await writeCanonicalSession({
      sessionRoot: root,
      session,
      source: makeSource(),
      parserVersion: "test/1",
    });
    expect(conflict.duplicate).toBe(false);
    expect(conflict.manifest.state).toBe("skipped");
    expect(conflict.manifest.conflicts[0]?.existingPath).toBe(first.sessionPath);
    expect(await readFile(first.sessionPath, "utf8")).toBe("existing-user-file\n");
  });

  it("detects tampering even when the old manifest remains embedded", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zcode-migration-tamper-"));
    roots.push(root);
    const session = makeSession(join(root, "workspace"));
    const first = await writeCanonicalSession({
      sessionRoot: root,
      session,
      source: makeSource(),
      parserVersion: "test/1",
    });
    const tampered = (await readFile(first.sessionPath, "utf8")).replace(
      "Keep this message",
      "Tampered message",
    );
    await writeFile(first.sessionPath, tampered, "utf8");

    const conflict = await writeCanonicalSession({
      sessionRoot: root,
      session,
      source: makeSource(),
      parserVersion: "test/1",
    });
    expect(conflict.duplicate).toBe(false);
    expect(conflict.manifest.state).toBe("skipped");
    expect(conflict.manifest.conflicts).toHaveLength(1);
    expect(await readFile(first.sessionPath, "utf8")).toContain("Tampered message");
  });

  it("reports a content conflict for the same stable source identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zcode-migration-"));
    roots.push(root);
    const session = makeSession(join(root, "workspace"));
    const first = await writeCanonicalSession({
      sessionRoot: root,
      session,
      source: makeSource(),
      parserVersion: "test/1",
    });
    const changedSession: CanonicalSession = {
      ...session,
      entries: session.entries.map((entry) => {
        if (entry.type !== "message" || entry.message.role !== "user") return entry;
        return {
          ...entry,
          message: { ...entry.message, content: "Changed message" },
        };
      }),
    };

    const conflict = await writeCanonicalSession({
      sessionRoot: root,
      session: changedSession,
      source: makeSource(),
      parserVersion: "test/1",
    });
    expect(conflict.duplicate).toBe(false);
    expect(conflict.manifest.state).toBe("skipped");
    expect(conflict.manifest.conflicts).toHaveLength(1);
    expect(await readFile(first.sessionPath, "utf8")).toContain("Keep this message");
  });

  it("rejects a cwd slug symlink before writing outside the session root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zcode-migration-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "pi-zcode-migration-outside-"));
    roots.push(root, outsideRoot);
    const session = makeSession(join(root, "workspace"));
    const symlinkPath = join(root, encodeCwd(session.cwd));
    await symlink(outsideRoot, symlinkPath, "dir");

    await expect(
      writeCanonicalSession({
        sessionRoot: root,
        session,
        source: makeSource(),
        parserVersion: "test/1",
      }),
    ).rejects.toThrow("must be a real directory");
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it("rejects relative workspace paths before creating a target", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zcode-migration-"));
    roots.push(root);
    const session = makeSession("relative/workspace");
    expect(validateCanonicalSession(session).map((issue) => issue.path)).toContain("cwd");
    await expect(
      writeCanonicalSession({
        sessionRoot: root,
        session,
        source: makeSource(),
        parserVersion: "test/1",
      }),
    ).rejects.toThrow("Invalid canonical session");
    expect(await readdir(root)).toEqual([]);
  });
});
