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

interface PullResult {
  entryId: string;
  path: string;
  markdown: string;
  revisionId: string | null;
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

  async recall(query: string): Promise<RecallResult[]> {
    this.assertConfigured();
    const response = await requestUrl({
      url: this.endpoint(`/recall?query=${encodeURIComponent(query)}&topK=10`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status >= 400) {
      const error = response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return Array.isArray(response.json?.results) ? response.json.results as RecallResult[] : [];
  }

  async pull(): Promise<PullResult[]> {
    this.assertConfigured();
    const response = await requestUrl({
      url: this.endpoint(`/integrations/obsidian/pull?vaultId=${encodeURIComponent(this.settings.vaultId)}&limit=100`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status >= 400) {
      const error = response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return Array.isArray(response.json?.results) ? response.json.results as PullResult[] : [];
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
    const content = await this.app.vault.read(file);
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    await this.client().push({
      vaultId: this.settings.vaultId,
      path: file.path,
      content,
      properties: {
        tags: frontmatterTags(frontmatter),
        status: frontmatter?.singularity_status,
        obsidianPath: file.path,
        obsidianLinks: this.app.metadataCache.getFileCache(file)?.links?.map((link) => link.link) ?? [],
      },
      entryId: frontmatter?.singularity_id,
      baseRevisionId: frontmatter?.singularity_revision,
    });
    new Notice("Saved note to Singularity.");
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
    const results = await this.client().pull();
    let written = 0;
    for (const item of results) {
      const targetPath = this.localManagedPath(item);
      await this.writeMarkdown(targetPath, item.markdown);
      written++;
    }
    new Notice(`Exported ${written} Singularity memories.`);
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
        const [results, links] = await Promise.all([
          this.plugin.client().recall(query),
          this.plugin.client().pull().catch(() => [] as PullResult[]),
        ]);
        const linkByEntry = new Map(links.map((item) => [item.entryId, item]));
        resultsEl.empty();
        if (!results.length) {
          resultsEl.createEl("div", { text: "No results." });
          return;
        }
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
      .setDesc("Bearer token for the Singularity API.")
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
