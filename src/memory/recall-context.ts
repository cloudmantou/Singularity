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
