import { activeMemoryClaimPredicate } from "./claim-eligibility";

type FactRelationIdSql = "?" | "sb_entity_relations.id";

interface DistinctFactEvidenceCountSqlOptions {
  relationIdSql: FactRelationIdSql;
  excludeMemoryIdCount?: number;
  activeMemoriesOnly?: boolean;
  asOf?: number;
  floorAtOne?: boolean;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function distinctFactEvidenceCountSql(
  options: DistinctFactEvidenceCountSqlOptions
): string {
  const excludeMemoryIdCount = options.excludeMemoryIdCount ?? 0;
  if (!Number.isSafeInteger(excludeMemoryIdCount) || excludeMemoryIdCount < 0) {
    throw new Error("excludeMemoryIdCount must be a non-negative safe integer");
  }
  const asOf = options.asOf ?? Date.now();
  if (!Number.isSafeInteger(asOf) || asOf < 0) {
    throw new Error("asOf must be a non-negative safe integer");
  }
  const asOfSql = String(asOf);

  const activeMemoryJoin = options.activeMemoriesOnly
    ? `LEFT JOIN sb_memories m_count ON m_count.id = fs_count.memory_id
       LEFT JOIN entries e_count
         ON e_count.id = m_count.entry_id
        AND e_count.content_hash = m_count.content_hash`
    : "";
  const activeMemoryFilter = options.activeMemoriesOnly
    ? `AND (
         fs_count.memory_id IS NULL
         OR (
           m_count.id IS NOT NULL
           AND m_count.content_hash IS NOT NULL
           AND e_count.id IS NOT NULL
           AND ${activeMemoryClaimPredicate("m_count", asOfSql, { requireActiveParentLink: true })}
           AND NOT EXISTS (
             SELECT 1
             FROM sb_conflict_cases c_count
             WHERE c_count.state = 'pending'
               AND (
                 c_count.old_claim_id = m_count.id
                 OR c_count.new_claim_id = m_count.id
               )
           )
         )
       )`
    : "";
  const excludedMemoryFilter = excludeMemoryIdCount > 0
    ? `AND (
         fs_count.memory_id IS NULL
         OR fs_count.memory_id NOT IN (${placeholders(excludeMemoryIdCount)})
       )`
    : "";
  const countSql = `(
    SELECT COUNT(DISTINCT COALESCE(
      ms_count.evidence_root_id,
      o_count.root_evidence_id,
      ms_count.observation_id,
      fs_count.observation_id,
      CASE WHEN fs_count.memory_id IS NOT NULL THEN 'memory:' || fs_count.memory_id END,
      'fact-source:' || fs_count.id
    ))
    FROM sb_fact_sources fs_count
    LEFT JOIN sb_memory_sources ms_count
      ON ms_count.memory_id = fs_count.memory_id
     AND ms_count.relation IN ('supports', 'derived_from')
    LEFT JOIN sb_observations o_count
      ON o_count.id = COALESCE(ms_count.observation_id, fs_count.observation_id)
    ${activeMemoryJoin}
    WHERE fs_count.relation_id = ${options.relationIdSql}
      ${activeMemoryFilter}
      ${excludedMemoryFilter}
  )`;

  return options.floorAtOne ? `MAX(1, ${countSql})` : countSql;
}
