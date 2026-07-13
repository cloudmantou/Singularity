/**
 * Entity + temporal fact-edge layer (Graphiti-inspired, SQLite-native).
 *
 *   Observation → Atomic Memory → Entity (mentions)
 *                              → EntityRelation (fact edges with validity)
 */

import {
  D1EntityResolver,
  ENTITY_RESOLUTION_SCHEMA_STATEMENTS,
  type EntityExternalId,
} from "./entity-resolution";
import {
  FACT_RESOLUTION_SCHEMA_STATEMENTS,
} from "./fact-resolution";
import { insertEntityRelation as insertResolvedEntityRelation } from "./fact-resolution-store";
import {
  activeMemoryClaimPredicate,
  eligibleRelationClaimPredicate,
} from "./claim-eligibility";
export {
  normalizeEntityFactKey,
  temporalWindowsOverlap,
} from "./fact-resolution-store";

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
  aliases?: string[];
  externalIds?: EntityExternalId[];
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
        aliases: Array.isArray((item as any).aliases)
          ? (item as any).aliases.map(String).map((alias: string) => alias.trim()).filter(Boolean).slice(0, 16)
          : [],
        externalIds: Array.isArray((item as any).external_ids)
          ? (item as any).external_ids.flatMap((externalId: unknown) => {
              if (!externalId || typeof externalId !== "object") return [];
              const provider = String((externalId as any).provider ?? "").trim();
              const value = String((externalId as any).value ?? (externalId as any).id ?? "").trim();
              return provider && value ? [{ provider, value }] : [];
            }).slice(0, 16)
          : [],
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
    lifecycle_state TEXT NOT NULL DEFAULT 'active',
    merged_into_entity_id TEXT,
    merged_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (lifecycle_state IN ('active', 'merged')),
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
    fact_hash TEXT,
    evidence_count INTEGER NOT NULL DEFAULT 1,
    memory_id TEXT,
    observation_id TEXT,
    score REAL,
    valid_from INTEGER,
    valid_to INTEGER,
    invalid_at INTEGER,
    expired_at INTEGER,
    reference_time INTEGER,
    scope_id TEXT,
    polarity TEXT NOT NULL DEFAULT 'positive',
    modality TEXT NOT NULL DEFAULT 'asserted',
    resolution_type TEXT NOT NULL DEFAULT 'coexists',
    resolution_state TEXT NOT NULL DEFAULT 'active',
    supersedes_relation_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_from
    ON sb_entity_relations(from_entity_id, relation_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_to
    ON sb_entity_relations(to_entity_id, relation_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_memory
    ON sb_entity_relations(memory_id)`,
  `CREATE TABLE IF NOT EXISTS sb_fact_sources (
    id TEXT PRIMARY KEY,
    relation_id TEXT NOT NULL,
    memory_id TEXT,
    observation_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(relation_id, memory_id, observation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_fact_sources_relation
    ON sb_fact_sources(relation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_fact_sources_memory
    ON sb_fact_sources(memory_id)`,
  // Temporal fields on atomic memories (idempotent ALTERs applied in ensure path).
] as const;

export async function ensureEntityDataModel(db: D1Database): Promise<void> {
  for (const statement of ENTITY_SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
  await db.exec(
    `DELETE FROM sb_fact_sources
     WHERE rowid NOT IN (
       SELECT MIN(rowid)
       FROM sb_fact_sources
       GROUP BY
         relation_id,
         COALESCE(memory_id, ''),
         COALESCE(observation_id, '')
     )`
  );
  const entityColumns = await db.prepare(
    `PRAGMA table_info(sb_entities)`
  ).all<{ name: string }>();
  const existingEntityColumns = new Set((entityColumns.results ?? []).map((row) => row.name));
  for (const migration of [
    { column: "lifecycle_state", sql: `ALTER TABLE sb_entities ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'` },
    { column: "merged_into_entity_id", sql: `ALTER TABLE sb_entities ADD COLUMN merged_into_entity_id TEXT` },
    { column: "merged_at", sql: `ALTER TABLE sb_entities ADD COLUMN merged_at INTEGER` },
  ]) {
    if (existingEntityColumns.has(migration.column)) continue;
    try {
      await db.exec(migration.sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_sources_identity
     ON sb_fact_sources (
       relation_id,
       COALESCE(memory_id, ''),
       COALESCE(observation_id, '')
     )`
  );
  const relationColumns = await db.prepare(
    `PRAGMA table_info(sb_entity_relations)`
  ).all<{ name: string }>();
  const existingColumns = new Set((relationColumns.results ?? []).map((row) => row.name));
  for (const migration of [
    { column: "expired_at", sql: `ALTER TABLE sb_entity_relations ADD COLUMN expired_at INTEGER` },
    { column: "fact_hash", sql: `ALTER TABLE sb_entity_relations ADD COLUMN fact_hash TEXT` },
    { column: "evidence_count", sql: `ALTER TABLE sb_entity_relations ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1` },
    { column: "scope_id", sql: `ALTER TABLE sb_entity_relations ADD COLUMN scope_id TEXT` },
    { column: "polarity", sql: `ALTER TABLE sb_entity_relations ADD COLUMN polarity TEXT NOT NULL DEFAULT 'positive'` },
    { column: "modality", sql: `ALTER TABLE sb_entity_relations ADD COLUMN modality TEXT NOT NULL DEFAULT 'asserted'` },
    { column: "resolution_type", sql: `ALTER TABLE sb_entity_relations ADD COLUMN resolution_type TEXT NOT NULL DEFAULT 'coexists'` },
    { column: "resolution_state", sql: `ALTER TABLE sb_entity_relations ADD COLUMN resolution_state TEXT NOT NULL DEFAULT 'active'` },
    { column: "supersedes_relation_id", sql: `ALTER TABLE sb_entity_relations ADD COLUMN supersedes_relation_id TEXT` },
  ]) {
    if (existingColumns.has(migration.column)) continue;
    try {
      await db.exec(migration.sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_fact_hash
      ON sb_entity_relations(from_entity_id, to_entity_id, relation_type, fact_hash)`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_resolution
      ON sb_entity_relations(from_entity_id, relation_type, scope_id, resolution_state, created_at DESC)`
  );
}

/** Heavy resolver tables are initialized only when resolution-backed features run. */
export async function ensureEntityResolutionDataModel(db: D1Database): Promise<void> {
  const resolutionSchemaExists = await db.prepare(
    `SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'sb_entity_aliases'
     LIMIT 1`
  ).first<{ "1": number }>();
  if (!resolutionSchemaExists) {
    await db.exec(
      [...ENTITY_RESOLUTION_SCHEMA_STATEMENTS, ...FACT_RESOLUTION_SCHEMA_STATEMENTS].join(";\n")
    );
  } else {
    await db.exec(
      `UPDATE sb_fact_resolutions
       SET target_relation_id = NULL,
           requires_review = 1
       WHERE target_relation_id = relation_id`
    );
  }
}

export async function upsertEntity(
  db: D1Database,
  draft: EntityDraft,
  now: number,
  context: {
    observationId?: string | null;
    embedding?: number[] | null;
    embeddingFingerprint?: string | null;
  } = {}
): Promise<{ id: string; name: string; created: boolean }> {
  const resolved = await new D1EntityResolver(db).resolve(draft, {
    now,
    observationId: context.observationId ?? null,
    embedding: context.embedding ?? null,
    embeddingFingerprint: context.embeddingFingerprint ?? null,
  });
  return {
    id: resolved.entityId,
    name: resolved.canonicalName,
    created: resolved.created,
  };
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
    scopeId?: string | null;
    polarity?: string | null;
    modality?: string | null;
    resolveEntityEmbeddings?: (names: string[]) => Promise<{
      embeddings: Map<string, number[]>;
      fingerprint: string;
    } | null>;
    createdAt: number;
  }
): Promise<{ entityIds: string[]; relationIds: string[] }> {
  await ensureEntityResolutionDataModel(db);
  const entityIds: string[] = [];
  const byNormalized = new Map<string, string>();
  const entityResolver = new D1EntityResolver(db);
  const names = [...new Set(input.entities.map((draft) => draft.name.trim()).filter(Boolean))];
  const embeddingBatch = input.resolveEntityEmbeddings
    ? await input.resolveEntityEmbeddings(names).catch(() => null)
    : null;

  for (const draft of input.entities) {
    const resolved = await entityResolver.resolve(draft, {
      now: input.createdAt,
      observationId: input.observationId ?? null,
      embedding: embeddingBatch?.embeddings.get(draft.name.trim()) ?? null,
      embeddingFingerprint: embeddingBatch?.fingerprint ?? null,
    });
    const upserted = {
      id: resolved.entityId,
      name: resolved.canonicalName,
      created: resolved.created,
    };
    byNormalized.set(normalizeEntityName(draft.name), upserted.id);
    for (const alias of draft.aliases ?? []) {
      byNormalized.set(normalizeEntityName(alias), upserted.id);
    }
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
    const relationId = await insertResolvedEntityRelation(db, {
      fromEntityId: fromId,
      toEntityId: toId,
      relationType: rel.relationType,
      fact: rel.fact ?? null,
      memoryId: input.memoryId,
      observationId: input.observationId ?? null,
      score: input.score ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      referenceTime: input.referenceTime ?? null,
      scopeId: input.scopeId ?? null,
      polarity: input.polarity ?? "positive",
      modality: input.modality ?? "asserted",
      createdAt: input.createdAt,
    });
    relationIds.push(relationId);
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
           AND lifecycle_state = 'active'
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
       WHERE lifecycle_state = 'active'
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
  const asOf = Date.now();
  const entity = await db
    .prepare(
      `SELECT id, name, name_normalized, entity_type, aliases_json, metadata_json,
              mention_count, created_at, updated_at
       FROM sb_entities WHERE id = ? AND lifecycle_state = 'active'`
    )
    .bind(entityId)
    .first<Record<string, unknown>>();

  if (!entity) {
    return { entity: null, relations: [], memories: [] };
  }

  const { results: relations } = await db
    .prepare(
      `SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation_type, r.fact, r.memory_id,
              r.observation_id, r.score, r.valid_from, r.valid_to, r.invalid_at,
              r.expired_at, r.reference_time, r.evidence_count, r.created_at,
              fe.name AS from_name, te.name AS to_name
       FROM sb_entity_relations r
       JOIN sb_entities fe ON fe.id = r.from_entity_id
       JOIN sb_entities te ON te.id = r.to_entity_id
       WHERE (r.from_entity_id = ? OR r.to_entity_id = ?)
         AND r.resolution_state = 'active'
         AND (r.invalid_at IS NULL OR r.invalid_at > ?)
         AND (r.expired_at IS NULL OR r.expired_at > ?)
         AND ${eligibleRelationClaimPredicate("r", String(asOf))}
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .bind(entityId, entityId, asOf, asOf, limit)
    .all();

  const { results: memories } = await db
    .prepare(
      `SELECT m.id, m.content, m.kind, m.memory_class, m.importance, m.confidence,
              m.entry_id, m.observed_at, m.valid_from, m.valid_to, m.reference_time,
              m.invalid_at, m.expired_at, m.created_at, me.role
       FROM sb_memory_entities me
       JOIN sb_memories m ON m.id = me.memory_id
       JOIN entries e ON e.id = m.entry_id AND e.content_hash = m.content_hash
       WHERE me.entity_id = ?
         AND m.content_hash IS NOT NULL
         AND ${activeMemoryClaimPredicate("m", String(asOf), { requireActiveParentLink: true })}
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

/** Active facts: not invalid/expired and (valid_to IS NULL OR valid_to > asOf). */
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
           AND (r.invalid_at IS NULL OR r.invalid_at > ?)
           AND (r.expired_at IS NULL OR r.expired_at > ?)
           AND (
             r.resolution_state = 'active'
             OR (r.resolution_state = 'superseded' AND r.invalid_at > ${String(asOf)})
           )
           AND ${eligibleRelationClaimPredicate("r", String(asOf))}
           AND (r.valid_from IS NULL OR r.valid_from <= ?)
           AND (r.valid_to IS NULL OR r.valid_to > ?)
         ORDER BY r.created_at DESC
         LIMIT ?`
      )
      .bind(opts.entityId, opts.entityId, asOf, asOf, asOf, asOf, limit)
      .all();
    return (results ?? []) as Array<Record<string, unknown>>;
  }
  const { results } = await db
    .prepare(
      `SELECT r.*, fe.name AS from_name, te.name AS to_name
       FROM sb_entity_relations r
       JOIN sb_entities fe ON fe.id = r.from_entity_id
       JOIN sb_entities te ON te.id = r.to_entity_id
       WHERE (r.invalid_at IS NULL OR r.invalid_at > ?)
         AND (r.expired_at IS NULL OR r.expired_at > ?)
         AND (
           r.resolution_state = 'active'
           OR (r.resolution_state = 'superseded' AND r.invalid_at > ${String(asOf)})
         )
         AND ${eligibleRelationClaimPredicate("r", String(asOf))}
         AND (r.valid_from IS NULL OR r.valid_from <= ?)
         AND (r.valid_to IS NULL OR r.valid_to > ?)
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .bind(asOf, asOf, asOf, asOf, limit)
    .all();
  return (results ?? []) as Array<Record<string, unknown>>;
}
