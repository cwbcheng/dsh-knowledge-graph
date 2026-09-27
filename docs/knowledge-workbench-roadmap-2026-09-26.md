# Knowledge Workbench Roadmap

## Authorization And Delivery State

The user accepted the seven directions below, requested a commit of the prior
uncommitted work, and then requested sequential implementation. They later
explicitly authorized committing item 1, which is `cb37aaf68658dcea380e0f8637e96cf373082154`.
They then authorized committing the verified item 2 work. This does not
authorize committing later items, pushing, merging or restarting production.

- Prior work committed: `f898a1d` (`fix: preserve workbench drafts and keyboard
  focus`). A fresh full Node 24 `npm test` passed before that commit; evidence:
  `output/precommit-20260926.log`. Browser output and the dependency symlink
  were not committed.
- Development checkout: `/mnt/d/github/.dsh-safe-bulk-verification-20260925`,
  branch `codex/kg-audit-continuation-20260926`.
- Production remains separate: `/mnt/d/github/dsh-knowledge-graph`, port 3099,
  `dsh-kgsrc-web.service`. No production graph, report, configuration or
  credential may be used as writable test data. Port 3109 is unrelated.
- Use Node 24 at `/opt/node-v24.14.0/bin`. Keep source, `lib`, extension viewer
  and signed distribution consistent. Use only the existing external signing
  identity. Never weaken a gate or create a new signing identity.
- Use independent temporary databases, random free ports and controlled model
  streams. No paid model calls or starts/resumes/cancellations of user tasks.
- The continuous-improvement automation may be paused independently of this
  roadmap. Check its current state before relying on another scheduled run.

## Ordered Queue

| Order | Capability | State | Acceptance boundary |
| --- | --- | --- | --- |
| 1 | Incremental audit reuse | First version and publication-history follow-up verified and committed | Explicit plan, complete coverage, content/ontology/model/prompt dependencies, durable independent results, local checks rerun, no stale patch authority |
| 2 | Issue work packages | Implemented and isolated-browser verified; included in this commit | Group by rule/problem family and source/context; independent verdict per item; preview conflicts and before/after changes; one confirmation and reversible changes |
| 3 | Hierarchical reading map | First usable version implemented and isolated-browser verified; uncommitted | Book, source chapter, graph-concept candidate theme, evidence-anchored reading priorities and original quotation navigation; derived views never merge canonical nodes or turn summaries into source facts |
| 4 | Saved task perspectives | First usable version implemented and isolated-browser verified; uncommitted | Persist filters, focus and expansion/reading state rather than copying the graph; test reload, revision changes and missing nodes |
| 5 | Cross-book concept dossiers | First usable version implemented and isolated-browser verified; uncommitted | Candidate alignment only; retain each source, conditions, time and disagreements; distinguish faithful attribution from real-world truth |
| 6 | Learning mode | First usable version implemented and isolated-browser verified; uncommitted | Concept discrimination, mechanism explanation and transfer to new situations; separate progress and generated tasks from canonical source knowledge |
| 7 | Expanded quality benchmark | Offline evaluator and draft adversarial fixture implemented; independent human labels and measured model runs pending | Human-confirmed cases for negation, conditions, cross-paragraph evidence, homonyms, unsafe merges and distant dependencies; evaluate false positives/negatives, unsafe repair, cost and time |

Existing QA/quality gates remain mandatory throughout. Their current fixture
scores are not a substitute for new human-labelled semantic evaluation.
Do not claim draft benchmark labels or controlled predictions are measured model
quality. The first six capabilities have their own verification records below;
none of items 3-6 is committed or deployed.

## Item 1: Incremental Audit Reuse

### Contract

The document workbench has an explicit incremental action. Ordinary deep audit
still performs a fresh review. Incremental mode first requests a read-only
plan for the current canonical revision and selected model. The user sees the
reused/dirty batch counts and minimum new requests before admission. An old or
malformed Host response cannot silently fall back to a full paid audit.

The Host rebuilds the complete source/node/relation ownership plan against the
current document. It reuses only server-persisted completed batches whose
versioned input fingerprint matches. Inputs include full node/edge fields,
source units, ownership sets, ontology, model identity and review/independent
confirmation prompts. Object-property ordering and cosmetic batch ordinals
are canonicalized; arrays and complete semantic values remain significant.

Output dependencies include issue evidence, repair targets and merge
destinations outside the prompt, their incident relation membership, endpoint
nodes and source evidence. Unanchored output quotes conservatively depend on
the entire source. Results are re-admitted under current scope, evidence and
repair validation. Missing proof, altered result hashes or validation warnings
cause a miss, never an implicit successful check.

Each reused batch is copied through the ordinary transactional result/cursor
checkpoint path. Its original run, batch and revision are retained. Pause and
resume preserve incremental mode; changing the resume model still preserves
the provenance of already-completed batches. A failed copy cannot increment
completed coverage or publish a successful report.

Local rules run on the full current graph every time. The report records reused
versus newly reviewed batches and current coverage/revision. Per-issue input
dependency hashes allow unchanged, handled findings to retain their handling
state; changed dependencies cannot inherit an old decision, even on a later
reuse pass. No proposed repair is automatically applied.

### Evidence And Reproductions

- Original negative control: the unchanged completed-run plan had no reuse
  count and the new regression failed. Fixtures explicitly verify that their
  paragraph indices match the actual content splitter before testing distant
  evidence, rather than relying on blank-line indices.
