/**
 * pi-backed `IProjectService`.
 *
 * ZCode's workspace picker and the composer's "can I send" gate both go through
 * this service. When it cannot answer, the UI falls back to its
 * `virtual-project-browse` folder dialog, which covers the composer and makes
 * sending impossible — so this is the service that unlocks the last link of the
 * end-to-end path.
 *
 * Projects are derived rather than stored: pi has no project database, but every
 * session records its `cwd`, so the set of directories that contain sessions is
 * exactly the set of projects worth showing. A directory's display name is its
 * basename, which is what the sidebar renders.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import { listPiSessions, type PiSessionSummary } from "./session-list.js";
import { defaultSessionsDir } from "./session-locator.js";

/** Mirrors ZCode's `ProjectRoot`. */
interface ProjectRoot {
  rootPath: string;
  position: number;
  isPrimary: boolean;
}

/** Mirrors ZCode's `VirtualProject`. */
interface VirtualProject {
  id: string;
  hostId: string;
  name: string;
  nameOverridden: boolean;
  roots: ProjectRoot[];
  position: number;
  pinned: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  primaryRootStatus?: "available" | "missing" | "unavailable";
}

/** Mirrors ZCode's `ProjectTask` (a `ZCodeTaskMeta` plus organisation fields). */
interface ProjectTask {
  taskId: string;
  traceId: string;
  title: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  mode: string;
  status?: string;
  projectId: string | null;
  hostId: string;
  pinned: boolean;
  archived: boolean;
  [key: string]: unknown;
}

interface ProjectTree {
  projects: VirtualProject[];
  tasks: ProjectTask[];
}

interface ProjectDirectories {
  workspacePath: string;
  additionalDirectories: string[];
  projectId: string | null;
}

const LOCAL_HOST_ID = "local";

/**
 * Derive a stable project id from a directory path.
 *
 * ZCode treats the id as opaque; it only has to be stable across restarts so a
 * selection survives a reload.
 */
function projectIdFor(workspacePath: string): string {
  return `pi-dir:${workspacePath}`;
}

/**
 * The workspace ZCode last used, from its own settings file.
 *
 * This is the user's actual choice rather than a guess: `lastActiveWorkspace`
 * is written by the app whenever a project is opened. Reading it keeps the pi
 * host agreeing with what the sidebar shows, and avoids a derived default
 * flipping the draft mid-send.
 */
async function readLastActiveWorkspace(): Promise<string | null> {
  try {
    const settingsPath = join(homedir(), ".zcode", "v2", "setting.json");
    const raw = await readFile(settingsPath, "utf8");
    const settings = JSON.parse(raw) as {
      lastActiveWorkspace?: { workspacePath?: unknown; kind?: unknown };
    };
    const workspace = settings.lastActiveWorkspace;
    if (workspace?.kind !== "local") return null;
    const path = workspace.workspacePath;
    return typeof path === "string" && path.trim() ? path : null;
  } catch {
    return null;
  }
}

export class PiProjectService {
  private cache: { at: number; sessions: PiSessionSummary[] } | null = null;
  /** Session listing is a directory walk; a short cache keeps the UI's polling cheap. */
  private readonly cacheMs = 3000;

  constructor(private readonly sessionsDir = defaultSessionsDir()) {}

  /**
   * Directories offered in the picker.
   *
   * Only directories that actually contain sessions are listed: an empty
   * project would let the user select a workspace with no conversation in it,
   * which is the state that brings back the folder dialog.
   */
  async readProjects(_params?: { includeDeleted?: boolean; hostId?: string }): Promise<VirtualProject[]> {
    const sessions = await this.sessions();
    const byCwd = new Map<string, { createdAt: number; updatedAt: number; count: number }>();

    for (const session of sessions) {
      const entry = byCwd.get(session.cwd);
      if (!entry) {
        byCwd.set(session.cwd, {
          createdAt: session.createdAt,
          updatedAt: session.modifiedAt,
          count: 1,
        });
        continue;
      }
      entry.count += 1;
      entry.createdAt = Math.min(entry.createdAt, session.createdAt);
      entry.updatedAt = Math.max(entry.updatedAt, session.modifiedAt);
    }

    return [...byCwd.entries()]
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .map(([cwd, stats], index) => ({
        id: projectIdFor(cwd),
        hostId: LOCAL_HOST_ID,
        name: basename(cwd) || cwd,
        nameOverridden: false,
        roots: [{ rootPath: cwd, position: 0, isPrimary: true }],
        position: index,
        pinned: false,
        deleted: false,
        createdAt: Math.floor(stats.createdAt),
        updatedAt: Math.floor(stats.updatedAt),
        primaryRootStatus: "available" as const,
      }));
  }

