/**
 * pi message → ZCode conversation row projection.
 *
 * ZCode's conversation topic is a projected event log: rows are self-contained
 * (rendering one row never requires another), structural changes replace the
 * whole row via `row.upserted`, and text growth uses `row.delta`. pi instead
 * emits session events whose messages are re-sent whole on every update.
 *
 * This module owns the translation. It is deliberately pure — no hidden clocks
 * or counters — so the frame builder can replay it in tests.
 *
 * Row kind mapping:
 *   pi user message          → userInput
 *   pi assistant text block  → assistantText  (streaming while the block grows)
 *   pi thinking block        → reasoning      (streaming while it grows)
 *   pi toolCall block        → toolCall       (status from tool_execution_*)
 *   pi toolResult message    → same toolCall row, filled in
 *   pi Agent tool call       → subagent       (a dedicated row, not a tool card)
 */

import type { AssistantMessage, ToolCall, UserMessage } from "@earendil-works/pi-ai";

export type RowKind =
  | "turnHeader"
  | "userInput"
  | "assistantText"
  | "reasoning"
  | "toolCall"
  | "subagent";

/**
 * Row shape consumed by ZCode's projection store. Mirrors `conversationRowSchema`
 * loosely on purpose: the frame builder re-validates with the real Zod schema,
 * so this type stays readable instead of restating every optional field.
 */
export interface ProjectedRow {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  kind: RowKind;
  [key: string]: unknown;
}

export type ProjectedDelta =
  | { op: "row.appended"; row: ProjectedRow }
  | { op: "row.upserted"; row: ProjectedRow }
  | { op: "row.delta"; rowId: number; path: string; append: string }
  /**
   * A session-state change with no row impact (phase, approvals, retry, title).
   *
   * These live in the snapshot's control/config blocks, and the UI reads the
   * whole snapshot for them. An empty patch keeps the stream sequence legal —
   * re-sending a snapshot mid-stream is rejected as a metadata mismatch.
   */
  | { op: "state.updated"; patch: Record<string, unknown> };

export interface ProjectionState {
  /** Monotonic row id, never reused — matches ZCode's generator contract. */
  nextRowId: number;
  /** pi has no turn concept, so one prompt opens one product turn. */
  currentTurnId: string | null;
  nextSeq: number;
  /** Block identity → row id, so an update patches instead of re-adding. */
  readonly rowByKey: Map<string, number>;
  /** Last known text per streamed row, used to emit only the appended suffix. */
  readonly textByRow: Map<number, string>;
  readonly rows: Map<number, ProjectedRow>;
}

export function createProjectionState(): ProjectionState {
  return {
    nextRowId: 1,
    currentTurnId: null,
    nextSeq: 1,
    rowByKey: new Map(),
    textByRow: new Map(),
    rows: new Map(),
  };
}

function baseRow(
  state: ProjectionState,
  kind: RowKind,
  key: string,
  createdAt: number,
): ProjectedRow {
  const rowId = state.nextRowId++;
  state.rowByKey.set(key, rowId);
  return {
    rowId,
    turnId: state.currentTurnId ?? "turn-0",
    createdAt,
    createdAtSeq: state.nextSeq++,
    kind,
  };
}

/** Open a new product turn. pi starts one per prompt. */
export function beginTurn(state: ProjectionState, turnId: string, createdAt = Date.now()): void {
  state.currentTurnId = turnId;
  const row = baseRow(state, "turnHeader", `turn:${turnId}`, createdAt);
  Object.assign(row, {
    origin: "userInput",
    executionKind: "agent",
    state: "running",
    startedAt: createdAt,
  });
  state.rows.set(row.rowId, row);
}

/** Close the open turn. */
export function endTurn(
  state: ProjectionState,
  outcome: "completedSuccess" | "completedInterrupted" | "failed",
  endedAt = Date.now(),
): ProjectedDelta[] {
  if (!state.currentTurnId) return [];
  const rowId = state.rowByKey.get(`turn:${state.currentTurnId}`);
  if (rowId === undefined) return [];
  const row = state.rows.get(rowId);
  if (!row) return [];
  const updated = { ...row, state: outcome, endedAt };
  state.rows.set(rowId, updated);
  return [{ op: "row.upserted", row: updated }];
}

/** Project a pi user message into a `userInput` row. */
export function projectUserMessage(
  state: ProjectionState,
  message: UserMessage,
  key: string,
): ProjectedDelta[] {
  const row = baseRow(state, "userInput", key, message.timestamp);
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
  Object.assign(row, { text, origin: "realUser" });
  state.rows.set(row.rowId, row);
  return [{ op: "row.appended", row }];
}

/**
 * Emit `row.delta` for an append-only suffix, or a whole-row upsert when the
 * text was rewritten (retry / edit / compaction rewrites history).
 */
function growText(state: ProjectionState, rowId: number, next: string): ProjectedDelta[] {
  const previous = state.textByRow.get(rowId) ?? "";
  if (next === previous) return [];
  state.textByRow.set(rowId, next);
  if (next.startsWith(previous)) {
    const append = next.slice(previous.length);
    // `path` is a closed enum — "text" | "inputText" | "output.text" |
    // "summaryText" — not a JSON pointer. A pointer form fails the frame schema,
    // and the assembler then rejects the whole frame as an invalid payload, which
    // silently drops every streamed character.
    return append ? [{ op: "row.delta", rowId, path: "text", append }] : [];
  }
  const row = state.rows.get(rowId);
  if (!row) return [];
  const updated = { ...row, text: next };
  state.rows.set(rowId, updated);
  return [{ op: "row.upserted", row: updated }];
}