- `scripts/kg-verification-reuse-smoke.mjs` uses the actual generated persistent
  HTTP Host and a temporary SQLite store. It covers full coverage, durable
  reuse after Host recreation, changed claims, distant source evidence, added
  relations, model/document isolation, explicit fresh audits, nonempty
  independently confirmed findings, external merge destinations, changes after
  the old text-preview prefix, handled-state retention/invalidation, corrupted
  results, legacy rows, pause/resume and a transactional disk-failure fixture.
- A pause/resume test exposed a missing incremental flag in checkpoint hash
  reconstruction. Both unchanged-model and changed-model reconstruction now
  preserve the flag.
- Browser testing exposed a real miss after saving the report: evidence
  authentication reordered object properties without changing their values.
  Fingerprints now use canonical object ordering. The backend regression saves
  the report through real `graph-commit`, not a bypassing store-only mock.
- The same browser run exposed completed tasks showing an old zero-coverage
  progress snapshot. Successful live verification now includes final progress.
- A further adversarial case proved that an unanchored node quotation could
  otherwise reuse its batch after the underlying source changed. Unanchored
  input and output quotes now depend on a full-source SHA-256 computed once
  per context. The negative regression is retained in
  `output/incremental-audit-final-test-20260926.log`; it was not a passing run.
- `scripts/kg-verification-progress-smoke.mjs` executes both real admission
  handlers and adds incremental plan approval/cancellation, old Host,
  malformed counts, changed revision, navigation and offline cases.
- Browser fixture: real `lib/client.js`, Cordis Host, independent SQLite and
  controlled model stream. Final fixture port 45095: an ordinary review made
  five model calls and saved revision 2; the incremental run reused all five
  batches, made zero additional model calls and saved revision 3. The report
  showed 37/37 nodes and 37/37 source units. Reload preserved the report and
  did not submit again. No production data or model endpoint was used.
- Inspected desktop 1440 x 1000 and mobile 390 x 844 screenshots:
  `output/playwright/incremental-audit-desktop.png`,
  `output/playwright/incremental-audit-mobile.png`,
  `output/playwright/incremental-audit-mobile-actions.png`. Checked summary
  wrapping and document scroll width; no browser errors observed.
- Final full Node 24 `npm test` passed, exit 0, after those corrections:
  `output/incremental-audit-verified-test-20260926.log`. This includes the new
  reuse regression, existing verification, recovery, quality, ontology and
  packaging gates. Existing npm configuration and experimental SQLite warnings,
  and intentionally failing PDF/OCR/model/disk fixtures, were not suppressed.
  The signed extension passed payload parity and stale-payload rejection using
  the existing external identity. `git diff --check` passed.
- Final fixture task state was idle before teardown; its browser and owned
  service were closed. The earlier pre-correction fixture was discarded, not
  counted as a pass. Production remained active with MainPID 2056309 and start
  time 2026-09-26 20:57:44 CST.
- The existing isolated preview at `http://127.0.0.1:3119/` was subsequently
  checked idle and restarted using its existing `kg-entry` profile, temporary
  DSH home/database, Node 24 and safe-runtime flags. Authenticated plugin
  readiness passed. A read-only incremental plan on `global-entry-fixture`
  returned version 1, revision 1, 2 nodes/1 edge/2 source units, zero reused
  batches and one new batch; no task or model call was started. The SHA-256 of
  the sorted row contents of all 10 application tables was unchanged:
  `02ef0995e91528bda7f46d5279e88cdd1667e02af4b93a7354cb69152c1f6537`.

### Publication History Follow-Up (2026-09-27)

The previous browser run exposed a genuine state-model error: a saved report
was considered pending again when another report replaced it. Comparing with
the current report establishes which report is selected, not whether an older
report was ever committed. Deleting those older runs would destroy reusable
batches and would not solve the distinction.

The store now uses the current report and committed revision snapshots as
publication evidence. Existing snapshot writes already share the graph
transaction, so no separate, failure-prone acknowledgement write is needed.
The list and explicit-delete admission use the same predicate: a stale pending
row cannot delete an already published run even when its checkpoint timestamp
has not changed. The original checkpoints and completed batches are retained.
Running, paused and failed tasks remain visible regardless of report history.

A document-scoped expression index avoids parsing large revision snapshots for
every run during listing. It is created after the additive snapshot-column
migration, supports existing saved snapshots without rewriting them, and is
confirmed by EXPLAIN QUERY PLAN on the actual listing SQL. Restore preserves
publication history without weakening graph revision CAS.

- Negative control: the new HTTP regression failed on the first saved report
  reappearing after the second report became current. Evidence:
  `output/report-history-reproduction-20260927.log`. An earlier fixture setup
  omitted grounded status and correctly caused a cache miss after evidence
  authentication; `output/report-history-negative-20260927.log` is that fixture
  failure, not the publication-bug reproduction or a passing test.
- `scripts/kg-verification-report-history-smoke.mjs` uses the actual generated
  Host and independent temporary SQLite. It covers two-report replacement,
  Host recreation, an actual SQLite failure after snapshot/revision writes,
  atomic rollback, explicit report recovery, stale save rejection, restore of
  both an older report and a pre-review graph, preserved reusable batches,
  stale deletion, document-scoped identity, unfinished states, missing legacy
  proof, pre-index databases and pre-snapshot-column databases. It is registered
  in the normal `test:kg-verification` command.
- Fresh complete Node 24 `npm test` passed, exit 0:
  `output/report-history-full-test-20260927.log`. Existing fault fixtures and
  npm/experimental SQLite diagnostics were not suppressed. Source/generated
  store parity, signed extension payload parity and stale-payload rejection
  passed. No new signing operation was needed; viewer and CRX bytes are
  unchanged from the previous verification. `git diff --check` passed.
