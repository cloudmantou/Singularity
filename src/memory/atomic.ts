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
import {
  defaultClaimScores,
  normalizeClaimModality,
  normalizeClaimPolarity,
  normalizeClaimStatus,
  normalizeEvidenceAuthorType,
  normalizeProvenanceRelation,
  prepareParentVersionClaimInsert,
  type ClaimModality,
  type ClaimPolarity,
  type ClaimStatus,
  type EvidenceAuthorType,
  type ProvenanceRelation,
} from "./evidence-contract";

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
  subject: string | null;
  predicate: string | null;
  object: string | null;
  scopeId: string | null;
  polarity: ClaimPolarity | null;
  modality: ClaimModality | null;
  status: ClaimStatus | null;
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
export const ATOMIC_EXTRACTION_MAX_TOKENS = 1000;
export const ATOMIC_EXTRACTION_CONTENT_LIMIT = 4_000;
export const ATOMIC_EXTRACTION_VERSION = 1;

export const OBSERVATION_EXTRACTION_STATUSES = [
  "pending",
  "processing",
  "succeeded",
  "fallback",
  "partial_error",
  "retryable_error",
  "terminal_error",
] as const;

export type ObservationExtractionStatus = (typeof OBSERVATION_EXTRACTION_STATUSES)[number];

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

function optionalText(raw: unknown, max = 512): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  return text ? text.slice(0, max) : null;
}

export function buildAtomicExtractionPrompt(content: string): string {
  const sample = content.slice(0, ATOMIC_EXTRACTION_CONTENT_LIMIT);
  return (
    `Split this memory input into independent atomic facts. Respond with ONLY one JSON object.\n` +
    `{"facts":[{"content":"...","subject":null,"predicate":null,"object":null,"scope_id":null,"polarity":"positive|negative|neutral","modality":"asserted|confirmed|inferred|hypothetical","kind":"episodic|semantic|procedural","memory_class":"fact|preference|project|task|decision|plan|event|milestone|problem|solution|document|procedure|inference|summary","importance":1-5,"confidence":0-1,"observed_at":null,"valid_from":null,"valid_to":null,"reference_time":null,"entities":[{"name":"...","type":"person|project|organization|place|product|concept|other"}],"relations":[{"from":"...","to":"...","type":"uses|part_of|owns|works_on|depends_on|related_to|located_in","fact":"..."}]}]}\n` +
    `Rules:\n` +
    `- One fact per object; do not merge unrelated claims.\n` +
    `- Preserve the user's language.\n` +
    `- If the input is already a single fact, return exactly one fact.\n` +
    `- Skip pure greetings / empty chatter.\n` +
    `- Max ${ATOMIC_EXTRACTION_MAX_FACTS} facts.\n` +
    `- Do not decide global claim lifecycle status such as confirmed, contested, superseded, or deprecated; only extract what this input states.\n` +
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
      subject: optionalText((item as any).subject),
      predicate: optionalText((item as any).predicate),
      object: optionalText((item as any).object),
      scopeId: optionalText((item as any).scope_id ?? (item as any).scopeId),
      polarity: normalizeClaimPolarity((item as any).polarity),
      modality: normalizeClaimModality((item as any).modality),
      status: "supported",
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
    contentHash?: string | null;
    sourceChannel?: string | null;
    sourceIdentity?: string | null;
    authorType?: EvidenceAuthorType | string | null;
    sourceUri?: string | null;
    sourceTimestamp?: number | null;
    revision?: number | null;
    rootEvidenceId?: string | null;
    previousEvidenceId?: string | null;
    extractionStatus?: ObservationExtractionStatus;
    extractionVersion?: number;
    extractionAttempts?: number;
    extractionError?: string | null;
    nextAttemptAt?: number | null;
    processingStartedAt?: number | null;
    processedAt?: number | null;
    needsReprocess?: boolean;
    createdAt: number;
  }
) {
  return db
    .prepare(
      `INSERT INTO sb_observations (
         id, content, source, metadata_json, content_hash,
         source_channel, source_identity, author_type, source_uri,
         source_timestamp, revision, root_evidence_id, previous_evidence_id,
         extraction_status, extraction_version, extraction_attempts,
         extraction_error, next_attempt_at, processing_started_at,
         processed_at, needs_reprocess, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.content,
      input.source,
      JSON.stringify(input.metadata ?? {}),
      input.contentHash ?? null,
      input.sourceChannel ?? input.source,
      input.sourceIdentity ?? null,
      normalizeEvidenceAuthorType(input.authorType),
      input.sourceUri ?? null,
      input.sourceTimestamp ?? input.createdAt,
      input.revision ?? 1,
      input.rootEvidenceId ?? input.id,
      input.previousEvidenceId ?? null,
      input.extractionStatus ?? "pending",
      input.extractionVersion ?? ATOMIC_EXTRACTION_VERSION,
      input.extractionAttempts ?? 0,
      input.extractionError ?? null,
      input.nextAttemptAt ?? null,
      input.processingStartedAt ?? null,
      input.processedAt ?? null,
      input.needsReprocess ? 1 : 0,
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
    parentVersionId?: string | null;
    claimSubject?: string | null;
    claimPredicate?: string | null;
    claimObject?: string | null;
    scopeId?: string | null;
    polarity?: ClaimPolarity | string | null;
    modality?: ClaimModality | string | null;
    claimStatus?: ClaimStatus | string | null;
    scoresJson?: string | null;
    contentHash: string | null;
    observedAt: number | null;
    validFrom: number | null;
    validTo: number | null;
    referenceTime: number | null;
    invalidAt?: number | null;
    expiredAt?: number | null;
    entitiesJson: string;
    createdAt: number;
  }
) {
  return db
    .prepare(
      `INSERT INTO sb_memories (
         id, content, kind, memory_class, importance, confidence,
         entry_id, parent_version_id, claim_subject, claim_predicate,
         claim_object, scope_id, polarity, modality, claim_status,
         scores_json, content_hash, observed_at, valid_from, valid_to,
         reference_time, invalid_at, expired_at, entities_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.content,
      input.kind,
      input.memoryClass,
      input.importance,
      input.confidence,
      input.entryId,
      input.parentVersionId ?? null,
      input.claimSubject ?? null,
      input.claimPredicate ?? null,
      input.claimObject ?? null,
      input.scopeId ?? null,
      normalizeClaimPolarity(input.polarity),
      normalizeClaimModality(input.modality),
      normalizeClaimStatus(input.claimStatus),
      input.scoresJson ?? JSON.stringify(defaultClaimScores({
        confidence: input.confidence,
        evidenceScore: input.confidence,
      })),
      input.contentHash,
      input.observedAt,
      input.validFrom,
      input.validTo,
      input.referenceTime,
      input.invalidAt ?? null,
      input.expiredAt ?? null,
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
    relation?: ProvenanceRelation | string | null;
    extractSpan?: string | null;
    evidenceScore?: number | null;
    derivationConfidence?: number | null;
    extractorModel?: string | null;
    extractorVersion?: string | null;
    evidenceRootId?: string | null;
    createdAt: number;
  }
) {
  return db
    .prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, score, relation, extract_span,
         evidence_score, derivation_confidence, extractor_model,
         extractor_version, evidence_root_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.memoryId,
      input.observationId,
      input.role ?? "derived_from",
      input.score ?? null,
      normalizeProvenanceRelation(input.relation ?? input.role),
      input.extractSpan ?? null,
      input.evidenceScore ?? input.score ?? null,
      input.derivationConfidence ?? input.score ?? null,
      input.extractorModel ?? null,
      input.extractorVersion ?? String(ATOMIC_EXTRACTION_VERSION),
      input.evidenceRootId ?? input.observationId,
      input.createdAt
    );
}

