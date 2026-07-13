const REQUIRED_VECTORIZE_METADATA_INDEXES = ["embedding_fingerprint", "source"] as const;

export interface VectorizeMetadataIndexDescription {
  propertyName?: unknown;
  indexType?: unknown;
}

export function missingVectorizeMetadataIndexes(
  indexes: readonly VectorizeMetadataIndexDescription[]
): string[] {
  const available = new Set(indexes.map((index) => String(index.propertyName ?? "").trim()));
  return REQUIRED_VECTORIZE_METADATA_INDEXES.filter((property) => !available.has(property));
}
