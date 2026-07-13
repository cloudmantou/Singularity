import { describe, expect, it, vi } from "vitest";
import { cachedVectorSourceMetadataProbe } from "../../src/operations/vector-health";

describe("cachedVectorSourceMetadataProbe", () => {
  it("reuses a successful probe within the cache TTL", async () => {
    const binding = {};
    const probe = vi.fn().mockResolvedValue(undefined);

    await cachedVectorSourceMetadataProbe(binding, "384", probe, { now: 100, ttlMs: 50 });
    await cachedVectorSourceMetadataProbe(binding, "384", probe, { now: 120, ttlMs: 50 });
    await cachedVectorSourceMetadataProbe(binding, "384", probe, { now: 151, ttlMs: 50 });

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("caches probe failures briefly to avoid repeated paid queries", async () => {
    const binding = {};
    const error = new Error("metadata index missing");
    const probe = vi.fn().mockRejectedValue(error);

    await expect(cachedVectorSourceMetadataProbe(binding, "384", probe, {
      now: 100,
      ttlMs: 50,
    })).rejects.toBe(error);
    await expect(cachedVectorSourceMetadataProbe(binding, "384", probe, {
      now: 120,
      ttlMs: 50,
    })).rejects.toBe(error);

    expect(probe).toHaveBeenCalledTimes(1);
  });
});
