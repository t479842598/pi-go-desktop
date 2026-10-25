/**
 * PiG-backed provider settings — ZCode 的 Pro 编辑器直接吃 PiG 数据。
 *
 * 数据层复用 ZCode 自己的 `NodePersonalProviderConfigRepository`；本文件只负责
 * 同步生命周期和 IProviderSettingsService 的公开方法，字段映射集中在同目录的
 * `provider-config-mapping.ts`，避免同步边界与纯投影逻辑互相膨胀。
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ProviderConfigInput,
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ModelConfigObject,
  type ProviderConfigLayerSnapshot,
  type ProviderSettingsView,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { Emitter, type Event } from "@zcode/rpc";
import type { ModelConnectivityResult } from "@zcode/shared";
import { IProviderSettingsService } from "@zcode/services";
import { getAppConfigDir, getPiGAgentDir } from "@zcode/services/node";

import {
  asZCodeApiType,
  findModelRuleData,
  isPiPersonalRule,
  isPiProviderId,
  modelConfigFromPi,
  plainModelConfig,
  plainProviderConfig,
  readJson,
  readPiProviders,
  slug,
  toPiInput,
  upsertModelRule,
  type PiModelEntry,
  type PiProviderEntry,
} from "./provider-config-mapping.js";
import { withServiceFallbacks } from "../../service-fallbacks.js";

/** 与 services 侧 ProviderSettingsConnectivityRequest 同形；shared 未导出该类型。 */
interface ProviderSettingsConnectivityRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: string;
  readonly modelId: string;
}

const PI_MODELS_PATH = join(getPiGAgentDir(), "models.json");
const PI_AUTH_PATH = join(getPiGAgentDir(), "auth.json");
const PERSONAL_PROVIDER_FILE = join(getAppConfigDir(), "provider_config.json");

/** ZCode 编辑器"新建 Provider"的模板：OpenAI 兼容空壳。 */
const PI_TEMPLATE_ID = "pi-custom";

export class PiProviderSettingsService {
  private readonly onChange = new Emitter<ProviderSettingsView>();
  private readonly repository: NodePersonalProviderConfigRepository;
  private revision = 0;
  /** 从 pi 导入过（或本会话经编辑器新建）的 provider id——回写 models.json 的白名单。 */
  private readonly exportableProviderIds = new Set<string>();
  /** 经编辑器显式删除、需要从 models.json 一并移除的 provider id。 */
  private readonly deletedProviderIds = new Set<string>();
  private lastImportFingerprint: string | null = null;
  private lastExportFingerprint: string | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private onModelSelectionRefresh?: () => void;

  readonly onDidChange: Event<ProviderSettingsView> = this.onChange.event;

  constructor(options: { onModelSelectionRefresh?: () => void } = {}) {
    this.onModelSelectionRefresh = options.onModelSelectionRefresh;
    this.repository = new NodePersonalProviderConfigRepository({
      filePath: PERSONAL_PROVIDER_FILE,
      pollingIntervalMs: 1_000,
    });
  }

  /** 启动导入 + 编辑器变更回写 pi 的轮询。 */
  async start(): Promise<void> {
    await this.importFromPi();
    this.lastExportFingerprint = await this.exportToPi();
    this.syncTimer = setInterval(() => {
      void this.exportTick();
    }, 2_000);
  }

  dispose(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.onChange.dispose();
  }