export async function linkObservationToAtomicMemory(
  db: D1Database,
  input: {
    entryId: string;
    content: string;
    contentHash: string;
    observationId: string;
    parentVersionId?: string | null;
    evidenceRootId?: string | null;
    atomic?: AtomicFactDraft;
    createdAt: number;
  }
): Promise<{ memoryId: string; created: boolean }> {
  const existing = await db
    .prepare(
      `SELECT id, confidence
       FROM sb_memories
       WHERE invalid_at IS NULL
         AND expired_at IS NULL
         AND (entry_id = ? OR content_hash = ?)
       ORDER BY CASE WHEN entry_id = ? THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`
    )
    .bind(input.entryId, input.contentHash, input.entryId)
    .first<{ id: string; confidence: number | null }>();

  const memoryId = existing?.id ?? crypto.randomUUID();
  const sourceScore = input.atomic?.confidence ?? null;
  const statements: D1PreparedStatement[] = [];

  if (!existing) {
    statements.push(
      prepareAtomicMemoryInsert(db, {
        id: memoryId,
        content: input.content,
        kind: input.atomic?.kind ?? null,
        memoryClass: input.atomic?.memoryClass ?? null,
        importance: input.atomic?.importance ?? null,
        confidence: sourceScore,
        entryId: input.entryId,
        parentVersionId: input.parentVersionId ?? null,
        claimSubject: input.atomic?.subject ?? null,
        claimPredicate: input.atomic?.predicate ?? null,
        claimObject: input.atomic?.object ?? null,
        scopeId: input.atomic?.scopeId ?? null,
        polarity: input.atomic?.polarity ?? "positive",
        modality: input.atomic?.modality ?? "asserted",
        claimStatus: input.atomic?.status ?? "supported",
        scoresJson: JSON.stringify(defaultClaimScores({
          confidence: sourceScore,
          evidenceScore: sourceScore,
        })),
        contentHash: input.contentHash,
        observedAt: input.atomic?.observedAt ?? input.createdAt,
        validFrom: input.atomic?.validFrom ?? null,
        validTo: input.atomic?.validTo ?? null,
        referenceTime: input.atomic?.referenceTime ?? null,
        invalidAt: null,
        entitiesJson: JSON.stringify(input.atomic?.entities ?? []),
        createdAt: input.createdAt,
      })
    );
  } else if (sourceScore != null) {
    statements.push(
      db
        .prepare(
          `UPDATE sb_memories
           SET confidence = CASE
             WHEN confidence IS NULL THEN ?
             WHEN confidence < ? THEN ?
             ELSE confidence
           END
           WHERE id = ?`
        )
        .bind(sourceScore, sourceScore, sourceScore, memoryId)
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO sb_memory_sources (
           id, memory_id, observation_id, role, score, relation,
           extract_span, evidence_score, derivation_confidence,
           extractor_model, extractor_version, evidence_root_id, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, observation_id, role) DO UPDATE SET
           score = COALESCE(excluded.score, sb_memory_sources.score),
           evidence_score = COALESCE(excluded.evidence_score, sb_memory_sources.evidence_score),
           derivation_confidence = COALESCE(excluded.derivation_confidence, sb_memory_sources.derivation_confidence)`
      )
      .bind(
        crypto.randomUUID(),
        memoryId,
        input.observationId,
        "derived_from",
        sourceScore,
        "supports",
        null,
        sourceScore,
        sourceScore,
        null,
        String(ATOMIC_EXTRACTION_VERSION),
        input.evidenceRootId ?? input.observationId,
        input.createdAt
      )
  );

  if (input.parentVersionId) {
    statements.push(
      prepareParentVersionClaimInsert(db, {
        parentVersionId: input.parentVersionId,
        memoryId,
        relation: "supports",
        createdAt: input.createdAt,
      })
    );
  }

  await db.batch(statements);
  return { memoryId, created: !existing };
}

export async function replaceEntryAtomicMemory(
  db: D1Database,
  input: {
    entryId: string;
    content: string;
    contentHash: string;
    source: string;
    eventType: "append" | "update";
    createdAt: number;
  }
): Promise<{ observationId: string; memoryId: string }> {
  const observationId = crypto.randomUUID();
  const memoryId = crypto.randomUUID();

  await db.batch([
    db
      .prepare(
        `UPDATE sb_entity_relations
         SET invalid_at = ?, expired_at = ?, valid_to = COALESCE(valid_to, ?)
         WHERE invalid_at IS NULL
           AND expired_at IS NULL
           AND memory_id IN (
             SELECT id FROM sb_memories
             WHERE entry_id = ? AND invalid_at IS NULL AND expired_at IS NULL
           )`
      )
      .bind(input.createdAt, input.createdAt, input.createdAt, input.entryId),
    db
      .prepare(
        `UPDATE sb_memories
         SET invalid_at = ?, expired_at = ?, valid_to = COALESCE(valid_to, ?)
         WHERE entry_id = ?
           AND invalid_at IS NULL
           AND expired_at IS NULL`
      )
      .bind(input.createdAt, input.createdAt, input.createdAt, input.entryId),
    prepareObservationInsert(db, {
      id: observationId,
      content: input.content,
      source: input.source,
      metadata: {
        lifecycle_event: input.eventType,
        entry_id: input.entryId,
        needs_reprocess: true,
      },
      contentHash: input.contentHash,
      extractionStatus: "fallback",
      processedAt: input.createdAt,
      needsReprocess: true,
      createdAt: input.createdAt,
    }),
    prepareAtomicMemoryInsert(db, {
      id: memoryId,
      content: input.content,
      kind: null,
      memoryClass: null,
      importance: null,
      confidence: null,
      entryId: input.entryId,
      contentHash: input.contentHash,
      observedAt: input.createdAt,
      validFrom: null,
      validTo: null,
      referenceTime: null,
      invalidAt: null,
      expiredAt: null,
      entitiesJson: "[]",
      createdAt: input.createdAt,
    }),
    prepareMemorySourceInsert(db, {
      id: crypto.randomUUID(),
      memoryId,
      observationId,
      role: "derived_from",
      score: null,
      createdAt: input.createdAt,
    }),
  ]);

  return { observationId, memoryId };
}

export async function deprecateEntryAtomicMemory(
  db: D1Database,
  input: {
    entryId: string;
    invalidAt: number;
  }
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE sb_entity_relations
         SET invalid_at = ?, valid_to = COALESCE(valid_to, ?)
         WHERE invalid_at IS NULL
           AND expired_at IS NULL
           AND memory_id IN (
             SELECT id FROM sb_memories
             WHERE entry_id = ? AND invalid_at IS NULL AND expired_at IS NULL
           )`
      )
      .bind(input.invalidAt, input.invalidAt, input.entryId),
    db
      .prepare(
        `UPDATE sb_memories
         SET invalid_at = ?, valid_to = COALESCE(valid_to, ?)
         WHERE entry_id = ?
           AND invalid_at IS NULL
           AND expired_at IS NULL`
      )
      .bind(input.invalidAt, input.invalidAt, input.entryId),
  ]);
}

