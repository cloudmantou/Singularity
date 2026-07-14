import type { EvidenceAuthorType } from "./evidence-contract";
import type { ClaimVectorProjectionResult } from "./claim-vector-queue";

export type MutationEvidenceType =
  | "direct_user_statement"
  | "user_written_note"
  | "ai_summary"
  | "tool_result"
  | "unknown";

export interface MutationActor {
  sourceChannel: string;
  authorType: EvidenceAuthorType;
  evidenceType: MutationEvidenceType;
  actorId: string;
}

export interface AtomicMutationProjectionResult {
  observationId: string;
  memoryId: string;
  claimVectorQueued: boolean;
  warnings: string[];
}

export function mutationActorForSource(source: string): MutationActor {
  const normalized = source.trim().toLowerCase();
  if (normalized === "mcp" || normalized === "assistant" || normalized === "claude" || normalized === "chatgpt") {
    return {
      sourceChannel: normalized || "mcp",
      authorType: "assistant",
      evidenceType: "ai_summary",
      actorId: normalized || "mcp",
    };
  }
  if (normalized === "system" || normalized === "digest") {
    return {
      sourceChannel: normalized || "system",
      authorType: "system",
      evidenceType: "ai_summary",
      actorId: normalized || "system",
    };
  }
  if (normalized === "obsidian") {
    return {
      sourceChannel: "obsidian",
      authorType: "user",
      evidenceType: "user_written_note",
      actorId: "obsidian",
    };
  }
  if (normalized === "tool" || normalized === "browser") {
    return {
      sourceChannel: normalized,
      authorType: "tool",
      evidenceType: "tool_result",
      actorId: normalized,
    };
  }
  if (normalized === "api") {
    return {
      sourceChannel: "api",
      authorType: "user",
      evidenceType: "direct_user_statement",
      actorId: "api",
    };
  }
  const unknownSource = normalized || "unknown";
  return {
    sourceChannel: unknownSource,
    authorType: "unknown",
    evidenceType: "unknown",
    actorId: unknownSource,
  };
}

export async function commitAtomicMutationWithProjection<T extends {
  observationId: string;
  memoryId: string;
}>(
  commit: () => Promise<T>,
  enqueueProjection: (memoryId: string) => Promise<boolean | ClaimVectorProjectionResult>,
  onProjectionError?: (error: unknown) => void
): Promise<T & AtomicMutationProjectionResult> {
  const committed = await commit();
  let claimVectorQueued = false;
  try {
    const result = await enqueueProjection(committed.memoryId);
    claimVectorQueued = result === true || result === "queued" || result === "already_indexed";
  } catch (error) {
    onProjectionError?.(error);
  }
  return {
    ...committed,
    claimVectorQueued,
    warnings: claimVectorQueued ? [] : ["claim_vector_enqueue_failed"],
  };
}
