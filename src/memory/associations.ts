import { activeMemoryClaimPredicate } from "./claim-eligibility";

export const ASSOCIATION_EDGE_TYPES = [
  "related_to",
  "continuation_of",
  "part_of_project",
  "follows",
  "references",
  "manual",
] as const;

export type AssociationEdgeType = (typeof ASSOCIATION_EDGE_TYPES)[number];

export const ASSOCIATION_PROVENANCE_VALUES = [
  "manual",
  "inferred",
  "system",
  "provider",
] as const;

export type AssociationProvenance = (typeof ASSOCIATION_PROVENANCE_VALUES)[number];
export const ASSOCIATION_DIRECTIONS = ["outgoing", "incoming", "both"] as const;
export type AssociationDirection = (typeof ASSOCIATION_DIRECTIONS)[number];

const SYMMETRIC_EDGE_TYPES = new Set<AssociationEdgeType>(["related_to", "manual"]);
const DEFAULT_WEIGHT = 0.5;
const DEFAULT_FANOUT = 8;
const DEFAULT_MAX_NODES = 40;
const MAX_HOPS = 2;
const D1_BINDING_CHUNK = 80;

export const ASSOCIATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_association_edges (
    id TEXT PRIMARY KEY,
    source_parent_id TEXT NOT NULL,
    target_parent_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 0.5,
    provenance TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    directed INTEGER NOT NULL DEFAULT 0,
    valid_from INTEGER,
    valid_to INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_parent_id, target_parent_id, edge_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_association_edges_target
    ON sb_association_edges(target_parent_id, weight DESC, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_association_edge_history (
    id TEXT PRIMARY KEY,
    source_parent_id TEXT NOT NULL,
    target_parent_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    weight REAL NOT NULL,
    provenance TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    directed INTEGER NOT NULL,
    valid_from INTEGER,
    valid_to INTEGER,
    deleted_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_association_edge_history_endpoints
    ON sb_association_edge_history(source_parent_id, target_parent_id, deleted_at)`,
] as const;

const ASSOCIATION_EDGE_TIMELINE_SQL = `(
  SELECT id, source_parent_id, target_parent_id, edge_type, weight,
         provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
         created_at, updated_at
  FROM sb_association_edges
  UNION ALL
  SELECT id, source_parent_id, target_parent_id, edge_type, weight,
         provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
         created_at, updated_at
  FROM sb_association_edge_history
)`;

const ASSOCIATION_COLUMN_MIGRATIONS = [
  { column: "directed", statement: `ALTER TABLE sb_association_edges ADD COLUMN directed INTEGER NOT NULL DEFAULT 0` },
  { column: "valid_from", statement: `ALTER TABLE sb_association_edges ADD COLUMN valid_from INTEGER` },
  { column: "valid_to", statement: `ALTER TABLE sb_association_edges ADD COLUMN valid_to INTEGER` },
  { column: "deleted_at", statement: `ALTER TABLE sb_association_edges ADD COLUMN deleted_at INTEGER` },
] as const;

const initializedAssociationDatabases = new WeakSet<object>();

export class AssociationEndpointUnavailableError extends Error {
  constructor(endpoint: string, reason = "missing or inactive") {
    super(`Association endpoint ${endpoint} is ${reason}`);
    this.name = "AssociationEndpointUnavailableError";
  }
}

export interface AssociationEdgeInput {
  source: string;
  target: string;
  edgeType: AssociationEdgeType;
  weight?: number;
  provenance: AssociationProvenance;
  metadata?: Record<string, unknown>;
  createdAt?: number;
  asOf?: number;
  validFrom?: number | null;
  validTo?: number | null;
}

export interface AssociationEdgeRecord {
  id: string;
  sourceParentId: string;
  targetParentId: string;
  edgeType: AssociationEdgeType;
  weight: number;
  provenance: AssociationProvenance;
  metadata: Record<string, unknown>;
  directed: boolean;
  validFrom: number;
  validTo: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AssociationParentView {
  parentId: string;
  entryId: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: number;
}

export interface AssociationConnection extends AssociationParentView {
  edgeId: string;
  edgeType: AssociationEdgeType;
  direction: "incoming" | "outgoing";
  weight: number;
  provenance: AssociationProvenance;
  metadata: Record<string, unknown>;
}

export interface AssociationExpansion {
  parentId: string;
  seedParentId: string;
  hop: number;
  viaType: AssociationEdgeType;
  viaWeight: number;
  pathWeight: number;
}

export interface AssociationRecallResult extends AssociationParentView {
  score: number;
  seedParentId: string;
  hop: number;
  viaType: AssociationEdgeType;
  viaWeight: number;
}

interface AssociationEdgeRow {
  id: string;
  source_parent_id: string;
  target_parent_id: string;
  edge_type: AssociationEdgeType;
  weight: number;
  provenance: AssociationProvenance;
  metadata_json: string;
  directed: number;
  valid_from: number | null;
  valid_to: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ParentEntryRow {
  parent_id: string;
  entry_id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
}

function isAssociationEdgeType(value: string): value is AssociationEdgeType {
  return (ASSOCIATION_EDGE_TYPES as readonly string[]).includes(value);
}

function isAssociationProvenance(value: string): value is AssociationProvenance {
  return (ASSOCIATION_PROVENANCE_VALUES as readonly string[]).includes(value);
}

function normalizeWeight(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WEIGHT;
  if (!Number.isFinite(value)) throw new Error("Association weight must be finite");
  return Math.max(0, Math.min(1, value));
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseTags(raw: string): string[] {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function safeAsOf(value: number | undefined): number {
  const asOf = value ?? Date.now();
  return Number.isFinite(asOf) ? Math.max(0, Math.trunc(asOf)) : Date.now();
}

export async function ensureAssociationDataModel(db: D1Database): Promise<void> {
  if (initializedAssociationDatabases.has(db as object)) return;
  for (const statement of ASSOCIATION_SCHEMA_STATEMENTS) await db.exec(statement);
  const { results: columnRows } = await db.prepare(
    `PRAGMA table_info(sb_association_edges)`
  ).all<{ name: string }>();
  const columns = new Set(columnRows.map((row) => row.name));
  for (const migration of ASSOCIATION_COLUMN_MIGRATIONS) {
    if (columns.has(migration.column)) continue;
    try {
      await db.exec(migration.statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
  await db.exec(
    `UPDATE sb_association_edges
     SET directed = CASE
       WHEN edge_type IN ('related_to', 'manual') THEN 0
       ELSE 1
     END,
         valid_from = COALESCE(valid_from, created_at)`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_association_edges_validity
     ON sb_association_edges(valid_from, valid_to, deleted_at)`
  );
  initializedAssociationDatabases.add(db as object);
}

async function activeParentIdsForEndpoint(
  db: D1Database,
  endpoint: string,
  asOf: number
): Promise<string[]> {
  const predicate = activeMemoryClaimPredicate("m_endpoint", String(asOf), {
    requireActiveParentLink: true,
  });
  const { results } = await db.prepare(
    `SELECT DISTINCT pu_endpoint.parent_id
     FROM sb_parent_units pu_endpoint
     JOIN sb_parent_versions pv_endpoint
       ON pv_endpoint.parent_id = pu_endpoint.parent_id
     JOIN sb_parent_version_claims pvc_endpoint
       ON pvc_endpoint.parent_version_id = pv_endpoint.version_id
      AND pvc_endpoint.relation = 'supports'
     JOIN sb_memories m_endpoint ON m_endpoint.id = pvc_endpoint.memory_id
     JOIN entries e_endpoint
       ON e_endpoint.id = m_endpoint.entry_id
      AND e_endpoint.content_hash = m_endpoint.content_hash
     WHERE (pu_endpoint.parent_id = ? OR m_endpoint.entry_id = ?)
       AND ${predicate}
     ORDER BY pu_endpoint.parent_id`
  ).bind(endpoint, endpoint).all<{ parent_id: string }>();
  return results.map((row) => row.parent_id);
}

export async function resolveActiveAssociationParent(
  db: D1Database,
  endpoint: string,
  asOf = Date.now()
): Promise<string> {
  const normalized = endpoint.trim();
  if (!normalized) throw new AssociationEndpointUnavailableError(endpoint, "empty");
  const candidates = await activeParentIdsForEndpoint(db, normalized, safeAsOf(asOf));
  if (!candidates.length) throw new AssociationEndpointUnavailableError(normalized);
  if (candidates.includes(normalized)) return normalized;
  if (candidates.length !== 1) {
    throw new AssociationEndpointUnavailableError(normalized, "ambiguous across active parents");
  }
  return candidates[0];
}

function normalizeEndpoints(
  sourceParentId: string,
  targetParentId: string,
  edgeType: AssociationEdgeType
): [string, string] {
  if (sourceParentId === targetParentId) throw new Error("Association cannot link to itself");
  if (SYMMETRIC_EDGE_TYPES.has(edgeType) && sourceParentId > targetParentId) {
    return [targetParentId, sourceParentId];
  }
  return [sourceParentId, targetParentId];
}

export async function createAssociationEdge(
  db: D1Database,
  input: AssociationEdgeInput
): Promise<AssociationEdgeRecord> {
  await ensureAssociationDataModel(db);
  if (!isAssociationEdgeType(input.edgeType)) throw new Error("Unsupported association edge type");
  if (!isAssociationProvenance(input.provenance)) throw new Error("Unsupported association provenance");
  const asOf = safeAsOf(input.asOf ?? input.createdAt);
  const [resolvedSource, resolvedTarget] = await Promise.all([
    resolveActiveAssociationParent(db, input.source, asOf),
    resolveActiveAssociationParent(db, input.target, asOf),
  ]);
  const [sourceParentId, targetParentId] = normalizeEndpoints(
    resolvedSource,
    resolvedTarget,
    input.edgeType
  );
  const createdAt = safeAsOf(input.createdAt);
  const validFrom = safeAsOf(input.validFrom ?? createdAt);
  const validTo = input.validTo == null ? null : safeAsOf(input.validTo);
  if (validTo != null && validTo <= validFrom) {
    throw new Error("Association validTo must be later than validFrom");
  }
  const weight = normalizeWeight(input.weight);
  const id = crypto.randomUUID();
  const metadata = { ...(input.metadata ?? {}) };
  const directed = SYMMETRIC_EDGE_TYPES.has(input.edgeType) ? 0 : 1;

  const closedEdge = await db.prepare(
    `SELECT id, deleted_at
     FROM sb_association_edges
     WHERE source_parent_id = ? AND target_parent_id = ? AND edge_type = ?
       AND deleted_at IS NOT NULL`
  ).bind(sourceParentId, targetParentId, input.edgeType).first<{
    id: string;
    deleted_at: number;
  }>();
  if (closedEdge) {
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO sb_association_edge_history (
           id, source_parent_id, target_parent_id, edge_type, weight,
           provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
           created_at, updated_at
         )
         SELECT id, source_parent_id, target_parent_id, edge_type, weight,
                provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
                created_at, updated_at
         FROM sb_association_edges
         WHERE id = ? AND deleted_at = ?`
      ).bind(closedEdge.id, closedEdge.deleted_at),
      db.prepare(
        `DELETE FROM sb_association_edges
         WHERE id = ? AND deleted_at = ?`
      ).bind(closedEdge.id, closedEdge.deleted_at),
    ]);
  }

  await db.prepare(
    `INSERT INTO sb_association_edges (
       id, source_parent_id, target_parent_id, edge_type, weight,
       provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(source_parent_id, target_parent_id, edge_type) DO UPDATE SET
       weight = MAX(sb_association_edges.weight, excluded.weight),
       provenance = CASE
         WHEN excluded.provenance = 'manual' THEN excluded.provenance
         WHEN sb_association_edges.provenance = 'manual' THEN sb_association_edges.provenance
         WHEN excluded.weight >= sb_association_edges.weight THEN excluded.provenance
         ELSE sb_association_edges.provenance
       END,
       metadata_json = CASE
         WHEN excluded.weight >= sb_association_edges.weight THEN excluded.metadata_json
         ELSE sb_association_edges.metadata_json
       END,
       directed = excluded.directed,
       valid_from = CASE
         WHEN sb_association_edges.deleted_at IS NOT NULL THEN excluded.valid_from
         ELSE MIN(COALESCE(sb_association_edges.valid_from, excluded.valid_from), excluded.valid_from)
       END,
       valid_to = excluded.valid_to,
       deleted_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    sourceParentId,
    targetParentId,
    input.edgeType,
    weight,
    input.provenance,
    JSON.stringify(metadata),
    directed,
    validFrom,
    validTo,
    createdAt,
    createdAt
  ).run();

  const row = await db.prepare(
    `SELECT id, source_parent_id, target_parent_id, edge_type, weight,
            provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
            created_at, updated_at
     FROM sb_association_edges
     WHERE source_parent_id = ? AND target_parent_id = ? AND edge_type = ?`
  ).bind(sourceParentId, targetParentId, input.edgeType).first<AssociationEdgeRow>();
  if (!row) throw new Error("Association edge upsert failed");
  return {
    id: row.id,
    sourceParentId: row.source_parent_id,
    targetParentId: row.target_parent_id,
    edgeType: row.edge_type,
    weight: Number(row.weight),
    provenance: row.provenance,
    metadata: parseObject(row.metadata_json),
    directed: Boolean(row.directed),
    validFrom: Number(row.valid_from ?? row.created_at),
    validTo: row.valid_to == null ? null : Number(row.valid_to),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function hydrateAssociationParents(
  db: D1Database,
  parentIds: string[],
  asOf = Date.now()
): Promise<Map<string, AssociationParentView>> {
  const unique = [...new Set(parentIds.map((id) => id.trim()).filter(Boolean))];
  const output = new Map<string, AssociationParentView>();
  const timestamp = safeAsOf(asOf);
  const predicate = activeMemoryClaimPredicate("m_association", String(timestamp), {
    requireActiveParentLink: true,
  });
  for (let offset = 0; offset < unique.length; offset += D1_BINDING_CHUNK) {
    const batch = unique.slice(offset, offset + D1_BINDING_CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await db.prepare(
      `SELECT pu_association.parent_id, m_association.entry_id,
              e_association.content, e_association.tags, e_association.source,
              e_association.created_at
       FROM sb_parent_units pu_association
       JOIN sb_parent_versions pv_association
         ON pv_association.parent_id = pu_association.parent_id
       JOIN sb_parent_version_claims pvc_association
         ON pvc_association.parent_version_id = pv_association.version_id
        AND pvc_association.relation = 'supports'
       JOIN sb_memories m_association ON m_association.id = pvc_association.memory_id
       JOIN entries e_association
         ON e_association.id = m_association.entry_id
        AND e_association.content_hash = m_association.content_hash
       WHERE pu_association.parent_id IN (${placeholders})
         AND ${predicate}
       ORDER BY COALESCE(m_association.importance, 0) DESC,
                COALESCE(m_association.confidence, 0) DESC,
                m_association.created_at DESC`
    ).bind(...batch).all<ParentEntryRow>();
    for (const row of results) {
      if (output.has(row.parent_id)) continue;
      output.set(row.parent_id, {
        parentId: row.parent_id,
        entryId: row.entry_id,
        content: row.content,
        tags: parseTags(row.tags),
        source: row.source,
        createdAt: Number(row.created_at),
      });
    }
  }
  return output;
}

export async function listAssociationConnections(
  db: D1Database,
  endpoint: string,
  options: {
    edgeType?: AssociationEdgeType;
    direction?: AssociationDirection;
    limit?: number;
    asOf?: number;
  } = {}
): Promise<AssociationConnection[]> {
  await ensureAssociationDataModel(db);
  const asOf = safeAsOf(options.asOf);
  const parentId = await resolveActiveAssociationParent(db, endpoint, asOf);
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  const direction = options.direction ?? "both";
  const directionSql = direction === "outgoing"
    ? `(source_parent_id = ? OR (directed = 0 AND target_parent_id = ?))`
    : direction === "incoming"
      ? `(target_parent_id = ? OR (directed = 0 AND source_parent_id = ?))`
      : `(source_parent_id = ? OR target_parent_id = ?)`;
  let sql = `SELECT id, source_parent_id, target_parent_id, edge_type, weight,
                    provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
                    created_at, updated_at
             FROM ${ASSOCIATION_EDGE_TIMELINE_SQL} association_timeline
             WHERE ${directionSql}
               AND created_at <= ?
               AND COALESCE(valid_from, created_at) <= ?
               AND (valid_to IS NULL OR valid_to > ?)
               AND (deleted_at IS NULL OR deleted_at > ?)`;
  const bindings: Array<string | number> = [parentId, parentId, asOf, asOf, asOf, asOf];
  if (options.edgeType) {
    sql += ` AND edge_type = ?`;
    bindings.push(options.edgeType);
  }
  sql += ` ORDER BY weight DESC, updated_at DESC LIMIT ?`;
  bindings.push(limit);
  const { results } = await db.prepare(sql).bind(...bindings).all<AssociationEdgeRow>();
  const otherIds = results.map((row) =>
    row.source_parent_id === parentId ? row.target_parent_id : row.source_parent_id
  );
  const parents = await hydrateAssociationParents(db, otherIds, asOf);
  return results.flatMap((row) => {
    const outgoing = row.source_parent_id === parentId;
    const otherParentId = outgoing ? row.target_parent_id : row.source_parent_id;
    const parent = parents.get(otherParentId);
    if (!parent) return [];
    return [{
      ...parent,
      edgeId: row.id,
      edgeType: row.edge_type,
      direction: outgoing ? "outgoing" as const : "incoming" as const,
      weight: Number(row.weight),
      provenance: row.provenance,
      metadata: parseObject(row.metadata_json),
    }];
  });
}

export async function deleteAssociationEdge(
  db: D1Database,
  input: { source: string; target: string; edgeType?: AssociationEdgeType; asOf?: number }
): Promise<number> {
  await ensureAssociationDataModel(db);
  const asOf = safeAsOf(input.asOf);
  const [resolvedSource, resolvedTarget] = await Promise.all([
    resolveActiveAssociationParent(db, input.source, asOf),
    resolveActiveAssociationParent(db, input.target, asOf),
  ]);
  const edgeType = input.edgeType;
  const [sourceParentId, targetParentId] = edgeType
    ? normalizeEndpoints(resolvedSource, resolvedTarget, edgeType)
    : [resolvedSource, resolvedTarget];
  let sql = `UPDATE sb_association_edges
             SET deleted_at = ?, updated_at = ?
             WHERE deleted_at IS NULL
               AND created_at <= ?
               AND COALESCE(valid_from, created_at) <= ?
               AND (valid_to IS NULL OR valid_to > ?)
               AND (
                 (source_parent_id = ? AND target_parent_id = ?)
                 OR (directed = 0 AND source_parent_id = ? AND target_parent_id = ?)
               )`;
  const bindings: Array<string | number> = [
    asOf,
    asOf,
    asOf,
    asOf,
    asOf,
    sourceParentId,
    targetParentId,
    targetParentId,
    sourceParentId,
  ];
  if (edgeType) {
    sql += ` AND edge_type = ?`;
    bindings.push(edgeType);
  }
  const result = await db.prepare(sql).bind(...bindings).run();
  return Number(result.meta.changes ?? 0);
}

export async function expandAssociationGraph(
  db: D1Database,
  seedParentIds: string[],
  options: {
    hops: number;
    direction?: AssociationDirection;
    fanoutCap?: number;
    maxNodes?: number;
    asOf?: number;
  }
): Promise<AssociationExpansion[]> {
  const hops = Math.max(0, Math.min(MAX_HOPS, Math.trunc(options.hops)));
  const seeds = [...new Set(seedParentIds.map((id) => id.trim()).filter(Boolean))];
  if (!hops || !seeds.length) return [];
  await ensureAssociationDataModel(db);
  const fanoutCap = Math.max(1, Math.min(Math.trunc(options.fanoutCap ?? DEFAULT_FANOUT), 20));
  const maxNodes = Math.max(1, Math.min(Math.trunc(options.maxNodes ?? DEFAULT_MAX_NODES), 100));
  const asOf = safeAsOf(options.asOf);
  const direction = options.direction ?? "outgoing";
  const activeSeeds = await hydrateAssociationParents(db, seeds, asOf);
  const visited = new Set(activeSeeds.keys());
  const output: AssociationExpansion[] = [];
  let frontier = [...activeSeeds.keys()].map((parentId) => ({
    parentId,
    seedParentId: parentId,
    pathWeight: 1,
  }));

  for (let hop = 1; hop <= hops && frontier.length && output.length < maxNodes; hop++) {
    const frontierIds = frontier.map((item) => item.parentId);
    const placeholders = frontierIds.map(() => "?").join(", ");
    const { results } = await db.prepare(
      `SELECT id, source_parent_id, target_parent_id, edge_type, weight,
              provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
              created_at, updated_at
       FROM ${ASSOCIATION_EDGE_TIMELINE_SQL} association_timeline
       WHERE (source_parent_id IN (${placeholders})
          OR target_parent_id IN (${placeholders}))
         AND created_at <= ?
         AND COALESCE(valid_from, created_at) <= ?
         AND (valid_to IS NULL OR valid_to > ?)
         AND (deleted_at IS NULL OR deleted_at > ?)
       ORDER BY weight DESC, updated_at DESC`
    ).bind(...frontierIds, ...frontierIds, asOf, asOf, asOf, asOf).all<AssociationEdgeRow>();
    const frontierById = new Map(frontier.map((item) => [item.parentId, item]));
    const perNode = new Map<string, number>();
    const candidates: AssociationExpansion[] = [];
    for (const row of results) {
      const transitions: Array<{ from: typeof frontier[number]; nextId: string }> = [];
      const sourceFrontier = frontierById.get(row.source_parent_id);
      const targetFrontier = frontierById.get(row.target_parent_id);
      if (Boolean(row.directed)) {
        if (sourceFrontier && direction !== "incoming") {
          transitions.push({ from: sourceFrontier, nextId: row.target_parent_id });
        }
        if (targetFrontier && direction !== "outgoing") {
          transitions.push({ from: targetFrontier, nextId: row.source_parent_id });
        }
      } else {
        if (sourceFrontier) transitions.push({ from: sourceFrontier, nextId: row.target_parent_id });
        if (targetFrontier) transitions.push({ from: targetFrontier, nextId: row.source_parent_id });
      }
      for (const transition of transitions) {
        if (visited.has(transition.nextId)) continue;
        const used = perNode.get(transition.from.parentId) ?? 0;
        if (used >= fanoutCap) continue;
        perNode.set(transition.from.parentId, used + 1);
        candidates.push({
          parentId: transition.nextId,
          seedParentId: transition.from.seedParentId,
          hop,
          viaType: row.edge_type,
          viaWeight: Number(row.weight),
          pathWeight: transition.from.pathWeight * Number(row.weight),
        });
      }
    }
    const activeCandidates = await hydrateAssociationParents(
      db,
      candidates.map((item) => item.parentId),
      asOf
    );
    const nextFrontier: typeof frontier = [];
    for (const candidate of candidates) {
      if (!activeCandidates.has(candidate.parentId) || visited.has(candidate.parentId)) continue;
      visited.add(candidate.parentId);
      output.push(candidate);
      nextFrontier.push({
        parentId: candidate.parentId,
        seedParentId: candidate.seedParentId,
        pathWeight: candidate.pathWeight,
      });
      if (output.length >= maxNodes) break;
    }
    frontier = nextFrontier;
  }
  return output;
}

export async function associationRecallExpansion(
  db: D1Database,
  directMatches: Array<{ entryId: string; score: number }>,
  options: { hops: number; direction?: AssociationDirection; limit?: number; asOf?: number }
): Promise<AssociationRecallResult[]> {
  const hops = Math.max(0, Math.min(MAX_HOPS, Math.trunc(options.hops)));
  if (!hops || !directMatches.length) return [];
  const resolvedSeeds = await Promise.all(directMatches.map(async (match) => ({
    parentId: await resolveActiveAssociationParent(db, match.entryId, options.asOf),
    entryId: match.entryId,
    score: Math.max(0, Number(match.score) || 0),
  })));
  const seedParentIds = [...new Set(resolvedSeeds.map((seed) => seed.parentId))];
  const expanded = await expandAssociationGraph(db, seedParentIds, {
    hops,
    direction: options.direction,
    asOf: options.asOf,
    maxNodes: Math.max(1, Math.min(Math.trunc(options.limit ?? 20), 40)),
  });
  if (!expanded.length) return [];
  const parents = await hydrateAssociationParents(
    db,
    expanded.map((item) => item.parentId),
    options.asOf
  );
  const directEntryIds = new Set(directMatches.map((match) => match.entryId));
  const weakestDirectScore = Math.min(...resolvedSeeds.map((seed) => seed.score));
  const hopMultiplier = (hop: number) => hop === 1 ? 0.55 : 0.3;
  return expanded
    .flatMap((item) => {
      const parent = parents.get(item.parentId);
      if (!parent || directEntryIds.has(parent.entryId)) return [];
      return [{
        ...parent,
        score: Number((weakestDirectScore * hopMultiplier(item.hop) * item.pathWeight).toFixed(6)),
        seedParentId: item.seedParentId,
        hop: item.hop,
        viaType: item.viaType,
        viaWeight: item.viaWeight,
      }];
    })
    .sort((left, right) => right.score - left.score || left.entryId.localeCompare(right.entryId))
    .slice(0, Math.max(1, Math.min(Math.trunc(options.limit ?? 20), 40)));
}