function setRowState(state: ProjectionState, rowId: number, nextState: string): ProjectedDelta[] {
  const row = state.rows.get(rowId);
  if (!row || row.state === nextState) return [];
  const updated = { ...row, state: nextState };
  state.rows.set(rowId, updated);
  return [{ op: "row.upserted", row: updated }];
}

export interface ProjectAssistantOptions {
  /** True while the assistant message is still being generated. */
  streaming: boolean;
}

/**
 * Project one assistant message.
 *
 * A single pi assistant message carries text, thinking and tool calls in one
 * `content` array; ZCode renders them as independent rows, so each block gets
 * its own row and identity keyed by message key + block index.
 */
export function projectAssistantMessage(
  state: ProjectionState,
  message: AssistantMessage,
  messageKey: string,
  options: ProjectAssistantOptions,
): ProjectedDelta[] {
  const deltas: ProjectedDelta[] = [];
  const responseId = message.responseId ?? messageKey;

  message.content.forEach((block, index) => {
    const blockKey = `${messageKey}:${index}`;

    if (block.type === "text" || block.type === "thinking") {
      const text = block.type === "text" ? block.text : block.thinking;
      const kind = block.type === "text" ? "assistantText" : "reasoning";
      const existing = state.rowByKey.get(blockKey);

      if (existing === undefined) {
        const row = baseRow(state, kind, blockKey, message.timestamp);
        Object.assign(row, {
          assistantResponseId: responseId,
          text,
          state: options.streaming ? "streaming" : "complete",
          ...(block.type === "text" ? { model: message.model } : {}),
        });
        state.rows.set(row.rowId, row);
        state.textByRow.set(row.rowId, text);
        deltas.push({ op: "row.appended", row });
        return;
      }

      deltas.push(...growText(state, existing, text));
      if (!options.streaming) deltas.push(...setRowState(state, existing, "complete"));
      return;
    }

    if (block.type === "toolCall") {
      deltas.push(...projectToolCall(state, block, blockKey, message.timestamp));
    }
  });

  return deltas;
}

/** Start (or patch) a tool-call row. The result arrives later as a separate message. */
export function projectToolCall(
  state: ProjectionState,
  call: ToolCall,
  blockKey: string,
  createdAt: number,
): ProjectedDelta[] {
  const inputText = safeJson(call.arguments);
  const existing = state.rowByKey.get(blockKey);

  if (existing !== undefined) {
    const row = state.rows.get(existing);
    if (!row || row.inputText === inputText) return [];
    const updated = { ...row, inputText, input: call.arguments };
    state.rows.set(existing, updated);
    return [{ op: "row.upserted", row: updated }];
  }

  // A subagent launch is its own row kind in ZCode, not a tool card.
  if (call.name === "Agent") {
    const row = baseRow(state, "subagent", blockKey, createdAt);
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    Object.assign(row, {
      parentToolCallId: call.id,
      subagentType: typeof args.subagent_type === "string" ? args.subagent_type : "general-purpose",
      status: "running",
      summaryText: typeof args.description === "string" ? args.description : "",
      startedAt: createdAt,
    });
    state.rows.set(row.rowId, row);
    return [{ op: "row.appended", row }];
  }

  const row = baseRow(state, "toolCall", blockKey, createdAt);
  Object.assign(row, {
    toolCallId: call.id,
    toolName: call.name,
    status: "running",
    inputText,
    input: call.arguments,
    startedAt: createdAt,
  });
  state.rows.set(row.rowId, row);
  return [{ op: "row.appended", row }];
}

/** Locate the row of a tool call by its pi tool-call id. */
export function findRowByToolCallId(
  state: ProjectionState,
  toolCallId: string,
): ProjectedRow | undefined {
  for (const row of state.rows.values()) {
    if ((row.kind === "toolCall" || row.kind === "subagent") && row.toolCallId === toolCallId) {
      return row;
    }
    if (row.kind === "subagent" && row.parentToolCallId === toolCallId) return row;
  }
  return undefined;
}

/** Fill a tool-call row from its result. */
export function applyToolResult(
  state: ProjectionState,
  input: { toolCallId: string; text: string; isError?: boolean; endedAt?: number },
): ProjectedDelta[] {
  const row = findRowByToolCallId(state, input.toolCallId);
  if (!row) return [];
  const updated =
    row.kind === "subagent"
      ? {
          ...row,
          status: input.isError ? "failed" : "success",
          summaryText: input.text || row.summaryText,
          endedAt: input.endedAt ?? Date.now(),
        }
      : {
          ...row,
          status: input.isError ? "error" : "success",
          output: { text: input.text },
          endedAt: input.endedAt ?? Date.now(),
        };
  state.rows.set(row.rowId, updated);
  return [{ op: "row.upserted", row: updated }];
}

/** Mark every still-running row as interrupted (pi abort, or a dropped session). */
export function interruptRunningRows(state: ProjectionState): ProjectedDelta[] {
  const deltas: ProjectedDelta[] = [];
  for (const row of state.rows.values()) {
    if (row.state === "streaming") {
      deltas.push(...setRowState(state, row.rowId, "interrupted"));
    } else if (row.kind === "toolCall" && row.status === "running") {
      const updated = { ...row, status: "cancelled", endedAt: Date.now() };
      state.rows.set(row.rowId, updated);
      deltas.push({ op: "row.upserted", row: updated });
    } else if (row.kind === "subagent" && row.status === "running") {
      const updated = { ...row, status: "cancelled", endedAt: Date.now() };
      state.rows.set(row.rowId, updated);
      deltas.push({ op: "row.upserted", row: updated });
    }
  }
  return deltas;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "";
  } catch {
    return "";
  }
}

/** Every projected row in rowId order — the snapshot's `window`. */
export function snapshotRows(state: ProjectionState): ProjectedRow[] {
  return [...state.rows.values()].sort((a, b) => a.rowId - b.rowId);
}
