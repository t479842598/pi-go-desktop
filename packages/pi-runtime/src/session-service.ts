/**
 * pi-backed `IZCodeSessionService`, limited to workspace preparation.
 *
 * `readWorkspacePresentation` is not optional decoration: the UI's workspace
 * prepare flow awaits it and **throws** on failure, which leaves the composer in
 * its "connecting" state forever and disables send. Serving it from pi is what
 * lets a draft session become writable.
 *
 * The response is small — the workspace ref, the session mode, and the slash
 * command list — so this returns pi's own answer rather than proxying ZCode's.
 */

import { ServiceChannels } from "@zcode/shared";
import type { Event } from "@zcode/rpc";
import { Emitter } from "@zcode/rpc";

export interface PiWorkspaceRefInput {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Minimal session service.
 *
 * Everything beyond workspace preparation rejects with a named fault: those
 * members back ZCode's own protocol sessions (message list, resume, close), and
 * silently answering them with empty shapes would make the UI render a session
 * it cannot actually operate.
 */
export class PiSessionService {
  private readonly onChange = new Emitter<unknown>();
  readonly onDidChange: Event<unknown> = this.onChange.event;

  /**
   * Answer the workspace prepare query.
   *
   * `mode` mirrors what the composer sends as its default (`build`), and the
   * slash command list is empty because pi exposes its commands through the
   * agent channel, not this one. An empty list is honest: the `/` menu simply
   * has no entries from this source.
   */
  async readWorkspacePresentation(params: PiWorkspaceRefInput): Promise<{
    workspace: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string };
    mode: string;
    slashCommands: unknown[];
  }> {
    return {
      workspace: {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
      mode: "build",
      slashCommands: [],
    };
  }

  dispose(): void {
    this.onChange.dispose();
  }
}

export const PI_SESSION_CHANNEL = ServiceChannels.ZCodeSession;
