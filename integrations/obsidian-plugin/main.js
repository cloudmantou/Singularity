var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SingularityPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var VIEW_TYPE_SINGULARITY_SEARCH = "singularity-search";
var DEFAULT_SETTINGS = {
  endpoint: "",
  authToken: "",
  vaultId: "default-vault",
  managedFolder: "Singularity"
};
function cleanEndpoint(endpoint) {
  return endpoint.trim().replace(/\/+$/, "");
}
function safeFileName(value) {
  return value.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, " ").trim() || "memory";
}
function currentTimestampSlug() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
function frontmatterTags(cache) {
  const tags = cache == null ? void 0 : cache.tags;
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === "string") return tags.split(/[,\s]+/).filter(Boolean);
  return [];
}
var SingularityClient = class {
  constructor(settings) {
    this.settings = settings;
  }
  headers() {
    return {
      Authorization: `Bearer ${this.settings.authToken}`,
      "Content-Type": "application/json"
    };
  }
  endpoint(path) {
    return `${cleanEndpoint(this.settings.endpoint)}${path}`;
  }
  assertConfigured() {
    if (!cleanEndpoint(this.settings.endpoint)) throw new Error("Singularity endpoint is not configured.");
    if (!this.settings.authToken.trim()) throw new Error("Singularity auth token is not configured.");
  }
  async push(body) {
    var _a;
    this.assertConfigured();
    const response = await (0, import_obsidian.requestUrl)({
      url: this.endpoint("/integrations/obsidian/push"),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      throw: false
    });
    if (response.status >= 400) {
      const error = ((_a = response.json) == null ? void 0 : _a.error) || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return response.json;
  }
  async recall(query) {
    var _a, _b;
    this.assertConfigured();
    const response = await (0, import_obsidian.requestUrl)({
      url: this.endpoint(`/recall?query=${encodeURIComponent(query)}&topK=10`),
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status >= 400) {
      const error = ((_a = response.json) == null ? void 0 : _a.error) || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return Array.isArray((_b = response.json) == null ? void 0 : _b.results) ? response.json.results : [];
  }
  async pull() {
    var _a, _b;
    this.assertConfigured();
    const response = await (0, import_obsidian.requestUrl)({
      url: this.endpoint(`/integrations/obsidian/pull?vaultId=${encodeURIComponent(this.settings.vaultId)}&limit=100`),
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status >= 400) {
      const error = ((_a = response.json) == null ? void 0 : _a.error) || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return Array.isArray((_b = response.json) == null ? void 0 : _b.results) ? response.json.results : [];
  }
};
var SingularityPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
  }
  async onload() {
    await this.loadSettings();
    this.registerView(
      VIEW_TYPE_SINGULARITY_SEARCH,
      (leaf) => new SingularitySearchView(leaf, this)
    );
    this.addCommand({
      id: "save-current-note",
      name: "Save current note",
      callback: () => this.saveCurrentNote()
    });
    this.addCommand({
      id: "save-selection",
      name: "Save selection",
      editorCallback: (editor) => this.saveSelection(editor.getSelection())
    });
    this.addCommand({
      id: "open-search",
      name: "Open search",
      callback: () => this.activateSearchView()
    });
    this.addCommand({
      id: "export-managed-memories",
      name: "Export managed memories",
      callback: () => this.exportManagedMemories()
    });
    this.addSettingTab(new SingularitySettingTab(this.app, this));
  }
  client() {
    return new SingularityClient(this.settings);
  }
  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async saveCurrentNote() {
    var _a, _b, _c, _d;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    const file = view == null ? void 0 : view.file;
    if (!file) {
      new import_obsidian.Notice("No active Markdown note.");
      return;
    }
    const content = await this.app.vault.read(file);
    const frontmatter = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter;
    await this.client().push({
      vaultId: this.settings.vaultId,
      path: file.path,
      content,
      properties: {
        tags: frontmatterTags(frontmatter),
        status: frontmatter == null ? void 0 : frontmatter.singularity_status,
        obsidianPath: file.path,
        obsidianLinks: (_d = (_c = (_b = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _b.links) == null ? void 0 : _c.map((link) => link.link)) != null ? _d : []
      },
      entryId: frontmatter == null ? void 0 : frontmatter.singularity_id,
      baseRevisionId: frontmatter == null ? void 0 : frontmatter.singularity_revision
    });
    new import_obsidian.Notice("Saved note to Singularity.");
  }
  async saveSelection(selection) {
    var _a, _b;
    const trimmed = selection.trim();
    if (!trimmed) {
      new import_obsidian.Notice("No selected text.");
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    const file = view == null ? void 0 : view.file;
    const title = safeFileName((_a = file == null ? void 0 : file.basename) != null ? _a : "selection");
    const path = (0, import_obsidian.normalizePath)(`${this.settings.managedFolder}/Inbox/${title}-${currentTimestampSlug()}.md`);
    const frontmatter = file ? (_b = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _b.frontmatter : void 0;
    await this.client().push({
      vaultId: this.settings.vaultId,
      path,
      content: trimmed,
      properties: {
        tags: frontmatterTags(frontmatter),
        obsidianPath: file == null ? void 0 : file.path,
        selection: true
      }
    });
    new import_obsidian.Notice("Saved selection to Singularity.");
  }
  async activateSearchView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SINGULARITY_SEARCH);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await (leaf == null ? void 0 : leaf.setViewState({ type: VIEW_TYPE_SINGULARITY_SEARCH, active: true }));
  }
  async exportManagedMemories() {
    const results = await this.client().pull();
    let written = 0;
    for (const item of results) {
      const targetPath = this.localManagedPath(item);
      await this.writeMarkdown(targetPath, item.markdown);
      written++;
    }
    new import_obsidian.Notice(`Exported ${written} Singularity memories.`);
  }
  localManagedPath(item) {
    const folder = (0, import_obsidian.normalizePath)(this.settings.managedFolder || "Singularity");
    const remotePath = (0, import_obsidian.normalizePath)(item.path);
    if (remotePath === folder || remotePath.startsWith(`${folder}/`)) return remotePath;
    return (0, import_obsidian.normalizePath)(`${folder}/Memories/${safeFileName(item.entryId)}.md`);
  }
  async writeMarkdown(path, content) {
    await this.ensureParentFolder(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian.TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    if (existing) throw new Error(`${path} exists but is not a file.`);
    await this.app.vault.create(path, content);
  }
  async ensureParentFolder(path) {
    const parts = (0, import_obsidian.normalizePath)(path).split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
};
var SingularitySearchView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_SINGULARITY_SEARCH;
  }
  getDisplayText() {
    return "Singularity";
  }
  async onOpen() {
    this.render();
  }
  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.createEl("h3", { text: "Singularity" });
    const input = container.createEl("input", {
      type: "search",
      placeholder: "Search memory"
    });
    input.style.width = "100%";
    const resultsEl = container.createDiv();
    const runSearch = async () => {
      var _a;
      const query = input.value.trim();
      if (!query) return;
      resultsEl.empty();
      resultsEl.createEl("div", { text: "Searching..." });
      try {
        const [results, links] = await Promise.all([
          this.plugin.client().recall(query),
          this.plugin.client().pull().catch(() => [])
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
          item.createEl("strong", { text: result.relevance || `Score ${(_a = result.score) != null ? _a : ""}` });
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
  async openLinkedNote(item) {
    if (!item) {
      new import_obsidian.Notice("This memory is not linked to a local Markdown note yet.");
      return;
    }
    const path = this.plugin.localManagedPath(item);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian.TFile)) {
      await this.plugin.writeMarkdown(path, item.markdown);
      file = this.app.vault.getAbstractFileByPath(path);
    }
    if (file instanceof import_obsidian.TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
};
var SingularitySettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Singularity endpoint").setDesc("Example: https://agent.mtzs.cloud").addText((text) => text.setPlaceholder("https://agent.mtzs.cloud").setValue(this.plugin.settings.endpoint).onChange(async (value) => {
      this.plugin.settings.endpoint = value.trim();
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Auth token").setDesc("Bearer token for the Singularity API.").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("AUTH_TOKEN").setValue(this.plugin.settings.authToken).onChange(async (value) => {
        this.plugin.settings.authToken = value.trim();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Vault ID").setDesc("Stable vault identifier used by Singularity external links.").addText((text) => text.setPlaceholder("work-vault").setValue(this.plugin.settings.vaultId).onChange(async (value) => {
      this.plugin.settings.vaultId = value.trim() || DEFAULT_SETTINGS.vaultId;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Managed folder").setDesc("Only this folder is written when exporting Singularity memories.").addText((text) => text.setPlaceholder("Singularity").setValue(this.plugin.settings.managedFolder).onChange(async (value) => {
      this.plugin.settings.managedFolder = (0, import_obsidian.normalizePath)(value.trim() || DEFAULT_SETTINGS.managedFolder);
      await this.plugin.saveSettings();
    }));
  }
};
