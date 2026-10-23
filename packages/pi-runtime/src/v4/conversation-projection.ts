/**
 * pi event stream → projection.
 *
 * This is the adapter that turns a live `AgentSession` into ZCode frames. It is
 * the one place that knows both vocabularies.
 *
 * pi re-sends a whole assistant message on every `message_update`, so identity
 * is derived from the message object rather than from event-local ids. The
 * stable key is the pi message's own identity: for assistant messages that is
 * the array index within the session plus its timestamp, because pi offers no
 * message id. Using a monotonically-assigned local key per distinct timestamp
 * keeps streaming updates pointing at the same row.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import {
  applyToolResult,
  beginTurn,
  createProjectionState,
  endTurn,
  interruptRunningRows,
  projectAssistantMessage,
  projectUserMessage,
  snapshotRows,
  type ProjectedDelta,
  type ProjectionState,
} from "./projection.js";
import { ConversationFrameBuilder, type ConversationWireFrame } from "./frames.js";
import { readSessionView, type PiPendingApproval, type PiPhase } from "./session-view.js";
import type { PiEvent, PiSessionHandle } from "../session-host.js";

export interface ConversationProjectionOptions {
  subscriptionId: string;
  /** Called for every frame the projection produces, in order. */
  /** Called for every wire frame the projection produces, in order. */
  emit: (frame: ConversationWireFrame) => void;
}

/**
 * Tracks one subscription over one live session.
 *
 * Lifecycle: `start()` emits the opening snapshot, then every relevant pi event
 * emits deltas. `resync()` re-emits a snapshot (the client asks for this after
 * a gap or a reconnect).
 */
export class ConversationProjection {
  private readonly state: ProjectionState = createProjectionState();
  private readonly frames: ConversationFrameBuilder;
  private unsubscribe: (() => void) | null = null;
  // A freshly opened session is idle. Starting as "running" made the very first
  // snapshot report a busy runtime, so the composer showed its stop control
  // instead of a send button and the message could never be submitted.
  private phase: PiPhase = "completedSuccess";
  private title: string | undefined;
  private pendingApprovals: PiPendingApproval[] = [];
  private errorMessage: string | undefined;
  private errorCode: string | undefined;
  private retry: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null =
    null;
  /** Message identity → stable projection key, so updates patch the same rows. */
  private readonly messageKeys = new Map<string, string>();
  /** User messages already projected; they arrive twice (start and end). */
  private readonly projectedUserKeys = new Set<string>();
  private nextMessageOrdinal = 1;
  /** Track the open turn so agent_end can close it. */
  private turnOpen = false;
  /** Whether the opening snapshot went out; a second one restarts the sequence. */
  private sentInitialSnapshot = false;

  constructor(
    private readonly session: PiSessionHandle,
    private readonly options: ConversationProjectionOptions,
  ) {
    this.frames = new ConversationFrameBuilder(session.sessionId, options.subscriptionId);
  }

  start(): void {
    // Seed the projection from the transcript before subscribing. A session
    // opened from the sidebar already has history in `state.messages`; without
    // this backfill the opening snapshot is empty and the conversation renders
    // blank even though the file is full.
    this.backfillHistory();
    this.unsubscribe = this.session.subscribe((event) => this.handle(event));
    this.emitSnapshot();
  }

