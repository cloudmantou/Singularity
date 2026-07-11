/**
 * Entity + temporal fact-edge layer (Graphiti-inspired, SQLite-native).
 *
 *   Observation → Atomic Memory → Entity (mentions)
 *                              → EntityRelation (fact edges with validity)
 */

export const ENTITY_TYPE_VALUES = [
  "person",
  "project",
  "organization",
  "place",
  "product",
  "concept",
  "other",
] as const;

export type EntityType = (typeof ENTITY_TYPE_VALUES)[number];

export const ENTITY_RELATION_TYPES = [
  "related_to",
  "uses",
  "part_of",
  "owns",
  "works_on",
  "depends_on",
  "created",
  "located_in",
  "mentions",
  "same_as",
] as const;

export type EntityRelationType = (typeof ENTITY_RELATION_TYPES)[number];

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPE_VALUES);
const ENTITY_RELATION_SET = new Set<string>(ENTITY_RELATION_TYPES);

export function normalizeEntityName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeEntityType(raw: unknown): EntityType | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (ENTITY_TYPE_SET.has(v)) return v as EntityType;
  if (v === "org" || v === "company") return "organization";
  if (v === "location" || v === "city" || v === "country") return "place";
  if (v === "tool" || v === "library" || v === "framework") return "product";
  if (v === "topic" || v === "tech") return "concept";
  if (v === "user" || v === "people") return "person";
  return null;
}

export function normalizeEntityRelationType(raw: unknown): EntityRelationType {
  if (typeof raw !== "string") return "related_to";
  const v = raw.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  if (ENTITY_RELATION_SET.has(v)) return v as EntityRelationType;
  if (v === "use" || v === "using") return "uses";
  if (v === "partof" || v === "belongs_to") return "part_of";
  if (v === "workson" || v === "works") return "works_on";
  if (v === "dependson" || v === "depends") return "depends_on";
  if (v === "in" || v === "at") return "located_in";
  return "related_to";
}

export interface EntityDraft {
  name: string;
  entityType: EntityType | null;
}

export interface EntityRelationDraft {
  from: string;
  to: string;
  relationType: EntityRelationType;
  fact?: string | null;
}

export function parseEntityList(raw: unknown): EntityDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: EntityDraft[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name.length < 1 || name.length > 120) continue;
      const key = normalizeEntityName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, entityType: null });
      continue;
    }
    if (item && typeof item === "object") {
      const name = String((item as any).name ?? (item as any).text ?? "").trim();
      if (name.length < 1 || name.length > 120) continue;
      const key = normalizeEntityName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        entityType: normalizeEntityType((item as any).type ?? (item as any).entity_type),
      });
    }
    if (out.length >= 16) break;
  }
  return out;
}

export function parseEntityRelationList(raw: unknown): EntityRelationDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: EntityRelationDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const from = String((item as any).from ?? (item as any).source ?? "").trim();
    const to = String((item as any).to ?? (item as any).target ?? "").trim();
    if (!from || !to || from === to) continue;
    out.push({
      from,
      to,
      relationType: normalizeEntityRelationType(
        (item as any).type ?? (item as any).relation ?? (item as any).relation_type
      ),
      fact: typeof (item as any).fact === "string" ? (item as any).fact.slice(0, 500) : null,
    });
    if (out.length >= 16) break;
  }
  return out;
}

