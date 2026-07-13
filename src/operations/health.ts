import { verifyComplianceAuditChain } from "../memory/quality";
import {
  queueAttentionCount,
  readClassificationQueueSnapshot,
  readExtractionQueueSnapshot,
  type QueueSnapshot,
} from "./queue-health";
import { isVectorSourceMetadataIndexError } from "./vector-health";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface ProviderHealthSummary {
  id: string;
  configured: boolean;
  status: HealthStatus;
  error?: string;
}

interface VectorHealthSource {
  describe?: () => Promise<unknown>;
  probeSourceMetadataFilter?: () => Promise<unknown>;
}

export interface HealthMatrixInput {
  db: D1Database;
  vectorize: VectorHealthSource;
  mode: "selfhost" | "cloudflare";
  llmConfigured: boolean;
  embeddingConfigured: boolean;
  providers: ProviderHealthSummary[];
}

export interface HealthMatrix {
  ok: boolean;
  status: HealthStatus;
  mode: "selfhost" | "cloudflare";
  checkedAt: number;
  components: {
    database: { status: HealthStatus };
    vectorIndex: {
      status: HealthStatus;
      dimensions?: number;
      sourceMetadataFilter?: "available" | "missing";
      error?: string;
    };
    llmProvider: { status: HealthStatus; configured: boolean };
    embeddingProvider: { status: HealthStatus; configured: boolean };
    graphProjection: { status: HealthStatus; reviewPending: number };
    auditChain: {
      status: HealthStatus;
      events: number;
      checked: number;
      complete: boolean;
      error?: string;
    };
    providers: ProviderHealthSummary[];
  };
  queues: {
    extraction: number;
    classification: number;
    conflicts: number;
    entityMerge: number;
    factReview: number;
    degradedParents: number;
  };
  queueDetails: {
    extraction: QueueSnapshot;
    classification: QueueSnapshot;
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 240);
}

async function countQuery(db: D1Database, sql: string, ...bindings: unknown[]): Promise<number> {
  try {
    const row = await db.prepare(sql).bind(...bindings).first<{ count: number }>();
    return Math.max(0, Number(row?.count ?? 0));
  } catch {
    return 0;
  }
}

function vectorDimensions(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.config && typeof record.config === "object"
    ? record.config as Record<string, unknown>
    : null;
  const dimensions = Number(record.dimensions ?? nested?.dimensions);
  return Number.isFinite(dimensions) && dimensions > 0 ? dimensions : undefined;
}

export async function collectHealthMatrix(input: HealthMatrixInput): Promise<HealthMatrix> {
  let databaseStatus: HealthStatus = "healthy";
  try {
    await input.db.prepare(`SELECT 1 AS ok`).first();
  } catch {
    databaseStatus = "unhealthy";
  }

  let vectorIndex: HealthMatrix["components"]["vectorIndex"] = { status: "healthy" };
  if (typeof input.vectorize.describe === "function") {
    try {
      const description = await input.vectorize.describe();
      vectorIndex = { ...vectorIndex, dimensions: vectorDimensions(description) };
    } catch (error) {
      vectorIndex = { status: "degraded", error: safeError(error) };
    }
  } else if (typeof input.vectorize.probeSourceMetadataFilter !== "function") {
    vectorIndex = { status: "degraded", error: "health probe unsupported" };
  }
  if (typeof input.vectorize.probeSourceMetadataFilter === "function") {
    try {
      await input.vectorize.probeSourceMetadataFilter();
      vectorIndex = { ...vectorIndex, sourceMetadataFilter: "available" };
    } catch (error) {
      vectorIndex = {
        ...vectorIndex,
        status: "degraded",
        sourceMetadataFilter: "missing",
        error: isVectorSourceMetadataIndexError(error)
          ? "vector_source_index_missing"
          : "vector_source_filter_probe_failed",
      };
    }
  }

  const [
    extractionDetails,
    classificationDetails,
    conflicts,
    entityMerge,
    factReview,
    degradedParents,
    auditChain,
  ] = await Promise.all([
    readExtractionQueueSnapshot(input.db),
    readClassificationQueueSnapshot(input.db),
    countQuery(input.db, `SELECT COUNT(*) AS count FROM sb_conflict_cases WHERE state = 'pending'`),
    countQuery(
      input.db,
      `SELECT COUNT(*) AS count FROM sb_entity_merge_candidates
       WHERE state IN ('pending', 'accepted')`
    ),
    countQuery(input.db, `SELECT COUNT(*) AS count FROM sb_fact_resolutions WHERE requires_review = 1`),
    countQuery(input.db, `SELECT COUNT(*) AS count FROM sb_parent_versions WHERE state = 'active_degraded'`),
    verifyComplianceAuditChain(input.db).catch((error) => ({
      valid: false,
      complete: false,
      events: 0,
      checked: 0,
      error: safeError(error),
    })),
  ]);

  const graphReviewPending = conflicts + entityMerge + factReview;
  const extraction = queueAttentionCount(extractionDetails);
  const classification = queueAttentionCount(classificationDetails);
  const auditStatus: HealthStatus = !auditChain.valid
    ? "unhealthy"
    : auditChain.complete
      ? "healthy"
      : "degraded";
  const providers = input.providers.map((provider) => ({ ...provider }));
  const componentStatuses: HealthStatus[] = [
    databaseStatus,
    vectorIndex.status,
    input.llmConfigured ? "healthy" : "degraded",
    input.embeddingConfigured ? "healthy" : "degraded",
    graphReviewPending > 0 ? "degraded" : "healthy",
    extraction + classification > 0 ? "degraded" : "healthy",
    auditStatus,
    ...providers.map((provider) => provider.status),
  ];
  const status: HealthStatus = componentStatuses.includes("unhealthy")
    ? "unhealthy"
    : componentStatuses.includes("degraded")
      ? "degraded"
      : "healthy";

  return {
    ok: databaseStatus === "healthy",
    status,
    mode: input.mode,
    checkedAt: Date.now(),
    components: {
      database: { status: databaseStatus },
      vectorIndex,
      llmProvider: {
        status: input.llmConfigured ? "healthy" : "degraded",
        configured: input.llmConfigured,
      },
      embeddingProvider: {
        status: input.embeddingConfigured ? "healthy" : "degraded",
        configured: input.embeddingConfigured,
      },
      graphProjection: {
        status: graphReviewPending > 0 ? "degraded" : "healthy",
        reviewPending: graphReviewPending,
      },
      auditChain: {
        status: auditStatus,
        events: auditChain.events,
        checked: auditChain.checked,
        complete: auditChain.complete,
        ...(auditChain.error ? { error: auditChain.error } : {}),
      },
      providers,
    },
    queues: {
      extraction,
      classification,
      conflicts,
      entityMerge,
      factReview,
      degradedParents,
    },
    queueDetails: {
      extraction: extractionDetails,
      classification: classificationDetails,
    },
  };
}
