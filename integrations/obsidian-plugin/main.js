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
function extractMarkdownBody(raw, frontmatterEndOffset) {
  if (frontmatterEndOffset == null) return raw.trim();
  return raw.slice(frontmatterEndOffset).replace(/^\s+/, "").trim();
}
function normalizeForHash(content) {
  return content.trim().replace(/\s+/g, " ");
}
async function sha256Hex(content) {
  const bytes = new TextEncoder().encode(normalizeForHash(content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function normalizedTagsKey(tags) {
  const values = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/[,\s]+/) : [];
  return [...new Set(values.map((tag) => String(tag).trim().replace(/^#/, "").toLowerCase()).filter(Boolean))].sort().join("\n");
}
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  async upsertRule(body) {
    var _a;
    this.assertConfigured();
    const response = await (0, import_obsidian.requestUrl)({
      url: this.endpoint("/integrations/obsidian/rules"),
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
      url: this.endpoint(`/recall?query=${encodeURIComponent(query)}&topK=10&vaultId=${encodeURIComponent(this.settings.vaultId)}`),
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
  async ack(item) {
    var _a;
    this.assertConfigured();
    const response = await (0, import_obsidian.requestUrl)({
      url: this.endpoint("/integrations/obsidian/ack"),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        linkId: item.link.id,
        vaultId: this.settings.vaultId,
        revisionId: item.revisionId,
        contentHash: item.contentHash,
        syncEtag: item.syncEtag || item.link.syncEtag
      }),
      throw: false
    });
    if (response.status >= 400) {
      const error = ((_a = response.json) == null ? void 0 : _a.error) || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
  }
  async pullPage(cursor) {
    var _a, _b, _c, _d;
    this.assertConfigured();
    const params = new URLSearchParams({
      vaultId: this.settings.vaultId,
      limit: "100"
    });
    if (cursor) params.set("cursor", cursor);
    const response = await (0, import_obsidian.requestUrl)({
      url: this.endpoint(`/integrations/obsidian/pull?${params.toString()}`),
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status >= 400) {
      const error = ((_a = response.json) == null ? void 0 : _a.error) || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    return {
      results: Array.isArray((_b = response.json) == null ? void 0 : _b.results) ? response.json.results : [],
      nextCursor: typeof ((_c = response.json) == null ? void 0 : _c.nextCursor) === "string" ? response.json.nextCursor : null,
      hasMore: ((_d = response.json) == null ? void 0 : _d.hasMore) === true
    };
  }
  async pull() {
    const all = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.pullPage(cursor);
      all.push(...result.results);
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return all;
  }
  async pullAggregates() {
    var _a, _b;
    this.assertConfigured();
    const params = new URLSearchParams({ vaultId: this.settings.vaultId });
    const response = await (0, import_obsidian.requestUrl)({
      url: this.endpoint(`/integrations/obsidian/aggregates?${params.toString()}`),
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status >= 400) {
      const error = ((_a = response.json) == null ? void 0 : _a.error) || response.text || `HTTP ${response.status}`;
      throw new Error(String(error));
    }
    const aggregates = Array.isArray((_b = response.json) == null ? void 0 : _b.results) ? response.json.results : [];
    return aggregates.map((item) => {
      var _a2, _b2, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p;
      return {
        objectType: "aggregate",
        entryId: item.id,
        path: item.path,
        markdown: item.markdown,
        revisionId: item.generatedAt == null ? null : String(item.generatedAt),
        contentHash: item.contentHash,
        syncEtag: item.syncEtag,
        lastSyncedRevisionId: item.generatedAt == null ? null : String(item.generatedAt),
        lastSyncedContentHash: item.contentHash,
        lastSyncedSyncEtag: (_b2 = (_a2 = item.link) == null ? void 0 : _a2.lastSyncedSyncEtag) != null ? _b2 : null,
        syncStatus: (_d = (_c = item.link) == null ? void 0 : _c.syncStatus) != null ? _d : item.staleAt ? "remote_changed" : "synced",
        syncDirection: (_f = (_e = item.link) == null ? void 0 : _e.syncDirection) != null ? _f : "singularity_to_obsidian",
        link: {
          id: (_h = (_g = item.link) == null ? void 0 : _g.id) != null ? _h : item.id,
          syncEtag: (_j = (_i = item.link) == null ? void 0 : _i.syncEtag) != null ? _j : item.syncEtag,
          lastSyncedSyncEtag: (_l = (_k = item.link) == null ? void 0 : _k.lastSyncedSyncEtag) != null ? _l : null,
          syncStatus: (_n = (_m = item.link) == null ? void 0 : _m.syncStatus) != null ? _n : null,
          syncDirection: (_p = (_o = item.link) == null ? void 0 : _o.syncDirection) != null ? _p : null
        },
        properties: {
          singularity_type: "knowledge-aggregate",
          singularity_id: item.id,
          singularity_revision: item.generatedAt == null ? "" : String(item.generatedAt),
          singularity_sync_etag: item.syncEtag,
          singularity_status: item.staleAt ? "stale" : "canonical",
          tags: ["singularity", "aggregate"]
        }
      };
    });
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
    var _a, _b, _c;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    const file = view == null ? void 0 : view.file;
    if (!file) {
      new import_obsidian.Notice("No active Markdown note.");
      return;
    }
    const raw = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache == null ? void 0 : cache.frontmatter;
    const content = extractMarkdownBody(raw, (_a = cache == null ? void 0 : cache.frontmatterPosition) == null ? void 0 : _a.end.offset);
    const singularityType = stringValue(frontmatter == null ? void 0 : frontmatter.singularity_type);
    if (singularityType === "knowledge-aggregate") {
      new import_obsidian.Notice("Singularity aggregate pages are read-only. Pull/export to refresh them.");
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
        ...frontmatter != null ? frontmatter : {},
        tags: frontmatterTags(frontmatter),
        status: frontmatter == null ? void 0 : frontmatter.singularity_status,
        obsidianPath: file.path,
        obsidianLinks: (_c = (_b = cache == null ? void 0 : cache.links) == null ? void 0 : _b.map((link) => link.link)) != null ? _c : []
      },
      entryId: singularityType === "atomic-memory" ? frontmatter == null ? void 0 : frontmatter.singularity_id : void 0,
      baseRevisionId: singularityType === "atomic-memory" ? frontmatter == null ? void 0 : frontmatter.singularity_revision : void 0,
      baseSyncEtag: singularityType === "atomic-memory" ? frontmatter == null ? void 0 : frontmatter.singularity_sync_etag : void 0,
      sourceId: singularityType === "atomic-memory" ? void 0 : frontmatter == null ? void 0 : frontmatter.singularity_source_id
    });
    if (singularityType === "atomic-memory") {
      await this.app.fileManager.processFrontMatter(file, (data) => {
        if (pushed.revisionId) data.singularity_revision = pushed.revisionId;
        if (pushed.link && typeof pushed.link === "object" && "syncEtag" in pushed.link) {
          data.singularity_sync_etag = pushed.link.syncEtag;
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
    new import_obsidian.Notice("Saved note to Singularity.");
  }
  async saveRuleTemplate(file, frontmatter, content) {
    var _a, _b;
    const rule = await this.client().upsertRule({
      id: frontmatter == null ? void 0 : frontmatter.singularity_id,
      vaultId: this.settings.vaultId,
      name: (_a = stringValue(frontmatter == null ? void 0 : frontmatter.name)) != null ? _a : file.basename,
      triggerType: (_b = stringValue(frontmatter == null ? void 0 : frontmatter.trigger_type)) != null ? _b : "manual",
      sourceFilter: objectValue(frontmatter == null ? void 0 : frontmatter.source_filter),
      extractorSchema: objectValue(frontmatter == null ? void 0 : frontmatter.extractor_schema),
      tagRules: objectValue(frontmatter == null ? void 0 : frontmatter.tag_rules),
      aggregationRule: objectValue(frontmatter == null ? void 0 : frontmatter.aggregation_rule),
      outputTemplate: content,
      enabled: (frontmatter == null ? void 0 : frontmatter.enabled) !== false
    });
    const savedRule = objectValue(rule.rule);
    await this.app.fileManager.processFrontMatter(file, (data) => {
      var _a2, _b2;
      data.singularity_type = "rule-template";
      data.singularity_id = savedRule.id;
      data.singularity_status = (_a2 = data.singularity_status) != null ? _a2 : "canonical";
      data.singularity_source = "obsidian";
      data.singularity_synced_at = (/* @__PURE__ */ new Date()).toISOString();
      data.managed_by = (_b2 = data.managed_by) != null ? _b2 : "user";
    });
    new import_obsidian.Notice("Saved rule template to Singularity.");
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
    const [memories, aggregates] = await Promise.all([
      this.client().pull(),
      this.client().pullAggregates()
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
    new import_obsidian.Notice(`Exported ${written} Singularity items. Skipped ${skipped}; conflicts ${conflicts}.`);
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
  async writeManagedMarkdownSafely(path, item) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (item.syncDirection === "obsidian_to_singularity") return "skipped";
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian.TFile) {
      const raw = await this.app.vault.read(existing);
      const cache = this.app.metadataCache.getFileCache(existing);
      const localBody = extractMarkdownBody(raw, (_a = cache == null ? void 0 : cache.frontmatterPosition) == null ? void 0 : _a.end.offset);
      const localBodyHash = await sha256Hex(localBody);
      const frontmatter = (_b = cache == null ? void 0 : cache.frontmatter) != null ? _b : {};
      const localRevision = stringValue(frontmatter.singularity_revision);
      const remoteProperties = (_c = item.properties) != null ? _c : {};
      const localStatus = (_d = stringValue(frontmatter.singularity_status)) != null ? _d : "draft";
      const remoteStatus = (_e = stringValue(remoteProperties.singularity_status)) != null ? _e : "draft";
      const localKind = (_f = stringValue(frontmatter.singularity_kind)) != null ? _f : "semantic";
      const remoteKind = (_g = stringValue(remoteProperties.singularity_kind)) != null ? _g : "semantic";
      const frontmatterChanged = localStatus !== remoteStatus || localKind !== remoteKind || normalizedTagsKey(frontmatterTags(frontmatter)) !== normalizedTagsKey(remoteProperties.tags);
      const localChanged = localRevision === item.lastSyncedRevisionId && (Boolean(item.lastSyncedContentHash) || Boolean(item.lastSyncedSyncEtag)) && (localBodyHash !== item.lastSyncedContentHash || frontmatterChanged);
      const remoteChanged = Boolean(item.syncEtag) && item.syncEtag !== item.lastSyncedSyncEtag || item.revisionId !== item.lastSyncedRevisionId || item.contentHash !== item.lastSyncedContentHash || item.syncStatus === "remote_changed";
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
    new import_obsidian.Setting(containerEl).setName("Auth token").setDesc("Use an Obsidian-scoped Singularity token. Do not use the server owner AUTH_TOKEN.").addText((text) => {
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
