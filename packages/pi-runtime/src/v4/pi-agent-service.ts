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
import {
  V4_WIRE_PROTOCOL_VERSION,
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ClientHello,
  CommandAck,
  CommandsQueryResult,
  HelloMessage,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";

import { PiSessionHost, type PiSessionHandle } from "../session-host.js";
import { locateSession } from "../session-locator.js";
import { listPiSessions } from "../session-list.js";
import { ConversationProjection } from "./conversation-projection.js";
import { toWireFrame, type ConversationWireFrame } from "./frames.js";

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
  /** sessions-index subscription id → workspace id (the topic's second half). */
  private readonly indexSubscriptions = new Map<string, string>();
  private readonly frameEmitter = new Emitter<unknown>();
  private readonly ttftEmitter = new Emitter<unknown>();
  private readonly connectionId = randomUUID();
  /** Revision the service reports in command ACKs; monotonic per connection. */
  private revision = 0;
  /** Delivery kinds already dumped to the log, to keep the trace readable. */
  private readonly dumpedKinds = new Set<string>();
  /** Mirrors the UI's wire assembler; used only to name a rejection locally. */
  private assemblerProbe: TopicWireFrameAssembler<unknown> | null = null;

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

    // Only one projection may stream a session. The UI opens a draft prewarm
    // subscription and then a real one for the same session; leaving both alive
    // put two frames with the same topic and ordinal-1 snapshot on the wire, and
    // the assembler rejects the second.
    for (const [existingId, existing] of this.subscriptions) {
      if (existing.sessionId !== handle.sessionId) continue;
      existing.projection.stop();
      this.subscriptions.delete(existingId);
    }

    const projection = new ConversationProjection(handle, {
      subscriptionId,
      emit: this.emitFrame,
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
      throw new Error(`Unknown subscription: ${params.subscriptionId}`);
    }
    // Answer with the same subscription id and let the projection continue its
    // own sequence. `resume` tells the UI to expect deltas from where it stopped
    // rather than a fresh snapshot: a snapshot mid-stream is rejected by the
    // assembler (either a metadata mismatch or an ordinal conflict), and every
    // later frame is then dropped, leaving the transcript empty.
    subscription.projection.resync();
    return {
      ack: {
        subscriptionId: params.subscriptionId,
        mode: "resume",
        logEpoch: subscription.logEpoch,
      },
    };
  }

  /** Frame fan-out shared by the initial subscription and every resync. */
  private emitFrame = (wire: ConversationWireFrame): void => {
    const frame = wire.frame;
    const size =
      frame.payload.kind === "snapshot"
        ? (frame.payload.snapshot as { rows?: { window?: unknown[] } }).rows?.window?.length ?? 0
        : frame.payload.deltas.length;
    console.log(
      `[pi-engine] frame ${frame.payload.kind} ${wire.deliveryKind} ` +
        `seq=${frame.fromSeq}->${frame.toSeq} units=${size}`,
    );
    // The assembler rejects frame 5 every run, so the exact envelope matters more
    // than a summary: dump the first frame of each (deliveryKind, payload kind).
    const dumpKey = `${wire.deliveryKind}:${frame.payload.kind}`;
    if (!this.dumpedKinds.has(dumpKey)) {
      this.dumpedKinds.add(dumpKey);
      console.log(
        `[pi-engine]   wire keys=${Object.keys(wire).join(",")} ` +
          `ordinal=${wire.logicalFrameOrdinal} ver=${wire.wireVersion} ` +
          `ops=${frame.payload.kind === "deltas" ? frame.payload.deltas.map((delta) => delta.op).join("+") : "n/a"}`,
      );
    }
    // Validate every frame with the same assembler the UI runs. A local rejection
    // here names the exact rule instead of inferring it from UI warnings.
    if (!this.assemblerProbe) {
      this.assemblerProbe = new TopicWireFrameAssembler<unknown>(conversationTopicFrameSchema, {
        maxAssemblyBytes: 32 * 1024 * 1024,
        timeoutMs: 30_000,
        maxPhysicalFrameBytes: 1024 * 1024,
      });
    }
    const outcome = this.assemblerProbe.accept(wire as never);
    for (const event of outcome) {
      if (event.kind === "fault") {
        console.log(
          `[pi-engine]   LOCAL REJECT ordinal=${wire.logicalFrameOrdinal} ` +
            `reason=${event.fault.reasonCode} detail=${JSON.stringify(event.fault).slice(0, 300)}`,
        );
      }
    }
    // The UI renders nothing unless the rows actually reach it, so keep the row
    // kinds visible: an all-header window explains an empty transcript.
    if (frame.payload.kind === "snapshot" && size > 0) {
      const rows = (
        frame.payload.snapshot as { rows: { window: Array<{ kind: string; text?: string }> } }
      ).rows.window;
      console.log(
        `[pi-engine]   rows: ${rows.map((row) => `${row.kind}(${(row.text ?? "").slice(0, 18)})`).join(", ")}`,
      );
    }
    this.frameEmitter.fire(wire);
  };

  async unsubscribeConversationV4(params: { subscriptionId: string }): Promise<void> {
    const subscription = this.subscriptions.get(params.subscriptionId);
    if (!subscription) return;
    subscription.projection.stop();
    this.subscriptions.delete(params.subscriptionId);
  }

  // ── sessions index ───────────────────────────────────────────────────────

  /**
   * The workspace session list.
   *
   * ZCode's sidebar reads rows from this topic rather than from the conversation
   * channel. The response is ACK-only; the actual list arrives as a snapshot
   * frame on the same workspace-level event stream as conversation frames,
   * distinguished by its `sessions-index/<workspaceId>` topic.
   */
  async subscribeSessionsIndexV4(params: {
    workspacePath: string;
    base?: { logEpoch: string; seq: number };
  }): Promise<V4SessionsIndexSubscribeResult> {
    const subscriptionId = randomUUID();
    const workspaceId = params.workspacePath;
    this.indexSubscriptions.set(subscriptionId, workspaceId);

    const ack = { subscriptionId, mode: "snapshot" as const, logEpoch: workspaceId };
    // Emit after the ACK so the client has a subscription id to match against.
    // The caller's RPC response and this notification are ordered by the host's
    // outbox, which is the same contract the ZCode CLI relies on.
    void this.emitSessionsIndex(workspaceId, subscriptionId);
    return { ack };
  }

  async resyncSessionsIndexV4(params: { subscriptionId: string }): Promise<V4SessionsIndexSubscribeResult> {
    const workspaceId = this.indexSubscriptions.get(params.subscriptionId);
    if (!workspaceId) throw new Error(`Unknown subscription: ${params.subscriptionId}`);
    void this.emitSessionsIndex(workspaceId, params.subscriptionId);
    return {
      ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch: workspaceId },
    };
  }

  async unsubscribeSessionsIndexV4(params: { subscriptionId: string }): Promise<void> {
    this.indexSubscriptions.delete(params.subscriptionId);
  }

  private async emitSessionsIndex(workspaceId: string, subscriptionId: string): Promise<void> {
    const sessions = await listPiSessions();
    const summaries = sessions.map((session) => ({
      sessionId: session.sessionId,
      workspaceId,
      title: session.title,
      titleSource: "default" as const,
      phase: "completedSuccess" as const,
      sessionEnded: true,
      hasBackgroundWork: false,
      // Milliseconds: the sidebar renders this as a relative time, and seconds
      // came out as "20728 days".
      lastActivityAt: Math.floor(session.modifiedAt),
      createdAt: Math.floor(session.createdAt),
      ...(session.lastAssistantPreview
        ? { lastAssistantPreview: session.lastAssistantPreview }
        : {}),
    }));
    this.frameEmitter.fire(
      toWireFrame(
        {
          topic: `sessions-index/${workspaceId}`,
          subscriptionId,
          fromSeq: 0,
          toSeq: 1,
          sentAt: Date.now(),
          payload: {
            kind: "snapshot",
            snapshot: { protocolVersion: 1, workspaceId, logEpoch: workspaceId, sessions: summaries },
          },
        },
        1,
        "initial",
      ),
    );
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async sendConversationCommandV4(params: {
    sessionId?: string;
    envelope?: {
      commandId: string;
      /** The command name lives on the envelope itself, not inside `payload`. */
      type?: string;
      /** The session the command targets; null only for `createSession`. */
      sessionId?: string | null;
      payload?: { type?: string; [key: string]: unknown };
    };
  }): Promise<CommandAck> {
    const commandId = params.envelope?.commandId ?? randomUUID();
    const envelope = params.envelope;
    // The command name is `envelope.type`; `payload` carries only its arguments.
    const commandType = envelope?.type ?? envelope?.payload?.type;
    const payload = (envelope?.payload ?? {}) as { type?: string; [key: string]: unknown };
    // The UI carries the target inside the envelope; the outer field is absent
    // for every command it sends, so reading only that made every command look
    // session-less and drop its delete/queue bookkeeping.
    const sessionId = envelope?.sessionId ?? params.sessionId ?? null;
    if (!commandType) return this.reject(commandId, "emptyCommand");
    console.log(`[pi-engine] cmd=${commandType} session=${sessionId ?? "(none)"}`);

    // createSession runs before a session exists, so it must not go through
    // ensureSession — the id on the envelope names a session that isn't there.
    if (commandType === "createSession") {
      const cwd = typeof payload.workspaceId === "string" ? payload.workspaceId : process.cwd();
      const created = await this.host.open({ cwd });
      // The ACK's `result` is what the UI reads the new id from; `message` would
      // be ignored, and the UI would retry the create forever.
      return {
        ...this.accept(commandId),
        result: {
          type: "createSession" as const,
          sessionId: created.sessionId,
          input: {
            delivery: "startNow" as const,
            inputId: `${created.sessionId}-create`,
          },
        },
      };
    }

    // A session-less envelope still arrives for the first message of a draft:
    // the UI sends `sendText` and expects the backend to have created the
    // session. Treat a missing id as "open a new one in the cwd it names".
    if (!sessionId) {
      if (commandType === "sendText") {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text) return this.reject(commandId, "emptyText");
        const cwd =
          typeof payload.workspaceId === "string" ? payload.workspaceId : process.cwd();
        const created = await this.host.open({ cwd });
        console.log(`[pi-engine] prompt(new session ${created.sessionId}): ${text.slice(0, 60)}`);
        void created.session.prompt(text).catch((error: unknown) => {
          console.error("[pi-engine] prompt failed", error);
        });
        return {
          ...this.accept(commandId),
          result: {
            type: "createSession" as const,
            sessionId: created.sessionId,
            input: { delivery: "startNow" as const, inputId: `${created.sessionId}-first` },
          },
        };
      }
      return this.reject(commandId, `noSessionFor:${commandType}`);
    }

    const handle = await this.ensureSession(sessionId);

    switch (commandType) {
      case "sendText": {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text) return this.reject(commandId, "emptyText");
        console.log(`[pi-engine] prompt -> ${handle.sessionId}: ${text.slice(0, 60)}`);
        // pi queues the prompt itself while a turn is running, which is exactly
        // the `startNow`/`enqueue` split the snapshot's inputRouting reports.
        void handle.session.prompt(text).catch((error: unknown) => {
          console.error("[pi-engine] prompt failed", error);
        });
        return this.accept(commandId);
      }

      case "stop": {
        await handle.session.abort();
        return this.accept(commandId);
      }

      case "deleteSession": {
        // The UI creates a draft session eagerly and deletes it when the draft is
        // abandoned. Rejecting that leaves orphaned in-memory sessions per draft.
        this.host.close(handle.sessionId);
        return this.accept(commandId);
      }

      case "setFollowupMode":
        // pi's own queue is drain-on-idle; the `guide` variant has no equivalent.
        return this.accept(commandId);

      default:
        return this.reject(commandId, `unsupported:${commandType}`);
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

  /**
   * Agent runtime availability.
   *
   * ZCode emits this when a CLI client attaches or detaches. pi has no separate
   * agent process — the session lives in this one — so the runtime is
   * permanently available and the event never fires. It must still exist:
   * `ProxyChannel.fromService` throws `Event not found` for an unknown event,
   * and an ordinary event member IS the `Event<T>` function itself.
   */
  onAgentRuntimeLifecycle: Event<unknown> = () => ({ dispose() {} });

  /** Runtime restarts do not happen without an external agent process. */
  onAgentRuntimeRestarted: Event<{ workspaceKey: string }> = () => ({ dispose() {} });

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
