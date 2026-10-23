import { materializeZCodeBuiltinProviderConfig } from "@zcode/services/node";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export interface MaterializeBundledZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 ZCode Built-in Provider Config。 */
export function readBundledZCodeBuiltinProviderConfig(): string {
  if (typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string") {
    return __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
  }
  // pi-zcode: the pi engine resolves models from pi's own ModelRuntime, so the
  // bundled ZCode provider catalog is not needed. Source runs (tsx, no bundler)
  // have no injected constant at all — an empty catalog is the correct answer
  // there rather than a startup failure. ZCode's own engine still requires it:
  // without the flag that the pi engine is active, keep the hard failure.
  if (process.env["PI_ENGINE"] === "pi") {
    // Shape required by `decodeZCodeBuiltinRelease` → `parseZCodeBuiltinProviderConfigRules`
    // → `parseZCodeBuiltinModelConfigRules`. Both are strict objects of rule
    // arrays; empty arrays mean "no bundled providers/models", which is what the
    // pi engine wants — it resolves models from pi's own ModelRuntime instead.
    return JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    });
  }
  throw new Error("当前构建未嵌入 ZCode Built-in Provider Config");
}

/**
 * 将 ZCode Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledZCodeBuiltinProviderConfig(
  options: MaterializeBundledZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeZCodeBuiltinProviderConfig(options);
}
