/** SQL predicates shared by Recall, Graph APIs, and external projections. */
export function activeMemoryClaimPredicate(
  memoryRef: string,
  asOfExpression: string,
  options: { requireActiveParentLink?: boolean } = {}
): string {
  const activeParentLink = `EXISTS (
    SELECT 1
    FROM sb_parent_version_claims pvc_active
    JOIN sb_parent_versions pv_active
      ON pv_active.version_id = pvc_active.parent_version_id
    JOIN sb_parent_units pu_active
      ON pu_active.active_version_id = pv_active.version_id
     AND pu_active.parent_id = pv_active.parent_id
    WHERE pvc_active.memory_id = ${memoryRef}.id
      AND pvc_active.relation = 'supports'
      AND pv_active.state IN ('active', 'active_degraded')
  )`;
  const parentEligibility = options.requireActiveParentLink
    ? activeParentLink
    : `(
      ${activeParentLink}
      OR (
        NOT EXISTS (
          SELECT 1
          FROM sb_parent_version_claims pvc_any
          WHERE pvc_any.memory_id = ${memoryRef}.id
        )
        AND (
          ${memoryRef}.parent_version_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM sb_parent_versions pv_legacy
            JOIN sb_parent_units pu_legacy
              ON pu_legacy.active_version_id = pv_legacy.version_id
             AND pu_legacy.parent_id = pv_legacy.parent_id
            WHERE pv_legacy.version_id = ${memoryRef}.parent_version_id
              AND pv_legacy.state IN ('active', 'active_degraded')
          )
        )
      )
    )`;
  return `(
    (
      ${memoryRef}.claim_status IN ('supported', 'confirmed', 'contested')
      OR (
        ${memoryRef}.claim_status IN ('superseded', 'deprecated')
        AND ${memoryRef}.invalid_at IS NOT NULL
        AND ${memoryRef}.invalid_at > ${asOfExpression}
      )
    )
    AND (${memoryRef}.valid_from IS NULL OR ${memoryRef}.valid_from <= ${asOfExpression})
    AND (${memoryRef}.valid_to IS NULL OR ${memoryRef}.valid_to > ${asOfExpression})
    AND (${memoryRef}.invalid_at IS NULL OR ${memoryRef}.invalid_at > ${asOfExpression})
    AND (${memoryRef}.expired_at IS NULL OR ${memoryRef}.expired_at > ${asOfExpression})
    AND EXISTS (
      SELECT 1
      FROM sb_memory_sources ms_active
      JOIN sb_observations o_active
        ON o_active.id = ms_active.observation_id
      WHERE ms_active.memory_id = ${memoryRef}.id
        AND (
          ms_active.relation IN ('supports', 'derived_from')
          OR ms_active.role IN ('supports', 'derived_from')
        )
        AND o_active.content_hash IS NOT NULL
    )
    AND ${parentEligibility}
  )`;
}

export function eligibleRelationClaimPredicate(
  relationRef: string,
  asOfExpression: string
): string {
  return `(
    EXISTS (
      SELECT 1
      FROM sb_fact_sources fs_eligible
      JOIN sb_memories m_eligible ON m_eligible.id = fs_eligible.memory_id
      JOIN entries e_eligible
        ON e_eligible.id = m_eligible.entry_id
       AND e_eligible.content_hash = m_eligible.content_hash
      WHERE fs_eligible.relation_id = ${relationRef}.id
        AND m_eligible.content_hash IS NOT NULL
        AND ${activeMemoryClaimPredicate("m_eligible", asOfExpression, { requireActiveParentLink: true })}
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM sb_fact_sources fs_any
        WHERE fs_any.relation_id = ${relationRef}.id
      )
      AND EXISTS (
        SELECT 1
        FROM sb_memories m_legacy_eligible
        JOIN entries e_legacy_eligible
          ON e_legacy_eligible.id = m_legacy_eligible.entry_id
         AND e_legacy_eligible.content_hash = m_legacy_eligible.content_hash
        WHERE m_legacy_eligible.id = ${relationRef}.memory_id
          AND m_legacy_eligible.content_hash IS NOT NULL
          AND ${activeMemoryClaimPredicate("m_legacy_eligible", asOfExpression, { requireActiveParentLink: true })}
      )
    )
  )`;
}
