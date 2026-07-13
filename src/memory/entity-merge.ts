import { ensureEntityDataModel, ensureEntityResolutionDataModel } from "./entities";
import { distinctFactEvidenceCountSql } from "./fact-evidence";
import { prepareComplianceAuditEvent } from "./quality";

export type EntityMergeDecision = "accept" | "reject";
export const ENTITY_MERGE_CANDIDATE_STATES = ["pending", "accepted", "rejected", "merged"] as const;
export type EntityMergeCandidateState = (typeof ENTITY_MERGE_CANDIDATE_STATES)[number];

export interface EntityMergeInput {
  candidateId: string;
  decision: EntityMergeDecision;
  actorType: string;
  actorId: string;
  reviewedBy?: string | null;
  tokenId?: string | null;
  vaultId?: string | null;
  reason?: string | null;
  reviewedAt?: number;
}

export interface EntityMergeResult {
  candidateId: string;
  sourceEntityId: string;
  targetEntityId: string;
  state: "merged" | "rejected";
}

export class EntityMergeCandidateUnavailableError extends Error {
  constructor(candidateId: string) {
    super(`Entity merge candidate is unavailable: ${candidateId}`);
    this.name = "EntityMergeCandidateUnavailableError";
  }
}

export class EntityMergeEndpointUnavailableError extends Error {
  constructor() {
    super("Entity merge requires two distinct active entities");
    this.name = "EntityMergeEndpointUnavailableError";
  }
}

interface CandidateRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  state: string;
  reviewed_by: string | null;
  reviewed_at: number | null;
}

interface EntityRow {
  id: string;
  name: string;
  name_normalized: string;
  entity_type: string | null;
  aliases_json: string;
  metadata_json: string;
  mention_count: number;
  lifecycle_state: string;
  created_at: number;
}

interface AliasRow {
  id: string;
  alias: string;
  alias_normalized: string;
  source_observation_id: string | null;
  confidence: number | null;
  created_at: number;
}

interface RelationRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  fact: string | null;
  fact_hash: string | null;
  scope_id: string | null;
  polarity: string | null;
  modality: string | null;
  valid_from: number | null;
  valid_to: number | null;
  created_at: number;
}

