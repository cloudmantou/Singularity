import {
  ensureConflictClaimSchema,
  prepareComplianceAuditEvent,
  type ConflictResolution,
  type PreparedComplianceAuditEvent,
} from "./quality";
import { buildMemoryRelation, prepareMemoryRelation, type MemoryRelationInput } from "./relations";
import { FACT_RESOLUTION_SCHEMA_STATEMENTS } from "./fact-resolution";

export interface SupersessionInput {
  sourceClaimId: string;
  targetClaimId: string;
  sourceRelationId: string;
  targetRelationId: string;
  effectiveAt: number;
  actorType?: string;
  actorId?: string | null;
}

export interface ConflictResolutionInput {
  conflictId: string;
  state?: "pending" | "resolved" | "dismissed";
  resolution: ConflictResolution;
  resolvedBy: string;
  effectiveAt: number;
  actorType: string;
  actorId?: string | null;
  finalizationStatements?: D1PreparedStatement[];
  aiReview?: { runId: string; decision: string; applicationMode: "human" | "deterministic_auto" };
}

interface ConflictRow {
  old_memory_id: string;
  new_memory_id: string;
  old_claim_id: string | null;
  new_claim_id: string | null;
}

export class ConflictClaimsUnavailableError extends Error {
  constructor(readonly conflictId: string) {
    super(`Conflict ${conflictId} does not resolve to one unambiguous Claim pair`);
    this.name = "ConflictClaimsUnavailableError";
  }
}

export class ManualResolutionOutcomeRequiredError extends Error {
  constructor(readonly conflictId: string) {
    super(`Conflict ${conflictId} cannot be closed manually without final Claim and Fact outcomes`);
    this.name = "ManualResolutionOutcomeRequiredError";
  }
}

export class ClaimRelationMismatchError extends Error {
  constructor(
    readonly claimId: string,
    readonly relationId: string
  ) {
    super(`Fact Relation ${relationId} is not supported by Claim ${claimId}`);
    this.name = "ClaimRelationMismatchError";
  }
}

interface SupersessionPreparationOptions {
  pendingSourcePair?: { claimId: string; relationId: string };
}

export interface ResolutionCoordinator {
  applySupersession(input: SupersessionInput): Promise<boolean>;
  applyConflictResolution(input: ConflictResolutionInput): Promise<boolean>;
}

export class D1ResolutionCoordinator implements ResolutionCoordinator {
  constructor(private readonly db: D1Database) {}

