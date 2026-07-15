(function (global) {
  function asArray(value) {
    return Array.isArray(value) ? value.map((item) => ({ ...item })) : [];
  }

  function normalizeReviewQueues(input) {
    const conflicts = asArray(input && input.conflicts && input.conflicts.conflicts);
    const entities = asArray(input && input.entities && input.entities.candidates);
    const memories = asArray(input && input.memories && input.memories.candidates);
    return {
      conflicts,
      entities,
      memories,
      counts: {
        conflicts: conflicts.length,
        entities: entities.length,
        memories: memories.length,
        total: conflicts.length + entities.length + memories.length,
      },
    };
  }

  function buildConflictDecision(decision) {
    if (["use_new", "use_old", "keep_both"].includes(decision)) {
      return { state: "resolved", resolution: decision };
    }
    if (decision === "dismissed") {
      return { state: "dismissed", resolution: "dismissed" };
    }
    throw new Error("unsupported_conflict_decision");
  }

  function joinUrl(baseUrl, path) {
    return `${String(baseUrl || "").replace(/\/$/, "")}${path}`;
  }

  async function parseReviewResponse(response) {
    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      throw new Error(`review_request_failed (HTTP ${response.status})`);
    }
    if (!response.ok || !payload || payload.ok !== true) {
      const code = payload && typeof payload.error === "string"
        ? payload.error
        : "review_request_failed";
      throw new Error(`${code} (HTTP ${response.status})`);
    }
    return payload;
  }

  function createKnowledgeReviewApi(options) {
    const fetchImpl = options.fetchImpl || global.fetch.bind(global);
    async function request(path, init) {
      const token = String(options.getToken() || "").trim();
      const response = await fetchImpl(joinUrl(options.getBaseUrl(), path), {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init && init.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...((init && init.headers) || {}),
        },
      });
      return parseReviewResponse(response);
    }

    return {
      async loadQueues() {
        const [conflicts, entities, memories] = await Promise.all([
          request("/quality/conflict-cases?state=pending&limit=100"),
          request("/quality/entity-merge-candidates?state=pending&limit=100"),
          request("/quality/merge-candidates?state=pending&limit=100"),
        ]);
        return normalizeReviewQueues({ conflicts, entities, memories });
      },
      resolveConflict(id, decision) {
        return request("/quality/conflict-cases/resolve", {
          method: "POST",
          body: JSON.stringify({ id, ...buildConflictDecision(decision) }),
        });
      },
      resolveEntity(id, decision) {
        return request("/quality/entity-merge-candidates/resolve", {
          method: "POST",
          body: JSON.stringify({ id, decision }),
        });
      },
      resolveMemory(id, state) {
        if (!["accepted", "rejected"].includes(state)) {
          return Promise.reject(new Error("unsupported_memory_review_decision"));
        }
        return request("/quality/merge-candidates/resolve", {
          method: "POST",
          body: JSON.stringify({ id, state }),
        });
      },
    };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function appendTextBlock(parent, label, content) {
    const block = el("section", "review-compare-block");
    block.appendChild(el("div", "review-compare-label", label));
    block.appendChild(el("p", "review-compare-content", content || "—"));
    parent.appendChild(block);
  }

  function createAction(label, action, emphasis) {
    const button = el("button", `review-action${emphasis ? " primary" : ""}`, label);
    button.type = "button";
    button.dataset.reviewAction = action;
    return button;
  }

  function createKnowledgeReviewController(options) {
    const root = options.root;
    const api = options.api;
    const t = options.t || ((key) => key);
    let state = { active: "conflicts", busyId: null, queues: normalizeReviewQueues({}) };

    function currentItems() {
      return state.queues[state.active] || [];
    }

    function renderTabs() {
      root.querySelectorAll("[data-review-tab]").forEach((button) => {
        const key = button.dataset.reviewTab;
        button.classList.toggle("active", key === state.active);
        const count = button.querySelector("[data-review-count]");
        if (count) count.textContent = String(state.queues.counts[key] || 0);
      });
      const total = root.querySelector("[data-review-total]");
      if (total) total.textContent = String(state.queues.counts.total);
    }

    function conflictCard(item) {
      const article = el("article", "review-item");
      article.dataset.reviewId = item.id;
      const head = el("header", "review-item-head");
      head.appendChild(el("span", "review-kind danger", item.conflictType || t("review.conflict")));
      if (item.confidence != null) {
        head.appendChild(el("span", "review-score", `${Math.round(Number(item.confidence) * 100)}%`));
      }
      article.appendChild(head);
      if (item.reason) article.appendChild(el("p", "review-reason", item.reason));
      const compare = el("div", "review-compare");
      appendTextBlock(compare, t("review.existing"), item.oldClaim?.content || item.oldMemory?.content);
      appendTextBlock(compare, t("review.incoming"), item.newClaim?.content || item.newMemory?.content);
      article.appendChild(compare);
      const actions = el("div", "review-actions");
      actions.append(
        createAction(t("review.useNew"), "conflict:use_new", true),
        createAction(t("review.keepOld"), "conflict:use_old"),
        createAction(t("review.keepBoth"), "conflict:keep_both"),
        createAction(t("review.dismiss"), "conflict:dismissed")
      );
      article.appendChild(actions);
      return article;
    }

    function entityCard(item) {
      const article = el("article", "review-item");
      article.dataset.reviewId = item.id;
      const head = el("header", "review-item-head");
      head.appendChild(el("span", "review-kind", item.matchedBy || t("review.entity")));
      if (item.score != null) head.appendChild(el("span", "review-score", `${Math.round(Number(item.score) * 100)}%`));
      article.appendChild(head);
      const compare = el("div", "review-compare");
      appendTextBlock(compare, t("review.sourceEntity"), item.source?.name);
      appendTextBlock(compare, t("review.targetEntity"), item.target?.name);
      article.appendChild(compare);
      const actions = el("div", "review-actions");
      actions.append(
        createAction(t("review.merge"), "entity:accept", true),
        createAction(t("review.reject"), "entity:reject")
      );
      article.appendChild(actions);
      return article;
    }

    function memoryCard(item) {
      const article = el("article", "review-item");
      article.dataset.reviewId = item.id;
      const head = el("header", "review-item-head");
      head.appendChild(el("span", "review-kind", item.suggestedAction || t("review.similar")));
      if (item.similarity != null) head.appendChild(el("span", "review-score", `${Math.round(Number(item.similarity) * 100)}%`));
      article.appendChild(head);
      if (item.reason) article.appendChild(el("p", "review-reason", item.reason));
      const compare = el("div", "review-compare");
      appendTextBlock(compare, t("review.sourceMemory"), item.source?.content);
      appendTextBlock(compare, t("review.targetMemory"), item.target?.content);
      article.appendChild(compare);
      const actions = el("div", "review-actions");
      actions.append(
        createAction(t("review.accept"), "memory:accepted", true),
        createAction(t("review.keepSeparate"), "memory:rejected")
      );
      article.appendChild(actions);
      return article;
    }

    function renderList() {
      const list = root.querySelector("[data-review-list]");
      if (!list) return;
      list.replaceChildren();
      const items = currentItems();
      if (!items.length) {
        list.appendChild(el("div", "review-empty", t("review.empty")));
        return;
      }
      const factory = state.active === "conflicts"
        ? conflictCard
        : state.active === "entities" ? entityCard : memoryCard;
      items.forEach((item) => list.appendChild(factory(item)));
      if (state.busyId) {
        list.querySelectorAll("button").forEach((button) => { button.disabled = true; });
      }
    }

    function setStatus(message, kind) {
      const target = root.querySelector("[data-review-status]");
      if (!target) return;
      target.textContent = message;
      target.dataset.kind = kind || "";
    }

    function render() {
      renderTabs();
      renderList();
    }

    async function load() {
      setStatus(t("review.loading"), "loading");
      try {
        state = { ...state, queues: await api.loadQueues() };
        render();
        setStatus(t("review.ready", { n: state.queues.counts.total }), "ready");
      } catch (_) {
        setStatus(t("review.error"), "error");
      }
    }

    async function resolveAction(itemId, action) {
      const [kind, decision] = String(action).split(":");
      state = { ...state, busyId: itemId };
      renderList();
      setStatus(t("review.saving"), "loading");
      try {
        if (kind === "conflict") await api.resolveConflict(itemId, decision);
        else if (kind === "entity") await api.resolveEntity(itemId, decision);
        else if (kind === "memory") await api.resolveMemory(itemId, decision);
        else throw new Error("unsupported_review_action");
        await load();
      } catch (_) {
        setStatus(t("review.saveError"), "error");
      } finally {
        state = { ...state, busyId: null };
        renderList();
      }
    }

    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element
        ? event.target
        : event.target && event.target.parentElement;
      if (!target) return;
      const tab = target.closest("[data-review-tab]");
      if (tab) {
        state = { ...state, active: tab.dataset.reviewTab };
        render();
        return;
      }
      const refresh = target.closest("[data-review-refresh]");
      if (refresh) { load(); return; }
      const action = target.closest("[data-review-action]");
      const item = action && action.closest("[data-review-id]");
      if (action && item && !state.busyId) resolveAction(item.dataset.reviewId, action.dataset.reviewAction);
    });

    render();
    return { load, render };
  }

  const exported = {
    buildConflictDecision,
    createKnowledgeReviewApi,
    createKnowledgeReviewController,
    normalizeReviewQueues,
  };
  global.SingularityKnowledgeReview = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
