import { COMPRESSION_IMPORTANCE_THRESHOLD, COMPRESSION_MIN_RECALL } from "../../src/index";

function parseJsonArray(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function finiteTime(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isActiveAt(row: any, asOf: number): boolean {
  const invalidAt = finiteTime(row?.invalid_at);
  const expiredAt = finiteTime(row?.expired_at);
  const validFrom = finiteTime(row?.valid_from);
  const validTo = finiteTime(row?.valid_to);
  if (invalidAt != null && invalidAt <= asOf) return false;
  if (expiredAt != null && expiredAt <= asOf) return false;
  return (validFrom == null || validFrom <= asOf) && (validTo == null || validTo > asOf);
}

function activePredicateAsOfFromSql(sql: string): number {
  const match = sql.match(/valid_from <= (\d+)/);
  return match ? Number(match[1]) : Date.now();
}

function activePredicateRequiresEvidence(sql: string): boolean {
  return sql.includes("sb_parent_versions") && !sql.includes("FROM sb_memories m_any");
}

function activePredicateRequiresSourceEvidence(sql: string): boolean {
  return sql.includes("sb_memory_sources");
}

function activePredicateRequiresProjectionHash(sql: string): boolean {
  return sql.includes("e_active_projection.content_hash");
}

function memoryHasEvidenceSource(db: D1Mock, memory: any): boolean {
  return db.memorySources.some((source: any) => {
    if (String(source.memory_id) !== String(memory.id)) return false;
    const relation = String(source.relation ?? source.role ?? "");
    if (!["supports", "derived_from"].includes(relation)) return false;
    return db.observations.some((observation: any) =>
      String(observation.id) === String(source.observation_id) &&
      observation.content_hash != null
    );
  });
}

function parentVersionIsEligibleAt(
  db: D1Mock,
  versionId: string | null | undefined,
  asOf: number
): boolean {
  if (!versionId) return false;
  const parentVersion = db.parentVersions.find((version: any) =>
    version.version_id === versionId
  );
  if (!parentVersion) return false;
  const activatedAt = finiteTime(parentVersion.activated_at);
  const supersededAt = finiteTime(parentVersion.superseded_at);
  if (parentVersion.state === "superseded") {
    return activatedAt != null && activatedAt <= asOf &&
      supersededAt != null && supersededAt > asOf;
  }
  if (
    supersededAt != null ||
    !["active", "active_degraded"].includes(String(parentVersion.state)) ||
    (activatedAt != null && activatedAt > asOf)
  ) {
    return false;
  }
  return db.parentUnits.some((unit: any) =>
    unit.parent_id === parentVersion.parent_id &&
    unit.active_version_id === parentVersion.version_id
  );
}

function memoryPassesActiveParentFilter(
  db: D1Mock,
  memory: any,
  asOf = Date.now(),
  requireSourceEvidence = false
): boolean {
  if (!memory) return false;
  if (!isActiveAt(memory, asOf)) return false;
  if (requireSourceEvidence && !memoryHasEvidenceSource(db, memory)) return false;
  const claimStatus = String(memory.claim_status ?? "supported");
  const historicalTerminalClaim = ["superseded", "deprecated"].includes(claimStatus) &&
    finiteTime(memory.invalid_at) != null && Number(memory.invalid_at) > asOf;
  if (!["supported", "confirmed", "contested"].includes(claimStatus) && !historicalTerminalClaim) {
    return false;
  }
  const links = db.parentVersionClaims.filter((claim: any) => claim.memory_id === memory.id);
  if (links.length) {
    return links.some((claim: any) => parentVersionIsEligibleAt(db, claim.parent_version_id, asOf));
  }
  if (memory.parent_version_id == null) return true;
  return parentVersionIsEligibleAt(db, memory.parent_version_id, asOf);
}

function entryPassesActiveParentFilter(
  db: D1Mock,
  entryId: string,
  asOf = Date.now(),
  requireEvidence = false,
  requireSourceEvidence = false,
  requireProjectionHash = false
): boolean {
  const entry = db.entries.find((row: any) => String(row.id) === String(entryId));
  const memories = db.memories.filter((memory: any) => memory.entry_id === entryId);
  if (!memories.length) return !requireEvidence;
  return memories.some((memory: any) => {
    if (
      requireProjectionHash &&
      (
        !entry ||
        entry.content_hash == null ||
        memory.content_hash == null ||
        String(entry.content_hash) !== String(memory.content_hash)
      )
    ) {
      return false;
    }
    return memoryPassesActiveParentFilter(db, memory, asOf, requireSourceEvidence);
  });
}

export class D1Mock {
  entries: any[] = [];
  relations: any[] = [];
  revisions: any[] = [];
  scopes: any[] = [];
  parentUnits: any[] = [];
  parentVersions: any[] = [];
  parentVersionClaims: any[] = [];
  claimVectors: any[] = [];
  memoryMutations: any[] = [];
  observations: any[] = [];
  memories: any[] = [];
  memorySources: any[] = [];
  entities: any[] = [];
  memoryEntities: any[] = [];
  entityRelations: any[] = [];
  factSources: any[] = [];
  mergeCandidates: any[] = [];
  conflictCases: any[] = [];
  auditEvents: any[] = [];
  appSettings: Record<string, { value: string; updated_at: number }> = {};
  vectorRebuilds: any[] = [];
  vectorCleanupQueue: any[] = [];
  vectorCleanupBatches: any[] = [];
  statementCount = 0;
  execCount = 0;
  beforeClassificationCommit?: (row: any) => boolean | void;
  beforePendingGenerationReset?: (row: any) => boolean | void;

  prepare(sql: string) {
    const s = sql.replace(/\s+/g, " ").trim();
    const db = this;
    const resetClassification = (row: any) => {
      Object.assign(row, {
        classification_confidence: null,
        classification_status: "pending",
        classification_error: null,
        classification_attempts: 0,
        classification_next_attempt_at: null,
        classification_started_at: null,
        classification_version: 1,
        classified_at: null,
      });
    };
    const activeEmbeddingMatches = (fingerprint: string | null): boolean => {
      if (!fingerprint) return true;
      const raw = db.appSettings.model_settings?.value;
      if (!raw) return true;
      try {
        const parsed = JSON.parse(raw);
        return String(parsed.embeddingFingerprint ?? "") === fingerprint;
      } catch {
        return false;
      }
    };

    const makeStmt = (args: any[]) => ({
      async run() {
        db.statementCount += 1;

        if (s.startsWith("INSERT OR IGNORE INTO sb_memory_mutations")) {
          const [
            mutation_id,
            idempotency_key,
            source_channel,
            operation,
            entry_id,
            request_hash,
            lease_owner,
            lease_expires_at,
            created_at,
            updated_at,
          ] = args;
          const duplicate = db.memoryMutations.some((row: any) =>
            row.source_channel === source_channel &&
            row.operation === operation &&
            row.idempotency_key === idempotency_key
          );
          if (duplicate) return { meta: { changes: 0 } };
          db.memoryMutations.push({
            mutation_id,
            idempotency_key,
            source_channel,
            operation,
            entry_id,
            request_hash,
            state: "preparing",
            result_content: null,
            result_content_hash: null,
            result_vector_count: null,
            observation_id: null,
            claim_id: null,
            warnings_json: "[]",
            last_error: null,
            lease_owner,
            lease_expires_at,
            created_at,
            updated_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_memory_mutations SET state = CASE")) {
          const [lease_owner, lease_expires_at, updated_at, mutation_id, now] = args;
          const index = db.memoryMutations.findIndex((row: any) =>
            row.mutation_id === mutation_id &&
            row.state !== "completed" &&
            (row.lease_owner == null || row.lease_expires_at == null || Number(row.lease_expires_at) <= Number(now))
          );
          if (index < 0) return { meta: { changes: 0 } };
          const row = db.memoryMutations[index];
          const projectedEntry = db.entries.some((entry: any) =>
            entry.id === row.entry_id &&
            entry.content === row.result_content &&
            entry.content_hash === row.result_content_hash
          );
          const projectedClaim = db.memories.find((memory: any) =>
            memory.id === row.claim_id &&
            memory.entry_id === row.entry_id &&
            memory.content_hash === row.result_content_hash
          );
          const projectedKnowledge = Boolean(projectedClaim) &&
            db.memorySources.some((source: any) =>
              source.memory_id === row.claim_id && source.observation_id === row.observation_id
            ) &&
            db.parentVersionClaims.some((link: any) => {
              if (link.memory_id !== row.claim_id || link.relation !== "supports") return false;
              const version = db.parentVersions.find((candidate: any) =>
                candidate.version_id === link.parent_version_id &&
                ["active", "active_degraded"].includes(candidate.state)
              );
              return Boolean(version) && db.parentUnits.some((unit: any) =>
                unit.parent_id === version.parent_id &&
                unit.active_version_id === version.version_id
              );
            });
          let state = row.state;
          if (["failed", "entry_committed"].includes(row.state) && projectedKnowledge) {
            state = "knowledge_committed";
          } else if (["failed", "preparing"].includes(row.state) && projectedEntry) {
            state = "entry_committed";
          } else if (row.state === "failed") {
            state = "preparing";
          } else if (row.state === "projection_pending") {
            state = "knowledge_committed";
          }
          db.memoryMutations[index] = {
            ...row,
            state,
            lease_owner,
            lease_expires_at,
            last_error: null,
            updated_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_memory_mutations SET result_content = ?")) {
          const [result_content, result_content_hash, result_vector_count, updated_at, mutation_id, lease_owner, now] = args;
          const index = db.memoryMutations.findIndex((row: any) =>
            row.mutation_id === mutation_id && row.lease_owner === lease_owner &&
            row.state === "preparing" && Number(row.lease_expires_at) > Number(now)
          );
          if (index < 0) return { meta: { changes: 0 } };
          db.memoryMutations[index] = {
            ...db.memoryMutations[index],
            result_content,
            result_content_hash,
            result_vector_count,
            updated_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_memory_mutations SET observation_id = ?, claim_id = ?")) {
          const [observation_id, claim_id, updated_at, mutation_id, lease_owner, now] = args;
          const index = db.memoryMutations.findIndex((row: any) =>
            row.mutation_id === mutation_id && row.lease_owner === lease_owner &&
            row.state === "entry_committed" && Number(row.lease_expires_at) > Number(now)
          );
          if (index < 0) return { meta: { changes: 0 } };
          db.memoryMutations[index] = {
            ...db.memoryMutations[index],
            observation_id,
            claim_id,
            updated_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_memory_mutations SET state = 'entry_committed'")) {
          const [result_content, result_content_hash, result_vector_count, updated_at, mutation_id, lease_owner, now] = args;
          const index = db.memoryMutations.findIndex((row: any) =>
            row.mutation_id === mutation_id && row.lease_owner === lease_owner &&
            row.state === "preparing" && Number(row.lease_expires_at) > Number(now) &&
            (!s.includes("entry_projection") || db.entries.some((entry: any) =>
              entry.id === row.entry_id &&
              entry.content === args[7] &&
              entry.content_hash === args[8]
            ))
          );
          if (index < 0) return { meta: { changes: 0 } };
          db.memoryMutations[index] = {
            ...db.memoryMutations[index],
            state: "entry_committed",
            result_content,
            result_content_hash,
            result_vector_count,
            last_error: null,
            updated_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_memory_mutations SET state = 'knowledge_committed'")) {
          const [observation_id, claim_id, updated_at, mutation_id, lease_owner, now] = args;
          const index = db.memoryMutations.findIndex((row: any) =>
            row.mutation_id === mutation_id && row.lease_owner === lease_owner &&
            row.state === "entry_committed" && Number(row.lease_expires_at) > Number(now) &&
            (!s.includes("FROM sb_observations WHERE id = ?") || (
              db.observations.some((observation: any) => observation.id === args[6]) &&
              db.memories.some((memory: any) => memory.id === args[7])
            ))
          );
          if (index < 0) return { meta: { changes: 0 } };
          db.memoryMutations[index] = {
            ...db.memoryMutations[index],
            state: "knowledge_committed",
            observation_id,
            claim_id,
            last_error: null,
            updated_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_memory_mutations SET state = ?, warnings_json")) {
          const [state, warnings_json, updated_at, mutation_id, lease_owner, now] = args;
          const index = db.memoryMutations.findIndex((row: any) =>
            row.mutation_id === mutation_id && row.lease_owner === lease_owner &&
            row.state === "knowledge_committed" && Number(row.lease_expires_at) > Number(now)
          );
          if (index < 0) return { meta: { changes: 0 } };
          db.memoryMutations[index] = {
            ...db.memoryMutations[index],
            state,
            warnings_json,
            lease_owner: null,
            lease_expires_at: null,
            last_error: null,
            updated_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_memory_mutations SET state = 'failed'")) {
          const [last_error, updated_at, mutation_id, lease_owner] = args;
          const index = db.memoryMutations.findIndex((row: any) =>
            row.mutation_id === mutation_id && row.lease_owner === lease_owner
          );
          if (index < 0) return { meta: { changes: 0 } };
          db.memoryMutations[index] = {
            ...db.memoryMutations[index],
            state: "failed",
            last_error,
            lease_owner: null,
            lease_expires_at: null,
            updated_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM sb_memory_mutations WHERE entry_id IN")) {
          const deleting = new Set(args.map(String));
          const before = db.memoryMutations.length;
          db.memoryMutations = db.memoryMutations.filter((row: any) =>
            !deleting.has(String(row.entry_id))
          );
          return { meta: { changes: before - db.memoryMutations.length } };
        }

        if (s.startsWith("INSERT INTO sb_app_settings") && s.includes("SELECT 'model_settings'")) {
          const [value, updated_at, rebuild_id] = args;
          const rebuild = db.vectorRebuilds.find(
            (row: any) => row.id === rebuild_id && row.state === "activating"
          );
          if (!rebuild) return { meta: { changes: 0 } };
          db.appSettings.model_settings = { value: String(value), updated_at: Number(updated_at) };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO sb_app_settings")) {
          const [key, value, updated_at] = args;
          db.appSettings[String(key)] = { value: String(value), updated_at: Number(updated_at) };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_app_settings SET value = ?")) {
          const [value, updated_at, rebuild_id] = args;
          const rebuild = db.vectorRebuilds.find(
            (row: any) => row.id === rebuild_id && row.state === "activating"
          );
          if (!rebuild) return { meta: { changes: 0 } };
          db.appSettings.model_settings = { value: String(value), updated_at: Number(updated_at) };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO sb_vector_rebuilds")) {
          const [id, active_fingerprint, pending_fingerprint, created_at, updated_at] = args;
          const expected_entries = db.entries.filter(
            (entry: any) => !String(entry.tags ?? "[]").includes('"status:deprecated"')
          ).length;
          const existing = db.vectorRebuilds.find((row: any) => row.slot === "current");
          const next = {
            id,
            slot: "current",
            state: "queued",
            active_fingerprint,
            pending_fingerprint,
            expected_entries,
            processed_entries: 0,
            failed_entries: 0,
            conflict_entries: 0,
            last_error: null,
            created_at,
            updated_at,
          };
          if (existing) Object.assign(existing, next);
          else db.vectorRebuilds.push(next);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET state = 'cancelling'")) {
          const [updated_at, id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && !["active", "cancelled", "failed"].includes(item.state)
          );
          if (row) {
            row.state = "cancelling";
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET state = 'cancelled'")) {
          const [updated_at, id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && item.state === "cancelling"
          );
          if (row) {
            row.state = "cancelled";
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET state = ?,")) {
          const [state, rebuild_id, updated_at, id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && ["queued", "building", "ready"].includes(item.state)
          );
          if (row) {
            row.state = state;
            row.processed_entries = db.entries.filter((entry: any) =>
              entry.pending_rebuild_id === rebuild_id &&
              entry.pending_vector_ids != null &&
              entry.pending_vector_ids !== "[]"
            ).length;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET expected_entries = expected_entries + 1")) {
          const [updated_at, id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && ["queued", "building", "ready"].includes(item.state)
          );
          if (row) {
            row.expected_entries = Number(row.expected_entries ?? 0) + 1;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET expected_entries = (")) {
          const [updated_at, id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && ["queued", "building", "ready"].includes(item.state)
          );
          if (row) {
            row.expected_entries = db.entries.filter((entry: any) =>
              !String(entry.tags ?? "[]").includes('"status:deprecated"')
            ).length;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET expected_entries = MAX(0, expected_entries - ?")) {
          const [count, updated_at, id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && ["queued", "building", "ready"].includes(item.state)
          );
          if (row) {
            row.expected_entries = Math.max(0, Number(row.expected_entries ?? 0) - Number(count ?? 0));
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET expected_entries = MAX(0, expected_entries - 1")) {
          const [updated_at, id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && ["queued", "building", "ready"].includes(item.state)
          );
          if (row) {
            row.expected_entries = Math.max(0, Number(row.expected_entries ?? 0) - 1);
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET state = 'activating'")) {
          const [updated_at, id, conflict_rebuild_id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && ["queued", "building", "ready"].includes(item.state)
          );
          if (!row) return { meta: { changes: 0 } };
          const hasConflict = db.entries.some((entry: any) =>
            !String(entry.tags ?? "[]").includes('"status:deprecated"') &&
            (
              entry.pending_rebuild_id == null ||
              entry.pending_rebuild_id !== conflict_rebuild_id ||
              entry.pending_vector_ids == null ||
              entry.pending_vector_ids === "[]" ||
              entry.pending_content_hash == null ||
              entry.content_hash == null ||
              entry.pending_revision_id == null ||
              entry.metadata_hash == null ||
              entry.pending_metadata_hash == null ||
              entry.pending_content_hash !== entry.content_hash ||
              entry.pending_metadata_hash !== entry.metadata_hash
            )
          );
          if (hasConflict) return { meta: { changes: 0 } };
          row.state = "activating";
          row.conflict_entries = 0;
          row.last_error = null;
          row.updated_at = updated_at;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_vector_rebuilds SET state = 'active'")) {
          const [updated_at, id] = args;
          const row = db.vectorRebuilds.find((item: any) =>
            item.id === id && item.state === "activating"
          );
          if (row) {
            row.state = "active";
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("INSERT INTO sb_vector_cleanup_batches") || s.startsWith("INSERT OR IGNORE INTO sb_vector_cleanup_batches")) {
          const hasHash = s.includes("vector_ids_hash");
          const [id, rebuild_id, vector_ids_json] = args;
          let index = 3;
          const vector_ids_hash = hasHash ? args[index++] : null;
          const state = args[index++];
          const created_at = args[index++];
          const updated_at = args[index++];
          if (hasHash && db.vectorCleanupBatches.some((row: any) =>
            row.rebuild_id === rebuild_id && row.vector_ids_hash === vector_ids_hash
          )) {
            return { meta: { changes: 0 } };
          }
          db.vectorCleanupBatches.push({
            id,
            rebuild_id,
            vector_ids_json,
            vector_ids_hash,
            state,
            attempts: 0,
            next_attempt_at: null,
            last_error: null,
            created_at,
            updated_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_vector_cleanup_batches SET state = 'ready'")) {
          const [updated_at, rebuild_id] = args;
          let changes = 0;
          for (const row of db.vectorCleanupBatches) {
            if (row.rebuild_id === rebuild_id && row.state === "prepared") {
              row.state = "ready";
              row.updated_at = updated_at;
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE sb_vector_cleanup_batches SET vector_ids_json = ?")) {
          const [vector_ids_json, next_attempt_at, last_error, updated_at, id] = args;
          const row = db.vectorCleanupBatches.find((item: any) => item.id === id);
          if (row) {
            row.vector_ids_json = vector_ids_json;
            if (s.includes("attempts = attempts + 1")) {
              row.attempts = Number(row.attempts ?? 0) + 1;
            }
            row.state = "ready";
            row.next_attempt_at = next_attempt_at;
            row.last_error = last_error;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_cleanup_batches SET state = 'completed'")) {
          const [updated_at, id] = args;
          const row = db.vectorCleanupBatches.find((item: any) => item.id === id);
          if (row) {
            row.state = "completed";
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_cleanup_batches SET state = 'blocked'")) {
          const [last_error, updated_at, id] = args;
          const row = db.vectorCleanupBatches.find((item: any) => item.id === id);
          if (row) {
            row.state = "blocked";
            row.last_error = last_error;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_cleanup_batches SET attempts = attempts + 1")) {
          const [state, next_attempt_at, last_error, updated_at, id] = args;
          const row = db.vectorCleanupBatches.find((item: any) => item.id === id);
          if (row) {
            row.attempts = Number(row.attempts ?? 0) + 1;
            row.state = state;
            row.next_attempt_at = next_attempt_at;
            row.last_error = last_error;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("INSERT INTO sb_vector_cleanup_queue")) {
          const [id, vector_id, reason, state, rebuild_id, last_error, created_at, updated_at] = args;
          const existing = db.vectorCleanupQueue.find((row: any) => row.vector_id === vector_id);
          if (existing) {
            existing.reason = reason;
            existing.state = state;
            existing.rebuild_id = rebuild_id ?? existing.rebuild_id;
            existing.last_error = last_error ?? existing.last_error;
            existing.updated_at = updated_at;
          } else {
            db.vectorCleanupQueue.push({
              id,
              vector_id,
              reason,
              state,
              attempts: 0,
              next_attempt_at: null,
              rebuild_id,
              last_error,
              created_at,
              updated_at,
            });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_vector_cleanup_queue SET attempts = attempts + 1")) {
          const [state, next_attempt_at, last_error, updated_at, vector_id] = args;
          const row = db.vectorCleanupQueue.find((item: any) => item.vector_id === vector_id);
          if (row) {
            row.attempts = Number(row.attempts ?? 0) + 1;
            row.state = state;
            row.next_attempt_at = next_attempt_at;
            row.last_error = last_error;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_vector_cleanup_queue SET state = 'blocked'")) {
          const hasRetry = s.includes("attempts = attempts + 1");
          let index = 0;
          const next_attempt_at = hasRetry ? args[index++] : null;
          const last_error = args[index++];
          const updated_at = args[index++];
          const vector_id = args[index++];
          const row = db.vectorCleanupQueue.find((item: any) => item.vector_id === vector_id);
          if (row) {
            row.state = "blocked";
            if (hasRetry) {
              row.attempts = Number(row.attempts ?? 0) + 1;
              row.next_attempt_at = next_attempt_at;
            }
            row.last_error = last_error;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("DELETE FROM sb_vector_cleanup_queue WHERE vector_id IN")) {
          const ids = new Set(args.map(String));
          const before = db.vectorCleanupQueue.length;
          db.vectorCleanupQueue = db.vectorCleanupQueue.filter(
            (row: any) => !ids.has(String(row.vector_id))
          );
          return { meta: { changes: before - db.vectorCleanupQueue.length } };
        }
        if (s.startsWith("INSERT INTO sb_scopes") || s.startsWith("INSERT OR IGNORE INTO sb_scopes") || s.startsWith("INSERT OR REPLACE INTO sb_scopes")) {
          const [scope_id, parent_scope_id, canonical_name, aliases_json, scope_type, created_at, updated_at] = args;
          const existing = db.scopes.find((row: any) => row.scope_id === scope_id);
          const next = { scope_id, parent_scope_id, canonical_name, aliases_json, scope_type, created_at, updated_at };
          if (existing) Object.assign(existing, next);
          else db.scopes.push(next);
          return { meta: { changes: existing && s.startsWith("INSERT OR IGNORE") ? 0 : 1 } };
        }
        if (s.startsWith("INSERT INTO sb_parent_units") || s.startsWith("INSERT OR IGNORE INTO sb_parent_units") || s.startsWith("INSERT OR REPLACE INTO sb_parent_units")) {
          const [parent_id, active_version_id, scope_id, created_at, updated_at] = args;
          const existing = db.parentUnits.find((row: any) => row.parent_id === parent_id);
          if (existing) {
            if (s.startsWith("INSERT OR IGNORE")) return { meta: { changes: 0 } };
            if (!s.startsWith("INSERT INTO sb_parent_units") || !s.includes("ON CONFLICT")) {
              existing.active_version_id = active_version_id;
              existing.scope_id = scope_id;
              existing.created_at = created_at;
            }
            existing.updated_at = updated_at;
          } else {
            db.parentUnits.push({ parent_id, active_version_id, scope_id, created_at, updated_at });
          }
          return { meta: { changes: 1 } };
        }
        if (
          s.startsWith("INSERT INTO sb_parent_versions") ||
          s.startsWith("INSERT OR IGNORE INTO sb_parent_versions") ||
          s.startsWith("INSERT OR REPLACE INTO sb_parent_versions")
        ) {
          let version_id: any;
          let parent_id: any;
          let version_number: any;
          let source_observation_id: any;
          let source_snapshot_hash: any;
          let tags_snapshot_json: any = "[]";
          let source_snapshot: any = null;
          let vault_snapshot: any = null;
          let metadata_snapshot_hash: any = null;
          let summary: any = null;
          let state: any;
          let summary_vector_ids: any = "[]";
          let created_at: any;
          let updated_at: any;
          let activated_at: any = null;
          let superseded_at: any = null;
          if (s.includes("tags_snapshot_json") && args.length >= 18) {
            [
              version_id, parent_id, version_number, source_observation_id,
              source_snapshot_hash, tags_snapshot_json, source_snapshot,
              vault_snapshot, metadata_snapshot_hash, summary, state,
              summary_vector_ids, activated_at, superseded_at,
              , , created_at, updated_at,
            ] = args;
          } else if (s.includes("tags_snapshot_json") && args.length >= 12) {
            [
              version_id, parent_id, version_number, source_observation_id,
              source_snapshot_hash, tags_snapshot_json, source_snapshot,
              vault_snapshot, metadata_snapshot_hash, state, created_at, updated_at,
            ] = args;
          } else if (args.length >= 12) {
            [
              version_id, parent_id, version_number, source_observation_id,
              source_snapshot_hash, summary, state, summary_vector_ids,
              activated_at, superseded_at, created_at, updated_at,
            ] = args;
          } else if (args.length >= 10) {
            [
              version_id, parent_id, version_number, source_observation_id,
              source_snapshot_hash, summary, state, summary_vector_ids, created_at, updated_at,
            ] = args;
          } else {
            [
              version_id, parent_id, version_number, source_observation_id,
              source_snapshot_hash, state, created_at, updated_at,
            ] = args;
          }
          const existing = db.parentVersions.find((row: any) =>
            row.version_id === version_id ||
            (row.parent_id === parent_id && Number(row.version_number) === Number(version_number))
          );
          if (existing) {
            if (s.startsWith("INSERT OR REPLACE")) {
              Object.assign(existing, {
                version_id, parent_id, version_number, source_observation_id,
                source_snapshot_hash, tags_snapshot_json, source_snapshot,
                vault_snapshot, metadata_snapshot_hash, summary, state, summary_vector_ids,
                activated_at, superseded_at, created_at, updated_at,
              });
              return { meta: { changes: 1 } };
            }
            if (s.startsWith("INSERT OR IGNORE")) return { meta: { changes: 0 } };
            throw new Error("UNIQUE constraint failed: sb_parent_versions.parent_id, sb_parent_versions.version_number");
          }
          db.parentVersions.push({
            version_id, parent_id, version_number, source_observation_id,
            source_snapshot_hash, tags_snapshot_json, source_snapshot,
            vault_snapshot, metadata_snapshot_hash, summary, state, summary_vector_ids,
            activated_at, superseded_at, created_at, updated_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_parent_versions SET state = 'superseded'")) {
          const hasTemporalWindow = s.includes("superseded_at");
          const [superseded_at, updated_at, parent_id, version_id, guard_parent_id, guard_version_id] = hasTemporalWindow
            ? args
            : [null, ...args];
          if (
            s.includes("EXISTS") &&
            !db.parentUnits.some((unit: any) =>
              unit.parent_id === guard_parent_id &&
              unit.active_version_id === guard_version_id
            )
          ) {
            return { meta: { changes: 0 } };
          }
          let changes = 0;
          for (const row of db.parentVersions) {
            if (
              row.parent_id === parent_id &&
              (row.state === "active" || row.state === "active_degraded") &&
              row.version_id !== version_id
            ) {
              row.state = "superseded";
              if (hasTemporalWindow && row.activated_at == null) row.activated_at = row.created_at;
              if (hasTemporalWindow && row.superseded_at == null) row.superseded_at = superseded_at;
              row.updated_at = updated_at;
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE sb_parent_versions SET state = ?")) {
          const hasTemporalWindow = s.includes("activated_at");
          const [state, activated_at, updated_at, parent_id, version_id] = hasTemporalWindow
            ? args
            : [args[0], null, args[1], args[2], args[3]];
          const row = db.parentVersions.find((item: any) =>
            item.parent_id === parent_id &&
            item.version_id === version_id &&
            (!s.includes("state = 'building'") || item.state === "building")
          );
          if (row) {
            row.state = state;
            if (hasTemporalWindow && row.activated_at == null) row.activated_at = activated_at;
            if (hasTemporalWindow) row.superseded_at = null;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_parent_versions SET state = 'active'")) {
          const [updated_at, parent_id, version_id] = args;
          const row = db.parentVersions.find((item: any) =>
            item.parent_id === parent_id && item.version_id === version_id
          );
          if (row) {
            row.state = "active";
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_parent_versions SET state = 'failed'")) {
          const [updated_at, version_id] = args;
          const row = db.parentVersions.find((item: any) =>
            item.version_id === version_id && item.state === "building"
          );
          if (row) {
            row.state = "failed";
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (
          s.startsWith("INSERT INTO sb_parent_version_claims") ||
          s.startsWith("INSERT OR IGNORE INTO sb_parent_version_claims") ||
          s.startsWith("INSERT OR REPLACE INTO sb_parent_version_claims")
        ) {
          const [parent_version_id, memory_id, relation, created_at] = args;
          const existing = db.parentVersionClaims.find((row: any) =>
            row.parent_version_id === parent_version_id &&
            row.memory_id === memory_id &&
            row.relation === relation
          );
          if (existing) {
            if (s.startsWith("INSERT OR IGNORE")) return { meta: { changes: 0 } };
            Object.assign(existing, { parent_version_id, memory_id, relation, created_at });
          } else {
            db.parentVersionClaims.push({ parent_version_id, memory_id, relation, created_at });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_parent_units SET active_version_id")) {
          const [active_version_id, updated_at, parent_id, guard_version_id, guard_parent_id] = args;
          if (
            s.includes("EXISTS") &&
            !db.parentVersions.some((version: any) =>
              version.version_id === guard_version_id &&
              version.parent_id === guard_parent_id &&
              (version.state === "active" || version.state === "active_degraded")
            )
          ) {
            return { meta: { changes: 0 } };
          }
          const row = db.parentUnits.find((item: any) => item.parent_id === parent_id);
          if (row) {
            row.active_version_id = active_version_id;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("INSERT INTO sb_observations")) {
          if (args.length >= 22) {
            const [
              id, content, source, metadata_json, content_hash,
              source_channel, source_identity, author_type, source_uri,
              source_timestamp, revision, root_evidence_id, previous_evidence_id,
              extraction_status, extraction_version, extraction_attempts,
              extraction_error, next_attempt_at, processing_started_at,
              processed_at, needs_reprocess, created_at,
            ] = args;
            db.observations.push({
              id, content, source, metadata_json, content_hash,
              source_channel, source_identity, author_type, source_uri,
              source_timestamp, revision, root_evidence_id, previous_evidence_id,
              extraction_status, extraction_version, extraction_attempts,
              extraction_error, next_attempt_at, processing_started_at,
              processed_at, needs_reprocess,
              created_at,
            });
          } else if (args.length >= 14) {
            const [
              id, content, source, metadata_json, content_hash,
              extraction_status, extraction_version, extraction_attempts,
              extraction_error, next_attempt_at, processing_started_at,
              processed_at, needs_reprocess, created_at,
            ] = args;
            db.observations.push({
              id, content, source, metadata_json, content_hash,
              source_channel: source,
              source_identity: null,
              author_type: "unknown",
              source_uri: null,
              source_timestamp: created_at,
              revision: 1,
              root_evidence_id: id,
              previous_evidence_id: null,
              extraction_status, extraction_version, extraction_attempts,
              extraction_error, next_attempt_at, processing_started_at,
              processed_at, needs_reprocess,
              created_at,
            });
          } else {
            const [id, content, source, metadata_json, created_at] = args;
            db.observations.push({
              id, content, source, metadata_json,
              content_hash: null,
              source_channel: source,
              source_identity: null,
              author_type: "unknown",
              source_uri: null,
              source_timestamp: created_at,
              revision: 1,
              root_evidence_id: id,
              previous_evidence_id: null,
              extraction_status: "pending",
              extraction_version: 1,
              extraction_attempts: 0,
              extraction_error: null,
              next_attempt_at: null,
              processing_started_at: null,
              processed_at: null,
              needs_reprocess: 0,
              created_at,
            });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_observations SET extraction_status = 'processing'")) {
          const [
            currentVersion,
            processing_started_at,
            nextVersion,
            id,
            maxAttempts,
            now,
            leaseCutoff,
            whereVersion,
          ] = args;
          const row = db.observations.find((observation: any) => {
            if (observation.id !== id) return false;
            if (Number(observation.extraction_attempts ?? 0) >= Number(maxAttempts)) return false;
            const status = observation.extraction_status ?? "pending";
            const staleVersion = Number(observation.extraction_version ?? 0) < Number(whereVersion);
            return staleVersion ||
              status === "pending" ||
              (
                status === "retryable_error" &&
                Number(observation.next_attempt_at ?? 0) <= Number(now)
              ) ||
              (
                status === "processing" &&
                Number(observation.processing_started_at ?? 0) <= Number(leaseCutoff)
              ) ||
              (
                status === "fallback" &&
                Number(observation.needs_reprocess ?? 0) === 1
              ) ||
              (
                status === "partial_error" &&
                Number(observation.needs_reprocess ?? 0) === 1
              );
          });
          if (row) {
            const staleVersion = Number(row.extraction_version ?? 0) < Number(currentVersion);
            row.extraction_status = "processing";
            row.extraction_attempts = staleVersion
              ? 1
              : Number(row.extraction_attempts ?? 0) + 1;
            row.extraction_error = null;
            row.next_attempt_at = null;
            row.processing_started_at = processing_started_at;
            row.extraction_version = nextVersion;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_observations SET extraction_status = 'succeeded'")) {
          const [processed_at, extraction_version, id, started_at] = args;
          const row = db.observations.find((observation: any) =>
            observation.id === id &&
            (observation.processing_started_at === started_at || started_at == null)
          );
          if (row) {
            row.extraction_status = "succeeded";
            row.extraction_error = null;
            row.next_attempt_at = null;
            row.processing_started_at = null;
            row.processed_at = processed_at;
            row.needs_reprocess = 0;
            row.extraction_version = extraction_version;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_observations SET extraction_status = ?")) {
          const [
            extraction_status,
            extraction_error,
            next_attempt_at,
            processed_at,
            needs_reprocess,
            extraction_version,
            id,
            started_at,
          ] = args;
          const row = db.observations.find((observation: any) =>
            observation.id === id &&
            (observation.processing_started_at === started_at || started_at == null)
          );
          if (row) {
            row.extraction_status = extraction_status;
            row.extraction_error = extraction_error;
            row.next_attempt_at = next_attempt_at;
            row.processing_started_at = null;
            row.processed_at = processed_at;
            row.needs_reprocess = needs_reprocess;
            row.extraction_version = extraction_version;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_observations SET metadata_json = ?")) {
          const [metadata_json, id] = args;
          const row = db.observations.find((observation: any) => observation.id === id);
          if (row) row.metadata_json = metadata_json;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("INSERT INTO sb_memories")) {
          let id: any;
          let content: any;
          let kind: any;
          let memory_class: any;
          let importance: any;
          let confidence: any;
          let entry_id: any;
          let parent_version_id: any = null;
          let claim_subject: any = null;
          let claim_predicate: any = null;
          let claim_object: any = null;
          let scope_id: any = null;
          let polarity: any = "positive";
          let modality: any = "asserted";
          let claim_status: any = "supported";
          let scores_json: any = "{}";
          let content_hash: any;
          let observed_at: any;
          let valid_from: any;
          let valid_to: any;
          let reference_time: any;
          let invalid_at: any;
          let expired_at: any;
          let entities_json: any;
          let created_at: any;
          if (args.length >= 25) {
            [
              id, content, kind, memory_class, importance, confidence,
              entry_id, parent_version_id, claim_subject, claim_predicate,
              claim_object, scope_id, polarity, modality, claim_status,
              scores_json, content_hash, observed_at, valid_from, valid_to,
              reference_time, invalid_at, expired_at, entities_json, created_at,
            ] = args;
          } else if (args.length >= 16) {
            [
              id, content, kind, memory_class, importance, confidence,
              entry_id, content_hash, observed_at, valid_from, valid_to,
              reference_time, invalid_at, expired_at, entities_json, created_at,
            ] = args;
          } else if (args.length >= 15) {
            [
              id, content, kind, memory_class, importance, confidence,
              entry_id, content_hash, observed_at, valid_from, valid_to,
              reference_time, invalid_at, entities_json, created_at,
            ] = args;
            expired_at = null;
          } else {
            [
              id, content, kind, memory_class, importance, confidence,
              entry_id, content_hash, observed_at, valid_from, valid_to,
              reference_time, invalid_at, expired_at, entities_json, created_at,
            ] = [...args.slice(0, 11), null, null, null, args[11], args[12]];
          }
          db.memories.push({
            id, content, kind, memory_class, importance, confidence,
            entry_id, parent_version_id, claim_subject, claim_predicate,
            claim_object, scope_id, polarity, modality, claim_status,
            scores_json, content_hash, observed_at, valid_from, valid_to,
            reference_time, invalid_at, expired_at, entities_json, created_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO sb_claim_vectors")) {
          const [
            claim_id,
            embedding_fingerprint,
            parent_version_id,
            content_hash,
            vector_ids_json,
            indexed_at,
            guardedClaimId,
            guardedContentHash,
          ] = args;
          if (s.includes("WHERE EXISTS") && !db.memories.some((memory: any) =>
            String(memory.id) === String(guardedClaimId) &&
            String(memory.content_hash) === String(guardedContentHash)
          )) {
            return { meta: { changes: 0 } };
          }
          const existing = db.claimVectors.find((row: any) =>
            String(row.claim_id) === String(claim_id) &&
            String(row.embedding_fingerprint) === String(embedding_fingerprint)
          );
          const next = {
            claim_id,
            embedding_fingerprint,
            parent_version_id,
            content_hash,
            vector_ids_json,
            indexed_at,
          };
          if (existing) Object.assign(existing, next);
          else db.claimVectors.push(next);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM sb_claim_vectors WHERE claim_id IN")) {
          const wanted = new Set(args.map(String));
          const before = db.claimVectors.length;
          db.claimVectors = db.claimVectors.filter((row: any) => !wanted.has(String(row.claim_id)));
          return { meta: { changes: before - db.claimVectors.length } };
        }
        if (s.startsWith("INSERT INTO sb_memory_sources")) {
          let id: any;
          let memory_id: any;
          let observation_id: any;
          let role: any;
          let score: any;
          let relation: any = "derived_from";
          let extract_span: any = null;
          let evidence_score: any = null;
          let derivation_confidence: any = null;
          let extractor_model: any = null;
          let extractor_version: any = null;
          let evidence_root_id: any;
          let created_at: any;
          if (args.length >= 13) {
            [
              id,
              memory_id,
              observation_id,
              role,
              score,
              relation,
              extract_span,
              evidence_score,
              derivation_confidence,
              extractor_model,
              extractor_version,
              evidence_root_id,
              created_at,
            ] = args;
          } else {
            [id, memory_id, observation_id, role, score, created_at] = args;
            evidence_root_id = observation_id;
          }
          const existing = db.memorySources.find(
            (row: any) =>
              row.memory_id === memory_id &&
              row.observation_id === observation_id &&
              row.role === role
          );
          if (existing) {
            if (score != null) existing.score = score;
            if (evidence_score != null) existing.evidence_score = evidence_score;
            if (derivation_confidence != null) existing.derivation_confidence = derivation_confidence;
          } else {
            db.memorySources.push({
              id, memory_id, observation_id, role, score, relation,
              extract_span, evidence_score, derivation_confidence,
              extractor_model, extractor_version, evidence_root_id, created_at,
            });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_memories SET confidence = CASE")) {
          const [score, , , id] = args;
          const row = db.memories.find((memory: any) => memory.id === id);
          if (row && (row.confidence == null || Number(row.confidence) < Number(score))) {
            row.confidence = score;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.includes("UPDATE sb_memories") && s.includes("SET claim_status = 'confirmed'") && s.includes("scores_json = ?") && s.includes("WHERE id = ?")) {
          const [scores_json, id] = args;
          const row = db.memories.find((memory: any) => memory.id === id);
          if (row) {
            row.claim_status = "confirmed";
            row.scores_json = scores_json;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.includes("UPDATE sb_memories") && s.includes("SET claim_status = 'supported'") && s.includes("scores_json = ?") && s.includes("WHERE id = ?")) {
          const [scores_json, id] = args;
          const row = db.memories.find((memory: any) => memory.id === id);
          if (row) {
            row.claim_status = "supported";
            row.scores_json = scores_json;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_entity_relations SET invalid_at")) {
          if (s.includes("WHERE id = ?")) {
            const [invalid_at, expired_at, valid_to, id] = args;
            const row = db.entityRelations.find((relation: any) => relation.id === id);
            if (row && row.invalid_at == null && row.expired_at == null) {
              row.invalid_at = invalid_at;
              row.expired_at = expired_at;
              if (row.valid_to == null) row.valid_to = valid_to;
              row.resolution_state = "superseded";
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          const hasExpiredAt = s.startsWith("UPDATE sb_entity_relations SET invalid_at = ?, expired_at = ?");
          if (
            hasExpiredAt &&
            (s.includes("AND invalid_at = ?") || s.includes("m_target.invalid_at = ?"))
          ) {
            const [invalid_at, expired_at, valid_to, entry_id, excluded_id, invalidated_at, expired_match] = args;
            const invalidatedMemoryIds = new Set(
              db.memories
                .filter((memory: any) =>
                  memory.entry_id === entry_id &&
                  memory.id !== excluded_id &&
                  memory.invalid_at === invalidated_at &&
                  memory.expired_at === expired_match
                )
                .map((memory: any) => memory.id)
            );
            let changes = 0;
            for (const relation of db.entityRelations) {
              if (
                relation.invalid_at == null &&
                relation.expired_at == null &&
                invalidatedMemoryIds.has(relation.memory_id)
              ) {
                relation.invalid_at = invalid_at;
                relation.expired_at = expired_at;
                if (relation.valid_to == null) relation.valid_to = valid_to;
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          const [invalid_at, maybe_expired_at, maybe_valid_to, maybe_entry_id] = args;
          const expired_at = hasExpiredAt ? maybe_expired_at : null;
          const valid_to = hasExpiredAt ? maybe_valid_to : maybe_expired_at;
          const entry_id = hasExpiredAt ? maybe_entry_id : maybe_valid_to;
          const activeMemoryIds = new Set(
            db.memories
              .filter((memory: any) =>
                memory.entry_id === entry_id &&
                memory.invalid_at == null &&
                memory.expired_at == null
              )
              .map((memory: any) => memory.id)
          );
          let changes = 0;
          for (const relation of db.entityRelations) {
            if (
              relation.invalid_at == null &&
              relation.expired_at == null &&
              activeMemoryIds.has(relation.memory_id)
            ) {
              relation.invalid_at = invalid_at;
              if (hasExpiredAt) relation.expired_at = expired_at;
              if (relation.valid_to == null) relation.valid_to = valid_to;
              changes += 1;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE sb_entity_relations SET fact_hash")) {
          const [
            fact_hash,
            sourceInserted,
            scoreA,
            scoreB,
            scoreC,
            validFromA,
            validFromB,
            validFromC,
            validToA,
            validToB,
            validToC,
            referenceTime,
            id,
          ] = args;
          const row = db.entityRelations.find((relation: any) => relation.id === id);
          if (row) {
            row.fact_hash = row.fact_hash ?? fact_hash;
            row.evidence_count = Number(row.evidence_count ?? 1) + (Number(sourceInserted) === 1 ? 1 : 0);
            if (scoreA != null && (row.score == null || Number(row.score) < Number(scoreB))) {
              row.score = scoreC;
            }
            if (row.valid_from == null) row.valid_from = validFromA ?? null;
            else if (validFromB != null) row.valid_from = Math.min(Number(row.valid_from), Number(validFromC));
            if (row.valid_to == null) row.valid_to = validToA ?? null;
            else if (validToB != null) row.valid_to = Math.max(Number(row.valid_to), Number(validToC));
            row.reference_time = row.reference_time ?? referenceTime ?? null;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_memories SET invalid_at")) {
          const hasExpiredAt = s.startsWith("UPDATE sb_memories SET invalid_at = ?, expired_at = ?");
          const [invalid_at, maybe_expired_at, maybe_valid_to, maybe_entry_id] = args;
          const expired_at = hasExpiredAt ? maybe_expired_at : null;
          const valid_to = hasExpiredAt ? maybe_valid_to : maybe_expired_at;
          const entry_id = hasExpiredAt ? maybe_entry_id : maybe_valid_to;
          const excluded_id = hasExpiredAt && s.includes("AND id != ?") ? args[4] : null;
          const keepsActiveParentSupport = (memoryId: string) =>
            db.parentVersionClaims.some((claim: any) =>
              String(claim.memory_id) === String(memoryId) &&
              parentVersionIsEligibleAt(db, claim.parent_version_id, Number(invalid_at))
            );
          let changes = 0;
          for (const memory of db.memories) {
            if (
              memory.entry_id === entry_id &&
              memory.invalid_at == null &&
              memory.expired_at == null &&
              (excluded_id == null || memory.id !== excluded_id) &&
              (!s.includes("NOT EXISTS") || !keepsActiveParentSupport(memory.id))
            ) {
              memory.invalid_at = invalid_at;
              if (hasExpiredAt) memory.expired_at = expired_at;
              if (memory.valid_to == null) memory.valid_to = valid_to;
              changes += 1;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE sb_entities SET aliases_json")) {
          const [aliases_json, metadata_json, updated_at, id] = args;
          const row = db.entities.find((e: any) => e.id === id);
          if (row) {
            row.aliases_json = aliases_json;
            row.metadata_json = metadata_json;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_entities")) {
          const [entity_type, updated_at, id] = args;
          const row = db.entities.find((e: any) => e.id === id);
          if (row) {
            row.mention_count = Number(row.mention_count ?? 0) + 1;
            if (entity_type != null) row.entity_type = entity_type;
            row.updated_at = updated_at;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("INSERT INTO sb_entities")) {
          // VALUES (?, ?, ?, ?, '[]', '{}', 1, ?, ?)
          const [id, name, name_normalized, entity_type, created_at, updated_at] = args;
          db.entities.push({
            id, name, name_normalized, entity_type,
            aliases_json: '[]', metadata_json: '{}',
            mention_count: 1,
            created_at, updated_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO sb_memory_entities")) {
          const [id, memory_id, entity_id, role, score, created_at] = args;
          const exists = db.memoryEntities.some(
            (row: any) => row.memory_id === memory_id && row.entity_id === entity_id && row.role === role
          );
          if (!exists) {
            db.memoryEntities.push({ id, memory_id, entity_id, role, score, created_at });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO sb_entity_relations")) {
          let id: any;
          let from_entity_id: any;
          let to_entity_id: any;
          let relation_type: any;
          let fact: any;
          let fact_hash: any;
          let evidence_count: any;
          let memory_id: any;
          let observation_id: any;
          let score: any;
          let valid_from: any;
          let valid_to: any;
          let invalid_at: any;
          let expired_at: any;
          let reference_time: any;
          let metadata_json: any;
          let created_at: any;
          if (args.length >= 22) {
            let scope_id: any;
            let polarity: any;
            let modality: any;
            let resolution_type: any;
            let resolution_state: any;
            let supersedes_relation_id: any;
            [
              id, from_entity_id, to_entity_id, relation_type, fact,
              fact_hash, memory_id, observation_id, score,
              valid_from, valid_to, invalid_at, expired_at, reference_time,
              scope_id, polarity, modality, resolution_type, resolution_state,
              supersedes_relation_id, metadata_json, created_at,
            ] = args;
            evidence_count = 1;
            db.entityRelations.push({
              id, from_entity_id, to_entity_id, relation_type, fact,
              fact_hash, evidence_count, memory_id, observation_id, score,
              valid_from, valid_to, invalid_at, expired_at, reference_time,
              scope_id, polarity, modality, resolution_type, resolution_state,
              supersedes_relation_id, metadata_json, created_at,
            });
            return { meta: { changes: 1 } };
          } else if (args.length >= 17) {
            [
              id, from_entity_id, to_entity_id, relation_type, fact,
              fact_hash, evidence_count, memory_id, observation_id, score,
              valid_from, valid_to, invalid_at, expired_at, reference_time,
              metadata_json, created_at,
            ] = args;
          } else if (args.length >= 15) {
            [
              id, from_entity_id, to_entity_id, relation_type, fact,
              memory_id, observation_id, score,
              valid_from, valid_to, invalid_at, expired_at, reference_time,
              metadata_json, created_at,
            ] = args;
            fact_hash = null;
            evidence_count = 1;
          } else {
            [
              id, from_entity_id, to_entity_id, relation_type, fact,
              memory_id, observation_id, score,
              valid_from, valid_to, invalid_at, reference_time,
              metadata_json, created_at,
            ] = args;
            expired_at = null;
            fact_hash = null;
            evidence_count = 1;
          }
          db.entityRelations.push({
            id, from_entity_id, to_entity_id, relation_type, fact,
            fact_hash, evidence_count,
            memory_id, observation_id, score,
            valid_from, valid_to, invalid_at, expired_at, reference_time,
            metadata_json, created_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT OR IGNORE INTO sb_fact_sources")) {
          const [id, relation_id, memory_id, observation_id, created_at] = args;
          const exists = db.factSources.some((source: any) =>
            source.relation_id === relation_id &&
            source.memory_id === memory_id &&
            source.observation_id === observation_id
          );
          if (!exists) {
            db.factSources.push({ id, relation_id, memory_id, observation_id, created_at });
          }
          return { meta: { changes: exists ? 0 : 1 } };
        }

        if (s.startsWith("INSERT INTO sb_memory_relations")) {
          const [id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at] = args;
          db.relations.push({ id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO sb_memory_revisions")) {
          const [
            id,
            memory_id,
            event_type,
            old_content,
            new_content,
            old_metadata_json,
            new_metadata_json,
            reason,
            actor,
            created_at,
          ] = args;
          if (s.includes("WHERE EXISTS")) {
            const guardMemoryId = args[10];
            const activeVectorIdsJson = args[11];
            const active = db.entries.some(
              (entry: any) =>
                entry.id === guardMemoryId && entry.vector_ids === activeVectorIdsJson
            );
            if (!active) return { meta: { changes: 0 } };
          }
          db.revisions.push({
            id,
            memory_id,
            event_type,
            old_content,
            new_content,
            old_metadata_json,
            new_metadata_json,
            reason,
            actor,
            created_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT OR IGNORE INTO sb_memory_merge_candidates")) {
          const [
            id,
            source_memory_id,
            target_memory_id,
            similarity,
            suggested_action,
            reason,
            created_at,
          ] = args;
          const exists = db.mergeCandidates.some((candidate: any) =>
            candidate.source_memory_id === source_memory_id &&
            candidate.target_memory_id === target_memory_id &&
            candidate.suggested_action === suggested_action
          );
          if (!exists) {
            db.mergeCandidates.push({
              id,
              source_memory_id,
              target_memory_id,
              similarity,
              suggested_action,
              reason,
              state: "pending",
              reviewed_by: null,
              reviewed_at: null,
              created_at,
            });
          }
          return { meta: { changes: exists ? 0 : 1 } };
        }
        if (s.startsWith("UPDATE sb_memory_merge_candidates SET state = ?")) {
          const [state, reviewed_by, reviewed_at, id] = args;
          const row = db.mergeCandidates.find((candidate: any) => candidate.id === id);
          if (row) {
            Object.assign(row, { state, reviewed_by, reviewed_at });
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("INSERT OR IGNORE INTO sb_conflict_cases")) {
          const hasClaimIds = s.includes("old_claim_id, new_claim_id");
          const [id, old_memory_id, new_memory_id] = args;
          const old_claim_id = hasClaimIds ? args[3] : null;
          const new_claim_id = hasClaimIds ? args[4] : null;
          const offset = hasClaimIds ? 5 : 3;
          const conflict_type = args[offset];
          const reason = args[offset + 1];
          const confidence = args[offset + 2];
          const created_at = args[offset + 3];
          const exists = db.conflictCases.some((conflict: any) =>
            conflict.old_memory_id === old_memory_id &&
            conflict.new_memory_id === new_memory_id &&
            conflict.conflict_type === conflict_type
          );
          if (!exists) {
            db.conflictCases.push({
              id,
              old_memory_id,
              new_memory_id,
              old_claim_id,
              new_claim_id,
              conflict_type,
              reason,
              confidence,
              state: "pending",
              resolution: null,
              resolved_by: null,
              resolved_at: null,
              created_at,
            });
          }
          return { meta: { changes: exists ? 0 : 1 } };
        }
        if (s.startsWith("UPDATE sb_conflict_cases SET state = ?")) {
          const [state, resolution, resolved_by, resolved_at, id] = args;
          const row = db.conflictCases.find((conflict: any) => conflict.id === id);
          if (row) {
            Object.assign(row, { state, resolution, resolved_by, resolved_at });
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_conflict_cases SET old_claim_id = ?")) {
          const [old_claim_id, new_claim_id, old_memory_id, new_memory_id] = args;
          const row = db.conflictCases.find((conflict: any) =>
            conflict.old_memory_id === old_memory_id &&
            conflict.new_memory_id === new_memory_id &&
            conflict.state === "pending" &&
            conflict.old_claim_id == null &&
            conflict.new_claim_id == null
          );
          if (row) Object.assign(row, { old_claim_id, new_claim_id });
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_memories SET claim_status = 'contested'")) {
          const [oldClaimId, newClaimId] = args;
          const conflict = s.includes("old_memory_id = ?")
            ? db.conflictCases.find((item: any) =>
                item.old_memory_id === args[2] &&
                item.new_memory_id === args[3] &&
                item.old_claim_id === args[4] &&
                item.new_claim_id === args[5] &&
                item.state === "pending"
              )
            : db.conflictCases.find((item: any) =>
                item.id === args[2] && item.state === "pending"
              );
          if (!conflict) return { meta: { changes: 0 } };
          let changes = 0;
          for (const memory of db.memories) {
            if (memory.id === oldClaimId || memory.id === newClaimId) {
              memory.claim_status = "contested";
              changes += 1;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE sb_memories SET claim_status = 'superseded'")) {
          const [invalid_at, valid_to, entry_id] = args;
          let changes = 0;
          for (const memory of db.memories) {
            if (
              memory.entry_id === entry_id &&
              !["superseded", "deprecated"].includes(String(memory.claim_status ?? "supported"))
            ) {
              memory.claim_status = "superseded";
              memory.invalid_at = memory.invalid_at ?? invalid_at;
              memory.valid_to = memory.valid_to ?? valid_to;
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE sb_memories SET claim_status = 'deprecated'")) {
          const [invalid_at, valid_to, entry_id] = args;
          let changes = 0;
          for (const memory of db.memories) {
            if (
              memory.entry_id === entry_id &&
              !["superseded", "deprecated"].includes(String(memory.claim_status ?? "supported"))
            ) {
              memory.claim_status = "deprecated";
              memory.invalid_at = memory.invalid_at ?? invalid_at;
              memory.valid_to = memory.valid_to ?? valid_to;
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE sb_memories SET claim_status = 'confirmed'")) {
          const [entry_id] = args;
          let changes = 0;
          for (const memory of db.memories) {
            if (
              memory.entry_id === entry_id &&
              ["supported", "contested", "unsupported"].includes(String(memory.claim_status ?? "supported"))
            ) {
              memory.claim_status = "confirmed";
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("INSERT INTO sb_audit_events")) {
          const [
            id,
            occurred_at,
            trace_id,
            actor_type,
            actor_id,
            token_id,
            action,
            object_type,
            object_id,
            vault_id,
            before_hash,
            after_hash,
            success,
            error_code,
            metadata_json,
            previous_event_hash,
            event_hash,
          ] = args;
          db.auditEvents.push({
            id,
            occurred_at,
            trace_id,
            actor_type,
            actor_id,
            token_id,
            action,
            object_type,
            object_id,
            vault_id,
            before_hash,
            after_hash,
            success,
            error_code,
            metadata_json,
            previous_event_hash,
            event_hash,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM sb_memory_relations")) {
          const ids = new Set(args.map(String));
          const before = db.relations.length;
          db.relations = db.relations.filter(
            (relation: any) =>
              !ids.has(String(relation.from_memory_id)) &&
              !ids.has(String(relation.to_memory_id))
          );
          return { meta: { changes: before - db.relations.length } };
        }
        if (s.startsWith("DELETE FROM sb_memory_revisions")) {
          const memoryIds = new Set(args.map(String));
          const before = db.revisions.length;
          db.revisions = db.revisions.filter(
            (revision: any) => !memoryIds.has(String(revision.memory_id))
          );
          return { meta: { changes: before - db.revisions.length } };
        }
        if (s.startsWith("DELETE FROM sb_entity_relations WHERE memory_id IN") && !s.includes("id NOT IN")) {
          const memoryIds = new Set(args.map(String));
          const before = db.entityRelations.length;
          db.entityRelations = db.entityRelations.filter(
            (relation: any) => !memoryIds.has(String(relation.memory_id))
          );
          return { meta: { changes: before - db.entityRelations.length } };
        }
        if (s.startsWith("DELETE FROM sb_fact_sources WHERE memory_id IN")) {
          const memoryIds = new Set(args.map(String));
          const before = db.factSources.length;
          db.factSources = db.factSources.filter(
            (source: any) => !memoryIds.has(String(source.memory_id))
          );
          return { meta: { changes: before - db.factSources.length } };
        }
        if (s.startsWith("UPDATE sb_entity_relations SET evidence_count")) {
          if (
            s.includes("SELECT COUNT(*) FROM sb_fact_sources WHERE relation_id = ?") ||
            s.includes("FROM sb_fact_sources fs_count")
          ) {
            const [relationId, scoreA, scoreB, scoreC,
              validFromA, validFromB, validFromC,
              validToA, validToB, validToC, referenceTime, id] = args;
            const relation = db.entityRelations.find((row: any) => row.id === id);
            if (relation) {
              const independentSources = new Set<string>();
              for (const source of db.factSources.filter(
                (item: any) => item.relation_id === relationId
              )) {
                const provenance = db.memorySources.filter(
                  (item: any) =>
                    item.memory_id === source.memory_id &&
                    ["supports", "derived_from"].includes(String(item.relation ?? item.role ?? ""))
                );
                if (provenance.length > 0) {
                  for (const item of provenance) {
                    const observation = db.observations.find(
                      (candidate: any) => candidate.id === item.observation_id
                    );
                    independentSources.add(String(
                      item.evidence_root_id ??
                      observation?.root_evidence_id ??
                      item.observation_id
                    ));
                  }
                } else {
                  independentSources.add(String(
                    source.observation_id ??
                    (source.memory_id != null ? `memory:${source.memory_id}` : `fact-source:${source.id}`)
                  ));
                }
              }
              relation.evidence_count = Math.max(
                1,
                independentSources.size
              );
              if (scoreA != null && (relation.score == null || Number(relation.score) < Number(scoreB))) {
                relation.score = scoreC;
              }
              if (relation.valid_from == null) relation.valid_from = validFromA ?? null;
              else if (validFromB != null) relation.valid_from = Math.min(Number(relation.valid_from), Number(validFromC));
              if (relation.valid_to == null) relation.valid_to = validToA ?? null;
              else if (validToB != null) relation.valid_to = Math.max(Number(relation.valid_to), Number(validToC));
              relation.reference_time = relation.reference_time ?? referenceTime ?? null;
            }
            return { meta: { changes: relation ? 1 : 0 } };
          }
          const memoryIds = new Set(args.map(String));
          const affectedRelationIds = new Set(
            db.factSources
              .filter((source: any) => memoryIds.has(String(source.memory_id)))
              .map((source: any) => source.relation_id)
          );
          let changes = 0;
          for (const relation of db.entityRelations) {
            if (!affectedRelationIds.has(relation.id)) continue;
            const sources = db.factSources.filter((source: any) =>
              source.relation_id === relation.id &&
              (source.memory_id == null || !memoryIds.has(String(source.memory_id)))
            );
            if (!sources.length) continue;
            relation.evidence_count = sources.length;
            relation.memory_id = sources.find((source: any) => source.memory_id != null)?.memory_id ?? null;
            relation.observation_id = sources.find((source: any) => source.observation_id != null)?.observation_id ?? null;
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("DELETE FROM sb_entity_relations") && s.includes("id NOT IN")) {
          const memoryIds = new Set(args.map(String));
          const sourcedRelationIds = new Set(db.factSources.map((source: any) => source.relation_id));
          const affectedRelationIds = new Set(
            db.factSources
              .filter((source: any) => memoryIds.has(String(source.memory_id)))
              .map((source: any) => source.relation_id)
          );
          const survivingRelationIds = new Set(
            db.factSources
              .filter((source: any) =>
                source.memory_id == null || !memoryIds.has(String(source.memory_id))
              )
              .map((source: any) => source.relation_id)
          );
          const before = db.entityRelations.length;
          db.entityRelations = db.entityRelations.filter(
            (relation: any) => {
              const exhaustedRelation =
                affectedRelationIds.has(relation.id) && !survivingRelationIds.has(relation.id);
              const legacyDeletingRelation =
                memoryIds.has(String(relation.memory_id)) && !sourcedRelationIds.has(relation.id);
              return !exhaustedRelation && !legacyDeletingRelation;
            }
          );
          return { meta: { changes: before - db.entityRelations.length } };
        }
        if (s.startsWith("DELETE FROM sb_memory_entities WHERE memory_id IN")) {
          const memoryIds = new Set(args.map(String));
          const before = db.memoryEntities.length;
          db.memoryEntities = db.memoryEntities.filter(
            (link: any) => !memoryIds.has(String(link.memory_id))
          );
          return { meta: { changes: before - db.memoryEntities.length } };
        }
        if (s.startsWith("DELETE FROM sb_memory_sources WHERE memory_id IN")) {
          const memoryIds = new Set(args.map(String));
          const before = db.memorySources.length;
          db.memorySources = db.memorySources.filter(
            (source: any) => !memoryIds.has(String(source.memory_id))
          );
          return { meta: { changes: before - db.memorySources.length } };
        }
        if (s.startsWith("DELETE FROM sb_memories WHERE id IN")) {
          const memoryIds = new Set(args.map(String));
          const before = db.memories.length;
          db.memories = db.memories.filter(
            (memory: any) => !memoryIds.has(String(memory.id))
          );
          return { meta: { changes: before - db.memories.length } };
        }
        if (s.startsWith("DELETE FROM sb_observations")) {
          const observationIds = new Set(args.map(String));
          const before = db.observations.length;
          db.observations = db.observations.filter(
            (observation: any) =>
              !observationIds.has(String(observation.id)) ||
              db.memorySources.some(
                (source: any) => source.observation_id === observation.id
              )
          );
          return { meta: { changes: before - db.observations.length } };
        }
        if (s.startsWith("INSERT INTO entries")) {
          if (s.includes("classification_confidence")) {
            const [
              id, content, tags, source, created_at, vector_ids,
              recall_count, importance_score, classification_confidence,
              classification_status, classification_error, classification_attempts,
              classification_next_attempt_at, classification_version, classified_at,
              contradiction_wins, contradiction_losses, content_hash,
            ] = args;
            db.entries.push({
              id, content, tags, source, created_at, vector_ids,
              recall_count, importance_score, classification_confidence,
              classification_status, classification_error, classification_attempts,
              classification_next_attempt_at, classification_started_at: null,
              classification_version, classified_at,
              contradiction_wins, contradiction_losses,
              content_hash: content_hash ?? null,
            });
          } else if (s.includes("content_hash") && args.length >= 7) {
            const hasMetadataHash = s.includes("metadata_hash");
            const hasImportance = s.includes("importance_score") || args.length >= (hasMetadataHash ? 9 : 8);
            const id = args[0];
            const content = args[1];
            const tags = args[2];
            const source = args[3];
            const created_at = args[4];
            const vector_ids = args[5];
            const content_hash = args[6];
            let index = 7;
            const metadata_hash = hasMetadataHash ? args[index++] : null;
            const importance_score = hasImportance && args.length > index ? args[index] : 0;
            const row = {
              id, content, tags, source, created_at, vector_ids,
              recall_count: 0, importance_score: importance_score ?? 0,
              contradiction_wins: 0, contradiction_losses: 0,
              content_hash,
              metadata_hash,
            };
            resetClassification(row);
            db.entries.push(row);
          } else if (args.length >= 10) {
            const [id, content, tags, source, created_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses] = args;
            const row = { id, content, tags, source, created_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses, content_hash: null };
            resetClassification(row);
            db.entries.push(row);
          } else {
            const [id, content, tags, source, created_at, vector_ids] = args;
            const row = { id, content, tags, source, created_at, vector_ids, recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0, content_hash: null };
            resetClassification(row);
            db.entries.push(row);
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids")) {
          if (s.includes("AND content = ? AND tags = ? AND vector_ids = ?")) {
            const hasHash = s.includes("content_hash");
            const hasActiveEmbedding = s.includes("vector_ids = ?, embedding_fingerprint = ?");
            const hasMetadataHash = s.includes("metadata_hash = ?");
            const hasPending = s.includes("pending_vector_ids");
            const hasPendingRebuildId = s.includes("pending_rebuild_id = ?");
            const content = args[0];
            const vector_ids = args[1];
            let index = 2;
            const embedding_fingerprint = hasActiveEmbedding ? args[index++] : undefined;
            const content_hash = hasHash ? args[index++] : null;
            const metadata_hash = hasMetadataHash ? args[index++] : null;
            const pending_vector_ids = hasPending ? args[index++] : undefined;
            const pending_embedding_fingerprint = hasPending ? args[index++] : undefined;
            const pending_rebuild_id = hasPendingRebuildId ? args[index++] : undefined;
            const id = args[index++];
            const expected_content = args[index++];
            const expected_tags = args[index++];
            const expected_vector_ids = args[index++];
            const expected_embedding_fingerprint = s.includes("json_extract(value, '$.embeddingFingerprint')")
              ? String(args[index++])
              : null;
            const row = db.entries.find(
              (e: any) =>
                e.id === id &&
                e.content === expected_content &&
                e.tags === expected_tags &&
                e.vector_ids === expected_vector_ids &&
                activeEmbeddingMatches(expected_embedding_fingerprint)
            );
            if (row) {
              row.content = content;
              row.vector_ids = vector_ids;
              if (hasActiveEmbedding) row.embedding_fingerprint = embedding_fingerprint;
              if (hasHash) row.content_hash = content_hash;
              if (hasMetadataHash) row.metadata_hash = metadata_hash;
              if (hasPending) {
                row.pending_vector_ids = pending_vector_ids;
                row.pending_embedding_fingerprint = pending_embedding_fingerprint;
                row.pending_content_hash = null;
                row.pending_revision_id = null;
                row.pending_metadata_hash = null;
                if (hasPendingRebuildId) row.pending_rebuild_id = pending_rebuild_id;
              }
              if (s.includes("classification_status = 'pending'")) resetClassification(row);
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          const [content, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, vector_ids")) {
          const [tags, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.tags = tags;
            row.vector_ids = vector_ids;
            if (s.includes("pending_vector_ids = NULL")) {
              row.pending_vector_ids = null;
              row.pending_embedding_fingerprint = null;
              row.pending_content_hash = null;
              row.pending_revision_id = null;
              row.pending_metadata_hash = null;
              row.pending_rebuild_id = null;
            }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = ?,")) {
          if (!s.includes("pending_vector_ids = ?")) {
            const hasActiveEmbedding = s.includes("embedding_fingerprint = ?");
            const hasMetadataHash = s.includes("metadata_hash = ?");
            const vector_ids = args[0];
            let index = 1;
            const embedding_fingerprint = hasActiveEmbedding ? args[index++] : undefined;
            const metadata_hash = hasMetadataHash ? args[index++] : undefined;
            const id = args[index++];
            const expected_vector_ids = args[index++];
            const expected_content = args[index++];
            const expected_embedding_fingerprint = s.includes("json_extract(value, '$.embeddingFingerprint')")
              ? String(args[index++])
              : null;
            const row = db.entries.find(
              (e: any) =>
                e.id === id &&
                e.vector_ids === expected_vector_ids &&
                e.content === expected_content &&
                !String(e.tags ?? "[]").includes('"status:deprecated"') &&
                activeEmbeddingMatches(expected_embedding_fingerprint)
            );
            if (row) {
              row.vector_ids = vector_ids;
              if (hasActiveEmbedding) row.embedding_fingerprint = embedding_fingerprint;
              if (hasMetadataHash) row.metadata_hash = metadata_hash;
              row.pending_content_hash = null;
              row.pending_revision_id = null;
              row.pending_metadata_hash = null;
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          const hasActiveEmbedding = s.includes("embedding_fingerprint = ?");
          const hasMetadataHash = s.includes("metadata_hash = ?");
          const vector_ids = args[0];
          let index = 1;
          const embedding_fingerprint = hasActiveEmbedding ? args[index++] : undefined;
          const metadata_hash = hasMetadataHash ? args[index++] : undefined;
          const pending_vector_ids = args[index++];
          const pending_embedding_fingerprint = args[index++];
          const id = args[index++];
          const expected_vector_ids = args[index++];
          const expected_content = args[index++];
          const expected_embedding_fingerprint = s.includes("json_extract(value, '$.embeddingFingerprint')")
            ? String(args[index++])
            : null;
          const row = db.entries.find(
            (e: any) =>
              e.id === id &&
              e.vector_ids === expected_vector_ids &&
              e.content === expected_content &&
              !String(e.tags ?? "[]").includes('"status:deprecated"') &&
              activeEmbeddingMatches(expected_embedding_fingerprint)
          );
          if (row) {
            row.vector_ids = vector_ids;
            if (hasActiveEmbedding) row.embedding_fingerprint = embedding_fingerprint;
            if (hasMetadataHash) row.metadata_hash = metadata_hash;
            row.pending_vector_ids = pending_vector_ids;
            row.pending_embedding_fingerprint = pending_embedding_fingerprint;
            row.pending_content_hash = null;
            row.pending_revision_id = null;
            row.pending_metadata_hash = null;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = ? WHERE id = ? AND vector_ids = ? AND content = ?")) {
          const [vector_ids, id, expected_vector_ids, expected_content] = args;
          const row = db.entries.find(
            (e: any) =>
              e.id === id &&
              e.vector_ids === expected_vector_ids &&
              e.content === expected_content &&
              !String(e.tags ?? "[]").includes('"status:deprecated"')
          );
          if (row) row.vector_ids = vector_ids;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET pending_vector_ids = '[]'")) {
          if (s.includes("pending_revision_id IS ?") && s.includes("pending_vector_ids = ?")) {
            const [
              pending_embedding_fingerprint,
              pending_rebuild_id,
              id,
              expected_pending_rebuild_id,
              expected_pending_vector_ids,
              expected_pending_revision_id,
              expected_pending_content_hash,
              expected_pending_metadata_hash,
            ] = args;
            const candidate = db.entries.find((e: any) =>
              e.id === id &&
              e.pending_rebuild_id === expected_pending_rebuild_id &&
              e.pending_vector_ids === expected_pending_vector_ids &&
              (e.pending_revision_id ?? null) === (expected_pending_revision_id ?? null) &&
              (e.pending_content_hash ?? null) === (expected_pending_content_hash ?? null) &&
              (e.pending_metadata_hash ?? null) === (expected_pending_metadata_hash ?? null) &&
              (
                e.pending_content_hash == null ||
                e.content_hash == null ||
                e.pending_revision_id == null ||
                e.pending_metadata_hash == null ||
                e.metadata_hash == null ||
                e.pending_content_hash !== e.content_hash ||
                e.pending_metadata_hash !== e.metadata_hash
              )
            );
            if (candidate && db.beforePendingGenerationReset) {
              const hook = db.beforePendingGenerationReset;
              const keepHook = hook(candidate);
              if (keepHook !== true) db.beforePendingGenerationReset = undefined;
            }
            const row = db.entries.find((e: any) =>
              e.id === id &&
              e.pending_rebuild_id === expected_pending_rebuild_id &&
              e.pending_vector_ids === expected_pending_vector_ids &&
              (e.pending_revision_id ?? null) === (expected_pending_revision_id ?? null) &&
              (e.pending_content_hash ?? null) === (expected_pending_content_hash ?? null) &&
              (e.pending_metadata_hash ?? null) === (expected_pending_metadata_hash ?? null) &&
              (
                e.pending_content_hash == null ||
                e.content_hash == null ||
                e.pending_revision_id == null ||
                e.pending_metadata_hash == null ||
                e.metadata_hash == null ||
                e.pending_content_hash !== e.content_hash ||
                e.pending_metadata_hash !== e.metadata_hash
              )
            );
            if (row) {
              row.pending_vector_ids = "[]";
              row.pending_embedding_fingerprint = pending_embedding_fingerprint;
              row.pending_content_hash = null;
              row.pending_revision_id = null;
              row.pending_metadata_hash = null;
              row.pending_rebuild_id = pending_rebuild_id;
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          const [pending_embedding_fingerprint, pending_rebuild_id, maybe_id, maybe_expected_rebuild_id, maybe_exists_rebuild_id] = args;
          const hasEntryScopedWhere = s.includes("WHERE id = ? AND tags NOT LIKE");
          const scopedId = hasEntryScopedWhere ? String(maybe_id) : null;
          const expectedDifferentRebuildId = s.includes("pending_rebuild_id IS NULL OR pending_rebuild_id != ?")
            ? String(hasEntryScopedWhere ? maybe_expected_rebuild_id : maybe_id)
            : null;
          const existsRebuildId = String(
            s.includes("pending_rebuild_id IS NULL OR pending_rebuild_id != ?")
              ? (hasEntryScopedWhere ? maybe_exists_rebuild_id : maybe_expected_rebuild_id)
              : (scopedId ? maybe_expected_rebuild_id : pending_rebuild_id)
          );
          const rebuildOpen = db.vectorRebuilds.some((item: any) =>
            item.id === existsRebuildId && ["queued", "building", "ready"].includes(item.state)
          );
          let changes = 0;
          for (const row of db.entries) {
            if (scopedId && row.id !== scopedId) continue;
            if (String(row.tags ?? "[]").includes('"status:deprecated"')) continue;
            if (!rebuildOpen) continue;
            if (expectedDifferentRebuildId && row.pending_rebuild_id === expectedDifferentRebuildId) continue;
            row.pending_vector_ids = "[]";
            row.pending_embedding_fingerprint = pending_embedding_fingerprint;
            row.pending_content_hash = null;
            row.pending_revision_id = null;
            row.pending_metadata_hash = null;
            row.pending_rebuild_id = pending_rebuild_id;
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE entries SET pending_vector_ids = ?, pending_embedding_fingerprint = ?")) {
          const [
            pending_vector_ids,
            pending_embedding_fingerprint,
            pending_content_hash,
            maybe_pending_revision_id,
            maybe_pending_metadata_hash,
            maybe_content_hash,
            maybe_metadata_hash,
            id,
            expected_pending_vector_ids,
            expected_pending_embedding_fingerprint,
            maybe_expected_pending_rebuild_id,
            maybe_expected_content,
            maybe_expected_tags,
            maybe_expected_source,
          ] = args;
          const hasPendingRevisionId = s.includes("pending_revision_id = ?");
          const pending_revision_id = hasPendingRevisionId ? maybe_pending_revision_id : null;
          const hasPendingMetadataHash = s.includes("pending_metadata_hash = ?");
          const pending_metadata_hash = hasPendingMetadataHash ? maybe_pending_metadata_hash : null;
          const content_hash = hasPendingRevisionId
            ? (hasPendingMetadataHash ? maybe_content_hash : maybe_pending_metadata_hash)
            : maybe_pending_revision_id;
          const metadata_hash = hasPendingMetadataHash ? maybe_metadata_hash : null;
          const hasPendingRebuildId = s.includes("pending_rebuild_id = ?");
          const expected_pending_rebuild_id = hasPendingRebuildId ? maybe_expected_pending_rebuild_id : undefined;
          const expected_content = hasPendingRebuildId ? maybe_expected_content : maybe_expected_pending_rebuild_id;
          const expected_tags = hasPendingMetadataHash ? maybe_expected_tags : undefined;
          const expected_source = hasPendingMetadataHash ? maybe_expected_source : undefined;
          const row = db.entries.find(
            (e: any) =>
              e.id === id &&
              e.pending_vector_ids === expected_pending_vector_ids &&
              e.pending_embedding_fingerprint === expected_pending_embedding_fingerprint &&
              (!hasPendingRebuildId || e.pending_rebuild_id === expected_pending_rebuild_id) &&
              e.content === expected_content &&
              (!hasPendingMetadataHash || e.tags === expected_tags) &&
              (!hasPendingMetadataHash || e.source === expected_source) &&
              !String(e.tags ?? "[]").includes('"status:deprecated"')
          );
          if (row) {
            row.pending_vector_ids = pending_vector_ids;
            row.pending_embedding_fingerprint = pending_embedding_fingerprint;
            row.pending_content_hash = pending_content_hash;
            row.pending_revision_id = pending_revision_id;
            row.pending_metadata_hash = pending_metadata_hash;
            if (row.content_hash == null) row.content_hash = content_hash;
            if (hasPendingMetadataHash) row.metadata_hash = metadata_hash;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET pending_vector_ids = NULL")) {
          const [pending_embedding_fingerprint] = args;
          let changes = 0;
          for (const row of db.entries) {
            if (row.pending_embedding_fingerprint !== pending_embedding_fingerprint) continue;
            row.pending_vector_ids = null;
            row.pending_embedding_fingerprint = null;
            row.pending_content_hash = null;
            row.pending_revision_id = null;
            row.pending_metadata_hash = null;
            row.pending_rebuild_id = null;
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = pending_vector_ids")) {
          const [pending_rebuild_id, state_rebuild_id] = args;
          const rebuild = db.vectorRebuilds.find(
            (item: any) => item.id === state_rebuild_id && item.state === "activating"
          );
          if (!rebuild) return { meta: { changes: 0 } };
          let changes = 0;
          for (const row of db.entries) {
            if (
              row.pending_rebuild_id === pending_rebuild_id &&
              row.pending_vector_ids != null &&
              row.pending_vector_ids !== "[]" &&
              row.pending_content_hash != null &&
              row.pending_revision_id != null &&
              row.pending_metadata_hash != null &&
              row.metadata_hash != null &&
              row.content_hash === row.pending_content_hash &&
              row.metadata_hash === row.pending_metadata_hash
            ) {
              row.vector_ids = row.pending_vector_ids;
              row.embedding_fingerprint = row.pending_embedding_fingerprint;
              row.metadata_hash = row.pending_metadata_hash;
              row.pending_vector_ids = null;
              row.pending_embedding_fingerprint = null;
              row.pending_content_hash = null;
              row.pending_revision_id = null;
              row.pending_metadata_hash = null;
              row.pending_rebuild_id = null;
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids")) {
          const [vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.vector_ids = vector_ids;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET classification_status = 'processing'")) {
          // Bind order after PR-4:
          // version, started_at, id, content, maxAttempts, now, leaseCutoff, version
          const [currentVersion, started_at, id, content, maxAttempts, now, leaseCutoff] = args;
          const row = db.entries.find((e: any) => {
            if (e.id !== id || e.content !== content) return false;
            if (String(e.tags ?? "[]").includes('"status:deprecated"')) return false;
            const status = e.classification_status;
            const staleVersion =
              status === "succeeded" &&
              Number(e.classification_version ?? 0) < Number(currentVersion);
            if (staleVersion) return true;
            if (Number(e.classification_attempts ?? 0) >= Number(maxAttempts)) return false;
            return status == null || status === "pending" ||
              (status === "retryable_error" && Number(e.classification_next_attempt_at ?? 0) <= Number(now)) ||
              (status === "processing" && Number(e.classification_started_at ?? 0) <= Number(leaseCutoff));
          });
          if (row) {
            const staleVersion =
              row.classification_status === "succeeded" &&
              Number(row.classification_version ?? 0) < Number(currentVersion);
            row.classification_status = "processing";
            row.classification_error = null;
            row.classification_attempts = staleVersion
              ? 1
              : Number(row.classification_attempts ?? 0) + 1;
            row.classification_started_at = started_at;
            row.classification_next_attempt_at = null;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (
          s.startsWith("UPDATE entries SET tags = ?, importance_score = ?, classification_confidence = ?") ||
          s.startsWith("UPDATE entries SET tags = ?, metadata_hash = ?, importance_score = ?, classification_confidence = ?")
        ) {
          const hasMetadataHash = s.includes("metadata_hash = ?");
          let index = 0;
          const tags = args[index++];
          const metadata_hash = hasMetadataHash ? args[index++] : undefined;
          const importance_score = args[index++];
          const classification_confidence = args[index++];
          const classification_version = args[index++];
          const classified_at = args[index++];
          const id = args[index++];
          const content = args[index++];
          const expected_tags = args[index++];
          const started_at = args[index++];
          const candidate = db.entries.find((e: any) => e.id === id);
          if (candidate && db.beforeClassificationCommit) {
            const hook = db.beforeClassificationCommit;
            const keepHook = hook(candidate);
            if (keepHook !== true) db.beforeClassificationCommit = undefined;
          }
          const row = db.entries.find((e: any) =>
            e.id === id && e.content === content && e.tags === expected_tags && e.classification_status === "processing" &&
            e.classification_started_at === started_at
          );
          if (row) {
            Object.assign(row, {
              tags,
              ...(hasMetadataHash ? { metadata_hash } : {}),
              importance_score,
              classification_confidence,
              classification_status: "succeeded",
              classification_error: null,
              classification_next_attempt_at: null,
              classification_started_at: null,
              classification_version,
              classified_at,
            });
            if (s.includes("pending_vector_ids = CASE")) {
              const hasPendingRebuild = row.pending_rebuild_id != null;
              row.pending_vector_ids = hasPendingRebuild ? "[]" : null;
              row.pending_embedding_fingerprint = hasPendingRebuild
                ? row.pending_embedding_fingerprint
                : null;
              row.pending_content_hash = null;
              row.pending_revision_id = null;
              row.pending_metadata_hash = null;
            }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET classification_status = ?, classification_error = ?")) {
          const [classification_status, classification_error, classification_next_attempt_at, id, content, started_at] = args;
          const row = db.entries.find((e: any) =>
            e.id === id && e.content === content && e.classification_status === "processing" &&
            e.classification_started_at === started_at
          );
          if (row) {
            row.classification_status = classification_status;
            row.classification_error = classification_error;
            row.classification_next_attempt_at = classification_next_attempt_at;
            row.classification_started_at = null;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET classification_status = 'pending'")) {
          if (s.includes("WHERE id = ? AND content = ?")) {
            const [id, content, started_at] = args;
            const row = db.entries.find((e: any) =>
              e.id === id && e.content === content && e.classification_status === "processing" &&
              e.classification_started_at === started_at
            );
            if (row) {
              row.classification_status = "pending";
              row.classification_error = null;
              if (s.includes("classification_attempts = MAX")) {
                row.classification_attempts = Math.max(0, Number(row.classification_attempts ?? 0) - 1);
              }
              row.classification_next_attempt_at = null;
              row.classification_started_at = null;
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.classification_status = "pending";
            row.classification_error = null;
            row.classification_attempts = 0;
            row.classified_at = null;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, importance_score = ?")) {
          const [tags, importance_score, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.tags = tags;
            row.importance_score = importance_score;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (
          s.startsWith("UPDATE entries SET tags = ? WHERE id") ||
          s.startsWith("UPDATE entries SET tags = ?, metadata_hash = ? WHERE id") ||
          s.startsWith("UPDATE entries SET tags = ?, metadata_hash = NULL WHERE id") ||
          s.startsWith("UPDATE entries SET tags = ?, metadata_hash = ?,") ||
          s.startsWith("UPDATE entries SET tags = ?, metadata_hash = NULL,")
        ) {
          let tags: any;
          let metadata_hash: any = undefined;
          let id: any;
          if (s.includes("metadata_hash = ?")) {
            tags = args[0];
            metadata_hash = args[1];
            id = args[args.length - 1];
          } else {
            tags = args[0];
            id = args[args.length - 1];
          }
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.tags = tags;
            if (s.includes("metadata_hash = ?")) row.metadata_hash = metadata_hash;
            if (s.includes("metadata_hash = NULL")) row.metadata_hash = null;
            if (s.includes("pending_vector_ids = CASE")) {
              const hasPendingRebuild = row.pending_rebuild_id != null;
              row.pending_vector_ids = hasPendingRebuild ? "[]" : null;
              row.pending_embedding_fingerprint = hasPendingRebuild
                ? row.pending_embedding_fingerprint
                : null;
              row.pending_content_hash = null;
              row.pending_revision_id = null;
              row.pending_metadata_hash = null;
            }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.includes("UPDATE entries SET content = ?, tags = ?, source = ?, created_at = ?, vector_ids = ?,") && s.includes("recall_count")) {
          if (s.includes("classification_confidence")) {
            const hasHash = s.includes("content_hash");
            const [
              content, tags, source, created_at, vector_ids, recall_count, importance_score,
              classification_confidence, classification_status, classification_error,
              classification_attempts, classification_next_attempt_at, classification_version,
              classified_at, contradiction_wins, contradiction_losses,
              maybeHashOrId, maybeId,
            ] = args;
            const content_hash = hasHash ? maybeHashOrId : null;
            const id = hasHash ? maybeId : maybeHashOrId;
            const row = db.entries.find((e: any) => e.id === id);
            if (row) {
              Object.assign(row, {
                content, tags, source, created_at, vector_ids, recall_count, importance_score,
                classification_confidence, classification_status, classification_error,
                classification_attempts, classification_next_attempt_at,
                classification_started_at: null, classification_version, classified_at,
                contradiction_wins, contradiction_losses,
                ...(hasHash ? { content_hash } : {}),
              });
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          const [content, tags, source, created_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            Object.assign(row, { content, tags, source, created_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses });
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, source = ?, created_at = ?, vector_ids")) {
          const [content, tags, source, created_at, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.content = content;
            row.tags = tags;
            row.source = source;
            row.created_at = created_at;
            row.vector_ids = vector_ids;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, vector_ids = ?")) {
          if (s.includes("AND content = ? AND tags = ? AND vector_ids = ?")) {
            const hasHash = s.includes("content_hash");
            const hasActiveEmbedding = s.includes("vector_ids = ?, embedding_fingerprint = ?");
            const hasMetadataHash = s.includes("metadata_hash = ?");
            const hasPending = s.includes("pending_vector_ids");
            const hasPendingRebuildId = s.includes("pending_rebuild_id = ?");
            const content = args[0];
            const tags = args[1];
            const vector_ids = args[2];
            let index = 3;
            const embedding_fingerprint = hasActiveEmbedding ? args[index++] : undefined;
            const content_hash = hasHash ? args[index++] : null;
            const metadata_hash = hasMetadataHash ? args[index++] : null;
            const pending_vector_ids = hasPending ? args[index++] : undefined;
            const pending_embedding_fingerprint = hasPending ? args[index++] : undefined;
            const pending_rebuild_id = hasPendingRebuildId ? args[index++] : undefined;
            const id = args[index++];
            const expected_content = args[index++];
            const expected_tags = args[index++];
            const expected_vector_ids = args[index++];
            const expected_embedding_fingerprint = s.includes("json_extract(value, '$.embeddingFingerprint')")
              ? String(args[index++])
              : null;
            const row = db.entries.find(
              (e: any) =>
                e.id === id &&
                e.content === expected_content &&
                e.tags === expected_tags &&
                e.vector_ids === expected_vector_ids &&
                activeEmbeddingMatches(expected_embedding_fingerprint)
            );
            if (row) {
              row.content = content;
              row.tags = tags;
              row.vector_ids = vector_ids;
              if (hasActiveEmbedding) row.embedding_fingerprint = embedding_fingerprint;
              if (hasHash) row.content_hash = content_hash;
              if (hasMetadataHash) row.metadata_hash = metadata_hash;
              if (hasPending) {
                row.pending_vector_ids = pending_vector_ids;
                row.pending_embedding_fingerprint = pending_embedding_fingerprint;
                row.pending_content_hash = null;
                row.pending_revision_id = null;
                row.pending_metadata_hash = null;
                if (hasPendingRebuildId) row.pending_rebuild_id = pending_rebuild_id;
              }
              if (s.includes("classification_status = 'pending'")) resetClassification(row);
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          const [content, tags, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.content = content;
            row.tags = tags;
            row.vector_ids = vector_ids;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags")) {
          const [content, tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content")) {
          const [content, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.content = content;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content ||")) {
          const [addition, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes("rolled-up")) tags.push("rolled-up");
            row.tags = JSON.stringify(tags);
            row.content = row.content + addition;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]'")) {
          const [tag, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes(tag)) tags.push(tag);
            row.tags = JSON.stringify(tags);
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_wins = contradiction_wins + 1")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_wins = (row.contradiction_wins ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_losses = contradiction_losses + 1")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_losses = (row.contradiction_losses ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET recall_count")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.recall_count = (row.recall_count ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET importance_score = ?, classification_confidence")) {
          const [
            importance_score, classification_confidence, classification_version, classified_at, id,
          ] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            Object.assign(row, {
              importance_score,
              classification_confidence,
              classification_status: "succeeded",
              classification_error: null,
              classification_attempts: 1,
              classification_next_attempt_at: null,
              classification_started_at: null,
              classification_version,
              classified_at,
            });
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET importance_score")) {
          const [score, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.importance_score = score;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_parent_units SET active_version_id = NULL")) {
          const [updated_at, ...ids] = args;
          const half = Math.floor(ids.length / 2);
          const deletingIds = new Set(ids.slice(0, half).map(String));
          const affectedVersionIds = new Set(
            db.parentVersionClaims
              .filter((claim: any) => deletingIds.has(String(claim.memory_id)))
              .map((claim: any) => String(claim.parent_version_id))
          );
          let changes = 0;
          for (const unit of db.parentUnits) {
            if (!affectedVersionIds.has(String(unit.active_version_id))) continue;
            const hasSurvivingClaim = db.parentVersionClaims.some((claim: any) =>
              String(claim.parent_version_id) === String(unit.active_version_id) &&
              !deletingIds.has(String(claim.memory_id))
            );
            if (hasSurvivingClaim) continue;
            unit.active_version_id = null;
            unit.updated_at = updated_at;
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("DELETE FROM sb_parent_versions")) {
          const half = Math.floor(args.length / 2);
          const deletingIds = new Set(args.slice(0, half).map(String));
          const before = db.parentVersions.length;
          db.parentVersions = db.parentVersions.filter((version: any) => {
            const linkedDeleting = db.parentVersionClaims.some((claim: any) =>
              String(claim.parent_version_id) === String(version.version_id) &&
              deletingIds.has(String(claim.memory_id))
            );
            if (!linkedDeleting) return true;
            const hasSurvivingClaim = db.parentVersionClaims.some((claim: any) =>
              String(claim.parent_version_id) === String(version.version_id) &&
              !deletingIds.has(String(claim.memory_id))
            );
            return hasSurvivingClaim;
          });
          return { meta: { changes: before - db.parentVersions.length } };
        }
        if (s.startsWith("DELETE FROM sb_parent_version_claims")) {
          const ids = new Set(args.map(String));
          const before = db.parentVersionClaims.length;
          db.parentVersionClaims = db.parentVersionClaims.filter((claim: any) => !ids.has(String(claim.memory_id)));
          return { meta: { changes: before - db.parentVersionClaims.length } };
        }
        if (s.startsWith("DELETE FROM sb_parent_units")) {
          const parentIdsWithVersions = new Set(db.parentVersions.map((version: any) => String(version.parent_id)));
          const before = db.parentUnits.length;
          db.parentUnits = db.parentUnits.filter((unit: any) =>
            unit.active_version_id != null || parentIdsWithVersions.has(String(unit.parent_id))
          );
          return { meta: { changes: before - db.parentUnits.length } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id")) {
          const ids = new Set(args.map(String));
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => !ids.has(String(e.id)));
          return { meta: { changes: before - db.entries.length } };
        }
        return { meta: {} };
      },
      async first() {
        db.statementCount += 1;
        if (s.includes("SELECT * FROM sb_memory_mutations WHERE source_channel = ?")) {
          const [source_channel, operation, idempotency_key] = args;
          return db.memoryMutations.find((row: any) =>
            row.source_channel === source_channel &&
            row.operation === operation &&
            row.idempotency_key === idempotency_key
          ) ?? null;
        }
        if (s.includes("SELECT * FROM sb_memory_mutations WHERE mutation_id = ?")) {
          return db.memoryMutations.find((row: any) => row.mutation_id === args[0]) ?? null;
        }
        if (s === "SELECT content, content_hash FROM entries WHERE id = ?") {
          const row = db.entries.find((entry: any) => entry.id === args[0]);
          return row ? { content: row.content, content_hash: row.content_hash ?? null } : null;
        }
        if (s.includes("SELECT content_hash") && s.includes("FROM sb_claim_vectors")) {
          const [claimId, fingerprint] = args.map(String);
          const row = db.claimVectors.find((item: any) =>
            String(item.claim_id) === claimId &&
            String(item.embedding_fingerprint) === fingerprint
          );
          return row ? { content_hash: row.content_hash } : null;
        }
        if (
          s.includes("SELECT pv.parent_id AS parent_id") &&
          s.includes("JOIN sb_parent_version_claims pvc")
        ) {
          const entryId = String(args[0]);
          const rows = db.memories
            .filter((memory: any) => String(memory.entry_id) === entryId)
            .flatMap((memory: any) =>
              db.parentVersionClaims
                .filter((claim: any) => claim.memory_id === memory.id)
                .map((claim: any) => {
                  const version = db.parentVersions.find((item: any) => item.version_id === claim.parent_version_id);
                  return version ? { version } : null;
                })
                .filter(Boolean) as { version: any }[]
            )
            .sort((a: any, b: any) =>
              (["active", "active_degraded"].includes(String(b.version.state)) ? 1 : 0) -
                (["active", "active_degraded"].includes(String(a.version.state)) ? 1 : 0) ||
              Number(b.version.version_number ?? 0) - Number(a.version.version_number ?? 0)
            );
          return rows[0] ? { parent_id: rows[0].version.parent_id } : null;
        }
        if (
          s.includes("SELECT pv.parent_id AS parent_id") &&
          s.includes("JOIN sb_parent_versions pv ON pv.version_id = m.parent_version_id")
        ) {
          const entryId = String(args[0]);
          const rows = db.memories
            .filter((memory: any) => String(memory.entry_id) === entryId && memory.parent_version_id != null)
            .map((memory: any) => {
              const version = db.parentVersions.find((item: any) => item.version_id === memory.parent_version_id);
              return version ? { version } : null;
            })
            .filter(Boolean)
            .sort((a: any, b: any) =>
              (["active", "active_degraded"].includes(String((b as any).version.state)) ? 1 : 0) -
                (["active", "active_degraded"].includes(String((a as any).version.state)) ? 1 : 0) ||
              Number((b as any).version.version_number ?? 0) - Number((a as any).version.version_number ?? 0)
            ) as { version: any }[];
          return rows[0] ? { parent_id: rows[0].version.parent_id } : null;
        }
        if (s.includes("COALESCE(MAX(version_number), 0) AS version_number")) {
          const parentId = String(args[0]);
          const maxVersion = Math.max(
            0,
            ...db.parentVersions
              .filter((version: any) => String(version.parent_id) === parentId)
              .map((version: any) => Number(version.version_number ?? 0))
          );
          return { version_number: maxVersion };
        }
        if (
          s.includes("SELECT pv.source_observation_id AS source_observation_id") &&
          s.includes("JOIN sb_parent_units pu")
        ) {
          const parentId = String(args[0]);
          const rows = db.parentVersions
            .filter((version: any) =>
              String(version.parent_id) === parentId &&
              ["active", "active_degraded"].includes(String(version.state)) &&
              db.parentUnits.some((unit: any) =>
                String(unit.parent_id) === parentId &&
                String(unit.active_version_id) === String(version.version_id)
              )
            )
            .sort((a: any, b: any) => Number(b.version_number ?? 0) - Number(a.version_number ?? 0));
          return rows[0] ? { source_observation_id: rows[0].source_observation_id ?? null } : null;
        }
        if (
          s.includes("memory_count") &&
          s.includes("FROM sb_parent_version_claims pvc")
        ) {
          const versionId = String(args[0]);
          const memoryIds = new Set(
            db.parentVersionClaims
              .filter((claim: any) =>
                claim.parent_version_id === versionId &&
                ["supports", "derived_from"].includes(String(claim.relation ?? "supports"))
              )
              .map((claim: any) => String(claim.memory_id))
          );
          const memories = db.memories.filter((memory: any) =>
            memoryIds.has(String(memory.id)) &&
            ["supported", "confirmed", "contested"].includes(String(memory.claim_status ?? "supported")) &&
            memory.invalid_at == null &&
            memory.expired_at == null
          );
          const sourced = memories.filter((memory: any) =>
            db.memorySources.some((source: any) => source.memory_id === memory.id)
          );
          return {
            memory_count: memories.length,
            sourced_memory_count: sourced.length,
          };
        }
        if (s.includes("SELECT id, pending_fingerprint AS pendingFingerprint, state") && s.includes("FROM sb_vector_rebuilds")) {
          const row = db.vectorRebuilds.find((item: any) =>
            item.slot === "current" && ["queued", "building", "ready"].includes(item.state)
          );
          return row
            ? {
                id: row.id,
                pendingFingerprint: row.pending_fingerprint,
                state: row.state,
              }
            : null;
        }
        if (
          s.includes("SELECT old_memory_id, new_memory_id") &&
          s.includes("FROM sb_conflict_cases") &&
          s.includes("WHERE id = ?")
        ) {
          const id = String(args[0]);
          const row = db.conflictCases.find((conflict: any) => conflict.id === id);
          return row
            ? {
                old_memory_id: row.old_memory_id,
                new_memory_id: row.new_memory_id,
              }
            : null;
        }
        if (s.includes("SELECT id, state, active_fingerprint") && s.includes("FROM sb_vector_rebuilds")) {
          const pendingFingerprint = args.length ? String(args[0]) : null;
          const row = db.vectorRebuilds.find((item: any) =>
            item.slot === "current" &&
            !["active", "cancelled", "failed"].includes(item.state) &&
            (!pendingFingerprint || item.pending_fingerprint === pendingFingerprint)
          );
          return row ? { ...row } : null;
        }
        if (s.toLowerCase().includes("select 1 as referenced") && s.includes("json_each")) {
          const [activeId, pendingId, claimId] = args.map(String);
          const entryReferenced = db.entries.some((entry: any) =>
            parseJsonArray(entry.vector_ids).includes(activeId) ||
            parseJsonArray(entry.pending_vector_ids).includes(pendingId)
          );
          const claimReferenced = db.claimVectors.some((mapping: any) =>
            parseJsonArray(mapping.vector_ids_json).includes(claimId)
          );
          const referenced = entryReferenced || claimReferenced;
          return referenced ? { referenced: 1 } : null;
        }
        if (s.includes("SELECT value FROM sb_app_settings WHERE key = ?")) {
          const row = db.appSettings[String(args[0])];
          return row ? { value: row.value } : null;
        }
        if (s.includes("SELECT event_hash FROM sb_audit_events")) {
          const latest = [...db.auditEvents].sort((a: any, b: any) =>
            Number(b.occurred_at ?? 0) - Number(a.occurred_at ?? 0)
          )[0];
          return latest ? { event_hash: latest.event_hash } : null;
        }
        if (s.includes("memory_sources_missing_memory") && s.includes("parent_versions_missing_parent")) {
          const has = (rows: any[], key: string, value: any) =>
            rows.some((row: any) => String(row[key]) === String(value));
          return {
            memory_sources_missing_memory: db.memorySources.filter((source: any) => !has(db.memories, "id", source.memory_id)).length,
            memory_sources_missing_observation: db.memorySources.filter((source: any) => !has(db.observations, "id", source.observation_id)).length,
            parent_versions_missing_parent: db.parentVersions.filter((version: any) => !has(db.parentUnits, "parent_id", version.parent_id)).length,
            parent_units_missing_active_version: db.parentUnits.filter((unit: any) =>
              unit.active_version_id != null && !has(db.parentVersions, "version_id", unit.active_version_id)
            ).length,
            memories_missing_parent_version: db.memories.filter((memory: any) =>
              memory.parent_version_id != null && !has(db.parentVersions, "version_id", memory.parent_version_id)
            ).length,
            parent_version_claims_missing_parent_version: db.parentVersionClaims.filter((claim: any) =>
              !has(db.parentVersions, "version_id", claim.parent_version_id)
            ).length,
            parent_version_claims_missing_memory: db.parentVersionClaims.filter((claim: any) =>
              !has(db.memories, "id", claim.memory_id)
            ).length,
            memory_entities_missing_memory: db.memoryEntities.filter((link: any) => !has(db.memories, "id", link.memory_id)).length,
            memory_entities_missing_entity: db.memoryEntities.filter((link: any) => !has(db.entities, "id", link.entity_id)).length,
            entity_relations_missing_from_entity: db.entityRelations.filter((relation: any) => !has(db.entities, "id", relation.from_entity_id)).length,
            entity_relations_missing_to_entity: db.entityRelations.filter((relation: any) => !has(db.entities, "id", relation.to_entity_id)).length,
            entity_relations_missing_memory: db.entityRelations.filter((relation: any) =>
              relation.memory_id != null && !has(db.memories, "id", relation.memory_id)
            ).length,
            entity_relations_missing_observation: db.entityRelations.filter((relation: any) =>
              relation.observation_id != null && !has(db.observations, "id", relation.observation_id)
            ).length,
            fact_sources_missing_relation: db.factSources.filter((source: any) => !has(db.entityRelations, "id", source.relation_id)).length,
            fact_sources_missing_memory: db.factSources.filter((source: any) =>
              source.memory_id != null && !has(db.memories, "id", source.memory_id)
            ).length,
            fact_sources_missing_observation: db.factSources.filter((source: any) =>
              source.observation_id != null && !has(db.observations, "id", source.observation_id)
            ).length,
            memory_relations_missing_from_entry: db.relations.filter((relation: any) => !has(db.entries, "id", relation.from_memory_id)).length,
            memory_relations_missing_to_entry: db.relations.filter((relation: any) => !has(db.entries, "id", relation.to_memory_id)).length,
            revisions_missing_entry: db.revisions.filter((revision: any) => !has(db.entries, "id", revision.memory_id)).length,
            memory_mutations_missing_entry: db.memoryMutations.filter((mutation: any) =>
              !has(db.entries, "id", mutation.entry_id)
            ).length,
            memory_mutations_missing_observation: db.memoryMutations.filter((mutation: any) =>
              mutation.observation_id != null && !has(db.observations, "id", mutation.observation_id)
            ).length,
            memory_mutations_missing_claim: db.memoryMutations.filter((mutation: any) =>
              mutation.claim_id != null && !has(db.memories, "id", mutation.claim_id)
            ).length,
            merge_candidates_missing_source: db.mergeCandidates.filter((candidate: any) => !has(db.entries, "id", candidate.source_memory_id)).length,
            merge_candidates_missing_target: db.mergeCandidates.filter((candidate: any) => !has(db.entries, "id", candidate.target_memory_id)).length,
            conflict_cases_missing_old: db.conflictCases.filter((conflict: any) => !has(db.entries, "id", conflict.old_memory_id)).length,
            conflict_cases_missing_new: db.conflictCases.filter((conflict: any) => !has(db.entries, "id", conflict.new_memory_id)).length,
          };
        }
        if (s.includes("SELECT id, vector_ids, pending_vector_ids, pending_rebuild_id FROM entries WHERE id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row
            ? {
                id: row.id,
                vector_ids: row.vector_ids ?? "[]",
                pending_vector_ids: row.pending_vector_ids ?? null,
                pending_rebuild_id: row.pending_rebuild_id ?? null,
              }
            : null;
        }
        if (s.includes("SELECT content, tags, source, pending_vector_ids, pending_rebuild_id FROM entries WHERE id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row
            ? {
                content: row.content,
                tags: row.tags ?? "[]",
                source: row.source ?? "api",
                pending_vector_ids: row.pending_vector_ids ?? null,
                pending_rebuild_id: row.pending_rebuild_id ?? null,
              }
            : null;
        }
        if (s.includes("SELECT vector_ids FROM entries WHERE id")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { vector_ids: row.vector_ids } : null;
        }
        if (s.includes("COUNT(*) as count") && s.includes("AVG(importance_score)")) {
          const count = db.entries.length;
          const scored = db.entries.filter((e: any) => typeof e.importance_score === "number");
          const avg_importance = scored.length > 0
            ? scored.reduce((sum: number, e: any) => sum + e.importance_score, 0) / scored.length
            : null;
          const cutoff = args.length > 0 ? Number(args[0]) : undefined;
          const unvectorized = cutoff !== undefined
            ? db.entries.filter((e: any) =>
                e.vector_ids === '[]' &&
                e.created_at < cutoff &&
                (!s.includes("tags NOT LIKE") || !String(e.tags ?? "[]").includes('"status:deprecated"'))
              ).length
            : 0;
          const unclassified = db.entries.filter((e: any) => e.classification_status !== "succeeded").length;
          return { count, avg_importance, unvectorized, unclassified };
        }
        if (
          s.includes("COUNT(*) as count") &&
          s.includes("pending_rebuild_id = ?") &&
          s.includes("pending_vector_ids != '[]'") &&
          s.includes("pending_content_hash IS NULL")
        ) {
          const rebuildId = String(args[0]);
          const count = db.entries.filter((e: any) =>
            e.pending_rebuild_id === rebuildId &&
            e.pending_vector_ids != null &&
            e.pending_vector_ids !== "[]" &&
            !String(e.tags ?? "[]").includes('"status:deprecated"') &&
            (
              e.pending_content_hash == null ||
              e.content_hash == null ||
              e.pending_revision_id == null ||
              e.pending_metadata_hash == null ||
              e.metadata_hash == null ||
              e.pending_content_hash !== e.content_hash ||
              e.pending_metadata_hash !== e.metadata_hash
            )
          ).length;
          return { count };
        }
        if (
          s.includes("COUNT(*) as count") &&
          s.includes("pending_rebuild_id IS NULL") &&
          s.includes("pending_rebuild_id != ?")
        ) {
          const rebuildId = String(args[0]);
          const count = db.entries.filter((e: any) =>
            !String(e.tags ?? "[]").includes('"status:deprecated"') &&
            (e.pending_rebuild_id == null || e.pending_rebuild_id !== rebuildId)
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("pending_embedding_fingerprint = ?") && s.includes("pending_content_hash != content_hash")) {
          const pendingFingerprint = String(args[0]);
          const rebuildId = s.includes("pending_rebuild_id = ?") ? String(args[1]) : null;
          const count = db.entries.filter((e: any) =>
            e.pending_embedding_fingerprint === pendingFingerprint &&
            (!rebuildId || e.pending_rebuild_id === rebuildId) &&
            e.pending_vector_ids != null &&
            e.pending_vector_ids !== "[]" &&
            (
              e.pending_content_hash == null ||
              e.pending_revision_id == null ||
              e.content_hash == null ||
              e.metadata_hash == null ||
              e.pending_metadata_hash == null ||
              e.pending_content_hash !== e.content_hash ||
              e.pending_metadata_hash !== e.metadata_hash
            )
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("pending_embedding_fingerprint = ?") && s.includes("content_hash = pending_content_hash")) {
          const pendingFingerprint = String(args[0]);
          const rebuildId = s.includes("pending_rebuild_id = ?") ? String(args[1]) : null;
          const count = db.entries.filter((e: any) =>
            e.pending_embedding_fingerprint === pendingFingerprint &&
            (!rebuildId || e.pending_rebuild_id === rebuildId) &&
            e.pending_vector_ids != null &&
            e.pending_vector_ids !== "[]" &&
            e.pending_content_hash != null &&
            e.pending_revision_id != null &&
            e.pending_metadata_hash != null &&
            e.metadata_hash != null &&
            e.content_hash === e.pending_content_hash &&
            e.metadata_hash === e.pending_metadata_hash
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("pending_embedding_fingerprint = ?") && s.includes("pending_vector_ids IS NOT NULL")) {
          const pendingFingerprint = String(args[0]);
          const count = db.entries.filter((e: any) =>
            e.pending_embedding_fingerprint === pendingFingerprint &&
            e.pending_vector_ids != null
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("pending_vector_ids = '[]'") && s.includes("pending_embedding_fingerprint = ?")) {
          const pendingFingerprint = String(args[0]);
          const hasRebuildId = s.includes("pending_rebuild_id = ?");
          const rebuildId = hasRebuildId ? String(args[1]) : null;
          const cutoff = s.includes("created_at <") ? Number(hasRebuildId ? args[2] : args[1]) : null;
          const count = db.entries.filter((e: any) =>
            e.pending_vector_ids === '[]' &&
            e.pending_embedding_fingerprint === pendingFingerprint &&
            (!rebuildId || e.pending_rebuild_id === rebuildId) &&
            (cutoff == null || e.created_at < cutoff) &&
            (!s.includes("tags NOT LIKE") || !String(e.tags ?? "[]").includes('"status:deprecated"'))
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("vector_ids = '[]'") && s.includes("created_at <")) {
          const cutoff = Number(args[0]);
          const count = db.entries.filter((e: any) =>
            e.vector_ids === '[]' &&
            e.created_at < cutoff &&
            (!s.includes("tags NOT LIKE") || !String(e.tags ?? "[]").includes('"status:deprecated"'))
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("vector_ids IS NOT NULL") && s.includes("vector_ids != '[]'")) {
          const count = db.entries.filter((e: any) =>
            e.vector_ids != null &&
            e.vector_ids !== "[]" &&
            (!s.includes("tags NOT LIKE") || !String(e.tags ?? "[]").includes('"status:deprecated"'))
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`)) {
          const count = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:')).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("classification_status = 'terminal_error'")) {
          const count = db.entries.filter((e: any) => e.classification_status === "terminal_error").length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("FROM sb_observations")) {
          const maxAttempts = Number(args[0] ?? 3);
          const now = Number(args[1] ?? Date.now());
          const leaseCutoff = Number(args[2] ?? 0);
          const currentVersion = Number(args[3] ?? 1);
          let rows = [...db.observations];
          if (s.includes("OR COALESCE(extraction_version, 0) < ?")) {
            rows = rows.filter((observation: any) => {
              if (Number(observation.extraction_attempts ?? 0) >= maxAttempts) return false;
              const status = observation.extraction_status ?? "pending";
              return status === "pending" ||
                (
                  status === "retryable_error" &&
                  Number(observation.next_attempt_at ?? 0) <= now
                ) ||
                (
                  status === "processing" &&
                  Number(observation.processing_started_at ?? 0) <= leaseCutoff
                ) ||
                (
                  status === "fallback" &&
                  Number(observation.needs_reprocess ?? 0) === 1
                ) ||
                (
                  status === "partial_error" &&
                  Number(observation.needs_reprocess ?? 0) === 1
                ) ||
                Number(observation.extraction_version ?? 0) < currentVersion;
            });
          } else if (s.includes("extraction_status = 'pending'") && s.includes("NOT EXISTS")) {
            rows = rows.filter((observation: any) =>
              (observation.extraction_status ?? "pending") === "pending" &&
              Number(observation.extraction_attempts ?? 0) === 0 &&
              !db.memorySources.some((source: any) => source.observation_id === observation.id)
            );
          } else if (
            s.includes("extraction_status = 'fallback'") &&
            s.includes("needs_reprocess")
          ) {
            rows = rows.filter((observation: any) =>
              observation.extraction_status === "fallback" &&
              Number(observation.needs_reprocess ?? 0) === 1 &&
              Number(observation.extraction_attempts ?? 0) < maxAttempts
            );
          } else if (
            s.includes("extraction_status = 'partial_error'") &&
            s.includes("needs_reprocess")
          ) {
            rows = rows.filter((observation: any) =>
              observation.extraction_status === "partial_error" &&
              Number(observation.needs_reprocess ?? 0) === 1 &&
              Number(observation.extraction_attempts ?? 0) < maxAttempts
            );
          } else if (
            s.includes("extraction_status = 'retryable_error'") &&
            s.includes("next_attempt_at, 0) <=")
          ) {
            rows = rows.filter((observation: any) =>
              observation.extraction_status === "retryable_error" &&
              Number(observation.extraction_attempts ?? 0) < maxAttempts &&
              Number(observation.next_attempt_at ?? 0) <= now
            );
          } else if (
            s.includes("extraction_status = 'processing'") &&
            s.includes("processing_started_at, 0) <=")
          ) {
            rows = rows.filter((observation: any) =>
              observation.extraction_status === "processing" &&
              Number(observation.extraction_attempts ?? 0) < maxAttempts &&
              Number(observation.processing_started_at ?? 0) <= Number(args[1] ?? leaseCutoff)
            );
          } else if (s.includes("extraction_status = 'terminal_error'")) {
            rows = rows.filter((observation: any) => observation.extraction_status === "terminal_error");
          } else if (
            s.includes("extraction_status = 'retryable_error'") &&
            s.includes("next_attempt_at, 0) >")
          ) {
            rows = rows.filter((observation: any) =>
              observation.extraction_status === "retryable_error" &&
              Number(observation.extraction_attempts ?? 0) < maxAttempts &&
              Number(observation.next_attempt_at ?? 0) > Number(args[1] ?? now)
            );
          } else {
            rows = rows.filter((observation: any) => {
              if (Number(observation.extraction_attempts ?? 0) >= maxAttempts) return false;
              const status = observation.extraction_status ?? "pending";
              return status === "pending" ||
                (
                  status === "retryable_error" &&
                  Number(observation.next_attempt_at ?? 0) <= now
                ) ||
                (
                  status === "processing" &&
                  Number(observation.processing_started_at ?? 0) <= leaseCutoff
                ) ||
                (
                  status === "fallback" &&
                  Number(observation.needs_reprocess ?? 0) === 1
                ) ||
                (
                  status === "partial_error" &&
                  Number(observation.needs_reprocess ?? 0) === 1
                ) ||
                Number(observation.extraction_version ?? 0) < currentVersion;
            });
          }
          return { count: rows.length };
        }
        if (s.includes("COUNT(*) as count") && s.includes("classification_status = 'retryable_error'") && s.includes("classification_next_attempt_at >")) {
          const now = Number(args[1] ?? s.match(/classification_next_attempt_at > (\d+)/)?.[1] ?? 0);
          const count = db.entries.filter((e: any) =>
            e.classification_status === "retryable_error" &&
            Number(e.classification_attempts ?? 0) < 3 &&
            Number(e.classification_next_attempt_at ?? 0) > now
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("classification_status IS NULL") && s.includes("classification_started_at")) {
          const now = Number(s.match(/classification_next_attempt_at, 0\) <= (\d+)/)?.[1] ?? 0);
          const leaseCutoff = Number(s.match(/classification_started_at, 0\) <= (\d+)/)?.[1] ?? 0);
          const versionMatch = s.match(/classification_version, 0\) < (\d+)/);
          const currentVersion = versionMatch ? Number(versionMatch[1]) : 2;
          const count = db.entries.filter((e: any) => {
            if (String(e.tags ?? "[]").includes('"status:deprecated"')) return false;
            const status = e.classification_status;
            if (status === "succeeded" && Number(e.classification_version ?? 0) < currentVersion) return true;
            if (Number(e.classification_attempts ?? 0) >= 3) return false;
            return status == null || status === "pending" ||
              (status === "retryable_error" && Number(e.classification_next_attempt_at ?? 0) <= now) ||
              (status === "processing" && Number(e.classification_started_at ?? 0) <= leaseCutoff);
          }).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count")) {
          return { count: db.entries.length };
        }
        if (
          (s.includes("SELECT tags FROM entries") || s.includes("SELECT tags, source")) &&
          s.includes("classification_started_at = ?")
        ) {
          const [id, content, startedAt] = args;
          const row = db.entries.find((e: any) =>
            e.id === id && e.content === content && e.classification_status === "processing" &&
            e.classification_started_at === startedAt
          );
          return row ? {
            tags: row.tags,
            source: row.source ?? "api",
            pending_vector_ids: row.pending_vector_ids ?? null,
            pending_rebuild_id: row.pending_rebuild_id ?? null,
          } : null;
        }
        if (s.includes("SELECT classification_attempts FROM entries") && s.includes("classification_started_at = ?")) {
          const [id, content, startedAt] = args;
          const row = db.entries.find((e: any) =>
            e.id === id && e.content === content && e.classification_status === "processing" &&
            e.classification_started_at === startedAt
          );
          return row ? { classification_attempts: row.classification_attempts } : null;
        }
        if (s.includes("FROM sb_entities WHERE name_normalized = ?")) {
          const key = String(args[0]);
          const row = db.entities.find((e: any) => e.name_normalized === key);
          return row ?? null;
        }
        if (s.includes("SELECT id FROM sb_fact_sources")) {
          const [relationId, memoryId, observationId] = args.map(String);
          const row = db.factSources.find((source: any) =>
            String(source.relation_id) === relationId &&
            String(source.memory_id ?? "") === memoryId &&
            String(source.observation_id ?? "") === observationId
          );
          return row ? { id: row.id } : null;
        }
        if (s.includes("COUNT(*) as total") && s.includes("FROM sb_app_settings")) {
          const fingerprint = String(args[0] ?? "");
          const raw = db.appSettings.model_settings?.value;
          if (!raw) return { total: 0, matching: 0 };
          let matching = 0;
          try {
            const parsed = JSON.parse(raw);
            matching = String(parsed.embeddingFingerprint ?? "") === fingerprint ? 1 : 0;
          } catch {
            matching = 0;
          }
          return { total: 1, matching };
        }
        if (s.includes("SELECT id FROM sb_entity_relations") && s.includes("from_entity_id = ?")) {
          const [fromEntityId, toEntityId, relationType, factHash, factKey] = args.map(String);
          const row = db.entityRelations.find((relation: any) =>
            String(relation.from_entity_id) === fromEntityId &&
            String(relation.to_entity_id) === toEntityId &&
            String(relation.relation_type) === relationType &&
            (
              String(relation.fact_hash ?? "") === factHash ||
              (!relation.fact_hash && String(relation.fact ?? "").trim().toLowerCase() === factKey)
            ) &&
            relation.invalid_at == null &&
            relation.expired_at == null
          );
          return row ? { id: row.id } : null;
        }
        if (s.includes("FROM sb_memories") && s.includes("entry_id = ? OR content_hash = ?")) {
          const entryId = String(args[0]);
          const contentHash = String(args[1]);
          const row = db.memories
            .filter((memory: any) =>
              memory.invalid_at == null &&
              memory.expired_at == null &&
              (memory.entry_id === entryId || memory.content_hash === contentHash)
            )
            .sort((a: any, b: any) => {
              const ar = a.entry_id === entryId ? 0 : 1;
              const br = b.entry_id === entryId ? 0 : 1;
              return ar - br || Number(a.created_at ?? 0) - Number(b.created_at ?? 0);
            })[0];
          return row ? { id: row.id, confidence: row.confidence ?? null } : null;
        }
        if (s.includes("FROM sb_observations") && s.includes("WHERE id = ?")) {
          const id = String(args[0]);
          const row = db.observations.find((observation: any) => observation.id === id);
          if (!row) return null;
          if (s.includes("extraction_attempts") && s.includes("processing_started_at")) {
            return {
              extraction_attempts: row.extraction_attempts ?? 0,
              processing_started_at: row.processing_started_at ?? null,
            };
          }
          return row;
        }
        if (s.includes("SELECT id FROM entries") && s.includes("content_hash = ?")) {
          const hash = String(args[0]);
          const row = db.entries.find((e: any) =>
            e.content_hash === hash && !String(e.tags ?? "[]").includes('"status:deprecated"')
          );
          return row ? { id: row.id } : null;
        }
        if (
          s.includes("SELECT id FROM entries") &&
          s.includes("content = ?") &&
          !s.includes("content_hash") &&
          !s.includes("AND content = ?")
        ) {
          const content = String(args[0]);
          const row = db.entries.find((e: any) =>
            e.content === content && !String(e.tags ?? "[]").includes('"status:deprecated"')
          );
          return row ? { id: row.id } : null;
        }
        if (s.includes("WHERE id") && !s.includes("json_each")) {
          return db.entries.find((e: any) => e.id === args[0]) ?? null;
        }
        if (s.includes("WHERE tags LIKE") && s.includes("created_at >")) {
          // Cooldown check: find entries matching arg LIKE patterns + any hardcoded tags in SQL
          const likePatterns: string[] = args.slice(0, -1).map((a: any) => String(a));
          const cutoff = args[args.length - 1] as number;
          // Extract hardcoded tags from SQL (e.g. '%"synthesized"%')
          const hardcoded = [...s.matchAll(/'%"(\w+)"%'/g)].map(m => m[1]);
          const match = db.entries.find((e: any) => {
            if (e.created_at <= cutoff) return false;
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!hardcoded.every(t => tags.includes(t))) return false;
            return likePatterns.every((p: string) => {
              const tag = p.replace(/%"/g, "").replace(/"%/g, "");
              return tags.includes(tag);
            });
          });
          return match ? { id: match.id } : null;
        }
        return null;
      },
      async all() {
        db.statementCount += 1;
        if (
          s.includes("SELECT cv.claim_id, cv.vector_ids_json") &&
          s.includes("FROM sb_claim_vectors cv")
        ) {
          const fingerprint = String(args[0]);
          const claimIds = new Set(args.slice(1).map(String));
          return {
            results: db.claimVectors.filter((mapping: any) => {
              if (
                String(mapping.embedding_fingerprint) !== fingerprint ||
                !claimIds.has(String(mapping.claim_id))
              ) return false;
              const memory = db.memories.find((candidate: any) =>
                String(candidate.id) === String(mapping.claim_id)
              );
              return Boolean(memory) && memory.content_hash === mapping.content_hash;
            }),
          };
        }
        if (
          s.includes("SELECT id, name, name_normalized, entity_type, aliases_json") &&
          s.includes("FROM sb_entities") &&
          s.includes("ORDER BY mention_count DESC")
        ) {
          const limit = Number(args[0] ?? 1000);
          return {
            results: [...db.entities]
              .sort((a: any, b: any) =>
                Number(b.mention_count ?? 0) - Number(a.mention_count ?? 0) ||
                Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0)
              )
              .slice(0, limit),
          };
        }
        if (
          s.includes("SELECT id, from_entity_id, to_entity_id, relation_type, fact,") &&
          s.includes("FROM sb_entity_relations") &&
          s.includes("WHERE from_entity_id = ?")
        ) {
          const [fromEntityId, relationType] = args.map(String);
          return {
            results: db.entityRelations
              .filter((relation: any) =>
                String(relation.from_entity_id) === fromEntityId &&
                String(relation.relation_type) === relationType &&
                relation.invalid_at == null && relation.expired_at == null
              )
              .map((relation: any) => {
                const activeSources = db.factSources
                  .filter((source: any) => source.relation_id === relation.id && source.memory_id)
                  .filter((source: any) => {
                    const memory = db.memories.find((item: any) => item.id === source.memory_id);
                    return memory && memory.invalid_at == null && memory.expired_at == null;
                  });
                return {
                  ...relation,
                  memory_id: activeSources.at(-1)?.memory_id ?? relation.memory_id,
                  evidence_count: db.factSources.some((source: any) => source.relation_id === relation.id)
                    ? activeSources.length
                    : relation.evidence_count,
                };
              })
              .sort((a: any, b: any) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
              .slice(0, 20),
          };
        }
        if (
          s.includes("COALESCE(pv_snapshot.version_id, m.parent_version_id) AS parent_version_id") &&
          s.includes("COALESCE(m.observed_at, m.created_at) AS created_at") &&
          s.includes("LEFT JOIN sb_memory_sources ms")
        ) {
          const lexicalCount = (s.match(/m\.content LIKE \?/g) ?? []).length;
          const semanticMatch = s.match(/m\.id IN \(([^)]*)\)/);
          const semanticCount = semanticMatch
            ? semanticMatch[1].split(",").filter(Boolean).length
            : 0;
          const graphMatches = [...s.matchAll(/m\.entry_id IN \(([^)]*)\)/g)];
          const graphCount = graphMatches.length
            ? graphMatches[0][1].split(",").filter(Boolean).length
            : 0;
          let offset = 0;
          const lexicalPatterns = args.slice(offset, offset + lexicalCount).map(String);
          offset += lexicalCount;
          const semanticIds = new Set(args.slice(offset, offset + semanticCount).map(String));
          offset += semanticCount;
          const graphEntryIds = new Set(args.slice(offset, offset + graphCount).map(String));
          offset += graphCount;
          const hasAfter = s.includes("COALESCE(m.observed_at, m.created_at) >= ?");
          const after = hasAfter ? Number(args[offset++]) : null;
          if (hasAfter && graphMatches.length > 1) offset += graphCount;
          const before = Number(args[offset++]);
          const kind = s.includes("AND m.kind = ?") ? String(args[offset++]) : null;
          const tagPattern = s.includes("COALESCE(e.tags, '[]') LIKE ?")
            ? String(args[offset++])
            : null;
          const vaultId = s.includes("l.vault_id = ?") ? String(args[offset++]) : null;
          const limit = Number(args.at(-1) ?? 50);
          const asOf = activePredicateAsOfFromSql(s);

          const results = db.memories
            .filter((memory: any) => {
              const observedAt = Number(memory.observed_at ?? memory.created_at ?? 0);
              const lexicalMatch = lexicalPatterns.some((pattern: string) =>
                String(memory.content ?? "").toLowerCase().includes(
                  pattern.replace(/^%/, "").replace(/%$/, "").toLowerCase()
                )
              );
              const candidateMatch = lexicalMatch ||
                semanticIds.has(String(memory.id)) ||
                graphEntryIds.has(String(memory.entry_id));
              if (!candidateMatch || observedAt > before) return false;
              if (after != null && observedAt < after && !graphEntryIds.has(String(memory.entry_id))) {
                return false;
              }
              if (kind && String(memory.kind) !== kind) return false;
              if (!memoryPassesActiveParentFilter(db, memory, asOf, true)) return false;
              const entry = db.entries.find((item: any) => String(item.id) === String(memory.entry_id));
              if (tagPattern) {
                const tag = tagPattern.replace(/^%"/, "").replace(/"%$/, "");
                if (!parseJsonArray(entry?.tags).includes(tag)) return false;
              }
              if (vaultId) {
                const links = (db as any).externalLinks ?? [];
                if (!links.some((link: any) =>
                  String(link.entry_id) === String(memory.entry_id) &&
                  link.provider === "obsidian" &&
                  link.object_type === "memory" &&
                  String(link.vault_id) === vaultId
                )) return false;
              }
              return true;
            })
            .sort((left: any, right: any) =>
              Number(right.observed_at ?? right.created_at ?? 0) -
              Number(left.observed_at ?? left.created_at ?? 0)
            )
            .slice(0, limit)
            .map((memory: any) => {
              const entry = db.entries.find((item: any) => String(item.id) === String(memory.entry_id));
              const parentVersionLink = db.parentVersionClaims
                .filter((item: any) =>
                  String(item.memory_id) === String(memory.id) &&
                  String(item.relation ?? "supports") === "supports" &&
                  parentVersionIsEligibleAt(db, item.parent_version_id, asOf)
                )
                .map((item: any) => db.parentVersions.find((version: any) =>
                  String(version.version_id) === String(item.parent_version_id)
                ))
                .filter(Boolean)
                .sort((left: any, right: any) =>
                  Number(right.version_number ?? 0) - Number(left.version_number ?? 0)
                )[0];
              const firstSource = db.memorySources
                .filter((source: any) => String(source.memory_id) === String(memory.id))
                .sort((left: any, right: any) =>
                  Number(left.created_at ?? 0) - Number(right.created_at ?? 0) ||
                  String(left.id).localeCompare(String(right.id))
                )[0];
              const observation = db.observations.find((item: any) =>
                String(item.id) === String(firstSource?.observation_id)
              );
              return {
                id: memory.id,
                entry_id: memory.entry_id,
                parent_version_id: parentVersionLink?.version_id ?? memory.parent_version_id ?? null,
                content: memory.content,
                content_hash: memory.content_hash,
                kind: memory.kind ?? "semantic",
                importance: memory.importance ?? 0,
                confidence: memory.confidence ?? 0,
                claim_status: memory.claim_status ?? "supported",
                created_at: memory.observed_at ?? memory.created_at ?? 0,
                tags: parentVersionLink?.metadata_snapshot_hash
                  ? parentVersionLink.tags_snapshot_json ?? "[]"
                  : entry?.tags ?? "[]",
                source: parentVersionLink?.metadata_snapshot_hash
                  ? parentVersionLink.source_snapshot ?? observation?.source_channel ?? observation?.source ?? "claim"
                  : entry?.source ?? observation?.source_channel ?? observation?.source ?? "claim",
              };
            });
          return { results };
        }
        if (
          s.includes("SELECT m.id, m.entry_id, m.content, m.claim_status") &&
          s.includes("FROM sb_memories m") &&
          (s.includes("WHERE m.entry_id IN") || s.includes("WHERE m.id IN"))
        ) {
          const wanted = new Set(args.map(String));
          const byEntry = s.includes("WHERE m.entry_id IN");
          const asOf = activePredicateAsOfFromSql(s);
          return {
            results: db.memories
              .filter((memory: any) => wanted.has(String(byEntry ? memory.entry_id : memory.id)))
              .filter((memory: any) => {
                const entry = db.entries.find((item: any) => String(item.id) === String(memory.entry_id));
                return entry &&
                  entry.content_hash != null &&
                  memory.content_hash != null &&
                  String(entry.content_hash) === String(memory.content_hash) &&
                  memoryPassesActiveParentFilter(db, memory, asOf, true);
              })
              .sort((a: any, b: any) =>
                Number(a.created_at ?? 0) - Number(b.created_at ?? 0) ||
                String(a.id).localeCompare(String(b.id))
              )
              .map((memory: any) => ({
                id: memory.id,
                entry_id: memory.entry_id,
                content: memory.content,
                claim_status: memory.claim_status ?? "supported",
              })),
          };
        }
        if (
          s.includes("SELECT id, old_claim_id, new_claim_id, reason") &&
          s.includes("FROM sb_conflict_cases") &&
          s.includes("state = 'pending'")
        ) {
          const half = Math.floor(args.length / 2);
          const wanted = new Set(args.slice(0, half).map(String));
          return {
            results: db.conflictCases
              .filter((conflict: any) =>
                conflict.state === "pending" &&
                conflict.old_claim_id != null &&
                conflict.new_claim_id != null &&
                (wanted.has(String(conflict.old_claim_id)) || wanted.has(String(conflict.new_claim_id)))
              )
              .sort((a: any, b: any) =>
                Number(a.created_at ?? 0) - Number(b.created_at ?? 0) ||
                String(a.id).localeCompare(String(b.id))
              )
              .map((conflict: any) => ({
                id: conflict.id,
                old_claim_id: conflict.old_claim_id,
                new_claim_id: conflict.new_claim_id,
                reason: conflict.reason ?? null,
              })),
          };
        }
        if (!s.includes(" LIMIT ") && s.includes("ORDER BY") && !s.includes("json_each")) {
          if (s.includes("FROM sb_scopes")) return { results: [...db.scopes] };
          if (s.includes("FROM sb_parent_units")) return { results: [...db.parentUnits] };
          if (s.includes("FROM sb_parent_versions")) return { results: [...db.parentVersions] };
          if (s.includes("FROM sb_parent_version_claims")) return { results: [...db.parentVersionClaims] };
          if (s.includes("FROM entries")) return { results: [...db.entries] };
          if (s.includes("FROM sb_observations")) return { results: [...db.observations] };
          if (s.includes("FROM sb_memories")) return { results: [...db.memories] };
          if (s.includes("FROM sb_memory_sources")) return { results: [...db.memorySources] };
          if (s.includes("FROM sb_entities")) return { results: [...db.entities] };
          if (s.includes("FROM sb_memory_entities")) return { results: [...db.memoryEntities] };
          if (s.includes("FROM sb_entity_relations")) return { results: [...db.entityRelations] };
          if (s.includes("FROM sb_fact_sources")) return { results: [...db.factSources] };
          if (s.includes("FROM sb_memory_relations")) return { results: [...db.relations] };
          if (s.includes("FROM sb_memory_revisions")) return { results: [...db.revisions] };
          if (s.includes("FROM sb_memory_merge_candidates")) return { results: [...db.mergeCandidates] };
          if (s.includes("FROM sb_conflict_cases")) return { results: [...db.conflictCases] };
          if (s.includes("FROM sb_audit_events")) return { results: [...db.auditEvents] };
        }
        if (s.includes("SELECT id, valid_from, valid_to, reference_time") && s.includes("FROM sb_entity_relations")) {
          const [fromEntityId, toEntityId, relationType, factHash, factKey] = args.map(String);
          const results = db.entityRelations
            .filter((relation: any) =>
              String(relation.from_entity_id) === fromEntityId &&
              String(relation.to_entity_id) === toEntityId &&
              String(relation.relation_type) === relationType &&
              (
                String(relation.fact_hash ?? "") === factHash ||
                (!relation.fact_hash && String(relation.fact ?? "").trim().toLowerCase() === factKey)
              ) &&
              relation.invalid_at == null &&
              relation.expired_at == null
            )
            .sort((a: any, b: any) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
            .slice(0, 20)
            .map((relation: any) => ({
              id: relation.id,
              valid_from: relation.valid_from ?? null,
              valid_to: relation.valid_to ?? null,
              reference_time: relation.reference_time ?? null,
            }));
          return { results };
        }
        if (s.includes("SELECT id, vector_ids, pending_vector_ids") && s.includes("pending_rebuild_id = ?")) {
          const pendingFingerprint = String(args[0]);
          const rebuildId = String(args[1]);
          const results = db.entries
            .filter((e: any) =>
              e.pending_embedding_fingerprint === pendingFingerprint &&
              e.pending_rebuild_id === rebuildId &&
              e.pending_vector_ids != null &&
              e.pending_vector_ids !== "[]" &&
              e.pending_content_hash != null &&
              e.pending_revision_id != null &&
              e.pending_metadata_hash != null &&
              e.metadata_hash != null &&
              e.content_hash === e.pending_content_hash &&
              e.metadata_hash === e.pending_metadata_hash
            )
            .map((e: any) => ({
              id: e.id,
              vector_ids: e.vector_ids,
              pending_vector_ids: e.pending_vector_ids,
            }));
          return { results };
        }
        if (s.includes("SELECT id, vector_ids, pending_vector_ids") && s.includes("pending_embedding_fingerprint = ?")) {
          const pendingFingerprint = String(args[0]);
          const results = db.entries
            .filter((e: any) =>
              e.pending_embedding_fingerprint === pendingFingerprint &&
              e.pending_vector_ids != null &&
              e.pending_vector_ids !== "[]" &&
              e.pending_content_hash != null &&
              e.pending_revision_id != null &&
              e.pending_metadata_hash != null &&
              e.metadata_hash != null &&
              e.content_hash === e.pending_content_hash &&
              e.metadata_hash === e.pending_metadata_hash
            )
            .map((e: any) => ({
              id: e.id,
              vector_ids: e.vector_ids,
              pending_vector_ids: e.pending_vector_ids,
            }));
          return { results };
        }
        if (s.includes("SELECT id, vector_ids_json, attempts") && s.includes("FROM sb_vector_cleanup_batches")) {
          const now = Number(args[0] ?? Date.now());
          const limit = Number(args[1] ?? 100);
          return {
            results: [...db.vectorCleanupBatches]
              .filter((row: any) => row.state === "ready" && Number(row.next_attempt_at ?? 0) <= now)
              .sort((a: any, b: any) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))
              .slice(0, limit)
              .map((row: any) => ({
                id: row.id,
                vector_ids_json: row.vector_ids_json,
                attempts: row.attempts ?? 0,
              })),
          };
        }
        if (s.includes("SELECT vector_id, attempts") && s.includes("FROM sb_vector_cleanup_queue")) {
          const now = Number(args[0] ?? Date.now());
          const limit = Number(args[1] ?? args[0] ?? 100);
          return {
            results: [...db.vectorCleanupQueue]
              .filter((row: any) =>
                (s.includes("state IN ('ready', 'blocked')")
                  ? ["ready", "blocked"].includes(row.state ?? "ready")
                  : (row.state ?? "ready") === "ready") &&
                Number(row.next_attempt_at ?? 0) <= now
              )
              .sort((a: any, b: any) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))
              .slice(0, limit)
              .map((row: any) => ({
                vector_id: row.vector_id,
                attempts: row.attempts ?? 0,
              })),
          };
        }
        if (s === "PRAGMA table_info(sb_observations)") {
          return {
            results: [
              "id",
              "content",
              "source",
              "metadata_json",
              "content_hash",
              "source_channel",
              "source_identity",
              "author_type",
              "source_uri",
              "source_timestamp",
              "revision",
              "root_evidence_id",
              "previous_evidence_id",
              "extraction_status",
              "extraction_version",
              "extraction_attempts",
              "extraction_error",
              "next_attempt_at",
              "processing_started_at",
              "processed_at",
              "needs_reprocess",
              "created_at",
            ].map((name) => ({ name })),
          };
        }
        if (s === "PRAGMA table_info(sb_memories)") {
          return {
            results: [
              "id",
              "content",
              "kind",
              "memory_class",
              "importance",
              "confidence",
              "entry_id",
              "parent_version_id",
              "claim_subject",
              "claim_predicate",
              "claim_object",
              "scope_id",
              "polarity",
              "modality",
              "claim_status",
              "scores_json",
              "content_hash",
              "observed_at",
              "valid_from",
              "valid_to",
              "reference_time",
              "invalid_at",
              "expired_at",
              "entities_json",
              "created_at",
            ].map((name) => ({ name })),
          };
        }
        if (s === "PRAGMA table_info(sb_memory_sources)") {
          return {
            results: [
              "id",
              "memory_id",
              "observation_id",
              "role",
              "score",
              "relation",
              "extract_span",
              "evidence_score",
              "derivation_confidence",
              "extractor_model",
              "extractor_version",
              "evidence_root_id",
              "created_at",
            ].map((name) => ({ name })),
          };
        }
        if (s === "PRAGMA table_info(sb_parent_versions)") {
          return {
            results: [
              "version_id", "parent_id", "version_number", "source_observation_id",
              "source_snapshot_hash", "summary", "state", "summary_vector_ids",
              "activated_at", "superseded_at", "activation_time_source",
              "superseded_time_source", "created_at", "updated_at",
            ].map((name) => ({ name })),
          };
        }
        if (s === "PRAGMA table_info(sb_entity_relations)") {
          return {
            results: [
              "id", "from_entity_id", "to_entity_id", "relation_type", "fact",
              "fact_hash", "evidence_count", "memory_id", "observation_id", "score",
              "valid_from", "valid_to", "invalid_at", "expired_at", "reference_time",
              "scope_id", "polarity", "modality", "resolution_type", "resolution_state",
              "supersedes_relation_id", "metadata_json", "created_at",
            ].map((name) => ({ name })),
          };
        }
        if (s === "PRAGMA table_info(sb_association_edges)") {
          return {
            results: [
              "id", "source_parent_id", "target_parent_id", "edge_type", "weight",
              "provenance", "metadata_json", "directed", "valid_from", "valid_to",
              "deleted_at", "created_at", "updated_at",
            ].map((name) => ({ name })),
          };
        }
        if (
          s.includes("SELECT id, from_memory_id, to_memory_id, relation_type") &&
          s.includes("FROM sb_memory_relations")
        ) {
          const memoryId = String(args[0]);
          const limit = Number(args[args.length - 1]);
          const results = db.relations
            .filter(
              (relation: any) =>
                String(relation.from_memory_id) === memoryId ||
                String(relation.to_memory_id) === memoryId
            )
            .sort((a: any, b: any) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
            .slice(0, limit);
          return { results };
        }
        if (s.includes("SELECT from_memory_id") && s.includes("FROM sb_memory_relations")) {
          const targetIds = new Set(args.map(String));
          const results = db.relations
            .filter(
              (relation: any) =>
                ["digest_of", "derived_from"].includes(relation.relation_type) &&
                targetIds.has(String(relation.to_memory_id))
            )
            .map((relation: any) => ({ from_memory_id: relation.from_memory_id }));
          return { results };
        }
        if (s.includes("SELECT to_memory_id") && s.includes("FROM sb_memory_relations")) {
          const derivedIds = new Set(args.map(String));
          const results = db.relations
            .filter(
              (relation: any) =>
                relation.relation_type === "digest_of" &&
                derivedIds.has(String(relation.from_memory_id))
            )
            .map((relation: any) => ({ to_memory_id: relation.to_memory_id }));
          return { results };
        }
        if (s.includes("SELECT id FROM sb_memories") && s.includes("WHERE entry_id IN")) {
          const entryIds = new Set(args.map(String));
          const results = db.memories
            .filter((memory: any) => entryIds.has(String(memory.entry_id)))
            .map((memory: any) => ({ id: memory.id }));
          return { results };
        }
        if (s.includes("SELECT observation_id FROM sb_memory_sources") && s.includes("WHERE memory_id IN")) {
          const memoryIds = new Set(args.map(String));
          const results = db.memorySources
            .filter((source: any) => memoryIds.has(String(source.memory_id)))
            .map((source: any) => ({ observation_id: source.observation_id }));
          return { results };
        }
        if (
          s.includes("FROM sb_entities") &&
          s.includes("ORDER BY length(name_normalized)")
        ) {
          const normalizedQuery = String(args[0] ?? "");
          const aliasPatterns = args
            .slice(1, -1)
            .map((arg: any) => String(arg ?? "").replace(/^%/, "").replace(/%$/, "").toLowerCase())
            .filter(Boolean);
          const limit = Number(args[args.length - 1] ?? 8);
          const results = [...db.entities]
            .filter((entity: any) => {
              const name = String(entity.name_normalized ?? "");
              const aliases = String(entity.aliases_json ?? "[]").toLowerCase();
              return name.length >= 2 && (
                normalizedQuery.includes(name) ||
                aliasPatterns.some((pattern: string) => aliases.includes(pattern))
              );
            })
            .sort((a: any, b: any) =>
              String(b.name_normalized ?? "").length - String(a.name_normalized ?? "").length ||
              Number(b.mention_count ?? 0) - Number(a.mention_count ?? 0) ||
              Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0)
            )
            .slice(0, limit)
            .map((entity: any) => ({
              id: entity.id,
              name: entity.name,
              name_normalized: entity.name_normalized,
              entity_type: entity.entity_type ?? null,
              aliases_json: entity.aliases_json ?? "[]",
              mention_count: entity.mention_count ?? 0,
              updated_at: entity.updated_at ?? 0,
            }));
          return { results };
        }
        if (
          s.includes("FROM sb_memory_entities me") &&
          s.includes("JOIN sb_memories m ON m.id = me.memory_id") &&
          s.includes("JOIN sb_entities e ON e.id = me.entity_id")
        ) {
          const inMatch = s.match(/me\.entity_id IN \(([^)]*)\)/);
          const entityIdCount = inMatch ? inMatch[1].split(",").filter(Boolean).length : 0;
          const entityIds = new Set(args.slice(0, entityIdCount).map(String));
          const asOf = Number(args[entityIdCount] ?? Date.now());
          const limit = Number(args[args.length - 1] ?? 100);
          const results = db.memoryEntities
            .filter((link: any) => entityIds.has(String(link.entity_id)))
            .map((link: any) => {
              const memory = db.memories.find((m: any) => m.id === link.memory_id);
              const entity = db.entities.find((e: any) => e.id === link.entity_id);
              return { link, memory, entity };
            })
            .filter(({ memory }: any) =>
              memory &&
              memory.entry_id &&
              isActiveAt(memory, asOf) &&
              memoryPassesActiveParentFilter(db, memory, asOf, activePredicateRequiresSourceEvidence(s))
            )
            .sort((a: any, b: any) =>
              Number(b.link.score ?? 0) - Number(a.link.score ?? 0) ||
              Number(b.memory.created_at ?? 0) - Number(a.memory.created_at ?? 0)
            )
            .slice(0, limit)
            .map(({ link, memory, entity }: any) => ({
              entry_id: memory.entry_id,
              memory_id: memory.id,
              created_at: memory.created_at,
              valid_from: memory.valid_from ?? null,
              valid_to: memory.valid_to ?? null,
              reference_time: memory.reference_time ?? null,
              invalid_at: memory.invalid_at ?? null,
              expired_at: memory.expired_at ?? null,
              importance: memory.importance ?? null,
              confidence: memory.confidence ?? null,
              entity_id: link.entity_id,
              entity_score: link.score ?? null,
              entity_name: entity?.name ?? null,
            }));
          return { results };
        }
        if (
          s.includes("FROM sb_entity_relations r") &&
          (
            s.includes("JOIN sb_memories m ON m.id = r.memory_id") ||
            s.includes("JOIN sb_memories m ON m.id = COALESCE(rfs.memory_id, r.memory_id)")
          ) &&
          s.includes("JOIN sb_entities fe ON fe.id = r.from_entity_id")
        ) {
          const inMatch = s.match(/r\.from_entity_id IN \(([^)]*)\)/);
          const entityIdCount = inMatch ? inMatch[1].split(",").filter(Boolean).length : 0;
          const fromIds = new Set(args.slice(0, entityIdCount).map(String));
          const toIds = new Set(args.slice(entityIdCount, entityIdCount * 2).map(String));
          const asOf = Number(args[entityIdCount * 2] ?? Date.now());
          const limit = Number(args[args.length - 1] ?? 100);
          const results = db.entityRelations
            .filter((relation: any) =>
              fromIds.has(String(relation.from_entity_id)) ||
              toIds.has(String(relation.to_entity_id))
            )
            .flatMap((relation: any) => {
              const sourceMemoryIds = db.factSources
                .filter((source: any) => source.relation_id === relation.id && source.memory_id)
                .map((source: any) => source.memory_id);
              const memoryIds = sourceMemoryIds.length > 0 ? sourceMemoryIds : [relation.memory_id];
              const from = db.entities.find((e: any) => e.id === relation.from_entity_id);
              const to = db.entities.find((e: any) => e.id === relation.to_entity_id);
              return memoryIds.map((memoryId: string) => ({
                relation,
                memory: db.memories.find((m: any) => m.id === memoryId),
                from,
                to,
              }));
            })
            .filter(({ relation, memory }: any) =>
              memory &&
              memory.entry_id &&
              isActiveAt(relation, asOf) &&
              isActiveAt(memory, asOf) &&
              memoryPassesActiveParentFilter(db, memory, asOf, activePredicateRequiresSourceEvidence(s))
            )
            .sort((a: any, b: any) =>
              Number(b.relation.score ?? 0) - Number(a.relation.score ?? 0) ||
              Number(b.relation.created_at ?? 0) - Number(a.relation.created_at ?? 0)
            )
            .slice(0, limit)
            .map(({ relation, memory, from, to }: any) => ({
              entry_id: memory.entry_id,
              memory_created_at: memory.created_at,
              memory_id: relation.memory_id,
              from_entity_id: relation.from_entity_id,
              to_entity_id: relation.to_entity_id,
              relation_type: relation.relation_type,
              fact: relation.fact ?? null,
              score: relation.score ?? null,
              valid_from: relation.valid_from ?? null,
              valid_to: relation.valid_to ?? null,
              reference_time: relation.reference_time ?? memory.reference_time ?? null,
              invalid_at: relation.invalid_at ?? null,
              expired_at: relation.expired_at ?? null,
              from_name: from?.name ?? null,
              to_name: to?.name ?? null,
            }));
          return { results };
        }
        if (
          s.includes("SELECT id, claim_status, scores_json") &&
          s.includes("FROM sb_memories") &&
          s.includes("WHERE entry_id = ?")
        ) {
          const entryId = String(args[0]);
          const results = db.memories
            .filter((memory: any) =>
              String(memory.entry_id) === entryId &&
              memory.invalid_at == null &&
              memory.expired_at == null
            )
            .map((memory: any) => ({
              id: memory.id,
              claim_status: memory.claim_status ?? null,
              scores_json: memory.scores_json ?? null,
            }));
          return { results };
        }
        if (s.includes("SELECT id, vector_ids") && s.includes("FROM entries WHERE id IN")) {
          const ids = new Set(args.map(String));
          const results = db.entries
            .filter((entry: any) => ids.has(String(entry.id)))
            .map((entry: any) => ({
              id: entry.id,
              vector_ids: entry.vector_ids ?? "[]",
              pending_vector_ids: entry.pending_vector_ids ?? null,
              pending_rebuild_id: entry.pending_rebuild_id ?? null,
              tags: entry.tags ?? "[]",
            }));
          return { results };
        }
        if (
          s.includes("SELECT id, content, tags, source, created_at") &&
          s.includes("FROM entries") &&
          s.includes("WHERE id IN")
        ) {
          const ids = new Set(args.map(String));
          const kindMatch = s.match(/kind:(episodic|semantic|procedural)/);
          const results = db.entries
            .filter((entry: any) => {
              const tags: string[] = JSON.parse(entry.tags ?? "[]");
              if (!ids.has(String(entry.id))) return false;
              if (
                s.includes("sb_parent_versions") &&
                !entryPassesActiveParentFilter(
                  db,
                  String(entry.id),
                  activePredicateAsOfFromSql(s),
                  activePredicateRequiresEvidence(s),
                  activePredicateRequiresSourceEvidence(s),
                  activePredicateRequiresProjectionHash(s)
                )
              ) return false;
              if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
              if (s.includes('"auto-pattern"') && tags.includes("auto-pattern")) return false;
              if (kindMatch && !tags.includes(`kind:${kindMatch[1]}`)) return false;
              return true;
            })
            .map((entry: any) => ({
              id: entry.id,
              content: entry.content,
              tags: entry.tags,
              source: entry.source,
              created_at: entry.created_at,
              vector_ids: entry.vector_ids ?? "[]",
            }));
          return { results };
        }
        if (
          s.includes("SELECT id, content, tags, source FROM entries") &&
          s.includes("WHERE id IN")
        ) {
          const ids = new Set(args.map(String));
          const results = db.entries
            .filter((entry: any) => ids.has(String(entry.id)))
            .map((entry: any) => ({
              id: entry.id,
              content: entry.content,
              tags: entry.tags,
              source: entry.source,
            }));
          return { results };
        }
        if (
          s.includes("FROM sb_observations") &&
          s.includes("ORDER BY created_at ASC") &&
          s.includes("LIMIT")
        ) {
          const maxAttempts = Number(args[0] ?? 3);
          const now = Number(args[1] ?? Date.now());
          const leaseCutoff = Number(args[2] ?? 0);
          const currentVersion = Number(args[3] ?? 1);
          const limit = Number(args[args.length - 1] ?? 10);
          const results = [...db.observations]
            .filter((observation: any) => {
              if (Number(observation.extraction_attempts ?? 0) >= maxAttempts) return false;
              const status = observation.extraction_status ?? "pending";
              return status === "pending" ||
                (
                  status === "retryable_error" &&
                  Number(observation.next_attempt_at ?? 0) <= now
                ) ||
                (
                  status === "processing" &&
                  Number(observation.processing_started_at ?? 0) <= leaseCutoff
                ) ||
                (
                  status === "fallback" &&
                  Number(observation.needs_reprocess ?? 0) === 1
                ) ||
                (
                  status === "partial_error" &&
                  Number(observation.needs_reprocess ?? 0) === 1
                ) ||
                Number(observation.extraction_version ?? 0) < currentVersion;
            })
            .sort((a: any, b: any) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))
            .slice(0, limit);
          return { results };
        }
        if (
          s.includes("FROM entries") &&
          s.includes("pending_vector_ids = '[]'") &&
          s.includes("pending_embedding_fingerprint = ?") &&
          s.includes("ORDER BY created_at DESC LIMIT")
        ) {
          const pendingFingerprint = String(args[0]);
          const hasRebuildId = s.includes("pending_rebuild_id = ?");
          const rebuildId = hasRebuildId ? String(args[1]) : null;
          const cutoff = Number(hasRebuildId ? args[2] : args[1]);
          const limit = Number(args[args.length - 1]);
          const rows = [...db.entries]
            .filter((e: any) =>
              e.pending_vector_ids === "[]" &&
              e.pending_embedding_fingerprint === pendingFingerprint &&
              (!rebuildId || e.pending_rebuild_id === rebuildId) &&
              e.created_at < cutoff &&
              (!s.includes("tags NOT LIKE") || !String(e.tags ?? "[]").includes('"status:deprecated"'))
            )
            .sort((a: any, b: any) => b.created_at - a.created_at || (b.id < a.id ? 1 : -1))
            .slice(0, limit)
            .map((e: any) => ({
              id: e.id,
              content: e.content,
              tags: e.tags,
              source: e.source,
              created_at: e.created_at,
              content_hash: e.content_hash ?? null,
              pending_rebuild_id: e.pending_rebuild_id ?? null,
            }));
          return { results: rows };
        }
        if (
          s.includes("SELECT id, pending_vector_ids, pending_rebuild_id") &&
          s.includes("pending_rebuild_id IS NULL") &&
          s.includes("pending_rebuild_id != ?") &&
          s.includes("pending_vector_ids != '[]'")
        ) {
          const rebuildId = String(args[0]);
          const results = [...db.entries]
            .filter((e: any) =>
              e.pending_vector_ids != null &&
              e.pending_vector_ids !== "[]" &&
              !String(e.tags ?? "[]").includes('"status:deprecated"') &&
              (e.pending_rebuild_id == null || e.pending_rebuild_id !== rebuildId)
            )
            .map((e: any) => ({
              id: e.id,
              pending_vector_ids: e.pending_vector_ids,
              pending_rebuild_id: e.pending_rebuild_id ?? null,
            }));
          return { results };
        }
        if (
          s.includes("SELECT id, pending_vector_ids, pending_rebuild_id") &&
          s.includes("pending_rebuild_id = ?") &&
          s.includes("pending_vector_ids != '[]'")
        ) {
          const rebuildId = String(args[0]);
          const limit = Number(args[1] ?? 50);
          const results = [...db.entries]
            .filter((e: any) =>
              e.pending_rebuild_id === rebuildId &&
              e.pending_vector_ids != null &&
              e.pending_vector_ids !== "[]" &&
              !String(e.tags ?? "[]").includes('"status:deprecated"') &&
              (
                e.pending_content_hash == null ||
                e.content_hash == null ||
                e.pending_revision_id == null ||
                e.pending_metadata_hash == null ||
                e.metadata_hash == null ||
                e.pending_content_hash !== e.content_hash ||
                e.pending_metadata_hash !== e.metadata_hash
              )
            )
            .sort((a: any, b: any) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
            .slice(0, limit)
            .map((e: any) => ({
              id: e.id,
              pending_vector_ids: e.pending_vector_ids,
              pending_rebuild_id: e.pending_rebuild_id,
              pending_revision_id: e.pending_revision_id ?? null,
              pending_content_hash: e.pending_content_hash ?? null,
              pending_metadata_hash: e.pending_metadata_hash ?? null,
            }));
          return { results };
        }
        if (
          s.includes("SELECT id, vector_ids, pending_vector_ids") &&
          s.includes("pending_embedding_fingerprint = ?")
        ) {
          const pendingFingerprint = String(args[0]);
          const results = db.entries
            .filter((e: any) =>
              e.pending_embedding_fingerprint === pendingFingerprint &&
              e.pending_vector_ids != null &&
              e.pending_vector_ids !== "[]" &&
              e.pending_content_hash != null &&
              e.pending_revision_id != null &&
              e.content_hash === e.pending_content_hash
            )
            .map((e: any) => ({
              id: e.id,
              vector_ids: e.vector_ids,
              pending_vector_ids: e.pending_vector_ids,
            }));
          return { results };
        }
        if (
          s.includes("SELECT pending_vector_ids FROM entries") &&
          s.includes("pending_embedding_fingerprint = ?") &&
          s.includes("pending_vector_ids IS NOT NULL")
        ) {
          const pendingFingerprint = String(args[0]);
          const rebuildId = s.includes("pending_rebuild_id = ?") ? String(args[1]) : null;
          const results = db.entries
            .filter((e: any) =>
              e.pending_embedding_fingerprint === pendingFingerprint &&
              (!rebuildId || e.pending_rebuild_id === rebuildId) &&
              e.pending_vector_ids != null &&
              e.pending_vector_ids !== "[]"
            )
            .map((e: any) => ({ pending_vector_ids: e.pending_vector_ids }));
          return { results };
        }
        // export (cursor + id) and vectorize-pending — avoid matching compress/list queries
        if (
          s.includes("FROM entries") &&
          s.includes("LIMIT") &&
          (s.includes("ORDER BY created_at DESC, id DESC") ||
            (s.includes("vector_ids = '[]'") && s.includes("ORDER BY created_at DESC")))
        ) {
          const limit = Number(args[args.length - 1]);
          let rows = [...db.entries];
          if (s.includes("vector_ids = '[]'")) {
            const cutoff = Number(args[0]);
            rows = rows.filter((e: any) => e.vector_ids === "[]" && e.created_at < cutoff);
            if (s.includes("tags NOT LIKE")) {
              rows = rows.filter(
                (e: any) => !String(e.tags ?? "[]").includes('"status:deprecated"')
              );
            }
          } else if (s.includes("created_at = ? AND id < ?") && args.length >= 4) {
            const cAt = Number(args[0]);
            const cId = String(args[2]);
            rows = rows.filter(
              (e: any) => e.created_at < cAt || (e.created_at === cAt && e.id < cId)
            );
          }
          rows.sort((a: any, b: any) => b.created_at - a.created_at || (b.id < a.id ? 1 : -1));
          return { results: rows.slice(0, limit) };
        }
        if (
          s === "SELECT id FROM entries WHERE tags LIKE ?" ||
          s === "SELECT id, vector_ids FROM entries WHERE tags LIKE ?" ||
          s.startsWith("SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ?")
        ) {
          const pattern = String(args[0]);
          const tag = pattern.replace(/%"/g, "").replace(/"%/g, "");
          const results = db.entries
            .filter((e: any) => (JSON.parse(e.tags ?? "[]") as string[]).includes(tag))
            .filter((e: any) =>
              !s.includes("sb_parent_versions") ||
              entryPassesActiveParentFilter(
                db,
                String(e.id),
                activePredicateAsOfFromSql(s),
                activePredicateRequiresEvidence(s),
                activePredicateRequiresSourceEvidence(s),
                activePredicateRequiresProjectionHash(s)
              )
            )
            .filter((e: any) =>
              !s.includes("tags NOT LIKE") ||
              (
                !String(e.tags ?? "[]").includes('"status:deprecated"') &&
                !String(e.tags ?? "[]").includes('"auto-pattern"')
              )
            )
            .map((e: any) => ({ id: e.id, vector_ids: e.vector_ids ?? "[]", content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("content LIKE") && s.includes("ORDER BY created_at DESC LIMIT")) {
          // Keyword (hybrid recall) query: content LIKE ? OR content LIKE ? ... LIMIT ?
          const limit = Number(args[args.length - 1]);
          const patterns = args.slice(0, -1).map((a: any) => String(a).replace(/^%/, "").replace(/%$/, "").toLowerCase());
          const rows = [...db.entries]
            .filter((e: any) => patterns.some((p: string) => String(e.content).toLowerCase().includes(p)))
            .filter((e: any) =>
              !s.includes("sb_parent_versions") ||
              entryPassesActiveParentFilter(
                db,
                String(e.id),
                activePredicateAsOfFromSql(s),
                activePredicateRequiresEvidence(s),
                activePredicateRequiresSourceEvidence(s),
                activePredicateRequiresProjectionHash(s)
              )
            )
            .filter((e: any) =>
              !s.includes("tags NOT LIKE") ||
              (
                !String(e.tags ?? "[]").includes('"status:deprecated"') &&
                !String(e.tags ?? "[]").includes('"auto-pattern"')
              )
            )
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results: rows };
        }
        if (
          s.includes("recall_count") &&
          s.includes("importance_score") &&
          s.includes("WHERE id IN")
        ) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .filter((e: any) =>
              !s.includes("sb_parent_versions") ||
              entryPassesActiveParentFilter(
                db,
                String(e.id),
                activePredicateAsOfFromSql(s),
                activePredicateRequiresEvidence(s),
                activePredicateRequiresSourceEvidence(s),
                activePredicateRequiresProjectionHash(s)
              )
            )
            .map((e: any) => ({
              id: e.id,
              tags: e.tags ?? "[]",
              source: e.source ?? "api",
              created_at: e.created_at ?? 0,
              recall_count: e.recall_count ?? 0,
              importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0,
              contradiction_losses: e.contradiction_losses ?? 0,
              classification_confidence: e.classification_confidence ?? null,
              evidence_score: Math.max(
                0,
                ...db.memories
                  .filter((memory: any) =>
                    memory.entry_id === e.id &&
                    memoryPassesActiveParentFilter(
                      db,
                      memory,
                      activePredicateAsOfFromSql(s),
                      activePredicateRequiresSourceEvidence(s)
                    )
                  )
                  .map((memory: any) => {
                    const sourceScores = db.memorySources
                      .filter((source: any) => source.memory_id === memory.id)
                      .map((source: any) => Number(source.evidence_score ?? source.score ?? 0));
                    return Math.max(Number(memory.confidence ?? 0), ...sourceScores);
                  })
              ),
              parent_version_state: (() => {
                const memory = db.memories.find((item: any) =>
                  item.entry_id === e.id &&
                  memoryPassesActiveParentFilter(
                    db,
                    item,
                    activePredicateAsOfFromSql(s),
                    activePredicateRequiresSourceEvidence(s)
                  )
                );
                if (!memory) return null;
                const claim = db.parentVersionClaims.find((item: any) =>
                  item.memory_id === memory.id && parentVersionIsEligibleAt(
                    db,
                    item.parent_version_id,
                    activePredicateAsOfFromSql(s)
                  )
                );
                const versionId = claim?.parent_version_id ?? memory.parent_version_id;
                const version = db.parentVersions.find((parentVersion: any) =>
                  parentVersion.version_id === versionId
                );
                return version?.state ?? null;
              })(),
            }));
          return { results };
        }
        if (
          s.includes("SELECT id, content, tags, source") &&
          s.includes("pending_vector_ids") &&
          s.includes("pending_rebuild_id") &&
          s.includes("WHERE id IN")
        ) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({
              id: e.id,
              content: e.content,
              tags: e.tags,
              source: e.source,
              pending_vector_ids: e.pending_vector_ids ?? null,
              pending_rebuild_id: e.pending_rebuild_id ?? null,
              has_pending_columns: s.includes("has_pending_columns") ? 1 : undefined,
            }));
          return { results };
        }
        if (s.includes("FROM entries WHERE id IN") && s.includes("tags NOT LIKE")) {
          // recallEntries D1 hydration — filter by IDs, exclude auto-pattern entries, apply after/before
          const inMatch = s.match(/WHERE id IN \(([^)]*)\)/);
          const idCount = inMatch ? inMatch[1].split(",").length : 0;
          const ids = args.slice(0, idCount);
          const rest = args.slice(idCount);
          let argIdx = 0;
          const kindMatch = s.match(/kind:(episodic|semantic|procedural)/);
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (
              s.includes("sb_parent_versions") &&
              !entryPassesActiveParentFilter(
                db,
                String(e.id),
                activePredicateAsOfFromSql(s),
                activePredicateRequiresEvidence(s),
                activePredicateRequiresSourceEvidence(s),
                activePredicateRequiresProjectionHash(s)
              )
            ) return false;
            if (tags.includes("auto-pattern")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (kindMatch && !tags.includes(`kind:${kindMatch[1]}`)) return false;
            return true;
          });
          if (s.includes("created_at >= ?")) {
            const after = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          const results = rows.map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (
          (s.includes("SELECT id, content FROM entries") ||
            s.includes("SELECT id, content, tags FROM entries") ||
            s.includes("SELECT id, content, tags, pending_vector_ids, pending_rebuild_id FROM entries")) &&
          s.includes("WHERE tags LIKE") &&
          s.includes("ORDER BY created_at DESC")
        ) {
          // compressTag raw entries query — tag match, system-tag exclusion, and the
          // recall/age/contradiction eligibility predicate (cutoff is the 2nd bind param).
          const tagPattern = args[0] as string;
          const tag = tagPattern.replace(/%"/g, "").replace(/"%/g, "");
          const cutoff = Number(args[1]);
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              if (!tags.includes(tag)) return false;
              if (tags.includes("synthesized") || tags.includes("auto-pattern") || tags.includes("rolled-up")) return false;
              if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) return false;
              const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
              if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) return false;
              if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) return false;
              if (!(e.contradiction_losses == null || e.contradiction_losses === 0)) return false;
              if (
                s.includes("sb_parent_versions") &&
                !entryPassesActiveParentFilter(
                  db,
                  String(e.id),
                  activePredicateAsOfFromSql(s),
                  activePredicateRequiresEvidence(s),
                  activePredicateRequiresSourceEvidence(s),
                  activePredicateRequiresProjectionHash(s)
                )
              ) return false;
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, 50)
            .map((e: any) => ({
              id: e.id,
              content: e.content,
              tags: e.tags,
              pending_vector_ids: e.pending_vector_ids ?? null,
              pending_rebuild_id: e.pending_rebuild_id ?? null,
            }));
          return { results };
        }
        if (s.includes("SELECT id, content FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("HAVING count > 10")) {
          // Digest-candidate query (nightly compression + /stats): per-tag count of
          // entries that pass the compression eligibility predicate. Cutoff is args[0].
          const cutoff = Number(args[0]);
          const SYSTEM = ["synthesized", "auto-pattern", "duplicate-candidate", "contradiction-resolved", "rolled-up"];
          const counts = new Map<string, number>();
          for (const e of db.entries as any[]) {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (tags.includes("rolled-up") || tags.includes("synthesized") || tags.includes("auto-pattern")) continue;
            if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) continue;
            const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
            if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) continue;
            if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) continue;
            if (!(e.contradiction_losses == null || e.contradiction_losses === 0)) continue;
            if (
              s.includes("sb_parent_versions") &&
              !entryPassesActiveParentFilter(
                db,
                String(e.id),
                activePredicateAsOfFromSql(s),
                activePredicateRequiresEvidence(s),
                activePredicateRequiresSourceEvidence(s),
                activePredicateRequiresProjectionHash(s)
              )
            ) continue;
            for (const t of tags) {
              if (SYSTEM.includes(t)) continue;
              if (t.startsWith("status:") || t.startsWith("kind:")) continue;
              counts.set(t, (counts.get(t) ?? 0) + 1);
            }
          }
          const results = [...counts.entries()]
            .filter(([, c]) => c > 10)
            .sort((a, b) => b[1] - a[1])
            .map(([tag, count]) => ({ tag, count }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("GROUP BY value")) {
          // Top tags by frequency — for /stats
          const freq = new Map<string, number>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => freq.set(t, (freq.get(t) ?? 0) + 1));
          });
          const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
          return { results: sorted.map(([value, n]) => ({ value, n })) };
        }
        if (s.includes("json_each(entries.tags)")) {
          // Distinct sorted tags — for /tags
          const tags = new Set<string>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => tags.add(t));
          });
          return { results: [...tags].sort().map(t => ({ value: t })) };
        }
        if (s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`) && s.includes("ORDER BY created_at ASC LIMIT")) {
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:'))
            .sort((a: any, b: any) => a.created_at - b.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags }));
          return { results: rows };
        }
        if (s.includes("classification_status IS NULL") && s.includes("classification_started_at") && s.includes("ORDER BY CASE")) {
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 14;
          const now = Number(s.match(/classification_next_attempt_at, 0\) <= (\d+)/)?.[1] ?? 0);
          const leaseCutoff = Number(s.match(/classification_started_at, 0\) <= (\d+)/)?.[1] ?? 0);
          const versionMatch = s.match(/classification_version, 0\) < (\d+)/);
          const currentVersion = versionMatch ? Number(versionMatch[1]) : 2;
          const rows = [...db.entries]
            .filter((e: any) => {
              if (String(e.tags ?? "[]").includes('"status:deprecated"')) return false;
              const status = e.classification_status;
              if (status === "succeeded" && Number(e.classification_version ?? 0) < currentVersion) return true;
              if (Number(e.classification_attempts ?? 0) >= 3) return false;
              return status == null || status === "pending" ||
                (status === "retryable_error" && Number(e.classification_next_attempt_at ?? 0) <= now) ||
                (status === "processing" && Number(e.classification_started_at ?? 0) <= leaseCutoff);
            })
            .sort((a: any, b: any) => {
              const rank = (e: any) => {
                if (e.classification_status == null || e.classification_status === "pending") return 0;
                if (e.classification_status === "succeeded") return 2;
                return 1;
              };
              return rank(a) - rank(b) || a.created_at - b.created_at;
            })
            .slice(0, limit)
            .map((e: any) => ({
              id: e.id,
              content: e.content,
              classification_attempts: Number(e.classification_attempts ?? 0),
            }));
          return { results: rows };
        }
        if (s.includes("vector_ids = '[]' AND created_at <") && s.includes("ORDER BY created_at DESC LIMIT")) {
          const cutoff = Number(args[0]);
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff)
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results: rows };
        }
        if (s.includes("ORDER BY created_at DESC LIMIT")) {
          const limit = Number(args[args.length - 1]);
          const filterArgs = args.slice(0, -1);
          let argIdx = 0;
          let rows = [...db.entries];
          if (s.includes("1 = 0")) rows = [];
          if (s.includes("tags LIKE ?")) {
            const pattern = String(filterArgs[argIdx++]);
            const tag = pattern.replace(/%"/g, "").replace(/"%/g, "");
            rows = rows.filter((e: any) => (JSON.parse(e.tags ?? "[]") as string[]).includes(tag));
          }
          if (s.includes("created_at >= ?")) {
            const after = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          rows.sort((a: any, b: any) => b.created_at - a.created_at);
          return { results: rows.slice(0, limit) };
        }
        return { results: [] };
      },
    });

    return {
      bind(...args: any[]) { return makeStmt(args); },
      ...makeStmt([]),
    };
  }

  async exec(sql: string) {
    const statements = sql.split(";").filter(statement => statement.trim()).length;
    this.execCount += statements;
    this.statementCount += statements;
  }
  async batch(stmts: any[]) { return Promise.all(stmts.map((s: any) => s.run())); }
  reset() {
    this.entries = [];
    this.relations = [];
    this.revisions = [];
    this.scopes = [];
    this.parentUnits = [];
    this.parentVersions = [];
    this.parentVersionClaims = [];
    this.observations = [];
    this.memories = [];
    this.memorySources = [];
    this.entities = [];
    this.memoryEntities = [];
    this.entityRelations = [];
    this.factSources = [];
    this.mergeCandidates = [];
    this.conflictCases = [];
    this.auditEvents = [];
    this.appSettings = {};
    this.vectorRebuilds = [];
    this.vectorCleanupQueue = [];
    this.vectorCleanupBatches = [];
  }
}
