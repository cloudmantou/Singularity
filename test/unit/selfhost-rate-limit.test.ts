import { describe, expect, it } from "vitest";
import {
  classifyExpensiveRoute,
  createFixedWindowRateLimiter,
  createRateLimitIdentity,
} from "../../src/selfhost/rate-limit";

describe("fixed-window rate limiter", () => {
  it("allows the configured number of attempts and then returns retry timing", () => {
    const limiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 60_000 });

    expect(limiter.consume("127.0.0.1", 1_000).allowed).toBe(true);
    expect(limiter.consume("127.0.0.1", 2_000).allowed).toBe(true);
    expect(limiter.consume("127.0.0.1", 3_000)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 58,
    });
  });

  it("resets after the window and isolates clients", () => {
    const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 1_000 });

    expect(limiter.consume("client-a", 0).allowed).toBe(true);
    expect(limiter.consume("client-a", 500).allowed).toBe(false);
    expect(limiter.consume("client-b", 500).allowed).toBe(true);
    expect(limiter.consume("client-a", 1_000).allowed).toBe(true);
  });

  it("classifies model, maintenance, import, and MCP endpoints", () => {
    expect(classifyExpensiveRoute("GET", "/recall")).toBe("model");
    expect(classifyExpensiveRoute("POST", "/settings/models/test")).toBe("model");
    expect(classifyExpensiveRoute("POST", "/vectorize-pending")).toBe("maintenance");
    expect(classifyExpensiveRoute("POST", "/import")).toBe("import");
    expect(classifyExpensiveRoute("POST", "/mcp")).toBe("mcp");
    expect(classifyExpensiveRoute("GET", "/tags")).toBeNull();
  });

  it("only isolates the trusted owner credential and groups unknown credentials by IP", () => {
    const trustedAuthorization = "Bearer private-token";
    const key = createRateLimitIdentity(
      "127.0.0.1",
      trustedAuthorization,
      trustedAuthorization
    );
    expect(key).not.toContain("private-token");
    expect(key).toBe(createRateLimitIdentity(
      "127.0.0.1",
      trustedAuthorization,
      trustedAuthorization
    ));
    expect(key).not.toBe(createRateLimitIdentity("127.0.0.1"));
    expect(createRateLimitIdentity(
      "127.0.0.1",
      "Bearer attacker-token-a",
      trustedAuthorization
    )).toBe(createRateLimitIdentity(
      "127.0.0.1",
      "Bearer attacker-token-b",
      trustedAuthorization
    ));
  });
});
