/**
 * pi-backed plugin management — PI 的"插件"就是 pi 的本地扩展。
 *
 * `<pig-agent>/extensions/` 下每个子目录（或 .ts 文件）是一个扩展，PiG 启动时
 * 自动加载。ZCode 的插件面板（IPluginManagementService）在这里降维成：
 *  - list：目录扫描 + 读 package.json/文件名给出名称与来源；
 *  - 启/停：目录改名为 `<name>.disabled` / 恢复（pi 只加载未带后缀的目录），
 *    重启会话后生效（与 ZCode 插件启停的生效语义一致）。
 * 市场安装（npm 包）不在本层——pi 没有内置市场 API，引导用户手动放置目录。
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { Emitter, type Event } from "@zcode/rpc";
import { IPluginManagementService } from "@zcode/services";

import { getPiGAgentDir } from "@zcode/services/node";
import { withServiceFallbacks } from "../../service-fallbacks.js";

const EXTENSIONS_DIR = join(getPiGAgentDir(), "extensions");
const DISABLED_SUFFIX = ".disabled";

function extensionsRoot(): string {
  return EXTENSIONS_DIR;
}

interface ExtensionEntry {
  id: string;
  name: string;
  enabled: boolean;
  kind: "directory" | "file";
  path: string;
  /** package.json 的描述（目录型扩展有则带） */
  description: string;
}

function scanExtensions(): ExtensionEntry[] {
  if (!existsSync(extensionsRoot())) return [];
  const out: ExtensionEntry[] = [];
  for (const name of readdirSync(extensionsRoot())) {
    const full = join(extensionsRoot(), name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (name.endsWith(DISABLED_SUFFIX)) {
      const realName = name.slice(0, -DISABLED_SUFFIX.length);
      out.push({
        id: realName,
        name: realName,
        enabled: false,
        kind: isDir ? "directory" : "file",
        path: full,
        description: readDescription(full, isDir),
      });
      continue;
    }
    out.push({
      id: name,
      name,
      enabled: true,
      kind: isDir ? "directory" : "file",
      path: full,
      description: readDescription(full, isDir),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function readDescription(path: string, isDir: boolean): string {
  if (!isDir) return "单文件扩展";
  const pkg = join(path, "package.json");
  if (!existsSync(pkg)) return "";
  try {
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { description?: string };
    return parsed.description ?? "";
  } catch {
    return "";
  }
}

// readFileSync 顶部导入已合并到 node:fs 导入块。

type PluginSettings = IPluginManagementService;

export class PiPluginManagementService {
  private readonly change = new Emitter<unknown>();
  readonly onDidChange: Event<unknown> = this.change.event;

  async listExtensions(): Promise<{ extensions: ExtensionEntry[]; root: string }> {
    return { extensions: scanExtensions(), root: extensionsRoot() };
  }

  async setExtensionEnabled(params: { id: string; enabled: boolean }): Promise<{ ok: true }> {
    const enabledPath = join(extensionsRoot(), params.id);
    const disabledPath = join(extensionsRoot(), `${params.id}${DISABLED_SUFFIX}`);
    const from = params.enabled ? disabledPath : enabledPath;
    const to = params.enabled ? enabledPath : disabledPath;
    if (!existsSync(from)) throw new Error(`extension not found: ${params.id}`);
    renameSync(from, to);
    this.change.fire({ id: params.id, enabled: params.enabled });
    return { ok: true };
  }

  /** 兼容 ZCode 面板的主查询：返回空市场 + 本地扩展列表。 */
  async listPlugins(): Promise<unknown> {
    const extensions = scanExtensions();
    return {
      plugins: extensions.map((extension) => ({
        id: extension.id,
        name: extension.name,
        description: extension.description,
        enabled: extension.enabled,
        source: "pi-extension",
      })),
      marketplaces: [],
      root: extensionsRoot(),
    };
  }
}

export function mountPiPluginManagementService(
  register: (descriptor: typeof IPluginManagementService, instance: unknown) => void,
): void {
  register(
    IPluginManagementService,
    withServiceFallbacks(
      new PiPluginManagementService(),
      "pluginManagementService",
    ) as unknown as PluginSettings,
  );
}
