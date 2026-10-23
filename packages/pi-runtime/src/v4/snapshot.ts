/**
 * Conversation snapshot builder.
 *
 * ZCode's snapshot is a wide, strictly validated object: the UI parses every
 * frame with `conversationTopicFrameSchema` and a single bad field rejects the
 * whole frame. So the builder fills every required sub-structure explicitly and
 * runs the real schema in tests rather than trusting the shape by eye.
 *
 * pi has no equivalent of several ZCode concepts (goals, workflows, plans,
 * background work). Those are projected as empty/null, which is exactly what
 * ZCode sends for a session that has none.
 */

import type { PiSessionView } from "./session-view.js";
import type { ProjectedRow } from "./projection.js";

export interface SnapshotInput {
  view: PiSessionView;
  rows: ProjectedRow[];
  seq: number;
  revision: number;
  logEpoch?: string;
  title?: string;
  titleSource?: "default" | "generated" | "custom";
}

/**
 * Build the conversation snapshot for a session.
 *
 * `rows` is the projected row window; `seq`/`revision` are the frame's own
 * monotonic counters, owned by the frame builder.
 *
 * The return type is `unknown` on purpose: the caller validates it with the
 * real Zod schema (see ./frames.ts), and pinning a hand-written type here would
 * invite drift from the wire contract.
 */
export function buildConversationSnapshot(input: SnapshotInput): Record<string, unknown> {
  const { view, rows, seq, revision } = input;
  const busy = view.phase === "running" || view.phase === "prewarming";

  return {
    protocolVersion: 1,
    sessionId: view.sessionId,
    logEpoch: input.logEpoch ?? view.logEpoch,
    seq,
    revision,

    control: {
      phase: view.phase,
      sessionEnded: isEnded(view.phase),
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

    // Every action is offered: pi supports fork/compact/model change/follow-up
    // routing. Fields ZCode would gate on a CLI capability are left allowed so
    // the UI does not render disabled controls with a meaningless reason code.
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoal" },
      resumeGoal: { allowed: false, reasonCode: "noGoal" },
    },

    // pi's own steering/follow-up queue is what backs this: while a prompt is
    // running a new message is queued, otherwise it starts a new turn.
    inputRouting: { mode: busy ? "enqueue" : "startNow" },

    meta: {
      title: input.title ?? view.title ?? "",
      titleSource: input.titleSource ?? (view.title ? "custom" : "default"),
    },

    config: {
      provider: view.model?.provider ?? "",
      model: view.model?.modelId ?? "",
      thought: view.thinkingLevel ?? "off",
      thoughtLevels: view.thoughtLevels,
      followupMode: "queue",
      mode: "build",
    },

    modelTransition: null,

    usage: {
      contextWindow: view.contextUsage
        ? {
            usedTokens: view.contextUsage.usedTokens,
            maxTokens: view.contextUsage.maxTokens,
            autoCompactThresholdTokens: view.contextUsage.autoCompactThresholdTokens ?? null,
          }
        : null,
      cumulative: {
        inputTokens: view.usage.inputTokens,
        outputTokens: view.usage.outputTokens,
        cacheReadTokens: view.usage.cacheReadTokens,
        cacheWriteTokens: view.usage.cacheWriteTokens,
      },
    },

    // pi keeps its queue in memory; here it is surfaced so the UI can show it.
    queue: {
      items: view.queue.map((item, index) => ({
        queueItemId: `pi-queue-${index}`,
        text: item.text,
        dispatch: { state: "queued" },
      })),
      autoDrain: true,
    },

    pendingInteractions: view.pendingApprovals.map((approval) => ({
      interactionId: approval.interactionId,
      kind: "permission",
      request: {
        kind: "permission",
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        summary: approval.summary,
        detail: approval.detail ?? null,
      },
      createdAt: approval.createdAt,
    })),

    pendingCommands: [],
    backgroundWorks: [],

    goal: null,
    plan: null,

    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows.length > 0 ? rows[0]!.rowId : null,
    },
  };
}

function isEnded(phase: PiSessionView["phase"]): boolean {
  return (
    phase === "completedSuccess" ||
    phase === "completedInterrupted" ||
    phase === "error"
  );
}
