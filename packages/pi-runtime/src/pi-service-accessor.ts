/**
 * `IServiceAccessor` for the pi host.
 *
 * ZCode's UI reads services off one object. Only `zcode-agent` has a pi
 * implementation today; everything else resolves to a stub that throws a named
 * error. That choice is deliberate — a stub returning `[]` looks like "this
 * panel is empty", while a named error says exactly which service is missing.
 *
 * Event members (`onXxx`, `onDynamicXxx`) return a no-op subscription instead of
 * throwing: the UI subscribes to events during mount, and an unhandled rejection
 * there takes the whole tree down. A silent empty stream is the only safe
 * default for a channel that has nothing to say.
 */

import type { IServiceAccessor } from "@zcode/services";

/** Per-instance record of which stubs were touched, for diagnostics. */
export interface PiAccessorDiagnostics {
  readonly touched: Set<string>;
}

export interface PiServiceAccessorOptions {
  /** The real agent service, served over RPC. */
  agent: unknown;
  /** Called whenever a stub member is invoked; used to log missing surfaces. */
  onUnsupported?: (path: string) => void;
}

/** Matches `onXxx` / `onDynamicXxx`, the two event naming conventions. */
function isEventName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.startsWith("onDynamic") && name.length > 9) return true;
  return name.length >= 3 && name.startsWith("on") && name.charCodeAt(2) >= 65 && name.charCodeAt(2) <= 90;
}

/**
 * A service whose every member fails with a name that identifies the gap.
 *
 * Event members return a dangling subscription rather than throwing, because
 * those are called from effects during mount.
 */
function createUnsupportedService<T extends object>(
  serviceName: string,
  onUnsupported: (path: string) => void,
): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      const member = String(property);
      if (member === "then") return undefined;

      const path = `${serviceName}.${member}`;
      if (isEventName(member)) {
        return () => ({ dispose() {} });
      }
      return async () => {
        onUnsupported(path);
        throw new Error(
          `${path} is not implemented by the pi host yet. ` +
            `Service "${serviceName}" has no pi backend.`,
        );
      };
    },
  });
}

/**
 * Build the accessor the UI renders against.
 *
 * `agent` is the only live service. The list of stub names mirrors
 * `IServiceAccessor`; a new field added upstream will show up as `undefined`
 * rather than a stub, which surfaces the gap immediately instead of at first use.
 */
export function createPiServiceAccessor(
  options: PiServiceAccessorOptions,
): { accessor: IServiceAccessor; diagnostics: PiAccessorDiagnostics } {
  const touched = new Set<string>();
  const onUnsupported = (path: string) => {
    touched.add(path);
    options.onUnsupported?.(path);
  };

  const stub = <T extends object>(name: string) => createUnsupportedService<T>(name, onUnsupported);

  const accessor = {
    // ── live ──
    zcodeAgentService: options.agent,

    // ── stubbed: workspace and files ──
    fileService: stub("fileService"),
    fileWatcherService: stub("fileWatcherService"),
    gitService: stub("gitService"),
    gitCheckpointService: stub("gitCheckpointService"),
    systemService: stub("systemService"),
    terminalService: stub("terminalService"),
    projectService: stub("projectService"),
    taskGroupService: stub("taskGroupService"),
    windowControllerService: stub("windowControllerService"),

    // ── stubbed: settings, models, accounts ──
    settingService: stub("settingService"),
    credentialService: stub("credentialService"),
    providerSettingsService: stub("providerSettingsService"),
    modelSelectionService: stub("modelSelectionService"),
    oauthService: stub("oauthService"),
    clientConfigService: stub("clientConfigService"),
    clientScenesService: stub("clientScenesService"),
    settingsSyncService: stub("settingsSyncService"),
    onboardingRecordService: stub("onboardingRecordService"),

    // ── stubbed: conversation side surfaces ──
    zcodeTaskService: stub("zcodeTaskService"),
    zcodeSessionService: stub("zcodeSessionService"),
    conversationShareService: stub("conversationShareService"),
    broadcastService: stub("broadcastService"),
    promptAttachmentTransferService: stub("promptAttachmentTransferService"),
    mediaPreviewService: stub("mediaPreviewService"),

    // ── stubbed: tooling ──
    skillsService: stub("skillsService"),
    skillSyncService: stub("skillSyncService"),
    mcpSyncService: stub("mcpSyncService"),
    pluginSyncService: stub("pluginSyncService"),
    pluginsService: stub("pluginsService"),
    pluginManagementService: stub("pluginManagementService"),
    subagentsService: stub("subagentsService"),
    commandsService: stub("commandsService"),
    hooksService: stub("hooksService"),
    memoryService: stub("memoryService"),
    outputStyleService: stub("outputStyleService"),

    // ── stubbed: observability and commercial surfaces pi has no equivalent for ──
    usageStatsService: stub("usageStatsService"),
    codingPlanSubscriptionService: stub("codingPlanSubscriptionService"),
    offPeakTaskService: stub("offPeakTaskService"),
    highspeedCardService: stub("highspeedCardService"),
    feedbackService: stub("feedbackService"),
    marketingTouchService: stub("marketingTouchService"),
    cloudContentService: stub("cloudContentService"),
    botsService: stub("botsService"),
    selfUpdateService: stub("selfUpdateService"),

    // ── stubbed: host identity ──
    sourceServerWorkspaceService: stub("sourceServerWorkspaceService"),
    sourceServerManagementService: stub("sourceServerManagementService"),
  } as unknown as IServiceAccessor;

  return { accessor, diagnostics: { touched } };
}
