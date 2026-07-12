import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");

describe("web memory mutation API contract", () => {
  it("uses REST for append, update, and forget instead of routing the UI through MCP", () => {
    expect(html).not.toContain("async function apiMcp");
    expect(html).toMatch(/async function apiAppend[\s\S]*?\/append/);
    expect(html).toMatch(/async function apiUpdate[\s\S]*?\/update/);
    expect(html).toMatch(/async function apiForget[\s\S]*?\/forget/);
    expect(html).toContain("await apiAppend(pendingAppendId, addition)");
    expect(html).toContain("await apiUpdate(pendingEditId, newContent)");
    expect(html).toContain("await apiForget(idToForget)");
  });

  it("validates capture, append, update, and forget REST responses", () => {
    expect((html.match(/parseApiJsonResponse\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("treats atomic memory sync failures as append and update errors", () => {
    expect(html).toContain('id="runtime-warning"');
    expect(html).not.toContain("function showAtomicSyncWarning(result)");
    expect(html).not.toContain("result.warning === 'atomic_sync_failed'");
    expect(html).toContain("await apiAppend(pendingAppendId, addition)");
    expect(html).toContain("await apiUpdate(pendingEditId, newContent)");
  });

  it("imports backups sequentially in D1-safe batches", () => {
    expect(html).toContain("await importEntriesInBatches(entries");
  });

  it("preserves graph recall evidence into source cards and chat context", () => {
    expect(html).toContain("scoreDetails: m.score_details || {}");
    expect(html).toContain("matchedEntities: m.matched_entities || []");
    expect(html).toContain("graphFacts: m.graph_facts || []");
    expect(html).toContain("timeBasis: m.time_basis || null");
    expect(html).toContain("Time basis:");
    expect(html).toContain("语义向量服务不可用，当前使用关键词 + 知识图谱降级召回。");
    expect(html).toContain("Matched entities:");
    expect(html).toContain("Current graph facts:");
    expect(html).toContain("const graphContext = [");
    expect(html).toContain("class=\"recall-explain\"");
    expect(html).toContain("<summary>Why recalled</summary>");
    expect(html).toContain("recall-signal-grid");
    expect(html).toContain("function formatTimeBasis(value)");
    expect(html).toContain("formatRecallSignal(scoreDetails.temporal)");
  });

  it("surfaces vector runtime state in the observatory system view", () => {
    expect(html).toContain('id="obs-vector-runtime-section"');
    expect(html).toContain('id="obs-vector-runtime-grid"');
    expect(html).toContain("function obsRenderVectorRuntime(runtime)");
    expect(html).toContain("data.vector_runtime || {}");
    expect(html).toContain("obsApi('/analytics/vector-runtime')");
    expect(html).toContain("t('obs.vector.rebuildState')");
    expect(html).toContain("t('obs.vector.cleanupQueue')");
    expect(html).toContain("t('obs.vector.ftsIndex')");
    expect(html).toContain("t('obs.vector.annIndex')");
    expect(html).toContain("filteredQueryBackend");
    expect(html).toContain("filteredVecAvailable");
    expect(html).toContain("t('obs.vector.filteredKnn')");
  });
});
