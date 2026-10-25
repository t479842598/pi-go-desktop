import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  type CanonicalSession,
  type CanonicalSessionEntry,
  type SessionSourceAdapter,
  type SessionSourceKind,
  type SessionSourceReference,
} from "./contract.js";
import { assertValidCanonicalSession, createStableSessionIdentity, sha256 } from "./canonical.js";

const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DISCOVERED_FILES = 10_000;
const MAX_DISCOVERY_DEPTH = 24;
const VALID_PI_ENTRY_TYPES = new Set([
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

interface ParsedRecord {
  readonly ordinal: number;
  readonly value: Record<string, unknown>;
}

export interface SourceDocument {
  readonly records: readonly ParsedRecord[];
  readonly header?: Record<string, unknown>;
  readonly skipped: readonly { ordinal?: number; reason: string }[];
  readonly digest: string;
  readonly modifiedAt: number;
}

interface MessageShape {
  readonly role: string;
  readonly content: unknown;
  readonly timestamp?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

export class FileSessionSourceAdapter implements SessionSourceAdapter<SourceDocument> {
  readonly parserVersion = "file-session-adapter/1";

  constructor(readonly sourceKind: SessionSourceKind) {}

  async discover(input: { readonly root: string }): Promise<readonly SessionSourceReference[]> {
    const root = resolve(input.root);
    const rootStat = await stat(root);
    const rootRealPath = await realpath(root);
    const files = rootStat.isFile() ? [root] : await collectFiles(root, this.sourceKind);
    const references: SessionSourceReference[] = [];

    for (const sourcePath of files.slice(0, MAX_DISCOVERED_FILES)) {
      const sourceRealPath = await realpath(sourcePath);
      assertInsideRoot(rootRealPath, sourceRealPath);
      const sourceStat = await stat(sourceRealPath);
      if (!sourceStat.isFile() || sourceStat.size > MAX_SOURCE_FILE_BYTES) continue;
      const bytes = await readFile(sourceRealPath);
      const relativePath = rootStat.isFile()
        ? sourceStatPath(sourceRealPath)
        : relative(rootRealPath, sourceRealPath);
      references.push({
        sourceKind: this.sourceKind,
        sourceId: `${this.sourceKind}:${relativePath || sourceRealPath}`,
        sourcePath: sourceRealPath,
        sourceRoot: rootRealPath,
        workspacePath: rootStat.isDirectory() ? rootRealPath : resolve(rootRealPath, ".."),
        sizeBytes: sourceStat.size,
        sourceDigest: sha256(bytes),
      });
    }

    return references.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  }

  async read(reference: SessionSourceReference): Promise<SourceDocument> {
    if (reference.sourceKind !== this.sourceKind)
      throw new Error("Source kind does not match adapter");
    const sourcePath = await realpath(reference.sourcePath);
    if (reference.sourceRoot) assertInsideRoot(await realpath(reference.sourceRoot), sourcePath);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error("Source session must be a regular file");
    if (sourceStat.size > MAX_SOURCE_FILE_BYTES)
      throw new Error("Source session exceeds the 32 MiB limit");
    const content = await readFile(sourcePath, "utf8");
    const digest = sha256(content);
    if (reference.sourceDigest && reference.sourceDigest !== digest) {
      throw new Error("Source session changed after discovery; discover it again before importing");
    }

    const skipped: { ordinal?: number; reason: string }[] = [];
    let values: { ordinal: number; value: unknown }[];
    let header: Record<string, unknown> | undefined;
    if (extname(sourcePath).toLowerCase() === ".json") {
      try {
        const parsed: unknown = JSON.parse(content);
        const object = asRecord(parsed);
        const items = object?.entries ?? object?.messages ?? object?.records;
        values = Array.isArray(items)
          ? items.map((value, ordinal) => ({ ordinal, value }))
          : [{ ordinal: 0, value: parsed }];
        header = asRecord(object?.session) ?? (object?.type === "session" ? object : undefined);
      } catch {
        throw new Error("Invalid JSON source session");
      }
    } else {
      values = [];
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line?.trim()) continue;
        try {
          values.push({ ordinal: index, value: JSON.parse(line) as unknown });
        } catch {
          skipped.push({ ordinal: index, reason: "malformed-json-line" });
        }
      }
    }

    const records: ParsedRecord[] = [];
    values.forEach(({ ordinal, value }) => {
      const object = asRecord(value);
      if (!object) {
        skipped.push({ ordinal, reason: "record-is-not-an-object" });
        return;
      }
      if (object.type === "session") {
        header = object;
        return;
      }
      records.push({ ordinal, value: object });
    });

    return {
      records,
      ...(header ? { header } : {}),
      skipped,
      digest,
      modifiedAt: sourceStat.mtimeMs,
    };
  }

  async normalize(
    document: SourceDocument,
    reference: SessionSourceReference,
  ): Promise<CanonicalSession> {
    const now = new Date(document.modifiedAt).toISOString();
    const headerCwd = readString(document.header?.cwd);
    const recordCwd = document.records
      .map((item) => findWorkspace(item.value))
      .find((value): value is string => Boolean(value && isAbsolute(value)));
    const cwd =
      headerCwd && isAbsolute(headerCwd)
        ? headerCwd
        : (recordCwd ??
          reference.workspacePath ??
          reference.sourceRoot ??
          resolve(reference.sourcePath, ".."));
    const createdAt =
      normalizeTimestamp(document.header?.timestamp) ??
      document.records.map((item) => findTimestamp(item.value, this.sourceKind)).find(Boolean) ??
      now;
    const entries: CanonicalSessionEntry[] = [];
    const skipped = [...document.skipped];
    const idMap = new Map<string, string>();
    const piEntryIdsByOrdinal = new Map<number, string>();
    const claudeToolNames = new Map<string, string>();
    let previousId: string | null = null;

    if (this.sourceKind === "pi") {
      for (const { ordinal, value } of document.records) {
        if (!isPiEntry(value)) continue;
        const originalId = readString(value.id);
        const id = originalId && !idMap.has(originalId) ? originalId : entryId(reference, ordinal);
        if (originalId && !idMap.has(originalId)) idMap.set(originalId, id);
        piEntryIdsByOrdinal.set(ordinal, id);
      }
    }

    for (const { ordinal, value } of document.records) {
      if (this.sourceKind === "pi" && isPiEntry(value)) {
        const originalId = readString(value.id);
        const id = piEntryIdsByOrdinal.get(ordinal) ?? entryId(reference, ordinal);
        const timestamp = normalizeTimestamp(value.timestamp) ?? createdAt;
        const parent = typeof value.parentId === "string" ? value.parentId : null;
        const parentId = parent === null ? null : (idMap.get(parent) ?? null);
        if (parent && !idMap.has(parent)) {
          skipped.push({ ordinal, reason: `unresolved-parent-reference:${parent}` });
        }
        entries.push({
          ...(value as unknown as SessionEntry),
          id,
          parentId,
          timestamp,
          sourceOrdinal: ordinal,
          ...(originalId ? { sourceRecordId: originalId } : {}),
        } as CanonicalSessionEntry);
        previousId = id;
        continue;
      }

      const shapes = extractMessages(value, this.sourceKind, claudeToolNames);
      let written = 0;
      let skippedRole: string | undefined;
      for (const [shapeIndex, shape] of shapes.entries()) {
        if (shape.role === "system" || shape.role === "developer") {
          skippedRole = shape.role;
          continue;
        }
        const id = entryId(reference, ordinal, shapeIndex);
        const timestamp =
          normalizeTimestamp(shape.timestamp ?? findTimestamp(value, this.sourceKind)) ?? createdAt;
        const entry = makeMessageEntry(shape, id, previousId, timestamp, ordinal, value);
        if (!entry) continue;
        entries.push(entry);
        previousId = id;
        written += 1;
      }
      if (written > 0) continue;

      if (skippedRole) {
        skipped.push({ ordinal, reason: `non-conversation-role:${skippedRole}` });
        continue;
      }

      const id = entryId(reference, ordinal);
      const timestamp = normalizeTimestamp(findTimestamp(value, this.sourceKind)) ?? createdAt;
      entries.push({
        type: "custom",
        id,
        parentId: previousId,
        timestamp,
        customType: "zcode-session-migration-source-record",
        data: { sourceKind: this.sourceKind, ordinal, record: value },
        sourceOrdinal: ordinal,
        ...(readString(value.id) ? { sourceRecordId: readString(value.id) } : {}),
        unmapped: true,
      } as CanonicalSessionEntry);
      previousId = id;
    }

    if (entries.length === 0) {
      throw new Error(`No importable records found in ${reference.sourcePath}`);
    }

    const identity = createStableSessionIdentity(
      { ...reference, sourceDigest: document.digest },
      document.digest,
    );
    const session: CanonicalSession = {
      version: 3,
      sessionId: identity.sessionId,
      cwd,
      createdAt,
      updatedAt:
        document.records
          .map((item) => findTimestamp(item.value, this.sourceKind))
          .filter(Boolean)
          .at(-1) ?? now,
      entries,
      ...(previousId ? { leafId: previousId } : {}),
      provenance: {
        sourceKind: this.sourceKind,
        sourceId: reference.sourceId,
        sourcePath: reference.sourcePath,
        parserVersion: this.parserVersion,
        sourceDigest: document.digest,
        importedAt: new Date().toISOString(),
      },
      skippedRecords: skipped,
    };
    assertValidCanonicalSession(session);
    return session;
  }

  validate(session: CanonicalSession): void {
    assertValidCanonicalSession(session);
  }
}

export function createDefaultSessionSourceAdapters(): readonly SessionSourceAdapter<SourceDocument>[] {
  return [
    new FileSessionSourceAdapter("pi"),
    new FileSessionSourceAdapter("reasonix"),
    new FileSessionSourceAdapter("codex"),
    new FileSessionSourceAdapter("zcode"),
    new FileSessionSourceAdapter("deepseekharness"),
    new FileSessionSourceAdapter("claude-code"),
  ];
}

async function collectFiles(root: string, sourceKind: SessionSourceKind): Promise<string[]> {
  const acceptedExtensions =
    sourceKind === "zcode" ? new Set([".jsonl", ".json"]) : new Set([".jsonl"]);
  const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  const files: string[] = [];
  while (pending.length > 0 && files.length < MAX_DISCOVERED_FILES) {
    const current = pending.pop();
    if (!current || current.depth > MAX_DISCOVERY_DEPTH) continue;
    let children;
    try {
      children = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = resolve(current.path, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) pending.push({ path: childPath, depth: current.depth + 1 });
      else if (child.isFile() && acceptedExtensions.has(extname(child.name).toLowerCase()))
        files.push(childPath);
    }
  }
  return files;
}

function sourceStatPath(sourcePath: string): string {
  return sourcePath.split(sep).at(-1) ?? sourcePath;
}

function assertInsideRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Source path escapes its declared root");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return undefined;
}

