import { readFileSync } from "node:fs";

import {
  type ModelConfigRule,
  type ProviderConfigInput,
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderConfig,
} from "@zcode/provider";

export interface PiModelEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: readonly string[];
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  [key: string]: unknown;
}

export interface PiProviderEntry {
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  name?: string;
  models?: PiModelEntry[];
  [key: string]: unknown;
}

export function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readPiProviders(path: string): Record<string, PiProviderEntry> {
  const doc = readJson(path);
  const providers = doc?.providers;
  if (!providers || typeof providers !== "object") return {};
  const out: Record<string, PiProviderEntry> = {};
  for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
    if (value && typeof value === "object") out[id] = value as PiProviderEntry;
  }
  return out;
}

export function asZCodeApiType(
  value: string | undefined,
): "anthropic-messages" | "openai-chat-completions" | "openai-responses" {
  if (value === "anthropic-messages" || value === "openai-responses") return value;
  return "openai-chat-completions";
}

export function slug(value: string | undefined): string | null {
  const cleaned = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned ? cleaned : null;
}

const DEFAULT_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function modelConfigFromPi(
  model: PiModelEntry,
  enabled: boolean,
): {
  enabled: boolean;
  properties: ModelPropertiesConfig;
  optionSpecs?: ModelOptionSpecsConfig;
} {
  const input = model.input ?? [];
  const levels = model.reasoning
    ? DEFAULT_REASONING_LEVELS.filter(
        (level) => !model.thinkingLevelMap || model.thinkingLevelMap[level] != null,
      )
    : [];
  return {
    enabled,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: model.contextWindow ?? 128000,
      inputFormat: {
        supportsText: true,
        supportsImage: input.includes("image"),
        supportsVideo: input.includes("video"),
        supportsAudio: input.includes("audio"),
        supportsPdf: input.includes("pdf"),
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    ...(levels.length > 0
      ? {
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: { values: levels, map: "{}" },
            ...(model.maxTokens ? { maxOutputTokens: { max: model.maxTokens } } : {}),
          }),
        }
      : {}),
  };
}

export function plainProviderConfig(config: ProviderConfig): ProviderConfigInput {
  const out = {} as Record<string, unknown>;
  if (config.group != null) out.group = config.group;
  if (config.logo != null) out.logo = config.logo;
  if (config.access != null) out.access = config.access;
  if (config.api != null) out.api = config.api;
  if (config.personalModelIds != null) out.personalModelIds = config.personalModelIds;
  if (config.modelOrder != null) out.modelOrder = config.modelOrder;
  if (config.visibility != null) out.visibility = config.visibility;
  return out as ProviderConfigInput;
}

export function plainModelConfig(config: ModelConfig): {
  enabled?: boolean;
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
} {
  const out: ReturnType<typeof plainModelConfig> = {};
  if (config.enabled != null) out.enabled = config.enabled;
  if (config.properties !== undefined) out.properties = config.properties;
  if (config.optionSpecs !== undefined) out.optionSpecs = config.optionSpecs;
  return out;
}

export function isPiPersonalRule(rule: {
  providerId: string;
  templateId?: string | null;
}): boolean {
  return rule.templateId !== "zai-api" && !rule.providerId.startsWith("account:");
}

export function isPiProviderId(id: string): boolean {
  if (id.startsWith("pi-")) return true;
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  return !looksLikeUuid && !id.includes(":");
}

export function toPiInput(
  format:
    | {
        supportsImage?: boolean;
        supportsVideo?: boolean;
        supportsAudio?: boolean;
        supportsPdf?: boolean;
      }
    | null
    | undefined,
): string[] {
  if (!format) return ["text"];
  const out = ["text"];
  if (format.supportsImage) out.push("image");
  if (format.supportsVideo) out.push("video");
  if (format.supportsAudio) out.push("audio");
  if (format.supportsPdf) out.push("pdf");
  return out;
}

export function findModelRuleData(
  models: ModelConfigRules,
  providerId: string,
  modelId: string,
): {
  enabled?: boolean;
  properties?: {
    contextWindow?: number;
    inputFormat?: {
      supportsImage?: boolean;
      supportsVideo?: boolean;
      supportsAudio?: boolean;
      supportsPdf?: boolean;
    } | null;
  } | null;
  optionSpecs?: {
    reasoningLevel?: { values?: readonly string[] } | null;
    maxOutputTokens?: { max?: number } | null;
  } | null;
} {
  for (const rule of models.rules()) {
    if (
      "providerId" in rule &&
      rule.providerId === providerId &&
      "modelId" in rule &&
      rule.modelId === modelId &&
      "config" in rule
    ) {
      return plainModelConfig(rule.config) as never;
    }
  }
  return { enabled: true };
}

export function upsertModelRule(
  rules: readonly ModelConfigRule[],
  providerId: string,
  modelId: string,
  config: ModelConfig,
  type: "provider-model" | "manual-provider-model",
): ModelConfigRule[] {
  const next = rules.filter(
    (rule) =>
      !(
        "providerId" in rule &&
        rule.providerId === providerId &&
        "modelId" in rule &&
        rule.modelId === modelId
      ),
  );
  next.push({ type, providerId, modelId, config } as ModelConfigRule);
  return next;
}
