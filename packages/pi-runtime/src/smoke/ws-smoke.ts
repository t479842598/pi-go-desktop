/**
 * Live smoke test against a running ZCode server.
 *
 * Connects over the same WebSocket + `@zcode/rpc` channel protocol the real UI
 * uses, then drives the pi engine through the UI's actual call sequence:
 * hello → createSession → subscribe → sendText → watch frames.
 *
 * Run it against a server started under PI_ENGINE=pi:
 *
 *   PI_ENGINE=pi PORT=3099 tsx packages/server/src/entry-http.ts
 *   SMOKE_TEXT="say hi" tsx packages/pi-runtime/src/smoke/ws-smoke.ts
 *
 * Uses `@zcode/client`'s browser wrapper for the socket so the framing code
 * under test is exactly what ships, not a re-implementation.
 */

import { connectViaWebSocket } from "@zcode/client";
import {
  commandAckSchema,
  helloMessageSchema,
  v4ConversationSubscribeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";

const port = Number(process.env.PORT ?? 3099);
const cwd = process.env.SMOKE_CWD ?? "/tmp";
/** Must match the `clientId` in the clientHello: the connection scope binds it. */
const clientId = "pi-zcode-smoke";

interface FrameLike {
  payload: { kind: string; snapshot?: { rows?: { window?: unknown[] } } };
}

function log(step: string, detail?: unknown): void {
  // Written before the process can hang, so a stall is attributable.
  process.stderr.write(
    (detail === undefined ? `• ${step}` : `• ${step}: ${JSON.stringify(detail)}`) + "\n",
  );
}

/** Reject instead of hanging forever when a step never settles. */
function withTimeout<T>(promise: Promise<T>, label: string, ms = 20_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

async function main(): Promise<void> {
  // `connectViaWebSocket` expects a browser WebSocket; Node's global one works
  // because the wrapper only uses addEventListener/send/close/readyState.
  const services = await withTimeout(
    connectViaWebSocket(`ws://127.0.0.1:${port}/ws`),
    "connect",
  );
  log("connected", `ws://127.0.0.1:${port}`);

  const agent = services.zcodeAgentService;
  if (!agent) throw new Error("zcode-agent channel missing from the accessor");

  const hello = await withTimeout(agent.helloConversationV4(), "hello");
  const helloParsed = helloMessageSchema.safeParse(hello);
  log("hello", helloParsed.success ? `schema OK (${hello.clientMode})` : helloParsed.error.issues);
  if (!helloParsed.success) throw new Error("hello failed schema validation");

  // The server wraps `zcode-agent` in a connection scope that refuses every
  // command until the client answers hello. Skipping this is what
  // `fault.connection.handshakeRequired` means.
  await withTimeout(
    agent.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: hello.protocolVersion,
      clientId,
      clientKind: "desktop",
      appVersion: "0.0.0",
    } as never),
    "initialize",
  );
  log("initialize", "handshake complete");

  // Attach before creating the session so the opening snapshot is not missed.
  const frames: FrameLike[] = [];
  const subscription = agent.onDynamicConversationFrame({} as never)((frame) => {
    frames.push(frame as FrameLike);
  });

  const created = await withTimeout(
    agent.sendConversationCommandV4({
      sessionId: "new",
      envelope: {
        commandId: "smoke-create",
        clientId,
        payload: { type: "createSession", workspaceId: cwd } as never,
      },
    }),
    "createSession",
  );
  const createAck = commandAckSchema.safeParse(created);
  if (!createAck.success) throw new Error(`createSession schema: ${JSON.stringify(created)}`);
  log("createSession", createAck.data.status);
  if (createAck.data.status !== "accepted") throw new Error("createSession rejected");
  const sessionId = createAck.data.message;
  if (!sessionId) throw new Error("createSession returned no session id");
  log("sessionId", sessionId);

  const sub = await withTimeout(agent.subscribeConversationV4({ sessionId }), "subscribe");
  const subAck = v4ConversationSubscribeResultSchema.safeParse(sub);
  if (!subAck.success) throw new Error(`subscribe schema: ${JSON.stringify(sub)}`);
  log("subscribe", subAck.data.ack);

  await new Promise((resolve) => setTimeout(resolve, 600));
  log("frames received", frames.length);
  log("frame kinds", frames.map((frame) => frame.payload.kind));

  const text = process.env.SMOKE_TEXT;
  if (text) {
    log("sending prompt", text);
    const sent = await withTimeout(
      agent.sendConversationCommandV4({
        sessionId,
        envelope: {
          commandId: "smoke-send",
          clientId,
          payload: { type: "sendText", text } as never,
        },
      }),
      "sendText",
    );
    const sendAck = commandAckSchema.safeParse(sent);
    log("sendText", sendAck.success ? sendAck.data.status : sent);

    const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
    let lastCount = frames.length;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (frames.length !== lastCount) {
        log("frames", `${frames.length} (+${frames.length - lastCount})`);
        lastCount = frames.length;
      }
      const streaming = frames.some((frame) => frame.payload.kind === "deltas");
      const settled = frames.some(
        (frame) => (frame.payload.snapshot?.rows?.window?.length ?? 0) > 1,
      );
      if (streaming && settled) break;
    }
    log("streaming observed", frames.some((frame) => frame.payload.kind === "deltas"));
    log("final frame count", frames.length);
  }

  subscription.dispose();
  services.dispose?.();
  console.log("\nsmoke test complete");
}

main().catch((error) => {
  console.error("smoke test failed:", error);
  process.exit(1);
});
