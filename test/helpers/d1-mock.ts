import { COMPRESSION_IMPORTANCE_THRESHOLD, COMPRESSION_MIN_RECALL } from "../../src/index";

export class D1Mock {
  entries: any[] = [];
  relations: any[] = [];
  revisions: any[] = [];
  observations: any[] = [];
  memories: any[] = [];
  memorySources: any[] = [];
  entities: any[] = [];
  memoryEntities: any[] = [];
  entityRelations: any[] = [];
  factSources: any[] = [];
  appSettings: Record<string, { value: string; updated_at: number }> = {};
  vectorCleanupQueue: any[] = [];
  statementCount = 0;
  execCount = 0;
  beforeClassificationCommit?: (row: any) => boolean | void;

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

    const makeStmt = (args: any[]) => ({
      async run() {
        db.statementCount += 1;

        if (s.startsWith("INSERT INTO sb_app_settings")) {
          const [key, value, updated_at] = args;
          db.appSettings[String(key)] = { value: String(value), updated_at: Number(updated_at) };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO sb_vector_cleanup_queue")) {
          const [id, vector_id, reason, last_error, created_at, updated_at] = args;
          const existing = db.vectorCleanupQueue.find((row: any) => row.vector_id === vector_id);
          if (existing) {
            existing.reason = reason;
            existing.last_error = last_error ?? existing.last_error;
            existing.updated_at = updated_at;
          } else {
            db.vectorCleanupQueue.push({
              id,
              vector_id,
              reason,
              attempts: 0,
              last_error,
              created_at,
              updated_at,
            });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE sb_vector_cleanup_queue SET attempts = attempts + 1")) {
          const [last_error, updated_at, vector_id] = args;
          const row = db.vectorCleanupQueue.find((item: any) => item.vector_id === vector_id);
          if (row) {
            row.attempts = Number(row.attempts ?? 0) + 1;
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
        if (s.startsWith("INSERT INTO sb_observations")) {
          if (args.length >= 14) {
            const [
              id, content, source, metadata_json, content_hash,
              extraction_status, extraction_version, extraction_attempts,
              extraction_error, next_attempt_at, processing_started_at,
              processed_at, needs_reprocess, created_at,
            ] = args;
            db.observations.push({
              id, content, source, metadata_json, content_hash,
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
        if (s.startsWith("INSERT INTO sb_memories")) {
          let id: any;
          let content: any;
          let kind: any;
          let memory_class: any;
          let importance: any;
          let confidence: any;
          let entry_id: any;
          let content_hash: any;
          let observed_at: any;
          let valid_from: any;
          let valid_to: any;
          let reference_time: any;
          let invalid_at: any;
          let expired_at: any;
          let entities_json: any;
          let created_at: any;
          if (args.length >= 16) {
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
            entry_id, content_hash, observed_at, valid_from, valid_to,
            reference_time, invalid_at, expired_at, entities_json, created_at,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO sb_memory_sources")) {
          const [id, memory_id, observation_id, role, score, created_at] = args;
          const existing = db.memorySources.find(
            (row: any) =>
              row.memory_id === memory_id &&
              row.observation_id === observation_id &&
              row.role === role
          );
          if (existing) {
            if (score != null) existing.score = score;
          } else {
            db.memorySources.push({ id, memory_id, observation_id, role, score, created_at });
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
        if (s.startsWith("UPDATE sb_entity_relations SET invalid_at")) {
          const hasExpiredAt = s.startsWith("UPDATE sb_entity_relations SET invalid_at = ?, expired_at = ?");
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
          const [fact_hash, sourceInserted, scoreA, scoreB, scoreC, id] = args;
          const row = db.entityRelations.find((relation: any) => relation.id === id);
          if (row) {
            row.fact_hash = row.fact_hash ?? fact_hash;
            row.evidence_count = Number(row.evidence_count ?? 1) + (Number(sourceInserted) === 1 ? 1 : 0);
            if (scoreA != null && (row.score == null || Number(row.score) < Number(scoreB))) {
              row.score = scoreC;
            }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE sb_memories SET invalid_at")) {
          const hasExpiredAt = s.startsWith("UPDATE sb_memories SET invalid_at = ?, expired_at = ?");
          const [invalid_at, maybe_expired_at, maybe_valid_to, maybe_entry_id] = args;
          const expired_at = hasExpiredAt ? maybe_expired_at : null;
          const valid_to = hasExpiredAt ? maybe_valid_to : maybe_expired_at;
          const entry_id = hasExpiredAt ? maybe_entry_id : maybe_valid_to;
          let changes = 0;
          for (const memory of db.memories) {
            if (memory.entry_id === entry_id && memory.invalid_at == null && memory.expired_at == null) {
              memory.invalid_at = invalid_at;
              if (hasExpiredAt) memory.expired_at = expired_at;
              if (memory.valid_to == null) memory.valid_to = valid_to;
              changes += 1;
            }
          }
          return { meta: { changes } };
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
          if (args.length >= 17) {
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
            const hasImportance = s.includes("importance_score") || args.length >= 8;
            const id = args[0];
            const content = args[1];
            const tags = args[2];
            const source = args[3];
            const created_at = args[4];
            const vector_ids = args[5];
            const content_hash = args[6];
            const importance_score = hasImportance && args.length >= 8 ? args[7] : 0;
            const row = {
              id, content, tags, source, created_at, vector_ids,
              recall_count: 0, importance_score: importance_score ?? 0,
              contradiction_wins: 0, contradiction_losses: 0,
              content_hash,
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
            const hasPending = s.includes("pending_vector_ids");
            const content = args[0];
            const vector_ids = args[1];
            let index = 2;
            const content_hash = hasHash ? args[index++] : null;
            const pending_vector_ids = hasPending ? args[index++] : undefined;
            const pending_embedding_fingerprint = hasPending ? args[index++] : undefined;
            const id = args[index++];
            const expected_content = args[index++];
            const expected_tags = args[index++];
            const expected_vector_ids = args[index++];
            const row = db.entries.find(
              (e: any) =>
                e.id === id &&
                e.content === expected_content &&
                e.tags === expected_tags &&
                e.vector_ids === expected_vector_ids
            );
            if (row) {
              row.content = content;
              row.vector_ids = vector_ids;
              if (hasHash) row.content_hash = content_hash;
              if (hasPending) {
                row.pending_vector_ids = pending_vector_ids;
                row.pending_embedding_fingerprint = pending_embedding_fingerprint;
                row.pending_content_hash = null;
                row.pending_revision_id = null;
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
            }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = ?,")) {
          const [vector_ids, pending_vector_ids, pending_embedding_fingerprint, id, expected_vector_ids, expected_content] = args;
          const row = db.entries.find(
            (e: any) =>
              e.id === id &&
              e.vector_ids === expected_vector_ids &&
              e.content === expected_content &&
              !String(e.tags ?? "[]").includes('"status:deprecated"')
          );
          if (row) {
            row.vector_ids = vector_ids;
            row.pending_vector_ids = pending_vector_ids;
            row.pending_embedding_fingerprint = pending_embedding_fingerprint;
            row.pending_content_hash = null;
            row.pending_revision_id = null;
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
          const [pending_embedding_fingerprint] = args;
          let changes = 0;
          for (const row of db.entries) {
            if (String(row.tags ?? "[]").includes('"status:deprecated"')) continue;
            row.pending_vector_ids = "[]";
            row.pending_embedding_fingerprint = pending_embedding_fingerprint;
            row.pending_content_hash = null;
            row.pending_revision_id = null;
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
            maybe_content_hash,
            id,
            expected_pending_vector_ids,
            expected_pending_embedding_fingerprint,
            expected_content,
          ] = args;
          const hasPendingRevisionId = s.includes("pending_revision_id = ?");
          const pending_revision_id = hasPendingRevisionId ? maybe_pending_revision_id : null;
          const content_hash = hasPendingRevisionId ? maybe_content_hash : maybe_pending_revision_id;
          const row = db.entries.find(
            (e: any) =>
              e.id === id &&
              e.pending_vector_ids === expected_pending_vector_ids &&
              e.pending_embedding_fingerprint === expected_pending_embedding_fingerprint &&
              e.content === expected_content &&
              !String(e.tags ?? "[]").includes('"status:deprecated"')
          );
          if (row) {
            row.pending_vector_ids = pending_vector_ids;
            row.pending_embedding_fingerprint = pending_embedding_fingerprint;
            row.pending_content_hash = pending_content_hash;
            row.pending_revision_id = pending_revision_id;
            if (row.content_hash == null) row.content_hash = content_hash;
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
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = pending_vector_ids")) {
          const [pending_embedding_fingerprint] = args;
          let changes = 0;
          for (const row of db.entries) {
            if (
              row.pending_embedding_fingerprint === pending_embedding_fingerprint &&
              row.pending_vector_ids != null &&
              row.pending_vector_ids !== "[]" &&
              row.pending_content_hash != null &&
              row.pending_revision_id != null &&
              row.content_hash === row.pending_content_hash
            ) {
              row.vector_ids = row.pending_vector_ids;
              row.embedding_fingerprint = row.pending_embedding_fingerprint;
              row.pending_vector_ids = null;
              row.pending_embedding_fingerprint = null;
              row.pending_content_hash = null;
              row.pending_revision_id = null;
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
        if (s.startsWith("UPDATE entries SET tags = ?, importance_score = ?, classification_confidence = ?")) {
          const [
            tags,
            importance_score,
            classification_confidence,
            classification_version,
            classified_at,
            id,
            content,
            expected_tags,
            started_at,
          ] = args;
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
              importance_score,
              classification_confidence,
              classification_status: "succeeded",
              classification_error: null,
              classification_next_attempt_at: null,
              classification_started_at: null,
              classification_version,
              classified_at,
            });
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
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id")) {
          const [tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.tags = tags;
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
            const hasPending = s.includes("pending_vector_ids");
            const content = args[0];
            const tags = args[1];
            const vector_ids = args[2];
            let index = 3;
            const content_hash = hasHash ? args[index++] : null;
            const pending_vector_ids = hasPending ? args[index++] : undefined;
            const pending_embedding_fingerprint = hasPending ? args[index++] : undefined;
            const id = args[index++];
            const expected_content = args[index++];
            const expected_tags = args[index++];
            const expected_vector_ids = args[index++];
            const row = db.entries.find(
              (e: any) =>
                e.id === id &&
                e.content === expected_content &&
                e.tags === expected_tags &&
                e.vector_ids === expected_vector_ids
            );
            if (row) {
              row.content = content;
              row.tags = tags;
              row.vector_ids = vector_ids;
              if (hasHash) row.content_hash = content_hash;
              if (hasPending) {
                row.pending_vector_ids = pending_vector_ids;
                row.pending_embedding_fingerprint = pending_embedding_fingerprint;
                row.pending_content_hash = null;
                row.pending_revision_id = null;
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
        if (s.includes("SELECT value FROM sb_app_settings WHERE key = ?")) {
          const row = db.appSettings[String(args[0])];
          return row ? { value: row.value } : null;
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
        if (s.includes("COUNT(*) as count") && s.includes("pending_embedding_fingerprint = ?") && s.includes("pending_content_hash != content_hash")) {
          const pendingFingerprint = String(args[0]);
          const count = db.entries.filter((e: any) =>
            e.pending_embedding_fingerprint === pendingFingerprint &&
            e.pending_vector_ids != null &&
            e.pending_vector_ids !== "[]" &&
            (
              e.pending_content_hash == null ||
              e.pending_revision_id == null ||
              e.content_hash == null ||
              e.pending_content_hash !== e.content_hash
            )
          ).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes("pending_embedding_fingerprint = ?") && s.includes("content_hash = pending_content_hash")) {
          const pendingFingerprint = String(args[0]);
          const count = db.entries.filter((e: any) =>
            e.pending_embedding_fingerprint === pendingFingerprint &&
            e.pending_vector_ids != null &&
            e.pending_vector_ids !== "[]" &&
            e.pending_content_hash != null &&
            e.pending_revision_id != null &&
            e.content_hash === e.pending_content_hash
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
          const cutoff = s.includes("created_at <") ? Number(args[1]) : null;
          const count = db.entries.filter((e: any) =>
            e.pending_vector_ids === '[]' &&
            e.pending_embedding_fingerprint === pendingFingerprint &&
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
          const now = Number(s.match(/classification_next_attempt_at > (\d+)/)?.[1] ?? 0);
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
        if (s.includes("SELECT tags FROM entries") && s.includes("classification_started_at = ?")) {
          const [id, content, startedAt] = args;
          const row = db.entries.find((e: any) =>
            e.id === id && e.content === content && e.classification_status === "processing" &&
            e.classification_started_at === startedAt
          );
          return row ? { tags: row.tags } : null;
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
        if (s.includes("SELECT vector_id, attempts") && s.includes("FROM sb_vector_cleanup_queue")) {
          const limit = Number(args[0] ?? 100);
          return {
            results: [...db.vectorCleanupQueue]
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
              memory.invalid_at == null &&
              memory.expired_at == null &&
              (memory.valid_from == null || Number(memory.valid_from) <= asOf) &&
              (memory.valid_to == null || Number(memory.valid_to) > asOf)
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
          s.includes("JOIN sb_memories m ON m.id = r.memory_id") &&
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
            .map((relation: any) => {
              const memory = db.memories.find((m: any) => m.id === relation.memory_id);
              const from = db.entities.find((e: any) => e.id === relation.from_entity_id);
              const to = db.entities.find((e: any) => e.id === relation.to_entity_id);
              return { relation, memory, from, to };
            })
            .filter(({ relation, memory }: any) =>
              memory &&
              memory.entry_id &&
              relation.invalid_at == null &&
              relation.expired_at == null &&
              (relation.valid_from == null || Number(relation.valid_from) <= asOf) &&
              (relation.valid_to == null || Number(relation.valid_to) > asOf) &&
              memory.invalid_at == null &&
              memory.expired_at == null
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
        if (s.includes("SELECT id, vector_ids") && s.includes("FROM entries WHERE id IN")) {
          const ids = new Set(args.map(String));
          const results = db.entries
            .filter((entry: any) => ids.has(String(entry.id)))
            .map((entry: any) => ({
              id: entry.id,
              vector_ids: entry.vector_ids ?? "[]",
              tags: entry.tags ?? "[]",
            }));
          return { results };
        }
        if (
          s.includes("SELECT id, content, tags, source, created_at") &&
          s.includes("FROM entries WHERE id IN") &&
          !s.includes("tags NOT LIKE")
        ) {
          const ids = new Set(args.map(String));
          const results = db.entries
            .filter((entry: any) => ids.has(String(entry.id)))
            .map((entry: any) => ({
              id: entry.id,
              content: entry.content,
              tags: entry.tags,
              source: entry.source,
              created_at: entry.created_at,
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
          const cutoff = Number(args[1]);
          const limit = Number(args[args.length - 1]);
          const rows = [...db.entries]
            .filter((e: any) =>
              e.pending_vector_ids === "[]" &&
              e.pending_embedding_fingerprint === pendingFingerprint &&
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
            }));
          return { results: rows };
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
          const results = db.entries
            .filter((e: any) =>
              e.pending_embedding_fingerprint === pendingFingerprint &&
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
        if (s.includes("SELECT id, recall_count, importance_score") && s.includes("WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({
              id: e.id,
              recall_count: e.recall_count ?? 0,
              importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0,
              contradiction_losses: e.contradiction_losses ?? 0,
              classification_confidence: e.classification_confidence ?? null,
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
          const kindMatch = s.match(/tags LIKE '%"(kind:(?:episodic|semantic))"%'/);
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (tags.includes("auto-pattern")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (kindMatch && !tags.includes(kindMatch[1])) return false;
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
          (s.includes("SELECT id, content FROM entries") || s.includes("SELECT id, content, tags FROM entries")) &&
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
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, 50)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags }));
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
    this.observations = [];
    this.memories = [];
    this.memorySources = [];
    this.entities = [];
    this.memoryEntities = [];
    this.entityRelations = [];
    this.factSources = [];
    this.appSettings = {};
    this.vectorCleanupQueue = [];
  }
}
