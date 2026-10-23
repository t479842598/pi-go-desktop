/**
 * Connection probe: isolates each step of the WebSocket handshake so a hang can
 * be attributed to a specific stage instead of "the smoke test never printed".
 */

import { connectViaWebSocket } from "@zcode/client";

const t0 = Date.now();
const step = (message: string) => console.log(`[${Date.now() - t0}ms] ${message}`);

step("start");
const services = await connectViaWebSocket(`ws://127.0.0.1:${process.env.PORT ?? 3099}/ws`);
step("connected");
step(`agent service type: ${typeof services.zcodeAgentService}`);

const hello = await services.zcodeAgentService.helloConversationV4();
step(`hello: ${JSON.stringify(hello).slice(0, 120)}`);

process.exit(0);
