import type {
  EvidenceProvenance,
  KnowledgeSourceProvider,
  SourceDocumentRef,
} from "./framework";

const DEVELOPMENT_CLIENTS = new Set(["claude-code", "codex"]);

function metadataText(metadata: Readonly<Record<string, unknown>>, key: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Development session provenance requires ${key}`);
  }
  return value.trim();
}

export function normalizeDevelopmentSessionProvenance(
  document: SourceDocumentRef
): EvidenceProvenance {
  const client = metadataText(document.metadata, "client").toLowerCase();
  if (!DEVELOPMENT_CLIENTS.has(client)) {
    throw new Error(`Unsupported development session client: ${client}`);
  }
  metadataText(document.metadata, "repository");
  metadataText(document.metadata, "branch");
  metadataText(document.metadata, "sessionId");
  const sourceIdentity = document.sourceId.trim();
  if (!sourceIdentity) throw new Error("Development session provenance requires sourceId");
  return {
    sourceChannel: client,
    sourceIdentity,
    sourceUri: null,
    authorType: "assistant",
    evidenceType: "conversation_transcript",
    rootEvidenceId: sourceIdentity,
    revision: Math.max(1, Math.trunc(document.sourceRevision)),
    sourceTimestamp: document.sourceTimestamp ?? null,
  };
}

export const DEVELOPMENT_SESSION_PROVIDER: KnowledgeSourceProvider = Object.freeze({
  id: "development-session",
  name: "Development Session",
  transport: "webhook",
  syncModes: Object.freeze(["append"] as const),
  capabilities: Object.freeze(["capture_session", "project_recall"]),
  normalizeProvenance: normalizeDevelopmentSessionProvenance,
});
