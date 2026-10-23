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
import { ConversationFrameBuilder } from "./frames.js";
import { readSessionView, type PiPendingApproval, type PiPhase } from "./session-view.js";
import type { PiEvent, PiSessionHandle } from "../session-host.js";

export interface ConversationProjectionOptions {
  subscriptionId: string;
  /** Called for every frame the projection produces, in order. */
  emit: (frame: ReturnType<ConversationFrameBuilder["snapshot"]>) => void;
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
  private phase: PiPhase = "running";
  private title: string | undefined;
  private pendingApprovals: PiPendingApproval[] = [];
  private errorMessage: string | undefined;
  private errorCode: string | undefined;
  private retry: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null =
    null;
  /** Message identity → stable projection key, so updates patch the same rows. */
  private readonly messageKeys = new Map<string, string>();
  private nextMessageOrdinal = 1;
  /** Track the open turn so agent_end can close it. */
  private turnOpen = false;

  constructor(
    private readonly session: PiSessionHandle,
    private readonly options: ConversationProjectionOptions,
  ) {
    this.frames = new ConversationFrameBuilder(session.sessionId, options.subscriptionId);
  }

  start(): void {
    this.unsubscribe = this.session.subscribe((event) => this.handle(event));
    this.emitSnapshot();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Re-emit a full snapshot; the client uses this after a gap or reconnect. */
  resync(): void {
    this.emitSnapshot();
  }

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
    this.options.emit(this.frames.snapshot(view, snapshotRows(this.state)));
  }

  private emitDeltas(deltas: ProjectedDelta[]): void {
    const frame = this.frames.deltas(deltas);
    if (frame) this.options.emit(frame);
  }

  private handle(event: PiEvent): void {
    switch (event.type) {
      case "agent_start": {
        this.phase = "running";
        this.turnOpen = true;
        beginTurn(this.state, `turn-${this.nextMessageOrdinal}`);
        this.emitDeltas([]);
        this.emitSnapshot();
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
        this.emitSnapshot();
        return;
      }

      case "agent_settled": {
        if (this.phase === "running") {
          this.phase = "completedSuccess";
          this.emitSnapshot();
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
        this.emitSnapshot();
        return;
      }

      case "auto_retry_end": {
        this.retry = null;
        this.emitSnapshot();
        return;
      }

      case "session_info_changed": {
        const name = (event as { name?: string }).name;
        this.title = name;
        this.emitSnapshot();
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
        this.emitSnapshot();
        return;
      }

      case "tool_approval_resolved": {
        const interactionId = (event as { interactionId?: string }).interactionId;
        this.pendingApprovals = this.pendingApprovals.filter(
          (approval) => approval.interactionId !== interactionId,
        );
        this.emitSnapshot();
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

    if (role === "user") {
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
