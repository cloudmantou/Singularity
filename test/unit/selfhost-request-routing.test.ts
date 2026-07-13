import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isKnownWorkerRoute,
  resolvePublicAssetPath,
} from "../../src/selfhost/request-routing";

describe("self-host request routing", () => {
  const publicDir = "/srv/singularity/public";

  it("rejects scanner paths before Worker forwarding", () => {
    expect(isKnownWorkerRoute("GET", "/recall")).toBe(true);
    expect(isKnownWorkerRoute("POST", "/integrations/obsidian/push")).toBe(true);
    expect(isKnownWorkerRoute("OPTIONS", "/integrations/obsidian/push")).toBe(true);
    expect(isKnownWorkerRoute("GET", "/entities/entity-1")).toBe(true);
    expect(isKnownWorkerRoute("GET", "/graph/entity/entity-1")).toBe(true);
    expect(isKnownWorkerRoute("GET", "/wp-json/gravitysmtp/v1/tests/mock-data")).toBe(false);
    expect(isKnownWorkerRoute("POST", "/api/graphql")).toBe(false);
    expect(isKnownWorkerRoute("GET", "/owa")).toBe(false);
    expect(isKnownWorkerRoute("GET", "/.well-known/owa")).toBe(false);
    expect(isKnownWorkerRoute("GET", "/.well-known/oauth-protected-resource/owa")).toBe(false);
    expect(isKnownWorkerRoute("GET", "/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isKnownWorkerRoute("DELETE", "/settings/oauth/clients/client-1")).toBe(true);
    expect(isKnownWorkerRoute("DELETE", "/settings/oauth/clients/client-1/nested")).toBe(false);
  });

  it("fails closed for malformed encoding and traversal", () => {
    expect(resolvePublicAssetPath("/%E0%A4%A", publicDir)).toBeNull();
    expect(resolvePublicAssetPath("/../../etc/passwd", publicDir)).toBeNull();
    expect(resolvePublicAssetPath("/index.html", publicDir)).toBe(
      path.join(publicDir, "index.html")
    );
  });
});
