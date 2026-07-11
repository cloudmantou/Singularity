export const MEMORY_REVISION_EVENTS = [
  "ADD",
  "UPDATE",
  "APPEND",
  "STATUS",
  "CLASSIFY",
  "DEPRECATE",
  "ROLLUP",
  "UNROLL",
] as const;

export type MemoryRevisionEvent = (typeof MEMORY_REVISION_EVENTS)[number];

export interface MemoryRevisionInput {
  memoryId: string;
  eventType: MemoryRevisionEvent;
  oldContent?: string | null;
  newContent?: string | null;
  oldMetadata?: Record<string, unknown> | null;
  newMetadata?: Record<string, unknown> | null;
  reason?: string | null;
  actor: string;
  createdAt?: number;
}

function metadataJson(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}

export interface MemoryRevisionRecord extends MemoryRevisionInput {
  id: string;
  createdAt: number;
}

export interface MemoryRevisionGuard {
  /** JSON-encoded vector generation that must be active after the write. */
  activeVectorIdsJson: string;
}

function buildMemoryRevision(input: MemoryRevisionInput): MemoryRevisionRecord {
  const memoryId = input.memoryId.trim();
  const actor = input.actor.trim();
  if (!memoryId || !actor) {
    throw new Error("Memory revision requires memoryId and actor");
  }

  return {
    ...input,
    memoryId,
    actor,
    id: crypto.randomUUID(),
    createdAt: input.createdAt ?? Date.now(),
  };
}

function revisionStatement(
  db: D1Database,
  revision: MemoryRevisionRecord,
  guard?: MemoryRevisionGuard
) {
  const insert = `INSERT INTO sb_memory_revisions (
        id, memory_id, event_type, old_content, new_content,
        old_metadata_json, new_metadata_json, reason, actor, created_at
      )`;
  const values = [
    revision.id,
    revision.memoryId,
    revision.eventType,
    revision.oldContent ?? null,
    revision.newContent ?? null,
    metadataJson(revision.oldMetadata),
    metadataJson(revision.newMetadata),
    revision.reason ?? null,
    revision.actor,
    revision.createdAt,
  ];

  if (guard) {
    return db
      .prepare(
        `${insert}
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM entries WHERE id = ? AND vector_ids = ?
         )`
      )
      .bind(...values, revision.memoryId, guard.activeVectorIdsJson);
  }

  return db
    .prepare(
      `${insert} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(...values);
}

export function prepareMemoryRevision(
  db: D1Database,
  input: MemoryRevisionInput,
  guard?: MemoryRevisionGuard
) {
  const record = buildMemoryRevision(input);
  return { record, statement: revisionStatement(db, record, guard) };
}
