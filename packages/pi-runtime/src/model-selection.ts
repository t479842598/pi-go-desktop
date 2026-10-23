/**
 * pi models → ZCode's model-selection view.
 *
 * ZCode's composer disables sending while its model picker is empty, so the
 * first thing the UI needs from a backend is a model list. pi keeps models in
 * its own `ModelRuntime` (providers from models.json plus the built-in
 * catalog), which has a different shape from ZCode's provider registry.
 *
 * This module builds the ZCode view directly from pi's models rather than
 * teaching ZCode's provider registry about pi: the view is the only thing the
 * UI reads, and constructing it here keeps the two registries independent.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Emitter } from "@zcode/rpc";
import type { Event } from "@zcode/rpc";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Thinking levels ZCode knows; a model's own map decides which apply. */
const DEFAULT_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface PiModelSelectionOptions {
  /** Refresh interval for the model list; 0 disables polling. */
  refreshMs?: number;
}

/**
 * A ZCode-shaped model view over pi's `ModelRuntime`.
 *
 * Mirrors `IModelSelectionService`: `getView()` returns the provider tree the
 * picker renders, and `onDidChange` notifies when the runtime's model set
 * changes (a catalog refresh, a new API key).
 */
export class PiModelSelectionService {
  private readonly onChange = new Emitter<unknown>();
  private runtime: ModelRuntime | null = null;
  private revision = 0;

  constructor(private readonly options: PiModelSelectionOptions = {}) {}

  readonly onDidChange: Event<unknown> = this.onChange.event;

  async getView(_input?: unknown): Promise<Record<string, unknown>> {
    const models = await this.availableModels();
    const providers = groupByProvider(models);
    // The composer reads the *selected* model from `effectiveSelection`. Sending
    // only a provider list leaves it at provider:null, and its send gate stays
    // closed even though every model is listed.
    const defaultSelection = firstSelection(models);

    const view = {
      revision: ++this.revision,
      providers,
      effectiveSelection: defaultSelection,
      preferredSelection: defaultSelection ?? undefined,
      ...(defaultSelection ? {} : { selectionIssue: "selection-missing" as const }),
    };
    // The UI's acceptance of a view is otherwise invisible; this states what
    // actually left the service so a mismatch can be seen from the server log.
    console.log(
      `[pi-engine] modelSelectionView rev=${view.revision} providers=${providers.length} ` +
        `effective=${defaultSelection ? `${defaultSelection.providerId}/${defaultSelection.modelId}` : "null"}`,
    );
    return view;
  }

  /** Push a changed view to listeners (called after a catalog refresh). */
  async refresh(): Promise<void> {
    this.runtime = null;
    this.onChange.fire(await this.getView());
  }

  dispose(): void {
    this.onChange.dispose();
  }

  private async availableModels(): Promise<readonly Model<never>[]> {
    if (!this.runtime) this.runtime = await ModelRuntime.create();
    return (await this.runtime.getAvailable()) as readonly Model<never>[];
  }
}

/**
 * Pick the selection the composer should start from.
 *
 * pi's own configured default wins; otherwise the first available model is used.
 * A `null` answer is honest — the caller then reports `selection-missing` rather
 * than pretending a model is selected.
 */
function firstSelection(
  models: readonly Model<never>[],
): { providerId: string; modelId: string } | null {
  if (models.length === 0) return null;
  const preferred = readConfiguredDefault();
  if (preferred) {
    const match = models.find((model) => {
      const provider = String((model as unknown as { provider?: unknown }).provider ?? "");
      return provider === preferred.providerId && idOf(model) === preferred.modelId;
    });
    if (match) return preferred;
  }
  const first = models[0]!;
  return {
    providerId: String((first as unknown as { provider?: unknown }).provider ?? ""),
    modelId: idOf(first),
  };
}

/**
 * pi's configured default model, as `provider/modelId`.
 *
 * Read synchronously on purpose: the view is built during render, and an async
 * read there would leave the first view without a selection and re-open the
 * gate that this function exists to close.
 */
