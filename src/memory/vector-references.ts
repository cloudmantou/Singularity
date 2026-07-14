export async function vectorStillReferenced(
  db: D1Database,
  vectorId: string
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS referenced
     FROM entries e, json_each(CASE WHEN json_valid(e.vector_ids) THEN e.vector_ids ELSE '[]' END) active
     WHERE active.value = ?
     UNION ALL
     SELECT 1 AS referenced
     FROM entries e, json_each(
       CASE
         WHEN json_valid(COALESCE(e.pending_vector_ids, '[]')) THEN COALESCE(e.pending_vector_ids, '[]')
         ELSE '[]'
       END
     ) pending
     WHERE pending.value = ?
     UNION ALL
     SELECT 1 AS referenced
     FROM sb_claim_vectors cv, json_each(
       CASE
         WHEN json_valid(cv.vector_ids_json) THEN cv.vector_ids_json
         ELSE '[]'
       END
     ) claim_vector
     WHERE claim_vector.value = ?
     LIMIT 1`
  ).bind(vectorId, vectorId, vectorId).first<{ referenced: number }>();
  return Boolean(row?.referenced);
}
