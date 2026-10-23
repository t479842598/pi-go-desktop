/**
 * `IZCodeAgentService` over pi.
 *
 * ZCode's UI talks to this channel for every conversation concern. The real
 * implementation proxies 27 v4 methods to a CLI subprocess; here the same
 * surface is served by {@link PiSessionHost} and the v4 projection.
 *
 * Only the methods the UI calls on the conversation path are live. The
 * workflow/journal family has no pi equivalent and answers with empty results —
 * those are read-only, stateless queries, so an empty answer is a legal answer
 * rather than a lie the UI can act on.
 *
 * Every return value is typed against the real wire schema rather than cast, so
 * `tsc` catches drift here instead of the UI silently dropping a bad ACK.
 */

import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import type { Event } from "@zcode/rpc";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import type {
  ClientHello,
  CommandAck,
  CommandsQueryResult,
  HelloMessage,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";

import { PiSessionHost, type PiSessionHandle } from "../session-host.js";
import { locateSession } from "../session-locator.js";
import { ConversationProjection } from "./conversation-projection.js";

export interface PiAgentServiceOptions {
  host?: PiSessionHost;
  /** Session directory override; pi's default applies when omitted. */
  sessionDir?: string;
}

interface Subscription {
  projection: ConversationProjection;
  sessionId: string;
  logEpoch: string;
}

/**
 * Live conversation surface over pi.
 *
 * Deliberately a standalone class rather than `implements IZCodeAgentService`:
 * that interface carries ~150 members across plugins, CUA, workflows and
 * automation, and claiming to implement them all would be a lie. RPC dispatch
 * is by member name, so unimplemented members are simply not callable.
 */
export class PiAgentService {
  private readonly host: PiSessionHost;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly frameEmitter = new Emitter<unknown>();
  private readonly ttftEmitter = new Emitter<unknown>();
  private readonly connectionId = randomUUID();
  /** Revision the service reports in command ACKs; monotonic per connection. */
  private revision = 0;

  constructor(options: PiAgentServiceOptions = {}) {
    this.host = options.host ?? new PiSessionHost({ sessionDir: options.sessionDir });
  }

  // ── handshake ────────────────────────────────────────────────────────────

  async helloConversationV4(): Promise<HelloMessage> {
    return {
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: this.connectionId,
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
      serverTime: Math.floor(Date.now() / 1000),
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: true,
        compression: "none",
        workspaceHookReview: false,
        independentPlanState: false,
        workflowRunDeltas: false,
        historyFirst: false,
      },
      auth: {},
    };
  }

  /** pi has nothing to negotiate; the client hello is accepted as-is. */
  async initializeConversationV4(_clientHello: ClientHello): Promise<void> {}

  // ── conversation subscription ────────────────────────────────────────────

  async subscribeConversationV4(params: {
    sessionId: string;
    base?: { logEpoch: string; seq: number };
    visibility?: "foreground" | "background";
  }): Promise<V4ConversationSubscribeResult> {
    const subscriptionId = randomUUID();
    const handle = await this.ensureSession(params.sessionId);

    const projection = new ConversationProjection(handle, {
      subscriptionId,
      emit: (frame) => this.frameEmitter.fire(frame),
    });

    this.subscriptions.set(subscriptionId, {
      projection,
      sessionId: handle.sessionId,
      logEpoch: handle.sessionId,
    });
    projection.start();

    return {
      ack: { subscriptionId, mode: "snapshot", logEpoch: handle.sessionId },
    };
  }

  async resyncConversationV4(params: {
    subscriptionId: string;
  }): Promise<V4ConversationResyncResult> {
    const subscription = this.subscriptions.get(params.subscriptionId);
    if (!subscription) {
      // An unknown subscription cannot be resumed; the client treats a missing
      // ack as "resubscribe" rather than retrying forever.
      throw new Error(`Unknown subscription: ${params.subscriptionId}`);
    }
    subscription.projection.resync();
    return {
      ack: {
        subscriptionId: params.subscriptionId,
        mode: "snapshot",
        logEpoch: subscription.logEpoch,
      },
    };
  }

  async unsubscribeConversationV4(params: { subscriptionId: string }): Promise<void> {
    const subscription = this.subscriptions.get(params.subscriptionId);
    if (!subscription) return;
    subscription.projection.stop();
    this.subscriptions.delete(params.subscriptionId);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async sendConversationCommandV4(params: {
    sessionId: string;
    envelope?: { commandId: string; payload?: { type: string; [key: string]: unknown } };
  }): Promise<CommandAck> {
    const commandId = params.envelope?.commandId ?? randomUUID();
    const payload = params.envelope?.payload;
    if (!payload) return this.reject(commandId, "emptyCommand");

    // createSession runs before a session exists, so it must not go through
    // ensureSession — the id on the envelope names a session that isn't there.
    if (payload.type === "createSession") {
      const cwd = typeof payload.workspaceId === "string" ? payload.workspaceId : process.cwd();
      const created = await this.host.open({ cwd });
      return { ...this.accept(commandId), message: created.sessionId };
    }

    const handle = await this.ensureSession(params.sessionId);

    switch (payload.type) {
      case "sendText": {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text) return this.reject(commandId, "emptyText");
        // pi queues the prompt itself while a turn is running, which is exactly
        // the `startNow`/`enqueue` split the snapshot's inputRouting reports.
        void handle.session.prompt(text);
        return this.accept(commandId);
      }

      case "stop": {
        await handle.session.abort();
        return this.accept(commandId);
      }

      default:
        return this.reject(commandId, `unsupported:${payload.type}`);
    }
  }

  async queryConversationCommandsV4(_params: unknown): Promise<CommandsQueryResult> {
    // pi applies a prompt immediately instead of journaling commands, so there
    // is never a pending command to reconcile after a reconnect.
    return { results: [] };
  }

  // ── read-only projections with no pi equivalent ──────────────────────────
  // These are legal empty answers: stateless, side-effect free queries the UI
  // renders as "nothing here" rather than acting on.

  async conversationRowsRangeV4(params: { sessionId: string; beforeRowId?: number; limit: number }) {
    const subscription = this.findSubscriptionBySession(params.sessionId);
    const rows = subscription ? subscription.projection.rowsSnapshot() : [];
    const before = params.beforeRowId ?? Number.POSITIVE_INFINITY;
    const older = rows.filter((row) => row.rowId < before).slice(-Math.max(1, params.limit));
    return {
      rows: older,
      hasMore: false,
      atSeq: subscription?.projection.currentSeq ?? 0,
      atRevision: this.revision,
      atLogEpoch: subscription?.logEpoch ?? params.sessionId,
    };
  }

  async conversationPlansV4(_params: unknown) {
    return { plans: [] };
  }

  async conversationWorkflowRunEventsV4(_params: unknown) {
    return { events: [] };
  }

  async conversationWorkflowRunsV4(_params: unknown) {
    return { runs: [] };
  }

  async conversationWorkflowRunArtifactsV4(_params: unknown) {
    return { artifacts: [] };
  }

  async conversationWorkflowRunArtifactDataV4(_params: unknown) {
    return { items: [] };
  }

  async conversationWorkflowRunArtifactReadV4(_params: unknown) {
    return { bytes: new Uint8Array(), mediaType: "application/octet-stream" };
  }

  async conversationWorkflowRunWorkspaceV4(_params: unknown) {
    return { entries: [] };
  }

  async conversationWorkflowRunNodeResultV4(_params: unknown) {
    return { text: "" };
  }

  async conversationFileChangesV4(_params: unknown) {
    return { files: [] };
  }

  async conversationFileRewindPreviewV4(_params: unknown) {
    return { files: [] };
  }

  // ── events ───────────────────────────────────────────────────────────────

  /** Workspace-level frame fan-out; the client routes by the frame's topic. */
  onDynamicConversationFrame(_params: unknown): Event<unknown> {
    return this.frameEmitter.event;
  }

  onDynamicLocalTtftFacts(_params: unknown): Event<unknown> {
    return this.ttftEmitter.event;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    for (const subscription of this.subscriptions.values()) subscription.projection.stop();
    this.subscriptions.clear();
    this.host.closeAll();
    this.frameEmitter.dispose();
    this.ttftEmitter.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private accept(commandId: string): CommandAck {
    return { commandId, status: "accepted", revisionAtDecision: ++this.revision };
  }

  private reject(commandId: string, reasonCode: string): CommandAck {
    return {
      commandId,
      status: "rejected",
      reasonCode,
      revisionAtDecision: ++this.revision,
    };
  }

  private findSubscriptionBySession(sessionId: string): Subscription | undefined {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.sessionId === sessionId) return subscription;
    }
    return undefined;
  }

  /**
   * Resolve a session id to a live handle, opening it when needed.
   *
   * ZCode passes back whatever id it was handed, which is pi's session UUID.
   * The file header supplies the cwd, so a session opened from the sidebar
   * resumes in its own project instead of the host's working directory.
   */
  private async ensureSession(sessionId: string): Promise<PiSessionHandle> {
    const live = this.host.get(sessionId);
    if (live) return live;

    const location = await locateSession(sessionId);
    if (!location) throw new Error(`Unknown session: ${sessionId}`);
    return this.host.open({ cwd: location.cwd, sessionFile: location.sessionFile });
  }
}
