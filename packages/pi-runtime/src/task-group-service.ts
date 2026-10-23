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