  /**
   * pi models.json → 个人层规则。只补缺失的 provider；已在个人层的条目以编辑器
   * 为准（回写路径负责把编辑结果送回 models.json）。
   */
  private async importFromPi(): Promise<void> {
    const providers = readPiProviders(PI_MODELS_PATH);
    if (Object.keys(providers).length === 0) return;
    const snapshot = await this.repository.read();
    for (const id of Object.keys(providers)) this.exportableProviderIds.add(id);
    const known = new Set(snapshot.providers.rules().map((rule) => rule.providerId));
    const missing = Object.keys(providers).filter((id) => !known.has(id));
    if (missing.length === 0) return;
    await this.repository.update((current) => {
      const rules = [...current.providers.rules()];
      const modelRules = [...current.models.rules()];
      for (const id of missing) {
        const provider = providers[id]!;
        const modelIds = (provider.models ?? []).map((model) => model.id);
        rules.push({
          providerId: id,
          providerName: provider.name ?? id,
          enabled: true,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ type: "api-key" }),
            api: new ProviderApiConfig({
              type: asZCodeApiType(provider.api),
              baseUrl: provider.baseUrl ?? "",
            }),
            personalModelIds: modelIds,
            modelOrder: modelIds,
          }),
        });
        for (const model of provider.models ?? []) {
          modelRules.push({
            type: "provider-model",
            providerId: id,
            modelId: model.id,
            config: new ModelConfig(modelConfigFromPi(model, true)),
          });
        }
      }
      return {
        providers: new ProviderConfigMap(rules),
        models: new ModelConfigRules(modelRules),
      };
    });
  }

  /**
   * 个人层规则 → pi models.json。编辑器每次落盘后指纹变化即触发；顺序取
   * providerOrder，模型级 pi 字段从导入时建立的规则里合并保留。
   */
  private async exportToPi(): Promise<string | null> {
    let snapshot: ProviderConfigLayerSnapshot;
    try {
      snapshot = await this.repository.read();
    } catch {
      return null;
    }
    const allRules = snapshot.providers.rules();
    const fingerprint = JSON.stringify(
      allRules
        .filter((rule) => isPiPersonalRule(rule))
        .map((rule) => [
          rule.providerId,
          rule.providerName,
          rule.enabled,
          plainProviderConfig(rule.config),
        ]),
    );
    if (fingerprint === this.lastExportFingerprint) return this.lastExportFingerprint;
    this.lastExportFingerprint = fingerprint;

    // 合并语义：以 models.json 现有内容为基底，只更新白名单内条目、移除显式
    // 删除的条目，其余（白名单外、编辑器未触达的）原样保留。绝不能整个重建
    // providers 对象——overlay 为空或快照滞后时那会把用户的全部 provider 清掉。
    const doc = readJson(PI_MODELS_PATH) ?? { providers: {} };
    const nextProviders: Record<string, PiProviderEntry> = {
      ...((doc.providers ?? {}) as Record<string, PiProviderEntry>),
    };
    for (const id of this.deletedProviderIds) delete nextProviders[id];
    const order = snapshot.providerOrder ?? allRules.map((rule) => rule.providerId);
    const byId = new Map(allRules.map((rule) => [rule.providerId, rule]));
    for (const id of order) {
      const rule = byId.get(id);
      if (!rule || !isPiPersonalRule(rule)) continue;
      // 白名单外的一律不回写：models.json 只接受 pi 命名空间的 provider。
      if (!this.exportableProviderIds.has(id) || !isPiProviderId(id)) continue;
      const existing = nextProviders[id];
      const modelIds = rule.config.modelOrder ?? rule.config.personalModelIds ?? [];
      const models: PiModelEntry[] = modelIds.map((modelId) => {
        const ruleModel = findModelRuleData(snapshot.models, id, modelId);
        const prior = (existing?.models ?? []).find((model) => model.id === modelId);
        // 从规则投影 pi 原生字段：规则是权威，pi 特有字段（compat /
        // thinkingLevelMap 等）从旧条目保留；ZCode 的 enabled/properties/
        // optionSpecs 形状绝不落进 pi 的 models.json。
        const piFields: Record<string, unknown> = {};
        const contextWindow = ruleModel.properties?.contextWindow ?? prior?.contextWindow;
        if (contextWindow != null) piFields.contextWindow = contextWindow;
        const input = ruleModel.properties?.inputFormat
          ? toPiInput(ruleModel.properties.inputFormat)
          : prior?.input;
        if (input) piFields.input = input;
        const hasSpecs =
          ruleModel.optionSpecs?.reasoningLevel != null ||
          ruleModel.optionSpecs?.maxOutputTokens != null;
        if (hasSpecs) {
          piFields.reasoning = (ruleModel.optionSpecs?.reasoningLevel?.values?.length ?? 0) > 0;
          const maxTokens = ruleModel.optionSpecs?.maxOutputTokens?.max ?? prior?.maxTokens;
          if (maxTokens != null) piFields.maxTokens = maxTokens;
        } else if (prior?.reasoning != null) {
          piFields.reasoning = prior.reasoning;
        }
        if (ruleModel.enabled === false) piFields.enabled = false;
        return { ...(prior ?? {}), ...piFields, id: modelId };
      });
      const apiKey = (rule.config.access as { apiKey?: string } | null | undefined)?.apiKey;
      nextProviders[id] = {
        ...(existing ?? {}),
        api: rule.config.api?.type ?? existing?.api ?? "openai-chat-completions",
        baseUrl: rule.config.api?.baseUrl ?? existing?.baseUrl ?? "",
        ...(apiKey ? { apiKey } : {}),
        name: rule.providerName ?? existing?.name,
        models,
      };
    }
    doc.providers = nextProviders;
    try {
      writeFileSync(PI_MODELS_PATH, `${JSON.stringify(doc, null, 2)}\n`);
    } catch {
      return fingerprint;
    }
    this.onModelSelectionRefresh?.();
    return fingerprint;
  }

  private async exportTick(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      await this.exportToPi();
    } finally {
      this.syncing = false;
    }
  }

  private async buildView(): Promise<ProviderSettingsView> {
    const snapshot = await this.repository.read();
    for (const rule of snapshot.providers.rules()) {
      // 只认 pi 命名空间（导入原样 id 或编辑器 pi- 前缀）；UUID 形态的杂项规则
      // 永不回写 models.json——那是同步事故的入口。
      if (isPiProviderId(rule.providerId)) this.exportableProviderIds.add(rule.providerId);
    }
    const auth = readJson(PI_AUTH_PATH) ?? {};
    this.revision += 1;
    const providers = snapshot.providers.rules().map((rule) => {
      const enabled = rule.enabled ?? true;
      const modelIds = rule.config.modelOrder ?? rule.config.personalModelIds ?? [];
      return {
        providerId: rule.providerId,
        providerName: rule.providerName ?? rule.providerId,
        templateId: rule.templateId ?? PI_TEMPLATE_ID,
        enabled,
        accountState: {
          availability: (auth[rule.providerId] ||
          (rule.config.access as { apiKey?: string } | null | undefined)?.apiKey
            ? "available"
            : "unknown") as "available" | "unknown",
          entitled: true,
        },
        executable: true,
        personalConfig: rule.config,
        effectiveConfig: rule.config,
        issues: [],
        models: modelIds.map((modelId) => {
          const modelConfig = findModelRuleData(snapshot.models, rule.providerId, modelId);
          return {
            kind: "candidate" as const,
            modelId,
            builtin: false,
            effectiveBuiltinConfig: modelConfig,
            effectiveConfig: modelConfig,
            enabled: modelConfig.enabled ?? true,
            executable: true,
            selectable: true,
            issues: [],
          };
        }),
      };
    });
    const order = snapshot.providerOrder ?? providers.map((provider) => provider.providerId);
    return {
      revision: this.revision,
      providerTemplates: [
        {
          templateId: PI_TEMPLATE_ID,
          templateNameMap: { "zh-CN": "PI 自定义 Provider", "en-US": "PI Custom Provider" },
          config: new ProviderConfig({
            access: new ApiKeyAccessConfig({ type: "api-key" }),
            api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: "" }),
          }),
        },
      ],
      providerOrder: order,
      providers,
    };
  }

  private async mutate(
    transform: (current: ProviderConfigLayerSnapshot) => {
      providers: ProviderConfigMap;
      models: ModelConfigRules;
      providerOrder?: readonly string[];
    },
  ): Promise<ProviderSettingsView> {
    await this.repository.update((current) => transform(current));
    const view = await this.buildView();
    this.onChange.fire(view);
    // 立刻回写 pi，不等 2s 轮询；指纹相同则 no-op。
    await this.exportToPi();
    return view;
  }

  // ── IProviderSettingsService ────────────────────────────────────────────

  async getView(): Promise<ProviderSettingsView> {
    return this.buildView();
  }

  async refresh(_reason: string): Promise<ProviderSettingsView> {
    await this.importFromPi();
    const view = await this.buildView();
    this.onChange.fire(view);
    return view;
  }

  async createPersonalProvider(
    input?: { providerName?: string; baseUrl?: string } & Record<string, unknown>,
  ): Promise<{ providerId: string; view: ProviderSettingsView }> {
    const base = slug(input?.providerName) || `provider-${randomUUID().slice(0, 6)}`;
    const providerId = `pi-${base}`;
    this.exportableProviderIds.add(providerId);
    const view = await this.mutate((current) => {
      const rules = [...current.providers.rules()];
      rules.push({
        providerId,
        templateId: PI_TEMPLATE_ID,
        providerName: input?.providerName ?? providerId,
        enabled: true,
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ type: "api-key" }),
          api: new ProviderApiConfig({
            type: "openai-chat-completions",
            baseUrl: input?.baseUrl ?? "",
          }),
          personalModelIds: [],
          modelOrder: [],
        }),
      });
      return {
        providers: new ProviderConfigMap(rules),
        models: current.models,
        providerOrder: [
          ...(current.providerOrder ?? current.providers.rules().map((rule) => rule.providerId)),
          providerId,
        ],
      };
    });
    return { providerId, view };
  }

  async resolveModelConfig(input: { providerId: string; modelId: string }): Promise<{
    inheritedConfig: ModelConfigObject;
    effectiveConfig: ModelConfigObject;
    issues: [];
  }> {
    const snapshot = await this.repository.read();
    const config = findModelRuleData(snapshot.models, input.providerId, input.modelId);
    return { inheritedConfig: config, effectiveConfig: config, issues: [] };
  }

  async savePersonalProviderOverlay(
    providerId: string,
    config: ProviderConfigInput,
  ): Promise<ProviderSettingsView> {
    return this.mutate((current) => {
      const rules = current.providers.rules().map((rule) => {
        if (rule.providerId !== providerId) return rule;
        const prior = plainProviderConfig(rule.config);
        return {
          ...rule,
          config: new ProviderConfig({
            ...prior,
            logo: config.logo ?? prior.logo,
            access:
              config.access === undefined
                ? prior.access
                : config.access instanceof ApiKeyAccessConfig
                  ? config.access
                  : new ApiKeyAccessConfig(config.access as never),
            api:
              config.api === undefined
                ? prior.api
                : config.api instanceof ProviderApiConfig
                  ? config.api
                  : new ProviderApiConfig(config.api as never),
            visibility: config.visibility ?? prior.visibility,
          }),
        };
      });
      return { providers: new ProviderConfigMap(rules), models: current.models };
    });
  }

  async deletePersonalProvider(providerId: string): Promise<ProviderSettingsView> {
    this.deletedProviderIds.add(providerId);
    this.exportableProviderIds.delete(providerId);
    return this.mutate((current) => {
      const rules = current.providers.rules().filter((rule) => rule.providerId !== providerId);
      const modelRules = current.models
        .rules()
        .filter((rule) => !("providerId" in rule) || rule.providerId !== providerId);
      return {
        providers: new ProviderConfigMap(rules),
        models: new ModelConfigRules(modelRules),
        providerOrder: (current.providerOrder ?? []).filter((id) => id !== providerId),
      };
    });
  }

  async reorderPersonalProviders(providerIds: readonly string[]): Promise<ProviderSettingsView> {
    return this.mutate((current) => ({
      providers: current.providers,
      models: current.models,
      providerOrder: [...providerIds],
    }));
  }

  async reorderPersonalModels(
    providerId: string,
    modelIds: readonly string[],
  ): Promise<ProviderSettingsView> {
    return this.mutate((current) => {
      const rules = current.providers.rules().map((rule) => {
        if (rule.providerId !== providerId) return rule;
        return {
          ...rule,
          config: new ProviderConfig({
            ...plainProviderConfig(rule.config),
            personalModelIds: [...modelIds],
            modelOrder: [...modelIds],
          }),
        };
      });
      return { providers: new ProviderConfigMap(rules), models: current.models };
    });
  }

  async addPersonalModel(
    providerId: string,
    modelId: string,
    config: ModelConfigObject,
  ): Promise<ProviderSettingsView> {
    return this.mutate((current) => {
      const rules = current.providers.rules().map((rule) => {
        if (rule.providerId !== providerId) return rule;
        const ids = [...(rule.config.personalModelIds ?? [])];
        if (!ids.includes(modelId)) ids.push(modelId);
        return {
          ...rule,
          config: new ProviderConfig({
            ...plainProviderConfig(rule.config),
            personalModelIds: ids,
            modelOrder: [...(rule.config.modelOrder ?? ids)],
          }),
        };
      });
      const modelRules = upsertModelRule(
        current.models.rules(),
        providerId,
        modelId,
        new ModelConfig({
          ...(config.enabled != null ? { enabled: config.enabled } : {}),
          ...(config.properties
            ? { properties: new ModelPropertiesConfig(config.properties as never) }
            : {}),
          ...(config.optionSpecs
            ? { optionSpecs: new ModelOptionSpecsConfig(config.optionSpecs as never) }
            : {}),
        }),
        "provider-model",
      );
      return { providers: new ProviderConfigMap(rules), models: new ModelConfigRules(modelRules) };
    });
  }

  async renamePersonalModel(
    providerId: string,
    currentModelId: string,
    nextModelId: string,
  ): Promise<ProviderSettingsView> {
    return this.mutate((current) => {
      const rules = current.providers.rules().map((rule) => {
        if (rule.providerId !== providerId) return rule;
        const rename = (ids: readonly string[] | null | undefined) =>
          ids?.map((id) => (id === currentModelId ? nextModelId : id)) ?? undefined;
        return {
          ...rule,
          config: new ProviderConfig({
            ...plainProviderConfig(rule.config),
            personalModelIds: rename(rule.config.personalModelIds),
            modelOrder: rename(rule.config.modelOrder),
          }),
        };
      });
      const modelRules = current.models.rules().map((rule) => {
        if (
          "providerId" in rule &&
          rule.providerId === providerId &&
          "modelId" in rule &&
          rule.modelId === currentModelId
        ) {
          return { ...rule, modelId: nextModelId };
        }
        return rule;
      });
      return { providers: new ProviderConfigMap(rules), models: new ModelConfigRules(modelRules) };
    });
  }

  async deletePersonalModel(providerId: string, modelId: string): Promise<ProviderSettingsView> {
    return this.mutate((current) => {
      const rules = current.providers.rules().map((rule) => {
        if (rule.providerId !== providerId) return rule;
        const drop = (ids: readonly string[] | null | undefined) =>
          ids?.filter((id) => id !== modelId) ?? undefined;
        return {
          ...rule,
          config: new ProviderConfig({
            ...plainProviderConfig(rule.config),
            personalModelIds: drop(rule.config.personalModelIds),
            modelOrder: drop(rule.config.modelOrder),
          }),
        };
      });
      const modelRules = current.models
        .rules()
        .filter(
          (rule) =>
            !("providerId" in rule) || rule.providerId !== providerId || rule.modelId !== modelId,
        );
      return { providers: new ProviderConfigMap(rules), models: new ModelConfigRules(modelRules) };
    });
  }

  async savePersonalModelDraft(input: {
    providerId: string;
    originalModelId: string;
    nextModelId: string;
    personalConfig: ModelConfigObject;
  }): Promise<ProviderSettingsView> {
    return this.mutate((current) => {
      const rules = current.providers.rules().map((rule) => {
        if (rule.providerId !== input.providerId) return rule;
        const ids = [...(rule.config.personalModelIds ?? [])];
        const order = [...(rule.config.modelOrder ?? ids)];
        const replace = (list: string[]) =>
          list.map((id) => (id === input.originalModelId ? input.nextModelId : id));
        const renamedIds = replace(ids);
        if (!renamedIds.includes(input.nextModelId)) renamedIds.push(input.nextModelId);
        return {
          ...rule,
          config: new ProviderConfig({
            ...plainProviderConfig(rule.config),
            personalModelIds: renamedIds,
            modelOrder: replace(order).includes(input.nextModelId)
              ? replace(order)
              : [...replace(order), input.nextModelId],
          }),
        };
      });
      const modelRules = current.models
        .rules()
        .filter(
          (rule) =>
            !(
              "providerId" in rule &&
              rule.providerId === input.providerId &&
              "modelId" in rule &&
              rule.modelId === input.originalModelId
            ),
        );
      const draft = input.personalConfig;
      const nextModelRules = upsertModelRule(
        modelRules,
        input.providerId,
        input.nextModelId,
        new ModelConfig({
          ...(draft.enabled != null ? { enabled: draft.enabled } : {}),
          ...(draft.properties
            ? { properties: new ModelPropertiesConfig(draft.properties as never) }
            : {}),
          ...(draft.optionSpecs
            ? { optionSpecs: new ModelOptionSpecsConfig(draft.optionSpecs as never) }
            : {}),
        }),
        "manual-provider-model",
      );
      return {
        providers: new ProviderConfigMap(rules),
        models: new ModelConfigRules(nextModelRules),
      };
    });
  }

  async setPersonalModelEnabled(
    providerId: string,
    modelId: string,
    enabled: boolean,
  ): Promise<ProviderSettingsView> {
    return this.mutate((current) => {
      const modelRules = current.models.rules().map((rule) => {
        if (
          !("providerId" in rule) ||
          rule.providerId !== providerId ||
          !("modelId" in rule) ||
          rule.modelId !== modelId
        ) {
          return rule;
        }
        return {
          ...rule,
          config: new ModelConfig({ ...plainModelConfig(rule.config), enabled }),
        };
      });
      return { providers: current.providers, models: new ModelConfigRules(modelRules) };
    });
  }

  async testModelConnectivity(
    input: ProviderSettingsConnectivityRequest,
  ): Promise<ModelConnectivityResult> {
    const snapshot = await this.repository.read();
    const rule = snapshot.providers
      .rules()
      .find((candidate) => candidate.providerId === input.providerId);
    const baseUrl = rule?.config.api?.baseUrl;
    if (!baseUrl) {
      return {
        success: false,
        error: { message: "Provider 未配置 baseUrl", code: "provider-unavailable" },
      };
    }
    const auth = readJson(PI_AUTH_PATH) ?? {};
    const credential = auth[input.providerId];
    const apiKey =
      (credential && typeof credential === "object"
        ? (credential as { key?: string }).key
        : undefined) ??
      (rule.config.access as { apiKey?: string } | null | undefined)?.apiKey ??
      "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey && !apiKey.startsWith("{{") ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          success: false,
          error: { message: `HTTP ${response.status}`, code: "model-unavailable" },
        };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function mountPiProviderSettingsService(
  register: (descriptor: typeof IProviderSettingsService, instance: unknown) => void,
  options: { onModelSelectionRefresh?: () => void } = {},
): { start: () => Promise<void>; dispose: () => void } {
  const service = new PiProviderSettingsService(options);
  register(
    IProviderSettingsService,
    withServiceFallbacks(service, "providerSettingsService") as unknown as IProviderSettingsService,
  );
  return { start: () => service.start(), dispose: () => service.dispose() };
}
