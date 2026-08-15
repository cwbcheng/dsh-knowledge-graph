# dsh-knowledge-graph

**[English](README.en.md) | [中文](README.md)**

**DSH (DeepSeek Harness) Cordis plugin**: turn any piece of source text — or an AI session execution trace — into an **AI-generated knowledge graph**, with **two-way linking between the graph and the original text**.

> Paste text → AI asynchronously builds the graph → two-way anchor navigation. A standalone, reusable plugin realization of NovelStudio's "资料 ⇄ 知识图" (Source ⇄ Knowledge Graph).

---

## What it does

- **Asynchronous AI extraction**: paste any text (chapters, technical docs, study notes…); a background task calls the LLM and returns a knowledge graph in ~15–40 s. Long documents are split into batches automatically; polling resumes automatically after a refresh / window reopen.
- **7 node types / 6 relation types**:
  - Nodes: `fact` · `inference` · `concept` · `definition` · `example` · `counter_example` · `rule`.
  - Relations: `supports` · `example` · `counter_example` · `defines` · `infers` · `causes`.
- **Two-way linking**:
  - Click a **graph node** → opens a **detail card** (full content + verbatim quote + locate button) and smoothly scrolls to and highlights the matching paragraph;
  - Click a **source paragraph** → the graph centers on and pulses the corresponding node.
  - Nodes in the graph render only the first 4 lines (overflow collapses to `…`); the **full content is always available in the detail card**;
  - Anchoring primarily uses the **paragraph index** the AI reports directly (deterministic), with exact-quote matching and token-overlap scoring as fallbacks; nodes that cannot be linked are never guessed into an offset — they go to a diagnostics list.