function readConfiguredDefault(): { providerId: string; modelId: string } | null {
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as { defaultProvider?: unknown; defaultModel?: unknown };
    if (typeof settings.defaultModel !== "string" || !settings.defaultModel.trim()) return null;

    const model = settings.defaultModel.trim();
    // pi writes `defaultModel` already prefixed with the provider, so the id is
    // whatever follows the first slash. Splitting on the last slash instead
    // produced a provider of "Sub付费" for a nested id, which no provider has.
    const separator = model.indexOf("/");
    if (separator > 0) {
      return { providerId: model.slice(0, separator), modelId: model.slice(separator + 1) };
    }
    if (typeof settings.defaultProvider === "string" && settings.defaultProvider.trim()) {
      return { providerId: settings.defaultProvider.trim(), modelId: model };
    }
    return null;
  } catch {
    return null;
  }
}
/**
 * Group pi models into ZCode's provider entries.
 *
 * `builtinModelIds` / `personalModelIds` are the only required config fields;
 * pi has no such split, so every model goes in `personalModelIds` (the list the
 * picker shows) and `modelOrder` fixes the display order.
 */
function groupByProvider(models: readonly Model<never>[]): unknown[] {
  const byProvider = new Map<string, Model<never>[]>();
  for (const model of models) {
    const provider = String((model as unknown as { provider?: unknown }).provider ?? "unknown");
    const list = byProvider.get(provider);
    if (list) list.push(model);
    else byProvider.set(provider, [model]);
  }

  return [...byProvider.entries()].map(([providerId, providerModels]) => {
    const modelIds = providerModels.map((model) => String(idOf(model)));
    return {
      providerId,
      // `providerName` is a plain id string, not a localized map.
      providerName: providerId,
      templateId: "pi",
      config: {
        builtinModelIds: [],
        personalModelIds: modelIds,
        modelOrder: modelIds,
      },
      models: providerModels.map((model) => ({
        modelId: idOf(model),
        config: {
          enabled: true,
          properties: {
            requiresMfjsToolSchema: false,
            contextWindow: contextWindowOf(model),
            inputFormat: {
              supportsText: true,
              supportsImage: supportsImages(model),
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
            outputFormat: { supportsText: true, supportsImage: false },
            supportsToolCall: true,
            supportsJsonSchemaOutput: false,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          },
          optionSpecs: {
            // `map` is a compiled CEL expression source, not an object. An empty
            // expression fails validation and makes the UI discard the whole
            // view, which is why the picker fell back to "manage models".
            reasoningLevel: { values: reasoningLevelsOf(model), map: "{}" },
            maxOutputTokens: { max: maxOutputTokensOf(model), map: "{}" },
          },
        },
      })),
    };
  });
}

function idOf(model: Model<never>): string {
  const record = model as unknown as { id?: unknown; modelId?: unknown };
  return String(record.id ?? record.modelId ?? "");
}

function contextWindowOf(model: Model<never>): number {
  const value = (model as unknown as { contextWindow?: unknown }).contextWindow;
  return typeof value === "number" && value > 0 ? Math.floor(value) : 128_000;
}

function maxOutputTokensOf(model: Model<never>): number {
  const record = model as unknown as { maxOutputTokens?: unknown; outputLimits?: { max?: unknown } };
  const direct = record.maxOutputTokens ?? record.outputLimits?.max;
  if (typeof direct === "number" && direct > 0) return Math.floor(direct);
  return Math.min(contextWindowOf(model), 32_768);
}

function supportsImages(model: Model<never>): boolean {
  const input = (model as unknown as { input?: unknown }).input;
  if (Array.isArray(input)) return input.includes("image");
  return input === "text+image" || input === "image";
}

/**
 * Which thinking levels this model accepts.
 *
 * `off` is always offered so a user can disable reasoning; the rest come from
 * the model's own map when it declares one.
 */
function reasoningLevelsOf(model: Model<never>): string[] {
  const map = (model as unknown as { thinkingLevelMap?: unknown }).thinkingLevelMap;
  if (map && typeof map === "object") {
    const keys = Object.keys(map as Record<string, unknown>);
    if (keys.length > 0) {
      const levels = new Set(["off", ...keys]);
      return DEFAULT_REASONING_LEVELS.filter((level) => levels.has(level));
    }
  }
  const reasoning = (model as unknown as { reasoning?: unknown }).reasoning;
  return reasoning === false ? ["off"] : DEFAULT_REASONING_LEVELS;
}
