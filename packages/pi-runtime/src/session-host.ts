/**
 * pi session runtime — the pi side of pi-zcode.
 *
 * One {@link PiSessionHost} owns a registry of live pi AgentSessions keyed by
 * session id, mirroring what pi-web's `AgentSessionWrapper` does but without
 * any HTTP/SSE surface. Callers subscribe to raw pi events and drive sessions
 * through typed commands; the v4 projection layer (see ./v4) turns those into
 * ZCode conversation rows.
 *
 * Deliberately mirrors pi-web's lifecycle traps:
 *  - `fork()` mutates the session in place, so the host must drop the old
 *    entry immediately after a fork or the next request sees the forked state.
 *  - pi's queue lives in memory only; a host restart loses it.
 */

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

export type PiEvent = { type: string; [key: string]: unknown };
export type PiEventListener = (event: PiEvent) => void;

export interface PiSessionHandle {
  readonly sessionId: string;
  readonly cwd: string;
  /** The live SDK session. Prefer {@link PiSessionHost} commands over this. */
  readonly session: AgentSession;
  /**
   * The manager behind the session.
   *
   * Needed for operations that rewrite history rather than talk to the model —
   * `createBranchedSession` for forking, and the entry lookups a branch switch
   * uses. `AgentSession` exposes none of that.
   */
  readonly sessionManager: SessionManager;
  subscribe(listener: PiEventListener): () => void;
  /** Drop this session from the host. Safe to call twice. */
  dispose(): void;
}

export interface PiHostOptions {
  /**
   * Supply an already-created services bundle. Services are cwd-bound, so a
   * host that spans several projects keeps a per-cwd cache instead of passing
   * one bundle for everything.
   */
  servicesFor?: (cwd: string) => Promise<AgentSessionServices>;
  /** Default session directory; pi's own default applies when omitted. */
  sessionDir?: string;
}

interface HostEntry {
  handle: PiSessionHandle;
  cwd: string;
  listeners: Set<PiEventListener>;
  unsubscribe: () => void;
  lastActivityAt: number;
}

/**
 * Owns live pi sessions for one process.
 *
 * The registry is deliberately instance-scoped rather than a module singleton
 * so tests and the desktop/web hosts cannot share state by accident.
 */
export class PiSessionHost {
  private readonly entries = new Map<string, HostEntry>();
  private readonly services = new Map<string, Promise<AgentSessionServices>>();
  private readonly options: PiHostOptions;

  constructor(options: PiHostOptions = {}) {
    this.options = options;
  }

  /** Open an existing session file, or create a new one when `sessionFile` is absent. */
  async open(input: { cwd: string; sessionFile?: string }): Promise<PiSessionHandle> {
    const { cwd, sessionFile } = input;
    if (sessionFile && !existsSync(sessionFile)) {
      throw new Error(`Session file not found: ${sessionFile}`);
    }

    const services = await this.servicesFor(cwd);
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, this.options.sessionDir)
      : SessionManager.create(cwd, this.options.sessionDir);

    const { session } = await createAgentSessionFromServices({ services, sessionManager });
    return this.adopt(session, cwd, sessionManager);
  }

  /** Look up a live handle without creating one. */
  get(sessionId: string): PiSessionHandle | undefined {
    return this.entries.get(sessionId)?.handle;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Resolve the cwd a live session was opened with. */
  cwdOf(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.cwd;
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  /** Drop a live session. Safe to call twice. */
  close(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    entry.unsubscribe();
    entry.listeners.clear();
    try {
      entry.handle.session.dispose();
    } catch (error) {
      console.error(`[pi-runtime] dispose failed for ${sessionId}`, error);
    }
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  private adopt(session: AgentSession, cwd: string, sessionManager: SessionManager): PiSessionHandle {
    const sessionId = session.sessionId;

    // A stale entry for the same id means the caller reopened from disk while
    // an old wrapper was still registered; drop the old one first so
    // subscribers cannot attach to a session that is about to be disposed.
    if (this.entries.has(sessionId)) this.close(sessionId);

    const listeners = new Set<PiEventListener>();
    const entry: HostEntry = {
      handle: undefined as unknown as PiSessionHandle,
      cwd,
      listeners,
      unsubscribe: () => {},
      lastActivityAt: Date.now(),
    };

    entry.unsubscribe = session.subscribe((event) => {
      entry.lastActivityAt = Date.now();
      for (const listener of [...listeners]) {
        try {
          listener(event as PiEvent);
        } catch (error) {
          // A broken subscriber must not tear down the agent loop.
          console.error("[pi-runtime] event listener threw", error);
        }
      }
    });

    const host = this;
    const handle: PiSessionHandle = {
      sessionId,
      cwd,
      session,
      sessionManager,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      dispose() {
        host.close(sessionId);
      },
    };

    entry.handle = handle;
    this.entries.set(sessionId, entry);
    return handle;
  }

  private servicesFor(cwd: string): Promise<AgentSessionServices> {
    if (this.options.servicesFor) return this.options.servicesFor(cwd);
    let pending = this.services.get(cwd);
    if (!pending) {
      pending = createAgentSessionServices({ cwd });
      this.services.set(cwd, pending);
    }
    return pending;
  }
}
