/**
 * Live view of one pi session, shaped for snapshot building.
 *
 * The projection layer needs a small, stable vocabulary (phase, model, usage,
 * queue, approvals) while the SDK state carries much more. This module is the
 * single adapter between them; nothing else reaches into `AgentSession.state`.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type PiPhase =
  | "draft"
  | "prewarming"
  | "running"
  | "completedSuccess"
  | "completedInterrupted"
  | "error";

export interface PiUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PiContextUsage {
  usedTokens: number;
  maxTokens: number;
  autoCompactThresholdTokens?: number | null;
}

export interface PiRetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface PiQueueItem {
  text: string;
}

export interface PiPendingApproval {
  interactionId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  detail?: unknown;
  createdAt: number;
}

export interface PiSessionView {
  sessionId: string;
  logEpoch: string;
  phase: PiPhase;
  title?: string;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  thoughtLevels: string[];
  usage: PiUsageTotals;
  contextUsage: PiContextUsage | null;
  queue: PiQueueItem[];
  pendingApprovals: PiPendingApproval[];
  retry: PiRetryInfo | null;
  errorMessage?: string;
  errorCode?: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Derive the view from a live session.
 *
 * `phase` is not a property of a pi session — it is inferred from the runtime
 * flags the session exposes. A session with no history and no run is `draft`,
 * which is what ZCode shows for a freshly created empty session.
 */
export function readSessionView(
  session: AgentSession,
  extras: {
    phase?: PiPhase;
    title?: string;
    queue?: readonly string[];
    pendingApprovals?: PiPendingApproval[];
    retry?: PiRetryInfo | null;
    errorMessage?: string;
    errorCode?: string;
  } = {},
): PiSessionView {
  const state = session.state as unknown as {
    model?: { provider?: string; id?: string; modelId?: string } | null;
    thinkingLevel?: string;
    messages?: readonly unknown[];
    isStreaming?: boolean;
    usage?: Partial<PiUsageTotals>;
  };

  const usage = state.usage ?? {};
  // A session that is not streaming is idle, not "running". Reporting a busy
  // phase makes the composer render its stop control instead of the send
  // button, so the user can never submit.
  const inferredPhase: PiPhase = extras.phase ?? (state.isStreaming ? "running" : "completedSuccess");
  return {
    sessionId: session.sessionId,
    logEpoch: session.sessionId,
    phase: inferredPhase,
    title: extras.title,
    model: state.model
      ? {
          provider: state.model.provider ?? "",
          modelId: state.model.id ?? state.model.modelId ?? "",
        }
      : null,
    thinkingLevel: state.thinkingLevel ?? "off",
    thoughtLevels: THINKING_LEVELS,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    },
    contextUsage: null,
    queue: (extras.queue ?? []).map((text) => ({ text })),
    pendingApprovals: extras.pendingApprovals ?? [],
    retry: extras.retry ?? null,
    errorMessage: extras.errorMessage,
    errorCode: extras.errorCode,
  };
}
