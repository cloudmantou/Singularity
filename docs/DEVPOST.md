# Devpost submission copy

Use this document as the source for the public Devpost **Project story** field. The final form also requires a public YouTube demo URL.

## Project story

## Inspiration

AI assistants are good at the current conversation and bad at the life of a project. Important decisions end up scattered across chats, coding sessions, notes, and tools. Saving every transcript creates another archive; it does not tell an agent which fact is current, which claim is contradicted, or which source actually supports an answer.

We built **Singularity** to make memory a shared, user-owned infrastructure layer for AI. The name comes from the point where scattered information collapses into a new structure: observations become evidence, evidence becomes memory, and memory becomes usable intelligence.

## What it does

Singularity is a self-hosted, evidence-first memory engine for ChatGPT, Codex, other MCP agents, a bilingual web app, and Obsidian.

- **Remember once, recall everywhere:** every connected client uses the same memory layer.
- **Preserve the evidence:** raw Observations remain linked to extracted atomic Claims.
- **Let memory evolve:** updates create versions, while conflicts and historical facts remain explicit.
- **Recall with more than vectors:** dense, keyword, lexical, entity, relation, and temporal signals are fused and reranked.
- **Answer with proof:** the model selects Claim references; the server validates answerability, conflicts, language, entailment, and citations before showing an answer.
- **Run it your way:** Cloudflare Workers/D1/Vectorize/KV or Node.js/Fastify/SQLite/sqlite-vec.
- **See when it degrades:** Observatory exposes health queues, vector state, traces, and model calls.

## How we built it

Capture is a versioned evidence pipeline:

```text
Observation → Atomic extraction → Parent version → Claim + provenance
            → Entity/temporal graph → Classification + vector queues
```

Recall keeps retrieval and factual support separate:

```text
Question → intent/time parsing → dense + lexical + graph retrieval
         → reciprocal-rank fusion → bounded reranking
         → active, answerable Claim ledger → LLM synthesis
         → server validation → answer + citations + why-recalled signals
```

For document \(d\), retrieval channels are combined with Reciprocal Rank Fusion:

$$
S_{\mathrm{RRF}}(d)=
\sum_{r\in R_{\mathrm{dense}}}\frac{1}{k+r(d)}+
\sum_{r\in R_{\mathrm{keyword}}}\frac{w_d}{k+r(d)}+
\sum_{r\in R_{\mathrm{lexical}}}\frac{1}{k+r(d)}
$$

One of the reranking signals is time decay:

$$
M_{\mathrm{time}}=e^{-\mathrm{age}/\mathrm{halfLife}}
$$

Tasks decay quickly; procedures remain durable. Frequency can compensate for age, but it is capped so an old note cannot dominate only because it was recalled often.

The control plane supports OpenAI chat and embedding presets through an OpenAI-compatible provider layer. It also isolates vendor capability differences instead of assuming every compatible endpoint behaves identically.

## How Codex and GPT-5.6 helped

Singularity existed before Build Week, so we documented the extension precisely. The last pre-submission-period baseline is commit `82e78ef`. From that baseline through `798da71`, the public repository records 12 commits across 45 files with 6,118 insertions and 384 deletions.

During Build Week, Codex and GPT-5.6 helped us:

1. map capture, mutation, vector, graph, recall, and self-host runtime boundaries;
2. write failing tests for stale vector generations, missing provenance, bad citations, unsupported prose, conflict leakage, and corrupted restore chains;
3. implement evidence/Claim consistency, mutation recovery, query answerability, cited natural-language recall, and strict answer validation;
4. review the changes adversarially for fail-open behavior, secret leakage, unsafe retries, and current-versus-historical confusion;
5. verify tests, coverage, typechecking, dependency audit, local runtime behavior, and live browser traces as separate proof layers.

Codex accelerated investigation and implementation. The human decisions shaped the product: preserve raw evidence, make associations navigation-only, fail closed on unsupported factual answers, and prefer an incremental architecture over a rewrite.

## Challenges

### Retrieval is not proof

A semantically related memory can still be the wrong answer. We introduced a Claim ledger, query-answerability ranking, conflict rules, server-rendered citations, and paragraph-level entailment checks.

### Current truth and history must coexist

An update should change the current answer without destroying the previous state. Parent-version activation and historical Claim recall keep those views separate.

### One mutation touches many projections

Appending one sentence can affect the entry, Observation, Claims, sources, vectors, versions, revisions, and audit chain. We added idempotent mutation phases, leases, recovery, and explicit vector-index health.

### Cloud and self-host runtimes must agree

Cloudflare provides D1, Vectorize, KV, and Workers AI. The self-host runtime maps the same contracts to SQLite, sqlite-vec, local KV, Fastify, and configurable OpenAI-compatible APIs.

### Privacy changes the demo strategy

A real memory system contains private work. The public demo and media use a synthetic database; credentials belong in private testing instructions, never in screenshots or the repository.

## What we learned

- Relevance and answerability are different metrics.
- A knowledge graph only matters when its facts reach the answer layer.
- Raw evidence, current versions, derived Claims, and navigation links need different contracts.
- Self-hosting gives users control of storage, but a configured hosted model may still process selected context.
- Observability is a product feature when extraction, indexing, and synthesis can degrade independently.
- AI-assisted engineering works best when Codex proposes and tests, while humans guard scope, evidence, privacy, and product boundaries.

## Accomplishments we are proud of

- One memory layer shared by MCP, OAuth-enabled clients, REST, web, and Obsidian.
- Evidence-linked atomic Claims with current and historical versions.
- Hybrid vector, lexical, graph, and temporal recall.
- Fail-closed answer validation with server-rendered citations.
- Cloudflare and self-hosted runtimes backed by the same behavior.
- Operational dashboards, repair queues, backup integrity, and audit-chain verification.
- An 80% coverage gate across unit, integration, UI-contract, and self-host MCP E2E suites.

## What's next

- Ship incremental Recall streaming while replacing the draft with the final Claim-validated answer.
- Publish a dedicated, resettable demo workspace for judges.
- Add an interactive graph explorer to the existing entity and temporal-fact backend.
- Expand evaluation datasets for answerability, conflicts, history, and cross-client consistency.

## Try it

- Demo: [agent.mtzs.cloud](https://agent.mtzs.cloud)
- Source: [github.com/cloudmantou/Singularity](https://github.com/cloudmantou/Singularity)

## Tags

`TypeScript`, `Node.js`, `Cloudflare Workers`, `Cloudflare D1`, `Cloudflare Vectorize`, `Cloudflare Workers AI`, `Model Context Protocol`, `OpenAI API`, `Fastify`, `SQLite`, `sqlite-vec`, `better-sqlite3`, `Zod`, `OAuth 2.0`, `PKCE`, `Docker`, `Vitest`, `Obsidian`, `REST API`, `Vector Search`, `Hybrid Search`, `Knowledge Graph`, `AI Agents`, `Self Hosted`, `Open Source`

## Remaining private submission fields

- Public YouTube demo URL (required, under three minutes, with audio)
- Demo Bearer token or test account for judges
- Codex `/feedback` Session ID for the thread where the majority of core functionality was built
