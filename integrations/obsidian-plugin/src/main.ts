import {
  App,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";

const VIEW_TYPE_SINGULARITY_SEARCH = "singularity-search";

interface SingularitySettings {
  endpoint: string;
  authToken: string;
  vaultId: string;
  managedFolder: string;
}

interface RecallResult {
  id: string;
  content: string;
  score?: number | null;
  relevance?: string;
  tags?: string[];
  source?: string;
  created_at?: number;
}

interface RecallResponse {
  answer?: string | null;
  citations?: Array<{
    ref: string;
    memoryId: string;
    claimId?: string | null;
    evidenceId?: string;
  }>;
  results: RecallResult[];
}

interface PullResult {
  objectType?: "memory" | "aggregate";
  entryId: string;
  path: string;
  markdown: string;
  revisionId: string | null;
  contentHash: string | null;
  syncEtag: string | null;
  lastSyncedRevisionId: string | null;
  lastSyncedContentHash: string | null;
  lastSyncedSyncEtag: string | null;
  syncStatus: string;
  syncDirection: string;
  link: {
    id: string;
    syncEtag?: string | null;
    lastSyncedSyncEtag?: string | null;
    syncStatus?: string | null;
    syncDirection?: string | null;
  };
  properties?: Record<string, unknown>;
}

interface AggregateResult {
  id: string;
  path: string;
  markdown: string;
  contentHash: string | null;
  syncEtag: string | null;
  generatedAt: number | null;
  staleAt: number | null;
  link?: {
    id: string;
    syncEtag?: string | null;
    lastSyncedSyncEtag?: string | null;
    syncStatus?: string | null;
    syncDirection?: string | null;
  } | null;
}

interface PullPage {
  results: PullResult[];
  nextCursor: string | null;
  hasMore: boolean;
}

const DEFAULT_SETTINGS: SingularitySettings = {
  endpoint: "",
  authToken: "",
  vaultId: "default-vault",
  managedFolder: "Singularity",
};

function cleanEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, " ").trim() || "memory";
}

function currentTimestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function frontmatterTags(cache: Record<string, unknown> | undefined): string[] {
  const tags = cache?.tags;
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === "string") return tags.split(/[,\s]+/).filter(Boolean);
  return [];
}

function extractMarkdownBody(raw: string, frontmatterEndOffset?: number): string {
  if (frontmatterEndOffset == null) return raw.trim();
  return raw.slice(frontmatterEndOffset).replace(/^\s+/, "").trim();
}

