/**
 * pi-backed service assembly.
 *
 * ZCode's whole UI talks to the host through `ServiceCollection` →
 * `exposeOnChannelServer` → `ProxyChannel.fromService`. That makes the service
 * collection the single injection point: register pi implementations here and
 * the UI needs no changes at all.
 *
 * This module builds that collection. Everything pi cannot serve is left
 * unregistered so a stray call fails with a named "service not registered"
 * error at the call site rather than returning plausible-looking empty data.
 */

import { IZCodeAgentService, ServiceCollection } from "@zcode/services";

import { PiGSessionHost, type RuntimeSessionHost } from "./pig/session-host.js";
import { PiAgentService } from "./v4/pi-agent-service.js";

export interface PiServiceAssemblyOptions {
  /** Live pi sessions shared by every pi-backed service. */
  host?: RuntimeSessionHost;
  sessionDir?: string;
}

export interface PiServiceAssembly {
  collection: ServiceCollection;
  agent: PiAgentService;
  host: RuntimeSessionHost;
  dispose(): Promise<void>;
}

/**
 * Build the pi service collection.
 *
 * Only `zcode-agent` is live today. The remaining channels stay unregistered on
 * purpose: `ServiceCollection.get()` throws for a missing channel, which
 * surfaces the gap at its call site instead of hiding it behind a stub.
 */
export function createPiServices(options: PiServiceAssemblyOptions = {}): PiServiceAssembly {
  const host =
    options.host ??
    new PiGSessionHost({ ...(options.sessionDir ? { sessionRoot: options.sessionDir } : {}) });
  const agent = new PiAgentService({ host });
  const collection = new ServiceCollection();

  // The descriptor's channel name is "zcode-agent"; registration is by name, so
  // the UI's existing `getChannel(IZCodeAgentService.channelName)` resolves to
  // the pi implementation without touching `RemoteServiceAccess`. The cast is
  // the honest boundary: pi serves a subset of the 150-member interface.
  collection.register(IZCodeAgentService, agent as unknown as IZCodeAgentService);

  return {
    collection,
    agent,
    host,
    async dispose() {
      await agent.dispose();
    },
  };
}