- Real browser fixture on random port 45601: first report saved revision 2
  using five controlled model calls; incremental replacement saved revision 3
  without additional model calls. Reload showed no historical pending report.
  Rejecting the next report save left revision 3 unchanged and exactly one
  genuinely unsaved report recoverable. After reload, clicking Save Report
  saved revision 4, with no new submission or model call. Three submissions,
  four save attempts, five total controlled model calls; no paid endpoint.
- Inspected desktop 1440 x 1000 and mobile 390 x 844 screenshots:
  `output/playwright/report-history-reloaded-desktop.png`,
  `output/playwright/report-history-recovered-mobile.png`, and
  `output/playwright/report-history-report-mobile.png`. The recovered report
  retained full 37-node/37-source-unit coverage and five reused batches; no
  page errors, mobile horizontal overflow or phantom pending row was observed.
  The fixture was idle before its browser and owned service were closed.
- The existing 3119 preview was checked idle and restarted, still using the
  isolated `kg-entry` home/database. Authenticated ontology readiness passed;
  a read-only run-list request then initialized the lazy store and confirmed
  the new history index. An index check before that request was premature,
  not a successful verification. Fresh post-request verification passed.
  All ten application tables retained the same row-content SHA-256:
  `fbe04fb23e49c05ecd368847149c8261a1770c1de15a05a6297311b8c10a60c3`.
  This receipt hashes arrays of serialized, sorted rows; it differs in format
  from the earlier receipt and is compared only against its own before hash.
  Preview PID is 2204139. No production access, task or restart was performed.
- Machine-readable test/artifact/preview receipt:
  `output/report-history-verification-20260927.json`.

### Remaining Boundaries

- This first version reuses complete review batches, not arbitrary fragments
  of a prior verdict. Changed batch membership may conservatively review more
  than the directly edited item. It is not a fixed one-hop invalidation rule.
- Older saved batches without dependency proof are not retroactively certified.
  The first incremental plan may therefore show zero reusable batches. Do not
  tell the user an old 857-batch audit is reusable without checking that plan.
- Existing prompt input limits remain. Full-value hashing prevents a change
  beyond a preview from being hidden by the cache, but does not claim that the
  pre-existing full-audit prompt now contains every long node character.
- Model identity is provider/model configuration, not a verified weight hash.
  Silent provider model changes cannot be detected locally; users retain the
  explicit fresh-audit action. Future admission-rule changes must bump the
  reuse proof version or include the changed policy in the fingerprint.
- Controlled models verify data flow, persistence, isolation and UI behavior;
  they do not prove real-model verdict quality or actual token savings.
- Whole-graph multi-pass issue synthesis, old audit navigation races and other
  outstanding audit concerns remain in `continuous-audit-2026-09-26.md`.
- A legacy report absent from both the current graph and all retained revision
  snapshots cannot be proven published. It remains recoverable, not silently
  marked saved. This change does not invent lost history or introduce a report
  history browser. Any future snapshot-retention policy must preserve durable
  publication evidence before pruning snapshots.

## Item 2: Issue Work Packages

The page groups open findings by allegation family or family plus source
paragraph, without merging their verdicts. A group run exports one canonical
graph/source context and reuses its context index, but sends a separately
identified review request for every issue. Resumed tasks retain the original
allegation and context hashes; title, detail, category, evidence, or proposed
fix changes cannot rebind an in-flight answer. Similar missing-quote and
unsupported-claim findings are not treated as one automatic quote repair.

Confirmation requires an explicit read-only `graph-commit-preview` call on
the current revision. The preview runs the sequential planner, shows each
outcome and graph before/after lines, and reports actual conflicts rather than
the optimistic count of individually safe patches. The Host applies the same
ontology/evidence/invariant checks as commit, but does not write a graph or
revision. A second export before save checks the revision and deterministic
plan fingerprint. The one group save is a revision-fenced canonical commit;
failed persistence retains the review session instead of claiming success.

The commit is tagged `bulk_review` in revision history. The UI retains only
document/report/revision references for undo, not a graph copy. The undo
endpoint restores the previous canonical snapshot as a new revision only
when the latest revision is exactly that group commit and its report matches.
Any later edit or an already-used receipt is rejected, so undo cannot erase
unrelated work. The volatile Host uses the same fence with its in-memory
snapshot; after a Host restart, that nonpersistent mode cannot undo an older
group, while the production SQLite Host can. Undo restores both graph content
and review statuses.

Evidence:

- The adversarial planner case had two individually safe fixes for one node;
  the actual plan applied one and held the second as a conflict. Missing
  allegation proof, changed source, graph/context/revision changes, edited
  outcomes after preview, repeated clicks and navigation were rejected before
  commit. A failed model row cannot attach to a changed allegation.
- Persistent SQLite and dynamic Host tests verify read-only preflight, invalid
  graph rejection, successful group undo, wrong report rejection, repeated
  receipt rejection and a later-edit CAS fence. The generated HTTP route was
  used against an independent temporary database.
- Real isolated browser, controlled model and temporary SQLite: two separate
  issue reviews produced a two-fix preview with zero graph commits; one
  confirmation saved revision 2; undo restored four open issues and the two
  original empty quotations at revision 3. A second run confirmed the undo
  button survived page reload and still restored the graph. No production
  data, paid model or user task was used.
- At 390 px, the preview was visible and document scroll width equalled
  viewport width. This visual check caught a negative hidden-change count
  from a pre-existing diff helper; the count now tracks all changes and the
  zero/overflow cases have a regression test.
- Final Node 24 `npm test` passed, exit 0, after the mobile visual fix. It
  rebuilt source/generated artifacts and passed the packaging payload parity
  and stale-payload rejection gates using the existing external identity.
  `git diff --check` passed. Synthetic fault fixtures logged their expected
  errors; those lines were not treated as test failures.
