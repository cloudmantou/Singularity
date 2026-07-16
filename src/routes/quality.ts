import { z } from "zod";
import { ENTITY_MERGE_CANDIDATE_STATES } from "../memory/entity-merge";
import {
  AI_REVIEW_MODES,
  AI_REVIEW_OBJECT_TYPES,
  type AIReviewMode,
  type AIReviewObjectType,
} from "../memory/ai-review";
import {
  CONFLICT_CASE_STATES,
  CONFLICT_RESOLUTIONS,
  MERGE_CANDIDATE_STATES,
  type ConflictCaseState,
  type ConflictResolution,
  type MergeCandidateState,
} from "../memory/quality";

type AuthResult<Principal> =
  | { ok: true; principal: Principal }
  | { ok: false; response: Response };

export interface QualityRouteServices<Principal> {
  authenticate(request: Request): AuthResult<Principal>;
  listEntityCandidates(input: { state: string | null; limit: number }): Promise<unknown[]>;
  resolveEntityCandidate(input: {
    id: string;
    decision: "accept" | "reject";
    reviewedBy?: string;
    reason?: string;
    principal: Principal;
  }): Promise<Record<string, unknown>>;
  listMemoryCandidates(input: { state: MergeCandidateState | null; limit: number }): Promise<unknown[]>;
  resolveMemoryCandidate(input: {
    id: string;
    state: Exclude<MergeCandidateState, "pending">;
    reviewedBy: string;
    principal: Principal;
  }): Promise<boolean>;
  listConflictCases(input: { state: ConflictCaseState | null; limit: number }): Promise<unknown[]>;
  resolveConflictCase(input: {
    id: string;
    state: Exclude<ConflictCaseState, "pending">;
    resolution: ConflictResolution;
    resolvedBy: string;
    principal: Principal;
  }): Promise<boolean>;
  listAIReviews(input: {
    objectType: AIReviewObjectType | null;
    objectId: string | null;
    limit: number;
  }): Promise<unknown[]>;
  requestAIReview(input: {
    objectType: AIReviewObjectType;
    objectId: string;
    mode: AIReviewMode;
    principal: Principal;
  }): Promise<Record<string, unknown>>;
  requestAIReviewBatch(input: {
    objectType: AIReviewObjectType | null;
    limit: number;
    mode: AIReviewMode;
    principal: Principal;
  }): Promise<Record<string, unknown>>;
  getKnowledgeEvolutionStatus(input: {
    principal: Principal;
  }): Promise<Record<string, unknown>>;
  startKnowledgeEvolution(input: {
    objectType: AIReviewObjectType | null;
    mode: AIReviewMode;
    principal: Principal;
  }): Promise<Record<string, unknown>>;
  applyAIReview(input: {
    runId: string;
    principal: Principal;
  }): Promise<Record<string, unknown>>;
  mapError?(error: unknown): Response | null;
}

const EntityReviewSchema = z.object({
  id: z.string().trim().min(1).max(256),
  decision: z.enum(["accept", "reject"]),
  reviewedBy: z.string().trim().min(1).max(256).optional(),
  reason: z.string().max(1000).optional(),
}).strict();

const MemoryReviewSchema = z.object({
  id: z.string().trim().min(1).max(256),
  state: z.enum(["accepted", "rejected", "resolved"]),
  reviewedBy: z.string().trim().min(1).max(256).optional(),
}).strict();

const ConflictReviewSchema = z.object({
  id: z.string().trim().min(1).max(256),
  state: z.enum(["resolved", "dismissed"]),
  resolution: z.enum(CONFLICT_RESOLUTIONS),
  resolvedBy: z.string().trim().min(1).max(256).optional(),
}).strict();

const AIReviewRequestSchema = z.object({
  objectType: z.enum(AI_REVIEW_OBJECT_TYPES),
  objectId: z.string().trim().min(1).max(256),
  mode: z.enum(AI_REVIEW_MODES).default("suggest"),
}).strict();

const AIReviewBatchSchema = z.object({
  objectType: z.enum(AI_REVIEW_OBJECT_TYPES).optional(),
  limit: z.number().int().min(1).max(10).default(5),
  mode: z.enum(AI_REVIEW_MODES).default("suggest"),
}).strict();

const AIReviewApplySchema = z.object({
  runId: z.string().trim().min(1).max(256),
}).strict();

