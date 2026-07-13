import { describe, expect, it } from "vitest";
import {
  KnowledgeSourceRegistry,
  type KnowledgeSourceProvider,
} from "../../src/integrations/framework";
import { OBSIDIAN_SOURCE_PROVIDER } from "../../src/integrations/obsidian";
import { DEVELOPMENT_SESSION_PROVIDER } from "../../src/integrations/development-session";

describe("Knowledge Source Provider Registry", () => {
  it("normalizes Obsidian notes into stable Evidence provenance", () => {
    const provenance = OBSIDIAN_SOURCE_PROVIDER.normalizeProvenance({
      sourceId: "obsidian:vault-a:Projects/Singularity.md:block-1",
      sourceRevision: 7,
      sourceTimestamp: 1234,
      metadata: {
        vaultId: "vault-a",
        path: "Projects/Singularity.md",
        blockId: "block-1",
      },
    });

    expect(provenance).toEqual({
      sourceChannel: "obsidian",
      sourceIdentity: "obsidian:vault-a:Projects/Singularity.md:block-1",
      sourceUri: "obsidian://open?vault=vault-a&file=Projects%2FSingularity.md%23%5Eblock-1",
      authorType: "user",
      evidenceType: "user_written_note",
      rootEvidenceId: "obsidian:vault-a:Projects/Singularity.md:block-1",
      revision: 7,
      sourceTimestamp: 1234,
    });
  });

  it("lists public capabilities without provider secrets and rejects duplicate ids", () => {
    const registry = new KnowledgeSourceRegistry([
      OBSIDIAN_SOURCE_PROVIDER,
      DEVELOPMENT_SESSION_PROVIDER,
    ]);
    expect(registry.list()).toEqual(expect.arrayContaining([{
      id: "obsidian",
      name: "Obsidian",
      transport: "push_pull",
      syncModes: ["mirror", "snapshot", "append"],
      capabilities: ["push", "pull", "conflict_resolution", "managed_projection"],
    }, {
      id: "development-session",
      name: "Development Session",
      transport: "webhook",
      syncModes: ["append"],
      capabilities: ["capture_session", "project_recall"],
    }]));

    const duplicate: KnowledgeSourceProvider = {
      ...OBSIDIAN_SOURCE_PROVIDER,
      name: "Duplicate",
    };
    expect(() => new KnowledgeSourceRegistry([OBSIDIAN_SOURCE_PROVIDER, duplicate]))
      .toThrow("Duplicate knowledge source provider: obsidian");
  });
});