interface MergeLock {
  candidateId: string;
  reviewedBy: string;
  reviewedAt: number;
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.map(String).map((item) => item.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

function mergeMetadata(source: string, target: string): string {
  const sourceMetadata = parseObject(source);
  const targetMetadata = parseObject(target);
  const externalIds = [
    ...(Array.isArray(targetMetadata.external_ids) ? targetMetadata.external_ids : []),
    ...(Array.isArray(sourceMetadata.external_ids) ? sourceMetadata.external_ids : []),
  ];
  const externalIdEntries = externalIds.flatMap((item): Array<[string, { provider: string; value: string }]> => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const provider = normalize(String(record.provider ?? ""));
    const value = String(record.value ?? record.id ?? "").trim();
    return provider && value ? [[`${provider}\u001f${value}`, { provider, value }]] : [];
  });
  const uniqueExternalIds = [...new Map(externalIdEntries).values()];
  return JSON.stringify({
    ...sourceMetadata,
    ...targetMetadata,
    external_ids: uniqueExternalIds,
  });
}

function mergeAliases(source: EntityRow, target: EntityRow, sourceAliases: AliasRow[]): string[] {
  const aliases = [
    ...parseStringArray(target.aliases_json),
    ...parseStringArray(source.aliases_json),
    ...sourceAliases.map((item) => item.alias),
    source.name,
  ];
  const targetName = normalize(target.name);
  return [...new Map(
    aliases
      .map((alias) => alias.trim())
      .filter((alias) => alias && normalize(alias) !== targetName)
      .map((alias) => [normalize(alias), alias])
  ).values()];
}

function sourceIdentityAliases(source: EntityRow, sourceAliases: AliasRow[]): AliasRow[] {
  const legacyAliases: AliasRow[] = parseStringArray(source.aliases_json).map((alias) => ({
    id: `legacy:${normalize(alias)}`,
    alias,
    alias_normalized: normalize(alias),
    source_observation_id: null,
    confidence: null,
    created_at: source.created_at,
  }));
  const canonical: AliasRow = {
    id: "source-canonical",
    alias: source.name,
    alias_normalized: normalize(source.name),
    source_observation_id: null,
    confidence: 1,
    created_at: source.created_at,
  };
  return [...new Map(
    [...legacyAliases, canonical, ...sourceAliases].map((alias) => [alias.alias_normalized, alias])
  ).values()];
}

function guardSql(): string {
  return `EXISTS (
    SELECT 1 FROM sb_entity_merge_candidates merge_guard
    WHERE merge_guard.id = ?
      AND merge_guard.state = 'accepted'
      AND merge_guard.reviewed_by = ?
      AND merge_guard.reviewed_at = ?
  )`;
}

function guardBindings(lock: MergeLock): [string, string, number] {
  return [lock.candidateId, lock.reviewedBy, lock.reviewedAt];
}

function relationKey(row: RelationRow, sourceEntityId: string, targetEntityId: string): string {
  const from = row.from_entity_id === sourceEntityId ? targetEntityId : row.from_entity_id;
  const to = row.to_entity_id === sourceEntityId ? targetEntityId : row.to_entity_id;
  return JSON.stringify([
    from,
    to,
    row.relation_type,
    row.fact_hash ?? normalize(row.fact ?? ""),
    row.scope_id,
    row.polarity,
    row.modality,
    row.valid_from,
    row.valid_to,
  ]);
}

function guardedAuditStatement(
  db: D1Database,
  audit: Awaited<ReturnType<typeof prepareComplianceAuditEvent>>,
  lock: MergeLock,
  finalState: "merged" | "rejected"
): D1PreparedStatement {
  const row = audit.record;
  return db.prepare(
    `INSERT INTO sb_audit_events (
       id, occurred_at, trace_id, actor_type, actor_id, token_id,
       action, object_type, object_id, vault_id, before_hash, after_hash,
       success, error_code, metadata_json, previous_event_hash, event_hash
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM sb_entity_merge_candidates
       WHERE id = ? AND state = ? AND reviewed_by = ? AND reviewed_at = ?
     )`
  ).bind(
    row.id,
    row.occurred_at,
    row.trace_id,
    row.actor_type,
    row.actor_id,
    row.token_id,
    row.action,
    row.object_type,
    row.object_id,
    row.vault_id,
    row.before_hash,
    row.after_hash,
    row.success,
    row.error_code,
    row.metadata_json,
    row.previous_event_hash,
    row.event_hash,
    lock.candidateId,
    finalState,
    lock.reviewedBy,
    lock.reviewedAt
  );
}

export class D1EntityMergeExecutor {
  constructor(private readonly db: D1Database) {}

