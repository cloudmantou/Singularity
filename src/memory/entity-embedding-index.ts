export const ENTITY_VECTOR_SOURCE = "singularity-entity";

export interface EntityEmbeddingMatch {
  entityId: string;
  score: number;
}

export interface EntityEmbeddingIndex {
  search(input: {
    vector: number[];
    fingerprint: string;
    topK: number;
  }): Promise<EntityEmbeddingMatch[]>;
  upsert(input: {
    entityId: string;
    vector: number[];
    fingerprint: string;
    updatedAt: number;
  }): Promise<void>;
  delete(entityId: string): Promise<void>;
}

function validVector(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const vector = raw.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}

function cosineSimilarity(left: number[], right: number[]): number | null {
  if (!left.length || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function boundedTopK(value: number): number {
  return Math.max(1, Math.min(50, Math.trunc(value || 10)));
}

export class D1EntityEmbeddingIndex implements EntityEmbeddingIndex {
  constructor(private readonly db: D1Database) {}

  async search(input: {
    vector: number[];
    fingerprint: string;
    topK: number;
  }): Promise<EntityEmbeddingMatch[]> {
    const query = validVector(input.vector);
    if (!query || !input.fingerprint.trim()) return [];
    const matches: EntityEmbeddingMatch[] = [];
    let lastEntityId = "";
    const pageSize = 250;
    while (true) {
      const { results } = await this.db.prepare(
        `SELECT x.entity_id, x.embedding_json
         FROM sb_entity_embeddings x
         JOIN sb_entities e ON e.id = x.entity_id
         WHERE x.embedding_fingerprint = ?
           AND x.entity_id > ?
           AND e.lifecycle_state = 'active'
         ORDER BY x.entity_id
         LIMIT ?`
      ).bind(input.fingerprint, lastEntityId, pageSize).all<{
        entity_id: string;
        embedding_json: string;
      }>();
      const page = results ?? [];
      for (const row of page) {
        const vector = validVector(safeParseJson(row.embedding_json));
        const score = vector ? cosineSimilarity(query, vector) : null;
        if (score != null) matches.push({ entityId: row.entity_id, score });
      }
      if (page.length < pageSize) break;
      lastEntityId = page[page.length - 1].entity_id;
    }
    return matches
      .sort((left, right) => right.score - left.score || left.entityId.localeCompare(right.entityId))
      .slice(0, boundedTopK(input.topK));
  }

  async upsert(): Promise<void> {
    // sb_entity_embeddings is the durable source and is written by the resolver.
  }

  async delete(): Promise<void> {
    // Lifecycle filtering is applied directly against sb_entities during search.
  }
}

export class VectorizeEntityEmbeddingIndex implements EntityEmbeddingIndex {
  constructor(private readonly index: VectorizeIndex) {}

  async search(input: {
    vector: number[];
    fingerprint: string;
    topK: number;
  }): Promise<EntityEmbeddingMatch[]> {
    const vector = validVector(input.vector);
    if (!vector || !input.fingerprint.trim()) return [];
    const result = await this.index.query(vector, {
      topK: boundedTopK(input.topK),
      returnMetadata: "all",
      filter: {
        source: ENTITY_VECTOR_SOURCE,
        embedding_fingerprint: input.fingerprint,
      },
    });
    return (result.matches ?? []).flatMap((match) => {
      const entityId = String((match.metadata as Record<string, unknown> | undefined)?.entity_id ?? "").trim();
      const score = Number(match.score);
      return entityId && Number.isFinite(score) ? [{ entityId, score }] : [];
    });
  }

  async upsert(input: {
    entityId: string;
    vector: number[];
    fingerprint: string;
    updatedAt: number;
  }): Promise<void> {
    const vector = validVector(input.vector);
    if (!vector || !input.entityId.trim() || !input.fingerprint.trim()) return;
    await this.index.upsert([{
      id: `entity:${input.entityId}`,
      values: vector,
      metadata: {
        source: ENTITY_VECTOR_SOURCE,
        entity_id: input.entityId,
        embedding_fingerprint: input.fingerprint,
        updated_at: input.updatedAt,
      },
    }]);
  }

  async delete(entityId: string): Promise<void> {
    const id = entityId.trim();
    if (!id) return;
    await this.index.deleteByIds([`entity:${id}`]);
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
