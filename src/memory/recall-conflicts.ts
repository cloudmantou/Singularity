import { activeMemoryClaimPredicate } from "./claim-eligibility";

export interface RecallClaimContext {
  id: string;
  entryId: string;
  parentVersionId?: string | null;
  statement: string;
  status: string;
  verificationStatus: "confirmed" | "contested" | "supported";
  conflictIds: string[];
  opposingClaimIds: string[];
  queryRelevance?: number;
}

export interface RecallConflictClaim {
  id: string;
  entryId: string;
  parentVersionId?: string | null;
  statement: string;
  status: string;
}

export interface RecallConflictContext {
  id: string;
  state: "pending";
  reason: string | null;
  claimIds: string[];
  claims: RecallConflictClaim[];
}

export interface LoadedRecallConflictContext {
  claimsByEntry: Map<string, RecallClaimContext[]>;
  conflicts: RecallConflictContext[];
}

export function applyRecallClaimRelevance(
  claims: readonly RecallClaimContext[],
  semanticScores: ReadonlyMap<string, number>
): RecallClaimContext[] {
  return claims.map((claim) => ({
    ...claim,
    queryRelevance: semanticScores.get(claim.id),
  }));
}

export async function linkPendingEntryConflictClaims(
  db: D1Database,
  input: { oldEntryId: string; newEntryId: string; asOf?: number }
): Promise<boolean> {
  const context = await loadRecallConflictContext(
    db,
    [input.oldEntryId, input.newEntryId],
    input.asOf ?? Date.now()
  );
  const oldClaims = context.claimsByEntry.get(input.oldEntryId) ?? [];
  const newClaims = context.claimsByEntry.get(input.newEntryId) ?? [];
  if (oldClaims.length !== 1 || newClaims.length !== 1) return false;
  const oldClaimId = oldClaims[0].id;
  const newClaimId = newClaims[0].id;
  const results = await db.batch([
    db.prepare(
      `UPDATE sb_conflict_cases
       SET old_claim_id = ?, new_claim_id = ?
       WHERE old_memory_id = ?
         AND new_memory_id = ?
         AND state = 'pending'
         AND old_claim_id IS NULL
         AND new_claim_id IS NULL`
    ).bind(oldClaimId, newClaimId, input.oldEntryId, input.newEntryId),
    db.prepare(
      `UPDATE sb_memories
       SET claim_status = 'contested'
       WHERE id IN (?, ?)
         AND EXISTS (
           SELECT 1 FROM sb_conflict_cases
           WHERE old_memory_id = ?
             AND new_memory_id = ?
             AND old_claim_id = ?
             AND new_claim_id = ?
             AND state = 'pending'
         )`
    ).bind(
      oldClaimId,
      newClaimId,
      input.oldEntryId,
      input.newEntryId,
      oldClaimId,
      newClaimId
    ),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1 &&
    Number(results[1]?.meta?.changes ?? 0) === 2;
}

interface ClaimRow {
  id: string;
  entry_id: string;
  parent_version_id: string | null;
  content: string;
  claim_status: string;
}

interface ConflictRow {
  id: string;
  old_claim_id: string;
  new_claim_id: string;
  reason: string | null;
}

function verificationStatus(status: string): RecallClaimContext["verificationStatus"] {
  if (status === "confirmed") return "confirmed";
  if (status === "contested") return "contested";
  return "supported";
}

async function loadEligibleClaims(
  db: D1Database,
  claimIds: string[],
  asOf: number
): Promise<ClaimRow[]> {
  if (claimIds.length === 0) return [];
  const placeholders = claimIds.map(() => "?").join(", ");
  const { results } = await db.prepare(
    `SELECT m.id, m.entry_id, m.parent_version_id, m.content, m.claim_status
     FROM sb_memories m
     WHERE m.id IN (${placeholders})
       AND m.entry_id IS NOT NULL
       AND m.content_hash IS NOT NULL
       AND ${activeMemoryClaimPredicate("m", String(asOf), { requireActiveParentLink: true })}
     ORDER BY m.created_at ASC, m.id ASC`
  ).bind(...claimIds).all<ClaimRow>();
  return results ?? [];
}

export async function loadRecallConflictContext(
  db: D1Database,
  entryIds: string[],
  asOf = Date.now()
): Promise<LoadedRecallConflictContext> {
  const uniqueEntryIds = [...new Set(entryIds.map(String).filter(Boolean))];
  if (uniqueEntryIds.length === 0) return { claimsByEntry: new Map(), conflicts: [] };

  const entryPlaceholders = uniqueEntryIds.map(() => "?").join(", ");
  const { results: matchedClaims } = await db.prepare(
    `SELECT m.id, m.entry_id, m.parent_version_id, m.content, m.claim_status
     FROM sb_memories m
     WHERE m.entry_id IN (${entryPlaceholders})
       AND m.content_hash IS NOT NULL
       AND ${activeMemoryClaimPredicate("m", String(asOf), { requireActiveParentLink: true })}
     ORDER BY m.created_at ASC, m.id ASC`
  ).bind(...uniqueEntryIds).all<ClaimRow>();
  const matchedClaimIds = [...new Set((matchedClaims ?? []).map((claim) => claim.id))];
  if (matchedClaimIds.length === 0) return { claimsByEntry: new Map(), conflicts: [] };

  const claimPlaceholders = matchedClaimIds.map(() => "?").join(", ");
  const { results: conflictRows } = await db.prepare(
    `SELECT id, old_claim_id, new_claim_id, reason
     FROM sb_conflict_cases
     WHERE state = 'pending'
       AND old_claim_id IS NOT NULL
       AND new_claim_id IS NOT NULL
       AND (old_claim_id IN (${claimPlaceholders}) OR new_claim_id IN (${claimPlaceholders}))
     ORDER BY created_at ASC, id ASC`
  ).bind(...matchedClaimIds, ...matchedClaimIds).all<ConflictRow>();

  const allConflictClaimIds = [...new Set((conflictRows ?? []).flatMap((row) => [
    row.old_claim_id,
    row.new_claim_id,
  ]))];
  const allClaims = new Map<string, ClaimRow>();
  for (const claim of matchedClaims ?? []) allClaims.set(claim.id, claim);
  for (const claim of await loadEligibleClaims(db, allConflictClaimIds, asOf)) {
    allClaims.set(claim.id, claim);
  }

  const conflicts = (conflictRows ?? []).flatMap((row): RecallConflictContext[] => {
    const oldClaim = allClaims.get(row.old_claim_id);
    const newClaim = allClaims.get(row.new_claim_id);
    if (!oldClaim || !newClaim) return [];
    return [{
      id: row.id,
      state: "pending",
      reason: row.reason,
      claimIds: [oldClaim.id, newClaim.id],
      claims: [oldClaim, newClaim].map((claim) => ({
        id: claim.id,
        entryId: claim.entry_id,
        parentVersionId: claim.parent_version_id,
        statement: claim.content,
        status: claim.claim_status,
      })),
    }];
  });

  const conflictsByClaim = new Map<string, RecallConflictContext[]>();
  for (const conflict of conflicts) {
    for (const claimId of conflict.claimIds) {
      const existing = conflictsByClaim.get(claimId) ?? [];
      conflictsByClaim.set(claimId, [...existing, conflict]);
    }
  }

  const claimsByEntry = new Map<string, RecallClaimContext[]>();
  for (const claim of matchedClaims ?? []) {
    const claimConflicts = conflictsByClaim.get(claim.id) ?? [];
    const context: RecallClaimContext = {
      id: claim.id,
      entryId: claim.entry_id,
      parentVersionId: claim.parent_version_id,
      statement: claim.content,
      status: claim.claim_status,
      verificationStatus: verificationStatus(claim.claim_status),
      conflictIds: claimConflicts.map((conflict) => conflict.id),
      opposingClaimIds: [...new Set(claimConflicts.flatMap((conflict) =>
        conflict.claimIds.filter((claimId) => claimId !== claim.id)
      ))],
    };
    const existing = claimsByEntry.get(claim.entry_id) ?? [];
    claimsByEntry.set(claim.entry_id, [...existing, context]);
  }

  return { claimsByEntry, conflicts };
}
