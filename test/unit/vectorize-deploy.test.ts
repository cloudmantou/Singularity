import { describe, expect, it } from "vitest";
import { missingVectorizeMetadataIndexes } from "../../src/operations/vectorize-deploy";

describe("Vectorize deployment gate", () => {
  it("requires both embedding_fingerprint and source metadata indexes", () => {
    expect(missingVectorizeMetadataIndexes([
      { propertyName: "embedding_fingerprint", indexType: "string" },
    ])).toEqual(["source"]);
    expect(missingVectorizeMetadataIndexes([
      { propertyName: "source", indexType: "string" },
      { propertyName: "embedding_fingerprint", indexType: "string" },
    ])).toEqual([]);
  });
});
