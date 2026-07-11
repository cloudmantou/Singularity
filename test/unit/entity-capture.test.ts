import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureEntry } from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import type { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<any>) => {
        pending.push(p);
      },
    } as any as ExecutionContext,
    drain: async () => {
      await Promise.allSettled(pending);
    },
  };
}

function makeExtractionAI(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") {
        return { data: [new Array(384).fill(0.1)] };
      }
      return new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(`data: {"response":${JSON.stringify(body)}}\n\n`)
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

describe("entity dual-write from capture", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("upserts entities, memory links, and temporal fact edges", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI({
        facts: [
          {
            content: "Singularity uses SQLite for personal memory storage.",
            kind: "semantic",
            memory_class: "fact",
            importance: 4,
            confidence: 0.91,
            valid_from: 1_700_000_000_000,
            reference_time: 1_700_000_000_000,
            entities: [
              { name: "Singularity", type: "project" },
              { name: "SQLite", type: "product" },
            ],
            relations: [
              {
                from: "Singularity",
                to: "SQLite",
                type: "uses",
                fact: "Singularity uses SQLite",
              },
              {
                from: "Singularity",
                to: "SQLite",
                type: "uses",
                fact: " singularity uses sqlite ",
              },
            ],
          },
        ],
      }),
    });

    const { ctx, drain } = makeCtx();
    const result = await captureEntry(
      "Singularity uses SQLite for personal memory storage.",
      ["work"],
      "api",
      env,
      ctx
    );
    await drain();

    expect(result.status).not.toBe("blocked");
    expect(db.entities.map((e) => e.name).sort()).toEqual(["SQLite", "Singularity"]);
    expect(db.memoryEntities.length).toBeGreaterThanOrEqual(2);
    expect(db.entityRelations.some((r) => r.relation_type === "uses")).toBe(true);
    const uses = db.entityRelations.find((r) => r.relation_type === "uses");
    expect(db.entityRelations.filter((r) => r.relation_type === "uses")).toHaveLength(1);
    expect(uses.valid_from).toBe(1_700_000_000_000);
    expect(uses.reference_time).toBe(1_700_000_000_000);
    expect(db.memories[0].reference_time).toBeTruthy();
  });
});
