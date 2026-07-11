import { AsyncLocalStorage } from "node:async_hooks";
import { inspect, stripVTControlCharacters } from "node:util";

export type UnhandledRejectionDisposition =
  | "ignore-empty"
  | "ignore-disconnect"
  | "fatal";

export interface RuntimeRejectionContext {
  source: "mcp";
  requestId?: string;
}

const runtimeRejectionContext =
  new AsyncLocalStorage<RuntimeRejectionContext>();

export function runWithRuntimeRejectionContext<T>(
  context: RuntimeRejectionContext,
  operation: () => T
): T {
  return runtimeRejectionContext.run(context, operation);
}

export function runMcpRequest<T>(
  requestId: string,
  operation: () => T
): T {
  return runWithRuntimeRejectionContext(
    { source: "mcp", requestId },
    operation
  );
}

export function getRuntimeRejectionContext():
  | RuntimeRejectionContext
  | undefined {
  return runtimeRejectionContext.getStore();
}

/** Client/proxy closed a stream while the server was still writing. */
export function isBenignStreamClose(reason: unknown): boolean {
  if (reason == null || typeof reason !== "object") return false;
  const error = reason as NodeJS.ErrnoException & { name?: string };
  const code = error.code || "";
  if (
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECANCELED" ||
    code === "ABORT_ERR" ||
    code === "ERR_STREAM_DESTROYED"
  ) {
    return true;
  }
  if (error.name === "AbortError") return true;
  const message = String(error.message || "").trim().toLowerCase();
  return message === "premature close" || message === "socket hang up";
}

/**
 * Decide whether a detached Promise rejection should terminate self-host Node.
 * Empty rejections carry no diagnostic information and are emitted by some
 * transport cleanup paths after a request has already completed successfully.
 */
export function classifyUnhandledRejection(
  reason: unknown,
  context = getRuntimeRejectionContext()
): UnhandledRejectionDisposition {
  if (reason == null && context?.source === "mcp") return "ignore-empty";
  if (isBenignStreamClose(reason)) return "ignore-disconnect";
  return "fatal";
}

export function formatUnknownReason(reason: unknown, depth = 5): string {
  try {
    let rendered: string;
    if (reason instanceof Error) {
      let stack: unknown;
      let message: unknown;
      try {
        stack = reason.stack;
      } catch {
        stack = undefined;
      }
      try {
        message = reason.message;
      } catch {
        message = undefined;
      }
      rendered =
        (typeof stack === "string" && stack) ||
        (typeof message === "string" && message) ||
        "[unprintable rejection reason]";
    } else {
      rendered = inspect(reason, {
        depth,
        breakLength: 120,
        customInspect: false,
        maxArrayLength: 50,
        maxStringLength: 2_000,
      });
    }
    return stripVTControlCharacters(rendered)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
      .slice(0, 4_000);
  } catch {
    return "[unprintable rejection reason]";
  }
}

function formatReasonSummary(reason: unknown): string {
  return formatUnknownReason(reason, 1)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 500);
}

export interface RuntimeRejectionReporter {
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
  exit(code: number): void;
}

export function handleUnhandledRejection(
  reason: unknown,
  runtime: RuntimeRejectionReporter
): UnhandledRejectionDisposition {
  const context = getRuntimeRejectionContext();
  const disposition = classifyUnhandledRejection(reason, context);
  if (disposition === "ignore-empty") {
    runtime.warn("[runtime] ignored empty unhandled rejection", {
      source: context?.source,
      requestId: context?.requestId,
    });
    return disposition;
  }
  if (disposition === "ignore-disconnect") {
    runtime.warn(
      "[stream] ignored connection-close rejection:",
      formatReasonSummary(reason)
    );
    return disposition;
  }

  runtime.error("[fatal] unhandledRejection:", formatUnknownReason(reason));
  runtime.exit(1);
  return disposition;
}