const KnowledgeEvolutionRunSchema = z.object({
  objectType: z.enum(AI_REVIEW_OBJECT_TYPES).optional(),
  mode: z.enum(AI_REVIEW_MODES).default("auto_low_risk"),
}).strict();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function boundedLimit(value: string | null): number {
  const parsed = Number(value ?? 50);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.trunc(parsed))) : 50;
}

function parseState<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? value as T : null;
}

async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function mappedError<Principal>(
  error: unknown,
  services: QualityRouteServices<Principal>
): Response | null {
  return services.mapError?.(error) ?? null;
}

async function entityRoute<Principal>(
  request: Request,
  url: URL,
  principal: Principal,
  services: QualityRouteServices<Principal>
): Promise<Response> {
  if (request.method === "GET") {
    const state = parseState(url.searchParams.get("state"), ENTITY_MERGE_CANDIDATE_STATES);
    if (url.searchParams.has("state") && !state) {
      return json({ ok: false, error: `state must be one of: ${ENTITY_MERGE_CANDIDATE_STATES.join(", ")}` }, 400);
    }
    const candidates = await services.listEntityCandidates({ state, limit: boundedLimit(url.searchParams.get("limit")) });
    return json({ ok: true, count: candidates.length, candidates });
  }
  const parsed = EntityReviewSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ ok: false, error: "invalid_entity_merge_review" }, 400);
  try {
    const result = await services.resolveEntityCandidate({ ...parsed.data, principal });
    return json({ ok: true, ...result });
  } catch (error) {
    const response = mappedError(error, services);
    if (response) return response;
    throw error;
  }
}

async function memoryRoute<Principal>(
  request: Request,
  url: URL,
  principal: Principal,
  services: QualityRouteServices<Principal>
): Promise<Response> {
  if (request.method === "GET") {
    const state = parseState(url.searchParams.get("state"), MERGE_CANDIDATE_STATES);
    if (url.searchParams.has("state") && !state) {
      return json({ ok: false, error: `state must be one of: ${MERGE_CANDIDATE_STATES.join(", ")}` }, 400);
    }
    const candidates = await services.listMemoryCandidates({ state, limit: boundedLimit(url.searchParams.get("limit")) });
    return json({ ok: true, count: candidates.length, candidates });
  }
  const parsed = MemoryReviewSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ ok: false, error: "invalid_memory_merge_review" }, 400);
  const reviewedBy = parsed.data.reviewedBy ?? "owner";
  const ok = await services.resolveMemoryCandidate({ ...parsed.data, reviewedBy, principal });
  if (!ok) return json({ ok: false, error: `No merge candidate found with ID: ${parsed.data.id}` }, 404);
  return json({ ok: true, id: parsed.data.id, state: parsed.data.state, reviewedBy });
}

function conflictOutcomeValid(state: string, resolution: string): boolean {
  return (state === "dismissed" && resolution === "dismissed") ||
    (state === "resolved" && resolution !== "dismissed" && resolution !== "manual");
}

async function conflictRoute<Principal>(
  request: Request,
  url: URL,
  principal: Principal,
  services: QualityRouteServices<Principal>
): Promise<Response> {
  if (request.method === "GET") {
    const state = parseState(url.searchParams.get("state"), CONFLICT_CASE_STATES);
    if (url.searchParams.has("state") && !state) {
      return json({ ok: false, error: `state must be one of: ${CONFLICT_CASE_STATES.join(", ")}` }, 400);
    }
    const conflicts = await services.listConflictCases({ state, limit: boundedLimit(url.searchParams.get("limit")) });
    return json({ ok: true, count: conflicts.length, conflicts });
  }
  const parsed = ConflictReviewSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ ok: false, error: "invalid_conflict_review" }, 400);
  if (!conflictOutcomeValid(parsed.data.state, parsed.data.resolution)) {
    const error = parsed.data.resolution === "manual"
      ? "manual_resolution_requires_outcome"
      : "invalid_conflict_outcome";
    return json({ ok: false, error }, 400);
  }
  const resolvedBy = parsed.data.resolvedBy ?? "owner";
  try {
    const ok = await services.resolveConflictCase({ ...parsed.data, resolvedBy, principal });
    if (!ok) return json({ ok: false, error: `No conflict case found with ID: ${parsed.data.id}` }, 404);
    return json({ ok: true, id: parsed.data.id, state: parsed.data.state, resolution: parsed.data.resolution, resolvedBy });
  } catch (error) {
    const response = mappedError(error, services);
    if (response) return response;
    throw error;
  }
}

