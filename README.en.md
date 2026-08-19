# dsh-knowledge-graph

**[English](README.en.md) | [中文](README.md)**

**DSH (DeepSeek Harness) Cordis plugin**: turn any piece of source text — or an AI session execution trace — into an **AI-generated knowledge graph**, with **two-way linking between the graph and the original text**.

> Paste text → AI asynchronously builds the graph → two-way anchor navigation. A standalone, reusable plugin realization of NovelStudio's "资料 ⇄ 知识图" (Source ⇄ Knowledge Graph).

---

## What it does

- **Asynchronous AI extraction**: paste any text (chapters, technical docs, study notes…); a background task calls the LLM and returns a knowledge graph in ~15–40 s. `documentId` is a random stable logical-document UUID, `sourceId` is a SHA-256 identity of the complete immutable source version, and each `chunkId` binds sourceId + batch + paragraph range, so different documents and appended source versions cannot overwrite one another through local `chunk-0001` reuse. In persistent mode the full source, canonical graph, and lossless checkpoint live in SQLite; the browser restores by `documentId/runId`, and only a `running` task orphaned by a Host restart may resume from checkpoint. Explicit `failed/cancelled` tasks are never auto-retried.
- **7 node types / 6 relation types**:
  - Nodes: `fact` · `inference` · `concept` · `definition` · `example` · `counter_example` · `rule`.
  - Relations: `supports` · `example` · `counter_example` · `defines` · `infers` · `causes`.
- **Two-way linking**:
  - Click a **graph node** → opens a **detail card** (full content + verbatim quote + locate button) and smoothly scrolls to and highlights the matching content unit;
  - Click a **source content unit** → the graph centers on and pulses the corresponding node.
  - Nodes in the graph render only the first 4 lines (overflow collapses to `…`); the **full content is always available in the detail card**;
  - Anchoring primarily uses the **content-unit index** the AI reports directly (deterministic — long natural paragraphs are split into numbered units at sentence boundaries), with exact-quote matching and token-overlap scoring as fallbacks; nodes that cannot be linked are never guessed into an offset — they go to a diagnostics list.