function normalizeForHash(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeForHash(content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedTagsKey(tags: unknown): string {
  const values = Array.isArray(tags)
    ? tags
    : typeof tags === "string"
      ? tags.split(/[,\s]+/)
      : [];
  return [...new Set(values.map((tag) => String(tag).trim().replace(/^#/, "").toLowerCase()).filter(Boolean))]
    .sort()
    .join("\n");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

class SingularityClient {
  constructor(private readonly settings: SingularitySettings) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.settings.authToken}`,
      "Content-Type": "application/json",
    };
  }

  private endpoint(path: string): string {
    return `${cleanEndpoint(this.settings.endpoint)}${path}`;
  }

  assertConfigured(): void {
    if (!cleanEndpoint(this.settings.endpoint)) throw new Error("Singularity endpoint is not configured.");
    if (!this.settings.authToken.trim()) throw new Error("Singularity auth token is not configured.");
  }

  async push(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertConfigured();
    const response = await requestUrl({
      url: this.endpoint("/integrations/obsidian/push"),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      throw: false,
    });
    if (response.status >= 400) {
      const error = response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return response.json as Record<string, unknown>;
  }

  async upsertRule(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertConfigured();
    const response = await requestUrl({
      url: this.endpoint("/integrations/obsidian/rules"),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      throw: false,
    });
    if (response.status >= 400) {
      const error = response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return response.json as Record<string, unknown>;
  }

  async recall(query: string): Promise<RecallResponse> {
    this.assertConfigured();
    const response = await requestUrl({
      url: this.endpoint(`/recall?query=${encodeURIComponent(query)}&topK=10&vaultId=${encodeURIComponent(this.settings.vaultId)}`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status >= 400) {
      const error = response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return {
      answer: typeof response.json?.answer === "string" ? response.json.answer : null,
      citations: Array.isArray(response.json?.citations)
        ? response.json.citations as RecallResponse["citations"]
        : [],
      results: Array.isArray(response.json?.results) ? response.json.results as RecallResult[] : [],
    };
  }

  async ack(item: PullResult): Promise<void> {
    this.assertConfigured();
    const response = await requestUrl({
      url: this.endpoint("/integrations/obsidian/ack"),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        linkId: item.link.id,
        vaultId: this.settings.vaultId,
        revisionId: item.revisionId,
        contentHash: item.contentHash,
        syncEtag: item.syncEtag || item.link.syncEtag,
      }),
      throw: false,
    });
    if (response.status >= 400) {
      const error = response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
  }

  async pullPage(cursor?: string): Promise<PullPage> {
    this.assertConfigured();
    const params = new URLSearchParams({
      vaultId: this.settings.vaultId,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const response = await requestUrl({
      url: this.endpoint(`/integrations/obsidian/pull?${params.toString()}`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status >= 400) {
      const error = response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return {
      results: Array.isArray(response.json?.results) ? response.json.results as PullResult[] : [],
      nextCursor: typeof response.json?.nextCursor === "string" ? response.json.nextCursor : null,
      hasMore: response.json?.hasMore === true,
    };
  }

  async pull(): Promise<PullResult[]> {
    const all: PullResult[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.pullPage(cursor);
      all.push(...result.results);
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return all;
  }

  async pullAggregates(): Promise<PullResult[]> {
    this.assertConfigured();
    const params = new URLSearchParams({ vaultId: this.settings.vaultId });
    const response = await requestUrl({
      url: this.endpoint(`/integrations/obsidian/aggregates?${params.toString()}`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status >= 400) {
      const error = response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    const aggregates = Array.isArray(response.json?.results)
      ? response.json.results as AggregateResult[]
      : [];
    return aggregates.map((item) => ({
      objectType: "aggregate",
      entryId: item.id,
      path: item.path,
      markdown: item.markdown,
      revisionId: item.generatedAt == null ? null : String(item.generatedAt),
      contentHash: item.contentHash,
      syncEtag: item.syncEtag,
      lastSyncedRevisionId: item.generatedAt == null ? null : String(item.generatedAt),
      lastSyncedContentHash: item.contentHash,
      lastSyncedSyncEtag: item.link?.lastSyncedSyncEtag ?? null,
      syncStatus: item.link?.syncStatus ?? (item.staleAt ? "remote_changed" : "synced"),
      syncDirection: item.link?.syncDirection ?? "singularity_to_obsidian",
      link: {
        id: item.link?.id ?? item.id,
        syncEtag: item.link?.syncEtag ?? item.syncEtag,
        lastSyncedSyncEtag: item.link?.lastSyncedSyncEtag ?? null,
        syncStatus: item.link?.syncStatus ?? null,
        syncDirection: item.link?.syncDirection ?? null,
      },
      properties: {
        singularity_type: "knowledge-aggregate",
        singularity_id: item.id,
        singularity_revision: item.generatedAt == null ? "" : String(item.generatedAt),
        singularity_sync_etag: item.syncEtag,
        singularity_status: item.staleAt ? "stale" : "canonical",
        tags: ["singularity", "aggregate"],
      },
    }));
  }
}

export default class SingularityPlugin extends Plugin {
  settings: SingularitySettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(
      VIEW_TYPE_SINGULARITY_SEARCH,
      (leaf) => new SingularitySearchView(leaf, this)
    );

    this.addCommand({
      id: "save-current-note",
      name: "Save current note",
      callback: () => this.saveCurrentNote(),
    });
    this.addCommand({
      id: "save-selection",
      name: "Save selection",
      editorCallback: (editor) => this.saveSelection(editor.getSelection()),
    });
    this.addCommand({
      id: "open-search",
      name: "Open search",
      callback: () => this.activateSearchView(),
    });
    this.addCommand({
      id: "export-managed-memories",
      name: "Export managed memories",
      callback: () => this.exportManagedMemories(),
    });
    this.addSettingTab(new SingularitySettingTab(this.app, this));
  }

  client(): SingularityClient {
    return new SingularityClient(this.settings);
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveCurrentNote(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (!file) {
      new Notice("No active Markdown note.");
      return;
    }
    const raw = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    const content = extractMarkdownBody(raw, cache?.frontmatterPosition?.end.offset);
    const singularityType = stringValue(frontmatter?.singularity_type);
    if (singularityType === "knowledge-aggregate") {
      new Notice("Singularity aggregate pages are read-only. Pull/export to refresh them.");
      return;
    }
    if (singularityType === "rule-template") {
      await this.saveRuleTemplate(file, frontmatter, content);
      return;
    }
    const pushed = await this.client().push({
      vaultId: this.settings.vaultId,
      path: file.path,
      content,
      properties: {
        ...(frontmatter ?? {}),
        tags: frontmatterTags(frontmatter),
        status: frontmatter?.singularity_status,
        obsidianPath: file.path,
        obsidianLinks: cache?.links?.map((link) => link.link) ?? [],
      },
      entryId: singularityType === "atomic-memory" ? frontmatter?.singularity_id : undefined,
      baseRevisionId: singularityType === "atomic-memory" ? frontmatter?.singularity_revision : undefined,
      baseSyncEtag: singularityType === "atomic-memory" ? frontmatter?.singularity_sync_etag : undefined,
      sourceId: singularityType === "atomic-memory" ? undefined : frontmatter?.singularity_source_id,
    });
    if (singularityType === "atomic-memory") {
      await this.app.fileManager.processFrontMatter(file, (data) => {
        if (pushed.revisionId) data.singularity_revision = pushed.revisionId;
        if (pushed.link && typeof pushed.link === "object" && "syncEtag" in pushed.link) {
          data.singularity_sync_etag = (pushed.link as Record<string, unknown>).syncEtag;
        }
      });
    } else if (pushed.sourceId) {
      await this.app.fileManager.processFrontMatter(file, (data) => {
        data.singularity_type = "raw-material";
        data.singularity_source_id = pushed.sourceId;
        data.singularity_observation_id = pushed.observationId;
        data.singularity_source_revision = pushed.sourceRevision;
        data.singularity_source_hash = pushed.sourceHash;
        data.singularity_memory_ids = Array.isArray(pushed.memoryIds) ? pushed.memoryIds : [];
      });
    }
    new Notice("Saved note to Singularity.");
  }

  async saveRuleTemplate(
    file: TFile,
    frontmatter: Record<string, unknown> | undefined,
    content: string
  ): Promise<void> {
    const rule = await this.client().upsertRule({
      id: frontmatter?.singularity_id,
      vaultId: this.settings.vaultId,
      name: stringValue(frontmatter?.name) ?? file.basename,
      triggerType: stringValue(frontmatter?.trigger_type) ?? "manual",
      sourceFilter: objectValue(frontmatter?.source_filter),
      extractorSchema: objectValue(frontmatter?.extractor_schema),
      tagRules: objectValue(frontmatter?.tag_rules),
      aggregationRule: objectValue(frontmatter?.aggregation_rule),
      outputTemplate: content,
      enabled: frontmatter?.enabled !== false,
    });
    const savedRule = objectValue(rule.rule);
    await this.app.fileManager.processFrontMatter(file, (data) => {
      data.singularity_type = "rule-template";
      data.singularity_id = savedRule.id;
      data.singularity_status = data.singularity_status ?? "canonical";
      data.singularity_source = "obsidian";
      data.singularity_synced_at = new Date().toISOString();
      data.managed_by = data.managed_by ?? "user";
    });
    new Notice("Saved rule template to Singularity.");
  }

  async saveSelection(selection: string): Promise<void> {
    const trimmed = selection.trim();
    if (!trimmed) {
      new Notice("No selected text.");
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    const title = safeFileName(file?.basename ?? "selection");
    const path = normalizePath(`${this.settings.managedFolder}/Inbox/${title}-${currentTimestampSlug()}.md`);
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    await this.client().push({
      vaultId: this.settings.vaultId,
      path,
      content: trimmed,
      properties: {
        tags: frontmatterTags(frontmatter),
        obsidianPath: file?.path,
        selection: true,
      },
    });
    new Notice("Saved selection to Singularity.");
  }

  async activateSearchView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SINGULARITY_SEARCH);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: VIEW_TYPE_SINGULARITY_SEARCH, active: true });
  }

  async exportManagedMemories(): Promise<void> {
    const [memories, aggregates] = await Promise.all([
      this.client().pull(),
      this.client().pullAggregates(),
    ]);
    const results = [...memories, ...aggregates];
    let written = 0;
    let skipped = 0;
    let conflicts = 0;
    for (const item of results) {
      const targetPath = this.localManagedPath(item);
      const outcome = await this.writeManagedMarkdownSafely(targetPath, item);
      if (outcome === "written") written++;
      else if (outcome === "conflict") conflicts++;
      else skipped++;
    }
    new Notice(`Exported ${written} Singularity items. Skipped ${skipped}; conflicts ${conflicts}.`);
  }

  localManagedPath(item: PullResult): string {
    const folder = normalizePath(this.settings.managedFolder || "Singularity");
    const remotePath = normalizePath(item.path);
    if (remotePath === folder || remotePath.startsWith(`${folder}/`)) return remotePath;
    return normalizePath(`${folder}/Memories/${safeFileName(item.entryId)}.md`);
  }

  async writeMarkdown(path: string, content: string): Promise<void> {
    await this.ensureParentFolder(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    if (existing) throw new Error(`${path} exists but is not a file.`);
    await this.app.vault.create(path, content);
  }

  async writeManagedMarkdownSafely(path: string, item: PullResult): Promise<"written" | "skipped" | "conflict"> {
    if (item.syncDirection === "obsidian_to_singularity") return "skipped";
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const raw = await this.app.vault.read(existing);
      const cache = this.app.metadataCache.getFileCache(existing);
      const localBody = extractMarkdownBody(raw, cache?.frontmatterPosition?.end.offset);
      const localBodyHash = await sha256Hex(localBody);
      const frontmatter = cache?.frontmatter ?? {};
      const localRevision = stringValue(frontmatter.singularity_revision);
      const remoteProperties = item.properties ?? {};
      const localStatus = stringValue(frontmatter.singularity_status) ?? "draft";
      const remoteStatus = stringValue(remoteProperties.singularity_status) ?? "draft";
      const localKind = stringValue(frontmatter.singularity_kind) ?? "semantic";
      const remoteKind = stringValue(remoteProperties.singularity_kind) ?? "semantic";
      const frontmatterChanged =
        localStatus !== remoteStatus ||
        localKind !== remoteKind ||
        normalizedTagsKey(frontmatterTags(frontmatter)) !== normalizedTagsKey(remoteProperties.tags);
      const localChanged =
        localRevision === item.lastSyncedRevisionId &&
        (Boolean(item.lastSyncedContentHash) || Boolean(item.lastSyncedSyncEtag)) &&
        (localBodyHash !== item.lastSyncedContentHash || frontmatterChanged);
      const remoteChanged =
        (Boolean(item.syncEtag) && item.syncEtag !== item.lastSyncedSyncEtag) ||
        item.revisionId !== item.lastSyncedRevisionId ||
        item.contentHash !== item.lastSyncedContentHash ||
        item.syncStatus === "remote_changed";

      if (localChanged && remoteChanged) return "conflict";
      if (localChanged && !remoteChanged) return "skipped";
      if (!remoteChanged && localBodyHash === item.contentHash) return "skipped";
      await this.app.vault.modify(existing, item.markdown);
      if (item.objectType !== "aggregate") await this.client().ack(item);
      return "written";
    }

    if (existing) throw new Error(`${path} exists but is not a file.`);
    await this.writeMarkdown(path, item.markdown);
    if (item.objectType !== "aggregate") await this.client().ack(item);
    return "written";
  }

  async ensureParentFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}

class SingularitySearchView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: SingularityPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SINGULARITY_SEARCH;
  }

  getDisplayText(): string {
    return "Singularity";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const container = this.containerEl.children[1];
    container.empty();
    container.createEl("h3", { text: "Singularity" });
    const input = container.createEl("input", {
      type: "search",
      placeholder: "Search memory",
    });
    input.style.width = "100%";
    const resultsEl = container.createDiv();

    const runSearch = async () => {
      const query = input.value.trim();
      if (!query) return;
      resultsEl.empty();
      resultsEl.createEl("div", { text: "Searching..." });
      try {
        const [recall, links] = await Promise.all([
          this.plugin.client().recall(query),
          this.plugin.client().pull().catch(() => [] as PullResult[]),
        ]);
        const results = recall.results;
        const linkByEntry = new Map(links.map((item) => [item.entryId, item]));
        resultsEl.empty();
        if (!results.length) {
          resultsEl.createEl("div", { text: "No results." });
          return;
        }
        if (recall.answer) {
          resultsEl.createEl("h4", { text: "Answer" });
          resultsEl.createEl("p", { text: recall.answer });
        }
        resultsEl.createEl("h4", { text: "Sources" });
        for (const result of results) {
          const item = resultsEl.createDiv();
          item.addClass("singularity-result");
          item.createEl("strong", { text: result.relevance || `Score ${result.score ?? ""}` });
          item.createEl("p", { text: result.content });
          item.onclick = () => this.openLinkedNote(linkByEntry.get(result.id));
        }
      } catch (error) {
        resultsEl.empty();
        resultsEl.createEl("div", { text: error instanceof Error ? error.message : String(error) });
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void runSearch();
    });
  }

  async openLinkedNote(item: PullResult | undefined): Promise<void> {
    if (!item) {
      new Notice("This memory is not linked to a local Markdown note yet.");
      return;
    }
    const path = this.plugin.localManagedPath(item);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.plugin.writeMarkdown(path, item.markdown);
      file = this.app.vault.getAbstractFileByPath(path);
    }
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}

class SingularitySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SingularityPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Singularity endpoint")
      .setDesc("Example: https://agent.mtzs.cloud")
      .addText((text) => text
        .setPlaceholder("https://agent.mtzs.cloud")
        .setValue(this.plugin.settings.endpoint)
        .onChange(async (value) => {
          this.plugin.settings.endpoint = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Use an Obsidian-scoped Singularity token. Do not use the server owner AUTH_TOKEN.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("AUTH_TOKEN")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("Stable vault identifier used by Singularity external links.")
      .addText((text) => text
        .setPlaceholder("work-vault")
        .setValue(this.plugin.settings.vaultId)
        .onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim() || DEFAULT_SETTINGS.vaultId;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Managed folder")
      .setDesc("Only this folder is written when exporting Singularity memories.")
      .addText((text) => text
        .setPlaceholder("Singularity")
        .setValue(this.plugin.settings.managedFolder)
        .onChange(async (value) => {
          this.plugin.settings.managedFolder = normalizePath(value.trim() || DEFAULT_SETTINGS.managedFolder);
          await this.plugin.saveSettings();
        }));
  }
}
