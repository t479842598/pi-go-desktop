/**
 * pi session listing.
 *
 * Scans `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` and returns a summary per
 * file. Mirrors what pi-web's `session-list-scanner` does, trimmed to the fields
 * ZCode's sidebar actually renders.
 *
 * Only the head and tail of each file are read: the header carries `cwd`, and a
 * bounded tail holds enough of the last message to build a preview. A 100 MB
 * transcript must not be loaded to show one row.
 */

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { defaultSessionsDir } from "./session-locator.js";

export interface PiSessionSummary {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  createdAt: number;
  modifiedAt: number;
  /** First user message, truncated — ZCode uses it as the default title. */
  title: string;
  /** Last assistant text, truncated — shown as the row's secondary line. */
  lastAssistantPreview?: string;
  messageCount: number;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 128 * 1024;
const TITLE_LIMIT = 120;

/**
 * List every session on disk.
 *
 * Sorted newest-first by mtime, matching what a sidebar wants and what pi's own
 * `listAll()` does.
 */
export async function listPiSessions(sessionsDir = defaultSessionsDir()): Promise<PiSessionSummary[]> {
  const projectDirs = await safeReaddir(sessionsDir);
  const summaries: PiSessionSummary[] = [];

  for (const projectDir of projectDirs) {
    const projectPath = join(sessionsDir, projectDir);
    const files = await safeReaddir(projectPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const summary = await summarizeSession(join(projectPath, file));
      if (summary) summaries.push(summary);
    }
  }

  return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Read one session file's head and tail.
 *
 * A file whose header cannot be parsed is skipped rather than reported with
 * guessed values: a half-written transcript is not a session the UI can open.
 */
async function summarizeSession(sessionFile: string): Promise<PiSessionSummary | null> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(sessionFile);
  } catch {
    return null;
  }

  const handle = await open(sessionFile, "r").catch(() => null);
  if (!handle) return null;

  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, fileStat.size));
    await handle.read(head, 0, head.length, 0);
    const headerLine = head.toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(headerLine) as { type?: string; id?: string; cwd?: string; timestamp?: string };
    if (header.type !== "session" || !header.id || !header.cwd) return null;

    const tailStart = Math.max(0, fileStat.size - TAIL_BYTES);
    const tail = Buffer.alloc(fileStat.size - tailStart);
    await handle.read(tail, 0, tail.length, tailStart);

    const lines = tail
      .toString("utf8")
      .split("\n")
      // A bounding read can start mid-line; only the first fragment is suspect.
      .slice(tailStart === 0 ? 0 : 1)
      .filter(Boolean);

    let title = "";
    let lastAssistantPreview: string | undefined;
    let messageCount = 0;

    for (const line of lines) {
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "message" || !entry.message) continue;
      messageCount += 1;
      const text = messageText(entry.message.content);
      if (!text) continue;
      if (entry.message.role === "user" && !title) title = truncate(text, TITLE_LIMIT);
      if (entry.message.role === "assistant") lastAssistantPreview = truncate(text, TITLE_LIMIT);
    }

    const createdAt = header.timestamp ? Date.parse(header.timestamp) : fileStat.birthtimeMs;
    return {
      sessionId: header.id,
      sessionFile,
      cwd: header.cwd,
      createdAt: Number.isFinite(createdAt) ? createdAt : fileStat.birthtimeMs,
      modifiedAt: fileStat.mtimeMs,
      title: title || "(untitled)",
      ...(lastAssistantPreview ? { lastAssistantPreview } : {}),
      messageCount,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Flatten a pi message `content` (string or block array) to plain text. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