- **Graph rendering**: SVG canvas + 7-color node palette / **4 switchable layouts** (dropdown at the graph's top right, choice remembered): **Force** (embedded d3-force engine, zero dependencies: collision avoids node overlap, edge–node repulsion keeps arrows from crossing nodes), **Circular**, **Radial** (central hub + BFS rings; edges drawn as **polylines**: radial exit → outer arc → radial entry), **Layered** (edges drawn as **orthogonal right-angle polylines**: inter-row channels + per-row obstacle corridors; segments never cross nodes) / relation edges carry type labels, and **edges sharing a source fan out by target angle** (quadratic Bézier) / drag to pan / Ctrl+wheel to zoom / toolbar `− 100% +` (50%–200%, 10% steps) / long-press a node to see the verbatim quote / keyboard accessible.
- **Verify & question the graph**: once a graph exists, check whether it is faithful to the source text —
  - **⚡ Quick check**: instant local rules (self-loops/dangling edges, quote grounding, paragraph-vs-quote mismatch, type–relation semantic rules, duplicate / suspected-contradiction nodes, isolated nodes, coverage stats);
  - **🤖 AI deep audit**: an asynchronous LLM pass adversarially reviews each node/edge; every issue must cite verbatim source evidence, and the standard mode runs a second confirmation pass to suppress false positives;
  - **Human-in-the-loop fix**: issues are listed by severity (error / warning / suggestion); clicking an issue tints the graph target by severity and scrolls to the source paragraph; each issue can be **applied** (patched immediately, written to an audit log) or **dismissed**; a **fix all** button applies every automatically fixable issue at once, and the fix log shows concrete **old → new** diffs;
  - **Ask questions**: the node detail card offers **question this node**, selecting an edge shows an edge card with **question this relation**, and the verification panel lets you question the whole graph; the AI answers with one of **supported / contradicted / insufficient / out-of-scope** plus source evidence;
  - **🔎 External fact-check of the source**: fact/inference/rule/definition/counter-example nodes become checkable claims and are judged against external evidence (built-in free Wikipedia retrieval plus optional **pasted domain-rule sources**); verdicts are **supported / contradicted / partially supported / insufficient / unverifiable / out-of-scope**, every conclusion carries an evidence link and a verbatim evidence quote (quotes that cannot be located in the retrieved snippets are automatically downgraded);
  - Verification / fact-check results are persisted with the graph; **appending new content marks them stale** for re-running. The trajectory graph tab supports all of the same capabilities.
- **Floating workbench**: draggable, resizable window; the **width ratio** between text and graph and the **result area height** are both drag-adjustable and remembered.
- **Select-to-split**: select any text **inside a chat message**; a "拆成知识图" (split into graph) button floats above the selection — one click opens the workbench and splits the selection; selecting text in the result's source column splits it as a sub-graph; selecting part of the input textarea also offers "split selection".
- **Incremental append (追加拆分)**: once a result exists, the input panel's primary button becomes **追加拆分 (append split)** — paste the next passage / document and the AI extracts ONLY the new content, linking it into the existing graph via **cross-passage edges** (a concept that reappears is not duplicated — it gets an edge straight to the existing node); the result merges in place, paragraph numbering stays unified across the whole text, and the history entry updates in place. Selecting text in a chat message while a result exists appends it to the current graph automatically.
- **History**: every successful split records a lightweight browser index (up to 20 entries, deletable one-by-one or all); the browser keeps only `documentId`, title, counts, and timestamps, then reloads the source and canonical graph from Host/SQLite instead of copying book-sized payloads into `localStorage`.
- **Chapter filtering and candidate review**: filter the graph and source paragraphs by chapter; review evidence-bearing entity / claim candidates as **candidate / accepted / rejected** and click a candidate to jump back to its source. Decisions sync through the Host to SQLite (dynamic plugins retain them in the Host session, with browser localStorage as fallback).
- **Knowledge graph export**: the graph toolbar exports the current rendered graph as a high-resolution PNG image, and the result toolbar exports the complete graph as JSON (including source, chunk, evidence, verification, and audit data) or as separate node and edge CSV files. Data exports always contain the full graph, independent of the active chapter filter; trajectory graphs support the same exports.
- **Persistent entry**: a permanent 「知识图」button on the right of each conversation header; run cards also get a launch bar.
- **Trajectory knowledge graph (conversation view tab)**: a third tab 「轨迹知识图」(beside 对话 / 轨迹) turns the **current session's full execution trace** (user messages, tool calls, tool results, assistant replies) into a knowledge graph — visualizing what the agent **found, inferred, and did** — with two-way linking between graph and trace events. Results are canonical Host/SQLite documents; the browser stores only the trajectory `documentId/revision` reference, so tab switches or page reloads rehydrate from canonical state rather than from a copied graph. Leaving mid-extraction and returning resumes polling automatically. Once the session produces new events, **追加新事件 (append new events)** submits the same document id plus the expected revision, reloads the complete canonical graph Host-side, and merges only the new events; hidden nodes beyond the 800-node browser window therefore cannot be lost. The event-column / graph-column width and result height remain drag-adjustable and remembered.

## Screenshots

Floating workbench:

<img width="1538" height="945" alt="image" src="https://github.com/user-attachments/assets/824ab99b-d291-4d06-8eb7-b91e947b1af4" />

```
┌────────────────────────── Floating Workbench ──────────────────────────┐
│ ● Knowledge · Source ⇄ Knowledge Graph                     [ × ]        │
│ [Source text ────────────── collapse ▴]                                 │
│ [Source ⇄ Knowledge Graph]                                              │
│ One-line summary: …                                                     │
│ N nodes · M relations · X/Y linkable ─────────────────────┐             │
│ [paragraphs…badges]  ‖  [graph SVG…]  [− 100% +]  ← drag  │             │
│ ─────────────── drag height ───────────────               │             │
└────────────────────────────────────────────────────────────────────────┘
```

Trajectory knowledge graph tab:

<img width="3377" height="1720" alt="image" src="https://github.com/user-attachments/assets/5dfef153-25a0-431e-970c-dc344eef53d5" />

```
┌────────────────────── Trajectory ⇄ Knowledge Graph ─────────────────────┐
│ Split this session's trace: user / tool call / tool result / AI reply   │
│ One-line summary: …                                                     │
│ [trace events…badges]  ‖  [graph SVG…]  [− 100% +]  ← drag width        │
│ ────────────── drag height ──────────────                               │
│ (result restored after tab switch / page reload)                        │
└─────────────────────────────────────────────────────────────────────────┘
```

## Installation

This is a **DSH dynamic Cordis plugin**: one Host half (Node process) + one Client half (browser), plain JS, zero dependencies, no build step. It loads through DSH Web's Cordis plugin mechanism and works in any DSH Web session.

### 0. Prerequisites

- **DSH Web** is running (`dsh web`) and you are inside a session;
- An **AI model provider** is configured (Settings → Models, or `agentDefaultModel`). The plugin follows the system default by default; both the workbench and the “Trajectory Knowledge Graph” tab include a model dropdown so you can manually choose the model used for extraction, appends, AI audit, questioning, and external fact-checking (the choice is saved in browser local storage). If none is configured, it shows a clear Chinese error message.

### 1. Get the source

```bash
git clone https://github.com/cwbcheng/dsh-knowledge-graph.git
cd dsh-knowledge-graph
```

| File | Purpose |
| --- | --- |
| [`src/index.host.js`](src/index.host.js) | Host half: async AI extraction engine (paragraph numbering, batching, schema validation, typed diagnostics, model routing, session-trace serialization) + graph verification/questioning engine (local checks, LLM audit, confirmation pass) |
| [`src/index.client.js`](src/index.client.js) | Client half: floating workbench UI, graph rendering, two-way linking, verification & questioning panel, fix application/audit, history, width/height resizing, trajectory graph tab |
| [`src/kg-store.mjs`](src/kg-store.mjs) | SQLite persistence: documents, chunks, nodes, edges, evidence, entity/claim candidates, and extraction checkpoints |

### 2. Install (pick one)

**Option A: let an Agent install it (recommended)**

Send this to the Agent in any session (replace the path with your clone location):

> Please read `src/index.host.js` and `src/index.client.js` from the `dsh-knowledge-graph` repo, define these two files as the Host half and Client half of a Cordis plugin, and run it.

The Agent runs `cordis_define` (define) → `cordis_run` (run); an **approval card** pops up in the UI.

**Option B: paste the source and define it yourself**

1. Run a `cordis_define` in any session (have the Agent do it, or follow your environment's Cordis tool flow);
2. Paste `src/index.host.js` into the **Host half** and `src/index.client.js` into the **Client half**;
3. Paste the **function body**: strip the `export default function hostPlugin() {` / `export default function clientPlugin() {` line and the matching trailing `}`, keep the `return { ... };` part in between (the header comment may be kept or dropped).

> Not familiar with `cordis_define`? Use Option A — the Agent handles the function-body extraction automatically.

**Option C: persistent install (recommended — survives restarts)**

Install the repo as a web-profile composition plugin (same community-plugin package shape as `dsh-hud`): the Host half serves a `webServer` route, the Client half is a `__ModuleLoader__` browser module; it auto-loads with `dsh web` — **no redefinition after every restart, no approval**.

```bash
# 1. Add the dependency and bundle to the profile ($DSH_HOME defaults to ~/.dsh)
cd ~/.dsh/profiles/web
#    add to package.json dependencies:
#    "dsh-knowledge-graph": "github:cwbcheng/dsh-knowledge-graph#main"
#    add to package.json dsh.profile.bundles:
#    "dsh-knowledge-graph"
pnpm install

# 2. Restart dsh web (Ctrl+C, then `dsh web` again)
```

After the restart: the 「知识图」button appears at the right of each conversation header. Browser `localStorage` keeps only lightweight UI state such as layout and history indexes; source text, graph, checkpoints, and revisions are persisted by Host/SQLite.

| File | Purpose (persistent package) |
| --- | --- |
| [`lib/index.js`](lib/index.js) | Host half: task engine + `/api/dsh-knowledge-graph` routes for extraction/append, task status, `document-load`/`document-export`, revisioned `graph-commit`, safe `resume-extract`, verification/questioning, plus automatic SQLite canonical-graph/checkpoint persistence |
| [`lib/client.js`](lib/client.js) | Client half: `__ModuleLoader__` browser module (fetch RPC + manual style injection) |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle patch: inserts the `dsh-knowledge-graph` row into the composition |

> `src/` and `lib/` are two deployment shapes of the same plugin: `src/` for the dynamic plugin (Options A/B), `lib/` for the persistent composition (Option C); the logic stays in sync.

### 3. Approve the run

After defining, the run enters **awaiting approval**:

- The plugin panel (bottom-left **Cordis Plugin** button) pops up automatically and highlights the row awaiting approval;
- Click **✓ (single check)**: authorize this run only; click **✓✓ (double check)**: also authorize automatic runs of future versions (recommended);
- After approval the plugin activates in the browser and the panel shows **running**.

### 4. Verify the install

- The 「知识图」button appears at the **right of the conversation title** (header action row);
- Click it → the **floating workbench** opens; paste a text → **AI 拆分**; a knowledge graph appears in ~15–40 s;
- A third tab 「轨迹知识图」appears at the top of the conversation area (对话 / 轨迹 / 轨迹知识图); click it → **拆解本会话轨迹**; the session's trajectory graph appears in ~15–40 s.

### 5. SQLite persistence and CLI

The CLI uses Node `node:sqlite` and currently requires Node 22.5+; it has no extra npm dependency. It persists a `KnowledgeGraphDto`, then exposes evidence-bearing entity and claim candidates for human review.

```bash
npm run kg -- init --db ./data/knowledge.sqlite
npm run kg -- import-graph --db ./data/knowledge.sqlite --input ./graph.json
npm run kg -- list-candidates --db ./data/knowledge.sqlite --kind entity --status candidate
npm run kg -- list-candidates --db ./data/knowledge.sqlite --kind claim --status candidate
npm run kg -- set-candidate --db ./data/knowledge.sqlite --kind entity --id ent_xxx --status accepted
npm run kg -- set-candidate --db ./data/knowledge.sqlite --kind claim --id clm_xxx --status rejected
npm run kg -- list-documents --db ./data/knowledge.sqlite
npm run kg -- show-document --db ./data/knowledge.sqlite --id document_xxx
npm run kg -- save-checkpoint --db ./data/knowledge.sqlite --input checkpoint.json --run-id run_xxx
npm run kg -- load-checkpoint --db ./data/knowledge.sqlite --run-id run_xxx
```

The persistent `lib/index.js` writes each successful chunk and completed graph to SQLite automatically. Set `DSH_KG_DB` to choose the database path; otherwise it uses `.dsh-knowledge-graph.sqlite` in the current working directory. `npm run test:kg` verifies graph/chunk/evidence persistence, candidate state changes, checkpoint storage, and document restoration in an in-memory SQLite database; `npm run test:kg-candidates` additionally covers dynamic Host RPC and persistent HTTP/SQLite candidate list/update flows. The persistent build also copies [`lib/kg-store.mjs`](lib/kg-store.mjs).

## Updating

- **Dynamic install (A/B)**: repeat Option A after repo updates — have the Agent re-read both source files and `cordis_define` (append a new Package under the same plugin), then `cordis_run` (update mode) to switch versions; if you previously clicked the double check, new versions run automatically.
- **Persistent install (C)**: after updates, re-run `pnpm install` (pulls latest `#main`) and restart `dsh web`.

## Uninstalling

- **Dynamic install**: open the **Cordis Plugin** panel → click **Stop** on the plugin row to pause; use `cordis_undefine` to delete the definition entirely.
- **Persistent install**: remove the dependency and bundles entries from the profile's `package.json`, then `pnpm install` and restart.

Window layout, history indexes, and other lightweight UI state live in browser `localStorage`; book-sized sources, canonical graphs, checkpoints, and graph revisions live in Host/SQLite in persistent mode. Keep the SQLite database or export JSON/CSV before uninstalling if you need long-term retention.

## Notes

- A dynamic plugin runs **inside the DSH process**: it disappears after a process restart and must be reinstalled (Option A, or switch to persistent Option C; browser data remains); the persistent plugin loads with the service and is unaffected by restarts;
- The Host half needs a working LLM (see prerequisites); AI calls happen only inside your own DSH environment — whether they leave it depends on the model provider you configured;
- This project has **no paid / quota features**: extraction, history, and two-way linking all run locally.

## Usage

1. Click the 「知识图」button at the right of the conversation title to open the floating workbench;
2. Paste text into 「输入资料」(title optional), click **AI 拆分** (the input area collapses; result height and text/graph width ratio are drag-adjustable and remembered);
3. Once the summary / graph appears, **click a graph node to view the detail card (full content) and locate the source**, or **click a source paragraph to focus its node**;
4. Click **⚡ 快速体检 (quick check)** for an instant deterministic report, or **🤖 AI 深度审校 (deep audit)** for an evidence-grounded adversarial LLM review; click an issue to tint its graph target and locate its source paragraph, then **apply the fix** or **dismiss**; question a node from its detail card, an edge from its selected-edge card, or the whole graph from the verification panel;
5. In **章节与候选审核 (chapter and candidate review)**, choose a chapter to filter the graph/source view, then mark candidates accepted or rejected; click a candidate card to locate its evidence in the source;
6. To extend the graph, paste the next passage into the input area and click **追加拆分 (append split)** (or just select text in a chat message — it appends automatically): new nodes link to existing ones via cross-passage edges, paragraph numbering stays unified, and the history entry updates in place; the previous verification report is marked stale and can be re-run;
7. Use 「历史」to revisit previous splits (last 20 saved automatically, deletable one-by-one or all); if you close or refresh mid-task, reopening the window resumes polling automatically;
8. Switch to the 「轨迹知识图」tab and click **拆解本会话轨迹** to generate the session's trajectory graph; click a trace event to focus its node in the graph, click a node to see full content and scroll to its event; results restore after tab switches / reloads; drag the middle handle for column width and the bottom handle for result height.

## Chrome extension (划线拆图)

Select text on **any web page**, click the floating 「拆成知识图」button, and the local DSH service turns it into an AI knowledge graph right in a popup (split, view the graph, and jump back to the source text without leaving the page).

- The extension source lives in `extension/`; it is dependency-free: `viewer.js` is sliced from `src/index.client.js` by `scripts/build-viewer.mjs`, and `d3/*.js` are the embedded d3 modules as standalone files (MV3 extension pages forbid eval, so the popup preloads them with `<script src>` and the viewer's d3 loader takes the global fast path). After editing the source, run `node scripts/build-viewer.mjs` to regenerate.
- **Install (either)**:
  1. **Drag a single file (recommended)**: open `chrome://extensions` → enable **Developer mode** (top right) → **drag `dist/dsh-knowledge-graph.crx` onto the page** → click **Add extension**. The first time Chrome warns "Chromium cannot verify the source of this extension" — expected for any extension not from the Web Store; it works normally.
  2. **Load unpacked**: **Load unpacked** → select the repo's `extension/` folder.
  - Note: branded Chrome 137+ **no longer supports `--load-extension` on the command line** (Chrome for Testing / unbranded Chromium still do).
- **Repacking** (after source updates, to keep distributing as crx): the extension private key must **stay outside the repository**. Store it outside the checkout (the recommended default is `~/.config/dsh-knowledge-graph/extension-signing.pem`, mode `0600`) and pass it to the pack script:
  ```bash
  npm ci --prefix scripts/signing --ignore-scripts
  export DSH_KG_EXTENSION_KEY="$HOME/.config/dsh-knowledge-graph/extension-signing.pem"
  npm run pack:extension
  ```
  The first run creates a new private key; the extension ID is derived from it, so rotating the key changes the ID and invalidates existing installs. Never copy the key into `dist/` or commit it. The script writes the replacement CRX to `dist/dsh-knowledge-graph.crx`.
- **Dependency**: `dsh web` must be running locally with a plugin version that serves the `/dsh-kg` extension endpoint (for persistent installs, update the plugin and restart dsh web first). By default the endpoint accepts only this project's new CRX origin, `chrome-extension://kffpcpfkpmfkicdnlckdphiplnhlbkof`; if you use **Load unpacked** and get a different extension ID, set `DSH_KG_EXTENSION_ORIGINS=chrome-extension://your-extension-id` before starting dsh web. `DSH_KG_ALLOW_LOCAL_ORIGIN=1` is required to additionally allow localhost/127.0.0.1 origins; empty Origin and other extension IDs are rejected. The endpoint answers with the PNA preflight header.
- **Data flow**: content script (any page) → `chrome.runtime.sendMessage` → service worker writes `chrome.storage.session` and calls `chrome.action.openPopup()` (Chrome 127+); the popup reads the selected text and POSTs to `http://127.0.0.1:3080/dsh-kg/extract`, then polls `task-status` to render the graph. The DSH base URL is editable at the bottom of the popup and remembered (`kgBase` in `chrome.storage.local`).

## Architecture

```
┌─────────────── Host (Node process) ───────────────┐   ┌────────── Client (browser) ──────────┐
│ extract / append-extract / task-status /           │   │                                     │
│   trajectory-extract / trajectory-status           │   │  floating window (shell.overlay)     │
│   verify-graph (quick / standard)                  │   │    input area (collapsible)          │
│   question-graph (node / edge / graph)             │   │    source ⇄ graph (resizable)        │
│   split paragraphs (numbered)  ──────────────────►│   │    verify panel / fixes / audit log   │
│   serializeTrace(session events) ────────────────►│   │    history / diagnostics / toast     │
│   append: existing-graph node list into the       │   │  header 「知识图」button + run card   │
│     prompt (cross-passage edges) ────────────────►│   │  conversation tab 「轨迹知识图」      │
│   batches → llm.stream (typed retry ×2)           │   │    trajectory ⇄ graph two-way link  │
│   schema validate → merge (dedupe/warnings)       │   └─────────────────────────────────────┘
│   task Map; busy lock; 2h purge                   │
└───────────────────────────────────────────────────┘
```

### Key design

- **Content-unit index = anchor**: Host and Client first classify each blank-line block (heading / list / dialogue / table / code / quote / prose) and then number units according to that structure — headings and list items stay one unit each, dialogue turns stay separate, quotes and code organize by line; ordinary prose groups sentences by discourse markers (but/therefore/for example…) and lexical topic drift, then closes a group at ~120 chars and splits single sentences past ~180 chars at clause/punctuation boundaries, so one unit never accumulates too many node badges. The prompt requires every node to report its source unit index; the client maps units **deterministically** instead of relying on the LLM to quote verbatim.
- **Evidence carries its own provenance, and relation evidence must prove the relation itself**: canonical node/edge evidence uses `evidence[{ documentId, sourceId, chunkId, paragraph, quote }]`. The Host re-authenticates each quote against the referenced source unit at the write gate and fills provenance from the source-version/chunk covering that paragraph; an unlocatable quote is never upgraded into evidence. If the same canonical Node/Edge appears again in a later source version, the new evidence is merged instead of discarded. Endpoint presence alone still cannot prove `supports / causes / infers`.
- **Generate → Verify → Repair → Accept**: `validateGraphInvariantsHost()` is the deterministic truth gate shared by generation and quick-check. Every batch is schema-normalized and invariant-checked before merge; blocking invariants are fed back to the model as typed repair instructions for a bounded three-attempt retry. Deterministic paragraph fixes are repaired Host-side, invalid edges can be safely omitted after the retry budget, but a node that cannot be safely repaired or anchored makes the task fail explicitly with `invariant_violation`. A final whole-graph gate runs after all batch merges, and only `invariantErrors=0` can be persisted. The generation audit separately counts evidence-backed, candidate, and unsupported claims; a node without an authenticated quote is never labeled grounded.
- **Anchor / evidence / semantic entailment are separate states**: `paragraph` is only an anchor; it is not claim evidence. A source-authenticated quote yields `groundingStatus=grounded`, a node with only an anchor is `candidate`, and a supplied quote that cannot be authenticated is `unsupported`. Semantic entailment is tracked independently as `entailmentStatus=verified|unsupported|uncertain|unverified`. The deterministic gate authenticates provenance but does **not** claim that a node's text is semantically entailed merely because a quote exists. Quick-check reports anchor coverage, evidence coverage, and independently verified entailment coverage separately.
- **Typed failures, never silent**: CLI/process failures, non-JSON output, schema/invariant violations, busy queue, and missing models all produce explicit error codes; semantic state that cannot be safely repaired is never presented as a successful canonical graph.
- **No offset guessing**: if anchoring fails, the node is simply not linkable between graph and text — no fabricated offsets, always surfaced in the diagnostics list (`anchor_unresolved:node:...`).
- **Trajectory graphs use the same canonical document lifecycle as source graphs**: session events are serialized into numbered units (user messages / tool calls / tool results / assistant replies) with `[start, end)` offsets. The first trajectory extraction produces a `documentId/revision/sourceId`; later appends send only `sessionId + documentId + expectedRevision`. Host/SQLite reloads the complete canonical graph plus persisted `traceText/traceEvents` before appending. Browser `localStorage` keeps only the trajectory `documentId/revision` reference, never the full graph/text, so repeated appends past 800 visible nodes cannot silently discard hidden nodes.
- **Incremental merge (append split)**: on append, the existing graph's node list is injected into the prompt; the AI only produces new nodes and links them into the old graph by referencing existing node ids (**cross-passage edges**). The Host renumbers new ids, offsets unit numbers, and performs semantic dedupe. When a canonical Node/Edge reappears, provenance-rich evidence is merged rather than thrown away; append remains protected by the frozen base revision.
- **The source is the only ground truth**: quick checks run locally on the Host using the same anchor-matching algorithm as the Client; the deep audit batches content units, reviews only the relevant sub-graph per batch, and the standard mode generates candidate issues first and then filters them with a second confirmation pass; issues without locatable evidence, with low confidence, or targeting missing graph objects are dropped Host-side; verify/question input is capped at 800 nodes to prevent crafted graphs from stalling the Host.
- **Fixes are explicit and auditable**: the AI only proposes, the user applies (or applies all auto-fixable issues with one click), and every patch writes a compact before/after snapshot to `graph.verification.auditLog`. A bounded browser window no longer allocates sequential canonical node IDs: added nodes use `node_<UUID>` and Host/SQLite still reject hidden-ID collisions. `merge_nodes` is submitted as a semantic `merge_node(from→into)` operation and executed on the full canonical graph, so incident edges outside the window are redirected rather than silently deleted. Every commit remains guarded by `expectedRevision` and the invariant gate; blocking edits return `invariant_violation`, stale writes return `revision_conflict`.
- **Tasks are observable and cancellable, not timeout-as-failure**: model work runs until it finishes or the user cancels; live progress (stage / elapsed / chars received / warnings) is surfaced and every long operation has a cancel button, so a slow stream never silently fails.
- **SQLite candidate layer**: `src/kg-store.mjs` persists documents, chunks, nodes, edges, and evidence, then derives evidence-bearing entity and claim candidates from node types. A canonical revision removes stale candidates while preserving accepted/rejected state for surviving stable candidate ids; the CLI can also update review state.
- **Chapter / review view**: chapter filtering changes only the browser view, not the source graph; review decisions use the stable `documentId | kind | nodeId` key and preserve source evidence.
- **Pluggable declaration extractor**: the Host optionally consumes a `kgExtractor` service implementing `extractChunk(input)`. It receives owned chunk JSON and existing node ids, and returns either the normalized graph object or JSON text; without the service, the existing LLM path remains the fallback.
- **Lossless per-chunk checkpoints**: every successful chunk records `nextBatchIndex`, the complete semantic state accumulated so far, plus append `baseRevision / baseSource / baseStaging`. Trajectory checkpoints additionally retain `traceEvents`, and trajectory append checkpoints retain `baseTraceText/baseTraceEvents`. Recovery after a Host restart verifies that the canonical revision still equals the frozen base revision and reattaches old chunk/section/trace metadata; completed batches are not re-run. Checkpoint v2 is never truncated to the 800-node renderer budget and lives in Host/SQLite; deterministic failures stay terminal.
- **800 is a view budget, not a knowledge limit**: Host/SQLite retains the full canonical graph, while persistent `document-load` now executes SQL `LIMIT/OFFSET` directly. Subgraph search reads only direct matches, bounded incident edges, and one-hop neighbors instead of materializing the full graph in Node before slicing. The browser still loads at most 800 nodes and provides previous / next / direct-page navigation plus bounded search by node ID, text, type, or section. JSON/CSV full export remains an explicit canonical-graph read.

## Data contract

```
KnowledgeGraphDto { summary: string, source?, staging?, nodes[], edges[], warnings[], generation?, verification? }
GenerationAudit { invariantVersion, status: 'succeeded' | 'succeeded_with_warnings', invariantErrors: 0, sourceAudit, retryCount, autoRepairCount, autoRepairs[], grounding: { groundedNodes, candidateNodes, unsupportedNodes, evidenceBackedClaims, candidateClaims, unsupportedClaims, entailmentVerifiedNodes, entailmentStatus } }
Source { id, documentId, title, chars, paragraphCount, chunkCount, sectionCount, sections[] }
Staging { sourceId, documentId, chunkCount, chunks[] }
Evidence { documentId, sourceId, chunkId, paragraph, quote }
Checkpoint { version: 2, taskKind, sourceId, documentId, baseRevision?, baseSource?, baseStaging?, traceEvents?, baseTraceText?, baseTraceEvents?, nextBatchIndex, totalBatches, graph /* lossless */, staging }
GraphView { nodes[<=800], edges[], view: { kind: 'window' | 'query', nodeOffset, nodeLimit, totalNodes, totalEdges, truncated, query?, matchedNodes? } }
GraphOperation { kind: 'merge_node', fromNodeId, intoNodeId }
EntityCandidate { id, documentId, nodeId?, text, type, status: 'candidate' | 'accepted' | 'rejected', evidence[] }
ClaimCandidate { id, documentId, nodeId?, text, type, status: 'candidate' | 'accepted' | 'rejected', confidence?, evidence[] }
ExtractionRun { runId, documentId?, sourceId?, status, nextBatchIndex, totalBatches, checkpoint }
GraphExtractorService { extractChunk({ title, chunk, paragraphOffset, existingNodeIds, prompt, attempt }) -> KnowledgeGraphBatch | JSON }
Node  { id, type, typeLabel?, text, quote?, paragraph?, evidence?: Evidence[], groundingStatus: 'grounded'|'candidate'|'unsupported', entailmentStatus: 'verified'|'unsupported'|'uncertain'|'unverified', documentId?, sourceId?, chunkId?, sectionId?, sectionTitle? }
Edge  { fromNodeId, toNodeId, relation, relationLabel?, evidence?: Evidence[], documentId?, sourceId?, chunkId? }

GraphVerification {
  lastReport?: VerificationReport,
  stale?: boolean,
  auditLog?: [{ ts, action, targetId, detail, reportId, before?, after? }]
}
VerificationReport {
  reportId, mode: 'quick' | 'standard' | 'question',
  createdAt, model?, scope: { kind: 'full' | 'node' | 'edge' | 'graph', ids[] },
  summary, metrics: { checkedNodes, checkedEdges, errorCount, warningCount,
                     suggestionCount, anchorCoverage, evidenceCoverage,
                     entailmentCoverage, paragraphCoverage },
  issues: Issue[]
}
Issue {
  id, source: 'local' | 'ai' | 'question',
  severity: 'error' | 'warning' | 'suggestion',
  category: 'grounding' | 'type' | 'relation' | 'duplicate' | 'contradiction'
          | 'completeness' | 'summary' | 'other',
  targetKind: 'node' | 'edge' | 'graph', targetId: string | null,
  title, detail, evidence: [{ paragraph?, quote? }],
  confidence: 0..1,
  proposedFix: { action: 'none' | 'update_node' | 'delete_node' | 'add_node'
               | 'update_edge' | 'delete_edge' | 'add_edge' | 'merge_nodes'
               | 'update_summary', nodePatch?, edgePatch?, mergeIntoId?, summaryPatch? },
  status: 'open' | 'accepted' | 'rejected' | 'applied'
}
```

- The 7 node wire types and 6 relation edge types are listed above.
- `paragraph` is a deterministic anchor only. An authenticated evidence item carries its own `documentId/sourceId/chunkId/paragraph/quote`; semantic entailment remains `unverified` until an independent verifier establishes it.
- `verification` is optional; history entries produced by older versions simply load as unverified.

## License

[MIT](LICENSE) © cwbcheng
