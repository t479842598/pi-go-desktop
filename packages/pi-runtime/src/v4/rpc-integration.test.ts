/**
 * Service registration test.
 *
 * Every other test calls the service object directly. This one checks the
 * wiring the UI actually depends on: that `zcode-agent` resolves through the
 * service collection by its real channel name, so a rename or a wrong
 * registration fails here instead of in the running app.
 *
 * The RPC transport itself (`ChannelServer` ↔ `ChannelClient` ↔
 * `ProxyChannel.toService`) is ZCode's own code and is covered by its own
 * suite; re-testing it here would only test that library, not this wiring.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ServiceChannels } from "@zcode/shared";
import {
  commandAckSchema,
  helloMessageSchema,
  v4ConversationSubscribeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { PiSessionHost } from "../session-host.js";
import { createPiServices } from "../services-assembly.js";

async function withServices<T>(run: (services: ReturnType<typeof createPiServices>, cwd: string) => Promise<T>) {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-zcode-rpc-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-zcode-rpc-cwd-"));
  const host = new PiSessionHost({ sessionDir });
  const services = createPiServices({ host });
  try {
    return await run(services, cwd);
  } finally {
    await services.dispose();
    await rm(sessionDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

test("zcode-agent resolves through the collection by its real channel name", async () => {
  await withServices(async (services, cwd) => {
    const registered = services.collection.get({ channelName: ServiceChannels.ZCodeAgent } as never);
    assert.equal(registered, services.agent);

    const hello = await services.agent.helloConversationV4();
    const parsed = helloMessageSchema.safeParse(hello);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));

    const created = await services.agent.sendConversationCommandV4({
      sessionId: "new",
      envelope: { commandId: "c1", type: "createSession", payload: { workspaceId: cwd } },
    });
    assert.ok(commandAckSchema.safeParse(created).success);

    const createdSessionId =
      created.result?.type === "createSession" ? created.result.sessionId : null;
    assert.ok(createdSessionId, "createSession must report result.sessionId");

    const sub = await services.agent.subscribeConversationV4({ sessionId: createdSessionId! });
    assert.ok(
      v4ConversationSubscribeResultSchema.safeParse(sub).success,
      "subscribe ACK must satisfy the wire schema",
    );
  });
});

test("an unregistered channel throws instead of returning empty data", async () => {
  await withServices(async (services) => {
    assert.throws(() => services.collection.get({ channelName: "coding-plan-subscription" } as never));
  });
});