- Focused checks: `kg-issue-work-packages-smoke`,
  `kg-question-feedback-ui-smoke`, `kg-question-context-completeness-smoke`,
  `kg-candidate-sync-smoke`, `kg-generation-gate-smoke`,
  `kg-commit-queue-smoke`, `kg-paragraph-remove-smoke`,
  `kg-quick-verification-lifecycle-smoke` and packaging parity.

## Next Action

Item 1's first-version delivery and history follow-up, plus item 2's
end-to-end work-package flow, are verified and committed on the isolated
branch but remain undeployed. Item 3 now has a verified first usable version:
source chapters, distinct graph-concept candidate themes, selected
evidence-anchored reading priorities and exact original quotation navigation.
It remains uncommitted and undeployed. These priorities are deterministic
reading aids, not author-designated core claims or a claim of real-world truth.
Item 4 has a verified isolated first version; items 5-7 have not started. No
production release is authorized.

## Item 3: Hierarchical Reading Map (2026-09-27)

- The new Host `reading-map` request reads canonical graph state at a requested
  revision and returns source-section headings, counts, a 20-item page and
  exact source quotations. It does not write to the graph or use an LLM.
  Missing or stale sections are shown as unassigned rather than guessed.
- The persistent HTTP route uses the saved paragraph-unit table when present;
  this prevents a legacy source-text split from being mistaken for the
  authoritative citation unit. Exact node quotations can provide a source
  anchor when separate evidence rows are absent. Cross-document evidence and
  quotes absent from the source are excluded. The UI distinguishes semantic
  verification status from an extracted node type.
- Isolated regression `scripts/kg-reading-map-smoke.mjs` exercises source
  mismatch, pagination, section fallback, stale revision, invalid topic,
  fabricated/foreign evidence, no mutation, generated parity and the actual
  SQLite-backed HTTP route. `npm run test:kg-consumption` and signed package
  parity passed using Node 24 and the existing external identity.
- After confirming `task-active` idle, only the isolated `kg-entry` preview
  on port 3119 was restarted. A real browser with no conversation and no
  model key opened the global workbench, loaded the preserved fixture and
  displayed the reading map with two entries and two exact source quotations.
  Clicking the P2 quotation located the original second paragraph and node.
  Desktop and 390 px mobile panel screenshots are in
  `output/playwright/reading-map-panel-*.png`; the mobile region and document
  widths equalled their viewport/container bounds, with zero console errors.
  The fixture has no source sections, so it could not validate multi-section
  selection by itself.
- Fresh full Node 24 `npm test` passed with exit 0 after the final source-unit
  and quotation changes: `output/reading-map-full-test-final-20260927.log`.
  This includes packaging payload parity and stale-payload rejection. The
  signed CRX was regenerated with the existing external identity. The 3119
  fixture remained revision 1, `task-active` was idle, and the browser was
  closed. `git diff --check` passed. No commit, push, production restart,
  paid model call or production graph access occurred.

- A second, independently generated SQLite/browser fixture ran on port 3127
  with 851 nodes, two source sections (400 and 450 entries), one unassigned
  entry and a claim beyond the normal 800-node render window. In the real
  browser, section selection displayed the 450-item chapter; page jump 23
  reached P850/n849; selecting its quotation located both the canonical node
  and original P850. The unassigned entry correctly reported no verifiable
  original quotation. An unsupported n401 initially appeared as merely
  unverified, so the UI now displays its actual semantic status. This was
  verified after rebuilding and restarting only the idle isolated 3127
  service. Screenshots: `output/playwright/reading-map-large-desktop.png` and
  `output/playwright/reading-map-large-mobile.png`. At 390 px, document
  scroll width matched viewport width; browser console had zero errors or
  warnings. The browser was closed and the owned 3127 instance was stopped
  after `task-active` returned idle.
- A 5,000-node/8,500-edge persistent graph returned a 20-entry map page in
  81 ms in the isolated smoke run, with a 4,894-byte response. This is a
  measured sample, not a guaranteed latency bound. A new adversarial source
  range test proved that a stale node `sectionId` could put a P3 claim under
  the P1-P2 chapter; it failed before the fix. The Host now validates a
  declared section against the actual paragraph range and avoids coercing a
  missing paragraph to zero. The focused smoke passes after this change.
  Fresh Node 24 `npm test` then passed with exit 0:
  `output/reading-map-full-test-stale-section-20260927.log`. The signed CRX
  was rebuilt with the existing external identity; payload parity and
  stale-payload rejection passed. `git diff --check` passed. The work remains
  uncommitted on the isolated branch and was not deployed.

### Concept-Led Candidate Themes (2026-09-27)

- A new negative-control fixture failed before implementation because the
  reading-map response had no concept layer. The Host now derives candidate
  themes only from actual concept-node IDs with a direct same-section link to
  a claim-like knowledge node. Same-name concepts remain separate identities;
  cross-section links, example-only links and duplicate parallel edges do not
  inflate or merge the candidate. Both edge directions are covered. The
  section's complete entry list remains available. Candidate lists are
  limited to 12 per page with an explicit next/previous group control; a
  selected candidate exposes its own concept and directly linked knowledge
  entries with their independently checked original quotations. The UI says
  that candidate theme names come from graph concepts, not source headings,
  and that a relationship does not establish the truth of a claim.