function findTimestamp(
  value: Record<string, unknown>,
  sourceKind: SessionSourceKind,
): string | undefined {
  const payload = asRecord(value.payload);
  const message = asRecord(value.message);
  const timestamp =
    value.timestamp ??
    value.createdAt ??
    value.created_at ??
    payload?.timestamp ??
    message?.timestamp;
  if (sourceKind === "reasonix" && typeof value.createdAt === "number")
    return normalizeTimestamp(value.createdAt);
  return normalizeTimestamp(timestamp);
}

function findWorkspace(value: Record<string, unknown>): string | undefined {
  const payload = asRecord(value.payload);
  const message = asRecord(value.message);
  const meta = asRecord(value.meta) ?? asRecord(payload?.meta);
  const candidate =
    value.cwd ??
    value.workspacePath ??
    value.workspace_path ??
    value.projectPath ??
    meta?.cwd ??
    payload?.cwd ??
    message?.cwd;
  return readString(candidate);
}

function isPiEntry(value: Record<string, unknown>): boolean {
  return (
    typeof value.type === "string" &&
    VALID_PI_ENTRY_TYPES.has(value.type) &&
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.timestamp === "string"
  );
}

function extractMessages(
  value: Record<string, unknown>,
  sourceKind: SessionSourceKind,
  claudeToolNames: Map<string, string>,
): MessageShape[] {
  let record = value;
  let payload = asRecord(value.payload);
  if (sourceKind === "codex" && value.type === "response_item" && payload) record = payload;
  else if (sourceKind === "codex" && value.type === "event_msg" && payload) record = payload;

  const nestedMessage = asRecord(record.message);
  let role = readString(record.role) ?? readString(nestedMessage?.role);
  let content: unknown = nestedMessage?.content ?? record.content ?? record.text;

  if (sourceKind === "reasonix") {
    role = readString(value.role);
    if (role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      const thinking = readString(value.reasoning_content);
      if (thinking) blocks.push({ type: "thinking", thinking });
      if (Array.isArray(value.tool_calls)) {
        for (const item of value.tool_calls) {
          const toolCall = asRecord(item);
          if (!toolCall) continue;
          blocks.push({
            type: "toolCall",
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          });
        }
      }
      const text = readString(value.content);
      if (text) blocks.push({ type: "text", text });
      content = blocks;
    } else {
      content = value.content;
    }
  } else if (sourceKind === "claude-code") {
    role = readString(value.type);
    content = nestedMessage?.content ?? value.content;
    if (role === "assistant" && Array.isArray(content)) {
      for (const item of content) {
        const block = asRecord(item);
        if (block?.type !== "tool_use") continue;
        const toolId = readString(block.id);
        const toolName = readString(block.name);
        if (toolId && toolName) claudeToolNames.set(toolId, toolName);
      }
    }
    if (role === "user" && Array.isArray(content)) {
      const shapes: MessageShape[] = [];
      for (const item of content) {
        const block = asRecord(item);
        if (block?.type !== "tool_result") {
          shapes.push({ role, content: [item] });
          continue;
        }
        const toolCallId = readString(block.tool_use_id) ?? readString(block.id);
        if (!toolCallId) {
          shapes.push({ role, content: [item] });
          continue;
        }
        shapes.push({
          role: "toolResult",
          content: block.content,
          toolCallId,
          toolName: claudeToolNames.get(toolCallId) ?? "unknown",
          isError: block.is_error === true,
        });
      }
      if (shapes.length > 0) return shapes;
    }
  } else if (sourceKind === "codex") {
    const eventType = readString(record.type);
    if (eventType === "user_message") role = "user";
    if (eventType === "agent_message" || eventType === "assistant_message") role = "assistant";
    if (eventType === "function_call") {
      role = "assistant";
      content = [
        {
          type: "function_call",
          id: record.call_id ?? record.id,
          name: record.name,
          arguments: record.arguments ?? record.input,
        },
      ];
    }
    if (eventType === "function_call_output" || eventType === "tool_result") {
      role = "toolResult";
      content = record.output ?? record.content ?? record.text;
    }
    content ??= record.message;
  }

  if (!role) return [];
  const toolCallId =
    readString(record.tool_call_id) ?? readString(record.call_id) ?? readString(record.id);
  const toolName = readString(record.name) ?? readString(record.tool_name);
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : undefined;
  return [
    {
      role,
      content,
      timestamp,
      provider: readString(record.provider),
      model: readString(record.model) ?? readString(record.modelId),
      toolCallId,
      toolName,
      isError: record.isError === true || record.is_error === true,
    },
  ];
}

