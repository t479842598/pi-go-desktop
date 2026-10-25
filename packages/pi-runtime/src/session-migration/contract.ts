import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Stable, path-safe identity used for an imported session. */
export type SessionMigrationId = string & { readonly __brand: "SessionMigrationId" };
export type SessionSourceKind =
  | "pi"
  | "reasonix"
  | "codex"
  | "zcode"
  | "deepseekharness"
  | "claude-code";
export type ImportState =
  | "discovered"
  | "previewed"
  | "validated"
  | "staged"
  | "committed"
  | "verified"
  | "skipped"
  | "failed";

export interface SessionSourceReference {
  readonly sourceKind: SessionSourceKind;
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly sourceRoot?: string;
  readonly workspacePath?: string;
  readonly sizeBytes?: number;
  readonly sourceDigest?: string;
}

export interface SessionProvenance {
  readonly sourceKind: SessionSourceKind;
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly parserVersion: string;
  readonly sourceDigest?: string;
  readonly importedAt: string;
}

/**
 * Pi-native session entry plus migration-only source coordinates.
 * Migration coordinates are stripped before writing the Pi JSONL record.
 */
export type CanonicalSessionEntry = SessionEntry & {
  readonly sourceOrdinal: number;
  readonly sourceRecordId?: string;
  readonly unmapped?: boolean;
};

export interface CanonicalSession {
  readonly version: 3;
  readonly sessionId: SessionMigrationId;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entries: readonly CanonicalSessionEntry[];
  readonly leafId?: string;
  /** Parser diagnostics retained for the import manifest, never written into the Pi header. */
  readonly skippedRecords?: readonly { readonly ordinal?: number; readonly reason: string }[];
  readonly provenance: SessionProvenance;
}

export interface ImportManifest {
  readonly source: SessionSourceReference;
  readonly parserVersion: string;
  readonly sourceDigest?: string;
  readonly targetSessionId: string;
  /** Digest of the canonical Pi header and source entries, excluding the audit custom entry. */
  readonly targetDigest?: string;
  readonly state: ImportState;
  readonly counts: {
    readonly sourceRecords: number;
    readonly writtenEntries: number;
    readonly skippedRecords: number;
    readonly unmappedRecords: number;
  };
  readonly sourceRecordMap: readonly {
    readonly entryId: string;
    readonly sourceOrdinal: number;
    readonly sourceRecordId?: string;
    readonly unmapped: boolean;
  }[];
  readonly skipped: readonly { ordinal?: number; reason: string }[];
  readonly conflicts: readonly { existingPath: string; reason: string }[];
  readonly secretFieldsExcluded: readonly string[];
  readonly createdAt: string;
  readonly error?: string;
}

export interface SessionSourceAdapter<TDocument = unknown> {
  readonly sourceKind: SessionSourceKind;
  readonly parserVersion: string;
  discover(input: { readonly root: string }): Promise<readonly SessionSourceReference[]>;
  read(reference: SessionSourceReference): Promise<TDocument>;
  normalize(document: TDocument, reference: SessionSourceReference): Promise<CanonicalSession>;
  validate(session: CanonicalSession): void;
}

export interface SessionMigrationContract {
  /** Discover readable source sessions without modifying source or target files. */
  discover(sourceKind: SessionSourceKind, root: string): Promise<readonly SessionSourceReference[]>;
  /** Normalize one source document and return a preview without writing. */
  preview(reference: SessionSourceReference): Promise<CanonicalSession>;
  /** Validate, atomically write and return an auditable manifest. */
  import(reference: SessionSourceReference): Promise<ImportManifest>;
  /** Read the manifest for a previous migration by stable migration id. */
  report(migrationId: SessionMigrationId): Promise<ImportManifest | null>;
}

export function asSessionMigrationId(value: string): SessionMigrationId {
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(value)) {
    throw new Error(`invalid session migration id: ${value}`);
  }
  return value as SessionMigrationId;
}
