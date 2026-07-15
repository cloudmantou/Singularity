export interface InsightEvidenceRow<TClaim = unknown> {
  id: string;
  content: string;
  claims?: TClaim[];
  createdAt?: number;
  source?: string;
  tags?: string[];
  versionId?: string | null;
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
  versionId?: string | null;
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
    | "missing_answer"
    | "missing_answer_citation"
    | "invalid_answer_citation"
    | "missing_claim_ref"
    | "unknown_claim_ref"
    | "too_many_claim_refs"
    | "conflict_only_ref"
    | "claim_not_answerable"
    | "claim_text_not_supported"
    | "unresolved_conflict"
    | "invalid_conflict_refs"
    | "answer_language_mismatch";
}

export interface InsightCitation {
  ref: string;
  memoryId: string;
  claimId: string | null;
  evidenceId: string;
  versionId: string | null;
  statement: string;
  kind: "fact" | "conflict";
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
  citations?: InsightCitation[];
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

function unwrapStructuredInsightResponse(raw: string): string {
  const withoutBom = raw.replace(/^\uFEFF/, "").trim();
  const withoutThinking = withoutBom.replace(
    /^(?:<think>[\s\S]*?<\/think>\s*)+/i,
    ""
  ).trim();
  const fenced = withoutThinking.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? withoutThinking).trim();
}

export function parseInsightEntailmentVerdicts(
  response: string,
  expectedParagraphIds: readonly string[]
): Map<string, boolean> | null {
  const expected = [...new Set(expectedParagraphIds)];
  if (!expected.length || expected.length !== expectedParagraphIds.length) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapStructuredInsightResponse(response.trim()));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const paragraphs = (parsed as Record<string, unknown>).paragraphs;
  if (!Array.isArray(paragraphs) || paragraphs.length !== expected.length) return null;

  const expectedSet = new Set(expected);
  const verdicts = new Map<string, boolean>();
  for (const paragraph of paragraphs) {
    if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)) return null;
    const record = paragraph as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (
      !expectedSet.has(id) ||
      verdicts.has(id) ||
      typeof record.supported !== "boolean"
    ) return null;
    verdicts.set(id, record.supported);
  }
  return verdicts.size === expected.length ? verdicts : null;
}

export function validateInsightEntailmentResponse(
  response: string,
  expectedParagraphIds: readonly string[]
): boolean {
  const verdicts = parseInsightEntailmentVerdicts(response, expectedParagraphIds);
  return verdicts !== null && [...verdicts.values()].every(Boolean);
}

function extractAnswerClaimRefs(answer: string): string[] {
  const refs: string[] = [];
  for (const match of answer.matchAll(/\[\s*(C\d+(?:\s*,\s*C\d+)*)\s*\]/gi)) {
    for (const ref of match[1].split(",")) {
      const normalized = ref.trim().toUpperCase();
      if (normalized && !refs.includes(normalized)) refs.push(normalized);
    }
  }
  return refs;
}

function answerHasNonClaimReference(answer: string): boolean {
  return /\[\s*[ER]\d+(?:\s*,\s*[ER]\d+)*\s*\]/i.test(answer);
}

function removeModelClaimMarkers(text: string, refs: readonly string[]): string {
  const allowed = new Set(refs.map((ref) => ref.toUpperCase()));
  return text.replace(/[（(]\s*(C\d+)\s*[)）]/gi, (marker, ref: string) =>
    allowed.has(ref.toUpperCase()) ? "" : marker
  );
}

function renderStructuredAnswer(
  value: unknown,
  unverifiedClaims: UnverifiedInsightClaim[]
): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  if (value.length > 5) {
    unverifiedClaims.push({
      text: "",
      refs: [],
      reason: "invalid_structured_response",
    });
    return "";
  }

  const paragraphs: string[] = [];
  for (const paragraph of value) {
    if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)) {
      unverifiedClaims.push({ text: "", refs: [], reason: "invalid_structured_response" });
      continue;
    }
    const record = paragraph as Record<string, unknown>;
    const rawRefs = Array.isArray(record.refs) ? record.refs : [];
    const refs = [...new Set(rawRefs
      .filter((ref): ref is string => typeof ref === "string")
      .map((ref) => ref.trim().toUpperCase())
      .filter(Boolean))];
    const text = typeof record.text === "string"
      ? removeModelClaimMarkers(normalizeClaimText(record.text), refs).slice(0, 4_000)
      : "";
    if (!text || rawRefs.some((ref) => typeof ref !== "string")) {
      unverifiedClaims.push({ text, refs, reason: "invalid_structured_response" });
      continue;
    }
    if (rawRefs.length > 10 || refs.length > 10) {
      unverifiedClaims.push({ text, refs: refs.slice(0, 10), reason: "too_many_claim_refs" });
      continue;
    }
    if (extractAnswerClaimRefs(text).length || answerHasNonClaimReference(text)) {
      unverifiedClaims.push({ text, refs, reason: "invalid_answer_citation" });
      continue;
    }
    const citationSuffix = refs.map((ref) => `[${ref}]`).join("");
    paragraphs.push(citationSuffix ? `${text} ${citationSuffix}` : text);
  }
  return paragraphs.join("\n\n");
}

