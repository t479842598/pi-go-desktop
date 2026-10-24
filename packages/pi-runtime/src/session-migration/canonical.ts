import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  asSessionMigrationId,
  type CanonicalSession,
  type CanonicalSessionEntry,
  type SessionSourceReference,
  type SessionSourceKind,
} from "./contract.js";

const SESSION_SOURCE_KINDS = new Set<SessionSourceKind>([
  "pi",
  "reasonix",
  "codex",
  "zcode",
  "deepseekharness",
  "claude-code",
]);
const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/i;
const ENTRY_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
const VALID_ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "usage",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "context_edit",
  "label",
  "session_info",
]);

export interface CanonicalValidationIssue {
  readonly path: string;
  readonly message: string;
}

export function validateCanonicalSession(session: CanonicalSession): CanonicalValidationIssue[] {
  const issues: CanonicalValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (session.version !== 3) add("version", "Pi session version must be 3");
  if (!SESSION_ID_PATTERN.test(session.sessionId)) add("sessionId", "Invalid session id");
  if (!isAbsolute(session.cwd)) add("cwd", "Session cwd must be an absolute path");
  if (!isIsoTimestamp(session.createdAt)) add("createdAt", "Expected an ISO timestamp");
  if (!isIsoTimestamp(session.updatedAt)) add("updatedAt", "Expected an ISO timestamp");
  if (!SESSION_SOURCE_KINDS.has(session.provenance.sourceKind)) {
    add("provenance.sourceKind", "Unsupported source kind");
  }
  if (!session.provenance.sourceId.trim()) add("provenance.sourceId", "Source id is required");
  if (!session.provenance.parserVersion.trim())
    add("provenance.parserVersion", "Parser version is required");
  if (!isIsoTimestamp(session.provenance.importedAt)) {
    add("provenance.importedAt", "Expected an ISO timestamp");
  }
  if (!Array.isArray(session.entries)) {
    add("entries", "Entries must be an array");
    return issues;
  }

  const entriesById = new Map<string, CanonicalSessionEntry>();
  for (const [index, entry] of session.entries.entries()) {
    const path = `entries[${index}]`;
    if (!entry || typeof entry !== "object") {
      add(path, "Entry must be an object");
      continue;
    }
    if (!ENTRY_ID_PATTERN.test(entry.id)) add(`${path}.id`, "Invalid Pi entry id");
    if (entriesById.has(entry.id)) add(`${path}.id`, `Duplicate entry id: ${entry.id}`);
    else entriesById.set(entry.id, entry);
    if (!VALID_ENTRY_TYPES.has(entry.type))
      add(`${path}.type`, `Unsupported Pi entry type: ${entry.type}`);
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      add(`${path}.parentId`, "parentId must be a string or null");
    }
    if (!isIsoTimestamp(entry.timestamp)) add(`${path}.timestamp`, "Expected an ISO timestamp");
    if (!Number.isSafeInteger(entry.sourceOrdinal) || entry.sourceOrdinal < 0) {
      add(`${path}.sourceOrdinal`, "sourceOrdinal must be a non-negative safe integer");
    }
    if (entry.type === "message" && (!entry.message || typeof entry.message !== "object")) {
      add(`${path}.message`, "Message entries require a message object");
    }
    if (entry.type === "custom" && !entry.customType) {
      add(`${path}.customType`, "Custom entries require customType");
    }
    if (entry.type === "compaction" && !entry.firstKeptEntryId) {
      add(`${path}.firstKeptEntryId`, "Compaction entries require firstKeptEntryId");
    }
  }

  for (const [index, entry] of session.entries.entries()) {
    if (entry.parentId !== null && !entriesById.has(entry.parentId)) {
      add(`entries[${index}].parentId`, `Missing parent entry: ${entry.parentId}`);
    }
    if (entry.type === "compaction" && !entriesById.has(entry.firstKeptEntryId)) {
      add(
        `entries[${index}].firstKeptEntryId`,
        `Missing retained entry: ${entry.firstKeptEntryId}`,
      );
    }
    if (entry.type === "branch_summary" && !entriesById.has(entry.fromId)) {
      add(`entries[${index}].fromId`, `Missing summarized entry: ${entry.fromId}`);
    }
    if (entry.type === "context_edit" && !entriesById.has(entry.targetId)) {
      add(`entries[${index}].targetId`, `Missing context-edit target: ${entry.targetId}`);
    }
    if (entry.type === "label" && !entriesById.has(entry.targetId)) {
      add(`entries[${index}].targetId`, `Missing label target: ${entry.targetId}`);
    }
  }

  if (session.leafId && !entriesById.has(session.leafId)) {
    add("leafId", `Missing leaf entry: ${session.leafId}`);
  }
  detectParentCycles(session.entries, add);
  try {
    JSON.stringify(session);
  } catch {
    add("entries", "Session contains values that cannot be serialized as JSON");
  }
  return issues;
}

export function assertValidCanonicalSession(session: CanonicalSession): void {
  const issues = validateCanonicalSession(session);
  if (issues.length > 0) {
    throw new Error(
      `Invalid canonical session: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
}

export function createStableSessionIdentity(
  source: SessionSourceReference,
  contentDigest: string,
): {
  migrationId: ReturnType<typeof asSessionMigrationId>;
  sessionId: ReturnType<typeof asSessionMigrationId>;
} {
  if (!source.sourceId.trim())
    throw new Error("sourceId is required to create a stable session identity");
  if (!/^[a-f0-9]{64}$/i.test(contentDigest))
    throw new Error("contentDigest must be a SHA-256 hex digest");
  const digest = createHash("sha256")
    .update(`${source.sourceKind}\0${source.sourceId}\0${contentDigest.toLowerCase()}`)
    .digest("hex");
  const id = `m-${digest}`;
  return { migrationId: asSessionMigrationId(id), sessionId: asSessionMigrationId(id) };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function detectParentCycles(
  entries: readonly CanonicalSessionEntry[],
  add: (path: string, message: string) => void,
): void {
  const parentById = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const complete = new Set<string>();
  for (const entry of entries) {
    const path = new Set<string>();
    let current: string | null = entry.id;
    while (current !== null && parentById.has(current) && !complete.has(current)) {
      if (path.has(current)) {
        add(`entries.${entry.id}.parentId`, `Parent cycle includes entry: ${current}`);
        break;
      }
      path.add(current);
      current = parentById.get(current) ?? null;
    }
    for (const id of path) complete.add(id);
  }
}