- **Graph rendering**: SVG canvas + 7-color node palette / **4 switchable layouts** (dropdown at the graph's top right, choice remembered): **Force** (embedded d3-force engine, zero dependencies: collision avoids node overlap, edge–node repulsion keeps arrows from crossing nodes), **Circular**, **Radial** (central hub + BFS rings; edges drawn as **polylines**: radial exit → outer arc → radial entry), **Layered** (edges drawn as **orthogonal right-angle polylines**: inter-row channels + per-row obstacle corridors; segments never cross nodes) / relation edges carry type labels, and **edges sharing a source fan out by target angle** (quadratic Bézier) / drag to pan / Ctrl+wheel to zoom / toolbar `− 100% +` (50%–200%, 10% steps) / long-press a node to see the verbatim quote / keyboard accessible.
- **Floating workbench**: draggable, resizable window; the **width ratio** between text and graph and the **result area height** are both drag-adjustable and remembered.
- **Select-to-split**: select any text **inside a chat message**; a "拆成知识图" (split into graph) button floats above the selection — one click opens the workbench and splits the selection; selecting text in the result's source column splits it as a sub-graph; selecting part of the input textarea also offers "split selection".
- **Incremental append (追加拆分)**: once a result exists, the input panel's primary button becomes **追加拆分 (append split)** — paste the next passage / document and the AI extracts ONLY the new content, linking it into the existing graph via **cross-passage edges** (a concept that reappears is not duplicated — it gets an edge straight to the existing node); the result merges in place, paragraph numbering stays unified across the whole text, and the history entry updates in place. Selecting text in a chat message while a result exists appends it to the current graph automatically.
- **History**: every successful split is stored automatically (up to 20 entries, deduped by text, deletable one-by-one or all), reloadable at any time.
- **Persistent entry**: a permanent 「知识图」button on the right of each conversation header; run cards also get a launch bar.
- **Trajectory knowledge graph (conversation view tab)**: a third tab 「轨迹知识图」(beside 对话 / 轨迹) that turns the **current session's full execution trace** (user messages, tool calls, tool results, assistant replies) into a knowledge graph — visualizing what the agent **found, inferred, and did** — with two-way linking between graph and trace events (click a node → scroll to the event; click an event → focus its node). Results are saved per session: **restored after tab switches or page reloads**; leaving mid-extraction and returning resumes polling automatically; once the session produces new events, click **追加新事件 (append new events)** to extract only the new part and merge it incrementally (cross-event edges are created); the event-column / graph-column width and the result height are drag-adjustable and remembered.

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
- An **AI model provider** is configured (Settings → Models, or `agentDefaultModel`). The plugin automatically uses the current default model; if none is configured, it shows a clear Chinese error message.

### 1. Get the source

```bash
git clone https://github.com/cwbcheng/dsh-knowledge-graph.git
cd dsh-knowledge-graph
```

| File | Purpose |
| --- | --- |
| [`src/index.host.js`](src/index.host.js) | Host half: async AI extraction engine (paragraph numbering, batching, schema validation, typed diagnostics, model routing, session-trace serialization) |
| [`src/index.client.js`](src/index.client.js) | Client half: floating workbench UI, graph rendering, two-way linking, history, width/height resizing, trajectory graph tab |

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

After the restart: the 「知识图」button appears at the right of each conversation header; history, window position, etc. (browser localStorage) are preserved.

| File | Purpose (persistent package) |
| --- | --- |
| [`lib/index.js`](lib/index.js) | Host half: task engine + `/api/dsh-knowledge-graph` routes (POST extract / POST append-extract / POST trajectory-extract / GET task-status / GET trajectory-status) |
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

## Updating

- **Dynamic install (A/B)**: repeat Option A after repo updates — have the Agent re-read both source files and `cordis_define` (append a new Package under the same plugin), then `cordis_run` (update mode) to switch versions; if you previously clicked the double check, new versions run automatically.
- **Persistent install (C)**: after updates, re-run `pnpm install` (pulls latest `#main`) and restart `dsh web`.

## Uninstalling

- **Dynamic install**: open the **Cordis Plugin** panel → click **Stop** on the plugin row to pause; use `cordis_undefine` to delete the definition entirely.
- **Persistent install**: remove the dependency and bundles entries from the profile's `package.json`, then `pnpm install` and restart.

History and other data live in browser `localStorage`; uninstalling does not delete it.

## Notes

- A dynamic plugin runs **inside the DSH process**: it disappears after a process restart and must be reinstalled (Option A, or switch to persistent Option C; browser data remains); the persistent plugin loads with the service and is unaffected by restarts;
- The Host half needs a working LLM (see prerequisites); AI calls happen only inside your own DSH environment — whether they leave it depends on the model provider you configured;
- This project has **no paid / quota features**: extraction, history, and two-way linking all run locally.

## Usage

1. Click the 「知识图」button at the right of the conversation title to open the floating workbench;
2. Paste text into 「输入资料」(title optional), click **AI 拆分** (the input area collapses; result height and text/graph width ratio are drag-adjustable and remembered);
3. Once the summary / graph appears, **click a graph node to view the detail card (full content) and locate the source**, or **click a source paragraph to focus its node**;
4. To extend the graph, paste the next passage into the input area and click **追加拆分 (append split)** (or just select text in a chat message — it appends automatically): new nodes link to existing ones via cross-passage edges, paragraph numbering stays unified, and the history entry updates in place;
5. Use 「历史」to revisit previous splits (last 20 saved automatically, deletable one-by-one or all); if you close or refresh mid-task, reopening the window resumes polling automatically;
6. Switch to the 「轨迹知识图」tab and click **拆解本会话轨迹** to generate the session's trajectory graph; click a trace event to focus its node in the graph, click a node to see full content and scroll to its event; results restore after tab switches / reloads; drag the middle handle for column width and the bottom handle for result height.

## Chrome extension (划线拆图)

Select text on **any web page**, click the floating 「拆成知识图」button, and the local DSH service turns it into an AI knowledge graph right in a popup (split, view the graph, and jump back to the source text without leaving the page).

- The extension source lives in `extension/`; it is dependency-free: `viewer.js` is sliced from `src/index.client.js` by `scripts/build-viewer.mjs`, and `d3/*.js` are the embedded d3 modules as standalone files (MV3 extension pages forbid eval, so the popup preloads them with `<script src>` and the viewer's d3 loader takes the global fast path). After editing the source, run `node scripts/build-viewer.mjs` to regenerate.
- **Install (either)**:
  1. **Drag a single file (recommended)**: open `chrome://extensions` → enable **Developer mode** (top right) → **drag `dist/dsh-knowledge-graph.crx` onto the page** → click **Add extension**. The first time Chrome warns "Chromium cannot verify the source of this extension" — expected for any extension not from the Web Store; it works normally.
  2. **Load unpacked**: **Load unpacked** → select the repo's `extension/` folder.
  - Note: branded Chrome 137+ **no longer supports `--load-extension` on the command line** (Chrome for Testing / unbranded Chromium still do).
- **Repacking** (after source updates, to keep distributing as crx): keep `dist/dsh-knowledge-graph.pem` private — the extension ID derives from it (a new key = new ID = existing installs stop matching):
  ```
  chrome --pack-extension=extension --pack-extension-key=dist/dsh-knowledge-graph.pem
  ```
  Replace `dist/dsh-knowledge-graph.crx` with the produced `extension.crx` and drag it in again.
- **Dependency**: `dsh web` must be running locally with a plugin version that serves the `/dsh-kg` extension endpoint (for persistent installs, update the plugin and restart dsh web first). The endpoint only accepts `chrome-extension://` and `localhost/127.0.0.1` origins and answers with the PNA preflight header.
- **Data flow**: content script (any page) → `chrome.runtime.sendMessage` → service worker writes `chrome.storage.session` and calls `chrome.action.openPopup()` (Chrome 127+); the popup reads the selected text and POSTs to `http://127.0.0.1:3080/dsh-kg/extract`, then polls `task-status` to render the graph. The DSH base URL is editable at the bottom of the popup and remembered (`kgBase` in `chrome.storage.local`).

## Architecture

```
┌─────────────── Host (Node process) ───────────────┐   ┌────────── Client (browser) ──────────┐
│ extract / append-extract / task-status /           │   │                                     │
│   trajectory-extract / trajectory-status           │   │  floating window (shell.overlay)     │
│   split paragraphs (numbered)  ──────────────────►│   │    input area (collapsible)          │
│   serializeTrace(session events) ────────────────►│   │    source ⇄ graph (resizable)        │
│   append: existing-graph node list into the       │   │    history / diagnostics / toast     │
│     prompt (cross-passage edges) ────────────────►│   │  header 「知识图」button + run card   │
│   batches → llm.stream (typed retry ×2)           │   │  conversation tab 「轨迹知识图」      │
│   schema validate → merge (dedupe/warnings)       │   │    trajectory ⇄ graph two-way link  │
│   task Map; busy lock; 2h purge                   │   └─────────────────────────────────────┘
└───────────────────────────────────────────────────┘
```

### Key design

- **Paragraph index = anchor**: Host and Client split and number the text with the same algorithm; the prompt requires every node to report its source paragraph index; the client maps paragraphs **deterministically** instead of relying on the LLM to quote verbatim.
- **Typed failures, never silent**: CLI/process failures, non-JSON output, invalid schema (typed retry ×2 first), busy queue, missing model — all produce explicit error codes and Chinese messages; invalid nodes/edges are dropped but recorded in warnings.
- **No offset guessing**: if anchoring fails, the node is simply not linkable between graph and text — no fabricated offsets, always surfaced in the diagnostics list (`anchor_unresolved:node:...`).
- **Trace events are paragraphs**: the session execution trace is serialized into numbered paragraphs (user messages / tool calls / tool results / assistant replies), events and paragraphs stay 1:1 (long traces are truncated while keeping alignment), reusing the same paragraph-index anchor mechanism for deterministic two-way linking between graph and events.
- **Incremental merge (append split)**: on append, the existing graph's node list is injected into the prompt; the AI only produces new nodes and links them into the old graph by referencing existing node ids (**cross-passage edges**); the Host renumbers new ids (avoiding collisions), offsets paragraph numbers (keeping global alignment) and dedupes edges; the client merges the view in place.
- **Self-contained front end**: layout, force simulation, two-way linking, and history all run in the browser; the Host is only a thin async task manager.

## Data contract

```
KnowledgeGraphDto { summary: string, nodes[], edges[], warnings[] }
Node  { id, type, typeLabel?, text, quote?, paragraph?, offsetHint? }
Edge  { fromNodeId, toNodeId, relation, relationLabel? }
```

- The 7 node wire types and 6 relation edge types are listed above.
- Each node preferably carries `paragraph` (paragraph index, deterministic back-link) and `quote` (verbatim excerpt).

## License

[MIT](LICENSE) © cwbcheng