  /**
   * Project the messages a session already holds.
   *
   * Runs once, before the subscription, so the opening snapshot carries the whole
   * transcript instead of only events that arrive afterwards.
   */
  private backfillHistory(): void {
    const state = this.session.session.state as unknown as {
      messages?: readonly (UserMessage | AssistantMessage | ToolResultMessage)[];
      isStreaming?: boolean;
    };
    const messages = state.messages ?? [];
    if (messages.length === 0) return;

    // One turn per user message, matching how a live run opens a turn.
    let turn = 0;
    for (const message of messages) {
      const role = (message as { role?: string }).role;
      if (role === "user") {
        turn += 1;
        beginTurn(this.state, `history-${turn}`);
      }
      const streaming = role === "assistant" && Boolean(state.isStreaming);
      this.projectMessage(message, streaming);
    }
    this.phase = state.isStreaming ? "running" : "completedSuccess";
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Recovery hook for a same-subscription resync.
   *
   * Deliberately does NOT re-send a snapshot. pi keeps every projected row in
   * memory and never loses a delta, so a client that resumes from its own
   * sequence is already consistent; emitting a snapshot here is what produced
   * `frameAssemblyMetadataMismatch` and silently emptied the transcript.
   */
  resync(): void {}

  /** Every projected row in rowId order — used by rows/range pagination. */
  rowsSnapshot() {
    return snapshotRows(this.state);
  }

  /** Sequence of the last delivered frame, for cursor bookkeeping. */
  get currentSeq(): number {
    return this.frames.currentSeq;
  }

  private emitSnapshot(): void {
    const view = readSessionView(this.session.session as AgentSession, {
      phase: this.phase,
      title: this.title,
      pendingApprovals: this.pendingApprovals,
      retry: this.retry,
      errorMessage: this.errorMessage,
      errorCode: this.errorCode,
    });
    // `onDynamicConversationFrame` carries the wire envelope, not the bare frame.
    this.sentInitialSnapshot = true;
    this.options.emit(this.frames.wrap(this.frames.snapshot(view, snapshotRows(this.state))));
  }

  private emitDeltas(deltas: ProjectedDelta[]): void {
    const frame = this.frames.deltas(deltas);
    if (frame) this.options.emit(this.frames.wrap(frame));
  }

  /**
   * Report a session-state change (phase, approvals, retry, title).
   *
   * This must NOT emit a snapshot. A snapshot carries `fromSeq: 0` while its
   * `toSeq` keeps advancing, so re-sending one mid-stream makes the UI's
   * assembler reject the frame with `frameAssemblyMetadataMismatch` — which then
   * discards the streamed rows. Only the first frame of a subscription is a
   * snapshot; everything after it is a delta.
   */
  private emitStateUpdate(): void {
    if (!this.sentInitialSnapshot) {
      this.emitSnapshot();
      return;
    }
    this.emitDeltas([
      {
        op: "state.updated",
        // Carry the fields that actually changed. An empty patch would leave the
        // stop control showing after the turn finished, because the UI renders
        // running/idle from `control`.
        patch: (() => {
          const view = readSessionView(this.session.session as AgentSession, {
            phase: this.phase,
            title: this.title,
            pendingApprovals: this.pendingApprovals,
            retry: this.retry,
            errorMessage: this.errorMessage,
            errorCode: this.errorCode,
          });
          const busy = view.phase === "running" || view.phase === "prewarming";
          return {
            revision: this.frames.nextRevision(),
            control: {
              phase: view.phase,
              sessionEnded:
                view.phase === "completedSuccess" ||
                view.phase === "completedInterrupted" ||
                view.phase === "error",
              canStop: busy,
              stopState: busy ? "stoppable" : "idle",
              stopTargetKind: busy ? "assistant" : "unknown",
              activeWorks: [],
              lastError: view.errorMessage
                ? { code: view.errorCode ?? "unknown", message: view.errorMessage }
                : null,
              apiRetry: view.retry
                ? {
                    attempt: view.retry.attempt,
                    maxAttempts: view.retry.maxAttempts,
                    delayMs: view.retry.delayMs,
                    errorMessage: view.retry.errorMessage,
                  }
                : null,
            },
            ...(this.title ? { meta: { title: this.title, titleSource: "custom" as const } } : {}),
          } as Record<string, unknown>;
        })(),
      },
    ]);
  }

  private handle(event: PiEvent): void {
    switch (event.type) {
      case "agent_start": {
        this.phase = "running";
        this.turnOpen = true;
        beginTurn(this.state, `turn-${this.nextMessageOrdinal}`);
        this.emitDeltas([]);
        this.emitStateUpdate();
        return;
      }

      case "message_start":
      case "message_update": {
        const message = (event as { message?: unknown }).message;
        if (!message || typeof message !== "object") return;
        const deltas = this.projectMessage(message as never, event.type === "message_update");
        this.emitDeltas(deltas);
        return;
      }

      case "message_end": {
        const message = (event as { message?: unknown }).message;
        if (!message || typeof message !== "object") return;
        // The final frame of a message settles streaming state ("complete").
        const deltas = this.projectMessage(message as never, false);
        this.emitDeltas(deltas);
        return;
      }

      case "tool_execution_start": {
        // The toolCall row already exists from the assistant message; this event
        // only confirms the call is now running.
        return;
      }

      case "tool_execution_end": {
        const toolCallId = (event as { toolCallId?: string }).toolCallId;
        const result = (event as { result?: unknown }).result;
        const isError = Boolean((event as { isError?: boolean }).isError);
        if (!toolCallId) return;
        this.emitDeltas(
          applyToolResult(this.state, {
            toolCallId,
            text: toolResultText(result),
            isError,
          }),
        );
        return;
      }

      case "agent_end": {
        this.phase = "completedSuccess";
        this.turnOpen = false;
        this.emitDeltas(endTurn(this.state, "completedSuccess"));
        this.emitStateUpdate();
        return;
      }

      case "agent_settled": {
        if (this.phase === "running") {
          this.phase = "completedSuccess";
          this.emitStateUpdate();
        }
        return;
      }

      case "auto_retry_start": {
        const e = event as {
          attempt?: number;
          maxAttempts?: number;
          delayMs?: number;
          errorMessage?: string;
        };
        this.retry = {
          attempt: e.attempt ?? 1,
          maxAttempts: e.maxAttempts ?? 1,
          delayMs: e.delayMs ?? 0,
          errorMessage: e.errorMessage ?? "",
        };
        this.emitStateUpdate();
        return;
      }

      case "auto_retry_end": {
        this.retry = null;
        this.emitStateUpdate();
        return;
      }

      case "session_info_changed": {
        const name = (event as { name?: string }).name;
        this.title = name;
        this.emitStateUpdate();
        return;
      }

      case "tool_approval_request": {
        const e = event as {
          interactionId?: string;
          toolCallId?: string;
          toolName?: string;
          summary?: string;
          detail?: unknown;
        };
        if (!e.interactionId) return;
        this.pendingApprovals = [
          ...this.pendingApprovals,
          {
            interactionId: e.interactionId,
            toolCallId: e.toolCallId ?? "",
            toolName: e.toolName ?? "",
            summary: e.summary ?? "",
            detail: e.detail,
            createdAt: Date.now(),
          },
        ];
        this.emitStateUpdate();
        return;
      }

      case "tool_approval_resolved": {
        const interactionId = (event as { interactionId?: string }).interactionId;
        this.pendingApprovals = this.pendingApprovals.filter(
          (approval) => approval.interactionId !== interactionId,
        );
        this.emitStateUpdate();
        return;
      }

      default:
        return;
    }
  }

  /**
   * Project one pi message.
   *
   * pi sends no message id, so a key is derived per message: the first time a
   * message is seen it gets an ordinal; later updates of the same message must
   * resolve to the same key. `message_update` carries the same object identity
   * as its `message_start` sibling in practice, but not always — so the key is
   * also derived from (role, timestamp), which is stable across re-sends.
   */
  private projectMessage(message: UserMessage | AssistantMessage | ToolResultMessage, streaming: boolean): ProjectedDelta[] {
    const role = (message as { role?: string }).role;
    const timestamp = (message as { timestamp?: number }).timestamp ?? 0;
    const identity = `${role}:${timestamp}`;
    let key = this.messageKeys.get(identity);
    if (!key) {
      key = `msg-${this.nextMessageOrdinal++}`;
      this.messageKeys.set(identity, key);
    }
    // Streaming growth is invisible without the text length: a row stuck at one
    // character looks identical to a row that never updates.
    if (role === "assistant" && streaming) {
      const content = (message as AssistantMessage).content;
      const text = content.find((block) => block.type === "text");
      console.log(
        `[pi-engine] update key=${key} blocks=${content.length} ` +
          `text=${text && text.type === "text" ? text.text.length : 0}`,
      );
    }

    if (role === "user") {
      // A user message arrives on both message_start and message_end. Re-projecting
      // it appends a second identical row, which is why the transcript showed the
      // same prompt twice.
      if (this.projectedUserKeys.has(key)) return [];
      this.projectedUserKeys.add(key);
      return projectUserMessage(this.state, message as UserMessage, key);
    }
    if (role === "assistant") {
      return projectAssistantMessage(this.state, message as AssistantMessage, key, { streaming });
    }
    if (role === "toolResult") {
      const result = message as ToolResultMessage;
      return applyToolResult(this.state, {
        toolCallId: result.toolCallId,
        text: toolResultText(result.content),
        isError: Boolean((result as { isError?: boolean }).isError),
      });
    }
    return [];
  }
}

/** Flatten a pi tool result payload to display text. */
function toolResultText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (payload && typeof payload === "object") {
    const maybeText = (payload as { text?: unknown; content?: unknown }).text;
    if (typeof maybeText === "string") return maybeText;
    const content = (payload as { content?: unknown }).content;
    if (content !== undefined) return toolResultText(content);
    try {
      return JSON.stringify(payload);
    } catch {
      return "";
    }
  }
  return "";
}

export { interruptRunningRows };
