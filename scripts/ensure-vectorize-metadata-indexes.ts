import { spawnSync } from "node:child_process";
import { missingVectorizeMetadataIndexes } from "../src/operations/vectorize-deploy";

const indexName = process.env.VECTORIZE_INDEX_NAME?.trim() || "singularity-vectors";

function wrangler(args: string[]): string {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["wrangler", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "Wrangler command failed").trim();
    throw new Error(detail);
  }
  return result.stdout;
}

function listIndexes(): Array<{ propertyName?: unknown; indexType?: unknown }> {
  const output = wrangler(["vectorize", "list-metadata-index", indexName, "--json"]);
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Unexpected Vectorize metadata-index response");
  return parsed;
}

const missing = missingVectorizeMetadataIndexes(listIndexes());
for (const propertyName of missing) {
  wrangler([
    "vectorize",
    "create-metadata-index",
    indexName,
    `--propertyName=${propertyName}`,
    "--type=string",
  ]);
}

const unresolved = missingVectorizeMetadataIndexes(listIndexes());
if (unresolved.length) {
  throw new Error(`Required Vectorize metadata indexes are missing: ${unresolved.join(", ")}`);
}

console.log(`Vectorize metadata indexes verified for ${indexName}.`);
