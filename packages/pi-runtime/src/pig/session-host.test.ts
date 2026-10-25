import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { PiGSessionHost } from "./session-host.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private sessionId = "pig-session-1";
  private sessionFile = "/workspace/project/.pig-agent/sessions/session.jsonl";

  constructor(private readonly promptEvents: readonly unknown[] = []) {
    super();
    this.stdin.on("data", (chunk) => {
      const command = JSON.parse(String(chunk).trim()) as { id: string; type: string };
      const response = (data: unknown = {}) =>
        this.stdout.write(
          `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data })}\n`,
        );
      switch (command.type) {
        case "new_session":
          response({ cancelled: false });
          break;
        case "get_state":
          response({
            model: { id: "unknown", name: "unknown", api: "unknown", provider: "unknown" },
            thinkingLevel: "off",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
            sessionId: this.sessionId,
            sessionFile: this.sessionFile,
            messageCount: 0,
            pendingMessageCount: 0,
          });
          break;
        case "fork":
          this.sessionId = "pig-session-2";
          this.sessionFile = "/workspace/project/.pig-agent/sessions/session-fork.jsonl";
          response({ cancelled: false });
          break;
        case "get_messages":
          response({ messages: [] });
          break;
        case "prompt":
          this.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
          response({ disposition: "started" });
          for (const event of this.promptEvents) {
            this.stdout.write(`${JSON.stringify(event)}\n`);
          }
          this.stdout.write(`${JSON.stringify({ type: "agent_settled", aborted: false })}\n`);
          break;
        default:
          response();
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("close", 0, null);
    return true;
  }
}

function spawnFake(child: FakeChild) {
  return vi.fn(() => child as never) as never;
}

describe("PiGSessionHost", () => {
  it("opens an isolated PiG session, reads its snapshot, and forwards events", async () => {
    const child = new FakeChild();
    const host = new PiGSessionHost({
      sessionRoot: "/workspace/project/.pig-agent/sessions",
      spawnProcess: spawnFake(child),
      executable: "pig-test",
    });
    const events: unknown[] = [];
    const handle = await host.open({ cwd: "/workspace/project" });
    handle.subscribe((event) => events.push(event));

    expect(handle.sessionId).toBe("pig-session-1");
    expect(handle.cwd).toBe("/workspace/project");
    await handle.session.prompt("hello");
    expect(handle.session.state.isStreaming).toBe(false);
    expect(events).toContainEqual({ type: "agent_start" });
    expect(events).toContainEqual({ type: "agent_settled", aborted: false });

    host.closeAll();
    expect(host.list()).toEqual([]);
  });

  it("adopts the replacement session id after PiG forks a session", async () => {
    const child = new FakeChild();
    const host = new PiGSessionHost({
      sessionRoot: "/workspace/project/.pig-agent/sessions",
      spawnProcess: spawnFake(child),
      executable: "pig-test",
    });
    const handle = await host.open({ cwd: "/workspace/project" });

    const forkedSessionId = await host.fork(handle, "entry-1");

    expect(forkedSessionId).toBe("pig-session-2");
    expect(host.get("pig-session-1")).toBeUndefined();
    expect(host.get("pig-session-2")?.sessionId).toBe("pig-session-2");
    expect(host.list()).toEqual(["pig-session-2"]);

    host.close("pig-session-1");
    expect(host.list()).toEqual(["pig-session-2"]);
    host.closeAll();
  });

  it("normalizes cumulative text and thinking deltas before forwarding message_update", async () => {
    const assistant = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
      stopReason: "pending",
      timestamp: 10,
    };
    const child = new FakeChild([
      { type: "message_start", message: assistant },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Reason" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "ing" },
      },
      {
        type: "message_end",
        message: {
          ...assistant,
          content: [
            { type: "text", text: "Hello" },
            { type: "thinking", thinking: "Reasoning" },
          ],
        },
      },
    ]);
    const host = new PiGSessionHost({
      sessionRoot: "/workspace/project/.pig-agent/sessions",
      spawnProcess: spawnFake(child),
      executable: "pig-test",
    });
    const events: Array<{ type?: string; message?: { content?: unknown[] } }> = [];
    const handle = await host.open({ cwd: "/workspace/project" });
    handle.subscribe((event) => events.push(event as (typeof events)[number]));

    await handle.session.prompt("hello");

    const updates = events.filter((event) => event.type === "message_update");
    expect(updates.map((event) => event.message?.content)).toEqual([
      [{ type: "text", text: "" }],
      [{ type: "text", text: "Hel" }],
      [{ type: "text", text: "Hello" }],
      [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "" },
      ],
      [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "Reason" },
      ],
      [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "Reasoning" },
      ],
    ]);
    expect(events.find((event) => event.type === "message_end")?.message?.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "Reasoning" },
    ]);
    expect(handle.session.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "Reasoning" },
      ],
    });
    host.closeAll();
  });

  it("accumulates tool argument deltas once and uses toolcall_end as authoritative", async () => {
    const assistant = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
      stopReason: "pending",
      timestamp: 11,
    };
    const toolCall = {
      type: "toolCall",
      id: "call-1",
      name: "lookup",
      arguments: { query: "pi" },
    };
    const child = new FakeChild([
      { type: "message_start", message: assistant },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          id: "call-1",
          toolName: "lookup",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"query":' },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '"pi"}' },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall },
      },
      { type: "message_end", message: { ...assistant, content: [toolCall] } },
    ]);
    const host = new PiGSessionHost({
      sessionRoot: "/workspace/project/.pig-agent/sessions",
      spawnProcess: spawnFake(child),
      executable: "pig-test",
    });
    const events: Array<{ type?: string; message?: { content?: unknown[] } }> = [];
    const handle = await host.open({ cwd: "/workspace/project" });
    handle.subscribe((event) => events.push(event as (typeof events)[number]));

    await handle.session.prompt("lookup");

    const updates = events.filter((event) => event.type === "message_update");
    expect(updates.map((event) => event.message?.content)).toEqual([
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "pi" } }],
      [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "pi" } }],
    ]);
    expect(handle.session.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [toolCall],
    });
    host.closeAll();
  });
});
