export type SourceSyncMode = "mirror" | "snapshot" | "append";
export type SourceTransport = "push_pull" | "poll" | "webhook" | "file";
export type SourceAuthorType = "user" | "assistant" | "tool" | "system" | "import";
export type SourceEvidenceType =
  | "direct_user_statement"
  | "user_written_note"
  | "ai_summary"
  | "ai_inference"
  | "tool_result"
  | "imported_document"
  | "conversation_transcript";

export interface SourceDocumentRef {
  sourceId: string;
  sourceRevision: number;
  sourceTimestamp?: number | null;
  metadata: Readonly<Record<string, unknown>>;
}

export interface EvidenceProvenance {
  sourceChannel: string;
  sourceIdentity: string;
  sourceUri: string | null;
  authorType: SourceAuthorType;
  evidenceType: SourceEvidenceType;
  rootEvidenceId: string;
  previousEvidenceId?: string | null;
  revision: number;
  sourceTimestamp: number | null;
}

export interface KnowledgeSourceProvider {
  readonly id: string;
  readonly name: string;
  readonly transport: SourceTransport;
  readonly syncModes: readonly SourceSyncMode[];
  readonly capabilities: readonly string[];
  normalizeProvenance(document: SourceDocumentRef): EvidenceProvenance;
}

export interface PublicKnowledgeSourceProvider {
  id: string;
  name: string;
  transport: SourceTransport;
  syncModes: SourceSyncMode[];
  capabilities: string[];
}

export class KnowledgeSourceRegistry {
  private readonly providers: ReadonlyMap<string, KnowledgeSourceProvider>;

  constructor(providers: readonly KnowledgeSourceProvider[]) {
    const byId = new Map<string, KnowledgeSourceProvider>();
    for (const provider of providers) {
      const id = provider.id.trim().toLowerCase();
      if (!id) throw new Error("Knowledge source provider id is required");
      if (byId.has(id)) throw new Error(`Duplicate knowledge source provider: ${id}`);
      byId.set(id, provider);
    }
    this.providers = byId;
  }

  get(id: string): KnowledgeSourceProvider | null {
    return this.providers.get(id.trim().toLowerCase()) ?? null;
  }

  require(id: string): KnowledgeSourceProvider {
    const provider = this.get(id);
    if (!provider) throw new Error(`Unknown knowledge source provider: ${id}`);
    return provider;
  }

  list(): PublicKnowledgeSourceProvider[] {
    return [...this.providers.values()]
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        transport: provider.transport,
        syncModes: [...provider.syncModes],
        capabilities: [...provider.capabilities],
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
