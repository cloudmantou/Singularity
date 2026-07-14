/** Telemetry / Observatory data contracts (PR-008 foundation). */

export type ContentLoggingMode = "off" | "metadata" | "preview" | "full";

export interface TelemetryConfig {
  telemetryEnabled: boolean;
  contentLogging: ContentLoggingMode;
  previewMaxChars: number;
  retentionDays: number;
  storeModelResponses: boolean;
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  telemetryEnabled: true,
  contentLogging: "metadata",
  previewMaxChars: 400,
  retentionDays: 14,
  storeModelResponses: false,
};

const CONTENT_LOGGING_MODES: readonly ContentLoggingMode[] = [
  "off",
  "metadata",
  "preview",
  "full",
];

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

/** Validate persisted or user-provided telemetry settings at the boundary. */
export function normalizeTelemetryConfig(
  input: Partial<TelemetryConfig> | null | undefined
): TelemetryConfig {
  const value = input ?? {};
  const mode = CONTENT_LOGGING_MODES.includes(value.contentLogging as ContentLoggingMode)
    ? (value.contentLogging as ContentLoggingMode)
    : DEFAULT_TELEMETRY_CONFIG.contentLogging;
  const previewMaxChars = Number(value.previewMaxChars);
  const retentionDays = Number(value.retentionDays);

  return {
    telemetryEnabled: asBoolean(value.telemetryEnabled, DEFAULT_TELEMETRY_CONFIG.telemetryEnabled),
    contentLogging: mode,
    previewMaxChars: Number.isFinite(previewMaxChars)
      ? Math.min(Math.max(Math.round(previewMaxChars), 50), 5000)
      : DEFAULT_TELEMETRY_CONFIG.previewMaxChars,
    retentionDays: Number.isFinite(retentionDays)
      ? Math.min(Math.max(Math.round(retentionDays), 1), 3650)
      : DEFAULT_TELEMETRY_CONFIG.retentionDays,
    storeModelResponses: asBoolean(
      value.storeModelResponses,
      DEFAULT_TELEMETRY_CONFIG.storeModelResponses
    ),
  };
}

export interface RequestLog {
  id: string;
  trace_id: string;
  method: string;
  route: string;
  operation: string;
  source: string;
  status_code: number;
  success: number; // 0/1 for SQLite
  started_at: number;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  content_preview: string | null;
  content_hash: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface ModelCallLog {
  id: string;
  trace_id: string;
  call_type: "chat" | "embedding";
  provider: string;
  model: string;
  duration_ms: number;
  status: "success" | "error";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  input_preview: string | null;
  output_preview: string | null;
  error_message: string | null;
  created_at: number;
}

export type MemoryEventType =
  | "created"
  | "recalled"
  | "updated"
  | "appended"
  | "deleted"
  | "linked"
  | "merged"
  | "replaced"
  | "contradiction_detected"
  | "classified"
  | "vectorized"
  | "digest_created"
  | "imported"
  | "answerability_evaluated";

export interface MemoryEventLog {
  id: string;
  trace_id: string;
  memory_id: string;
  event_type: MemoryEventType;
  source: string;
  metadata_json: string;
  created_at: number;
}

export type TelemetryEvent =
  | { kind: "request"; data: RequestLog }
  | { kind: "model_call"; data: ModelCallLog }
  | { kind: "memory_event"; data: MemoryEventLog };
