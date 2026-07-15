import { verifyComplianceAuditChain } from "../memory/quality";
import { getMemoryMutationHealth, type MemoryMutationHealth } from "../memory/mutations";
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
    aiReview: {
      queued: number;
      processingLive: number;
      processingExpired: number;
      applyingLive: number;
      applyingExpired: number;
      failed: number;
    };
    mutations: {
      preparing: number;
      entryCommitted: number;
      knowledgeCommitted: number;
      projectionPending: number;
      retryableFailed: number;
      terminalFailed: number;
      stale: number;
    };
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
    mutationHealth,
    auditChain,
    aiReviewQueued,
    aiReviewProcessingLive,
    aiReviewProcessingExpired,
    aiReviewApplyingLive,
    aiReviewApplyingExpired,
    aiReviewFailed,
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
    getMemoryMutationHealth(input.db).catch((): MemoryMutationHealth => ({
      preparing: 0,
      entry_committed: 0,
      knowledge_committed: 0,
      projection_pending: 0,
      failed: 0,
      completed: 0,
      incomplete: 0,
      stale_incomplete: 0,
      retryable_failed: 0,
      terminal_failed: 0,
    })),
    verifyComplianceAuditChain(input.db).catch((error) => ({
      valid: false,
      complete: false,
      events: 0,
      checked: 0,
      error: safeError(error),
    })),
    countQuery(input.db, `SELECT COUNT(*) AS count FROM sb_ai_review_jobs WHERE status = 'queued'`),
    countQuery(
      input.db,
      `SELECT COUNT(*) AS count FROM sb_ai_review_jobs
       WHERE status = 'processing' AND COALESCE(lease_expires_at, 0) > ?`,
      Date.now()
    ),
    countQuery(
      input.db,
      `SELECT COUNT(*) AS count FROM sb_ai_review_jobs
       WHERE status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?`,
      Date.now()
    ),
    countQuery(
      input.db,
      `SELECT COUNT(*) AS count FROM sb_ai_review_jobs
       WHERE status = 'applying' AND COALESCE(lease_expires_at, 0) > ?`,
      Date.now()
    ),
    countQuery(
      input.db,
      `SELECT COUNT(*) AS count FROM sb_ai_review_jobs
       WHERE status = 'applying' AND COALESCE(lease_expires_at, 0) <= ?`,
      Date.now()
    ),
    countQuery(input.db, `SELECT COUNT(*) AS count FROM sb_ai_review_jobs WHERE status = 'failed'`),
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
    mutationHealth.terminal_failed > 0
      ? "unhealthy"
      : mutationHealth.retryable_failed > 0 || mutationHealth.stale_incomplete > 0
        ? "degraded"
        : "healthy",
    aiReviewProcessingExpired + aiReviewApplyingExpired + aiReviewFailed > 0
      ? "degraded"
      : "healthy",
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
      aiReview: {
        queued: aiReviewQueued,
        processingLive: aiReviewProcessingLive,
        processingExpired: aiReviewProcessingExpired,
        applyingLive: aiReviewApplyingLive,
        applyingExpired: aiReviewApplyingExpired,
        failed: aiReviewFailed,
      },
      mutations: {
        preparing: mutationHealth.preparing,
        entryCommitted: mutationHealth.entry_committed,
        knowledgeCommitted: mutationHealth.knowledge_committed,
        projectionPending: mutationHealth.projection_pending,
        retryableFailed: mutationHealth.retryable_failed,
        terminalFailed: mutationHealth.terminal_failed,
        stale: mutationHealth.stale_incomplete,
      },
    },
    queueDetails: {
      extraction: extractionDetails,
      classification: classificationDetails,
    },
  };
}
