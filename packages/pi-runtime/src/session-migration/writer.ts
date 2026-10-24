import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  canonicalJson,
  createStableSessionIdentity,
  sha256,
  assertValidCanonicalSession,
} from "./canonical.js";
import type {
  CanonicalSession,
  CanonicalSessionEntry,
  ImportManifest,
  SessionSourceReference,
} from "./contract.js";

const MIGRATION_ENTRY_TYPE = "zcode-session-migration-manifest";
const SECRET_FIELD_PATTERN =
  /^(?:api[-_]?key|(?:api|oauth|access|refresh|id|session)?[-_]?token|authorization|cookie|password|bearer|(?:client[-_]?)?secret|credentials?|private[-_]?key)$/i;

export interface WriteCanonicalSessionOptions {
  readonly sessionRoot: string;
  readonly session: CanonicalSession;
  readonly source: SessionSourceReference;
  readonly parserVersion: string;
  readonly skipped?: readonly { ordinal?: number; reason: string }[];
  readonly secretFieldsExcluded?: readonly string[];
  readonly now?: () => Date;
}

export interface WriteCanonicalSessionResult {
  readonly sessionPath: string;
  readonly manifest: ImportManifest;
  readonly duplicate: boolean;
}

/**
 * Write one Pi-compatible JSONL session without replacing an existing session.
 * The manifest is embedded as a Pi custom entry so a single atomic file publish
 * commits both the conversation and its migration report.
 */