- The adversarial smoke covers homonyms, cross-section and example edges,
  duplicate links, reverse direction, invalid cross-section selection and
  the 12+3 candidate pagination. The 5,000-node/8,500-edge fixture still
  returned a bounded page (4,951 bytes; 82-93 ms in sample runs). The real
  isolated browser used a fresh 851-node/3-edge SQLite graph on port 3127.
  Clicking the chapter-one concept displayed only n0/n1; chapter two showed
  a separate same-name n400 candidate and its n401 claim, explicitly marked
  `语义不支持`. No foreign-chapter n401 appeared in the chapter-one candidate.
  Desktop/mobile captures are `output/playwright/reading-map-themes-*.png`;
  390 px document width was 390 px and console errors/warnings were zero.
  The browser was closed and the owned service stopped after the idle check.
- Fresh Node 24 `npm test` passed after the concept layer changes:
  `output/reading-map-themes-full-test-20260927.log`. The extension was signed
  with the existing external identity; payload parity and stale-payload
  rejection passed. `git diff --check` passed.
### Evidence-Anchored Reading Priorities

- A further negative-control fixture failed before the Host provided any
  selected claims. Each chapter or chosen concept now presents up to five
  deterministic reading priorities. The selection first prefers proposition
  and rule/model types, then unique same-chapter direct-neighbor count, then
  source order. A candidate must have an exact quotation in authoritative
  paragraph units and must not have `unsupported` semantic status. Fabricated
  quotations, foreign evidence and legacy source-text matches that disagree
  with saved units cannot promote a claim. The UI labels these as reading
  starting points, not author-designated core theses. The full list remains
  accessible even when a chapter has no eligible priority or concept link.
- Isolated tests cover unsupported and invented candidates, source-unit
  disagreement, same-name concepts in different chapters, duplicate and
  cross-section relations, theme pagination, revision fencing and canonical
  graph immutability. On the browser fixture, the chapter-one concept's
  selected n1 opened both its graph location and original P2. Desktop/mobile
  theme screenshots and `output/playwright/reading-map-highlights-mobile.png`
  were visually inspected; mobile document width remained 390 px with no
  console errors or warnings. The 851-node fixture used no model key or paid
  call. Its browser was closed and owned 3127 process stopped after an idle
  check. A 5,000-node/8,500-edge read returned a bounded 5,015-byte response
  in 82-84 ms in isolated sample runs; this is not an SLA.
- The first full `npm test` after adding the final adversarial assertion
  failed in the unrelated dynamic timeout fixture: a task did not settle
  within its 1,200 ms test poll. The same fixture passed in isolation, and a
  fresh complete Node 24 `npm test` rerun passed: see
  `output/reading-map-highlights-final-test-20260927.log` and
  `output/reading-map-highlights-rerun-test-20260927.log`. This transient
  timeout is retained as evidence, not relabelled as a passing run or silently
  suppressed. The existing external signing identity produced a CRX with
  payload parity and stale-payload rejection. The implementation is isolated,
  uncommitted and not deployed to production.

Item 3 is a complete first version within its explicit epistemic boundary:
source headings, concept-linked candidate themes, selected grounded reading
priorities and exact source navigation. It does not pretend that a structural
ranking identifies the author's intended major thesis. Next: item 4, saved
task perspectives, using a separate test database and browser fixture. Do not
start items 5-7 before that flow is verified.

## Item 4: Saved Task Perspectives (2026-09-27)

- Negative control: `scripts/kg-perspective-smoke.mjs` initially failed because
  `savePerspective` was absent. The real fixture now tests a separate SQLite
  database, no graph/source copy in the saved payload, no graph revision change
  on save, reopening the store, update/delete version CAS, stale graph-revision
  rejection, document isolation, and resolving deleted nodes/sections without
  changing the stored preset. The generated persistent Host route is exercised
  through actual fake HTTP requests, not only a store method.
- `document_perspectives` stores a bounded, whitelisted view state with an
  independent version and canonical graph revision fence. The saved state
  contains only search filters, focus ID, relationship-gather request, layout,
  chapter, reading position and source paragraph. It rejects a supplied graph
  object and other unsupported fields. Resolve checks current revision and
  relevant IDs/sections with bounded SQLite lookups instead of loading a full
  book-sized graph; invalidated references are cleared in the returned copy,
  leaving the saved preset intact.
- The workbench provides named save, update, open and delete controls. An
  isolated browser with 851 graph nodes on port 3127 saved one search-filter
  view, reloaded the page, and reopened it with the keyword, concept type and
  second-chapter filter restored. A second view preserved an open reading map,
  second chapter, same-name concept `n400`, focused source P401 and graph
  location; switching views restored its reading state without a model call.
  The controls fit a 390 x 844 viewport in
  `output/playwright/perspectives-mobile-window.png`; console errors were zero.
- A separate isolated write advanced the fixture graph from revision 1 to 2,
  removed chapter two and focus node `n400`. The still-open revision-1 page
  refused to apply the stale view and asked for refresh. After page reload,
  opening the view reported the revision change, removed chapter/focus and
  reset reading page; the remaining first-chapter map loaded. This changed
  only the temporary fixture database, never production data.
- In the isolated browser, a third view saved a three-hop, outgoing relation
  gathering request centered on `n0`; after exiting gathering, opening the
  view restored the same center, direction and depth by requerying the graph.
  It persisted only query parameters, not projected nodes/edges. The backend
  also rejects a graph copy in the preset payload.
- An adversarial UI test first failed because an off-window focus load error
  left filters, reading map and layout half-applied. Apply now waits for
  location, checks the active document/revision again and only then publishes
  the rest of the view state. It also scopes restore requests by document and
  revision so a later view cannot leak into a different graph.
  `scripts/kg-perspective-ui-smoke.mjs` covers focus failure, a deferred
  navigation switch and successful restoration. The existing location helper
  checks the same guard after each awaited stage before changing the graph.
