/**
 * PI has no account system — models authenticate with each user's own API keys
 * stored by PiG (`<pig-agent>/auth.json`), so the client must never show ZCode's
 * login/welcome screen. This service reports a permanent local session.
 *
 * The UI's startup gate reads exactly two members: `restoreCachedSessionState`
 * (must say `authenticated`, or the sidebar renders a "sign in" footer and the
 * welcome screen gates the workspace) and `getActiveProvider` (must not throw;
 * `null` is fine — the caller only branches on it to refresh provider-family
 * state, which pi does not have). Everything else stays on the fallback layer:
 * the UI never calls it while the user is already signed in.
 */

import { Emitter, type Event } from "@zcode/rpc";
import type {
  OAuthCachedSessionRestoreResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthSessionState,
} from "@zcode/shared";
const LOCAL_USER = {
  id: "pi-local",
  username: "PI",
  displayName: "PI",
} as const;

export class PiOAuthService {
  // PI never has credential events; a live Emitter keeps subscribers honest
  // (they register and later dispose without error) at zero cost.
  private readonly sessionChange = new Emitter<OAuthSessionState>();
  readonly onDidChangeSession: Event<OAuthSessionState> = this.sessionChange.event;

  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [];
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return null;
  }

  async restoreCachedSession(): Promise<typeof LOCAL_USER | null> {
    return { ...LOCAL_USER };
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    return { status: "authenticated", userInfo: { ...LOCAL_USER } };
  }

  async restoreSession(): Promise<typeof LOCAL_USER | null> {
    return { ...LOCAL_USER };
  }
}
