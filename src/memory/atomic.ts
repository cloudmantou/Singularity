/**
 * Atomic memory layer: Observation → Atomic Memory → source links.
 * Dual-writes alongside legacy `entries` so existing recall/MCP keep working.
 */

import {
  parseEntityList,
  parseEntityRelationList,
  type EntityDraft,
  type EntityRelationDraft,
} from "./entities";

export const MEMORY_CLASS_VALUES = [
  "fact",
  "preference",
  "project",
  "task",
  "decision",
  "plan",
  "event",
  "milestone",
  "problem",
  "solution",
  "document",
  "procedure",
  "inference",
  "summary",
] as const;

export type MemoryClass = (typeof MEMORY_CLASS_VALUES)[number];

export const KIND_FOR_MEMORY = ["episodic", "semantic", "procedural"] as const;
export type AtomicMemoryKind = (typeof KIND_FOR_MEMORY)[number];

export interface AtomicFactDraft {
  content: string;
  kind: AtomicMemoryKind | null;
  memoryClass: MemoryClass | null;
  importance: number | null;
  confidence: number | null;
  observedAt: number | null;
  validFrom: number | null;
  validTo: number | null;
  referenceTime: number | null;
  entities: EntityDraft[];
  relations: EntityRelationDraft[];
}

export const ATOMIC_EXTRACTION_MAX_FACTS = 12;
export const ATOMIC_EXTRACTION_MAX_TOKENS = 500;
export const ATOMIC_EXTRACTION_CONTENT_LIMIT = 4_000;

const MEMORY_CLASS_SET = new Set<string>(MEMORY_CLASS_VALUES);
const KIND_SET = new Set<string>(KIND_FOR_MEMORY);

export function normalizeMemoryClass(raw: unknown): MemoryClass | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (MEMORY_CLASS_SET.has(v)) return v as MemoryClass;
  // common synonyms
  if (v === "howto" || v === "how_to" || v === "workflow") return "procedure";
  if (v === "goal") return "plan";
  if (v === "bug") return "problem";
  if (v === "fix") return "solution";
  if (v === "pref") return "preference";
  return null;
}

export function normalizeAtomicKind(raw: unknown): AtomicMemoryKind | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (KIND_SET.has(v)) return v as AtomicMemoryKind;
  if (/episod|event|milestone|occurrence/.test(v)) return "episodic";
  if (/procedur|workflow|how-?to|process/.test(v)) return "procedural";
  if (/semantic|fact|preference|knowledge|belief/.test(v)) return "semantic";
  return null;
}

