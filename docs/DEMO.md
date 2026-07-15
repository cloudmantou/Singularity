# Singularity demo plan

This is a privacy-safe script for the required public Devpost video. Target **90–120 seconds**; the official limit is three minutes. Record in English, with audio, and upload publicly to YouTube.

## Before recording

- Use a separate demo database. Do not record the owner's real memory corpus, traces, filesystem paths, API keys, tokens, or client identifiers.
- Never share the owner instance's long-lived token. Judge access must use a dedicated, revocable credential for an isolated synthetic deployment.
- Configure OpenAI in **Settings → Models & API** if the submission will say the running demo uses OpenAI.
- Prepare one synthetic project, `Aurora Launch`, with a decision, deadline, owner, and changed plan.
- Keep the browser at 100% zoom and close notification overlays.
- Put repository and architecture links in the video description.

## Synthetic demo fixture

First memory:

```text
Aurora Launch is a small accessibility app. On July 14 we decided to ship the keyboard-navigation audit before the color-theme work. Mina owns the audit, the target is July 18, and the next step is to test the checkout flow. #aurora #decision #task
```

Update:

```text
The checkout keyboard audit passed. The next task is now the settings screen, and the target moved from July 18 to July 19 because the team added a screen-reader test.
```

Recall questions:

```text
What did we decide to do first for Aurora Launch, and why?
What changed in the Aurora Launch plan?
```

## Shot list and voiceover

### 0:00–0:10 — The problem

**Visual:** Hero image, then the web app.

**Voiceover:**

> AI assistants are useful inside one chat, but projects evolve across many chats and tools. Singularity is a self-hosted memory engine that turns raw updates into versioned, evidence-linked Claims.

### 0:10–0:30 — Remember once

**Visual:** Paste the first synthetic fixture into **Remember** and save it.

**Voiceover:**

> I can save one project update from the web, ChatGPT, Codex, any MCP client, or Obsidian. Singularity preserves the Observation, extracts atomic facts, attaches entities and time, and keeps the source link.

### 0:30–0:52 — Recall with proof

**Visual:** Ask the first recall question. Expand citations and “Why recalled.”

**Voiceover:**

> Recall fuses vectors, keywords, entities, relations, and time. The model can only select from a server-built Claim ledger. The server validates every paragraph and renders the citations, so related text is not automatically treated as proof.

### 0:52–1:10 — Memory evolves

**Visual:** Append the update, then ask what changed.

**Voiceover:**

> When a plan changes, Singularity activates a new version instead of overwriting history. Current questions get current Claims; historical questions can still use the earlier version.

### 1:10–1:28 — Make the pipeline observable

**Visual:** Open Observatory and show only the synthetic workspace: Observations, atomic memories, entities, active facts, health queues, and one trace.

**Voiceover:**

> The Observatory makes asynchronous extraction, classification, vector indexing, and model calls visible. A successful HTTP response is not enough if a memory layer is degraded.

### 1:28–1:45 — Codex and Build Week

**Visual:** Show the GitHub Build Week section and commit comparison.

**Voiceover:**

> During Build Week, Codex and GPT-5.6 helped map the architecture, write failing regression tests, implement consistency and answer-validation fixes, and run adversarial reviews. I kept the product decisions: preserve raw evidence, fail closed on unsupported answers, and keep private data in user-controlled infrastructure.

### 1:45–1:55 — Close

**Visual:** Architecture diagram, then GitHub URL.

**Voiceover:**

> Remember once. Let every agent recall it. Keep the evidence.

## Required final checks

- Video is public on YouTube.
- Runtime shown in the video behaves exactly as described.
- Audio explicitly covers what was built and how Codex and GPT-5.6 were used.
- Video contains no private memory, secrets, third-party music, or unlicensed assets.
- Duration is under three minutes.
- Devpost has the public YouTube URL, repository URL, demo URL, private testing credentials, and the required `/feedback` Codex Session ID.