  async resolve(input: EntityMergeInput): Promise<EntityMergeResult> {
    const candidateId = boundedText(input.candidateId, 256);
    const actorType = boundedText(input.actorType, 64);
    const actorId = boundedText(input.actorId, 256);
    const reviewedBy = boundedText(input.reviewedBy, 256) || actorId;
    const reason = boundedText(input.reason, 1000) || null;
    const reviewedAt = input.reviewedAt ?? Date.now();
    if (!candidateId || !actorType || !actorId) {
      throw new Error("candidateId, actorType, and actorId are required");
    }
    await ensureEntityDataModel(this.db);
    await ensureEntityResolutionDataModel(this.db);

    const candidate = await this.loadCandidate(candidateId);
    if (!candidate) {
      throw new EntityMergeCandidateUnavailableError(candidateId);
    }
    if (input.decision === "reject") {
      if (candidate.state !== "pending") {
        throw new EntityMergeCandidateUnavailableError(candidateId);
      }
      return await this.reject(
        candidate,
        { candidateId, reviewedBy, reviewedAt },
        actorType,
        actorId,
        reason,
        input.tokenId ?? null,
        input.vaultId ?? null
      );
    }
    if (input.decision !== "accept") throw new Error("Unsupported entity merge decision");
    if (candidate.state !== "pending" && candidate.state !== "accepted") {
      throw new EntityMergeCandidateUnavailableError(candidateId);
    }
    const lock = candidate.state === "accepted"
      ? {
          candidateId,
          reviewedBy: candidate.reviewed_by ?? "",
          reviewedAt: Number(candidate.reviewed_at),
        }
      : { candidateId, reviewedBy, reviewedAt };
    if (!lock.reviewedBy || !Number.isFinite(lock.reviewedAt)) {
      throw new EntityMergeCandidateUnavailableError(candidateId);
    }
    return await this.accept(
      candidate,
      lock,
      actorType,
      actorId,
      reason,
      input.tokenId ?? null,
      input.vaultId ?? null
    );
  }

