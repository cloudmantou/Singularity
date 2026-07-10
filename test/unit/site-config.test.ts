import { describe, it, expect } from "vitest";
import {
  mcpPublicUrl,
  normalizePublicUrl,
  readPublicUrl,
  siteConfigJson,
} from "../../src/config/site";

describe("site config PUBLIC_URL", () => {
  it("normalizes origin and strips path/slash", () => {
    expect(normalizePublicUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizePublicUrl("https://example.com/mcp")).toBe("https://example.com");
    expect(normalizePublicUrl("example.com")).toBe("https://example.com");
  });

  it("reads first available env alias", () => {
    const unrelatedBaseUrl = {
      BASE_URL: "https://wrong.example",
    } as unknown as Parameters<typeof readPublicUrl>[0];
    expect(readPublicUrl(unrelatedBaseUrl)).toBe("");
    expect(
      readPublicUrl({
        PUBLIC_URL: "https://primary.example",
        PUBLIC_BASE_URL: "https://secondary.example",
      })
    ).toBe("https://primary.example");
    expect(readPublicUrl({ SITE_URL: "https://site.example/" })).toBe(
      "https://site.example"
    );
  });

  it("builds mcp and oauth paths from public origin", () => {
    const cfg = siteConfigJson("https://my.brain.example");
    expect(cfg.mcpUrl).toBe("https://my.brain.example/mcp");
    expect(cfg.oauthAuthorizationServer).toBe(
      "https://my.brain.example/.well-known/oauth-authorization-server"
    );
    expect(mcpPublicUrl("https://my.brain.example/")).toBe(
      "https://my.brain.example/mcp"
    );
  });
});