- Node 24 `npm run test:kg-consumption`, `npm run build`, `git diff --check`,
  and packaging with the existing external signing identity passed. An
  earlier full test invocation failed in a source-section fixture while the
  source was still being edited; the fixture passed independently. A fresh
  full Node 24 `npm test` on the final frozen source passed with exit 0:
  `output/perspectives-atomic-final-full-test-20260927.log`. Packaging again
  confirmed payload parity and stale-payload rejection. Browser console had
  zero errors. The browser was closed and the owned 3127 fixture service was
  stopped only after `task-active` returned idle. No production data, model
  call, commit, push or production restart was involved.

Item 4 meets its first-version acceptance boundary. The saved view remains a
derived navigation state, never an authority to mutate the canonical graph.
Next is item 5: cross-book concept dossiers. Keep source disagreement and
conditions explicit; do not align concepts by name alone.

## Item 5: Cross-Book Concept Dossiers (first version verified, 2026-09-27)

- Negative control: `scripts/kg-concept-dossier-smoke.mjs` first failed because
  there was no candidate search or dossier store. A second negative control
  showed that an empty first citation and a valid second-paragraph citation
  were incorrectly treated as no evidence. The current code authenticates
  each candidate quotation against the authoritative document unit at its
  own paragraph, without treating a quotation match as semantic verification
  or real-world truth.
- The separate `concept_dossiers` and `concept_dossier_members` tables retain
  document/node identities, explicit comparison relation, optional labelled
  user annotation and the source revisions at confirmation. They do not copy
  or merge canonical nodes. Same-name search only returns candidates; an
  explicit search can find differently worded concepts. Save requires
  per-source revision fences and update uses dossier-version CAS. A changed
  source becomes stale; deleting a source preserves a visible missing-source
  marker instead of silently erasing a recorded disagreement.
- The workbench can select a concept, inspect source title/author/publication
  date, compare exact citations and independently labelled source-semantic
  status versus unassessed real-world truth, choose candidate relations, add
  applicability/time/disagreement notes, confirm a dossier, reopen it after
  reload and delete it. Both original graphs remained at revision 1 in the
  isolated two-book comparison. A third book with a fabricated quote was
  clearly labelled as lacking a verifiable original citation. No LLM call was
  made. Desktop and 390 x 844 mobile screenshots:
  `output/playwright/dossier-desktop.png` and
  `output/playwright/dossier-mobile.png`.
- The store/real generated Host regression covers durable records, same-name
  non-alignment, explicit contrasting uses, missing quotes, cross-paragraph
  evidence, changed/deleted sources, missing revision fences and API
  save/list/get/delete. The final full Node 24 `npm test` passed (exit 0):
  `output/concept-dossier-final-full-test-20260927.log`. An earlier run failed
  the packaging gate because `viewer.js` was rebuilt after the CRX was packed;
  it was not counted as a pass. Rebuilding and repacking with the existing
  external signing identity before the final run restored payload parity and
  stale-payload rejection. `git diff --check` passed.
- The browser fixture used only `/tmp/kg-dossier-browser-IrV6Qj/graphs.sqlite`
  on owned port 3137. It was checked idle and stopped; the browser closed.
  Production 3099, the 3119 preview and user tasks were untouched.

### Completion Follow-Up

- Existing dossiers can now be edited in place: members can be added, removed
  or reclassified, and title, disagreement, applicability conditions and
  effective-time scope can be revised. The latter two have separate persisted
  fields and are explicitly labelled user judgments; publication date and
  dossier recording time remain distinct. An old client that omits the new
  fields remains compatible. Updating requires the dossier-version CAS and
  current revisions of every retained source; changed sources require an
  explicit user acknowledgement, while deleted sources must be removed before
  saving. The canonical graphs remain untouched.
- Each new confirmation stores a bounded-at-render source reference snapshot
  alongside the document/node identity and revision. When the source changes,
  the dossier shows the *current* reference and can expand the earlier
  confirmed text/quotation. When a source is deleted, its last confirmed
  title/text/quote remain visible as an archived snapshot, clearly not as
  current source evidence. Older dossiers without this snapshot are marked
  as such rather than pretending current text was the old evidence. Additive
  migrations preserve their prior data.
- The dossier gives a read-only original-paragraph preview, a same-graph node
  locator, and a deliberate cross-book switch with confirmation. It refuses
  a switch during extraction, review, fact/question tasks, page load or a
  paragraph edit, waits for the current graph write queue, and rechecks live
  task/view ownership after that wait. The history loader now discards
  out-of-order responses; adversarial regressions in
  `scripts/kg-commit-queue-smoke.mjs` proved both that a late older navigation
  cannot replace the newer source and that a task started during a queued
  graph write prevents the switch. A missing node fails without replacing
  the current view.
- The real isolated browser on port 3137 was used to add a third unverified
  book, edit title and annotations, remove that book, reopen after reload,
  switch from Learning Book to Database Book and focus its original node, then
  set separate condition/time fields. Its own Database Book was revised twice
  in the temporary SQLite fixture. The panel showed current 2022 content as
  stale against bound revision 2 and expanded the older 2021 quotation. Mobile
  screenshot `output/playwright/dossier-stale-mobile.png` was inspected; no
  overlap or hidden control was observed. No model endpoint was called.
- `scripts/kg-concept-dossier-scale.mjs` builds 300 independent books and
  30,000 concepts. Exact same-label candidates used the concept lookup index
  and took about 4 ms; explicit substring search took about 8 ms and returned
  bounded results on this fixture. These are observations, not an SLA; the
  substring path still scans concept labels, so larger corpora may warrant an
  FTS index after measurement. The fixture is included in `npm test`.
