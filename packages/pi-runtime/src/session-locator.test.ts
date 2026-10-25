import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findSessionFile } from "./session-locator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session locator", () => {
  it("resolves migrated ids from the JSONL header instead of filename matching", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zcode-session-locator-"));
    roots.push(root);
    const projectDir = join(root, "--workspace--");
    await mkdir(projectDir, { recursive: true });
    const migratedId = "m-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const sessionPath = join(projectDir, "2026-01-01T00-00-00.000Z-unrelated-name.jsonl");
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: "session", version: 3, id: migratedId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`,
      "utf8",
    );

    await expect(findSessionFile(migratedId, root)).resolves.toBe(sessionPath);
    await expect(findSessionFile(`${migratedId}-missing`, root)).resolves.toBeNull();
  });
});
