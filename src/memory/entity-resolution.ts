export interface EntityExternalId {
  provider: string;
  value: string;
}

export interface EntityResolutionDraft {
  name: string;
  entityType: string | null;
  aliases?: string[];
  externalIds?: EntityExternalId[];
}

export interface EntityResolutionCandidate {
  id: string;
  name: string;
  nameNormalized: string;
  entityType: string | null;
  aliases: string[];
  externalIds: EntityExternalId[];
  embedding: number[] | null;
  mentionCount: number;
}

export type EntityResolutionMatch =
  | "canonical"
  | "alias"
  | "external_id"
  | "identity_conflict"
  | "semantic"
  | "lexical"
  | "none";

export interface RankedEntityCandidate {
  entityId: string;
  score: number;
  matchedBy: Exclude<EntityResolutionMatch, "none">;
}

export interface EntityResolutionDecision {
  action: "use_existing" | "create" | "review";
  entityId: string | null;
  matchedBy: EntityResolutionMatch;
  confidence: number;
  candidates: RankedEntityCandidate[];
}

export interface EntityResolutionOptions {
  queryEmbedding?: number[] | null;
  semanticReviewThreshold?: number;
  lexicalReviewThreshold?: number;
}

export const ENTITY_RESOLUTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_entity_aliases (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    alias_normalized TEXT NOT NULL,
    source_observation_id TEXT,
    confidence REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(entity_id, alias_normalized)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entity_aliases_lookup
    ON sb_entity_aliases(alias_normalized, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity
    ON sb_entity_aliases(entity_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_entity_alias_sources (
    id TEXT PRIMARY KEY,
    alias_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'supports',
    created_at INTEGER NOT NULL,
    UNIQUE(alias_id, observation_id, relation)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entity_alias_sources_alias
    ON sb_entity_alias_sources(alias_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_alias_sources_observation
    ON sb_entity_alias_sources(observation_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_entity_external_ids (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    source_observation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(entity_id, provider, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entity_external_ids_lookup
    ON sb_entity_external_ids(provider, external_id, updated_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_external_ids_identity
    ON sb_entity_external_ids(provider, external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_external_ids_entity
    ON sb_entity_external_ids(entity_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_entity_external_id_sources (
    id TEXT PRIMARY KEY,
    external_id_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'supports',
    created_at INTEGER NOT NULL,
    UNIQUE(external_id_id, observation_id, relation)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entity_external_id_sources_external
    ON sb_entity_external_id_sources(external_id_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_external_id_sources_observation
    ON sb_entity_external_id_sources(observation_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_entity_embeddings (
    entity_id TEXT NOT NULL,
    embedding_fingerprint TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(entity_id, embedding_fingerprint)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entity_embeddings_profile
    ON sb_entity_embeddings(embedding_fingerprint, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_entity_merge_candidates (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    matched_by TEXT NOT NULL,
    score REAL,
    reason_json TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'pending',
    source_observation_id TEXT,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (state IN ('pending', 'accepted', 'rejected', 'merged')),
    UNIQUE(source_entity_id, target_entity_id, state)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entity_merge_candidates_state
    ON sb_entity_merge_candidates(state, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_merge_candidates_source
    ON sb_entity_merge_candidates(source_entity_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_merge_candidates_target
    ON sb_entity_merge_candidates(target_entity_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_entity_merge_history (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    candidate_id TEXT,
    actor_type TEXT NOT NULL,
    reason TEXT,
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entity_merge_history_source
    ON sb_entity_merge_history(source_entity_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_merge_history_target
    ON sb_entity_merge_history(target_entity_id, created_at DESC)`,
] as const;

export interface EntityResolverContext {
  now: number;
  observationId?: string | null;
  embedding?: number[] | null;
  embeddingFingerprint?: string | null;
}

export interface EntityResolution {
  entityId: string;
  canonicalName: string;
  created: boolean;
  decision: EntityResolutionDecision;
}

export interface EntityResolver {
  resolve(draft: EntityResolutionDraft, context: EntityResolverContext): Promise<EntityResolution>;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeExternalId(value: EntityExternalId): string {
  return `${normalize(value.provider)}\u001f${normalize(value.value)}`;
}

function entityTypesCompatible(left: string | null, right: string | null): boolean {
  return left == null || right == null || normalize(left) === normalize(right);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function bigrams(value: string): Set<string> {
  const normalized = normalize(value).replace(/\s+/g, "");
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  const out = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    out.add(normalized.slice(index, index + 2));
  }
  return out;
}

function diceSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return (2 * overlap) / (a.size + b.size);
}

function exactDecision(
  matches: EntityResolutionCandidate[],
  matchedBy: "canonical" | "alias" | "external_id"
): EntityResolutionDecision | null {
  const unique = [...new Map(matches.map((candidate) => [candidate.id, candidate])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  if (unique.length === 0) return null;
  if (unique.length === 1) {
    return {
      action: "use_existing",
      entityId: unique[0].id,
      matchedBy,
      confidence: 1,
      candidates: [{ entityId: unique[0].id, score: 1, matchedBy }],
    };
  }
  return {
    action: "review",
    entityId: null,
    matchedBy,
    confidence: 1,
    candidates: unique.map((candidate) => ({ entityId: candidate.id, score: 1, matchedBy })),
  };
}

export function decideEntityResolution(
  draft: EntityResolutionDraft,
  candidates: EntityResolutionCandidate[],
  options: EntityResolutionOptions = {}
): EntityResolutionDecision {
  const compatible = candidates.filter((candidate) =>
    entityTypesCompatible(draft.entityType, candidate.entityType)
  );
  const normalizedName = normalize(draft.name);
  const canonicalMatches = compatible.filter(
    (candidate) => candidate.nameNormalized === normalizedName
  );
  const aliasMatches = compatible.filter((candidate) =>
    candidate.aliases.some((alias) => normalize(alias) === normalizedName)
  );
  const requestedExternalIds = new Set((draft.externalIds ?? []).map(normalizeExternalId));
  const externalMatches = requestedExternalIds.size > 0
    ? compatible.filter((candidate) =>
        candidate.externalIds.some((externalId) =>
          requestedExternalIds.has(normalizeExternalId(externalId))
        )
      )
    : [];
  const exactGroups = [canonicalMatches, aliasMatches, externalMatches]
    .filter((group) => group.length > 0);
  const exactUnion = [...new Map(
    exactGroups.flat().map((candidate) => [candidate.id, candidate])
  ).values()].sort((left, right) => left.id.localeCompare(right.id));
  if (exactGroups.length > 1 && exactUnion.length > 1) {
    return {
      action: "review",
      entityId: null,
      matchedBy: "identity_conflict",
      confidence: 1,
      candidates: exactUnion.map((candidate) => ({
        entityId: candidate.id,
        score: 1,
        matchedBy: "identity_conflict",
      })),
    };
  }

  const canonical = exactDecision(canonicalMatches, "canonical");
  if (canonical) return canonical;

  const aliases = exactDecision(
    aliasMatches,
    "alias"
  );
  if (aliases) return aliases;

  if (requestedExternalIds.size > 0) {
    const external = exactDecision(externalMatches, "external_id");
    if (external) return external;
  }

  const semanticThreshold = options.semanticReviewThreshold ?? 0.88;
  const semantic = options.queryEmbedding
    ? compatible
        .filter((candidate) => candidate.embedding != null)
        .map((candidate) => ({
          entityId: candidate.id,
          score: cosineSimilarity(options.queryEmbedding as number[], candidate.embedding as number[]),
          matchedBy: "semantic" as const,
        }))
        .filter((candidate) => candidate.score >= semanticThreshold)
        .sort((left, right) => right.score - left.score || left.entityId.localeCompare(right.entityId))
        .slice(0, 10)
    : [];
  if (semantic.length > 0) {
    return {
      action: "review",
      entityId: null,
      matchedBy: "semantic",
      confidence: semantic[0].score,
      candidates: semantic,
    };
  }

  const lexicalThreshold = options.lexicalReviewThreshold ?? 0.86;
  const lexical = compatible
    .map((candidate) => ({
      entityId: candidate.id,
      score: diceSimilarity(draft.name, candidate.name),
      matchedBy: "lexical" as const,
    }))
    .filter((candidate) => candidate.score >= lexicalThreshold)
    .sort((left, right) => right.score - left.score || left.entityId.localeCompare(right.entityId))
    .slice(0, 10);
  if (lexical.length > 0) {
    return {
      action: "review",
      entityId: null,
      matchedBy: "lexical",
      confidence: lexical[0].score,
      candidates: lexical,
    };
  }

  return {
    action: "create",
    entityId: null,
    matchedBy: "none",
    confidence: 1,
    candidates: [],
  };
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseExternalIds(value: unknown): EntityExternalId[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const list = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).external_ids
      : [];
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const provider = String((item as Record<string, unknown>).provider ?? "").trim();
      const externalId = String((item as Record<string, unknown>).value ?? "").trim();
      return provider && externalId ? [{ provider, value: externalId }] : [];
    });
  } catch {
    return [];
  }
}

function mergeExternalIds(left: EntityExternalId[], right: EntityExternalId[]): EntityExternalId[] {
  return [...new Map([...left, ...right].map((item) => [normalizeExternalId(item), item])).values()];
}

function normalizedExternalIds(items: EntityExternalId[] | undefined): EntityExternalId[] {
  return mergeExternalIds([], (items ?? []).flatMap((item) => {
    const provider = String(item.provider ?? "").trim();
    const value = String(item.value ?? "").trim();
    return provider && value ? [{ provider, value }] : [];
  }));
}

interface EntityRow {
  id: string;
  name: string;
  name_normalized: string;
  entity_type: string | null;
  aliases_json: string;
  metadata_json: string;
  mention_count: number;
}

export class D1EntityResolver implements EntityResolver {
  private readonly candidateCache = new Map<
    string,
    Array<{ row: EntityRow; candidate: EntityResolutionCandidate }>
  >();
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly db: D1Database) {}

  async resolve(
    draft: EntityResolutionDraft,
    context: EntityResolverContext
  ): Promise<EntityResolution> {
    await this.ensureSchema();
    const name = String(draft.name ?? "").trim();
    if (!name || name.length > 120) throw new Error("Invalid entity name");
    const entityType = draft.entityType ? normalize(draft.entityType) : null;
    let rows = await this.loadExactCandidates({ ...draft, name, entityType });
    let decision = decideEntityResolution(
      { ...draft, name, entityType },
      rows.map((item) => item.candidate)
    );
    if (decision.action === "create") {
      rows = await this.loadCandidates(context.embeddingFingerprint ?? null);
      decision = decideEntityResolution(
        { ...draft, name, entityType },
        rows.map((item) => item.candidate),
        { queryEmbedding: context.embedding ?? null }
      );
    }

    const existing = decision.action === "use_existing"
      ? rows.find((item) => item.candidate.id === decision.entityId)?.row ?? null
      : null;
    const entityId = existing?.id ?? crypto.randomUUID();
    const created = existing == null;
    if (existing) {
      await this.db.prepare(
        `UPDATE sb_entities
         SET mention_count = COALESCE(mention_count, 0) + 1,
             entity_type = COALESCE(?, entity_type),
             updated_at = ?
         WHERE id = ?`
      ).bind(entityType, context.now, entityId).run();
    } else {
      const normalizedName = normalize(name);
      const hasSameNameCollision = rows.some((item) => normalize(item.row.name) === normalizedName);
      const storageKey = hasSameNameCollision
        ? `${normalizedName}\u001f${entityType ?? "unknown"}\u001f${entityId}`
        : normalizedName;
      await this.db.prepare(
        `INSERT INTO sb_entities (
           id, name, name_normalized, entity_type, aliases_json, metadata_json,
           mention_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, '[]', '{}', 1, ?, ?)`
      ).bind(entityId, name, storageKey, entityType, context.now, context.now).run();
    }

    const aliases = [...new Set((draft.aliases ?? []).map((item) => String(item).trim()).filter(Boolean))]
      .filter((alias) => normalize(alias) !== normalize(existing?.name ?? name));
    const externalIds = normalizedExternalIds(draft.externalIds);
    await this.persistIdentityMetadata(
      entityId,
      decision.action === "review" ? [] : aliases,
      decision.action === "review" ? [] : externalIds,
      context
    );
    await this.persistEmbedding(entityId, context);
    if (decision.action === "review") {
      await this.persistMergeCandidates(entityId, decision, context);
    }
    this.updateCandidateCache(
      entityId,
      existing?.name ?? name,
      entityType,
      decision.action === "review" ? { ...draft, aliases: [], externalIds: [] } : draft,
      context
    );

    return {
      entityId,
      canonicalName: existing?.name ?? name,
      created,
      decision,
    };
  }

  private ensureSchema(): Promise<void> {
    return (this.schemaReady ??= (async () => {
      const exists = await this.db.prepare(
        `SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = 'sb_entity_aliases'
         LIMIT 1`
      ).first<{ "1": number }>();
      if (!exists) {
        await this.db.exec(ENTITY_RESOLUTION_SCHEMA_STATEMENTS.join(";\n"));
      }
    })().catch((error) => {
      this.schemaReady = null;
      throw error;
    }));
  }

  private async loadCandidates(
    fingerprint: string | null
  ): Promise<Array<{ row: EntityRow; candidate: EntityResolutionCandidate }>> {
    const cacheKey = fingerprint ?? "";
    const cached = this.candidateCache.get(cacheKey);
    if (cached) return cached;
    const { results } = await this.db.prepare(
      `SELECT id, name, name_normalized, entity_type, aliases_json,
              metadata_json, mention_count
       FROM sb_entities
       ORDER BY mention_count DESC, updated_at DESC
       LIMIT 1000`
    ).all<EntityRow>();
    const embeddingByEntity = new Map<string, number[]>();
    if (fingerprint) {
      const embeddings = await this.db.prepare(
        `SELECT entity_id, embedding_json
         FROM sb_entity_embeddings
         WHERE embedding_fingerprint = ?
         ORDER BY updated_at DESC
         LIMIT 1000`
      ).bind(fingerprint).all<{ entity_id: string; embedding_json: string }>();
      for (const row of embeddings.results ?? []) {
        const vector = parseStringArray(row.embedding_json).map(Number).filter(Number.isFinite);
        if (vector.length > 0) embeddingByEntity.set(row.entity_id, vector);
      }
    }
    const loaded = (results ?? []).map((row) => ({
      row,
      candidate: {
        id: row.id,
        name: row.name,
        nameNormalized: normalize(row.name),
        entityType: row.entity_type,
        aliases: parseStringArray(row.aliases_json),
        externalIds: parseExternalIds(row.metadata_json),
        embedding: embeddingByEntity.get(row.id) ?? null,
        mentionCount: Number(row.mention_count ?? 0),
      },
    }));
    this.candidateCache.set(cacheKey, loaded);
    return loaded;
  }

  private updateCandidateCache(
    entityId: string,
    name: string,
    entityType: string | null,
    draft: EntityResolutionDraft,
    context: EntityResolverContext
  ): void {
    for (const [fingerprint, rows] of this.candidateCache) {
      const index = rows.findIndex((item) => item.candidate.id === entityId);
      const previous = index >= 0 ? rows[index].candidate : null;
      const aliases = [...new Set([...(previous?.aliases ?? []), ...(draft.aliases ?? [])])];
      const externalIds = mergeExternalIds(previous?.externalIds ?? [], normalizedExternalIds(draft.externalIds));
      const candidate: EntityResolutionCandidate = {
        id: entityId,
        name,
        nameNormalized: normalize(name),
        entityType: entityType ?? previous?.entityType ?? null,
        aliases,
        externalIds,
        embedding: context.embeddingFingerprint === fingerprint
          ? context.embedding ?? null
          : previous?.embedding ?? null,
        mentionCount: Number(previous?.mentionCount ?? 0) + 1,
      };
      const row: EntityRow = {
        id: entityId,
        name,
        name_normalized: normalize(name),
        entity_type: candidate.entityType,
        aliases_json: JSON.stringify(aliases),
        metadata_json: JSON.stringify({ external_ids: externalIds }),
        mention_count: candidate.mentionCount,
      };
      if (index >= 0) rows[index] = { row, candidate };
      else rows.push({ row, candidate });
    }
  }

  private async loadExactCandidates(
    draft: EntityResolutionDraft
  ): Promise<Array<{ row: EntityRow; candidate: EntityResolutionCandidate }>> {
    const rowsById = new Map<string, EntityRow>();
    const canonical = await this.db.prepare(
      `SELECT id, name, name_normalized, entity_type, aliases_json,
              metadata_json, mention_count
       FROM sb_entities
       WHERE name_normalized = ? OR name_normalized LIKE ?
       ORDER BY mention_count DESC, updated_at DESC
       LIMIT 20`
    ).bind(normalize(draft.name), `${normalize(draft.name)}\u001f%`).all<EntityRow>();
    for (const row of canonical.results ?? []) rowsById.set(row.id, row);

    const aliases = await this.db.prepare(
      `SELECT e.id, e.name, e.name_normalized, e.entity_type, e.aliases_json,
              e.metadata_json, e.mention_count
       FROM sb_entity_aliases a
       JOIN sb_entities e ON e.id = a.entity_id
       WHERE a.alias_normalized = ?
       ORDER BY e.mention_count DESC, e.updated_at DESC
       LIMIT 20`
    ).bind(normalize(draft.name)).all<EntityRow>();
    for (const row of aliases.results ?? []) rowsById.set(row.id, row);

    for (const externalId of normalizedExternalIds(draft.externalIds)) {
      const external = await this.db.prepare(
        `SELECT e.id, e.name, e.name_normalized, e.entity_type, e.aliases_json,
                e.metadata_json, e.mention_count
         FROM sb_entity_external_ids x
         JOIN sb_entities e ON e.id = x.entity_id
         WHERE x.provider = ? AND x.external_id = ?
         ORDER BY e.mention_count DESC, e.updated_at DESC
         LIMIT 20`
      ).bind(normalize(externalId.provider), externalId.value).all<EntityRow>();
      for (const row of external.results ?? []) rowsById.set(row.id, row);
    }
    return [...rowsById.values()].map((row) => ({
      row,
      candidate: {
        id: row.id,
        name: row.name,
        nameNormalized: normalize(row.name),
        entityType: row.entity_type,
        aliases: parseStringArray(row.aliases_json),
        externalIds: parseExternalIds(row.metadata_json),
        embedding: null,
        mentionCount: Number(row.mention_count ?? 0),
      },
    }));
  }

  private async persistIdentityMetadata(
    entityId: string,
    aliases: string[],
    externalIds: EntityExternalId[],
    context: EntityResolverContext
  ): Promise<void> {
    const current = await this.db.prepare(
      `SELECT aliases_json, metadata_json FROM sb_entities WHERE id = ?`
    ).bind(entityId).first<{ aliases_json: string; metadata_json: string }>();
    const mergedAliases = [...new Set([...parseStringArray(current?.aliases_json), ...aliases])];
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(current?.metadata_json ?? "{}");
    } catch {
      metadata = {};
    }
    const mergedExternalIds = mergeExternalIds(parseExternalIds(metadata), externalIds);
    const nextMetadata = { ...metadata, external_ids: mergedExternalIds };
    await this.db.prepare(
      `UPDATE sb_entities
       SET aliases_json = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`
    ).bind(JSON.stringify(mergedAliases), JSON.stringify(nextMetadata), context.now, entityId).run();

    for (const alias of aliases) {
      await this.db.prepare(
        `INSERT INTO sb_entity_aliases (
           id, entity_id, alias, alias_normalized, source_observation_id,
           confidence, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(entity_id, alias_normalized) DO UPDATE SET
           alias = excluded.alias,
           source_observation_id = COALESCE(source_observation_id, excluded.source_observation_id),
           updated_at = excluded.updated_at`
      ).bind(
        crypto.randomUUID(), entityId, alias, normalize(alias),
        context.observationId ?? null, context.now, context.now
      ).run();
      if (context.observationId) {
        const identity = await this.db.prepare(
          `SELECT id FROM sb_entity_aliases
           WHERE entity_id = ? AND alias_normalized = ?
           LIMIT 1`
        ).bind(entityId, normalize(alias)).first<{ id: string }>();
        if (identity?.id) {
          await this.db.prepare(
            `INSERT OR IGNORE INTO sb_entity_alias_sources (
               id, alias_id, observation_id, relation, created_at
             ) VALUES (?, ?, ?, 'supports', ?)`
          ).bind(crypto.randomUUID(), identity.id, context.observationId, context.now).run();
        }
      }
    }
    for (const externalId of externalIds) {
      await this.db.prepare(
        `INSERT INTO sb_entity_external_ids (
           id, entity_id, provider, external_id, source_observation_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id, provider, external_id) DO UPDATE SET
           source_observation_id = COALESCE(source_observation_id, excluded.source_observation_id),
           updated_at = excluded.updated_at`
      ).bind(
        crypto.randomUUID(), entityId, normalize(externalId.provider), externalId.value.trim(),
        context.observationId ?? null, context.now, context.now
      ).run();
      if (context.observationId) {
        const identity = await this.db.prepare(
          `SELECT id FROM sb_entity_external_ids
           WHERE entity_id = ? AND provider = ? AND external_id = ?
           LIMIT 1`
        ).bind(entityId, normalize(externalId.provider), externalId.value.trim()).first<{ id: string }>();
        if (identity?.id) {
          await this.db.prepare(
            `INSERT OR IGNORE INTO sb_entity_external_id_sources (
               id, external_id_id, observation_id, relation, created_at
             ) VALUES (?, ?, ?, 'supports', ?)`
          ).bind(crypto.randomUUID(), identity.id, context.observationId, context.now).run();
        }
      }
    }
  }

  private async persistEmbedding(entityId: string, context: EntityResolverContext): Promise<void> {
    const embedding = context.embedding?.map(Number).filter(Number.isFinite) ?? [];
    const fingerprint = context.embeddingFingerprint?.trim();
    if (!fingerprint || embedding.length === 0) return;
    await this.db.prepare(
      `INSERT INTO sb_entity_embeddings (
         entity_id, embedding_fingerprint, embedding_json, dimensions, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, embedding_fingerprint) DO UPDATE SET
         embedding_json = excluded.embedding_json,
         dimensions = excluded.dimensions,
         updated_at = excluded.updated_at`
    ).bind(entityId, fingerprint, JSON.stringify(embedding), embedding.length, context.now).run();
  }

  private async persistMergeCandidates(
    sourceEntityId: string,
    decision: EntityResolutionDecision,
    context: EntityResolverContext
  ): Promise<void> {
    for (const candidate of decision.candidates.slice(0, 10)) {
      if (candidate.entityId === sourceEntityId) continue;
      await this.db.prepare(
        `INSERT OR IGNORE INTO sb_entity_merge_candidates (
           id, source_entity_id, target_entity_id, matched_by, score,
           reason_json, state, source_observation_id, reviewed_by, reviewed_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`
      ).bind(
        crypto.randomUUID(), sourceEntityId, candidate.entityId, candidate.matchedBy,
        candidate.score, JSON.stringify(["review_required", `matched_by:${candidate.matchedBy}`]),
        context.observationId ?? null, context.now, context.now
      ).run();
    }
  }
}
