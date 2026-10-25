import type { SessionSourceAdapter, SessionSourceKind } from "./contract.js";
import { createDefaultSessionSourceAdapters, type SourceDocument } from "./adapters.js";

export const SESSION_SOURCE_KINDS = [
  "pi",
  "reasonix",
  "codex",
  "zcode",
  "deepseekharness",
  "claude-code",
] as const satisfies readonly SessionSourceKind[];

export class SessionSourceAdapterRegistry {
  private readonly adapters = new Map<SessionSourceKind, SessionSourceAdapter<SourceDocument>>();

  constructor(
    adapters: readonly SessionSourceAdapter<SourceDocument>[] = createDefaultSessionSourceAdapters(),
  ) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: SessionSourceAdapter<SourceDocument>): void {
    if (this.adapters.has(adapter.sourceKind)) {
      throw new Error(`Session source adapter already registered: ${adapter.sourceKind}`);
    }
    this.adapters.set(adapter.sourceKind, adapter);
  }

  get(sourceKind: SessionSourceKind): SessionSourceAdapter<SourceDocument> {
    const adapter = this.adapters.get(sourceKind);
    if (!adapter) throw new Error(`Unsupported session source kind: ${sourceKind}`);
    return adapter;
  }

  list(): readonly SessionSourceKind[] {
    return [...this.adapters.keys()];
  }
}