- Store/Host regression now covers editing, lost-update rejection, separate
  condition/time fields, old-schema migration, source-snapshot retention,
  stale/missing sources and original quotation authentication. The browser
  mutation script refuses paths outside its dedicated temporary fixture.
  After the final build and packaging with the pre-existing external identity,
  complete Node 24 `npm test` passed, exit 0, including 30,000-concept scale,
  navigation-race and signed payload/stale-payload gates:
  `output/concept-dossier-final-full-test-20260927.log`. `git diff --check`
  passed. The isolated 3137 service reported `busy:false` and was stopped;
  the browser was closed. Production 3099, preview 3119 and 3109 were not
  restarted or given test data.

Item 5 meets the candidate-comparison acceptance boundary, not a claim that
same-name concepts are equivalent or that a quotation proves a statement true.
Next is item 6: learning tasks and progress must be separate from canonical
source knowledge; begin with the existing consumption/evidence paths and an
adversarial fixture before designing generated exercises.

## Item 6: Learning Mode (first version verified, 2026-09-27)

- A negative control in `scripts/kg-learning-mode-smoke.mjs` first failed for
  the missing learning planner and independent progress store. The planner now
  derives three source-linked exercise types from the authoritative canonical
  graph: concept discrimination, mechanism explanation, and transfer to a
  learner-supplied new scenario. Each citation must occur in its recorded
  original paragraph; unsupported/rejected nodes and fabricated quotations
  are excluded. An absent concept or relation leaves that exercise unavailable
  instead of inventing material. A graph relation is not presented as proven
  causation. Every exercise is labelled graph-derived, not source text.
- `learning_attempts` is a separate SQLite table. It stores the attempted
  task, response, optional new scenario, self-rating, source revision and
  timestamp without editing the canonical graph or pretending to grade the
  answer. The Host recomputes tasks before accepting new attempts; forged
  task IDs and stale graph revisions fail. A previously saved attempt remains
  visible but marked stale after the graph changes. Exact retries are
  idempotent even when the graph changes between save and acknowledgement;
  changed retries conflict.
- The isolated browser on owned port 3147 opened the global workbench, loaded
  a three-node fixture from history, switched among all three task types,
  saved a self-assessment, reloaded and recovered its history. A browser
  adversary copied a short source quotation into the new-scenario field; the
  first version incorrectly accepted it because the copy check used a 20-char
  threshold. The regression was added before fixing normalized exact-copy
  rejection in the store, then the browser confirmed the error and a genuine
  different scenario was saved. A second browser adversary reopened a past
  concept task while the mechanism tab was selected; the history now shows
  its own prompt, source-quote snapshots and revision rather than implying
  that the active task's references apply. Repeated save clicks after a
  confirmed response now show a disabled `已保存` button until the answer or
  rating changes. The isolated fixture contains earlier rejected-design
  records only; no production graph or report was touched.
- Desktop 1365 x 900 and mobile 390 x 844 screenshots were inspected at
  `output/playwright/learning-desktop.png` and
  `output/playwright/learning-mobile.png`: content and controls fit without
  overlap. Browser console had zero errors and zero warnings; one unrelated
  verbose password-field message came from the DSH shell. The planner/store/
  generated-Host test also covers fabricated evidence, independent progress,
  exact-copy rejection, forged tasks, stale revisions and post-edit retries.
  `npm run build`, packaging with the existing external signing identity,
  `git diff --check`, and the final full Node 24 `npm test` passed with exit 0:
  `output/learning-mode-full-test-20260927.log`. CRX payload parity and stale
  payload rejection both passed. No model was called.

This is an honest self-practice workflow, not automated grading or proof of
mastery. The exact-copy guard cannot determine semantic novelty or answer
correctness, and the learner-supplied scenario is not independently verified.
The first version offers one grounded task per type from a graph; expanding
coverage and objective evaluation should be guided by the item 7 benchmark,
not assumed from fewer warnings or higher self-ratings. Next is item 7:
create an inspectable, manually labelled quality benchmark that compares
false positives, missed issues, unsafe repairs, token cost and time.

## Item 7: Review Benchmark (evaluator verified; labels pending, 2026-09-27)

- The existing 25-case frozen QA gate tests graph answerability, not whether
  a targeted AI allegation is correct or a proposed edit is safe. An initial
  negative-control test failed because no such per-allegation evaluator
  existed. `scripts/kg-review-benchmark.mjs` now evaluates a frozen gold
  fingerprint against complete per-case run files, compares model/prompt
  versions, and writes machine JSON plus a source/graph/allegation/decision
  Markdown sheet for independent review. It makes no model calls and never
  opens the production database.
- The seven **draft synthetic** cases in
  `scripts/fixtures/kg-review-benchmark-draft-v1.json` cover negation,
  applicability conditions, cross-paragraph evidence, homonyms, an unsafe
  existing merge, a distant exception at P10 and the distinction between an
  author's attributed claim and its real-world truth. They are inspectable
  calibration examples, **not human-confirmed findings**. The CLI's
  `--require-reviewed` rejects all of them until an independent reviewer
  checks and signs every label. Editing any gold case changes its SHA-256 and
  invalidates older run files.
- Controlled baseline/regressed predictions show the evaluator detecting two
  false-positive verdicts, one explicit false-negative, one positive
  abstention, three clearly unsafe proposals on unconfirmed cases, two
  unmatched repairs on confirmed cases and two missed approved repair
  opportunities. These are **synthetic counters**, not LLM quality or cost
  measurements; token/time deltas are suppressed for controlled runs or
  incomplete usage. `scripts/kg-review-benchmark-smoke.mjs` adversarially
  checks missing/duplicate predictions, changed gold, fabricated citations,
  duplicate source units, negative usage, absent usage and the review gate.