export async function writeCanonicalSession(
  options: WriteCanonicalSessionOptions,
): Promise<WriteCanonicalSessionResult> {
  const { session, source } = options;
  assertValidCanonicalSession(session);
  if (!isAbsolute(options.sessionRoot)) throw new Error("sessionRoot must be an absolute path");
  if (
    source.sourceKind !== session.provenance.sourceKind ||
    source.sourceId !== session.provenance.sourceId
  ) {
    throw new Error("Source reference does not match canonical session provenance");
  }

  const now = options.now ?? (() => new Date());
  const secretFieldsExcluded = new Set(options.secretFieldsExcluded ?? []);
  const baseEntries = session.entries.map((entry) => toPiEntry(entry, secretFieldsExcluded));
  const sourceDigest =
    source.sourceDigest ??
    session.provenance.sourceDigest ??
    sha256(
      canonicalJson({
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        entries: session.entries,
      }),
    );
  if (!/^[a-f0-9]{64}$/i.test(sourceDigest))
    throw new Error("sourceDigest must be a SHA-256 hex digest");

  const identity = createStableSessionIdentity({ ...source, sourceDigest }, sourceDigest);
  const createdAt = now().toISOString();
  const header = {
    type: "session" as const,
    version: 3 as const,
    id: identity.sessionId,
    timestamp: session.createdAt,
    cwd: session.cwd,
  };
  const targetDigest = sha256(canonicalJson({ header, entries: baseEntries }));
  const counts = {
    sourceRecords: session.entries.length,
    writtenEntries: baseEntries.length + 1,
    skippedRecords: options.skipped?.length ?? 0,
    unmappedRecords: session.entries.filter((entry) => entry.unmapped).length,
  };
  const sourceRecordMap = session.entries.map((entry) => ({
    entryId: entry.id,
    sourceOrdinal: entry.sourceOrdinal,
    ...(entry.sourceRecordId ? { sourceRecordId: entry.sourceRecordId } : {}),
    unmapped: entry.unmapped ?? false,
  }));
  const manifest: ImportManifest = {
    source: { ...source, sourceDigest },
    parserVersion: options.parserVersion,
    sourceDigest,
    targetSessionId: identity.sessionId,
    targetDigest,
    state: "committed",
    counts,
    sourceRecordMap,
    skipped: [...(options.skipped ?? [])],
    conflicts: [],
    secretFieldsExcluded: [...secretFieldsExcluded].sort(),
    createdAt,
  };
  const manifestEntry = makeManifestEntry(session, manifest);
  const entries = [...baseEntries, manifestEntry];
  const jsonl = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const targetDir = join(resolve(options.sessionRoot), encodeCwd(session.cwd));
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const rootPath = await realpath(options.sessionRoot);
  const targetDirStat = await lstat(targetDir);
  if (!targetDirStat.isDirectory() || targetDirStat.isSymbolicLink()) {
    throw new Error("Pi session directory must be a real directory");
  }
  const resolvedTargetDir = await realpath(targetDir);
  assertInsideRoot(rootPath, resolvedTargetDir);

  const filenameTimestamp = session.createdAt.replace(/[:.]/g, "-");
  const sessionPath = join(resolvedTargetDir, `${filenameTimestamp}_${identity.sessionId}.jsonl`);
  const parentPath = await realpath(dirname(sessionPath));
  assertInsideRoot(rootPath, parentPath);

  try {
    const existing = await readExistingSession(sessionPath);
    if (existing !== null) {
      if (existing.manifest && existing.targetDigest === targetDigest) {
        return { sessionPath, manifest: existing.manifest, duplicate: true };
      }
      return {
        sessionPath,
        manifest: {
          ...manifest,
          state: "skipped",
          targetDigest: existing.targetDigest,
          conflicts: [
            {
              existingPath: sessionPath,
              reason: "Target session path already exists with different content",
            },
          ],
        },
        duplicate: false,
      };
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const tempPath = `${sessionPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(jsonl, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // link() is an atomic, exclusive create on the same filesystem. Unlike
      // rename(), it cannot replace a session another importer created first.
      await link(tempPath, sessionPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readExistingSession(sessionPath);
      if (existing?.manifest && existing.targetDigest === targetDigest) {
        return { sessionPath, manifest: existing.manifest, duplicate: true };
      }
      return {
        sessionPath,
        duplicate: false,
        manifest: {
          ...manifest,
          state: "skipped",
          targetDigest: existing?.targetDigest,
          conflicts: [
            { existingPath: sessionPath, reason: "Concurrent import created a different session" },
          ],
        },
      };
    }
    await syncDirectory(parentPath);
    return { sessionPath, manifest, duplicate: false };
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

export function encodeCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  const resolvedCwd = resolve(cwd);
  if (resolvedCwd.includes("\0")) throw new Error("Invalid encoded cwd");
  return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function toPiEntry(entry: CanonicalSessionEntry, excluded: Set<string>): SessionEntry {
  const {
    sourceOrdinal: _sourceOrdinal,
    sourceRecordId: _sourceRecordId,
    unmapped: _unmapped,
    ...piEntry
  } = entry;
  return redactSecrets(piEntry, "", excluded) as SessionEntry;
}

function makeManifestEntry(session: CanonicalSession, manifest: ImportManifest): SessionEntry {
  const leafId = session.leafId ?? session.entries.at(-1)?.id ?? null;
  const id = `mig-${sha256(`${manifest.targetSessionId}\0${manifest.targetDigest}`).slice(0, 24)}`;
  return {
    type: "custom",
    id,
    parentId: leafId,
    timestamp: manifest.createdAt,
    customType: MIGRATION_ENTRY_TYPE,
    data: manifest,
  } as SessionEntry;
}

function redactSecrets(value: unknown, parentPath: string, excluded: Set<string>): unknown {
  if (Array.isArray(value))
    return value.map((item, index) => redactSecrets(item, `${parentPath}[${index}]`, excluded));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = parentPath ? `${parentPath}.${key}` : key;
    if (SECRET_FIELD_PATTERN.test(key)) {
      excluded.add(path);
      continue;
    }
    output[key] = redactSecrets(child, path, excluded);
  }
  return output;
}

async function readExistingSession(path: string): Promise<{
  readonly targetDigest: string;
  readonly manifest?: ImportManifest;
} | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    },
  );
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Existing target is not a regular file: ${path}`);
    const content = await handle.readFile("utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const manifestRecord = lines
      .map(parseJsonRecord)
      .find(
        (record): record is { type: "custom"; customType: string; data: ImportManifest } =>
          record?.type === "custom" &&
          record.customType === MIGRATION_ENTRY_TYPE &&
          isImportManifest(record.data),
      );
    return {
      targetDigest: manifestRecord?.data.targetDigest ?? sha256(content),
      ...(manifestRecord ? { manifest: manifestRecord.data } : {}),
    };
  } finally {
    await handle.close();
  }
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isImportManifest(value: unknown): value is ImportManifest {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as ImportManifest).targetSessionId === "string" &&
    typeof (value as ImportManifest).targetDigest === "string" &&
    typeof (value as ImportManifest).state === "string",
  );
}

function assertInsideRoot(rootPath: string, candidatePath: string): void {
  const pathFromRoot = relative(rootPath, candidatePath);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`Target path escapes Pi session root: ${candidatePath}`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY).catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
