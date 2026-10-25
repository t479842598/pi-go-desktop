/**
 * Service contract tests.
 *
 * These drive the service the way the UI does — handshake, subscribe, command —
 * and validate every response with the real wire schema. They run against a
 * throwaway pi session directory so they never touch the developer's sessions.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  commandAckSchema,
  conversationSnapshotSchema,
  conversationTopicWireFrameSchema,
  helloMessageSchema,
  v4ConversationSubscribeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { PiSessionHost } from "../session-host.js";
import type { PiGSessionEvent, RuntimeSessionHandle, RuntimeSessionHost } from "../pig/session-host.js";
import { PiAgentService } from "./pi-agent-service.js";

async function withService<T>(
  run: (service: PiAgentService, cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-zcode-svc-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-zcode-sessions-"));
  const host = new PiSessionHost({ sessionDir });
  const service = new PiAgentService({ host });
  try {
    return await run(service, cwd);
  } finally {
    await service.dispose();
    await rm(cwd, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
}

test("hello satisfies the wire schema and matches its own delivery profile", async () => {
  await withService(async (service) => {
    const hello = await service.helloConversationV4();
    const parsed = helloMessageSchema.safeParse(hello);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
    assert.equal(hello.clientMode, "desktop-continuous");
    assert.equal(hello.deliveryProfile, "continuous");
  });
});

test("a client hello is accepted", async () => {
  await withService(async (service) => {
    const clientHello = {
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: "test-client",
      clientKind: "desktop",
      appVersion: "0.0.1",
    };
    const parsed = clientHelloSchema.safeParse(clientHello);
    assert.ok(parsed.success);
    await service.initializeConversationV4(parsed.data);
  });
});

test("subscribe returns a schema-valid ACK", async () => {
  await withService(async (service, cwd) => {
    const created = await service.sendConversationCommandV4({
      sessionId: "ignored",
      // The command name is `envelope.type`; `payload` holds only arguments.
      envelope: { commandId: "cmd-1", type: "createSession", payload: { workspaceId: cwd } },
    });
    const ack = commandAckSchema.safeParse(created);
    assert.ok(ack.success, ack.success ? "" : JSON.stringify(ack.error.issues, null, 2));

    const sessionId =
      created.result?.type === "createSession" ? created.result.sessionId : undefined;
    assert.ok(sessionId, "createSession must report the new session id in result.sessionId");

    const result = await service.subscribeConversationV4({ sessionId: sessionId! });
    const parsed = v4ConversationSubscribeResultSchema.safeParse(result);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
    assert.equal(result.ack.mode, "snapshot");
  });
});

test("subscribing emits a schema-valid opening snapshot wire frame", async () => {
  await withService(async (service, cwd) => {
    const frames: unknown[] = [];
    const created = await service.sendConversationCommandV4({
      sessionId: "ignored",
      // The command name is `envelope.type`; `payload` holds only arguments.
      envelope: { commandId: "cmd-1", type: "createSession", payload: { workspaceId: cwd } },
    });
    const sessionId =
      created.result?.type === "createSession" ? created.result.sessionId : undefined;
    assert.ok(sessionId, "createSession must report result.sessionId");

    // Attach before subscribing so the opening frame is captured.
    service.onDynamicConversationFrame({})((frame) => frames.push(frame));
    await service.subscribeConversationV4({ sessionId: sessionId! });

    assert.ok(frames.length > 0, "subscribe must emit at least one frame");
    for (const wire of frames) {
      // The UI decodes the wire envelope, not the bare frame — a bare frame is
      // rejected as an invalid payload and takes the draft binding with it.
      const parsed = conversationTopicWireFrameSchema.safeParse(wire);
      assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
    }
    const first = frames[0] as {
      kind: string;
      deliveryKind: string;
      frame: { payload: { kind: string; snapshot?: unknown } };
    };
    assert.equal(first.kind, "complete");
    assert.equal(first.deliveryKind, "initial");
    assert.equal(first.frame.payload.kind, "snapshot");
    const snapshot = conversationSnapshotSchema.safeParse(first.frame.payload.snapshot);
    assert.ok(
      snapshot.success,
      snapshot.success ? "" : JSON.stringify(snapshot.error.issues, null, 2),
    );
  });
});

test("an unknown payload type is rejected with a reason code", async () => {
  await withService(async (service, cwd) => {
    const created = await service.sendConversationCommandV4({
      sessionId: "ignored",
      // The command name is `envelope.type`; `payload` holds only arguments.
      envelope: { commandId: "cmd-1", type: "createSession", payload: { workspaceId: cwd } },
    });
    const createdSessionId =
      created.result?.type === "createSession" ? created.result.sessionId : "unknown";
    const result = await service.sendConversationCommandV4({
      sessionId: createdSessionId,
      envelope: { commandId: "cmd-2", type: "rewindFilesEverything", payload: {} },
    });
    const parsed = commandAckSchema.safeParse(result);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
    assert.equal(result.status, "rejected");
    assert.match(result.reasonCode ?? "", /^unsupported:/);
  });
});

test("fork retires the old projection and returns the replacement session id", async () => {
  const host = new ForkHost();
  const service = new PiAgentService({ host });
  try {
    const created = await service.sendConversationCommandV4({
      envelope: { commandId: "create", type: "createSession", payload: { workspaceId: "/workspace" } },
    });
    const oldSessionId =
      created.result?.type === "createSession" ? created.result.sessionId : undefined;
    assert.equal(oldSessionId, "old-session");

    const frames: unknown[] = [];
    service.onDynamicConversationFrame({})((frame) => frames.push(frame));
    const subscription = await service.subscribeConversationV4({ sessionId: oldSessionId! });
    const beforeFork = frames.length;

    const forked = await service.sendConversationCommandV4({
      envelope: {
        commandId: "fork",
        sessionId: oldSessionId,
        type: "forkFromEntry",
        payload: { entryId: "entry-1" },
      },
    });
    assert.equal(forked.status, "accepted");
    assert.deepEqual(forked.result, {
      type: "createSession",
      sessionId: "new-session",
      input: { delivery: "startNow", inputId: "new-session-fork" },
    });
    assert.equal(host.get("old-session"), undefined);
    assert.equal(host.get("new-session")?.sessionId, "new-session");

    host.old.emit({ type: "agent_start" });
    assert.equal(frames.length, beforeFork);

    await service.subscribeConversationV4({ sessionId: "new-session" });
    const afterNewSubscription = frames.length;
    host.next.emit({ type: "agent_start" });
    assert.ok(frames.length > afterNewSubscription);

    await service.unsubscribeConversationV4({ subscriptionId: subscription.ack.subscriptionId });
  } finally {
    await service.dispose();
  }
});

class TestHandle implements RuntimeSessionHandle {
  readonly cwd = "/workspace";
  readonly session: RuntimeSessionHandle["session"];
  private readonly listeners = new Set<(event: PiGSessionEvent) => void>();

  constructor(readonly sessionId: string) {
    this.session = {
      sessionId,
      state: {
        model: { provider: "test", id: "test-model" },
        thinkingLevel: "off",
        messages: [],
        isStreaming: false,
      },
      prompt: async () => {},
      abort: async () => {},
      dispose: () => {},
    };
  }

  subscribe(listener: (event: PiGSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }

  emit(event: PiGSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class ForkHost implements RuntimeSessionHost {
  readonly old = new TestHandle("old-session");
  readonly next = new TestHandle("new-session");
  private readonly handles = new Map<string, RuntimeSessionHandle>([[this.old.sessionId, this.old]]);

  async open(input: { cwd: string; sessionId?: string }): Promise<RuntimeSessionHandle> {
    const sessionId = input.sessionId ?? this.old.sessionId;
    const handle = this.handles.get(sessionId);
    if (!handle) throw new Error(`unknown test session: ${sessionId}`);
    return handle;
  }

  get(sessionId: string): RuntimeSessionHandle | undefined {
    return this.handles.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.handles.has(sessionId);
  }

  cwdOf(sessionId: string): string | undefined {
    return this.handles.get(sessionId)?.cwd;
  }

  list(): string[] {
    return [...this.handles.keys()];
  }

  async fork(handle: RuntimeSessionHandle): Promise<string> {
    assert.equal(handle.sessionId, this.old.sessionId);
    this.handles.delete(this.old.sessionId);
    this.handles.set(this.next.sessionId, this.next);
    return this.next.sessionId;
  }

  close(sessionId: string): void {
    this.handles.delete(sessionId);
  }

  closeAll(): void {
    this.handles.clear();
  }
}