  private async loadCandidate(candidateId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT id, source_entity_id, target_entity_id, state, reviewed_by, reviewed_at
       FROM sb_entity_merge_candidates
       WHERE id = ?`
    ).bind(candidateId).first<CandidateRow>();
  }

  private async reject(
    candidate: CandidateRow,
    lock: MergeLock,
    actorType: string,
    auditActorId: string,
    reason: string | null,
    tokenId: string | null,
    vaultId: string | null
  ): Promise<EntityMergeResult> {
    const audit = await prepareComplianceAuditEvent(this.db, {
      occurredAt: lock.reviewedAt,
      actorType,
      actorId: auditActorId,
      tokenId,
      vaultId,
      action: "quality.entity_merge.reject",
      objectType: "entity_merge_candidate",
      objectId: lock.candidateId,
      metadata: { reason },
    });
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE sb_entity_merge_candidates
         SET state = 'rejected', reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`
      ).bind(lock.reviewedBy, lock.reviewedAt, lock.reviewedAt, lock.candidateId),
      guardedAuditStatement(this.db, audit, lock, "rejected"),
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      throw new EntityMergeCandidateUnavailableError(lock.candidateId);
    }
    return {
      candidateId: lock.candidateId,
      sourceEntityId: candidate.source_entity_id,
      targetEntityId: candidate.target_entity_id,
      state: "rejected",
    };
  }

  private async accept(
    candidate: CandidateRow,
    lock: MergeLock,
    actorType: string,
    auditActorId: string,
    reason: string | null,
    tokenId: string | null,
    vaultId: string | null
  ): Promise<EntityMergeResult> {
    if (candidate.source_entity_id === candidate.target_entity_id) {
      throw new EntityMergeEndpointUnavailableError();
    }
    if (candidate.state === "pending") {
      const locked = await this.db.prepare(
        `UPDATE sb_entity_merge_candidates
         SET state = 'accepted', reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`
      ).bind(lock.reviewedBy, lock.reviewedAt, lock.reviewedAt, lock.candidateId).run();
      if (Number(locked.meta?.changes ?? 0) !== 1) {
        throw new EntityMergeCandidateUnavailableError(lock.candidateId);
      }
    }

    const [source, target] = await Promise.all([
      this.loadActiveEntity(candidate.source_entity_id),
      this.loadActiveEntity(candidate.target_entity_id),
    ]);
    if (!source || !target) {
      await this.releaseAcceptedLock(lock);
      throw new EntityMergeEndpointUnavailableError();
    }

    const aliases = await this.db.prepare(
      `SELECT id, alias, alias_normalized, source_observation_id,
              confidence, created_at
       FROM sb_entity_aliases
       WHERE entity_id = ?
       ORDER BY created_at, id`
    ).bind(source.id).all<AliasRow>();
    const relations = await this.db.prepare(
      `SELECT id, from_entity_id, to_entity_id, relation_type, fact, fact_hash,
              scope_id, polarity, modality, valid_from, valid_to, created_at
       FROM sb_entity_relations
       WHERE from_entity_id IN (?, ?) OR to_entity_id IN (?, ?)
       ORDER BY created_at, id`
    ).bind(source.id, target.id, source.id, target.id).all<RelationRow>();
    const sourceAliases = aliases.results ?? [];
    const relationRows = relations.results ?? [];
    const statements: D1PreparedStatement[] = [];

    for (const alias of sourceIdentityAliases(source, sourceAliases)) {
      if (alias.alias_normalized === normalize(target.name)) continue;
      statements.push(this.db.prepare(
        `INSERT INTO sb_entity_aliases (
           id, entity_id, alias, alias_normalized, source_observation_id,
           confidence, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${guardSql()}
         ON CONFLICT(entity_id, alias_normalized) DO UPDATE SET
           source_observation_id = COALESCE(sb_entity_aliases.source_observation_id, excluded.source_observation_id),
           confidence = MAX(COALESCE(sb_entity_aliases.confidence, 0), COALESCE(excluded.confidence, 0)),
           updated_at = excluded.updated_at`
      ).bind(
        crypto.randomUUID(), target.id, alias.alias, alias.alias_normalized,
        alias.source_observation_id, alias.confidence, alias.created_at, lock.reviewedAt,
        ...guardBindings(lock)
      ));
    }
    statements.push(this.db.prepare(
      `INSERT OR IGNORE INTO sb_entity_alias_sources (
         id, alias_id, observation_id, relation, created_at
       )
       SELECT lower(hex(randomblob(16))), target_alias.id,
              source_link.observation_id, source_link.relation, source_link.created_at
       FROM sb_entity_alias_sources source_link
       JOIN sb_entity_aliases source_alias ON source_alias.id = source_link.alias_id
       JOIN sb_entity_aliases target_alias
         ON target_alias.entity_id = ?
        AND target_alias.alias_normalized = source_alias.alias_normalized
       WHERE source_alias.entity_id = ?
         AND ${guardSql()}`
    ).bind(target.id, source.id, ...guardBindings(lock)));
    statements.push(this.db.prepare(
      `DELETE FROM sb_entity_alias_sources
       WHERE alias_id IN (SELECT id FROM sb_entity_aliases WHERE entity_id = ?)
         AND ${guardSql()}`
    ).bind(source.id, ...guardBindings(lock)));
    statements.push(this.db.prepare(
      `DELETE FROM sb_entity_aliases WHERE entity_id = ? AND ${guardSql()}`
    ).bind(source.id, ...guardBindings(lock)));

    statements.push(this.db.prepare(
      `UPDATE sb_entity_external_ids
       SET entity_id = ?, updated_at = ?
       WHERE entity_id = ? AND ${guardSql()}`
    ).bind(target.id, lock.reviewedAt, source.id, ...guardBindings(lock)));
    statements.push(this.db.prepare(
      `DELETE FROM sb_entity_embeddings
       WHERE entity_id = ?
         AND embedding_fingerprint IN (
           SELECT embedding_fingerprint FROM sb_entity_embeddings WHERE entity_id = ?
         )
         AND ${guardSql()}`
    ).bind(source.id, target.id, ...guardBindings(lock)));
    statements.push(this.db.prepare(
      `UPDATE sb_entity_embeddings SET entity_id = ?
       WHERE entity_id = ? AND ${guardSql()}`
    ).bind(target.id, source.id, ...guardBindings(lock)));

    statements.push(this.db.prepare(
      `INSERT INTO sb_memory_entities (id, memory_id, entity_id, role, score, created_at)
       SELECT lower(hex(randomblob(16))), memory_id, ?, role, score, created_at
       FROM sb_memory_entities
       WHERE entity_id = ? AND ${guardSql()}
       ON CONFLICT(memory_id, entity_id, role) DO UPDATE SET
         score = CASE
           WHEN excluded.score IS NULL THEN sb_memory_entities.score
           WHEN sb_memory_entities.score IS NULL THEN excluded.score
           ELSE MAX(sb_memory_entities.score, excluded.score)
         END`
    ).bind(target.id, source.id, ...guardBindings(lock)));
    statements.push(this.db.prepare(
      `DELETE FROM sb_memory_entities WHERE entity_id = ? AND ${guardSql()}`
    ).bind(source.id, ...guardBindings(lock)));

    this.prepareRelationRewrites(statements, relationRows, source.id, target.id, lock);

    statements.push(this.db.prepare(
      `UPDATE sb_entities
       SET aliases_json = ?, metadata_json = ?,
           mention_count = COALESCE(mention_count, 0) + ?,
           entity_type = COALESCE(entity_type, ?), updated_at = ?
       WHERE id = ? AND lifecycle_state = 'active' AND ${guardSql()}`
    ).bind(
      JSON.stringify(mergeAliases(source, target, sourceAliases)),
      mergeMetadata(source.metadata_json, target.metadata_json),
      Number(source.mention_count ?? 0),
      source.entity_type,
      lock.reviewedAt,
      target.id,
      ...guardBindings(lock)
    ));
    statements.push(this.db.prepare(
      `UPDATE sb_entities
       SET lifecycle_state = 'merged', merged_into_entity_id = ?, merged_at = ?,
           mention_count = 0, updated_at = ?
       WHERE id = ? AND lifecycle_state = 'active' AND ${guardSql()}`
    ).bind(target.id, lock.reviewedAt, lock.reviewedAt, source.id, ...guardBindings(lock)));

    const snapshot = JSON.stringify({
      source: { id: source.id, name: source.name, mentionCount: source.mention_count },
      target: { id: target.id, name: target.name, mentionCount: target.mention_count },
      aliasCount: sourceAliases.length,
      relationCount: relationRows.filter((row) =>
        row.from_entity_id === source.id || row.to_entity_id === source.id
      ).length,
    });
    statements.push(this.db.prepare(
      `INSERT INTO sb_entity_merge_history (
         id, source_entity_id, target_entity_id, candidate_id,
         actor_type, reason, snapshot_json, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guardSql()}`
    ).bind(
      crypto.randomUUID(), source.id, target.id, lock.candidateId,
      actorType, reason, snapshot, lock.reviewedAt,
      ...guardBindings(lock)
    ));
    statements.push(this.db.prepare(
      `UPDATE sb_entity_merge_candidates
       SET state = 'rejected', reviewed_by = ?, reviewed_at = ?, updated_at = ?
       WHERE id <> ? AND state = 'pending'
         AND (source_entity_id = ? OR target_entity_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM sb_entity_merge_candidates rejected
           WHERE rejected.source_entity_id = sb_entity_merge_candidates.source_entity_id
             AND rejected.target_entity_id = sb_entity_merge_candidates.target_entity_id
             AND rejected.state = 'rejected'
         )
         AND ${guardSql()}`
    ).bind(
      lock.reviewedBy, lock.reviewedAt, lock.reviewedAt,
      lock.candidateId, source.id, source.id,
      ...guardBindings(lock)
    ));
    statements.push(this.db.prepare(
      `DELETE FROM sb_entity_merge_candidates
       WHERE id <> ? AND state = 'pending'
         AND (source_entity_id = ? OR target_entity_id = ?)
         AND EXISTS (
           SELECT 1 FROM sb_entity_merge_candidates rejected
           WHERE rejected.source_entity_id = sb_entity_merge_candidates.source_entity_id
             AND rejected.target_entity_id = sb_entity_merge_candidates.target_entity_id
             AND rejected.state = 'rejected'
         )
         AND ${guardSql()}`
    ).bind(lock.candidateId, source.id, source.id, ...guardBindings(lock)));

    const finalStatementIndex = statements.length;
    statements.push(this.db.prepare(
      `UPDATE sb_entity_merge_candidates
       SET state = 'merged', updated_at = ?
       WHERE id = ? AND state = 'accepted' AND reviewed_by = ? AND reviewed_at = ?`
    ).bind(lock.reviewedAt, lock.candidateId, lock.reviewedBy, lock.reviewedAt));
    const audit = await prepareComplianceAuditEvent(this.db, {
      occurredAt: lock.reviewedAt,
      actorType,
      actorId: auditActorId,
      tokenId,
      vaultId,
      action: "quality.entity_merge.accept",
      objectType: "entity_merge_candidate",
      objectId: lock.candidateId,
      metadata: {
        source_entity_id: source.id,
        target_entity_id: target.id,
        reason,
      },
    });
    statements.push(guardedAuditStatement(this.db, audit, lock, "merged"));

    const results = await this.db.batch(statements);
    if (Number(results[finalStatementIndex]?.meta?.changes ?? 0) !== 1) {
      throw new EntityMergeCandidateUnavailableError(lock.candidateId);
    }
    return {
      candidateId: lock.candidateId,
      sourceEntityId: source.id,
      targetEntityId: target.id,
      state: "merged",
    };
  }

  private async loadActiveEntity(entityId: string): Promise<EntityRow | null> {
    return await this.db.prepare(
      `SELECT id, name, name_normalized, entity_type, aliases_json, metadata_json,
              mention_count, lifecycle_state, created_at
       FROM sb_entities
       WHERE id = ? AND lifecycle_state = 'active'`
    ).bind(entityId).first<EntityRow>();
  }

  private async releaseAcceptedLock(lock: MergeLock): Promise<void> {
    await this.db.prepare(
      `UPDATE sb_entity_merge_candidates
       SET state = 'pending', reviewed_by = NULL, reviewed_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'accepted' AND reviewed_by = ? AND reviewed_at = ?`
    ).bind(lock.reviewedAt, lock.candidateId, lock.reviewedBy, lock.reviewedAt).run();
  }

  private prepareRelationRewrites(
    statements: D1PreparedStatement[],
    relations: RelationRow[],
    sourceEntityId: string,
    targetEntityId: string,
    lock: MergeLock
  ): void {
    const canonicalByKey = new Map<string, RelationRow>();
    const sorted = [...relations].sort((left, right) => {
      const leftTouchesSource = left.from_entity_id === sourceEntityId || left.to_entity_id === sourceEntityId;
      const rightTouchesSource = right.from_entity_id === sourceEntityId || right.to_entity_id === sourceEntityId;
      return Number(leftTouchesSource) - Number(rightTouchesSource) || left.id.localeCompare(right.id);
    });
    for (const relation of sorted) {
      const key = relationKey(relation, sourceEntityId, targetEntityId);
      if (!canonicalByKey.has(key)) canonicalByKey.set(key, relation);
    }

    const touchedCanonicalIds = new Set<string>();
    for (const relation of relations.filter((row) =>
      row.from_entity_id === sourceEntityId || row.to_entity_id === sourceEntityId
    )) {
      const nextFrom = relation.from_entity_id === sourceEntityId ? targetEntityId : relation.from_entity_id;
      const nextTo = relation.to_entity_id === sourceEntityId ? targetEntityId : relation.to_entity_id;
      if (nextFrom === nextTo) {
        statements.push(this.db.prepare(
          `UPDATE sb_entity_relations SET supersedes_relation_id = NULL
           WHERE supersedes_relation_id = ? AND ${guardSql()}`
        ).bind(relation.id, ...guardBindings(lock)));
        statements.push(this.db.prepare(
          `DELETE FROM sb_fact_resolutions
           WHERE relation_id = ? AND ${guardSql()}`
        ).bind(relation.id, ...guardBindings(lock)));
        statements.push(this.db.prepare(
          `UPDATE sb_fact_resolutions
           SET target_relation_id = NULL, requires_review = 1
           WHERE target_relation_id = ? AND ${guardSql()}`
        ).bind(relation.id, ...guardBindings(lock)));
        statements.push(this.db.prepare(
          `DELETE FROM sb_fact_sources WHERE relation_id = ? AND ${guardSql()}`
        ).bind(relation.id, ...guardBindings(lock)));
        statements.push(this.db.prepare(
          `DELETE FROM sb_entity_relations WHERE id = ? AND ${guardSql()}`
        ).bind(relation.id, ...guardBindings(lock)));
        continue;
      }

      const canonical = canonicalByKey.get(relationKey(relation, sourceEntityId, targetEntityId));
      if (!canonical) continue;
      touchedCanonicalIds.add(canonical.id);
      if (canonical.id === relation.id) {
        statements.push(this.db.prepare(
          `UPDATE sb_entity_relations
           SET from_entity_id = ?, to_entity_id = ?
           WHERE id = ? AND ${guardSql()}`
        ).bind(nextFrom, nextTo, relation.id, ...guardBindings(lock)));
        continue;
      }

      statements.push(this.db.prepare(
        `INSERT OR IGNORE INTO sb_fact_sources (
           id, relation_id, memory_id, observation_id, created_at
         )
         SELECT lower(hex(randomblob(16))), ?, memory_id, observation_id, created_at
         FROM sb_fact_sources
         WHERE relation_id = ? AND ${guardSql()}`
      ).bind(canonical.id, relation.id, ...guardBindings(lock)));
      statements.push(this.db.prepare(
        `DELETE FROM sb_fact_resolutions
         WHERE relation_id = ?
           AND target_relation_id = ?
           AND ${guardSql()}`
      ).bind(relation.id, canonical.id, ...guardBindings(lock)));
      statements.push(this.db.prepare(
        `UPDATE sb_fact_resolutions
         SET relation_id = ?
         WHERE relation_id = ? AND ${guardSql()}`
      ).bind(canonical.id, relation.id, ...guardBindings(lock)));
      statements.push(this.db.prepare(
        `UPDATE sb_fact_resolutions
         SET target_relation_id = NULL, requires_review = 1
         WHERE relation_id = ?
           AND target_relation_id = ?
           AND ${guardSql()}`
      ).bind(canonical.id, relation.id, ...guardBindings(lock)));
      statements.push(this.db.prepare(
        `UPDATE sb_fact_resolutions
         SET target_relation_id = ?
         WHERE target_relation_id = ?
           AND relation_id <> ?
           AND ${guardSql()}`
      ).bind(canonical.id, relation.id, canonical.id, ...guardBindings(lock)));
      statements.push(this.db.prepare(
        `UPDATE sb_entity_relations SET supersedes_relation_id = ?
         WHERE supersedes_relation_id = ? AND ${guardSql()}`
      ).bind(canonical.id, relation.id, ...guardBindings(lock)));
      statements.push(this.db.prepare(
        `DELETE FROM sb_fact_sources WHERE relation_id = ? AND ${guardSql()}`
      ).bind(relation.id, ...guardBindings(lock)));
      statements.push(this.db.prepare(
        `DELETE FROM sb_entity_relations WHERE id = ? AND ${guardSql()}`
      ).bind(relation.id, ...guardBindings(lock)));
    }
    const mergedEvidenceCountSql = distinctFactEvidenceCountSql({
      relationIdSql: "?",
      floorAtOne: true,
    });
    for (const relationId of touchedCanonicalIds) {
      statements.push(this.db.prepare(
        `UPDATE sb_entity_relations
         SET evidence_count = ${mergedEvidenceCountSql}
         WHERE id = ? AND ${guardSql()}`
      ).bind(relationId, relationId, ...guardBindings(lock)));
    }
    statements.push(this.db.prepare(
      `DELETE FROM sb_fact_resolutions
       WHERE relation_id = target_relation_id
         AND ${guardSql()}`
    ).bind(...guardBindings(lock)));
  }
}
