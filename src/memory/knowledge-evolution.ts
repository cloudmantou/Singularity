import { ensureAssociationDataModel } from "./associations";
import { distinctFactEvidenceCountSql } from "./fact-evidence";

export const KNOWLEDGE_EVOLUTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_knowledge_evolutions (
    id TEXT PRIMARY KEY,
    ai_review_run_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    generation INTEGER NOT NULL DEFAULT 1,
    output_entry_id TEXT,
    output_claim_id TEXT,
    output_generated INTEGER NOT NULL DEFAULT 0,
    decision_confidence REAL NOT NULL,
    evidence_confidence REAL NOT NULL,
    applied_by TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    rolled_back_by TEXT,
    rolled_back_at INTEGER,
    rollback_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (operation IN ('consolidate', 'merge', 'supersede', 'keep_separate')),
    CHECK (state IN ('active', 'rolled_back')),
    CHECK (output_generated IN (0, 1))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evolutions_state
   ON sb_knowledge_evolutions(state, generation, applied_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evolutions_output
   ON sb_knowledge_evolutions(output_claim_id, state)`,
  `CREATE TABLE IF NOT EXISTS sb_knowledge_evolution_sources (
    evolution_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    entry_id TEXT,
    disposition TEXT NOT NULL,
    previous_claim_status TEXT NOT NULL,
    previous_invalid_at INTEGER,
    source_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (evolution_id, claim_id),
    CHECK (disposition IN ('absorbed', 'superseded', 'retained'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evolution_sources_claim
   ON sb_knowledge_evolution_sources(claim_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_knowledge_claim_ownership (
    claim_id TEXT PRIMARY KEY,
    evolution_id TEXT NOT NULL,
    acquired_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sb_knowledge_evolution_history (
    id TEXT PRIMARY KEY,
    evolution_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    CHECK (action IN ('applied', 'rolled_back'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evolution_history
   ON sb_knowledge_evolution_history(evolution_id, created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS sb_knowledge_evolution_association_snapshots (
    evolution_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    source_parent_id TEXT NOT NULL,
    target_parent_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    weight REAL NOT NULL,
    provenance TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    directed INTEGER NOT NULL,
    valid_from INTEGER,
    valid_to INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (evolution_id, edge_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evolution_association_snapshots_edge
   ON sb_knowledge_evolution_association_snapshots(edge_id, evolution_id)`,
  `CREATE TABLE IF NOT EXISTS sb_knowledge_evolution_aggregate_snapshots (
    evolution_id TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    previous_stale_at INTEGER,
    previous_updated_at INTEGER NOT NULL,
    PRIMARY KEY (evolution_id, aggregate_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evolution_aggregate_snapshots_aggregate
   ON sb_knowledge_evolution_aggregate_snapshots(aggregate_id, evolution_id)`,
] as const;

type MemoryEvolutionDecision = "duplicate" | "merge" | "replace" | "keep_both";

interface ClaimRow {
  id: string;
  entry_id: string;
  content: string;
  kind: string | null;
  memory_class: string | null;
  importance: number | null;
  confidence: number | null;
  parent_version_id: string | null;
  claim_subject: string | null;
  claim_predicate: string | null;
  claim_object: string | null;
  scope_id: string | null;
  polarity: string;
  modality: string;
  claim_status: string;
  scores_json: string;
  content_hash: string | null;
  observed_at: number | null;
  valid_from: number | null;
  valid_to: number | null;
  reference_time: number | null;
  invalid_at: number | null;
  entities_json: string;
  tags: string;
  vault_snapshot: string | null;
  parent_id: string | null;
}

interface ProvenanceRow {
  observation_id: string;
  score: number | null;
  relation: string;
  extract_span: string | null;
  evidence_score: number | null;
  derivation_confidence: number | null;
  evidence_root_id: string | null;
}

interface MemoryEntityProjectionRow {
  entity_id: string;
  role: string;
  score: number | null;
}

interface AssociationProjectionRow {
  id: string;
  source_parent_id: string;
  target_parent_id: string;
  edge_type: string;
  weight: number;
  provenance: string;
  metadata_json: string;
  directed: number;
  valid_from: number | null;
  valid_to: number | null;
  created_at: number;
}

interface GroupedAssociationProjection {
  sourceParentId: string;
  targetParentId: string;
  edgeType: string;
  weight: number;
  directed: number;
  validFrom: number;
  validTo: number | null;
  metadata: Record<string, unknown>;
}

export interface MemoryKnowledgeEvolutionPlan {
  evolutionId: string;
  outputEntryId: string | null;
  outputClaimId: string | null;
  generation: number;
  statements: D1PreparedStatement[];
}

function parseArray(value: string | null): unknown[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function uniqueJsonValues(first: string, second: string): string {
  return JSON.stringify([...new Set([...parseArray(first), ...parseArray(second)].map(String))]);
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sameOrNull(first: string | null, second: string | null): string | null {
  return first === second ? first : null;
}

function projectionId(evolutionId: string, kind: string): string {
  return `knowledge-evolution:${evolutionId}:${kind}:${crypto.randomUUID()}`;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizedAssociationEndpoints(
  sourceParentId: string,
  targetParentId: string,
  directed: number
): [string, string] {
  return directed || sourceParentId.localeCompare(targetParentId) <= 0
    ? [sourceParentId, targetParentId]
    : [targetParentId, sourceParentId];
}

function groupAssociationProjections(
  edges: AssociationProjectionRow[],
  replacedParents: Set<string>,
  outputParentId: string,
  evolutionId: string,
  generation: number
): GroupedAssociationProjection[] {
  const groups = new Map<string, {
    sourceParentId: string;
    targetParentId: string;
    edgeType: string;
    directed: number;
    edges: AssociationProjectionRow[];
  }>();
  for (const edge of edges) {
    const sourceReplaced = replacedParents.has(edge.source_parent_id);
    const targetReplaced = replacedParents.has(edge.target_parent_id);
    if (!sourceReplaced && !targetReplaced) continue;
    let nextSource = sourceReplaced ? outputParentId : edge.source_parent_id;
    let nextTarget = targetReplaced ? outputParentId : edge.target_parent_id;
    if (nextSource === nextTarget) continue;
    [nextSource, nextTarget] = normalizedAssociationEndpoints(nextSource, nextTarget, edge.directed);
    const key = `${nextSource}\u0000${nextTarget}\u0000${edge.edge_type}`;
    const group = groups.get(key) ?? {
      sourceParentId: nextSource,
      targetParentId: nextTarget,
      edgeType: edge.edge_type,
      directed: edge.directed,
      edges: [],
    };
    group.edges.push(edge);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const sourceEdges = [...group.edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => ({
        id: edge.id,
        sourceParentId: edge.source_parent_id,
        targetParentId: edge.target_parent_id,
        provenance: edge.provenance,
        weight: Number(edge.weight),
        metadata: parseObject(edge.metadata_json),
        validFrom: Number(edge.valid_from ?? edge.created_at),
        validTo: edge.valid_to == null ? null : Number(edge.valid_to),
      }));
    const validToValues = sourceEdges.map((edge) => edge.validTo);
    return {
      sourceParentId: group.sourceParentId,
      targetParentId: group.targetParentId,
      edgeType: group.edgeType,
      weight: Math.max(...sourceEdges.map((edge) => edge.weight)),
      directed: group.directed,
      validFrom: Math.min(...sourceEdges.map((edge) => edge.validFrom)),
      validTo: validToValues.some((value) => value == null)
        ? null
        : Math.max(...validToValues.map(Number)),
      metadata: {
        evolutionId,
        generation,
        evolvedFrom: sourceEdges.map((edge) => edge.id),
        sourceEdges,
      },
    };
  });
}

function candidateGuard(): string {
  return `EXISTS (
    SELECT 1 FROM sb_memory_merge_candidates candidate
    WHERE candidate.id = ?
      AND candidate.state = ?
      AND candidate.reviewed_by = ?
      AND candidate.reviewed_at = ?
  )`;
}

function guardBindings(input: {
  candidateId: string;
  candidateState: "accepted" | "rejected";
  reviewedBy: string;
  reviewedAt: number;
}): [string, string, string, number] {
  return [input.candidateId, input.candidateState, input.reviewedBy, input.reviewedAt];
}

async function loadClaim(db: D1Database, entryId: string): Promise<ClaimRow | null> {
  return db.prepare(
    `SELECT m.*, e.tags, pv.vault_snapshot, pv.parent_id
     FROM sb_memories m
     JOIN entries e ON e.id = m.entry_id AND e.content_hash = m.content_hash
     LEFT JOIN sb_parent_versions pv ON pv.version_id = m.parent_version_id
     WHERE m.entry_id = ?
       AND m.claim_status IN ('supported', 'confirmed', 'contested')
       AND m.invalid_at IS NULL AND m.expired_at IS NULL
     ORDER BY m.created_at DESC, m.id DESC LIMIT 1`
  ).bind(entryId).first<ClaimRow>();
}

async function loadMemoryEntityProjections(
  db: D1Database,
  claimIds: string[]
): Promise<MemoryEntityProjectionRow[]> {
  const rows = await db.prepare(
    `SELECT entity_id, role, MAX(score) AS score
     FROM sb_memory_entities
     WHERE memory_id IN (?, ?)
     GROUP BY entity_id, role
     ORDER BY entity_id, role`
  ).bind(claimIds[0], claimIds[1]).all<MemoryEntityProjectionRow>();
  return rows.results ?? [];
}

async function loadFactRelationIds(
  db: D1Database,
  claimIds: string[]
): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT DISTINCT relation_id FROM sb_fact_sources
     WHERE memory_id IN (?, ?) ORDER BY relation_id`
  ).bind(claimIds[0], claimIds[1]).all<{ relation_id: string }>();
  return (rows.results ?? []).map((row) => row.relation_id);
}

async function loadAssociationProjections(
  db: D1Database,
  parentIds: string[]
): Promise<AssociationProjectionRow[]> {
  const usable = [...new Set(parentIds.filter(Boolean))];
  if (usable.length === 0) return [];
  const placeholders = usable.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT id, source_parent_id, target_parent_id, edge_type, weight, provenance,
            metadata_json, directed, valid_from, valid_to, created_at
     FROM sb_association_edges
     WHERE deleted_at IS NULL
       AND (source_parent_id IN (${placeholders}) OR target_parent_id IN (${placeholders}))
     ORDER BY updated_at DESC, id DESC`
  ).bind(...usable, ...usable).all<AssociationProjectionRow>();
  return rows.results ?? [];
}

async function loadProvenance(db: D1Database, claimIds: string[]): Promise<ProvenanceRow[]> {
  if (claimIds.length === 0 || claimIds.length > 2) return [];
  const predicate = claimIds.length === 1 ? "memory_id = ?" : "memory_id IN (?, ?)";
  const rows = await db.prepare(
    `SELECT observation_id, score, relation, extract_span, evidence_score,
            derivation_confidence, evidence_root_id
     FROM sb_memory_sources
     WHERE ${predicate}
       AND relation IN ('supports', 'derived_from')
     ORDER BY created_at ASC, id ASC`
  ).bind(...claimIds).all<ProvenanceRow>();
  const seen = new Set<string>();
  return (rows.results ?? []).filter((row) => {
    const key = row.observation_id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function ensureKnowledgeEvolutionDataModel(db: D1Database): Promise<void> {
  for (const statement of KNOWLEDGE_EVOLUTION_SCHEMA_STATEMENTS) await db.exec(statement);
  await ensureAssociationDataModel(db);
}

export async function prepareMemoryKnowledgeEvolution(
  db: D1Database,
  input: {
    candidateId: string;
    aiReviewRunId: string;
    decision: MemoryEvolutionDecision;
    refinementContent: string | null;
    decisionConfidence: number;
    evidenceConfidence: number;
    reviewedBy: string;
    reviewedAt: number;
    /** Server-derived context from the immutable AI review manifest. */
    trustedReviewContext?: {
      scopeIds: string[];
      vaultIds: string[];
    };
  }
): Promise<MemoryKnowledgeEvolutionPlan> {
  await ensureKnowledgeEvolutionDataModel(db);
  const candidate = await db.prepare(
    `SELECT source_memory_id, target_memory_id, similarity
     FROM sb_memory_merge_candidates WHERE id = ? AND state = 'pending'`
  ).bind(input.candidateId).first<{
    source_memory_id: string;
    target_memory_id: string;
    similarity: number | null;
  }>();
  if (!candidate) throw new Error("knowledge_evolution_candidate_unavailable");
  const [source, target] = await Promise.all([
    loadClaim(db, candidate.source_memory_id),
    loadClaim(db, candidate.target_memory_id),
  ]);
  if (!source || !target) throw new Error("knowledge_evolution_claim_unavailable");
  const normalizedContext = (values: string[] | undefined) =>
    [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
  const resolveContext = (
    sourceValue: string | null,
    targetValue: string | null,
    reviewedValues: string[] | undefined,
    mismatchError: string,
    ambiguousError: string
  ): string | null => {
    const sourceContext = sourceValue?.trim() || null;
    const targetContext = targetValue?.trim() || null;
    if (sourceContext || targetContext) {
      if (!sourceContext || sourceContext !== targetContext) throw new Error(mismatchError);
      return sourceContext;
    }
    const derived = normalizedContext(reviewedValues);
    if (derived.length === 0) throw new Error(mismatchError);
    if (input.decision === "merge" && derived.length !== 1) throw new Error(ambiguousError);
    return derived.length === 1 ? derived[0] : null;
  };
  const effectiveScopeId = resolveContext(
    source.scope_id,
    target.scope_id,
    input.trustedReviewContext?.scopeIds,
    "knowledge_evolution_scope_mismatch",
    "knowledge_evolution_scope_context_ambiguous"
  );
  const effectiveVaultId = resolveContext(
    source.vault_snapshot,
    target.vault_snapshot,
    input.trustedReviewContext?.vaultIds,
    "knowledge_evolution_vault_mismatch",
    "knowledge_evolution_vault_context_ambiguous"
  );
  const ownership = await db.prepare(
    `SELECT claim_id FROM sb_knowledge_claim_ownership WHERE claim_id IN (?, ?) LIMIT 1`
  ).bind(source.id, target.id).first<{ claim_id: string }>();
  if (ownership) throw new Error("knowledge_evolution_claim_already_owned");

  const operation = input.decision === "duplicate"
    ? "consolidate"
    : input.decision === "replace"
      ? "supersede"
      : input.decision === "keep_both"
        ? "keep_separate"
        : "merge";
  const candidateState = input.decision === "keep_both" ? "rejected" : "accepted";
  const generationRow = await db.prepare(
    `SELECT COALESCE(MAX(generation), 0) AS generation
     FROM sb_knowledge_evolutions
     WHERE output_claim_id IN (?, ?)`
  ).bind(source.id, target.id).first<{ generation: number }>();
  const generation = Number(generationRow?.generation ?? 0) + 1;
  const evolutionId = crypto.randomUUID();
  const outputGenerated = input.decision === "merge";
  const generatedParentId = outputGenerated ? crypto.randomUUID() : null;
  const outputEntryId = outputGenerated ? crypto.randomUUID() : input.decision === "duplicate"
    ? target.entry_id
    : input.decision === "replace"
      ? source.entry_id
      : null;
  const outputClaimId = outputGenerated ? crypto.randomUUID() : input.decision === "duplicate"
    ? target.id
    : input.decision === "replace"
      ? source.id
      : null;
  const guard = guardBindings({
    candidateId: input.candidateId,
    candidateState,
    reviewedBy: input.reviewedBy,
    reviewedAt: input.reviewedAt,
  });
  const statements: D1PreparedStatement[] = [];
  statements.push(db.prepare(
    `INSERT INTO sb_knowledge_evolutions (
       id, ai_review_run_id, candidate_id, operation, state, generation,
       output_entry_id, output_claim_id, output_generated,
       decision_confidence, evidence_confidence, applied_by, applied_at,
       created_at, updated_at
     ) SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${candidateGuard()}`
  ).bind(
    evolutionId,
    input.aiReviewRunId,
    input.candidateId,
    operation,
    generation,
    outputEntryId,
    outputClaimId,
    Number(outputGenerated),
    input.decisionConfidence,
    input.evidenceConfidence,
    input.reviewedBy,
    input.reviewedAt,
    input.reviewedAt,
    input.reviewedAt,
    ...guard
  ));

  const sourceDispositions = input.decision === "merge"
    ? [[source, "absorbed"], [target, "absorbed"]] as const
    : input.decision === "duplicate"
      ? [[source, "absorbed"], [target, "retained"]] as const
      : input.decision === "replace"
        ? [[source, "retained"], [target, "superseded"]] as const
      : [[source, "retained"], [target, "retained"]] as const;
  const sourceClaims = [source.id, target.id];
  const sourceParents = [source.parent_id, target.parent_id].filter((value): value is string => Boolean(value));
  const outputParentId = generatedParentId ?? (input.decision === "duplicate"
    ? target.parent_id
    : input.decision === "replace" ? source.parent_id : null);
  const entityProjections = outputClaimId
    ? await loadMemoryEntityProjections(db, sourceClaims)
    : [];
  const factRelationIds = await loadFactRelationIds(db, sourceClaims);
  const associationProjections = await loadAssociationProjections(db, sourceParents);
  sourceDispositions.forEach(([claim, disposition], index) => {
    statements.push(db.prepare(
      `INSERT INTO sb_knowledge_evolution_sources (
         evolution_id, claim_id, entry_id, disposition, previous_claim_status,
         previous_invalid_at, source_order, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${candidateGuard()}`
    ).bind(
      evolutionId,
      claim.id,
      claim.entry_id,
      disposition,
      claim.claim_status,
      claim.invalid_at,
      index,
      input.reviewedAt,
      ...guard
    ));
    if (disposition !== "retained") {
      statements.push(db.prepare(
        `INSERT INTO sb_knowledge_claim_ownership (claim_id, evolution_id, acquired_at)
         SELECT ?, ?, ? WHERE ${candidateGuard()}`
      ).bind(claim.id, evolutionId, input.reviewedAt, ...guard));
      statements.push(db.prepare(
        `UPDATE sb_memories
         SET claim_status = 'superseded', invalid_at = ?
         WHERE id = ? AND claim_status = ? AND invalid_at IS ?
           AND ${candidateGuard()}`
      ).bind(input.reviewedAt, claim.id, claim.claim_status, claim.invalid_at, ...guard));
    }
  });

  const provenance = await loadProvenance(
    db,
    input.decision === "duplicate" ? [source.id] : [source.id, target.id]
  );
  if (provenance.length === 0) throw new Error("knowledge_evolution_provenance_required");
  if (input.decision === "duplicate") {
    for (const proof of provenance) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO sb_memory_sources (
           id, memory_id, observation_id, role, score, relation, extract_span,
           evidence_score, derivation_confidence, extractor_model,
           extractor_version, evidence_root_id, created_at
         ) SELECT ?, ?, ?, 'derived_from', ?, 'derived_from', ?, ?, ?,
                  'knowledge-evolution', ?, ?, ?
           WHERE ${candidateGuard()}`
      ).bind(
        projectionId(evolutionId, "memory-relation"),
        target.id,
        proof.observation_id,
        proof.score,
        proof.extract_span,
        proof.evidence_score,
        input.evidenceConfidence,
        `review:${input.aiReviewRunId}`,
        proof.evidence_root_id ?? proof.observation_id,
        input.reviewedAt,
        ...guard
      ));
    }
  }

  if (outputGenerated) {
    const content = input.refinementContent?.trim();
    if (!content) throw new Error("knowledge_evolution_refinement_required");
    const contentHash = await sha256(content);
    const parentVersionId = crypto.randomUUID();
    const tags = uniqueJsonValues(source.tags, target.tags);
    const entities = uniqueJsonValues(source.entities_json, target.entities_json);
    const observedAt = Math.max(source.observed_at ?? 0, target.observed_at ?? 0) || input.reviewedAt;
    statements.push(db.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids, content_hash,
         classification_status, classification_confidence, classified_at
       ) SELECT ?, ?, ?, 'system', ?, '[]', ?, 'completed', ?, ?
         WHERE ${candidateGuard()}`
    ).bind(
      outputEntryId,
      content,
      tags,
      input.reviewedAt,
      contentHash,
      input.decisionConfidence,
      input.reviewedAt,
      ...guard
    ));
    statements.push(db.prepare(
      `INSERT INTO sb_parent_units (parent_id, active_version_id, scope_id, created_at, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE ${candidateGuard()}`
    ).bind(generatedParentId, parentVersionId, effectiveScopeId, input.reviewedAt, input.reviewedAt, ...guard));
    statements.push(db.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, source_snapshot_hash,
         tags_snapshot_json, source_snapshot, vault_snapshot, summary, state,
         activated_at, activation_time_source, created_at, updated_at
       ) SELECT ?, ?, 1, ?, ?, 'knowledge_evolution', ?, ?, 'active', ?, 'derived', ?, ?
         WHERE ${candidateGuard()}`
    ).bind(
      parentVersionId,
      generatedParentId,
      contentHash,
      tags,
      effectiveVaultId,
      content,
      input.reviewedAt,
      input.reviewedAt,
      input.reviewedAt,
      ...guard
    ));
    statements.push(db.prepare(
      `INSERT INTO sb_memories (
         id, content, kind, memory_class, importance, confidence, entry_id,
         parent_version_id, claim_subject, claim_predicate, claim_object,
         scope_id, polarity, modality, claim_status, scores_json, content_hash,
         observed_at, valid_from, valid_to, reference_time, entities_json, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'supported', ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${candidateGuard()}`
    ).bind(
      outputClaimId,
      content,
      sameOrNull(source.kind, target.kind) ?? "semantic",
      sameOrNull(source.memory_class, target.memory_class) ?? "summary",
      Math.max(source.importance ?? 0, target.importance ?? 0) || null,
      input.decisionConfidence,
      outputEntryId,
      parentVersionId,
      sameOrNull(source.claim_subject, target.claim_subject),
      sameOrNull(source.claim_predicate, target.claim_predicate),
      sameOrNull(source.claim_object, target.claim_object),
      effectiveScopeId,
      sameOrNull(source.polarity, target.polarity) ?? "positive",
      sameOrNull(source.modality, target.modality) ?? "asserted",
      JSON.stringify({
        derivationConfidence: input.decisionConfidence,
        evidenceQuality: input.evidenceConfidence,
        evolutionGeneration: generation,
      }),
      contentHash,
      observedAt,
      sameOrNull(
        source.valid_from == null ? null : String(source.valid_from),
        target.valid_from == null ? null : String(target.valid_from)
      ),
      sameOrNull(
        source.valid_to == null ? null : String(source.valid_to),
        target.valid_to == null ? null : String(target.valid_to)
      ),
      Math.max(source.reference_time ?? 0, target.reference_time ?? 0) || null,
      entities,
      input.reviewedAt,
      ...guard
    ));
    statements.push(db.prepare(
      `INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
       SELECT ?, ?, 'supports', ? WHERE ${candidateGuard()}`
    ).bind(parentVersionId, outputClaimId, input.reviewedAt, ...guard));
    for (const proof of provenance) {
      statements.push(db.prepare(
        `INSERT INTO sb_memory_sources (
           id, memory_id, observation_id, role, score, relation, extract_span,
           evidence_score, derivation_confidence, extractor_model,
           extractor_version, evidence_root_id, created_at
         ) SELECT ?, ?, ?, 'derived_from', ?, 'derived_from', ?, ?, ?,
                  'knowledge-evolution', ?, ?, ?
           WHERE ${candidateGuard()}`
      ).bind(
        projectionId(evolutionId, "memory-relation"),
        outputClaimId,
        proof.observation_id,
        proof.score,
        proof.extract_span,
        proof.evidence_score,
        input.decisionConfidence,
        `review:${input.aiReviewRunId}`,
        proof.evidence_root_id ?? proof.observation_id,
        input.reviewedAt,
        ...guard
      ));
    }
  }

  if (outputEntryId) {
    const relatedSources = [source, target].filter((claim) => claim.entry_id !== outputEntryId);
    for (const related of relatedSources) {
      const relationType = input.decision === "replace" ? "supersedes" : "derived_from";
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO sb_memory_relations (
           id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${candidateGuard()}`
      ).bind(
        projectionId(evolutionId, "memory-relation"),
        outputEntryId,
        related.entry_id,
        relationType,
        input.decisionConfidence,
        JSON.stringify({ evolutionId, generation, aiReviewRunId: input.aiReviewRunId }),
        input.reviewedAt,
        ...guard
      ));
    }
  } else if (input.decision === "keep_both") {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO sb_memory_relations (
         id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at
       ) SELECT ?, ?, ?, 'similar', ?, ?, ? WHERE ${candidateGuard()}`
    ).bind(
      projectionId(evolutionId, "memory-relation"),
      source.entry_id,
      target.entry_id,
      candidate.similarity ?? input.decisionConfidence,
      JSON.stringify({ evolutionId, generation, disposition: "keep_separate" }),
      input.reviewedAt,
      ...guard
    ));
  }

  if (outputClaimId) {
    for (const entity of entityProjections) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO sb_memory_entities (
           id, memory_id, entity_id, role, score, created_at
         ) SELECT ?, ?, ?, ?, ?, ? WHERE ${candidateGuard()}`
      ).bind(
        projectionId(evolutionId, "memory-entity"),
        outputClaimId,
        entity.entity_id,
        entity.role,
        entity.score,
        input.reviewedAt,
        ...guard
      ));
    }
  }

  if (outputClaimId && ["merge", "duplicate"].includes(input.decision)) {
    for (const relationId of factRelationIds) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO sb_fact_sources (
           id, relation_id, memory_id, observation_id, created_at
         ) SELECT ?, ?, ?, NULL, ? WHERE ${candidateGuard()}`
      ).bind(
        projectionId(evolutionId, "fact-source"),
        relationId,
        outputClaimId,
        input.reviewedAt,
        ...guard
      ));
    }
  }

  const invalidatedClaims = sourceDispositions
    .filter(([, disposition]) => disposition !== "retained")
    .map(([claim]) => claim.id);
  if (invalidatedClaims.length) {
    const affectedRelations = await loadFactRelationIds(
      db,
      invalidatedClaims.length === 1
        ? [invalidatedClaims[0], invalidatedClaims[0]]
        : invalidatedClaims
    );
    for (const relationId of affectedRelations) {
      const evidenceCountSql = distinctFactEvidenceCountSql({
        relationIdSql: "?",
        activeMemoriesOnly: true,
        asOf: input.reviewedAt,
      });
      statements.push(db.prepare(
        `UPDATE sb_entity_relations
         SET evidence_count = MAX(1, ${evidenceCountSql}),
             resolution_state = CASE WHEN ${evidenceCountSql} = 0
               THEN 'superseded' ELSE resolution_state END,
             invalid_at = CASE WHEN ${evidenceCountSql} = 0
               THEN COALESCE(invalid_at, ?) ELSE invalid_at END
         WHERE id = ? AND ${candidateGuard()}`
      ).bind(
        relationId,
        relationId,
        relationId,
        input.reviewedAt,
        relationId,
        ...guard
      ));
    }
  }

  if (outputParentId) {
    const replacedParents = new Set(sourceDispositions
      .filter(([, disposition]) => disposition !== "retained")
      .map(([claim]) => claim.parent_id)
      .filter((value): value is string => Boolean(value)));
    const projectedEdges = groupAssociationProjections(
      associationProjections,
      replacedParents,
      outputParentId,
      evolutionId,
      generation
    );
    for (const edge of projectedEdges) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO sb_knowledge_evolution_association_snapshots (
           evolution_id, edge_id, source_parent_id, target_parent_id, edge_type,
           weight, provenance, metadata_json, directed, valid_from, valid_to,
           deleted_at, created_at, updated_at
         ) SELECT ?, id, source_parent_id, target_parent_id, edge_type,
                  weight, provenance, metadata_json, directed, valid_from, valid_to,
                  deleted_at, created_at, updated_at
           FROM sb_association_edges
          WHERE source_parent_id = ? AND target_parent_id = ? AND edge_type = ?
            AND ${candidateGuard()}`
      ).bind(
        evolutionId,
        edge.sourceParentId,
        edge.targetParentId,
        edge.edgeType,
        ...guard
      ));
      statements.push(db.prepare(
        `DELETE FROM sb_association_edges
          WHERE source_parent_id = ? AND target_parent_id = ? AND edge_type = ?
            AND ${candidateGuard()}`
      ).bind(edge.sourceParentId, edge.targetParentId, edge.edgeType, ...guard));
      statements.push(db.prepare(
        `INSERT INTO sb_association_edges (
           id, source_parent_id, target_parent_id, edge_type, weight,
           provenance, metadata_json, directed, valid_from, valid_to,
           deleted_at, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, 'system', ?, ?, ?, ?, NULL, ?, ?
           WHERE ${candidateGuard()}`
      ).bind(
        projectionId(evolutionId, "association"),
        edge.sourceParentId,
        edge.targetParentId,
        edge.edgeType,
        edge.weight,
        JSON.stringify(edge.metadata),
        edge.directed,
        edge.validFrom,
        edge.validTo,
        input.reviewedAt,
        input.reviewedAt,
        ...guard
      ));
    }
  } else if (input.decision === "keep_both" && source.parent_id && target.parent_id) {
    const [left, right] = normalizedAssociationEndpoints(source.parent_id, target.parent_id, 0);
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO sb_knowledge_evolution_association_snapshots (
         evolution_id, edge_id, source_parent_id, target_parent_id, edge_type,
         weight, provenance, metadata_json, directed, valid_from, valid_to,
         deleted_at, created_at, updated_at
       ) SELECT ?, id, source_parent_id, target_parent_id, edge_type,
                weight, provenance, metadata_json, directed, valid_from, valid_to,
                deleted_at, created_at, updated_at
         FROM sb_association_edges
        WHERE source_parent_id = ? AND target_parent_id = ? AND edge_type = 'related_to'
          AND ${candidateGuard()}`
    ).bind(evolutionId, left, right, ...guard));
    statements.push(db.prepare(
      `DELETE FROM sb_association_edges
        WHERE source_parent_id = ? AND target_parent_id = ? AND edge_type = 'related_to'
          AND ${candidateGuard()}`
    ).bind(left, right, ...guard));
    statements.push(db.prepare(
      `INSERT INTO sb_association_edges (
         id, source_parent_id, target_parent_id, edge_type, weight,
         provenance, metadata_json, directed, valid_from, valid_to,
         deleted_at, created_at, updated_at
       ) SELECT ?, ?, ?, 'related_to', ?, 'system', ?, 0, ?, NULL, NULL, ?, ?
         WHERE ${candidateGuard()}`
    ).bind(
      projectionId(evolutionId, "association"),
      left,
      right,
      candidate.similarity ?? input.decisionConfidence,
      JSON.stringify({ evolutionId, generation, disposition: "keep_separate" }),
      input.reviewedAt,
      input.reviewedAt,
      input.reviewedAt,
      ...guard
    ));
  }

  for (const entryId of [source.entry_id, target.entry_id]) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO sb_knowledge_evolution_aggregate_snapshots (
         evolution_id, aggregate_id, previous_stale_at, previous_updated_at
       ) SELECT ?, id, stale_at, updated_at
           FROM sb_knowledge_aggregates
          WHERE source_memory_ids_json LIKE ? AND ${candidateGuard()}`
    ).bind(evolutionId, `%"${entryId}"%`, ...guard));
    statements.push(db.prepare(
      `UPDATE sb_knowledge_aggregates
       SET stale_at = COALESCE(stale_at, ?), updated_at = ?
       WHERE source_memory_ids_json LIKE ? AND ${candidateGuard()}`
    ).bind(input.reviewedAt, input.reviewedAt, `%"${entryId}"%`, ...guard));
  }
  statements.push(db.prepare(
    `INSERT INTO sb_knowledge_evolution_history (
       id, evolution_id, action, actor_id, reason, created_at
     ) SELECT ?, ?, 'applied', ?, ?, ? WHERE ${candidateGuard()}`
  ).bind(
    crypto.randomUUID(),
    evolutionId,
    input.reviewedBy,
    `AI review ${input.aiReviewRunId}`,
    input.reviewedAt,
    ...guard
  ));
  return { evolutionId, outputEntryId, outputClaimId, generation, statements };
}

export async function rollbackKnowledgeEvolution(
  db: D1Database,
  input: { evolutionId: string; actorId: string; reason: string; rolledBackAt?: number }
): Promise<void> {
  await ensureKnowledgeEvolutionDataModel(db);
  const evolution = await db.prepare(
    `SELECT id, state, operation, ai_review_run_id, output_claim_id,
            output_generated, applied_at
     FROM sb_knowledge_evolutions WHERE id = ?`
  ).bind(input.evolutionId).first<{
    id: string;
    state: string;
    operation: string;
    ai_review_run_id: string;
    output_claim_id: string | null;
    output_generated: number;
    applied_at: number;
  }>();
  if (!evolution || evolution.state !== "active") throw new Error("knowledge_evolution_not_active");
  if (evolution.output_claim_id) {
    const downstream = await db.prepare(
      `SELECT child.id AS evolution_id
       FROM sb_knowledge_evolution_sources dependency
       JOIN sb_knowledge_evolutions child
         ON child.id = dependency.evolution_id AND child.state = 'active'
       WHERE dependency.claim_id = ? AND child.id <> ?
       LIMIT 1`
    ).bind(evolution.output_claim_id, evolution.id).first<{ evolution_id: string }>();
    if (downstream) throw new Error("knowledge_evolution_has_active_descendant");
  }
  const sources = await db.prepare(
    `SELECT claim_id, disposition, previous_claim_status, previous_invalid_at
     FROM sb_knowledge_evolution_sources WHERE evolution_id = ? ORDER BY source_order`
  ).bind(evolution.id).all<{
    claim_id: string;
    disposition: string;
    previous_claim_status: string;
    previous_invalid_at: number | null;
  }>();
  const rolledBackAt = input.rolledBackAt ?? Date.now();
  const projectedFactRelations = await db.prepare(
    `SELECT DISTINCT fact.relation_id
     FROM sb_knowledge_evolution_sources source
     JOIN sb_fact_sources fact ON fact.memory_id = source.claim_id
     WHERE source.evolution_id = ?
     ORDER BY fact.relation_id`
  ).bind(evolution.id).all<{ relation_id: string }>();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE sb_knowledge_evolutions
       SET state = 'rolled_back', rolled_back_by = ?, rolled_back_at = ?,
           rollback_reason = ?, updated_at = ?
       WHERE id = ? AND state = 'active'`
    ).bind(input.actorId, rolledBackAt, input.reason, rolledBackAt, evolution.id),
  ];
  for (const source of sources.results ?? []) {
    if (source.disposition === "retained") continue;
    statements.push(db.prepare(
      `UPDATE sb_memories
       SET claim_status = ?, invalid_at = ?
       WHERE id = ? AND claim_status = 'superseded' AND invalid_at = ?
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(
      source.previous_claim_status,
      source.previous_invalid_at,
      source.claim_id,
      evolution.applied_at,
      evolution.id,
      rolledBackAt
    ));
    statements.push(db.prepare(
      `DELETE FROM sb_knowledge_claim_ownership
       WHERE claim_id = ? AND evolution_id = ?
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(source.claim_id, evolution.id, evolution.id, rolledBackAt));
  }
  if (evolution.output_generated && evolution.output_claim_id) {
    statements.push(db.prepare(
      `UPDATE sb_memories
       SET claim_status = 'deprecated', invalid_at = ?
       WHERE id = ? AND claim_status IN ('supported', 'confirmed', 'contested')
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(rolledBackAt, evolution.output_claim_id, evolution.id, rolledBackAt));
  }
  if (evolution.operation === "consolidate" && evolution.output_claim_id) {
    statements.push(db.prepare(
      `DELETE FROM sb_memory_sources
       WHERE memory_id = ?
         AND extractor_model = 'knowledge-evolution'
         AND extractor_version = ?
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(
      evolution.output_claim_id,
      `review:${evolution.ai_review_run_id}`,
      evolution.id,
      rolledBackAt
    ));
  }
  statements.push(
    db.prepare(
      `DELETE FROM sb_memory_entities
       WHERE id LIKE ?
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(`knowledge-evolution:${evolution.id}:memory-entity:%`, evolution.id, rolledBackAt),
    db.prepare(
      `DELETE FROM sb_fact_sources
       WHERE id LIKE ?
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(`knowledge-evolution:${evolution.id}:fact-source:%`, evolution.id, rolledBackAt),
    db.prepare(
      `DELETE FROM sb_memory_relations
       WHERE id LIKE ?
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(`knowledge-evolution:${evolution.id}:memory-relation:%`, evolution.id, rolledBackAt),
    db.prepare(
      `DELETE FROM sb_association_edges
       WHERE id LIKE ?
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(`knowledge-evolution:${evolution.id}:association:%`, evolution.id, rolledBackAt)
  );
  statements.push(db.prepare(
    `INSERT INTO sb_association_edges (
       id, source_parent_id, target_parent_id, edge_type, weight,
       provenance, metadata_json, directed, valid_from, valid_to,
       deleted_at, created_at, updated_at
     )
     SELECT snapshot.edge_id, snapshot.source_parent_id, snapshot.target_parent_id,
            snapshot.edge_type, snapshot.weight, snapshot.provenance,
            snapshot.metadata_json, snapshot.directed, snapshot.valid_from,
            snapshot.valid_to, snapshot.deleted_at, snapshot.created_at,
            snapshot.updated_at
       FROM sb_knowledge_evolution_association_snapshots snapshot
      WHERE snapshot.evolution_id = ?
        AND EXISTS (
          SELECT 1 FROM sb_knowledge_evolutions
          WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
        )`
  ).bind(evolution.id, evolution.id, rolledBackAt));
  statements.push(db.prepare(
    `UPDATE sb_knowledge_aggregates
        SET stale_at = (
              SELECT snapshot.previous_stale_at
                FROM sb_knowledge_evolution_aggregate_snapshots snapshot
               WHERE snapshot.evolution_id = ? AND snapshot.aggregate_id = sb_knowledge_aggregates.id
            ),
            updated_at = (
              SELECT snapshot.previous_updated_at
                FROM sb_knowledge_evolution_aggregate_snapshots snapshot
               WHERE snapshot.evolution_id = ? AND snapshot.aggregate_id = sb_knowledge_aggregates.id
            )
      WHERE id IN (
              SELECT aggregate_id FROM sb_knowledge_evolution_aggregate_snapshots
               WHERE evolution_id = ?
            )
        AND EXISTS (
          SELECT 1 FROM sb_knowledge_evolutions
          WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
        )`
  ).bind(evolution.id, evolution.id, evolution.id, evolution.id, rolledBackAt));
  for (const relation of projectedFactRelations.results ?? []) {
    const evidenceCountSql = distinctFactEvidenceCountSql({
      relationIdSql: "?",
      activeMemoriesOnly: true,
      asOf: rolledBackAt,
      floorAtOne: true,
    });
    statements.push(db.prepare(
      `UPDATE sb_entity_relations
       SET evidence_count = ${evidenceCountSql},
           resolution_state = CASE
             WHEN resolution_state = 'superseded' AND invalid_at = ? THEN 'active'
             ELSE resolution_state
           END,
           invalid_at = CASE
             WHEN resolution_state = 'superseded' AND invalid_at = ? THEN NULL
             ELSE invalid_at
           END
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM sb_knowledge_evolutions
           WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
         )`
    ).bind(
      relation.relation_id,
      evolution.applied_at,
      evolution.applied_at,
      relation.relation_id,
      evolution.id,
      rolledBackAt
    ));
  }
  statements.push(db.prepare(
    `INSERT INTO sb_knowledge_evolution_history (
       id, evolution_id, action, actor_id, reason, created_at
     ) SELECT ?, ?, 'rolled_back', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM sb_knowledge_evolutions
         WHERE id = ? AND state = 'rolled_back' AND rolled_back_at = ?
       )`
  ).bind(
    crypto.randomUUID(),
    evolution.id,
    input.actorId,
    input.reason,
    rolledBackAt,
    evolution.id,
    rolledBackAt
  ));
  const results = await db.batch(statements);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw new Error("knowledge_evolution_rollback_conflict");
}
