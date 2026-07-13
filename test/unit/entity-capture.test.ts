import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureEntry } from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import type { D1Mock } from "../helpers/d1-mock";
import { attachEntitiesToMemory } from "../../src/memory/entities";

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

  it("aggregates the same entity relation across multiple memory sources", async () => {
    const now = Date.now();
    await attachEntitiesToMemory(db as unknown as D1Database, {
      memoryId: "mem-1",
      observationId: "obs-1",
      entities: [
        { name: "Singularity", entityType: "project" },
        { name: "SQLite", entityType: "product" },
      ],
      relations: [
        {
          from: "Singularity",
          to: "SQLite",
          relationType: "uses",
          fact: "Singularity uses SQLite",
        },
      ],
      score: 0.8,
      createdAt: now - 100,
    });
    await attachEntitiesToMemory(db as unknown as D1Database, {
      memoryId: "mem-2",
      observationId: "obs-2",
      entities: [
        { name: "Singularity", entityType: "project" },
        { name: "SQLite", entityType: "product" },
      ],
      relations: [
        {
          from: "Singularity",
          to: "SQLite",
          relationType: "uses",
          fact: " singularity uses sqlite ",
        },
      ],
      score: 0.9,
      createdAt: now,
    });
    const repeatedNullObservationSource = {
      memoryId: "mem-3",
      entities: [
        { name: "Singularity", entityType: "project" as const },
        { name: "SQLite", entityType: "product" as const },
      ],
      relations: [
        {
          from: "Singularity",
          to: "SQLite",
          relationType: "uses" as const,
          fact: "Singularity uses SQLite",
        },
      ],
      score: 0.7,
      createdAt: now + 100,
    };
    await attachEntitiesToMemory(db as unknown as D1Database, repeatedNullObservationSource);
    await attachEntitiesToMemory(db as unknown as D1Database, repeatedNullObservationSource);

    const uses = db.entityRelations.filter((relation) => relation.relation_type === "uses");
    expect(uses).toHaveLength(1);
    expect(uses[0].evidence_count).toBe(3);
    expect(uses[0].score).toBe(0.9);
    expect(db.factSources).toHaveLength(3);
    expect(db.factSources.map((source) => source.memory_id).sort()).toEqual(["mem-1", "mem-2", "mem-3"]);
  });

  it("keeps identical facts in separate temporal windows", async () => {
    const now = Date.now();
    const base = {
      entities: [
        { name: "Singularity", entityType: "project" as const },
        { name: "SQLite", entityType: "product" as const },
      ],
      relations: [
        {
          from: "Singularity",
          to: "SQLite",
          relationType: "uses" as const,
          fact: "Singularity uses SQLite",
        },
      ],
      score: 0.8,
    };

    await attachEntitiesToMemory(db as unknown as D1Database, {
      ...base,
      memoryId: "mem-window-a",
      observationId: "obs-window-a",
      validFrom: 1_000,
      validTo: 2_000,
      createdAt: now - 300,
    });
    await attachEntitiesToMemory(db as unknown as D1Database, {
      ...base,
      memoryId: "mem-window-b",
      observationId: "obs-window-b",
      validFrom: 1_500,
      validTo: 2_500,
      score: 0.9,
      createdAt: now - 200,
    });
    await attachEntitiesToMemory(db as unknown as D1Database, {
      ...base,
      memoryId: "mem-window-c",
      observationId: "obs-window-c",
      validFrom: 200_000_000,
      validTo: 200_010_000,
      createdAt: now - 100,
    });

    const uses = db.entityRelations
      .filter((relation) => relation.relation_type === "uses")
      .sort((a, b) => Number(a.valid_from ?? 0) - Number(b.valid_from ?? 0));
    expect(uses).toHaveLength(2);
    expect(uses[0]).toMatchObject({
      evidence_count: 2,
      score: 0.9,
      valid_from: 1_000,
      valid_to: 2_500,
    });
    expect(uses[1]).toMatchObject({
      evidence_count: 1,
      valid_from: 200_000_000,
      valid_to: 200_010_000,
    });
    expect(db.factSources).toHaveLength(3);
  });

  it("does not invent Entity-to-Entity facts from co-mentions", async () => {
    const result = await attachEntitiesToMemory(db as unknown as D1Database, {
      memoryId: "mem-co-mentions",
      observationId: "obs-co-mentions",
      entities: [
        { name: "Singularity", entityType: "project" },
        { name: "Obsidian", entityType: "product" },
        { name: "SQLite", entityType: "product" },
      ],
      relations: [],
      score: 0.9,
      createdAt: Date.now(),
    });

    expect(result.entityIds).toHaveLength(3);
    expect(result.relationIds).toEqual([]);
    expect(db.memoryEntities).toHaveLength(3);
    expect(db.entityRelations).toEqual([]);
    expect(db.factSources).toEqual([]);
  });
});
