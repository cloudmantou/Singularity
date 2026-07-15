(function (global) {
  function asArray(value) {
    return Array.isArray(value) ? value.map((item) => ({ ...item })) : [];
  }

  function cloneAIReview(review) {
    if (!review || typeof review !== "object") return null;
    return {
      ...review,
      run: review.run ? {
        ...review.run,
        evidenceRefs: Array.isArray(review.run.evidenceRefs)
          ? review.run.evidenceRefs.map(String)
          : [],
        confidence: review.run.confidence ? { ...review.run.confidence } : null,
      } : null,
      application: review.application ? { ...review.application } : null,
    };
  }

  function normalizeReviewQueues(input) {
    const reviews = asArray(input && input.aiReviews && input.aiReviews.reviews);
    const latest = new Map();
    reviews.forEach((review) => {
      const key = `${review.objectType}:${review.objectId}`;
      if (!latest.has(key)) latest.set(key, cloneAIReview(review));
    });
    const attach = (items, objectType) => items.map((item) => ({
      ...item,
      aiReview: latest.get(`${objectType}:${item.id}`) || null,
    }));
    const conflicts = attach(
      asArray(input && input.conflicts && input.conflicts.conflicts),
      "conflict_case"
    );
    const entities = attach(
      asArray(input && input.entities && input.entities.candidates),
      "entity_merge_candidate"
    );
    const memories = attach(
      asArray(input && input.memories && input.memories.candidates),
      "memory_merge_candidate"
    );
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
      async loadAIReviews() {
        const payload = await request("/quality/ai-review?limit=100");
        return asArray(payload.reviews);
      },
      requestAIReview(objectType, objectId, mode) {
        return request("/quality/ai-review", {
          method: "POST",
          body: JSON.stringify({ objectType, objectId, mode: mode || "suggest" }),
        });
      },
      requestAIReviewBatch(objectType, mode, limit) {
        return request("/quality/ai-review/batch", {
          method: "POST",
          body: JSON.stringify({
            ...(objectType ? { objectType } : {}),
            mode: mode || "suggest",
            limit: limit || 5,
          }),
        });
      },
      applyAIReview(runId) {
        return request("/quality/ai-review/apply", {
          method: "POST",
          body: JSON.stringify({ runId }),
        });
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
    const block = el("div", "review-compare-block");
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

  function nextReviewTab(order, current, key) {
    if (!Array.isArray(order) || order.length === 0) return null;
    const index = order.indexOf(current);
    if (index < 0) return null;
    if (key === "Home") return order[0];
    if (key === "End") return order[order.length - 1];
    if (key === "ArrowRight" || key === "ArrowDown") {
      return order[(index + 1) % order.length];
    }
    if (key === "ArrowLeft" || key === "ArrowUp") {
      return order[(index - 1 + order.length) % order.length];
    }
    return null;
  }

  function appendAIReview(article, item, objectType, t) {
    article.dataset.reviewObjectType = objectType;
    const review = item.aiReview;
    const panel = el("section", "review-ai");
    panel.setAttribute("aria-label", t("review.ai.label"));
    const head = el("div", "review-ai-head");
    head.appendChild(el("span", "review-ai-label", t("review.ai.label")));
    const metadata = el("div", "review-ai-meta");
    const mode = review?.run?.mode || review?.mode;
    if (mode) {
      metadata.appendChild(el("span", "review-ai-mode", t(`review.ai.mode.${mode}`)));
    }
    if (review && review.status) {
      metadata.appendChild(el("span", `review-ai-state ${review.status}`, t(`review.ai.status.${review.status}`)));
    }
    if (metadata.childElementCount) head.appendChild(metadata);
    panel.appendChild(head);
    if (!review || review.status === "failed") {
      if (review && review.errorCode) panel.appendChild(el("p", "review-ai-error", review.errorCode));
      panel.appendChild(createAction(
        review ? t("review.ai.retry") : t("review.ai.start"),
        "ai:start",
        false
      ));
      article.appendChild(panel);
      return;
    }
    if (["queued", "processing", "applying"].includes(review.status)) {
      panel.appendChild(el("p", "review-ai-pending", t("review.ai.pending")));
      article.appendChild(panel);
      return;
    }
    const run = review.run;
    if (!run) {
      panel.appendChild(el("p", "review-ai-error", t("review.ai.unavailable")));
      article.appendChild(panel);
      return;
    }
    const decision = el("div", "review-ai-decision");
    decision.appendChild(el("strong", "", t(`review.ai.decision.${run.decision}`)));
    if (run.confidence && Number.isFinite(Number(run.confidence.decision))) {
      decision.appendChild(el("span", "review-score", `${Math.round(Number(run.confidence.decision) * 100)}%`));
    }
    panel.appendChild(decision);
    panel.appendChild(el("p", "review-ai-reason", run.reason));
    if (Array.isArray(run.evidenceRefs) && run.evidenceRefs.length) {
      panel.appendChild(el("div", "review-ai-refs", `${t("review.ai.evidence")}: ${run.evidenceRefs.join(", ")}`));
    }
    if (review.application || review.status === "applied") {
      panel.appendChild(el("div", "review-ai-applied", t("review.ai.applied")));
    } else if (run.mode !== "shadow" && !run.abstain && run.decision !== "uncertain") {
      const apply = createAction(t("review.ai.apply"), "ai:apply", true);
      apply.dataset.reviewRunId = run.id;
      panel.appendChild(apply);
    } else {
      panel.appendChild(el("div", "review-ai-shadow", run.mode === "shadow"
        ? t("review.ai.shadow")
        : t("review.ai.needsHuman")));
    }
    article.appendChild(panel);
  }

  function createKnowledgeReviewController(options) {
    const root = options.root;
    const api = options.api;
    const t = options.t || ((key) => key);
    let state = { active: "conflicts", busyId: null, queues: normalizeReviewQueues({}) };

    function currentMode() {
      const value = String(root.querySelector("[data-review-ai-mode]")?.value || "suggest");
      return ["shadow", "suggest", "auto_low_risk"].includes(value) ? value : "suggest";
    }

    function currentItems() {
      return state.queues[state.active] || [];
    }

    function renderTabs() {
      root.querySelectorAll("[data-review-tab]").forEach((button) => {
        const key = button.dataset.reviewTab;
        const selected = key === state.active;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
        const count = button.querySelector("[data-review-count]");
        if (count) count.textContent = String(state.queues.counts[key] || 0);
      });
      const panel = root.querySelector("[data-review-list]");
      if (panel) panel.setAttribute("aria-labelledby", `review-tab-${state.active}`);
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
      appendAIReview(article, item, "conflict_case", t);
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
      appendAIReview(article, item, "entity_merge_candidate", t);
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
      appendAIReview(article, item, "memory_merge_candidate", t);
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
        const [queues, aiReviews] = await Promise.all([
          api.loadQueues(),
          api.loadAIReviews(),
        ]);
        state = {
          ...state,
          queues: normalizeReviewQueues({
            conflicts: { conflicts: queues.conflicts },
            entities: { candidates: queues.entities },
            memories: { candidates: queues.memories },
            aiReviews: { reviews: aiReviews },
          }),
        };
        render();
        setStatus(t("review.ready", { n: state.queues.counts.total }), "ready");
      } catch (_) {
        setStatus(t("review.error"), "error");
      }
    }

    async function resolveAction(itemId, action, objectType, runId) {
      const [kind, decision] = String(action).split(":");
      state = { ...state, busyId: itemId };
      renderList();
      setStatus(t("review.saving"), "loading");
      try {
        if (kind === "ai" && decision === "start") {
          await api.requestAIReview(objectType, itemId, currentMode());
        } else if (kind === "ai" && decision === "apply") {
          await api.applyAIReview(runId);
        } else if (kind === "conflict") await api.resolveConflict(itemId, decision);
        else if (kind === "entity") await api.resolveEntity(itemId, decision);
        else if (kind === "memory") await api.resolveMemory(itemId, decision);
        else throw new Error("unsupported_review_action");
        await load();
        if (kind === "ai" && decision === "start") {
          scheduleAIRefresh();
        }
      } catch (_) {
        setStatus(t("review.saveError"), "error");
      } finally {
        state = { ...state, busyId: null };
        renderList();
      }
    }

    function scheduleAIRefresh(remaining) {
      const attempts = Number.isFinite(remaining) ? remaining : 5;
      if (attempts <= 0) return;
      const schedule = options.schedule || global.setTimeout;
      if (typeof schedule !== "function") return;
      schedule(async () => {
        await load();
        const pending = currentItems().some((item) =>
          ["queued", "processing", "applying"].includes(item.aiReview?.status)
        );
        if (pending) scheduleAIRefresh(attempts - 1);
      }, 1_200);
    }

    async function reviewBatch() {
      state = { ...state, busyId: "batch" };
      renderList();
      setStatus(t("review.ai.batchPending"), "loading");
      const objectTypes = {
        conflicts: "conflict_case",
        entities: "entity_merge_candidate",
        memories: "memory_merge_candidate",
      };
      try {
        await api.requestAIReviewBatch(objectTypes[state.active], currentMode(), 5);
        await load();
        scheduleAIRefresh();
      } catch (_) {
        setStatus(t("review.ai.batchError"), "error");
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
      const aiBatch = target.closest("[data-review-ai-batch]");
      if (aiBatch && !state.busyId) { reviewBatch(); return; }
      const action = target.closest("[data-review-action]");
      const item = action && action.closest("[data-review-id]");
      if (action && item && !state.busyId) {
        resolveAction(
          item.dataset.reviewId,
          action.dataset.reviewAction,
          item.dataset.reviewObjectType,
          action.dataset.reviewRunId
        );
      }
    });

    root.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const tab = target?.closest("[data-review-tab]");
      if (!tab) return;
      const order = Array.from(root.querySelectorAll("[data-review-tab]"))
        .map((button) => button.dataset.reviewTab)
        .filter(Boolean);
      const next = nextReviewTab(order, tab.dataset.reviewTab, event.key);
      if (!next) return;
      event.preventDefault();
      state = { ...state, active: next };
      render();
      root.querySelector(`[data-review-tab="${next}"]`)?.focus();
    });

    render();
    return { load, render };
  }

  const exported = {
    buildConflictDecision,
    createKnowledgeReviewApi,
    createKnowledgeReviewController,
    nextReviewTab,
    normalizeReviewQueues,
  };
  global.SingularityKnowledgeReview = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
