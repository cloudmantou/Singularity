import {
  FACT_RESOLUTION_SCHEMA_STATEMENTS,
  resolveFact,
  type FactResolutionResult,
} from "./fact-resolution";
import { ensureConflictClaimSchema } from "./quality";
import { D1ResolutionCoordinator } from "./resolution-coordinator";

export interface ResolveEntityRelationInput {
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  fact?: string | null;
  memoryId?: string | null;
  observationId?: string | null;
  score?: number | null;
  scopeId?: string | null;
  polarity?: string | null;
  modality?: string | null;
  validFrom?: number | null;
  validTo?: number | null;
  invalidAt?: number | null;
  expiredAt?: number | null;
  referenceTime?: number | null;
  metadata?: Record<string, unknown>;
  trustedEvidence?: boolean;
  createdAt: number;
}

interface FactCandidateRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  fact: string | null;
  memory_id: string | null;
  scope_id: string | null;
  polarity: string | null;
  modality: string | null;
  valid_from: number | null;
  valid_to: number | null;
  reference_time: number | null;
  evidence_count: number | null;
  created_at: number;
}

async function evidenceCanInvalidate(
  db: D1Database,
  input: ResolveEntityRelationInput
): Promise<boolean> {
  if (input.trustedEvidence != null) return input.trustedEvidence;
  if (!input.observationId || Number(input.score ?? 0) < 0.8) return false;
  const row = await db.prepare(
    `SELECT o.author_type, m.scores_json
     FROM sb_observations o
     LEFT JOIN sb_memories m ON m.id = ?
     WHERE o.id = ?
     LIMIT 1`
  ).bind(input.memoryId ?? null, input.observationId).first<{
    author_type: string | null;
    scores_json: string | null;
  }>();
  if (row?.author_type !== "user" && row?.author_type !== "import") return false;
  let scores: Record<string, any> = {};
  try { scores = JSON.parse(row.scores_json ?? "{}"); } catch { scores = {}; }
  return Number(scores.humanConfirmation ?? 0) === 1;
}

export function normalizeEntityFactKey(fact: string | null | undefined): string {
  return (fact ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, 500);
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

export function temporalWindowsOverlap(
  aFrom: number | null | undefined,
  aTo: number | null | undefined,
  bFrom: number | null | undefined,
  bTo: number | null | undefined,
  toleranceMs = 86_400_000
): boolean {
  const aStart = finiteOrNull(aFrom) ?? Number.NEGATIVE_INFINITY;
  const aEnd = finiteOrNull(aTo) ?? Number.POSITIVE_INFINITY;
  const bStart = finiteOrNull(bFrom) ?? Number.NEGATIVE_INFINITY;
  const bEnd = finiteOrNull(bTo) ?? Number.POSITIVE_INFINITY;
  return aStart <= bEnd + toleranceMs && bStart <= aEnd + toleranceMs;
}

function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < input.length; index += 1) {
    const char = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function entityRelationFactHash(input: ResolveEntityRelationInput): string {
  return stableHash([
    input.fromEntityId,
    input.toEntityId,
    input.relationType,
    normalizeEntityFactKey(input.fact),
  ].join("\u001f"));
}

function prepareNewRelation(
  db: D1Database,
  relationId: string,
  input: ResolveEntityRelationInput,
  resolution: FactResolutionResult
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sb_entity_relations (
       id, from_entity_id, to_entity_id, relation_type, fact, fact_hash,
       evidence_count, memory_id, observation_id, score,
       valid_from, valid_to, invalid_at, expired_at, reference_time,
       scope_id, polarity, modality, resolution_type, resolution_state,
       supersedes_relation_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    relationId,
    input.fromEntityId,
    input.toEntityId,
    input.relationType,
    input.fact?.trim() || null,
    entityRelationFactHash(input),
    input.memoryId ?? null,
    input.observationId ?? null,
    input.score ?? null,
    input.validFrom ?? null,
    input.validTo ?? null,
    input.invalidAt ?? null,
    input.expiredAt ?? null,
    input.referenceTime ?? null,
    input.scopeId ?? null,
    input.polarity ?? "positive",
    input.modality ?? "asserted",
    resolution.type,
    resolution.requiresReview ? "review" : "active",
    resolution.type === "supersedes" ? resolution.targetRelationId : null,
    JSON.stringify(input.metadata ?? {}),
    input.createdAt
  );
}

function prepareFactSource(
  db: D1Database,
  relationId: string,
  input: ResolveEntityRelationInput
): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO sb_fact_sources (
       id, relation_id, memory_id, observation_id, created_at
     ) VALUES (?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    relationId,
    input.memoryId ?? null,
    input.observationId ?? null,
    input.createdAt
  );
}

