/**
 * Session file discovery.
 *
 * PiG stores sessions under `~/.pi-web/pig-agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`.
 * The filename is only an index hint; the JSONL header's `id` is authoritative so
 * migrated `m-<sha256>` identities resolve exactly like native sessions.
 */

import { open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { getPiGSessionDir } from "@zcode/services/node";

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/i;

export interface SessionLocation {
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

/** Default root PiG writes sessions under. */
export function defaultSessionsDir(): string {
  return getPiGSessionDir();
}

/** Read-only legacy source used by the Pi migration adapter, never by runtime writes. */
export function legacyPiSessionsDir(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/**
 * Find the file for a session id.
 *
 * Returns `null` rather than throwing for an unknown or malformed id: callers
 * treat a miss as "no such session" and decide what to do next.
 */
export async function findSessionFile(
  sessionId: string,
  sessionsDir = defaultSessionsDir(),
): Promise<string | null> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;

  const root = resolve(sessionsDir);
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return null;
  }

  const suffix = `_${sessionId}.jsonl`;
  for (const projectDir of projectDirs) {
    const projectPath = join(root, projectDir);
    // Re-derive and re-check containment: a crafted directory name must not
    // walk out of the sessions root.
    const resolvedProjectPath = resolve(projectPath);
    if (resolvedProjectPath !== root && !resolvedProjectPath.startsWith(`${root}/`)) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionFile = join(projectPath, file);
      const header = await readSessionHeader(sessionFile);
      if (!header || header.id !== sessionId) continue;
      return sessionFile;
    }
  }

  return null;
}

/** Resolve a session id to its file plus the cwd recorded in the header. */
export async function locateSession(
  sessionId: string,
  sessionsDir = defaultSessionsDir(),
): Promise<SessionLocation | null> {
  const sessionFile = await findSessionFile(sessionId, sessionsDir);
  if (!sessionFile) return null;
  const header = await readSessionHeader(sessionFile);
  if (header === null) return null;
  return { sessionId, sessionFile, cwd: header.cwd };
}

/**
 * Read only as much of the header as needed.
 *
 * The first line is a `session` entry holding `cwd`; a corrupt or truncated
 * header means the file cannot be opened, so `null` is the honest answer.
 */
async function readSessionHeader(sessionFile: string): Promise<{ id: string; cwd: string } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(sessionFile, "r");
    // 64 KiB covers any realistic header; the line ends far earlier.
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as { type?: string; id?: string; cwd?: string };
    if (
      parsed.type !== "session" ||
      typeof parsed.id !== "string" ||
      typeof parsed.cwd !== "string"
    )
      return null;
    return { id: parsed.id, cwd: parsed.cwd };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
