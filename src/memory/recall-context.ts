export interface InsightEvidenceRow<TClaim = unknown> {
  id: string;
  content: string;
  claims?: TClaim[];
}

export interface InsightRelatedContextRow {
  id: string;
  content: string;
  associationType: string;
  hop: number;
}

export interface InsightContextPackage<TClaim = unknown> {
  directEvidence: InsightEvidenceRow<TClaim>[];
  relatedContext: InsightRelatedContextRow[];
}

export const INSUFFICIENT_VERIFIED_EVIDENCE =
  "Retrieved direct evidence is insufficient for a verified answer.";

export const ANSWERABILITY_MODES = ["shadow", "warn", "enforce"] as const;
export type AnswerabilityMode = (typeof ANSWERABILITY_MODES)[number];

export function normalizeAnswerabilityMode(
  value: unknown,
  fallback: AnswerabilityMode = "enforce"
): AnswerabilityMode {
  return ANSWERABILITY_MODES.includes(value as AnswerabilityMode)
    ? value as AnswerabilityMode
    : fallback;
}

export interface CitableInsightClaim {
  ref: string;
  evidenceId: string;
  claimId: string | null;
  statement: string;
  status: string;
  conflictIds: string[];
  citationUse?: "fact" | "conflict_only";
  queryRelevance: number;
  answerability: "answerable" | "related" | "irrelevant";
}

export interface VerifiedInsightClaim {
  text: string;
  refs: string[];
  kind: "fact" | "conflict";
}

export interface UnverifiedInsightClaim {
  text: string;
  refs: string[];
  reason:
    | "invalid_structured_response"
    | "missing_claim_ref"
    | "unknown_claim_ref"
    | "too_many_claim_refs"
    | "conflict_only_ref"
    | "claim_not_answerable"
    | "claim_text_not_supported"
    | "unresolved_conflict"
    | "invalid_conflict_refs";
}

export interface AnswerabilityWarning {
  text: string;
  refs: string[];
  reason: "claim_not_answerable";
  mode: Exclude<AnswerabilityMode, "enforce">;
}

export interface VerifiedInsightResult {
  answer: string;
  verifiedClaims: VerifiedInsightClaim[];
  unverifiedClaims: UnverifiedInsightClaim[];
  answerabilityWarnings?: AnswerabilityWarning[];
  answerabilityMode?: AnswerabilityMode;
}

export function normalizeInsightContext<TClaim>(
  input: InsightContextPackage<TClaim> | InsightEvidenceRow<TClaim>[]
): InsightContextPackage<TClaim> {
  if (Array.isArray(input)) {
    return { directEvidence: [...input], relatedContext: [] };
  }
  return {
    directEvidence: [...input.directEvidence],
    relatedContext: [...input.relatedContext],
  };
}

export function validateInsightEvidenceReferences(
  response: string,
  directEvidenceCount: number
): string {
  const text = response.trim();
  if (!text) return "";

  const refs = [...text.matchAll(/(?:\[|\b)([ER])(\d+)(?:\]|\b)/gi)];
  const evidenceRefs = refs
    .filter((match) => match[1].toUpperCase() === "E")
    .map((match) => Number(match[2]));
  const hasRelatedContextRef = refs.some((match) => match[1].toUpperCase() === "R");
  const hasInvalidEvidenceRef = evidenceRefs.some(
    (ref) => !Number.isInteger(ref) || ref < 1 || ref > directEvidenceCount
  );
  if (hasRelatedContextRef || hasInvalidEvidenceRef || evidenceRefs.length === 0) {
    return INSUFFICIENT_VERIFIED_EVIDENCE;
  }
  return text;
}

function normalizeClaimText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function invalidStructuredResponse(raw: string): VerifiedInsightResult {
  return {
    answer: raw.trim() ? INSUFFICIENT_VERIFIED_EVIDENCE : "",
    verifiedClaims: [],
    unverifiedClaims: raw.trim() ? [{
      text: raw.trim().slice(0, 500),
      refs: [],
      reason: "invalid_structured_response",
    }] : [],
  };
}

