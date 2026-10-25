/**
 * pi-backed `ITaskGroupService`.
 *
 * ZCode's sidebar merges two sources: the `sessions-index` topic (pi sessions)
 * and this service's stored groups. Leaving the ZCode implementation in place
 * kept its database rows — old projects and tasks from the ZCode CLI — visible
 * next to pi's, so the list showed conversations that cannot be opened.
 *
 * pi has no grouping concept, so reads answer "no groups" and writes are no-ops.
 * That is honest for a workspace with no organisation of its own, and it keeps
 * the sidebar showing exactly the sessions that exist.
 */

export interface PiTaskGroupStructure {
  groups: unknown[];
  members: unknown[];
  order: unknown[];
}

export class PiTaskGroupService {
  async read(): Promise<PiTaskGroupStructure> {
    return { groups: [], members: [], order: [] };
  }

  /**
   * 会话整库导出（「会话数据」设置分区用）。挂在 task-groups 通道上是因为 UI
   * 侧该服务的实例已随每个 host 就绪；额外成员经 ProxyChannel 反射可调用。
   */
  async exportSessionsData(): Promise<unknown> {
    const { exportPiSessions } = await import("./session-io.js");
    return exportPiSessions();
  }

  /** 导入快照：只写本机不存在的会话文件，已存在一律跳过。 */
  async importSessionsData(payload: unknown): Promise<unknown> {
    const { importPiSessions } = await import("./session-io.js");
    return importPiSessions(payload);
  }

  /** 单会话 HTML 导出（自含样式，双击可看）。 */
  async exportSessionHtmlFile(params: {
    sessionId: string;
  }): Promise<{ html: string; file: string }> {
    const { exportSessionHtml, resolveSessionFile } = await import("./session-io.js");
    const file = resolveSessionFile(params.sessionId);
    if (!file) throw new Error(`session file not found: ${params.sessionId}`);
    return { html: exportSessionHtml(file), file };
  }

  /**
   * 数据整库导出：会话 + 模型配置（models.json，密钥保留模板形态）+ 数据根设置。
   * 导入侧只恢复会话（模型/设置以本机为准，避免覆盖密钥）。
   */
  async exportAllData(): Promise<unknown> {
    const { exportPiSessions } = await import("./session-io.js");
    const { readFileSync } = await import("node:fs");
    const { getPiGAgentDir } = await import("@zcode/services/node");
    const { join } = await import("node:path");
    const modelsPath = join(getPiGAgentDir(), "models.json");
    let models: unknown = null;
    try {
      models = JSON.parse(readFileSync(modelsPath, "utf8"));
    } catch {
      /* 无配置文件时导出 null */
    }
    return {
      kind: "pi-all-data-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: exportPiSessions(),
      models,
    };
  }

  async save(input: { id?: string; title?: string; color?: string }): Promise<unknown> {
    return {
      id: input.id ?? `pi-group-${Date.now()}`,
      title: input.title ?? "",
      color: input.color ?? "default",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async ungroup(_id: string): Promise<void> {}

  async move(_input: unknown): Promise<void> {}

  async admit(_input: unknown): Promise<void> {}
}