  async prepareSupersession(
    input: SupersessionInput,
    options: SupersessionPreparationOptions = {}
  ): Promise<D1PreparedStatement[]> {
    const pendingSourcePair = options.pendingSourcePair;
    if (pendingSourcePair) {
      if (
        pendingSourcePair.claimId !== input.sourceClaimId ||
        pendingSourcePair.relationId !== input.sourceRelationId
      ) {
        throw new ClaimRelationMismatchError(input.sourceClaimId, input.sourceRelationId);
      }
    } else if (!await this.relationSupportsClaim(input.sourceRelationId, input.sourceClaimId)) {
      throw new ClaimRelationMismatchError(input.sourceClaimId, input.sourceRelationId);
    }
    if (!await this.relationSupportsClaim(input.targetRelationId, input.targetClaimId)) {
      throw new ClaimRelationMismatchError(input.targetClaimId, input.targetRelationId);
    }
    const audit = await prepareComplianceAuditEvent(this.db, {
      occurredAt: input.effectiveAt,
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? null,
      action: "fact.supersede.apply",
      objectType: "fact_resolution",
      objectId: input.sourceRelationId,
      metadata: {
        source_claim_id: input.sourceClaimId,
        target_claim_id: input.targetClaimId,
        source_relation_id: input.sourceRelationId,
        target_relation_id: input.targetRelationId,
      },
    });
    const claimRows = await this.db.prepare(
      `SELECT id, entry_id FROM sb_memories WHERE id IN (?, ?)`
    ).bind(input.sourceClaimId, input.targetClaimId).all<{ id: string; entry_id: string | null }>();
    const entryByClaim = new Map((claimRows.results ?? []).map((row) => [row.id, row.entry_id]));
    if (!entryByClaim.has(input.sourceClaimId) || !entryByClaim.has(input.targetClaimId)) {
      throw new Error("Supersession requires persisted source and target Claims");
    }
    const sourceEntryId = entryByClaim.get(input.sourceClaimId);
    const targetEntryId = entryByClaim.get(input.targetClaimId);
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `UPDATE sb_memories
         SET claim_status = 'superseded',
             invalid_at = COALESCE(invalid_at, ?),
             expired_at = COALESCE(expired_at, ?),
             valid_to = COALESCE(valid_to, ?)
         WHERE id = ?
           AND claim_status NOT IN ('superseded', 'deprecated')`
      ).bind(input.effectiveAt, input.effectiveAt, input.effectiveAt, input.targetClaimId),
      this.db.prepare(
        `UPDATE sb_memories
         SET claim_status = 'confirmed'
         WHERE id = ?
           AND claim_status IN ('supported', 'contested', 'unsupported')`
      ).bind(input.sourceClaimId),
      this.db.prepare(
        `UPDATE sb_entity_relations
         SET invalid_at = COALESCE(invalid_at, ?),
             expired_at = COALESCE(expired_at, ?),
             valid_to = COALESCE(valid_to, ?),
             resolution_state = 'superseded'
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM sb_fact_sources fs_keep
             JOIN sb_memories m_keep ON m_keep.id = fs_keep.memory_id
             WHERE fs_keep.relation_id = sb_entity_relations.id
               AND fs_keep.memory_id <> ?
               AND m_keep.claim_status IN ('supported', 'confirmed', 'contested')
               AND m_keep.invalid_at IS NULL
               AND m_keep.expired_at IS NULL
           )`
      ).bind(
        input.effectiveAt,
        input.effectiveAt,
        input.effectiveAt,
        input.targetRelationId,
        input.targetClaimId
      ),
      this.db.prepare(
        `UPDATE sb_entity_relations
         SET resolution_type = 'supersedes',
             resolution_state = 'active',
             supersedes_relation_id = ?
         WHERE id = ?`
      ).bind(input.targetRelationId, input.sourceRelationId),
    ];
    if (sourceEntryId && targetEntryId && sourceEntryId !== targetEntryId) {
      statements.push(prepareMemoryRelation(this.db, {
        fromMemoryId: sourceEntryId,
        toMemoryId: targetEntryId,
        relationType: "supersedes",
        metadata: {
          source_claim_id: input.sourceClaimId,
          target_claim_id: input.targetClaimId,
          source_relation_id: input.sourceRelationId,
          target_relation_id: input.targetRelationId,
          automatic: true,
        },
        createdAt: input.effectiveAt,
      }).statement);
    }
    statements.push(audit.statement);
    return statements;
  }

  async applySupersession(input: SupersessionInput): Promise<boolean> {
    const results = await this.db.batch(await this.prepareSupersession(input));
    return Number(results[0]?.meta?.changes ?? 0) > 0;
  }

  async applyConflictResolution(input: ConflictResolutionInput): Promise<boolean> {
    if (input.resolution === "manual") {
      throw new ManualResolutionOutcomeRequiredError(input.conflictId);
    }
    await ensureConflictClaimSchema(this.db);
    await this.ensureFactResolutionSchema();
    const conflict = await this.db.prepare(
      `SELECT old_memory_id, new_memory_id, old_claim_id, new_claim_id
       FROM sb_conflict_cases
       WHERE id = ? AND state = 'pending'`
    ).bind(input.conflictId).first<ConflictRow>();
    if (!conflict) return false;

    const oldClaimId = conflict.old_claim_id ?? await this.latestClaimId(conflict.old_memory_id);
    const newClaimId = conflict.new_claim_id ?? await this.latestClaimId(conflict.new_memory_id);
    if (!oldClaimId || !newClaimId) {
      throw new ConflictClaimsUnavailableError(input.conflictId);
    }
    if (oldClaimId && newClaimId) {
      const claimRows = await this.db.prepare(
        `SELECT id, entry_id FROM sb_memories WHERE id IN (?, ?)`
      ).bind(oldClaimId, newClaimId).all<{ id: string; entry_id: string | null }>();
      const entryByClaim = new Map((claimRows.results ?? []).map((row) => [row.id, row.entry_id]));
      if (
        entryByClaim.get(oldClaimId) !== conflict.old_memory_id ||
        entryByClaim.get(newClaimId) !== conflict.new_memory_id
      ) {
        throw new ConflictClaimsUnavailableError(input.conflictId);
      }
    }
    const statements: D1PreparedStatement[] = [];

    if ((input.resolution === "use_new" || input.resolution === "use_old") && oldClaimId && newClaimId) {
      const selectedClaimId = input.resolution === "use_new" ? newClaimId : oldClaimId;
      const rejectedClaimId = input.resolution === "use_new" ? oldClaimId : newClaimId;
      const rejectedStatus = input.resolution === "use_new" ? "superseded" : "deprecated";
      statements.push(
        this.db.prepare(
          `UPDATE sb_memories
           SET claim_status = ?,
               invalid_at = COALESCE(invalid_at, ?),
               expired_at = COALESCE(expired_at, ?),
               valid_to = COALESCE(valid_to, ?)
           WHERE id = ?
             AND claim_status NOT IN ('superseded', 'deprecated')
             AND EXISTS (
               SELECT 1 FROM sb_conflict_cases pending_case
               WHERE pending_case.id = ? AND pending_case.state = 'pending'
             )`
        ).bind(
          rejectedStatus,
          input.effectiveAt,
          input.effectiveAt,
          input.effectiveAt,
          rejectedClaimId,
          input.conflictId
        ),
        this.db.prepare(
          `UPDATE sb_memories
           SET claim_status = 'confirmed'
           WHERE id = ?
             AND claim_status IN ('supported', 'contested', 'unsupported')
             AND EXISTS (
               SELECT 1 FROM sb_conflict_cases pending_case
               WHERE pending_case.id = ? AND pending_case.state = 'pending'
             )`
        ).bind(selectedClaimId, input.conflictId),
        this.db.prepare(
          `UPDATE sb_entity_relations
           SET invalid_at = COALESCE(invalid_at, ?),
               expired_at = COALESCE(expired_at, ?),
               valid_to = COALESCE(valid_to, ?),
               resolution_state = 'superseded'
           WHERE EXISTS (
             SELECT 1 FROM sb_fact_sources fs_rejected
             WHERE fs_rejected.relation_id = sb_entity_relations.id
               AND fs_rejected.memory_id = ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM sb_fact_sources fs_keep
             JOIN sb_memories m_keep ON m_keep.id = fs_keep.memory_id
             WHERE fs_keep.relation_id = sb_entity_relations.id
               AND fs_keep.memory_id <> ?
               AND m_keep.claim_status IN ('supported', 'confirmed', 'contested')
               AND m_keep.invalid_at IS NULL
               AND m_keep.expired_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM sb_conflict_cases pending_case
             WHERE pending_case.id = ? AND pending_case.state = 'pending'
           )`
        ).bind(
          input.effectiveAt,
          input.effectiveAt,
          input.effectiveAt,
          rejectedClaimId,
          rejectedClaimId,
          input.conflictId
        ),
        this.db.prepare(
          `UPDATE sb_entity_relations
           SET resolution_state = 'active'
           WHERE EXISTS (
             SELECT 1 FROM sb_fact_sources fs_selected
             WHERE fs_selected.relation_id = sb_entity_relations.id
               AND fs_selected.memory_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM sb_conflict_cases pending_case
             WHERE pending_case.id = ? AND pending_case.state = 'pending'
           )`
        ).bind(selectedClaimId, input.conflictId),
        this.db.prepare(
          `UPDATE sb_fact_resolutions
           SET requires_review = 0,
               applied_invalidation = 1
           WHERE ((source_memory_id = ? AND target_memory_id = ?)
              OR (source_memory_id = ? AND target_memory_id = ?))
             AND EXISTS (
               SELECT 1 FROM sb_conflict_cases pending_case
               WHERE pending_case.id = ? AND pending_case.state = 'pending'
             )`
        ).bind(newClaimId, oldClaimId, oldClaimId, newClaimId, input.conflictId),
        this.prepareGuardedMemoryRelation({
          fromMemoryId: input.resolution === "use_new" ? conflict.new_memory_id : conflict.old_memory_id,
          toMemoryId: input.resolution === "use_new" ? conflict.old_memory_id : conflict.new_memory_id,
          relationType: "supersedes",
          metadata: {
            conflict_id: input.conflictId,
            resolution: input.resolution,
            selected_claim_id: selectedClaimId,
            rejected_claim_id: rejectedClaimId,
          },
          createdAt: input.effectiveAt,
        }, input.conflictId)
      );
    } else if (input.resolution === "keep_both" && oldClaimId && newClaimId) {
      statements.push(
        this.db.prepare(
          `UPDATE sb_memories
           SET claim_status = 'contested'
           WHERE id IN (?, ?)
             AND claim_status IN ('supported', 'confirmed', 'contested')
             AND EXISTS (
               SELECT 1 FROM sb_conflict_cases pending_case
               WHERE pending_case.id = ? AND pending_case.state = 'pending'
             )`
        ).bind(oldClaimId, newClaimId, input.conflictId),
        this.db.prepare(
          `UPDATE sb_entity_relations
           SET resolution_state = 'active'
           WHERE EXISTS (
             SELECT 1 FROM sb_fact_sources fs_keep_both
             WHERE fs_keep_both.relation_id = sb_entity_relations.id
               AND fs_keep_both.memory_id IN (?, ?)
           )
           AND EXISTS (
             SELECT 1 FROM sb_conflict_cases pending_case
             WHERE pending_case.id = ? AND pending_case.state = 'pending'
           )`
        ).bind(oldClaimId, newClaimId, input.conflictId),
        this.db.prepare(
          `UPDATE sb_fact_resolutions
           SET requires_review = 0,
               applied_invalidation = 0
           WHERE ((source_memory_id = ? AND target_memory_id = ?)
              OR (source_memory_id = ? AND target_memory_id = ?))
             AND EXISTS (
               SELECT 1 FROM sb_conflict_cases pending_case
               WHERE pending_case.id = ? AND pending_case.state = 'pending'
             )`
        ).bind(newClaimId, oldClaimId, oldClaimId, newClaimId, input.conflictId)
      );
    } else if (input.resolution === "dismissed" && newClaimId) {
      statements.push(
        this.db.prepare(
          `UPDATE sb_entity_relations
           SET resolution_state = 'active'
           WHERE EXISTS (
             SELECT 1 FROM sb_fact_sources fs_dismissed
             WHERE fs_dismissed.relation_id = sb_entity_relations.id
               AND fs_dismissed.memory_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM sb_conflict_cases pending_case
             WHERE pending_case.id = ? AND pending_case.state = 'pending'
           )`
        ).bind(newClaimId, input.conflictId),
        this.db.prepare(
          `UPDATE sb_fact_resolutions
           SET requires_review = 0,
               applied_invalidation = 0
           WHERE source_memory_id = ? AND target_memory_id = ?
             AND EXISTS (
               SELECT 1 FROM sb_conflict_cases pending_case
               WHERE pending_case.id = ? AND pending_case.state = 'pending'
             )`
        ).bind(newClaimId, oldClaimId, input.conflictId)
      );
    }

    const audit = await prepareComplianceAuditEvent(this.db, {
      occurredAt: input.effectiveAt,
      actorType: input.actorType,
      actorId: input.actorId ?? input.resolvedBy,
      action: "quality.conflict_case.resolve",
      objectType: "conflict_case",
      objectId: input.conflictId,
      metadata: {
        resolution: input.resolution,
        resolved_by: input.resolvedBy,
        old_claim_id: oldClaimId,
        new_claim_id: newClaimId,
        ...(input.aiReview ? {
          ai_review_run_id: input.aiReview.runId,
          ai_review_decision: input.aiReview.decision,
          ai_review_application_mode: input.aiReview.applicationMode,
        } : {}),
      },
    });
    statements.push(
      this.prepareGuardedAudit(audit.record, input.conflictId),
      this.db.prepare(
        `UPDATE sb_conflict_cases
         SET state = ?, resolution = ?, resolved_by = ?, resolved_at = ?,
             old_claim_id = COALESCE(old_claim_id, ?),
             new_claim_id = COALESCE(new_claim_id, ?)
         WHERE id = ? AND state = 'pending'`
      ).bind(
        input.state ?? (input.resolution === "dismissed" ? "dismissed" : "resolved"),
        input.resolution,
        input.resolvedBy,
        input.effectiveAt,
        oldClaimId,
        newClaimId,
        input.conflictId
      )
    );
    const conflictUpdateIndex = statements.length - 1;
    statements.push(...(input.finalizationStatements ?? []));
    const results = await this.db.batch(statements);
    return Number(results[conflictUpdateIndex]?.meta?.changes ?? 0) > 0;
  }

  private prepareGuardedMemoryRelation(
    input: MemoryRelationInput,
    conflictId: string
  ): D1PreparedStatement {
    const relation = buildMemoryRelation(input);
    return this.db.prepare(
      `INSERT INTO sb_memory_relations (
         id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM sb_conflict_cases pending_case
         WHERE pending_case.id = ? AND pending_case.state = 'pending'
       )
       ON CONFLICT(from_memory_id, to_memory_id, relation_type) DO NOTHING`
    ).bind(
      relation.id,
      relation.fromMemoryId,
      relation.toMemoryId,
      relation.relationType,
      relation.score,
      JSON.stringify(relation.metadata),
      relation.createdAt,
      conflictId
    );
  }

  private prepareGuardedAudit(
    record: PreparedComplianceAuditEvent["record"],
    conflictId: string
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO sb_audit_events (
         id, occurred_at, trace_id, actor_type, actor_id, token_id,
         action, object_type, object_id, vault_id, before_hash, after_hash,
         success, error_code, metadata_json, previous_event_hash, event_hash
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM sb_conflict_cases pending_case
         WHERE pending_case.id = ? AND pending_case.state = 'pending'
       )`
    ).bind(
      record.id,
      record.occurred_at,
      record.trace_id,
      record.actor_type,
      record.actor_id,
      record.token_id,
      record.action,
      record.object_type,
      record.object_id,
      record.vault_id,
      record.before_hash,
      record.after_hash,
      record.success,
      record.error_code,
      record.metadata_json,
      record.previous_event_hash,
      record.event_hash,
      conflictId
    );
  }

  private async latestClaimId(entryId: string): Promise<string | null> {
    const row = await this.db.prepare(
      `SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END AS id
       FROM sb_memories
       WHERE entry_id = ?
         AND claim_status IN ('supported', 'confirmed', 'contested')
         AND invalid_at IS NULL
         AND expired_at IS NULL`
    ).bind(entryId).first<{ id: string | null }>();
    return row?.id ?? null;
  }

  private async relationSupportsClaim(relationId: string, claimId: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM sb_fact_sources fs
         WHERE fs.relation_id = r.id AND fs.memory_id = ?
       ) OR (
         NOT EXISTS (
           SELECT 1 FROM sb_fact_sources fs_any WHERE fs_any.relation_id = r.id
         )
         AND r.memory_id = ?
       ) THEN 1 ELSE 0 END AS supported
       FROM sb_entity_relations r
       WHERE r.id = ?`
    ).bind(claimId, claimId, relationId).first<{ supported: number }>();
    return Number(row?.supported ?? 0) === 1;
  }

  private async ensureFactResolutionSchema(): Promise<void> {
    const exists = await this.db.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name = 'sb_fact_resolutions'
       LIMIT 1`
    ).first<{ "1": number }>();
    if (!exists) await this.db.exec(FACT_RESOLUTION_SCHEMA_STATEMENTS.join(";\n"));
  }
}