export const ENTITY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL,
    entity_type TEXT,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    mention_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(name_normalized)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_entities_name
    ON sb_entities(name_normalized)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_entities_type
    ON sb_entities(entity_type, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_memory_entities (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'mentions',
    score REAL,
    created_at INTEGER NOT NULL,
    UNIQUE(memory_id, entity_id, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_entities_memory
    ON sb_memory_entities(memory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_entities_entity
    ON sb_memory_entities(entity_id)`,
  `CREATE TABLE IF NOT EXISTS sb_entity_relations (
    id TEXT PRIMARY KEY,
    from_entity_id TEXT NOT NULL,
    to_entity_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    fact TEXT,
    memory_id TEXT,
    observation_id TEXT,
    score REAL,
    valid_from INTEGER,
    valid_to INTEGER,
    invalid_at INTEGER,
    reference_time INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_from
    ON sb_entity_relations(from_entity_id, relation_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_to
    ON sb_entity_relations(to_entity_id, relation_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_memory
    ON sb_entity_relations(memory_id)`,
  // Temporal fields on atomic memories (idempotent ALTERs applied in ensure path).
] as const;

export async function ensureEntityDataModel(db: D1Database): Promise<void> {
  for (const statement of ENTITY_SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
  for (const alter of [
    `ALTER TABLE sb_memories ADD COLUMN reference_time INTEGER`,
    `ALTER TABLE sb_memories ADD COLUMN invalid_at INTEGER`,
  ]) {
    try {
      await db.exec(alter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
}

export async function upsertEntity(
  db: D1Database,
  draft: EntityDraft,
  now: number
): Promise<{ id: string; name: string; created: boolean }> {
  const name = draft.name.trim();
  const nameNormalized = normalizeEntityName(name);
  const existing = await db
    .prepare(
      `SELECT id, name, entity_type, mention_count FROM sb_entities WHERE name_normalized = ?`
    )
    .bind(nameNormalized)
    .first<{ id: string; name: string; entity_type: string | null; mention_count: number }>();

  if (existing) {
    const nextType = draft.entityType ?? existing.entity_type;
    await db
      .prepare(
        `UPDATE sb_entities
         SET mention_count = COALESCE(mention_count, 0) + 1,
             entity_type = COALESCE(?, entity_type),
             updated_at = ?
         WHERE id = ?`
      )
      .bind(nextType, now, existing.id)
      .run();
    return { id: existing.id, name: existing.name, created: false };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO sb_entities (
         id, name, name_normalized, entity_type, aliases_json, metadata_json,
         mention_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '[]', '{}', 1, ?, ?)`
    )
    .bind(id, name, nameNormalized, draft.entityType, now, now)
    .run();
  return { id, name, created: true };
}

export async function linkMemoryEntity(
  db: D1Database,
  input: {
    memoryId: string;
    entityId: string;
    role?: string;
    score?: number | null;
    createdAt: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sb_memory_entities (id, memory_id, entity_id, role, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, entity_id, role) DO UPDATE SET
         score = COALESCE(excluded.score, sb_memory_entities.score)`
    )
    .bind(
      crypto.randomUUID(),
      input.memoryId,
      input.entityId,
      input.role ?? "mentions",
      input.score ?? null,
      input.createdAt
    )
    .run();
}

export async function insertEntityRelation(
  db: D1Database,
  input: {
    fromEntityId: string;
    toEntityId: string;
    relationType: EntityRelationType;
    fact?: string | null;
    memoryId?: string | null;
    observationId?: string | null;
    score?: number | null;
    validFrom?: number | null;
    validTo?: number | null;
    invalidAt?: number | null;
    referenceTime?: number | null;
    metadata?: Record<string, unknown>;
    createdAt: number;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO sb_entity_relations (
         id, from_entity_id, to_entity_id, relation_type, fact,
         memory_id, observation_id, score,
         valid_from, valid_to, invalid_at, reference_time,
         metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.fromEntityId,
      input.toEntityId,
      input.relationType,
      input.fact ?? null,
      input.memoryId ?? null,
      input.observationId ?? null,
      input.score ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
      input.invalidAt ?? null,
      input.referenceTime ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt
    )
    .run();
  return id;
}

/** Upsert entities, link to memory, and write optional fact edges. */
export async function attachEntitiesToMemory(
  db: D1Database,
  input: {
    memoryId: string;
    observationId?: string | null;
    entities: EntityDraft[];
    relations?: EntityRelationDraft[];
    score?: number | null;
    validFrom?: number | null;
    validTo?: number | null;
    referenceTime?: number | null;
    createdAt: number;
  }
): Promise<{ entityIds: string[]; relationIds: string[] }> {
  const entityIds: string[] = [];
  const byNormalized = new Map<string, string>();

  for (const draft of input.entities) {
    const upserted = await upsertEntity(db, draft, input.createdAt);
    byNormalized.set(normalizeEntityName(draft.name), upserted.id);
    entityIds.push(upserted.id);
    await linkMemoryEntity(db, {
      memoryId: input.memoryId,
      entityId: upserted.id,
      role: "mentions",
      score: input.score ?? null,
      createdAt: input.createdAt,
    });
  }

  const relationIds: string[] = [];
  for (const rel of input.relations ?? []) {
    const fromKey = normalizeEntityName(rel.from);
    const toKey = normalizeEntityName(rel.to);
    let fromId = byNormalized.get(fromKey);
    let toId = byNormalized.get(toKey);
    if (!fromId) {
      const created = await upsertEntity(db, { name: rel.from, entityType: null }, input.createdAt);
      fromId = created.id;
      byNormalized.set(fromKey, fromId);
      entityIds.push(fromId);
      await linkMemoryEntity(db, {
        memoryId: input.memoryId,
        entityId: fromId,
        role: "mentions",
        score: input.score ?? null,
        createdAt: input.createdAt,
      });
    }
    if (!toId) {
      const created = await upsertEntity(db, { name: rel.to, entityType: null }, input.createdAt);
      toId = created.id;
      byNormalized.set(toKey, toId);
      entityIds.push(toId);
      await linkMemoryEntity(db, {
        memoryId: input.memoryId,
        entityId: toId,
        role: "mentions",
        score: input.score ?? null,
        createdAt: input.createdAt,
      });
    }
    if (fromId === toId) continue;
    const relationId = await insertEntityRelation(db, {
      fromEntityId: fromId,
      toEntityId: toId,
      relationType: rel.relationType,
      fact: rel.fact ?? null,
      memoryId: input.memoryId,
      observationId: input.observationId ?? null,
      score: input.score ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      referenceTime: input.referenceTime ?? input.createdAt,
      createdAt: input.createdAt,
    });
    relationIds.push(relationId);
  }

  // Co-mentioned entities without explicit edges still form a weak related_to clique
  // only when ≥2 entities and no explicit relations were provided.
  if ((input.relations?.length ?? 0) === 0 && entityIds.length >= 2 && entityIds.length <= 6) {
    const unique = [...new Set(entityIds)];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const relationId = await insertEntityRelation(db, {
          fromEntityId: unique[i],
          toEntityId: unique[j],
          relationType: "related_to",
          fact: null,
          memoryId: input.memoryId,
          observationId: input.observationId ?? null,
          score: Math.max(0, Math.min(1, (input.score ?? 0.5) * 0.5)),
          validFrom: input.validFrom ?? null,
          validTo: input.validTo ?? null,
          referenceTime: input.referenceTime ?? input.createdAt,
          metadata: { automatic: true, co_mention: true },
          createdAt: input.createdAt,
        });
        relationIds.push(relationId);
      }
    }
  }

  return { entityIds: [...new Set(entityIds)], relationIds };
}

export async function listEntities(
  db: D1Database,
  opts: { q?: string; limit?: number } = {}
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.q?.trim()) {
    const q = `%${normalizeEntityName(opts.q)}%`;
    const { results } = await db
      .prepare(
        `SELECT id, name, name_normalized, entity_type, mention_count, created_at, updated_at
         FROM sb_entities
         WHERE name_normalized LIKE ?
         ORDER BY mention_count DESC, updated_at DESC
         LIMIT ?`
      )
      .bind(q, limit)
      .all();
    return (results ?? []) as Array<Record<string, unknown>>;
  }
  const { results } = await db
    .prepare(
      `SELECT id, name, name_normalized, entity_type, mention_count, created_at, updated_at
       FROM sb_entities
       ORDER BY mention_count DESC, updated_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();
  return (results ?? []) as Array<Record<string, unknown>>;
}

export async function getEntityGraph(
  db: D1Database,
  entityId: string,
  limit = 50
): Promise<{
  entity: Record<string, unknown> | null;
  relations: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
}> {
  const entity = await db
    .prepare(
      `SELECT id, name, name_normalized, entity_type, aliases_json, metadata_json,
              mention_count, created_at, updated_at
       FROM sb_entities WHERE id = ?`
    )
    .bind(entityId)
    .first<Record<string, unknown>>();

  if (!entity) {
    return { entity: null, relations: [], memories: [] };
  }

  const { results: relations } = await db
    .prepare(
      `SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation_type, r.fact, r.memory_id,
              r.observation_id, r.score, r.valid_from, r.valid_to, r.invalid_at, r.reference_time,
              r.created_at,
              fe.name AS from_name, te.name AS to_name
       FROM sb_entity_relations r
       JOIN sb_entities fe ON fe.id = r.from_entity_id
       JOIN sb_entities te ON te.id = r.to_entity_id
       WHERE r.from_entity_id = ? OR r.to_entity_id = ?
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .bind(entityId, entityId, limit)
    .all();

  const { results: memories } = await db
    .prepare(
      `SELECT m.id, m.content, m.kind, m.memory_class, m.importance, m.confidence,
              m.entry_id, m.observed_at, m.valid_from, m.valid_to, m.reference_time,
              m.invalid_at, m.created_at, me.role
       FROM sb_memory_entities me
       JOIN sb_memories m ON m.id = me.memory_id
       WHERE me.entity_id = ?
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .bind(entityId, limit)
    .all();

  return {
    entity,
    relations: (relations ?? []) as Array<Record<string, unknown>>,
    memories: (memories ?? []) as Array<Record<string, unknown>>,
  };
}

/** Active facts: invalid_at IS NULL and (valid_to IS NULL OR valid_to > asOf). */
export async function listActiveEntityRelations(
  db: D1Database,
  opts: { entityId?: string; asOf?: number; limit?: number } = {}
): Promise<Array<Record<string, unknown>>> {
  const asOf = opts.asOf ?? Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.entityId) {
    const { results } = await db
      .prepare(
        `SELECT r.*, fe.name AS from_name, te.name AS to_name
         FROM sb_entity_relations r
         JOIN sb_entities fe ON fe.id = r.from_entity_id
         JOIN sb_entities te ON te.id = r.to_entity_id
         WHERE (r.from_entity_id = ? OR r.to_entity_id = ?)
           AND r.invalid_at IS NULL
           AND (r.valid_from IS NULL OR r.valid_from <= ?)
           AND (r.valid_to IS NULL OR r.valid_to > ?)
         ORDER BY r.created_at DESC
         LIMIT ?`
      )
      .bind(opts.entityId, opts.entityId, asOf, asOf, limit)
      .all();
    return (results ?? []) as Array<Record<string, unknown>>;
  }
  const { results } = await db
    .prepare(
      `SELECT r.*, fe.name AS from_name, te.name AS to_name
       FROM sb_entity_relations r
       JOIN sb_entities fe ON fe.id = r.from_entity_id
       JOIN sb_entities te ON te.id = r.to_entity_id
       WHERE r.invalid_at IS NULL
         AND (r.valid_from IS NULL OR r.valid_from <= ?)
         AND (r.valid_to IS NULL OR r.valid_to > ?)
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .bind(asOf, asOf, limit)
    .all();
  return (results ?? []) as Array<Record<string, unknown>>;
}