function deriveClaimCandidatesFromAnswer(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;

  return value.flatMap((paragraph) => {
    if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)) {
      return [paragraph];
    }
    const record = paragraph as Record<string, unknown>;
    const refs = Array.isArray(record.refs) ? record.refs : [];
    if (record.kind === "conflict") {
      return [{ refs, kind: "conflict" }];
    }
    return refs.length
      ? refs.map((ref) => ({ refs: [ref], kind: "fact" }))
      : [{ refs: [], kind: "fact" }];
  });
}

function buildInsightCitations(
  claims: readonly CitableInsightClaim[],
  verifiedClaims: readonly VerifiedInsightClaim[]
): InsightCitation[] {
  const byRef = new Map(claims.map((claim) => [claim.ref.toUpperCase(), claim]));
  const citations: InsightCitation[] = [];
  const seen = new Set<string>();
  for (const verified of verifiedClaims) {
    for (const ref of verified.refs) {
      const claim = byRef.get(ref.toUpperCase());
      if (!claim || seen.has(claim.ref.toUpperCase())) continue;
      seen.add(claim.ref.toUpperCase());
      citations.push({
        ref: claim.ref,
        memoryId: claim.claimId ?? claim.evidenceId,
        claimId: claim.claimId,
        evidenceId: claim.evidenceId,
        versionId: claim.versionId ?? null,
        statement: claim.statement,
        kind: verified.kind,
      });
    }
  }
  return citations;
}

export function validateStructuredInsightResponse(
  response: string,
  citableClaims: readonly CitableInsightClaim[],
  answerabilityMode: AnswerabilityMode = "enforce"
): VerifiedInsightResult {
  const raw = response.trim();
  if (!raw) return invalidStructuredResponse("");
  const structured = unwrapStructuredInsightResponse(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(structured);
  } catch {
    return invalidStructuredResponse(raw);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidStructuredResponse(raw);
  }
  const parsedRecord = parsed as Record<string, unknown>;
  const answerValue = parsedRecord.answer;
  const candidateClaims = deriveClaimCandidatesFromAnswer(answerValue)
    ?? parsedRecord.claims;
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
    const referencedStatements = claims.map((claim) => normalizeClaimText(claim.statement));
    const allRefsSupportText = text
      ? referencedStatements.every((statement) => statement === text)
      : new Set(referencedStatements).size === 1;
    if (!allRefsSupportText) {
      unverifiedClaims.push({ text, refs, reason: "claim_text_not_supported" });
      continue;
    }
    verifiedClaims.push({ text: referencedStatements[0], refs, kind });
  }

  const answer = renderStructuredAnswer(answerValue, unverifiedClaims);
  const responseMetadata = {
    ...(answerabilityWarnings.length ? { answerabilityWarnings } : {}),
    ...(answerabilityMode !== "enforce" ? { answerabilityMode } : {}),
  };

  // A selected Claim is only a source ledger. It is never a fallback answer:
  // the model must provide a natural-language answer with local citations.
  if (verifiedClaims.length && !answer && !unverifiedClaims.length) {
    unverifiedClaims.push({ text: "", refs: [], reason: "missing_answer" });
  }

  if (verifiedClaims.length && answer) {
    const answerRefs = extractAnswerClaimRefs(answer);
    const verifiedRefs = new Set(verifiedClaims.flatMap((claim) => claim.refs));
    const paragraphs = answer.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    if (answerHasNonClaimReference(answer)) {
      unverifiedClaims.push({
        text: answer.slice(0, 500),
        refs: answerRefs,
        reason: "invalid_answer_citation",
      });
    } else if (!answerRefs.length) {
      unverifiedClaims.push({
        text: answer.slice(0, 500),
        refs: [],
        reason: "missing_answer_citation",
      });
    } else if (paragraphs.some((paragraph) => !extractAnswerClaimRefs(paragraph).length)) {
      unverifiedClaims.push({
        text: answer.slice(0, 500),
        refs: answerRefs,
        reason: "missing_answer_citation",
      });
    } else if (answerRefs.some((ref) => !verifiedRefs.has(ref))) {
      unverifiedClaims.push({
        text: answer.slice(0, 500),
        refs: answerRefs,
        reason: "unknown_claim_ref",
      });
    }
  }

  if (verifiedClaims.length && !unverifiedClaims.length && answer) {
    return {
      answer,
      verifiedClaims,
      unverifiedClaims,
      citations: buildInsightCitations(citableClaims, verifiedClaims),
      ...responseMetadata,
    };
  }

  return {
    answer: INSUFFICIENT_VERIFIED_EVIDENCE,
    verifiedClaims: [],
    unverifiedClaims,
    ...responseMetadata,
  };
}
