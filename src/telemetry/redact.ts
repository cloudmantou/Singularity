/** Content redaction for telemetry previews. */

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /sk-[A-Za-z0-9]{10,}/g,
  /api[_-]?key["'\s:=]+[A-Za-z0-9\-._]{8,}/gi,
  /password["'\s:=]+\S+/gi,
  /authorization["'\s:=]+\S+/gi,
  /cookie["'\s:=]+\S+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function previewText(
  text: string | undefined | null,
  mode: "off" | "metadata" | "preview" | "full",
  maxChars: number
): { preview: string | null; hash: string | null; length: number } {
  if (!text) return { preview: null, hash: null, length: 0 };
  const length = text.length;
  const hash = simpleHash(text);

  if (mode === "off") return { preview: null, hash: null, length };
  if (mode === "metadata") return { preview: null, hash, length };

  const redacted = redactSecrets(text);
  if (mode === "full") return { preview: redacted, hash, length };
  // preview
  const clipped =
    redacted.length <= maxChars ? redacted : redacted.slice(0, maxChars) + "…";
  return { preview: clipped, hash, length };
}

/**
 * Credential exchange, model settings, and memory write/chat bodies may contain
 * owner tokens, provider keys, or private memories. Never preview or hash them.
 */
export function shouldSuppressRequestBodyTelemetry(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return (
    p === "/oauth" ||
    p.startsWith("/oauth/") ||
    p === "/mcp" ||
    p.startsWith("/mcp/") ||
    p === "/settings/models" ||
    p.startsWith("/settings/models/") ||
    p === "/settings/oauth" ||
    p.startsWith("/settings/oauth/") ||
    p === "/import" ||
    p === "/capture" ||
    p === "/integrations/development-session/capture" ||
    p === "/integrations/obsidian/push" ||
    p === "/append" ||
    p === "/update" ||
    p === "/chat"
  );
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function routeToOperation(method: string, pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/integrations/development-session/capture" && method === "POST") {
    return "integration.development_session.capture";
  }
  if (p === "/integrations/obsidian/push" && method === "POST") return "integration.obsidian.push";
  if (p === "/integrations/obsidian/pull" && method === "GET") return "integration.obsidian.pull";
  if (p === "/integrations/providers" && method === "GET") return "integration.providers";
  if ((p === "/link" || p === "/associations/link") && method === "POST") {
    return "association.link";
  }
  if ((p === "/unlink" || p === "/associations/unlink") && method === "POST") {
    return "association.unlink";
  }
  if ((p === "/connections" || p === "/associations/connections") && method === "GET") {
    return "association.connections";
  }
  if (p === "/capture" && method === "POST") return "memory.capture";
  if (p === "/recall" && method === "GET") return "memory.recall";
  if (p === "/append" && method === "POST") return "memory.append";
  if (p === "/update" && method === "POST") return "memory.update";
  if (p === "/forget" && method === "POST") return "memory.delete";
  if (p === "/import" && method === "POST") return "memory.import";
  if (p === "/export" && method === "GET") return "memory.export";
  if (p === "/vectorize-pending" && method === "POST") return "memory.vectorize";
  if (p === "/classify-pending" && method === "POST") return "llm.classify_pending";
  if (p === "/chat" && method === "POST") return "llm.chat";
  if (p === "/digest" && method === "GET") return "maintenance.digest";
  if (p.startsWith("/settings/models")) return "settings.models";
  if (p.startsWith("/settings/telemetry")) return "settings.telemetry";
  if (p.startsWith("/analytics")) return "analytics";
  if (p === "/mcp" || p.startsWith("/mcp")) return "mcp";
  if (p === "/list") return "memory.list";
  if (p === "/count") return "memory.count";
  if (p === "/stats") return "memory.stats";
  if (p === "/health") return "health";
  if (p === "/health/details") return "health.details";
  return `${method.toLowerCase()}${p.replace(/\//g, ".")}`;
}