export function validateStructuredInsightResponse(
  response: string,
  citableClaims: readonly CitableInsightClaim[],
  answerabilityMode: AnswerabilityMode = "enforce"
): VerifiedInsightResult {
  const raw = response.trim();
  if (!raw) return invalidStructuredResponse("");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidStructuredResponse(raw);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidStructuredResponse(raw);
  }
  const candidateClaims = (parsed as Record<string, unknown>).claims;
  if (!Array.isArray(candidateClaims) || candidateClaims.length > 20) {
    return invalidStructuredResponse(raw);
  }

  const byRef = new Map(citableClaims.map((claim) => [claim.ref.toUpperCase(), claim]));
  const verifiedClaims: VerifiedInsightClaim[] = [];
  const unverifiedClaims: UnverifiedInsightClaim[] = [];
  const answerabilityWarnings: AnswerabilityWarning[] = [];

  for (const candidate of candidateClaims) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      unverifiedClaims.push({
        text: "",
        refs: [],
        reason: "invalid_structured_response",
      });
      continue;
    }
    const value = candidate as Record<string, unknown>;
    const text = typeof value.text === "string" ? normalizeClaimText(value.text).slice(0, 2_000) : "";
    const kind = value.kind === "conflict" ? "conflict" : "fact";
    const rawRefs = Array.isArray(value.refs) ? value.refs : [];
    const refs = [...new Set(rawRefs
        .filter((ref): ref is string => typeof ref === "string")
        .map((ref) => ref.trim().toUpperCase())
        .filter(Boolean))];
    if (rawRefs.length > 10 || refs.length > 10) {
      unverifiedClaims.push({
        text,
        refs: refs.slice(0, 10),
        reason: "too_many_claim_refs",
      });
      continue;
    }
    if (!refs.length) {
      unverifiedClaims.push({ text, refs, reason: "missing_claim_ref" });
      continue;
    }
    const referenced = refs.map((ref) => byRef.get(ref));
    if (referenced.some((claim) => !claim)) {
      unverifiedClaims.push({ text, refs, reason: "unknown_claim_ref" });
      continue;
    }
    const claims = referenced as CitableInsightClaim[];

    if (claims.some((claim) => claim.answerability !== "answerable")) {
      if (answerabilityMode !== "enforce") {
        answerabilityWarnings.push({
          text,
          refs,
          reason: "claim_not_answerable",
          mode: answerabilityMode,
        });
      } else {
        unverifiedClaims.push({ text, refs, reason: "claim_not_answerable" });
        continue;
      }
    }

    if (kind === "conflict") {
      const sharedConflict = claims.length >= 2 && claims[0].conflictIds.some((conflictId) =>
        claims.every((claim) => claim.conflictIds.includes(conflictId))
      );
      if (!sharedConflict) {
        unverifiedClaims.push({ text, refs, reason: "invalid_conflict_refs" });
        continue;
      }
      const statements = [...new Set(claims.map((claim) => normalizeClaimText(claim.statement)))];
      verifiedClaims.push({
        text: `Unresolved conflict: ${statements.join(" | ")}`,
        refs,
        kind,
      });
      continue;
    }

    if (claims.some((claim) => claim.citationUse === "conflict_only")) {
      unverifiedClaims.push({ text, refs, reason: "conflict_only_ref" });
      continue;
    }

    if (claims.some((claim) => claim.status === "contested" || claim.conflictIds.length > 0)) {
      unverifiedClaims.push({ text, refs, reason: "unresolved_conflict" });
      continue;
    }
    const allRefsSupportText = claims.every(
      (claim) => normalizeClaimText(claim.statement) === text
    );
    if (!allRefsSupportText) {
      unverifiedClaims.push({ text, refs, reason: "claim_text_not_supported" });
      continue;
    }
    verifiedClaims.push({ text: normalizeClaimText(claims[0].statement), refs, kind });
  }

  const answer = verifiedClaims.length
    ? verifiedClaims.map((claim) => `${claim.text} [${claim.refs.join(", ")}]`).join(" ")
    : INSUFFICIENT_VERIFIED_EVIDENCE;
  return {
    answer,
    verifiedClaims,
    unverifiedClaims,
    ...(answerabilityWarnings.length ? { answerabilityWarnings } : {}),
    ...(answerabilityMode !== "enforce" ? { answerabilityMode } : {}),
  };
}
