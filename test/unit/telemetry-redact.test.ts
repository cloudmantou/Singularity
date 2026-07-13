import { describe, it, expect } from "vitest";
import {
  previewText,
  redactSecrets,
  routeToOperation,
  shouldSuppressRequestBodyTelemetry,
} from "../../src/telemetry/redact";
import { DEFAULT_TELEMETRY_CONFIG } from "../../src/telemetry/types";

describe("telemetry redact", () => {
  it("redacts bearer and sk- keys", () => {
    const s = redactSecrets("Authorization: Bearer abc.def.ghi sk-abcdefghijklmnopqrst");
    expect(s).not.toMatch(/Bearer abc/);
    expect(s).not.toMatch(/sk-abcdefgh/);
    expect(s).toContain("[REDACTED]");
  });

  it("preview modes", () => {
    const long = "x".repeat(1000);
    expect(previewText(long, "off", 100).preview).toBeNull();
    expect(previewText(long, "metadata", 100).hash).toBeTruthy();
    expect(previewText(long, "preview", 50).preview!.length).toBeLessThanOrEqual(51);
    expect(previewText("hi", "full", 10).preview).toBe("hi");
  });

  it("maps routes to operations", () => {
    expect(routeToOperation("POST", "/capture")).toBe("memory.capture");
    expect(routeToOperation("GET", "/recall")).toBe("memory.recall");
    expect(routeToOperation("POST", "/import")).toBe("memory.import");
    expect(routeToOperation("PUT", "/settings/telemetry")).toBe("settings.telemetry");
  });

  it("never previews or hashes OAuth credentials and private MCP payloads", () => {
    expect(shouldSuppressRequestBodyTelemetry("/oauth/authorize")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/oauth/token")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/oauth/register")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/mcp")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/mcp/session")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/settings/models")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/settings/models/test")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/settings/oauth/clients")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/import")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/capture")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/append")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/update")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/chat")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/integrations/development-session/capture")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/integrations/obsidian/push")).toBe(true);
    expect(shouldSuppressRequestBodyTelemetry("/count")).toBe(false);
  });

  it("assigns stable operations to integration and association routes", () => {
    expect(routeToOperation("POST", "/integrations/development-session/capture"))
      .toBe("integration.development_session.capture");
    expect(routeToOperation("POST", "/associations/link")).toBe("association.link");
    expect(routeToOperation("GET", "/connections")).toBe("association.connections");
    expect(routeToOperation("GET", "/health/details")).toBe("health.details");
  });

  it("defaults personal telemetry to metadata-only with shorter retention", () => {
    expect(DEFAULT_TELEMETRY_CONFIG.contentLogging).toBe("metadata");
    expect(DEFAULT_TELEMETRY_CONFIG.retentionDays).toBe(14);
    expect(DEFAULT_TELEMETRY_CONFIG.storeModelResponses).toBe(false);
  });
});
