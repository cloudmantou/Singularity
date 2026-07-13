export type FactResolutionType =
  | "duplicate"
  | "supports"
  | "elaborates"
  | "coexists"
  | "supersedes"
  | "contradicts"
  | "uncertain";

export const FACT_RESOLUTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_fact_resolutions (
    id TEXT PRIMARY KEY,
    relation_id TEXT NOT NULL,
    target_relation_id TEXT,
    resolution_type TEXT NOT NULL,
    confidence REAL,
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    requires_review INTEGER NOT NULL DEFAULT 0,
    applied_invalidation INTEGER NOT NULL DEFAULT 0,
    source_memory_id TEXT,
    target_memory_id TEXT,
    created_at INTEGER NOT NULL,
    CHECK (resolution_type IN ('duplicate', 'supports', 'elaborates', 'coexists', 'supersedes', 'contradicts', 'uncertain'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fact_resolutions_relation
    ON sb_fact_resolutions(relation_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_fact_resolutions_target
    ON sb_fact_resolutions(target_relation_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_fact_resolutions_review
    ON sb_fact_resolutions(requires_review, created_at DESC)`,
] as const;

export interface FactResolutionInput {
  fromEntityId: string;
  toEntityId: string;
  predicate: string;
  fact: string | null;
  scopeId: string | null;
  polarity: string | null;
  modality: string | null;
  validFrom: number | null;
  validTo: number | null;
  referenceTime: number | null;
  memoryId: string | null;
  allowInvalidation?: boolean;
}

export interface FactResolutionCandidate extends FactResolutionInput {
  relationId: string;
  evidenceCount?: number;
}

export interface FactResolutionResult {
  type: FactResolutionType;
  targetRelationId: string | null;
  targetMemoryId: string | null;
  confidence: number;
  reasonCodes: string[];
  applyInvalidation: boolean;
  requiresReview: boolean;
}

export interface FactResolver {
  resolve(input: FactResolutionInput, candidates: FactResolutionCandidate[]): Promise<FactResolutionResult>;
}

export interface TemporalResolver {
  overlaps(left: FactResolutionInput, right: FactResolutionInput): boolean;
}

export class DeterministicTemporalResolver implements TemporalResolver {
  overlaps(left: FactResolutionInput, right: FactResolutionInput): boolean {
    return overlaps(left, right);
  }
}

export class DeterministicFactResolver implements FactResolver {
  async resolve(
    input: FactResolutionInput,
    candidates: FactResolutionCandidate[]
  ): Promise<FactResolutionResult> {
    return resolveFact(input, candidates);
  }
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function temporalPoint(input: FactResolutionInput): { from: number; to: number } {
  const reference = Number.isFinite(input.referenceTime) ? Number(input.referenceTime) : null;
  const explicitFrom = Number.isFinite(input.validFrom) ? Number(input.validFrom) : null;
  const explicitTo = Number.isFinite(input.validTo) ? Number(input.validTo) : null;
  const pointInTime = explicitFrom == null && explicitTo == null ? reference : null;
  return {
    from: explicitFrom ?? pointInTime ?? Number.NEGATIVE_INFINITY,
    to: explicitTo ?? pointInTime ?? Number.POSITIVE_INFINITY,
  };
}

function overlaps(left: FactResolutionInput, right: FactResolutionInput): boolean {
  const a = temporalPoint(left);
  const b = temporalPoint(right);
  return a.from <= b.to && b.from <= a.to;
}

function scopesCompatible(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  return normalize(left) === normalize(right);
}

function explicitlySupersedes(fact: string | null): boolean {
  const text = fact ?? "";
  if (/\b(?:not|never|no longer plans? to|doesn['’]?t|does not|do not|cannot|can['’]?t)\b.{0,40}\b(?:replace|supersede|switch|migrate)/i.test(text)) {
    return false;
  }
  if (/(?:不会|不应|不能|并非|没有).{0,24}(?:替代|取代|改为|切换|迁移)/.test(text)) {
    return false;
  }
  return /\b(?:now|currently)\b.*\b(?:replace[sd]?|switch(?:es|ed)?\s+to|migrat(?:e|ed|es)\s+to)\b|\b(?:replace[sd]?|supersede[sd]?)\b|(?:改为|替代|取代|切换为|迁移到|不再.{0,24}(?:改用|使用))/i.test(text);
}

function result(
  type: FactResolutionType,
  candidate: FactResolutionCandidate | null,
  confidence: number,
  reasonCodes: string[],
  options: { applyInvalidation?: boolean; requiresReview?: boolean } = {}
): FactResolutionResult {
  return {
    type,
    targetRelationId: candidate?.relationId ?? null,
    targetMemoryId: candidate?.memoryId ?? null,
    confidence,
    reasonCodes,
    applyInvalidation: options.applyInvalidation === true,
    requiresReview: options.requiresReview === true,
  };
}

export function resolveFact(
  input: FactResolutionInput,
  candidates: FactResolutionCandidate[]
): FactResolutionResult {
  const samePredicate = candidates.filter((candidate) =>
    candidate.fromEntityId === input.fromEntityId &&
    normalize(candidate.predicate) === normalize(input.predicate)
  );
  if (samePredicate.length === 0) {
    return result("coexists", null, 1, ["no_prior_fact"]);
  }

  for (const candidate of samePredicate) {
    if (
      candidate.toEntityId === input.toEntityId &&
      normalize(candidate.fact) === normalize(input.fact) &&
      scopesCompatible(input.scopeId, candidate.scopeId) &&
      overlaps(input, candidate)
    ) {
      return result("duplicate", candidate, 1, ["same_structure", "same_fact", "overlapping_time"]);
    }
  }

  const ranked = samePredicate
    .map((candidate) => {
      let score = 0;
      if (candidate.toEntityId === input.toEntityId) score += 4;
      if (scopesCompatible(input.scopeId, candidate.scopeId)) score += 2;
      if (overlaps(input, candidate)) score += 2;
      if (normalize(candidate.polarity) === normalize(input.polarity)) score += 1;
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score || left.candidate.relationId.localeCompare(right.candidate.relationId));
  const target = ranked[0]?.candidate ?? null;
  if (!target) return result("uncertain", null, 0, ["no_candidate"], { requiresReview: true });

  if (!scopesCompatible(input.scopeId, target.scopeId)) {
    return result("coexists", target, 0.98, ["different_scope"]);
  }
  if (!overlaps(input, target)) {
    return result("coexists", target, 0.98, ["non_overlapping_time"]);
  }

  if (input.toEntityId === target.toEntityId) {
    if (normalize(input.polarity) !== normalize(target.polarity)) {
      return result("contradicts", target, 0.96, ["opposite_polarity"], { requiresReview: true });
    }
    const nextFact = normalize(input.fact);
    const priorFact = normalize(target.fact);
    if (nextFact && priorFact && (nextFact.includes(priorFact) || priorFact.includes(nextFact))) {
      return result("elaborates", target, 0.92, ["same_structure", "qualified_detail"]);
    }
    return result("supports", target, 0.9, ["same_structure", "compatible_assertion"]);
  }

  if (explicitlySupersedes(input.fact)) {
    const explicitSameScope = Boolean(
      input.scopeId && target.scopeId && normalize(input.scopeId) === normalize(target.scopeId)
    );
    const eligibleModality = !["hypothetical", "inferred"].includes(normalize(input.modality));
    const independentlySupported = Number(target.evidenceCount ?? 1) > 1;
    const applyInvalidation =
      input.allowInvalidation === true &&
      explicitSameScope &&
      eligibleModality &&
      !independentlySupported;
    const reasonCodes = ["same_subject_predicate_scope", "explicit_replacement"];
    if (!explicitSameScope) reasonCodes.push("scope_not_explicit");
    if (!eligibleModality) reasonCodes.push("non_authoritative_modality");
    if (independentlySupported) reasonCodes.push("independent_support_remains");
    if (input.allowInvalidation !== true) reasonCodes.push("evidence_not_authoritative");
    return result("supersedes", target, 0.96, reasonCodes, {
      applyInvalidation,
      requiresReview: !applyInvalidation,
    });
  }

  return result("contradicts", target, 0.9, ["same_subject_predicate_scope", "different_object"], {
    requiresReview: true,
  });
}
