/**
 * Mount every pi-backed service into an existing `ServiceCollection`.
 *
 * This is the one entry point both hosts call: the web server and the Electron
 * host process. The host cannot mount inside `createLocalServices` because that
 * factory is synchronous, and importing pi there would pull its Node builtins
 * into the ESM main bundle ("Dynamic require of child_process" on every launch).
 *
 * Registration is by channel name, so each call replaces the ZCode implementation
 * in place and leaves every other service alone.
 */

import { ServiceCollection } from "@zcode/services";
import { IZCodeAgentService } from "@zcode/services";
import { IZCodeSessionService } from "@zcode/services";
import { IModelSelectionService } from "@zcode/services";
import { IProjectService } from "@zcode/services";
import { ITaskGroupService } from "@zcode/services";

import { PiSessionHost } from "./session-host.js";
import { PiAgentService } from "./v4/pi-agent-service.js";
import { PiModelSelectionService } from "./model-selection.js";
import { PiSessionService } from "./session-service.js";
import { PiProjectService } from "./project-service.js";
import { PiTaskGroupService } from "./task-group-service.js";
import { withServiceFallbacks } from "./service-fallbacks.js";

export interface PiMountedServices {
  host: PiSessionHost;
  agent: PiAgentService;
}

/**
 * Replace the five conversation-adjacent channels with pi implementations.
 *
 * Each `withServiceFallbacks` wrapper is load-bearing: `ProxyChannel.fromService`
 * throws for a member that does not exist, and that throw escapes the channel
 * server and takes the whole process down. pi implements a subset of every one of
 * these interfaces, so the fallback answers the rest.
 */
export function mountPiServices(services: ServiceCollection): PiMountedServices {
  const host = new PiSessionHost();
  const agent = new PiAgentService({ host });

  services.register(
    IZCodeAgentService,
    withServiceFallbacks(agent) as unknown as IZCodeAgentService,
  );

  const models = new PiModelSelectionService();
  services.register(
    IModelSelectionService,
    withServiceFallbacks(models, "modelSelectionService") as unknown as IModelSelectionService,
  );

  const session = new PiSessionService();
  services.register(
    IZCodeSessionService,
    withServiceFallbacks(session, "zcodeSessionService") as unknown as IZCodeSessionService,
  );

  const projects = new PiProjectService();
  services.register(
    IProjectService,
    withServiceFallbacks(projects, "projectService") as unknown as IProjectService,
  );

  const taskGroups = new PiTaskGroupService();
  services.register(
    ITaskGroupService,
    withServiceFallbacks(taskGroups, "taskGroupService") as unknown as ITaskGroupService,
  );

  return { host, agent };
}
