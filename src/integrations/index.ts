import { KnowledgeSourceRegistry } from "./framework";
import { OBSIDIAN_SOURCE_PROVIDER } from "./obsidian";
import { DEVELOPMENT_SESSION_PROVIDER } from "./development-session";

export const knowledgeSourceRegistry = new KnowledgeSourceRegistry([
  OBSIDIAN_SOURCE_PROVIDER,
  DEVELOPMENT_SESSION_PROVIDER,
]);

export * from "./framework";
export * from "./obsidian";
export * from "./development-session";