- See `docs/kg-review-benchmark.md` for the independent label-review and
  measured-run workflow. A governed conclusion still requires human sign-off
  and actual model/prompt runs on the same frozen cases. This is intentionally
  **not** marked complete solely because the evaluator passes tests.
- Targeted `npm run test:kg-qa-benchmark` passed. The final full Node 24
  `npm test` passed with exit 0 at
  `output/review-benchmark-full-test-20260927.log`; signed extension payload
  parity and stale-payload rejection remained green. The generated review
  sheet and machine comparison are in
  `output/review-benchmark-controlled-20260927.md` and `.json`. No browser
  service, production task or paid model was started for this offline tool.

### Raw Capture Follow-Up (2026-09-27)

- First-principles review found a measurement-integrity risk: manually copying
  DSH task-status replies into run JSON could silently change a verdict,
  structured repair, model identity or token count. The offline `--capture`
  mode now converts final successful issue-review replies into run files. It
  requires the frozen gold hash, one case per allegation, matching target and
  provider/model, records a SHA-256 trace of each raw status, and refuses to
  overwrite the gold or raw capture.
- Partial model usage is **unknown**, not free. The converter publishes a case
  usage value only if all started calls finished, all finished calls reported
  usage, and both total input and output token counters cover every call.
  Adversarial tests cover failed tasks, wrong target/model, missing cases,
  incomplete usage, unaccounted requests, draft-label gate and output
  clobbering. The capture interval is caller-recorded; it is not independently
  server-attested. See `docs/kg-review-benchmark.md` for the raw format and
  limitations.
- Targeted `npm run test:kg-qa-benchmark` and the full Node 24 `npm test`
  passed (exit 0); full log:
  `output/review-benchmark-capture-full-test-20260927.log`. Packaging checked
  18 extension files, payload parity and stale-payload rejection. No actual
  model was called, and the seven labels remain draft. Independent review and
  measured runs are still required before calling item 7 complete. The next
  step is to get the labels checked by a domain reviewer, freeze the corrected
  gold fingerprint, then collect comparable runs in a separate isolated
  database.

### Host Capture Contract (2026-09-27)

- The converter's unit fixture alone did not prove that real DSH task-status
  responses satisfy its schema. The existing isolated dynamic and persistent
  Host issue-review test now feeds both actual task-status replies into the
  capture converter for node and relation allegations. A deliberately missing
  usage event first failed the new complete-usage assertion. The controlled
  model stream now reports explicit input/output and zero cache tokens; both
  Host paths convert the original verdict and all reported input tokens.
- This is transport/measurement-shape evidence only. The model stream and
  verdict are controlled fixtures, not a measured quality result. No user
  graph, paid model, report or production service was accessed. Human labels
  and comparable real model runs remain the item 7 completion boundary.
- The direct dynamic/persistent Host regression and full Node 24 `npm test`
  passed after this change. Full log:
  `output/review-benchmark-host-capture-full-test-20260927.log`; the signed
  extension retained payload parity and stale-payload rejection.

### Same-Target Allegation Binding (2026-09-27)

- A negative control demonstrated a real benchmark integrity hole: swapping
  two final task-status replies for different allegations on the same node
  passed the converter's old model/target checks and silently attributed the
  wrong verdict to each case. Every gold allegation now has an explicit
  `issueId`; capture requires the Host's `reviewedIssueId` to match. The
  seven draft fixture IDs and controlled run gold fingerprints were updated,
  and the generated controlled comparison was regenerated. This changes the
  benchmark fixture fingerprint but does not change any graph or task.
- This step bound issue identity but not the admission payload. Binding the
  source/graph/question payload was the next measured-run risk and is covered
  in the follow-up below.
- The targeted benchmark and dynamic/persistent Host tests, `git diff --check`
  and full Node 24 `npm test` passed. Full log:
  `output/review-benchmark-issue-binding-full-test-20260927.log`; extension
  payload parity and stale-payload rejection remained green. No production
  write, paid model call, commit, push or deployment occurred.

### Frozen Request Binding (2026-09-27)

- A further negative control showed that a final reply for the right issue
  and target could still be counted after substituting a different graph
  snapshot. Gold cases now freeze the full review text, question, issue detail
  and anchored evidence in addition to graph/source units. Each captured case
  must include the exact submitted `question-graph` request; the converter
  rejects changes to graph fields, source units, question, issue detail or any
  extra request field. Both request and status hashes survive into the
  per-case report so a reviewer can reconcile the raw capture.
- The controlled dynamic/persistent Host path passes its actual request and
  final status through the converter for both node and relation allegations.
  Source-unit admission adds an empty evidence field to a previously bare
  fixture node; the isolated fixture was made explicit about that field so
  its existing complete-node-field assertion remains strict. No assertion
  was relaxed. The seven draft case inputs and controlled run gold hashes
  were updated; controlled output was regenerated.
- This does not authenticate the caller-supplied request/status pair or prove
  the exact internal model prompt. Human-reviewed labels, original transport
  evidence and actual comparable model runs remain required. Controlled
  fixtures must never be presented as real model accuracy or cost.
- Targeted benchmark and dynamic/persistent Host tests, `git diff --check`
  and the full Node 24 `npm test` passed. Full log:
  `output/review-benchmark-request-binding-full-test-20260927.log`;
  extension payload parity and stale-payload rejection remained green.