function makeMessageEntry(
  shape: MessageShape,
  id: string,
  parentId: string | null,
  timestamp: string,
  sourceOrdinal: number,
  sourceRecord: Record<string, unknown>,
): CanonicalSessionEntry | undefined {
  const role = shape.role === "tool" || shape.role === "tool_result" ? "toolResult" : shape.role;
  const blocks = contentBlocks(shape.content, role);
  if (blocks.length === 0) return undefined;
  const message =
    role === "toolResult"
      ? {
          role: "toolResult",
          toolCallId: shape.toolCallId ?? `unknown-${id}`,
          toolName: shape.toolName ?? "unknown",
          content: blocks,
          isError: shape.isError ?? false,
        }
      : {
          role,
          content: blocks,
          timestamp: Date.parse(timestamp),
          ...(shape.provider ? { provider: shape.provider } : {}),
          ...(shape.model ? { model: shape.model } : {}),
        };
  const sourceRecordId =
    readString(sourceRecord.id) ??
    readString(sourceRecord.uuid) ??
    readString(sourceRecord.messageId);
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message,
    sourceOrdinal,
    ...(sourceRecordId ? { sourceRecordId } : {}),
  } as unknown as CanonicalSessionEntry;
}

function contentBlocks(content: unknown, role: string): Record<string, unknown>[] {
  if (typeof content === "string") return content.length ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return [];
    return [{ type: "text", text: JSON.stringify(content) }];
  }
  const output: Record<string, unknown>[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) output.push({ type: "text", text: item });
      continue;
    }
    const block = asRecord(item);
    if (!block) continue;
    const type = readString(block.type);
    if (
      type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      (!type && typeof block.text === "string")
    ) {
      const text = readString(block.text) ?? readString(block.content);
      if (text) output.push({ type: "text", text });
    } else if (type === "thinking" || type === "reasoning") {
      const thinking =
        readString(block.thinking) ?? readString(block.text) ?? readString(block.summary);
      if (thinking) output.push({ type: "thinking", thinking });
    } else if (type === "tool_use" || type === "toolCall" || type === "function_call") {
      output.push({
        type: "toolCall",
        id: readString(block.id) ?? readString(block.call_id) ?? `imported-call-${output.length}`,
        name: readString(block.name) ?? readString(block.tool_name) ?? "unknown",
        arguments: parseToolArguments(block.input ?? block.arguments),
      });
    } else if (role === "toolResult" && type === "tool_result") {
      const result = block.content;
      const resultText = typeof result === "string" ? result : JSON.stringify(result ?? "");
      output.push({ type: "text", text: resultText });
    }
  }
  return output;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  const object = asRecord(value);
  if (object) return object;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return asRecord(parsed) ?? { raw: value };
  } catch {
    return { raw: value };
  }
}

function entryId(reference: SessionSourceReference, ordinal: number, part = 0): string {
  const position = part === 0 ? String(ordinal) : `${ordinal}:${part}`;
  return `e-${sha256(`${reference.sourceKind}\0${reference.sourceId}\0${reference.sourceDigest ?? ""}\0${position}`).slice(0, 32)}`;
}