function parseOptionalTime(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // accept unix seconds or ms
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function clampImportance(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= 1 && i <= 5 ? i : null;
}

function clampConfidence(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

export function buildAtomicExtractionPrompt(content: string): string {
  const sample = content.slice(0, ATOMIC_EXTRACTION_CONTENT_LIMIT);
  return (
    `Split this memory input into independent atomic facts. Respond with ONLY one JSON object.\n` +
    `{"facts":[{"content":"...","kind":"episodic|semantic|procedural","memory_class":"fact|preference|project|task|decision|plan|event|milestone|problem|solution|document|procedure|inference|summary","importance":1-5,"confidence":0-1,"observed_at":null,"valid_from":null,"valid_to":null,"reference_time":null,"entities":[{"name":"...","type":"person|project|organization|place|product|concept|other"}],"relations":[{"from":"...","to":"...","type":"uses|part_of|owns|works_on|depends_on|related_to|located_in","fact":"..."}]}]}\n` +
    `Rules:\n` +
    `- One fact per object; do not merge unrelated claims.\n` +
    `- Preserve the user's language.\n` +
    `- If the input is already a single fact, return exactly one fact.\n` +
    `- Skip pure greetings / empty chatter.\n` +
    `- Max ${ATOMIC_EXTRACTION_MAX_FACTS} facts.\n` +
    `- entities: named things in that fact only.\n` +
    `- relations: entity-to-entity fact edges when the fact states a relationship; omit if none.\n` +
    `- valid_from/valid_to/reference_time: unix ms or ISO when the fact has a time window; else null.\n\n` +
    `Input:\n${sample}`
  );
}

/** Parse model output into atomic fact drafts. Throws on unusable payload. */
export function parseAtomicExtraction(text: string): AtomicFactDraft[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("invalid_extraction");
  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("invalid_extraction");
  }

  const list = Array.isArray(parsed?.facts)
    ? parsed.facts
    : Array.isArray(parsed?.memory)
      ? parsed.memory
      : Array.isArray(parsed)
        ? parsed
        : null;
  if (!list) throw new Error("invalid_extraction");

  const facts: AtomicFactDraft[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const content = String(
      (item as any).content ?? (item as any).text ?? (item as any).fact ?? ""
    ).trim();
    if (content.length < 2) continue;
    const entities = parseEntityList((item as any).entities);
    const relations = parseEntityRelationList(
      (item as any).relations ?? (item as any).entity_relations
    );
    facts.push({
      content: content.slice(0, 2_000),
      kind: normalizeAtomicKind((item as any).kind),
      memoryClass: normalizeMemoryClass(
        (item as any).memory_class ?? (item as any).memoryClass ?? (item as any).category
      ),
      importance: clampImportance((item as any).importance),
      confidence: clampConfidence((item as any).confidence),
      observedAt: parseOptionalTime((item as any).observed_at ?? (item as any).observedAt),
      validFrom: parseOptionalTime((item as any).valid_from ?? (item as any).validFrom),
      validTo: parseOptionalTime((item as any).valid_to ?? (item as any).validTo),
      referenceTime: parseOptionalTime(
        (item as any).reference_time ?? (item as any).referenceTime
      ),
      entities,
      relations,
    });
    if (facts.length >= ATOMIC_EXTRACTION_MAX_FACTS) break;
  }
  if (!facts.length) throw new Error("empty_extraction");
  return facts;
}

export function prepareObservationInsert(
  db: D1Database,
  input: {
    id: string;
    content: string;
    source: string;
    metadata?: Record<string, unknown>;
    createdAt: number;
  }
) {
  return db
    .prepare(
      `INSERT INTO sb_observations (id, content, source, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.content,
      input.source,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt
    );
}

export function prepareAtomicMemoryInsert(
  db: D1Database,
  input: {
    id: string;
    content: string;
    kind: string | null;
    memoryClass: string | null;
    importance: number | null;
    confidence: number | null;
    entryId: string | null;
    contentHash: string | null;
    observedAt: number | null;
    validFrom: number | null;
    validTo: number | null;
    referenceTime: number | null;
    invalidAt?: number | null;
    entitiesJson: string;
    createdAt: number;
  }
) {
  return db
    .prepare(
      `INSERT INTO sb_memories (
         id, content, kind, memory_class, importance, confidence,
         entry_id, content_hash, observed_at, valid_from, valid_to,
         reference_time, invalid_at, entities_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.content,
      input.kind,
      input.memoryClass,
      input.importance,
      input.confidence,
      input.entryId,
      input.contentHash,
      input.observedAt,
      input.validFrom,
      input.validTo,
      input.referenceTime,
      input.invalidAt ?? null,
      input.entitiesJson,
      input.createdAt
    );
}

export function prepareMemorySourceInsert(
  db: D1Database,
  input: {
    id: string;
    memoryId: string;
    observationId: string;
    role?: string;
    score?: number | null;
    createdAt: number;
  }
) {
  return db
    .prepare(
      `INSERT INTO sb_memory_sources (id, memory_id, observation_id, role, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.memoryId,
      input.observationId,
      input.role ?? "derived_from",
      input.score ?? null,
      input.createdAt
    );
}

export const ATOMIC_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_observations (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'api',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_observations_created
    ON sb_observations(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    kind TEXT,
    memory_class TEXT,
    importance REAL,
    confidence REAL,
    entry_id TEXT,
    content_hash TEXT,
    observed_at INTEGER,
    valid_from INTEGER,
    valid_to INTEGER,
    reference_time INTEGER,
    invalid_at INTEGER,
    entities_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memories_entry
    ON sb_memories(entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memories_hash
    ON sb_memories(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memories_created
    ON sb_memories(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_memory_sources (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'derived_from',
    score REAL,
    created_at INTEGER NOT NULL,
    UNIQUE(memory_id, observation_id, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_sources_memory
    ON sb_memory_sources(memory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_sources_observation
    ON sb_memory_sources(observation_id)`,
] as const;
