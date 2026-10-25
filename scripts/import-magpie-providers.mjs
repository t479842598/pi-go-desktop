#!/usr/bin/env node
/**
 * 把 Magpie 的供应商配置导入 PI 的 `<pig-agent>/models.json`。
 *
 * 只做字段映射与合并，不改动 Magpie 自身配置：
 *   Magpie providers.json  →  PI models.json { providers: { [id]: { api, baseUrl, apiKey, name, models } } }
 *
 * 默认写入 `~/.pi-web/pig-agent/models.json`；`--dry-run` 只打印计划，`--out` 指定目标文件。
 * 已存在的同名 provider 默认跳过（`--overwrite` 才覆盖），避免冲掉用户手工编辑。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

export const DEFAULT_MAGPIE_PATH = join(homedir(), ".config", "magpie", "providers.json");
export const DEFAULT_PI_MODELS_PATH = join(homedir(), ".pi-web", "pig-agent", "models.json");

const CONTEXT_WINDOW_FALLBACK = 128_000;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function pickBaseUrl(provider) {
  // Magpie 的 chat 字段是 OpenAI 兼容根路径；anthropic 是 Anthropic 专用根路径。
  // PI 的 baseUrl 由 api 类型决定，两者不能混用。
  return provider.chat?.trim() || provider.anthropic?.trim() || "";
}

function pickApiType(provider) {
  if (provider.chat) {
    return provider.responses && !provider.anthropic ? "openai-responses" : "openai-chat-completions";
  }
  return provider.anthropic ? "anthropic-messages" : "openai-chat-completions";
}

function pickApiKey(provider) {
  if (typeof provider.key === "string" && provider.key.trim()) return provider.key.trim();
  const firstKey = Array.isArray(provider.keys) ? provider.keys.find((entry) => entry?.key) : null;
  return firstKey?.key?.trim() || "";
}

function toPiModels(provider) {
  const modelIds = Array.isArray(provider.models) ? provider.models.filter(Boolean) : [];
  const contextWindow =
    Number(provider.contexts?.["*"]) > 0 ? Number(provider.contexts["*"]) : CONTEXT_WINDOW_FALLBACK;
  return modelIds.map((id) => ({
    id,
    contextWindow,
    input: ["text"],
    reasoning: false,
  }));
}

/** 纯函数：Magpie 文档 → PI models.json 的 providers 片段。 */
export function convertMagpieProviders(magpieDocument) {
  const providers = Array.isArray(magpieDocument?.providers) ? magpieDocument.providers : [];
  const converted = {};
  const skipped = [];

  for (const provider of providers) {
    const id = typeof provider?.id === "string" ? provider.id.trim() : "";
    const baseUrl = pickBaseUrl(provider);
    const apiKey = pickApiKey(provider);
    const models = toPiModels(provider);

    if (!id || !baseUrl || !apiKey || models.length === 0) {
      skipped.push({
        id: id || "<unnamed>",
        reason: !baseUrl
          ? "missing-base-url"
          : !apiKey
            ? "missing-api-key"
            : models.length === 0
              ? "missing-models"
              : "missing-id",
      });
      continue;
    }

    converted[id] = {
      api: pickApiType(provider),
      baseUrl,
      apiKey,
      name: provider.name?.trim() || id,
      models,
    };
  }

  return { providers: converted, skipped };
}

/** 合并进已有的 models.json；默认不覆盖同 id 条目。 */
export function mergePiProviders(existingDocument, convertedProviders, { overwrite = false } = {}) {
  const existing = existingDocument?.providers;
  const merged = existing && typeof existing === "object" ? { ...existing } : {};
  const added = [];
  const updated = [];
  const kept = [];

  for (const [id, provider] of Object.entries(convertedProviders)) {
    if (!merged[id]) {
      merged[id] = provider;
      added.push(id);
      continue;
    }
    if (overwrite) {
      merged[id] = provider;
      updated.push(id);
      continue;
    }
    kept.push(id);
  }

  return { document: { ...(existingDocument ?? {}), providers: merged }, added, updated, kept };
}

function parseArgs(argv) {
  const options = {
    magpiePath: DEFAULT_MAGPIE_PATH,
    outPath: DEFAULT_PI_MODELS_PATH,
    dryRun: false,
    overwrite: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--overwrite") options.overwrite = true;
    else if (arg === "--magpie") options.magpiePath = resolve(argv[++index]);
    else if (arg === "--out") options.outPath = resolve(argv[++index]);
  }
  return options;
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

export function importMagpieProviders(options) {
  if (!existsSync(options.magpiePath)) {
    throw new Error(`Magpie providers file not found: ${options.magpiePath}`);
  }
  const magpieDocument = readJson(options.magpiePath);
  const { providers, skipped } = convertMagpieProviders(magpieDocument);
  const existingDocument = existsSync(options.outPath) ? readJson(options.outPath) : {};
  const merged = mergePiProviders(existingDocument, providers, { overwrite: options.overwrite });

  if (!options.dryRun) writeJsonAtomic(options.outPath, merged.document);

  return {
    outPath: options.outPath,
    converted: Object.keys(providers).length,
    added: merged.added,
    updated: merged.updated,
    kept: merged.kept,
    skipped,
    written: !options.dryRun,
  };
}

const entryHref = process.argv[1] ? new URL(`file://${resolve(process.argv[1])}`).href : null;
if (entryHref === import.meta.url) {
  try {
    const result = importMagpieProviders(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[import-magpie] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