async function aiReviewRoute<Principal>(
  request: Request,
  url: URL,
  principal: Principal,
  services: QualityRouteServices<Principal>
): Promise<Response> {
  try {
    if (url.pathname === "/quality/ai-review" && request.method === "GET") {
    const objectType = parseState(url.searchParams.get("objectType"), AI_REVIEW_OBJECT_TYPES);
    if (url.searchParams.has("objectType") && !objectType) {
      return json({ ok: false, error: "invalid_ai_review_object_type" }, 400);
    }
    const objectId = url.searchParams.get("objectId")?.trim() || null;
    const reviews = await services.listAIReviews({
      objectType,
      objectId,
      limit: boundedLimit(url.searchParams.get("limit")),
    });
    return json({ ok: true, count: reviews.length, reviews });
  }
    if (url.pathname === "/quality/ai-review" && request.method === "POST") {
    const parsed = AIReviewRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ ok: false, error: "invalid_ai_review_request" }, 400);
    const job = await services.requestAIReview({ ...parsed.data, principal });
    return json({ ok: true, ...job }, 202);
  }
    if (url.pathname === "/quality/ai-review/batch") {
    const parsed = AIReviewBatchSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ ok: false, error: "invalid_ai_review_batch" }, 400);
    const result = await services.requestAIReviewBatch({
      objectType: parsed.data.objectType ?? null,
      limit: parsed.data.limit,
      mode: parsed.data.mode,
      principal,
    });
    return json({ ok: true, ...result }, 202);
  }
    const parsed = AIReviewApplySchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ ok: false, error: "invalid_ai_review_application" }, 400);
    const result = await services.applyAIReview({ ...parsed.data, principal });
    return json({ ok: true, ...result });
  } catch (error) {
    const response = mappedError(error, services);
    if (response) return response;
    throw error;
  }
}

async function knowledgeEvolutionRoute<Principal>(
  request: Request,
  url: URL,
  principal: Principal,
  services: QualityRouteServices<Principal>
): Promise<Response> {
  if (url.pathname === "/quality/knowledge-evolution/status") {
    return json({ ok: true, ...await services.getKnowledgeEvolutionStatus({ principal }) });
  }
  const parsed = KnowledgeEvolutionRunSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ ok: false, error: "invalid_knowledge_evolution_run" }, 400);
  const result = await services.startKnowledgeEvolution({
    objectType: parsed.data.objectType ?? null,
    mode: parsed.data.mode,
    principal,
  });
  return json({ ok: true, ...result }, 202);
}

export async function handleQualityRoute<Principal>(
  request: Request,
  url: URL,
  services: QualityRouteServices<Principal>
): Promise<Response | null> {
  const routes = new Set([
    "/quality/entity-merge-candidates",
    "/quality/entity-merge-candidates/resolve",
    "/quality/merge-candidates",
    "/quality/merge-candidates/resolve",
    "/quality/conflict-cases",
    "/quality/conflict-cases/resolve",
    "/quality/ai-review",
    "/quality/ai-review/batch",
    "/quality/ai-review/apply",
    "/quality/knowledge-evolution/status",
    "/quality/knowledge-evolution/run",
  ]);
  if (!routes.has(url.pathname)) return null;
  const expectedMethod = url.pathname === "/quality/ai-review"
    ? null
    : url.pathname === "/quality/knowledge-evolution/status"
      ? "GET"
      : url.pathname === "/quality/knowledge-evolution/run"
        ? "POST"
    : url.pathname.endsWith("/resolve") || url.pathname.endsWith("/batch") || url.pathname.endsWith("/apply")
      ? "POST"
      : "GET";
  if (url.pathname === "/quality/ai-review" && !["GET", "POST"].includes(request.method)) {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (expectedMethod && request.method !== expectedMethod) {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  const auth = services.authenticate(request);
  if (!auth.ok) return auth.response;
  if (url.pathname.startsWith("/quality/knowledge-evolution/")) {
    return knowledgeEvolutionRoute(request, url, auth.principal, services);
  }
  if (url.pathname.startsWith("/quality/ai-review")) {
    return aiReviewRoute(request, url, auth.principal, services);
  }
  if (url.pathname.startsWith("/quality/entity-merge-candidates")) {
    return entityRoute(request, url, auth.principal, services);
  }
  if (url.pathname.startsWith("/quality/merge-candidates")) {
    return memoryRoute(request, url, auth.principal, services);
  }
  return conflictRoute(request, url, auth.principal, services);
}
