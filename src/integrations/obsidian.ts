import type {
  EvidenceProvenance,
  KnowledgeSourceProvider,
  SourceDocumentRef,
} from "./framework";

function requiredMetadata(metadata: Readonly<Record<string, unknown>>, key: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Obsidian provenance requires ${key}`);
  }
  return value.trim();
}

function obsidianUri(vaultId: string, path: string, blockId: string): string {
  const file = blockId ? `${path}#^${blockId}` : path;
  return `obsidian://open?vault=${encodeURIComponent(vaultId)}&file=${encodeURIComponent(file)}`;
}

export function normalizeObsidianProvenance(document: SourceDocumentRef): EvidenceProvenance {
  const vaultId = requiredMetadata(document.metadata, "vaultId");
  const path = requiredMetadata(document.metadata, "path");
  const blockValue = document.metadata.blockId;
  const blockId = typeof blockValue === "string" ? blockValue.trim() : "";
  const sourceIdentity = document.sourceId.trim();
  if (!sourceIdentity) throw new Error("Obsidian provenance requires sourceId");
  const revision = Math.max(1, Math.trunc(document.sourceRevision));
  return {
    sourceChannel: "obsidian",
    sourceIdentity,
    sourceUri: obsidianUri(vaultId, path, blockId),
    authorType: "user",
    evidenceType: "user_written_note",
    rootEvidenceId: sourceIdentity,
    revision,
    sourceTimestamp: document.sourceTimestamp ?? null,
  };
}

export const OBSIDIAN_SOURCE_PROVIDER: KnowledgeSourceProvider = Object.freeze({
  id: "obsidian",
  name: "Obsidian",
  transport: "push_pull",
  syncModes: Object.freeze(["mirror", "snapshot", "append"] as const),
  capabilities: Object.freeze([
    "push",
    "pull",
    "conflict_resolution",
    "managed_projection",
  ]),
  normalizeProvenance: normalizeObsidianProvenance,
});
