import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  asSessionMigrationId,
  type CanonicalSession,
  type ImportManifest,
  type SessionMigrationContract,
  type SessionMigrationId,
  type SessionSourceKind,
  type SessionSourceReference,
} from "./contract.js";
import { createStableSessionIdentity, sha256 } from "./canonical.js";
import { SessionSourceAdapterRegistry } from "./registry.js";
import { writeCanonicalSession } from "./writer.js";

const FAILURE_REPORT_DIR = ".zcode-migration-reports";
const MAX_REPORT_FILES = 10_000;
const MAX_REPORT_DEPTH = 8;
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

export interface SessionMigrationServiceOptions {
  readonly sessionRoot: string;
  readonly registry?: SessionSourceAdapterRegistry;
  readonly now?: () => Date;
}

/**
 * Coordinates source adapters and the canonical PiG session writer.
 * Adapters never write target files; this service owns the preview/import
 * boundary and turns parser failures into persistent audit manifests.
 */
export class SessionMigrationService implements SessionMigrationContract {
  readonly sessionRoot: string;
  readonly registry: SessionSourceAdapterRegistry;
  private readonly now: () => Date;

  constructor(options: SessionMigrationServiceOptions) {
    if (!resolve(options.sessionRoot)) throw new Error("sessionRoot is required");
    this.sessionRoot = resolve(options.sessionRoot);
    this.registry = options.registry ?? new SessionSourceAdapterRegistry();
    this.now = options.now ?? (() => new Date());
  }

  async discover(
    sourceKind: SessionSourceKind,
    root: string,
  ): Promise<readonly SessionSourceReference[]> {
    return this.registry.get(sourceKind).discover({ root: resolve(root) });
  }

  async preview(reference: SessionSourceReference): Promise<CanonicalSession> {
    const adapter = this.registry.get(reference.sourceKind);
    const document = await adapter.read(reference);
    const session = await adapter.normalize(document, reference);
    adapter.validate(session);
    return session;
  }

  async import(reference: SessionSourceReference): Promise<ImportManifest> {
    const adapter = this.registry.get(reference.sourceKind);
    try {
      const session = await this.preview(reference);
      const result = await writeCanonicalSession({
        sessionRoot: this.sessionRoot,
        session,
        source: reference,
        parserVersion: adapter.parserVersion,
        skipped: session.skippedRecords,
        now: this.now,
      });
      return result.manifest;
    } catch (error) {
      const failure = await this.buildFailureManifest(reference, adapter.parserVersion, error);
      await persistFailureManifest(this.sessionRoot, failure);
      return failure;
    }
  }

  async report(migrationId: SessionMigrationId): Promise<ImportManifest | null> {
    const failure = await readFailureManifest(this.sessionRoot, migrationId);
    if (failure) return failure;

    const sessionFiles = await collectJsonlFiles(this.sessionRoot);
    for (const filePath of sessionFiles) {
      let content: string;
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile() || fileStat.size > MAX_SESSION_FILE_BYTES) continue;
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { customType?: unknown; data?: unknown };
          if (
            record.customType === "zcode-session-migration-manifest" &&
            isImportManifest(record.data) &&
            record.data.targetSessionId === migrationId
          ) {
            return record.data;
          }
        } catch {
          // A damaged target is not allowed to make report() fail for other sessions.
        }
      }
    }
    return null;
  }

  private async buildFailureManifest(
    source: SessionSourceReference,
    parserVersion: string,
    error: unknown,
  ): Promise<ImportManifest> {
    const failureKey = sha256(
      `failed\0${source.sourceKind}\0${source.sourceId}\0${source.sourcePath}`,
    );
    const identity = createStableSessionIdentity(
      { ...source, sourceDigest: failureKey },
      failureKey,
    );
    const message = error instanceof Error ? error.message : String(error);
    return {
      source,
      ...(source.sourceDigest ? { sourceDigest: source.sourceDigest } : {}),
      parserVersion,
      targetSessionId: identity.sessionId,
      state: "failed",
      counts: { sourceRecords: 0, writtenEntries: 0, skippedRecords: 1, unmappedRecords: 0 },
      sourceRecordMap: [],
      skipped: [{ reason: `import-failed: ${message}` }],
      conflicts: [],
      secretFieldsExcluded: [],
      createdAt: this.now().toISOString(),
      error: message,
    };
  }
}

export function createSessionMigrationService(
  options: SessionMigrationServiceOptions,
): SessionMigrationService {
  return new SessionMigrationService(options);
}

async function persistFailureManifest(
  sessionRoot: string,
  manifest: ImportManifest,
): Promise<void> {
  const reportDir = join(sessionRoot, FAILURE_REPORT_DIR);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const targetPath = join(reportDir, `${manifest.targetSessionId}.json`);
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, targetPath);
}

async function readFailureManifest(
  sessionRoot: string,
  migrationId: SessionMigrationId,
): Promise<ImportManifest | null> {
  try {
    const content = await readFile(
      join(sessionRoot, FAILURE_REPORT_DIR, `${migrationId}.json`),
      "utf8",
    );
    const value: unknown = JSON.parse(content);
    return isImportManifest(value) ? value : null;
  } catch {
    return null;
  }
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (pending.length > 0 && files.length < MAX_REPORT_FILES) {
    const current = pending.pop();
    if (!current || current.depth > MAX_REPORT_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === FAILURE_REPORT_DIR) continue;
      const childPath = join(current.path, entry.name);
      if (entry.isDirectory()) pending.push({ path: childPath, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(childPath);
    }
  }
  return files;
}

function isImportManifest(value: unknown): value is ImportManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<ImportManifest>;
  return (
    typeof manifest.targetSessionId === "string" &&
    typeof manifest.parserVersion === "string" &&
    typeof manifest.state === "string" &&
    typeof manifest.createdAt === "string" &&
    Boolean(manifest.source && typeof manifest.source === "object")
  );
}
