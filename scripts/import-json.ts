/**
 * Import a Second Brain JSON export (Cloudflare dashboard or /list export) into
 * the self-host SQLite database.
 *
 * Usage:
 *   # Against local DB (no HTTP server required):
 *   AUTH_TOKEN=unused DATABASE_PATH=./data/memory.db \
 *     npx tsx scripts/import-json.ts /path/to/export.json
 *
 *   # Options:
 *     --mode=skip|overwrite   (default skip)
 *     --tag=cf-import         (repeatable; default cf-import)
 *     --vectorize             (call embed via running server if BASE_URL set)
 *
 *   # Against running server:
 *   BASE_URL=https://agent.mtzs.cloud AUTH_TOKEN=... \
 *     npx tsx scripts/import-json.ts ./export.json --http
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { importEntries, parseImportPayload, type ImportMode } from "../src/import-entries";
import { initializeDatabase } from "../src/index";
import { createSelfhostEnv } from "../src/selfhost/env";

dotenv.config();

function usage(): never {
  console.error(`Usage: npx tsx scripts/import-json.ts <file.json> [options]

Options:
  --mode=skip|overwrite   Default: skip existing ids
  --tag=NAME              Extra tag (repeatable). Default: cf-import
  --http                  POST to BASE_URL/import instead of direct DB
  --vectorize             After import, POST BASE_URL/vectorize-pending (needs --http or BASE_URL)
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) usage();

  const fileArg = args.find((a) => !a.startsWith("--"));
  if (!fileArg) usage();

  let mode: ImportMode = "skip";
  const tags: string[] = [];
  let http = false;
  let vectorize = false;

  for (const a of args) {
    if (a.startsWith("--mode=")) {
      const m = a.slice("--mode=".length);
      mode = m === "overwrite" ? "overwrite" : "skip";
    } else if (a.startsWith("--tag=")) {
      tags.push(a.slice("--tag=".length));
    } else if (a === "--http") {
      http = true;
    } else if (a === "--vectorize") {
      vectorize = true;
    }
  }
  if (!tags.length) tags.push("cf-import");

  const filePath = path.resolve(fileArg!);
  if (!fs.existsSync(filePath)) {
    console.error("File not found:", filePath);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const entries = parseImportPayload(raw);
  console.log(`Loaded ${entries.length} entries from ${filePath}`);
  console.log(`Mode: ${mode}; tags: ${tags.join(", ")}`);

  if (http) {
    const base = (process.env.BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
    const token = process.env.AUTH_TOKEN;
    if (!token) {
      console.error("AUTH_TOKEN required for --http");
      process.exit(1);
    }
    const res = await fetch(`${base}/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries, mode, extraTags: tags }),
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    if (!res.ok) process.exit(1);

    if (vectorize) {
      const v = await fetch(`${base}/vectorize-pending`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 500 }),
      });
      console.log("vectorize-pending:", await v.text());
    }
    return;
  }

  // Direct SQLite path
  if (!process.env.AUTH_TOKEN) {
    process.env.AUTH_TOKEN = "import-cli-local";
  }
  const { env, databasePath } = createSelfhostEnv();
  await initializeDatabase(env);
  console.log("Database:", databasePath);

  const result = await importEntries(env.DB, entries, { mode, extraTags: tags });
  console.log(JSON.stringify(result, null, 2));

  if (vectorize) {
    console.log(
      "Note: --vectorize without --http is not wired (needs running embedding stack). " +
        "Start the server and run: curl -X POST $BASE_URL/vectorize-pending -H \"Authorization: Bearer $AUTH_TOKEN\""
    );
  }

  if (result.failed > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
