import { prepareMemoryRevision } from "./revisions";

const DERIVED_RELATION_TYPES = ["digest_of", "derived_from"] as const;
const QUERY_BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 50;
const VECTOR_DELETE_BATCH_SIZE = 1_000;
const MAX_DELETE_CLOSURE = 10_000;

export type ForgetMemoryResult =
  | { status: "not_found" }
  | { status: "delete_failed" }
  | {
      status: "deleted";
      vectorCount: number;
      derivedCount: number;
    };

interface EntryVectorRow {
  id: string;
  vector_ids: string;
  pending_vector_ids: string | null;
  pending_rebuild_id: string | null;
}

interface ForgetCleanupOptions {
  prepareVectorCleanup?: (vectorIds: string[], reason: string) => D1PreparedStatement[];
  queueVectorCleanup?: (vectorIds: string[], reason: string) => Promise<void>;
}

interface DigestSourceRow {
  id: string;
  content: string;
  tags: string;
  source: string;
}

interface AtomicGraphRows {
  memoryIds: string[];
  observationIds: string[];
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function parseVectorIds(raw: string): string[] | null {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) && value.every(item => typeof item === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}

function parseTags(raw: string): string[] | null {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) && value.every(item => typeof item === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}

function isMissingPendingEntryColumn(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such column:\s*pending_(vector_ids|rebuild_id)/i.test(message);
}

async function findDerivedClosure(db: D1Database, rootId: string): Promise<string[] | null> {
  const seen = new Set([rootId]);
  let frontier = [rootId];

  while (frontier.length) {
    const next: string[] = [];
    for (const batch of chunks(frontier, QUERY_BATCH_SIZE)) {
      const { results } = await db
        .prepare(
          `SELECT from_memory_id
           FROM sb_memory_relations
           WHERE relation_type IN ('${DERIVED_RELATION_TYPES.join("', '")}')
             AND to_memory_id IN (${placeholders(batch.length)})`
        )
        .bind(...batch)
        .all<{ from_memory_id: string }>();

      for (const row of results) {
        if (!row.from_memory_id || seen.has(row.from_memory_id)) continue;
        seen.add(row.from_memory_id);
        next.push(row.from_memory_id);
        if (seen.size > MAX_DELETE_CLOSURE) return null;
      }
    }
    frontier = next;
  }

  return [...seen];
}

async function loadTrackedEntries(
  db: D1Database,
  ids: string[]
): Promise<EntryVectorRow[]> {
  const rows: EntryVectorRow[] = [];
  for (const batch of chunks(ids, QUERY_BATCH_SIZE)) {
    let results: EntryVectorRow[];
    try {
      ({ results } = await db
        .prepare(
          `SELECT id, vector_ids, pending_vector_ids, pending_rebuild_id FROM entries
           WHERE id IN (${placeholders(batch.length)})`
        )
        .bind(...batch)
        .all<EntryVectorRow>());
    } catch (error) {
      if (!isMissingPendingEntryColumn(error)) throw error;
      ({ results } = await db
        .prepare(
          `SELECT id, vector_ids, NULL AS pending_vector_ids, NULL AS pending_rebuild_id
           FROM entries
           WHERE id IN (${placeholders(batch.length)})`
        )
        .bind(...batch)
        .all<EntryVectorRow>());
    }
    rows.push(...results);
  }
  return rows;
}

async function loadTrackedEntry(
  db: D1Database,
  id: string
): Promise<EntryVectorRow | null> {
  try {
    return await db
      .prepare(`SELECT id, vector_ids, pending_vector_ids, pending_rebuild_id FROM entries WHERE id = ?`)
      .bind(id)
      .first<EntryVectorRow>();
  } catch (error) {
    if (!isMissingPendingEntryColumn(error)) throw error;
    return await db
      .prepare(
        `SELECT id, vector_ids, NULL AS pending_vector_ids, NULL AS pending_rebuild_id
         FROM entries
         WHERE id = ?`
      )
      .bind(id)
      .first<EntryVectorRow>();
  }
}

async function loadSurvivingDigestSources(
  db: D1Database,
  deletingIds: string[]
): Promise<DigestSourceRow[] | null> {
  const deleting = new Set(deletingIds);
  const sourceIds = new Set<string>();
  for (const batch of chunks(deletingIds, QUERY_BATCH_SIZE)) {
    const { results } = await db
      .prepare(
        `SELECT to_memory_id
         FROM sb_memory_relations
         WHERE relation_type = 'digest_of'
           AND from_memory_id IN (${placeholders(batch.length)})`
      )
      .bind(...batch)
      .all<{ to_memory_id: string }>();
    for (const row of results) {
      if (row.to_memory_id && !deleting.has(row.to_memory_id)) {
        sourceIds.add(row.to_memory_id);
      }
    }
  }

  const rows: DigestSourceRow[] = [];
  for (const batch of chunks([...sourceIds], QUERY_BATCH_SIZE)) {
    const { results } = await db
      .prepare(
        `SELECT id, content, tags, source FROM entries
         WHERE id IN (${placeholders(batch.length)})`
      )
      .bind(...batch)
      .all<DigestSourceRow>();
    rows.push(...results);
  }
  return rows.every(row => parseTags(row.tags) !== null) ? rows : null;
}

async function loadAtomicGraphRows(
  db: D1Database,
  entryIds: string[]
): Promise<AtomicGraphRows> {
  const memoryIds = new Set<string>();
  for (const batch of chunks(entryIds, QUERY_BATCH_SIZE)) {
    const { results } = await db
      .prepare(
        `SELECT id FROM sb_memories
         WHERE entry_id IN (${placeholders(batch.length)})`
      )
      .bind(...batch)
      .all<{ id: string }>();
    for (const row of results) {
      if (row.id) memoryIds.add(row.id);
    }
  }

  const observationIds = new Set<string>();
  const allMemoryIds = [...memoryIds];
  for (const batch of chunks(allMemoryIds, QUERY_BATCH_SIZE)) {
    const { results } = await db
      .prepare(
        `SELECT observation_id FROM sb_memory_sources
         WHERE memory_id IN (${placeholders(batch.length)})`
      )
      .bind(...batch)
      .all<{ observation_id: string }>();
    for (const row of results) {
      if (row.observation_id) observationIds.add(row.observation_id);
    }
  }

  return {
    memoryIds: allMemoryIds,
    observationIds: [...observationIds],
  };
}

function prepareDatabaseErase(
  db: D1Database,
  ids: string[],
  survivingDigestSources: DigestSourceRow[],
  atomicGraph: AtomicGraphRows
) {
  const unrollStatements = survivingDigestSources.flatMap(row => {
    const oldTags = parseTags(row.tags) ?? [];
    if (!oldTags.includes("rolled-up")) return [];
    const nextTags = oldTags.filter(tag => tag !== "rolled-up");
    const revision = prepareMemoryRevision(db, {
      memoryId: row.id,
      eventType: "UNROLL",
      oldContent: row.content,
      newContent: row.content,
      oldMetadata: { tags: oldTags, source: row.source },
      newMetadata: { tags: nextTags, source: row.source },
      reason: "Derived digest was erased and must be rebuilt",
      actor: "system",
    });
    return [
      db.prepare(`UPDATE entries SET tags = ?, metadata_hash = NULL WHERE id = ?`)
        .bind(JSON.stringify(nextTags), row.id),
      revision.statement,
    ];
  });
  const atomicMemoryStatements = chunks(atomicGraph.memoryIds, DELETE_BATCH_SIZE).flatMap(batch => {
    const inList = placeholders(batch.length);
    return [
      db.prepare(
        `UPDATE sb_entity_relations
         SET evidence_count = (
               SELECT COUNT(*) FROM sb_fact_sources
               WHERE relation_id = sb_entity_relations.id
                 AND (memory_id IS NULL OR memory_id NOT IN (${inList}))
             ),
             memory_id = (
               SELECT memory_id FROM sb_fact_sources
               WHERE relation_id = sb_entity_relations.id
                 AND memory_id IS NOT NULL
                 AND memory_id NOT IN (${inList})
               ORDER BY created_at ASC
               LIMIT 1
             ),
             observation_id = (
               SELECT observation_id FROM sb_fact_sources
               WHERE relation_id = sb_entity_relations.id
                 AND (memory_id IS NULL OR memory_id NOT IN (${inList}))
                 AND observation_id IS NOT NULL
               ORDER BY created_at ASC
               LIMIT 1
             )
         WHERE id IN (
             SELECT relation_id FROM sb_fact_sources
             WHERE memory_id IN (${inList})
           )
           AND id IN (
             SELECT relation_id FROM sb_fact_sources
             WHERE memory_id IS NULL OR memory_id NOT IN (${inList})
           )`
      ).bind(...batch, ...batch, ...batch, ...batch, ...batch),
      db.prepare(
        `DELETE FROM sb_entity_relations
         WHERE (
             id IN (
               SELECT relation_id FROM sb_fact_sources
               WHERE memory_id IN (${inList})
             )
             AND id NOT IN (
               SELECT relation_id FROM sb_fact_sources
               WHERE memory_id IS NULL OR memory_id NOT IN (${inList})
             )
           )
           OR (
             memory_id IN (${inList})
             AND id NOT IN (SELECT relation_id FROM sb_fact_sources)
           )`
      ).bind(...batch, ...batch, ...batch),
      db.prepare(`DELETE FROM sb_fact_sources WHERE memory_id IN (${inList})`).bind(...batch),
      db.prepare(`DELETE FROM sb_memory_entities WHERE memory_id IN (${inList})`).bind(...batch),
      db.prepare(`DELETE FROM sb_memory_sources WHERE memory_id IN (${inList})`).bind(...batch),
      db.prepare(`DELETE FROM sb_memories WHERE id IN (${inList})`).bind(...batch),
    ];
  });
  const observationStatements = chunks(atomicGraph.observationIds, DELETE_BATCH_SIZE).map(batch => {
    const inList = placeholders(batch.length);
    return db
      .prepare(
        `DELETE FROM sb_observations
         WHERE id IN (${inList})
           AND NOT EXISTS (
             SELECT 1 FROM sb_memory_sources s
             WHERE s.observation_id = sb_observations.id
           )`
      )
      .bind(...batch);
  });
  const eraseStatements = chunks(ids, DELETE_BATCH_SIZE).flatMap(batch => {
    const inList = placeholders(batch.length);
    return [
      db
        .prepare(
          `DELETE FROM sb_memory_relations
           WHERE from_memory_id IN (${inList}) OR to_memory_id IN (${inList})`
        )
        .bind(...batch, ...batch),
      db
        .prepare(`DELETE FROM sb_memory_revisions WHERE memory_id IN (${inList})`)
        .bind(...batch),
      db.prepare(`DELETE FROM entries WHERE id IN (${inList})`).bind(...batch),
    ];
  });
  return [
    ...unrollStatements,
    ...atomicMemoryStatements,
    ...observationStatements,
    ...eraseStatements,
  ];
}

export async function forgetMemoryGraph(
  id: string,
  db: D1Database,
  vectorize: VectorizeIndex,
  options: ForgetCleanupOptions = {}
): Promise<ForgetMemoryResult> {
  const memoryId = id.trim();
  if (!memoryId) return { status: "not_found" };
  const root = await loadTrackedEntry(db, memoryId);
  if (!root) return { status: "not_found" };

  const closure = await findDerivedClosure(db, memoryId);
  if (!closure) return { status: "delete_failed" };

  const rows = await loadTrackedEntries(db, closure);
  const trackedIds = new Set(rows.map(row => row.id));
  if (!trackedIds.has(memoryId)) return { status: "delete_failed" };
  const survivingDigestSources = await loadSurvivingDigestSources(
    db,
    [...trackedIds]
  );
  if (!survivingDigestSources) return { status: "delete_failed" };
  const atomicGraph = await loadAtomicGraphRows(db, [...trackedIds]);

  const vectorIds: string[] = [];
  const rebuildExitCounts = new Map<string, number>();
  for (const row of rows) {
    const parsed = parseVectorIds(row.vector_ids);
    if (!parsed) return { status: "delete_failed" };
    vectorIds.push(...parsed);
    const pending = parseVectorIds(row.pending_vector_ids ?? "[]");
    if (!pending) return { status: "delete_failed" };
    vectorIds.push(...pending);
    if (row.pending_rebuild_id) {
      rebuildExitCounts.set(
        row.pending_rebuild_id,
        (rebuildExitCounts.get(row.pending_rebuild_id) ?? 0) + 1
      );
    }
  }
  const uniqueVectorIds = [...new Set(vectorIds)];

  let cleanupStatements: D1PreparedStatement[] = [];
  try {
    if (options.prepareVectorCleanup) {
      cleanupStatements = options.prepareVectorCleanup(uniqueVectorIds, "memory_forget");
    } else if (options.queueVectorCleanup) {
      await options.queueVectorCleanup(uniqueVectorIds, "memory_forget");
    } else {
      for (const batch of chunks(uniqueVectorIds, VECTOR_DELETE_BATCH_SIZE)) {
        await vectorize.deleteByIds(batch);
      }
    }
  } catch (error) {
    console.error("Vector cleanup preparation failed; database tracking was preserved:", error);
    return { status: "delete_failed" };
  }

  try {
    const now = Date.now();
    const rebuildExitStatements = [...rebuildExitCounts.entries()].map(([rebuildId, count]) =>
      db.prepare(
        `UPDATE sb_vector_rebuilds
         SET expected_entries = MAX(0, expected_entries - ?),
             updated_at = ?
         WHERE id = ?
           AND state IN ('queued', 'building', 'ready')`
      ).bind(count, now, rebuildId)
    );
    await db.batch([
      ...cleanupStatements,
      ...rebuildExitStatements,
      ...prepareDatabaseErase(db, [...trackedIds], survivingDigestSources, atomicGraph),
    ]);
  } catch (error) {
    console.error("Database erase failed after vector deletion; retry is safe:", error);
    return { status: "delete_failed" };
  }

  return {
    status: "deleted",
    vectorCount: uniqueVectorIds.length,
    derivedCount: Math.max(0, trackedIds.size - 1),
  };
}
