/**
 * Schema contract tests.
 *
 * The whole point of this file is to fail loudly when the hand-built snapshot
 * drifts from ZCode's wire contract. A single rejected field means the UI would
 * drop the entire frame and show an empty conversation, so these assertions run
 * against the *real* Zod schema, never a local restatement of it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

import { ConversationFrameBuilder } from "./frames.js";
import {
  applyToolResult,
  createProjectionState,
  beginTurn,
  projectAssistantMessage,
  projectUserMessage,
  snapshotRows,
} from "./projection.js";
import type { PiSessionView } from "./session-view.js";

function view(overrides: Partial<PiSessionView> = {}): PiSessionView {
  return {
    sessionId: "sess-1",
    logEpoch: "sess-1",
    phase: "completedSuccess",
    model: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    thinkingLevel: "medium",
    thoughtLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    contextUsage: null,
    queue: [],
    pendingApprovals: [],
    retry: null,
    ...overrides,
  };
}

const userMessage = (text: string): UserMessage => ({
  role: "user",
  content: text,
  timestamp: Date.parse("2026-10-23T10:00:00Z"),
});

function assistantMessage(
  content: AssistantMessage["content"],
  timestamp = Date.parse("2026-10-23T10:00:01Z"),
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic" as AssistantMessage["api"],
    provider: "anthropic" as AssistantMessage["provider"],
    model: "claude-sonnet-4-6",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp,
  } as AssistantMessage;
}

test("empty snapshot satisfies the wire schema", () => {
  const builder = new ConversationFrameBuilder("sess-1", "sub-1");
  const frame = builder.snapshot(view(), []);
  const parsed = conversationSnapshotSchema.safeParse(
    frame.payload.kind === "snapshot" ? frame.payload.snapshot : null,
  );
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
});

test("snapshot with projected rows satisfies the wire schema", () => {
  const state = createProjectionState();
  beginTurn(state, "turn-1");
  projectUserMessage(state, userMessage("hello"), "user-1");
  projectAssistantMessage(state, assistantMessage([{ type: "text", text: "hi there" }]), "asst-1", {
    streaming: false,
  });

  const builder = new ConversationFrameBuilder("sess-1", "sub-1");
  const frame = builder.snapshot(view(), snapshotRows(state));
  assert.equal(frame.payload.kind, "snapshot");
  const snapshot = frame.payload.kind === "snapshot" ? frame.payload.snapshot : null;
  const parsed = conversationSnapshotSchema.safeParse(snapshot);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));

  const topicParsed = conversationTopicFrameSchema.safeParse(frame);
  assert.ok(
    topicParsed.success,
    topicParsed.success ? "" : JSON.stringify(topicParsed.error.issues, null, 2),
  );
});

test("snapshot with a tool call row satisfies the wire schema", () => {
  const state = createProjectionState();
  beginTurn(state, "turn-1");
  projectUserMessage(state, userMessage("list files"), "user-1");
  projectAssistantMessage(
    state,
    assistantMessage([
      { type: "text", text: "Let me look." },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]),
    "asst-1",
    { streaming: false },
  );
  applyToolResult(state, { toolCallId: "call-1", text: "a.txt\nb.txt" });

  const builder = new ConversationFrameBuilder("sess-1", "sub-1");
  const frame = builder.snapshot(view(), snapshotRows(state));
  const snapshot = frame.payload.kind === "snapshot" ? frame.payload.snapshot : null;
  const parsed = conversationSnapshotSchema.safeParse(snapshot);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
});

test("deltas frame satisfies the wire schema", () => {
  const state = createProjectionState();
  beginTurn(state, "turn-1");
  const deltas = projectUserMessage(state, userMessage("hello"), "user-1");

  const builder = new ConversationFrameBuilder("sess-1", "sub-1");
  // Sequence numbering assumes a snapshot opened the stream.
  builder.snapshot(view(), []);
  const frame = builder.deltas(deltas);
  assert.ok(frame);
  const parsed = conversationTopicFrameSchema.safeParse(frame);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
});

test("streaming text grows by row.delta, not by re-sending the row", () => {
  const state = createProjectionState();
  beginTurn(state, "turn-1");

  const first = projectAssistantMessage(
    state,
    assistantMessage([{ type: "text", text: "Hel" }]),
    "asst-1",
    { streaming: true },
  );
  const second = projectAssistantMessage(
    state,
    assistantMessage([{ type: "text", text: "Hello" }]),
    "asst-1",
    { streaming: true },
  );

  assert.equal(first[0]?.op, "row.appended");
  // rowId 1 is the turn header opened by beginTurn; the text row is 2.
  assert.deepEqual(second, [{ op: "row.delta", rowId: 2, path: "text", append: "lo" }]);
});