export const ATOMIC_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_observations (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'api',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT,
    source_channel TEXT,
    source_identity TEXT,
    author_type TEXT NOT NULL DEFAULT 'unknown',
    source_uri TEXT,
    source_timestamp INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    root_evidence_id TEXT,
    previous_evidence_id TEXT,
    extraction_status TEXT NOT NULL DEFAULT 'pending',
    extraction_version INTEGER NOT NULL DEFAULT 1,
    extraction_attempts INTEGER NOT NULL DEFAULT 0,
    extraction_error TEXT,
    next_attempt_at INTEGER,
    processing_started_at INTEGER,
    processed_at INTEGER,
    needs_reprocess INTEGER NOT NULL DEFAULT 0,
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
    parent_version_id TEXT,
    claim_subject TEXT,
    claim_predicate TEXT,
    claim_object TEXT,
    scope_id TEXT,
    polarity TEXT NOT NULL DEFAULT 'positive',
    modality TEXT NOT NULL DEFAULT 'asserted',
    claim_status TEXT NOT NULL DEFAULT 'supported',
    scores_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT,
    observed_at INTEGER,
    valid_from INTEGER,
    valid_to INTEGER,
    reference_time INTEGER,
    invalid_at INTEGER,
    expired_at INTEGER,
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
    relation TEXT NOT NULL DEFAULT 'derived_from',
    extract_span TEXT,
    evidence_score REAL,
    derivation_confidence REAL,
    extractor_model TEXT,
    extractor_version TEXT,
    evidence_root_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(memory_id, observation_id, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_sources_memory
    ON sb_memory_sources(memory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_sources_observation
    ON sb_memory_sources(observation_id)`,
] as const;

export const ATOMIC_POST_MIGRATION_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_sb_observations_hash
    ON sb_observations(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_observations_extraction_queue
    ON sb_observations(extraction_status, next_attempt_at, created_at)`,
] as const;

export const ATOMIC_OBSERVATION_MIGRATIONS = [
  { column: "content_hash", statement: `ALTER TABLE sb_observations ADD COLUMN content_hash TEXT` },
  {
    column: "extraction_status",
    statement: `ALTER TABLE sb_observations ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'`,
  },
  {
    column: "extraction_version",
    statement: `ALTER TABLE sb_observations ADD COLUMN extraction_version INTEGER NOT NULL DEFAULT 1`,
  },
  {
    column: "extraction_attempts",
    statement: `ALTER TABLE sb_observations ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0`,
  },
  { column: "extraction_error", statement: `ALTER TABLE sb_observations ADD COLUMN extraction_error TEXT` },
  { column: "next_attempt_at", statement: `ALTER TABLE sb_observations ADD COLUMN next_attempt_at INTEGER` },
  {
    column: "processing_started_at",
    statement: `ALTER TABLE sb_observations ADD COLUMN processing_started_at INTEGER`,
  },
  { column: "processed_at", statement: `ALTER TABLE sb_observations ADD COLUMN processed_at INTEGER` },
  {
    column: "needs_reprocess",
    statement: `ALTER TABLE sb_observations ADD COLUMN needs_reprocess INTEGER NOT NULL DEFAULT 0`,
  },
] as const;

export const ATOMIC_SCHEMA_MIGRATION_STATEMENTS = ATOMIC_OBSERVATION_MIGRATIONS.map(
  (migration) => migration.statement
);

export const ATOMIC_SCHEMA_BACKFILL_STATEMENTS = [
  `UPDATE sb_observations
   SET extraction_status = 'succeeded',
       processed_at = COALESCE(processed_at, created_at),
       needs_reprocess = 0
   WHERE extraction_status = 'pending'
     AND EXISTS (
       SELECT 1 FROM sb_memory_sources
       WHERE sb_memory_sources.observation_id = sb_observations.id
     )
     AND NOT (
       json_valid(metadata_json)
       AND json_extract(metadata_json, '$.needs_reprocess') = 1
     )`,
  `UPDATE sb_observations
   SET extraction_status = 'fallback',
       processed_at = COALESCE(processed_at, created_at),
       needs_reprocess = 1
   WHERE json_valid(metadata_json)
     AND json_extract(metadata_json, '$.needs_reprocess') = 1`,
] as const;
