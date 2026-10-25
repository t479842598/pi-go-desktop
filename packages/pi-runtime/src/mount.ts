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
import { IOAuthService } from "@zcode/services";
import { IPluginManagementService } from "@zcode/services";
import { IProviderSettingsService } from "@zcode/services";
import { ISkillsService } from "@zcode/services";
import { IProjectService } from "@zcode/services";
import { ITaskGroupService } from "@zcode/services";

import {
  PiGSessionHost,
  PiOAuthService,
  PiPluginManagementService,
  PiProviderSettingsService,
  PiSkillsService,
} from "./pig/index.js";
import { PiAgentService } from "./v4/pi-agent-service.js";
import { PiModelSelectionService } from "./model-selection.js";
import { PiSessionService } from "./session-service.js";
import { PiProjectService } from "./project-service.js";
import { PiTaskGroupService } from "./task-group-service.js";
import { withServiceFallbacks } from "./service-fallbacks.js";

export interface PiMountedServices {
  host: PiGSessionHost;
  agent: PiAgentService;
  /** Pro 编辑器背后的 provider 配置服务；start() 启动 pi 双向同步。 */
  providerSettings: PiProviderSettingsService;
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
  const host = new PiGSessionHost();
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

  // PI has no account system: reporting an always-authenticated local session
  // keeps the UI off ZCode's login/welcome screen.
  services.register(
    IOAuthService,
    withServiceFallbacks(new PiOAuthService(), "oauthService") as unknown as IOAuthService,
  );

  // Skills read/write pi's SKILL.md roots with the same disable-model-invocation
  // toggle pi-web uses, so the settings panel operates on real pi data.
  services.register(
    ISkillsService,
    withServiceFallbacks(new PiSkillsService(), "skillsService") as unknown as ISkillsService,
  );

  // 插件面板 → PiG 本地扩展（<pig-agent>/extensions，启停=目录改名）。
  services.register(
    IPluginManagementService,
    withServiceFallbacks(
      new PiPluginManagementService(),
      "pluginManagementService",
    ) as unknown as IPluginManagementService,
  );

  // ZCode 的 Pro 编辑器（providerSettingsService 通道）直接吃 pi 数据：编辑落在
  // 共用的个人层 provider_config.json，PiProviderSettingsService 负责与
  // <pig-agent>/models.json 双向同步，编辑完成后刷新 model-selection 视图。
  const providerSettings = new PiProviderSettingsService({
    onModelSelectionRefresh: () => void models.refresh(),
  });
  services.register(
    IProviderSettingsService,
    withServiceFallbacks(
      providerSettings,
      "providerSettingsService",
    ) as unknown as IProviderSettingsService,
  );

  return { host, agent, providerSettings };
}