  /** Projects plus their sessions — what the sidebar renders. */
  async readTree(params?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    hostId?: string;
  }): Promise<ProjectTree> {
    const [projects, sessions] = await Promise.all([this.readProjects(params), this.sessions()]);

    const tasks: ProjectTask[] = sessions.map((session) => ({
      taskId: session.sessionId,
      traceId: session.sessionId,
      title: session.title,
      workspacePath: session.cwd,
      createdAt: Math.floor(session.createdAt),
      updatedAt: Math.floor(session.modifiedAt),
      mode: "build",
      projectId: projectIdFor(session.cwd),
      hostId: LOCAL_HOST_ID,
      pinned: false,
      archived: false,
    }));

    return { projects, tasks };
  }

  /**
   * Directories for a new session.
   *
   * Without a `projectId` the caller has not picked a workspace yet. Returning
   * "whichever directory has the newest session" looks reasonable but is wrong:
   * a single scratch session in /tmp flips the default and makes the UI rebind
   * its draft mid-send, which silently swallows the message. The last workspace
   * the user actually worked in is the honest answer, so that is read from
   * ZCode's own settings and preferred over any derived guess.
   */
  async prepareSession(params?: {
    projectId?: string;
    hostId?: string;
    draftId?: string;
    reuseDraft?: boolean;
  }): Promise<ProjectDirectories> {
    if (params?.projectId) {
      const projects = await this.readProjects();
      const selected = projects.find((project) => project.id === params.projectId);
      if (selected) {
        return {
          workspacePath: selected.roots[0]!.rootPath,
          additionalDirectories: [],
          projectId: selected.id,
        };
      }
      throw new Error(`Unknown project: ${params.projectId}`);
    }

    const lastActive = await readLastActiveWorkspace();
    if (lastActive) {
      return {
        workspacePath: lastActive,
        additionalDirectories: [],
        projectId: projectIdFor(lastActive),
      };
    }

    const projects = await this.readProjects();
    const fallback = projects[0];
    if (!fallback) {
      // A machine with no pi sessions and no saved workspace has nothing to
      // infer. Answering with a made-up path would create sessions in a
      // location the user never chose.
      throw new Error("project.no-workspace");
    }
    return {
      workspacePath: fallback.roots[0]!.rootPath,
      additionalDirectories: [],
      projectId: fallback.id,
    };
  }

  async resolveSessionDirectories(
    task: { workspacePath: string; taskId: string },
  ): Promise<ProjectDirectories> {
    return {
      workspacePath: task.workspacePath,
      additionalDirectories: [],
      projectId: projectIdFor(task.workspacePath),
    };
  }

  /**
   * Directory listing for the picker's browse view.
   *
   * Restricted to one level and to directories only: this is a workspace chooser,
   * not a file browser, and the caller cannot read file contents through it.
   */
  async readDirectory(params?: {
    hostId?: string;
    path?: string;
    includeHidden?: boolean;
  }): Promise<{ path: string; entries: Array<{ name: string; path: string; isDirectory: boolean }> }> {
    const target = params?.path ?? process.env["HOME"] ?? "/";
    let names: string[];
    try {
      const dirents = await readdir(target, { withFileTypes: true });
      names = dirents
        .filter((dirent) => dirent.isDirectory())
        .filter((dirent) => params?.includeHidden || !dirent.name.startsWith("."))
        .map((dirent) => dirent.name)
        .sort();
    } catch {
      names = [];
    }
    return {
      path: target,
      entries: names.map((name) => ({
        name,
        path: join(target, name),
        isDirectory: true,
      })),
    };
  }

  /** Project creation is a name + roots operation; rerooting is not supported. */
  async saveProject(input: {
    id?: string;
    hostId?: string;
    name?: string;
    defaultName?: string;
    roots?: string[];
    primaryRoot?: string;
    pinned?: boolean;
    restoreProjectId?: string;
  }): Promise<VirtualProject> {
    const root = input.roots?.[0] ?? input.primaryRoot;
    if (!root) throw new Error("project.root-required");
    return {
      id: projectIdFor(root),
      hostId: LOCAL_HOST_ID,
      name: input.name ?? input.defaultName ?? basename(root) ?? root,
      nameOverridden: Boolean(input.name),
      roots: [{ rootPath: root, position: 0, isPrimary: true }],
      position: 0,
      pinned: input.pinned ?? false,
      deleted: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      primaryRootStatus: "available",
    };
  }

  // Organisation operations have no pi equivalent: projects are derived from
  // session directories, so there is nothing to delete, move, or reorder.
  async deleteProject(_id: string, _hostId?: string): Promise<void> {}
  async reorderProjects(_ids: string[], _hostId?: string): Promise<void> {}
  async moveTask(_input: unknown): Promise<void> {}

  private async sessions(): Promise<PiSessionSummary[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache.sessions;
    const sessions = await listPiSessions(this.sessionsDir);
    this.cache = { at: now, sessions };
    return sessions;
  }
}