export async function resolveAndInsertEntityRelation(
  db: D1Database,
  input: ResolveEntityRelationInput
): Promise<{ relationId: string; resolution: FactResolutionResult }> {
  const resolutionTable = await db.prepare(
    `SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'sb_fact_resolutions'
     LIMIT 1`
  ).first<{ "1": number }>();
  if (!resolutionTable) {
    await db.exec(FACT_RESOLUTION_SCHEMA_STATEMENTS.join(";\n"));
  }
  const { results } = await db.prepare(
    `SELECT id, from_entity_id, to_entity_id, relation_type, fact,
            COALESCE(
              (SELECT fs_active.memory_id
               FROM sb_fact_sources fs_active
               JOIN sb_memories m_active ON m_active.id = fs_active.memory_id
               WHERE fs_active.relation_id = sb_entity_relations.id
                 AND m_active.invalid_at IS NULL
                 AND m_active.expired_at IS NULL
               ORDER BY m_active.created_at DESC, fs_active.created_at DESC
               LIMIT 1),
              memory_id
            ) AS memory_id,
            scope_id, polarity, modality, valid_from, valid_to, reference_time, created_at,
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM sb_fact_sources fs_evidence
                JOIN sb_memory_sources ms_evidence
                  ON ms_evidence.memory_id = fs_evidence.memory_id
                WHERE fs_evidence.relation_id = sb_entity_relations.id
              ) THEN (
                SELECT COUNT(DISTINCT COALESCE(
                  ms_count.evidence_root_id,
                  o_count.root_evidence_id,
                  ms_count.observation_id
                ))
                FROM sb_fact_sources fs_count
                JOIN sb_memories m_count ON m_count.id = fs_count.memory_id
                JOIN sb_memory_sources ms_count ON ms_count.memory_id = m_count.id
                LEFT JOIN sb_observations o_count ON o_count.id = ms_count.observation_id
                WHERE fs_count.relation_id = sb_entity_relations.id
                  AND m_count.invalid_at IS NULL
                  AND m_count.expired_at IS NULL
                  AND ms_count.relation IN ('supports', 'derived_from')
              )
              ELSE evidence_count
            END AS evidence_count
     FROM sb_entity_relations
     WHERE from_entity_id = ?
       AND relation_type = ?
       AND invalid_at IS NULL
       AND expired_at IS NULL
     ORDER BY created_at DESC
     LIMIT 20`
  ).bind(input.fromEntityId, input.relationType).all<FactCandidateRow>();
  const candidates = (results ?? []).map((row) => ({
    relationId: row.id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    predicate: row.relation_type,
    fact: row.fact,
    scopeId: row.scope_id,
    polarity: row.polarity,
    modality: row.modality,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    referenceTime: row.reference_time,
    memoryId: row.memory_id,
    evidenceCount: Number(row.evidence_count ?? 1),
    createdAt: row.created_at,
  }));
  const allowInvalidation = await evidenceCanInvalidate(db, input);
  const resolution = resolveFact({
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    predicate: input.relationType,
    fact: input.fact ?? null,
    scopeId: input.scopeId ?? null,
    polarity: input.polarity ?? "positive",
    modality: input.modality ?? "asserted",
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    referenceTime: input.referenceTime ?? null,
    memoryId: input.memoryId ?? null,
    allowInvalidation,
  }, candidates);

  const reuseCanonical = (
    resolution.type === "duplicate" ||
    resolution.type === "supports" ||
    resolution.type === "elaborates"
  ) && resolution.targetRelationId != null;
  const relationId = reuseCanonical ? resolution.targetRelationId as string : crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  if (!reuseCanonical) statements.push(prepareNewRelation(db, relationId, input, resolution));
  statements.push(prepareFactSource(db, relationId, input));
  statements.push(
    db.prepare(
      `UPDATE sb_entity_relations
       SET evidence_count = MAX(1, (
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
             WHERE fs_count.relation_id = ?
           )),
           score = CASE
             WHEN ? IS NULL THEN score
             WHEN score IS NULL OR score < ? THEN ?
             ELSE score
           END,
           valid_from = CASE
             WHEN valid_from IS NULL THEN ?
             WHEN ? IS NULL THEN valid_from
             ELSE MIN(valid_from, ?)
           END,
           valid_to = CASE
             WHEN valid_to IS NULL THEN ?
             WHEN ? IS NULL THEN valid_to
             ELSE MAX(valid_to, ?)
           END,
           reference_time = COALESCE(reference_time, ?)
       WHERE id = ?`
    ).bind(
      relationId,
      input.score ?? null,
      input.score ?? null,
      input.score ?? null,
      input.validFrom ?? null,
      input.validFrom ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
      input.validTo ?? null,
      input.validTo ?? null,
      input.referenceTime ?? null,
      relationId
    )
  );
  statements.push(
    db.prepare(
      `INSERT INTO sb_fact_resolutions (
         id, relation_id, target_relation_id, resolution_type, confidence,
         reason_codes_json, requires_review, applied_invalidation,
         source_memory_id, target_memory_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), relationId, resolution.targetRelationId,
      resolution.type, resolution.confidence, JSON.stringify(resolution.reasonCodes),
      resolution.requiresReview ? 1 : 0, resolution.applyInvalidation ? 1 : 0,
      input.memoryId ?? null, resolution.targetMemoryId, input.createdAt
    )
  );
  if (
    resolution.applyInvalidation &&
    resolution.targetRelationId &&
    resolution.targetMemoryId &&
    input.memoryId
  ) {
    const coordinator = new D1ResolutionCoordinator(db);
    statements.push(...await coordinator.prepareSupersession({
      sourceClaimId: input.memoryId,
      targetClaimId: resolution.targetMemoryId,
      sourceRelationId: relationId,
      targetRelationId: resolution.targetRelationId,
      effectiveAt: input.createdAt,
      actorType: "system",
      actorId: "fact-resolver",
    }));
  }
  if (
    resolution.type === "contradicts" &&
    resolution.targetMemoryId && input.memoryId &&
    resolution.targetMemoryId !== input.memoryId
  ) {
    await ensureConflictClaimSchema(db);
    const claimRows = await db.prepare(
      `SELECT id, entry_id
       FROM sb_memories
       WHERE id IN (?, ?)`
    ).bind(resolution.targetMemoryId, input.memoryId).all<{ id: string; entry_id: string | null }>();
    const entryByClaim = new Map((claimRows.results ?? []).map((row) => [row.id, row.entry_id]));
    const oldEntryId = entryByClaim.get(resolution.targetMemoryId);
    const newEntryId = entryByClaim.get(input.memoryId);
    if (oldEntryId && newEntryId) {
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO sb_conflict_cases (
             id, old_memory_id, new_memory_id, old_claim_id, new_claim_id,
             conflict_type, reason, confidence, state, resolution,
             resolved_by, resolved_at, created_at
           ) VALUES (?, ?, ?, ?, ?, 'fact_resolution', ?, ?, 'pending', NULL, NULL, NULL, ?)`
        ).bind(
          crypto.randomUUID(), oldEntryId, newEntryId,
          resolution.targetMemoryId, input.memoryId,
          resolution.reasonCodes.join(","), resolution.confidence, input.createdAt
        )
      );
    }
  }
  await db.batch(statements);
  return { relationId, resolution };
}

export async function insertEntityRelation(
  db: D1Database,
  input: ResolveEntityRelationInput
): Promise<string> {
  return (await resolveAndInsertEntityRelation(db, input)).relationId;
}
