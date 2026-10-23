/**
 * Session file discovery.
 *
 * pi stores sessions under `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
 * The id a caller holds is the UUID in the filename, so resolving "open session
 * X" means finding that suffix. The filename is only a hint — the header inside
 * the file is authoritative — but scanning names first keeps this cheap enough
 * to sit on the subscribe path.
 */

import { open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionLocation {
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

/** Default root pi writes sessions under. */
export function defaultSessionsDir(): string {
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
    if (!resolve(projectPath).startsWith(root)) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    const match = files.find((file) => file.endsWith(suffix));
    if (!match) continue;

    const sessionFile = join(projectPath, match);
    const cwd = await readSessionCwd(sessionFile);
    if (cwd === null) continue;
    return sessionFile;
  }

  return null;
}

/** Resolve a session id to its file plus the cwd recorded in the header. */
export async function locateSession(sessionId: string): Promise<SessionLocation | null> {
  const sessionFile = await findSessionFile(sessionId);
  if (!sessionFile) return null;
  const cwd = await readSessionCwd(sessionFile);
  if (cwd === null) return null;
  return { sessionId, sessionFile, cwd };
}

/**
 * Read only as much of the header as needed.
 *
 * The first line is a `session` entry holding `cwd`; a corrupt or truncated
 * header means the file cannot be opened, so `null` is the honest answer.
 */
async function readSessionCwd(sessionFile: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(sessionFile, "r");
    // 64 KiB covers any realistic header; the line ends far earlier.
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as { type?: string; cwd?: string };
    if (parsed.type !== "session" || typeof parsed.cwd !== "string") return null;
    return parsed.cwd;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
