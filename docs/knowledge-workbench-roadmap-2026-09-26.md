# Knowledge Workbench Roadmap

## Authorization And Delivery State

The user accepted the seven directions below, requested a commit of the prior
uncommitted work, and then requested sequential implementation. They later
explicitly authorized committing item 1, which is `cb37aaf68658dcea380e0f8637e96cf373082154`.
They then authorized committing the verified item 2 work. That earlier scope
did not authorize committing later items, pushing, merging or restarting
production. On 2026-09-27 the user explicitly requested merging all current
work into local `main` and deploying it to 3099. No push was requested.

- Prior work committed: `f898a1d` (`fix: preserve workbench drafts and keyboard
  focus`). A fresh full Node 24 `npm test` passed before that commit; evidence:
  `output/precommit-20260926.log`. Browser output and the dependency symlink
  were not committed.
- Development checkout: `/mnt/d/github/.dsh-safe-bulk-verification-20260925`,
  branch `codex/kg-audit-continuation-20260926`.
- Production checkout: `/mnt/d/github/dsh-knowledge-graph`, port 3099,
  `dsh-kgsrc-web.service`. It now runs the merged code. No production graph,
  report, configuration or credential was used as writable test data. Port
  3109 is unrelated.
- Use Node 24 at `/opt/node-v24.14.0/bin`. Keep source, `lib`, extension viewer
  and signed distribution consistent. Use only the existing external signing
  identity. Never weaken a gate or create a new signing identity.
- Use independent temporary databases, random free ports and controlled model
  streams. A later explicit authorization permits paid CommandCode DeepSeek
  V4.1 Flash calls on isolated 3119 only; never start, resume or cancel a user
  task.
- The continuous-improvement automation may be paused independently of this
  roadmap. Check its current state before relying on another scheduled run.

## Ordered Queue

| Order | Capability | State | Acceptance boundary |
| --- | --- | --- | --- |
| 1 | Incremental audit reuse | First version verified, committed and deployed to 3099 | Explicit plan, complete coverage, content/ontology/model/prompt dependencies, durable independent results, local checks rerun, no stale patch authority |
| 2 | Issue work packages | First version isolated-browser verified, committed and deployed to 3099 | Group by rule/problem family and source/context; independent verdict per item; preview conflicts and before/after changes; one confirmation and reversible changes |
| 3 | Hierarchical reading map | First usable version isolated-browser verified and deployed to 3099 | Book, source chapter, graph-concept candidate theme, evidence-anchored reading priorities and original quotation navigation; derived views never merge canonical nodes or turn summaries into source facts |
| 4 | Saved task perspectives | First usable version isolated-browser verified and deployed to 3099 | Persist filters, focus and expansion/reading state rather than copying the graph; test reload, revision changes and missing nodes |
| 5 | Cross-book concept dossiers | First usable version isolated-browser verified and deployed to 3099 | Candidate alignment only; retain each source, conditions, time and disagreements; distinguish faithful attribution from real-world truth |
| 6 | Learning mode | First usable version isolated-browser verified and deployed to 3099 | Concept discrimination, mechanism explanation and transfer to new situations; separate progress and generated tasks from canonical source knowledge |
| 7 | Expanded quality benchmark | In progress: offline evaluator deployed; 17 original targeted synthetic cases, nine scored synthetic full-graph fixtures (v2-v6, v8-v9, v11-v12), one curated real-article excerpt (v7) and one public-domain book excerpt (v13), with isolated Flash runs and separate repair adjudication; v10's failed zero-defect label was disqualified, not scored; none is human-confirmed or representative of whole books | Representative adjudicated cases for negation, conditions, cross-paragraph evidence, homonyms, unsafe merges and distant dependencies; compare actual model runs, repair safety, false positives/negatives, token use and time without overstating evidence |

Existing QA/quality gates remain mandatory throughout. Their current fixture
scores are not a substitute for representative semantic evaluation. The user
accepted Codex-led sample review instead of requiring one person to label all
cases; record this as `codex-reviewed`, never as independent human ground truth.
The first six capabilities have isolated verification records below. Item 7's
evaluator and controlled fixtures do not establish measured model quality.

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

## Item 7: Review Benchmark (initial evaluator; later Codex pass below)

- The existing 25-case frozen QA gate tests graph answerability, not whether
  a targeted AI allegation is correct or a proposed edit is safe. An initial
  negative-control test failed because no such per-allegation evaluator
  existed. `scripts/kg-review-benchmark.mjs` now evaluates a frozen gold
  fingerprint against complete per-case run files, compares model/prompt
  versions, and writes machine JSON plus a source/graph/allegation/decision
  Markdown sheet for independent review. It makes no model calls and never
  opens the production database.
- The seven synthetic cases, originally draft and now in
  `scripts/fixtures/kg-review-benchmark-codex-v1.json`, cover negation,
  applicability conditions, cross-paragraph evidence, homonyms, an unsafe
  existing merge, a distant exception at P10 and the distinction between an
  author's attributed claim and its real-world truth. They are inspectable
  calibration examples, **not human-confirmed findings**. The CLI's stronger
  `--require-reviewed` still rejects Codex-only labels; the later
  `--require-adjudicated` tier permits them without claiming human review.
  Editing any gold case changes its SHA-256 and invalidates older run files.
- Controlled baseline/regressed predictions show the evaluator detecting two
  false-positive verdicts, one explicit false-negative, one positive
  abstention, three clearly unsafe proposals on unconfirmed cases, two
  unmatched repairs on confirmed cases and two missed approved repair
  opportunities. These are **synthetic counters**, not LLM quality or cost
  measurements; token/time deltas are suppressed for controlled runs or
  incomplete usage. `scripts/kg-review-benchmark-smoke.mjs` adversarially
  checks missing/duplicate predictions, changed gold, fabricated citations,
  duplicate source units, negative usage, absent usage and the review gate.
- See `docs/kg-review-benchmark.md` for label tiers and the measured-run
  workflow. Codex adjudication supports a provisional benchmark, not human
  confirmation; actual comparable model/prompt runs are still required.
  This is intentionally **not** marked complete solely because the evaluator
  passes tests.
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
  model was called; the seven labels were still draft at this stage. The
  later Codex pass below supersedes that label state, not the need for
  comparable measured runs in a separate isolated database.

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
  graph, paid model, report or production service was accessed. Human review
  was the initial plan; the user later chose the explicit Codex tier below.
  Comparable real model runs remain the item 7 completion boundary.
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

### Codex Sample Review (2026-09-27; isolated, not deployed)

- The user chose Codex to review benchmark samples because manual full-sample
  labelling is too costly. This is a separate evidence pass in the same task
  lineage, **not blinded or independent human review**. The seven synthetic
  cases were checked against their supplied source units, graph, allegation
  and allowed repairs. The case-by-case record is
  `docs/kg-review-benchmark-codex-review-2026-09-27.md`.
- Two old allowed text repairs imported a distant paragraph's conclusion into
  a node that still quoted only its local paragraph. The repaired gold allows
  an edit grounded in the node's own quotation, leaving the distant statement
  separate. An adversarial fixture assertion failed on the old data before
  the correction. The case labels are now `codex-reviewed` with explicit
  reviewer/date/rationale, and the dataset ID and fingerprint changed. The
  controlled run files were rebased on that fingerprint; they are still
  synthetic, not model measurements.
- The stronger `--require-reviewed` gate remains human-only. New
  `--require-adjudicated` accepts Codex or human review while rejecting draft
  labels; report metadata says `codex_reviewed_not_human_confirmed`. Focused
  smoke tests cover both gates and missing review identity. This work is
  uncommitted in the isolated branch, with no production graph/model access.
- Item 7 is **not complete**. Next: representative Chinese and learning-view
  samples without production-data leakage, isolated model runs only after
  budget approval, persisted-graph repair safety checks, and a separate
  full-graph discovery benchmark if recall of unreported issues is claimed.

### Chinese And Ontology Cases (2026-09-27; isolated, not deployed)

- A negative control first failed because the seven-case fixture contained no
  Chinese source units. Three invented snippets now test Chinese scope and
  negation, source-material `feature_description` versus derived knowledge
  `feature`, and a `positive_example` wrongly typed despite a negative
  example in the quote. The latter's allowed repair changes only the type;
  both example types have the declared discrimination/lower coordinates.
  The case-by-case rationale is in
  `docs/kg-review-benchmark-codex-review-2026-09-27.md`.
- The dataset now has ten Codex-reviewed synthetic cases. Its frozen SHA-256
  changed to `af117748431177cfb900b096e9ca642774319127302ba16e2fadb378cbd9b0a3`;
  both controlled run fixtures were rebased and retain invented usage, not
  measured model output. The focused benchmark test detects a missed Chinese
  condition, an unsafe material-to-knowledge conversion, and a correct verdict
  that omitted its safe polarity repair. It checks the Learning View type and
  coordinates against the repository ontology, not a copied list.
- These hand-constructed samples improve adversarial coverage but are not
  representative Chinese-book accuracy data. Item 7 still needs permitted
  real-model comparisons, persisted-graph repair safety tests, and a separate
  issue-discovery recall benchmark. No production graph, report, configuration,
  credentials or paid model was accessed or changed.
- The initial coverage assertion failed on the old seven-case fixture as
  intended. After adding the cases, `npm run test:kg-qa-benchmark`, full Node
  24 `npm test`, and `git diff --check` passed. The full suite rebuilt Host,
  client and viewer artifacts and passed signed-extension payload parity and
  stale-payload rejection with the existing external identity. This is local
  verification only; no model-quality measurement or remote CI claim.

### Gold Repair Structural Gate (2026-09-27; isolated, not deployed)

- An adversarial test showed the evaluator accepted an invented repair action
  as approved gold; it also accepted an update targeting a missing node, an
  unknown type, and a no-op text edit. These would make an unusable model
  proposal appear successful by exact-match scoring.
- The gold loader now admits only the product's known repair actions and
  checks structural applicability: node identity and effective patch, source
  anchors, ontology types and Learning View coordinates, relation endpoints
  and type constraints. A type edit from `feature_description` to `rule`
  would retain incompatible coordinates and is rejected, as is a fabricated
  replacement quote. A `feature_description` to `feature` edit has the same
  declared coordinates and **cannot** be ruled out structurally; its safety
  remains a semantic gold judgment. This conservative **fixture integrity**
  gate does not prove an approved patch will safely persist under concurrent
  revisions.
- The pre-fix negative control failed on an unsupported repair action. After
  the gate and adversarial tests were added, `npm run test:kg-qa-benchmark`,
  full Node 24 `npm test`, and `git diff --check` passed. The full suite
  rebuilt generated artifacts and passed extension payload parity and
  stale-payload rejection. This is isolated local verification; no production
  service restart, commit, push, paid model call or graph mutation occurred.

### Persisted Repair Replay (2026-09-27; isolated, not deployed)

- A new temporary-SQLite test replays every approved `update_node` gold fix
  through the persistent Host's actual `graph-commit-preview`, `graph-commit`
  and `document-export` routes. It asserts read-only preview, exact semantic
  node changes, unchanged relations and source text, a source-backed citation
  after persistence, and a stale-revision rejection.
- The first run found a fixture defect: the Chinese source snippet had a
  semicolon and topic transition that the Host split into separate source
  units. Its whole-line quote passed the fixture's substring check but became
  `groundingStatus: unsupported` with empty evidence after the actual commit.
  The invented snippet was rewritten as one atomic Chinese sentence preserving
  both the adult condition and child-efficacy limit. All five approved node
  repairs now persist with grounded evidence. The frozen dataset hash and
  controlled run hashes were updated accordingly.
- This verifies only those five **synthetic** node edits on isolated canonical
  documents. It does not prove semantic correctness of other proposed fixes,
  relation edits, undo paths or concurrent real-user edits. No paid model or
  production graph was used.
- The new replay is part of `npm run test:kg-qa-benchmark`. Both that target
  and the full Node 24 `npm test` passed, as did `git diff --check`. The full
  suite rebuilt generated artifacts and passed extension payload parity and
  stale-payload rejection using the existing external identity. The initial
  failing replay was retained as diagnosis, not counted as a passing run.

### Relation Causality Contrast (2026-09-27; isolated, not deployed)

- A negative coverage control failed while the ten-case benchmark had no
  approved relation edit. Two invented Chinese cases now contrast an explicit
  “directly caused” sentence, whose `supports` edge can be repaired to
  `causes`, with an association explicitly lacking causal proof, for which
  the same upgrade is unsafe. The Codex evidence decisions are recorded in
  `docs/kg-review-benchmark-codex-review-2026-09-27.md`; they are not
  independent human labels.
- The temporary persistent-Host replay now exercises five approved node
  updates and one approved relation update. The edge keeps a source-backed
  citation after commit, while the source text and nodes remain unchanged;
  preview remains read-only and stale revision is rejected. The controlled
  regressed fixture counts a causality upgrade on mere correlation as an
  unsafe proposed repair.
- The frozen twelve-case gold fingerprint is
  `2c47eb753e3e431819ca80ef793290cb7024231e548b2b9ba3d2097ab9a3fb7d`.
  Both supplied run files use that fingerprint and still contain invented
  outcomes and usage. This does not establish performance on real materials
  or prove all relation types/edits safe.
- `npm run test:kg-qa-benchmark`, full Node 24 `npm test`, and
  `git diff --check` passed after the relation cases and replay were added.
  The full suite rebuilt generated artifacts and passed extension payload
  parity and stale-payload rejection. These are local results only; no
  production service or graph was changed.

## Local Main Deployment (2026-09-27)

- The user authorized merging and deploying the current work. Items 3-6 and
  the offline item 7 evaluator were committed on the isolated branch as
  `dc4a44d3b701f58a93fc49d487b8ca7bea1120e7`. The complete Node 24
  `npm test` passed on that exact commit before the merge; see
  `output/premerge-20260927.log` in the isolated checkout. The production
  checkout fast-forwarded from `39812f2` through the existing item 1 and 2
  commits to `dc4a44d`. There were no merge conflicts. `origin/main` was an
  ancestor of the old local `main`; no remote push was requested or performed.
- Authenticated `task-active` returned `busy: false` immediately before the
  controlled stop. A consistent online SQLite backup was saved outside the
  repository at `/mnt/d/github/.dsh-kgsrc-before-workbench-20260927.sqlite`
  (6,579,458,048 bytes); its `PRAGMA quick_check` returned `ok`. The service
  was stopped, local `main` fast-forwarded, and the service started with the
  existing Node 24 safe-runtime configuration. The new user-service main PID
  was 3009927, started at 2026-09-27 18:24:38 Asia/Shanghai.
- After startup, authenticated ontology and document-list endpoints returned
  HTTP 200, and `task-active` remained idle. Read-only requests to the new
  perspectives, concept-dossier, learning-attempts, reading-map and learning
  plan endpoints returned HTTP 200 without errors. The existing document's
  reading map reported revision 249 and the plan returned three tasks. The
  web boot manifest's knowledge-graph asset contained the exact generated
  `lib/client.js` module, including all four new feature markers. Packaging
  validation still passed payload parity and stale-payload rejection.
- Hashes of every row in nine legacy data tables, including `documents`,
  `document_units`, `graph_nodes`, `graph_edges` and
  `verification_batch_results`, matched the pre-deploy backup. Their counts
  remained one document, 5,413 source units, 4,645 nodes, 8,539 edges and
  974 saved batch results; `graph_revisions` still had 249 rows. Four new
  sidecar tables were created for dossiers, perspectives and learning
  attempts; no user graph or review was edited by the deployment check.
- The first authenticated `document-list` request during cold startup timed
  out after 10 seconds, while a later request returned HTTP 200 in under a
  second. This is recorded as a cold-start observation, not proof of a steady
  performance regression. Item 7 still lacks independent human labels and
  measured model runs. No paid model call, task start, cancellation or
  automatic review continuation was part of deployment verification.

### Live Model Comparison Preparation (2026-09-27; isolated, not deployed)

- The user authorized paid model use without a token cap. This did not change
  the prohibition on reading production graph data, configuration or
  credentials. The 3119 isolated profile was idle and listed
  `deepseek-official/deepseek-flash` and `deepseek-v4-pro`.
- Its first frozen case was admitted as task `kg-mujx8j4e-1`, then failed with
  `MISSING_CREDENTIAL`: the profile has no DeepSeek API key. The Host recorded
  three finished attempts but zero reported model requests or token counts.
  No model result or quality metric was produced; the service returned idle.
  An isolated credential or another independently configured route is needed.
- Tracing the request path exposed a benchmark mismatch: the Host rejects
  scoped source units for a whole-graph allegation, while the initial capture
  builder sent them. The shared request builder now submits the complete
  frozen source unscoped for that case and preserves scoped units for the
  others; an adversarial test checks that both source paragraphs survive.
- Added a sequential live-capture runner. It records task IDs before polling,
  resumes pending tasks without duplicate admission, retains failures and
  requires an explicit `--retry-failed`. A controlled HTTP server test proved
  failed requests are not silently retried and a pending task is resumed even
  while the service reports busy. Focused benchmark tests, full Node 24
  `npm test`, and `git diff --check` passed. The full suite rebuilt generated
  artifacts and passed signed-extension payload parity and stale-payload
  rejection with the existing external identity. The twelve
  labels remain Codex-reviewed synthetic cases, not independent human truth
  or representative book accuracy.
- The user then selected 3099's already configured CommandCode instead of
  adding a key to 3119. A read-only `task-active` check found an ongoing user
  deep-review task (192/857 batches at that instant), with two model requests
  active. No synthetic request was sent to 3099: the existing task must not
  be interrupted or contended with. A read-only model catalogue confirmed
  `commandcode/deepseek/deepseek-v4.1-flash` is available there. The live
  comparison remains pending until the production service is genuinely idle
  and a synthetic-only, nonpersistent invocation path is verified. No
  production graph, report, configuration or credential was read or changed.
- Read-only code tracing confirmed `question-graph` uses the supplied graph
  snapshot and stores its answer only in the in-memory task map; it does not
  enter the document commit or verification checkpoint path. A temporary
  3099-specific test gate refused admission while the user task was busy.
  The user then clarified that the intent was **not** to run a test task on
  3099. That temporary exception was removed; the runner again rejects
  3099 and 3109. This avoided touching the production task, graph or report.

### Isolated CommandCode Model Runs (2026-09-27; not deployed)

- With the user's explicit clarification, 3119's temporary `kg-entry`
  profile received only the `commandcode` provider route from 3099's plugin
  configuration and the `COMMANDCODE_API_KEY` reference from its credential
  store. The production profile and credential file were not changed. The
  isolated credential file and route patch are mode 0600, outside the repo;
  only the CommandCode reference was added, leaving the existing isolated
  browser-session record intact. 3119 was confirmed idle, stopped and
  restarted. Its model catalogue then listed CommandCode V4.1 Flash and V4
  Pro. 3099's user deep-review task continued independently.
- A one-case pilot on 3119 succeeded and reported complete request/token
  accounting. Then the same capture was resumed to 12/12 cases, followed by
  12/12 on V4 Pro. Raw task IDs, exact submitted synthetic requests, final
  statuses and capture times are retained in ignored `output/`, with
  normalized run files and an inspectable Markdown comparison. The dataset
  hash is `2c47eb753e3e431819ca80ef793290cb7024231e548b2b9ba3d2097ab9a3fb7d`;
  both run files have prompt-build fingerprint
  `host-issue-review-c4414412e7298740` and complete reported token counts.
- On the 11 binary-labelled synthetic allegations, both models yielded
  7 true positives, 4 true negatives, no false positives or false negatives;
  the twelfth gold case is uncertain. Flash reported 11,331 input and 13,885
  output tokens across 98.083 seconds of summed case time; Pro reported
  12,005 input and 17,784 output tokens across 254.391 seconds. This is
  **not** independent human validation or representative book accuracy, and
  the latency comparison is not controlled for concurrent external load.
  No price or currency cost was inferred.
- Both models proposed an unmatched repair for `unsafe-existing-merge`:
  rewriting one node to combine meanings from two paragraphs while its quote
  remains anchored to only one. Pro also confirmed the causal-edge issue but
  proposed no repair, missing one approved opportunity. These proposals must
  not be auto-applied. Next: replay **model-proposed**, not just gold-approved,
  edits in an isolated persistent graph and inspect grounding/constraint
  outcomes; continue building representative samples before quality claims.
- After restoring the hard 3099/3109 runner guard, the focused benchmark
  target, full Node 24 `npm test`, packaging parity/stale-payload checks, and
  `git diff --check` passed locally. The production service was not restarted
  or changed; the isolated 3119 process remains available for further work.

### Model-Proposed Repair Replay (2026-09-27; isolated, not deployed)

- Replayed the saved **Flash** proposals, not the gold repairs, through the
  real Host preview and commit against disposable SQLite documents. All seven
  proposed edits passed structural preview and persisted. The causal relation
  repair survived with its cited source. The `unsafe-existing-merge` text also
  persisted even though it combines P1 and P2 while retaining only the P1
  quote. This demonstrates that quote authentication and graph invariants do
  not prove a text paraphrase is entailed; generic canonical commits must
  still permit deliberate human edits, so structural success is not AI repair
  approval. The replay command accepts the frozen Flash run as an optional
  argument to `scripts/kg-review-benchmark-persistence-smoke.mjs` and never
  accesses production data.
- An adversarial batch-planner test reproduced the same unsafe proposal being
  marked safe for group confirmation. The batch gate now permits automatic
  text replacement only when its full text is extractive from the node's
  retained, source-backed quote (or a new quote matched by review evidence).
  Non-extractive AI paraphrases remain visible but require single-item
  confirmation; type, relation and destructive edits already did so. This
  deliberately trades some bulk convenience for an auditable deterministic
  boundary, without claiming that extractive text proves every graph claim.
  The UI count and sequential plan use the same gate.
- The user specified that future CommandCode testing uses **DeepSeek V4.1
  Flash only**. The live-capture runner now rejects any other CommandCode
  model before contacting a service; historical Pro results remain read-only
  comparison data. The runner still refuses 3099 and 3109.
- Red test: the unsafe model text was initially accepted by `batchSafeFix`.
  Focused UI and benchmark tests then passed after the guard. The first full
  Node 24 `npm test` reached packaging and failed on a stale signed viewer
  payload after the source rebuild. Repacking with the existing external
  signing identity restored payload parity without changing identity or
  relaxing the gate. The subsequent complete `npm test` passed (exit 0),
  including signed payload parity and stale-payload rejection; `git diff
  --check` passed. No code was committed or deployed, and 3099's user review
  remained untouched.
- Remaining: broaden Codex-reviewed Chinese/learning-view cases without
  treating them as independent human truth; test realistic compound repairs
  and whole-graph discovery separately before making book-level quality
  claims. Confirm the isolated browser's batch preview on a controlled
  document before considering this fix release-ready.

### Isolated Browser Batch Review (2026-09-28; not deployed)

- Restarted only the idle 3119 isolated profile after rebuilding client and
  viewer assets; 3099's active user review was neither queried for data nor
  changed. A disposable 2-node, 3-paragraph synthetic document with two
  report issues was inserted into the isolated SQLite store. The real browser
  opened it through History. Only CommandCode DeepSeek V4.1 Flash was selected
  for two one-item group reviews.
- The unsafe cross-paragraph allegation was confirmed, but its non-extractive
  text proposal appeared as **needs individual handling**. The read-only
  preview showed zero graph repairs, one manual item, and no node/edge diff.
  After confirmation, canonical revision advanced 1 to 2 to store the review
  outcome, while the node text and open issue status stayed unchanged.
- The browser exposed another real defect: this report-only save still set
  `verification.stale=true` and displayed "graph changed" although no graph
  semantics had changed. A failing regression test was added before the fix.
  The bulk commit now carries forward prior staleness and marks a report stale
  only if `planBulkReviewedFixes` actually changes the graph. A second fresh
  browser fixture confirmed revision 1 to 2, `stale=false`, unchanged node
  text and open issue, with no false "graph changed" message.
- On the second fixture, the independent negation issue was confirmed with an
  extractive text repair. The per-item detail showed "can bulk repair" and the
  corrected text, after a separate failing test caught two missing `graph`
  arguments in that display path. Preview showed exactly one node text diff;
  confirmation advanced revision 2 to 3, fixed only that node, marked only
  that issue applied, and correctly set `stale=true`. Reopening after a page
  reload retained the unresolved merge issue and applied repair. Source quote
  and user data were not changed. Screenshot:
  `output/playwright/bulk-review-after-safe-fix-20260928.png`.
- `npm run test:kg-verification`, `npm run test:kg-qa-benchmark`, the complete
  Node 24 `npm test`, signed extension parity/stale-payload checks and
  `git diff --check` passed after the final browser-driven fixes. The isolated
  3119 service remains running; no new code was committed, pushed or deployed
  to 3099. Remaining quality work is representative Chinese/learning-view
  sampling, compound repair adjudication and a separate whole-graph discovery
  benchmark, not another rerun of these two synthetic cases.

### Compound Repair Grounding (2026-09-28; isolated branch only)

- Traced the batch auto-save path from `batchReviewCounts` through
  `planBulkReviewedFixes`. The prior extractive-text guard had a quote-only
  exception: a model could replace a node's quote with an exact, source-backed
  excerpt while leaving the node's existing, unsupported text unchanged. The
  old gate classified that as safe merely because `patch.text` was absent.
- Added an adversarial quote-only proposal with a valid evidence quote but
  unrelated retained node text. The red UI smoke test proved the gate returned
  safe and would count the proposal as an automatic repair. The gate now checks
  the **resulting** node text against the retained quote regardless of which
  fields the proposal changes. A valid quote-only reanchor whose full node
  text is actually contained in the new evidence remains eligible. This is a
  conservative auto-save boundary, not a claim that substring matching proves
  semantic entailment; other paraphrases continue to require individual
  confirmation.
- Focused UI smoke and the complete Node 24 `npm test` passed after rebuilding
  source-generated artifacts and repacking the extension with the existing
  external signing identity. Signed payload parity and stale-payload rejection
  passed. No production task, graph, report or service was touched; 3119 still
  runs the prior preview bundle, while these new changes remain uncommitted on
  the isolated branch. Next work: representative source-backed Chinese cases
  and a distinct whole-graph discovery benchmark.

### Additional Chinese Evidence Pass (2026-09-28; isolated only)

- Froze a separate five-case invented Chinese suite before calling the model,
  so the earlier twelve-case gold hash and raw Flash/Pro history remain intact.
  It covers a necessary-but-insufficient Learning View feature, a genuinely new
  verification example falsely called recycled, a cross-paragraph causality
  confound, an attributed author claim falsely judged by real-world efficacy,
  and a material type that cannot be decided from an incomplete classroom
  record. Each case has a same-thread Codex evidence rationale, source units,
  anchored graph and approved/no-fix decision. This is **AI-reviewed synthetic
  data**, not independent human truth or a sample from the user's book.
- Only CommandCode DeepSeek V4.1 Flash was called, sequentially on idle 3119.
  Its five verdicts were confirmed, false positive, confirmed, false positive,
  false positive. The four binary labels matched the frozen Codex pass; the
  fifth gold was uncertain, while Flash rejected the specific proposed type
  edit without changing the graph. Reported total: 4,856 input tokens, 5,583
  output tokens, 39,177 ms summed case latency (not wall-clock or controlled
  performance), with complete usage for all five. Raw task/status evidence,
  normalized run and report remain under ignored `output/zh-learning-flash-20260928.*`.
- One confirmed causality issue exposed a repair failure: Flash combined P0's
  observed co-occurrence with P2's confound into one node text while retaining
  only P0 as the node's quote. The new report distinguishes this unapproved
  confirmed-case fix from a repair proposed for a false allegation; the
  aggregate `unapprovedRepairProposals` is 1, not a misleading total of zero.
  The model's proposal was checked against the batch gate and correctly
  required individual handling. No model proposal was written to a graph.
- The isolated persistent Host preview and commit verified both newly approved
  repairs (a Learning View type correction and a P0-extractive text correction)
  in a temporary SQLite database. That verifies structural persistence and
  citation retention, not semantic safety of all future repairs. The remaining
  quality gap is a separate whole-graph **discovery** benchmark and more
  representative, authorized source material. No production state changed.

### Whole-Graph Discovery Boundary (2026-09-28; evaluator only)

- Added a separate discovery evaluator rather than reusing the targeted
  issue-review confusion matrix. Gold now freezes a complete graph/source
  snapshot, revision and positive findings. A captured ordinary full-graph
  verification must show successful **complete** node, edge and source-unit
  coverage at that revision; partial runs cannot be scored as no findings.
- Every AI issue in the finished report needs a report-hash-bound Codex/human
  decision (`match`, `false_alarm` or `uncertain`). Local deterministic issues
  cannot be credited as model discoveries. Multiple candidates matched to one
  finding count as one discovery plus duplicates, and an empty complete report
  counts all known findings as misses. Fabricated source quotes, target
  mismatches and missing adjudications are rejected by adversarial tests.
- A controlled real Host full-verification run against a temporary SQLite graph
  containing one invented claim emitted no AI issues. The new evaluator
  correctly scored one missed finding after verifying complete coverage, not
  perfect recall. `npm run test:kg-qa-benchmark` and the focused full-verification
  smoke passed. The evaluator is **not yet an actual Flash discovery result**:
  it still needs a frozen representative discovery fixture, isolated capture
  runner and post-run adjudication. Details: `docs/kg-discovery-benchmark.md`.

### Isolated Whole-Graph Flash Discovery (2026-09-28; not deployed)

- Source segmentation exposed a benchmark validity defect before model use:
  a Chinese semicolon split the initial supposed paragraph, shifting all
  subsequent anchors. The first seed remained in isolated SQLite only and
  received no model call. A new v2 document/gold was frozen with four actual
  Host units. The seed now compares all supplied units to the real Host
  splitter and refuses a mismatch before writing the database. An adversarial
  smoke test demonstrates the rejection and zero database writes.
- Added a 3119-only live capture runner pinned to CommandCode DeepSeek V4.1
  Flash. It checks idle state, model availability, exact graph/source/revision
  readback and the full-coverage plan; a pending admission is recorded so a
  crash cannot silently resubmit the paid task. The run completed at revision
  1 with 5/5 nodes, 1/1 edge, 4/4 source units.
- The actual Host report exposed a second evaluator contract error: graph-wide
  AI findings carry `targetId=null`, whereas the synthetic smoke had used the
  string `graph`. A failing test preceded normalization of this one graph
  target identity. The original report was scored without another model call.
- Same-thread Codex adjudication found 3 matches to the three frozen defects,
  one false alarm, one uncertain extra candidate, and 6 excluded local-rule
  issues. The observed 3/3 discovery recall and 3/4 determinate-candidate
  precision apply **only to this invented five-node graph**, not the user's
  book or independent human truth. Host-reported usage: 2 requests, 2,553
  input plus 11,149 output tokens. No patch was applied to any graph. Raw
  capture, decisions and report are under ignored `output/`; gold and tests
  are in `scripts/fixtures/` and `scripts/`.
- The adversarial seed/snapshot tests, `npm run test:kg-qa-benchmark`, the full
  Node 24 `npm test` (including signed extension payload parity and stale
  payload rejection), and `git diff --check` passed after the evaluator fix.
  3119 returned to idle; 3099's separate user task remained busy and untouched.
- Next: add multiple distinct source-backed discovery graphs, then evaluate
  whether detected defects yield safe, persistent repairs. Do not infer a
  general false-negative rate or cost advantage from this single run.

### Second Frozen Discovery Graph (2026-09-28; isolated only)

- Froze an independent five-unit synthetic graph before model use, testing
  homonymous but distinct concepts and a distant limitation on a trial claim.
  Gold has two Codex-reviewed findings. The seed smoke now also proves that
  an incorrectly attached node/edge evidence quote is rejected before any
  SQLite write; the real Host splitter and all graph anchors matched.
- On idle 3119, CommandCode DeepSeek V4.1 Flash completed all 5 nodes, 1 edge
  and 5 source units. It found both frozen findings. Two other AI issues were
  adjudicated separately: one false alarm about a faithful fact and one
  uncertain proposal for an additional caveat node; 6 local issues were
  excluded. The 2/2 discovery recall and 2/3 determinate-candidate precision
  are specific to this invented graph and same-thread Codex labels.
- Host usage was 2 requests, 1,810 ordinary input plus 896 cache-read input
  tokens and 20,992 output tokens, 23,698 reported total. The raw capture,
  adjudication and report are retained under ignored `output/`; no patch was
  applied to the reviewed graph. A separate temporary-Host replay and
  source/ontology check is recorded below. Two small synthetic graphs
  are not enough for a real-book quality or economic claim.
- After adding the second fixture and the wrong-anchor red/green regression,
  the complete Node 24 `npm test` passed, including generated artifact parity,
  signed extension payload parity and stale-payload rejection. The test's
  synthetic fault logs and npm/experimental SQLite warnings were not treated
  as production errors or suppressed.

### V3 Relation Repair Replay (2026-09-28; temporary SQLite only)

- The frozen Flash report's `is_a` to `not_is` proposal was replayed through
  the real persistent Host preview and commit routes in a new temporary SQLite
  database, without writing the 3119 fixture or any production data. A
  controlled no-model variant is registered in `test:kg-qa-benchmark`.
- Adversarial previews rejected a citation from a different source unit and
  an unregistered relation type. The valid proposal preview made no write;
  its commit advanced revision 1 to 2 and changed only the intended edge's
  relation semantics and source-backed evidence. Node text/types/citations
  and source text stayed unchanged. Other nodes' `entailmentStatus` remained
  `unverified` despite structural citation reauthentication. Old-revision
  preview and commit were both rejected. This proves this specific repair's
  structural persistence, not that all model-proposed relation fixes are safe.
- Both the controlled and actual saved-Flash-proposal replay passed. The full
  Node 24 `npm test` then passed with the new replay in the standard benchmark
  suite, including signed extension parity and stale-payload rejection. No
  model was called for this replay; no service was restarted or deployed.
- Next: distinguish source-grounded semantic repair from merely structurally
  valid commits across more relation types and longer evidence paths. Build
  additional frozen discovery graphs only when they cover a new failure mode;
  do not inflate the synthetic sample count for its own sake.

### Discovery Repair Verdicts (2026-09-28; isolated only)

- Found a benchmark blind spot: full-graph discovery metrics did not account
  for model-proposed edits, so a correctly found issue could carry an unsafe
  fix, and a false alarm could carry an unnecessary edit, without either
  appearing in the score. An adversarial test first failed because the repair
  metrics were absent.
- Adjudication schema 2 now requires an independent, report-hash-bound review
  of every AI candidate's proposed fix, including an explicit no-proposal
  decision. It distinguishes source-supported, unnecessary, source-unsafe
  and uncertain proposals. Missing labels, disguising a proposal as absent,
  and approving a false-alarm correction are rejected. A changed model patch
  invalidates the old report hash. This review does not auto-apply patches.
- Re-reviewed the saved v2 and v3 Flash reports without another model call.
  Each had three proposals: one source-supported, one unnecessary correction
  for a false allegation, and one uncertain. The v3 source-supported edge fix
  also has the independent persistent-Host proof above; the v2 source-backed
  add-node proposal does not yet have persistence proof. Zero adjudicated
  source-unsafe proposals in these two small graphs is **not** a general
  safety rate. Labels remain same-thread Codex review, not independent human
  truth.
- `npm run test:kg-qa-benchmark` passed, including the new adversarial
  assertions. The first full `npm test` exposed a schema-1 adjudication in
  the real-Host zero-discovery smoke; that caller was migrated to schema 2,
  then a fresh complete Node 24 `npm test` passed, including signed extension
  payload parity and stale-payload rejection. `git diff --check` passed.
  Both existing raw captures scored under schema 2 with unchanged
  frozen gold and report hashes. No production, 3119 graph, model endpoint,
  or service was changed. Next useful step: a distinct frozen scenario where
  a structurally accepted patch changes the meaning beyond its source, then
  verify the semantic gate and persistent preview independently.

### Relation Semantics Versus Structural Admission (2026-09-28; isolated only)

- In a new adversarial **repair** replay, the corrected v3 `not_is` edge was
  offered back as `is_a` with the exact same source quote saying the two
  concepts are not the same. Real persistent-Host preview returned valid:
  existence of a quote, legal relation/type and current revision do not prove
  the relation's meaning. The false reversal was never committed; the graph
  stayed at revision 2. This tests a distinct repair-safety failure mode,
  without rerunning Flash or adding another synthetic discovery score.
- Before the fix, the single-review UI regression failed because relation
  proposals lacked an explicit semantic warning. `add_edge` and `update_edge`
  now warn that relation direction and meaning remain unverified, and require
  a second confirmation click. Both the issue card and AI review result show
  the warning. This does not substitute for human judgement or independent
  semantic verification.
- Controlled and saved-Flash persistence replays, focused UI smoke, full Node
  24 `npm test`, signed extension parity and `git diff --check` passed. WSL
  Playwright lacked Chrome and desktop CUA failed to initialize; instead, a
  temporary Windows Playwright-core installation used the already-installed
  Chrome against the `--relation-semantic` fixture on a random local port.
  The real browser found the warning on both the issue card and controlled
  AI-review result. On each path the first repair click made zero commits and
  left revision 1; a second confirmation control appeared. Only the explicit
  second click in the issue-card path changed the fixture to revision 2, and
  its temporary SQLite was removed on teardown. Desktop 1440 px and mobile
  390 px warning/button bounds did not overlap; the document had no horizontal
  overflow. Inspected screenshots are retained in ignored
  `output/playwright/relation-semantic-*.png`. No 3119/production service was
  restarted, no persistent user graph changed, and no code was committed.
  Next: use a genuinely different source shape for discovery coverage rather
  than repeating this structural-versus-semantic relation replay.

### Table-Header Discovery Case (2026-09-28; isolated only)

- Froze a third synthetic full-graph discovery case with a Markdown table,
  not another prose paraphrase. The Host splits the header and two subgroup
  rows into separate source units. One Codex-reviewed positive finding targets
  n1's false claim that strategy A outperforms B in both groups: 8/10 > 7/10
  in one row, but 1/10 < 3/10 in the other. Two faithful row-specific nodes
  are negative controls. The seed regression rejects a wrong-row citation
  before SQLite writes and a swapped header against frozen evidence.
- After freezing the revision-1 Host export, idle 3119 ran only CommandCode
  DeepSeek V4.1 Flash. It completed 3/3 nodes, 0/0 relations and 6/6 source
  units; the one frozen defect was found. An additional proposal to create a
  same-week-limitation node remains uncertain rather than being counted as a
  false alarm or a second frozen hit. Six local rules were excluded. Two
  requests used 1,301 ordinary input, 896 cache-read input and 5,915 output
  tokens (8,112 reported total). The raw report, Codex decisions and score
  are retained under ignored `output/discovery-zh-flash-v4-20260928.*`.
- The model's proposed n1 correction is source-backed, but would duplicate
  the existing n2. Neither that proposal nor the uncertain limitation node
  was applied. Source-grounded wording is not sufficient graph-edit approval.
  This is same-thread AI adjudication on an invented table, not a real-book
  quality estimate. Next: inspect duplicate-result handling and preview in
  an independent temporary Host before deciding whether the edit gate needs
  a change. New source, fixture and regression remain uncommitted; no 3099 or
  3119 restart occurred.
- The new table-anchor smoke and a fresh complete Node 24 `npm test` passed,
  including signed extension payload parity and stale-payload rejection;
  `git diff --check` passed. Existing npm configuration and experimental
  SQLite warnings were not suppressed. No new extension signature was made.

### Same-Excerpt Repair Safety (2026-09-28; isolated only)

- The saved v4 Flash update and a controlled equivalent passed the real
  persistent Host's structural preview in independent temporary SQLite while
  making n1 share n2's exact paragraph/quote. Neither replay committed a
  duplicate, proving that citation validity is not semantic distinctness.
- The client now identifies other nodes in the current graph window that
  would use the exact proposed paragraph and quote. It presents them as
  possible duplicates, not a proven merge, and requires a second confirmation
  scoped to the exact issue. The v4 paraphrase remains ineligible for an
  automatic bulk text fix. A red UI regression reproduced the prior absence
  of peer context; source/window/unchanged-text negative controls pass now.
- Windows Chrome with temporary Playwright-core against a random-port,
  temporary-SQLite fixture showed the warning at 1440 and 390 px with no
  horizontal overflow or overlap. On mobile, first click caused zero commits
  and kept revision 1; only a deliberate second click changed the fixture to
  revision 2. The fixture process was closed. This warns about visible-window
  peers only; it does not prove no off-window duplicate or semantic identity.
  No production or 3119 service was restarted and no user graph was edited.
- A packaging run caught a stale signed viewer after the client change; an
  overlapping test also observed an in-flight UI assertion edit. Neither was
  treated as a pass. With edits finished, source/lib/viewer were rebuilt and
  the extension was re-signed using the existing external identity. A fresh
  complete Node 24 `npm test` exited 0, including signed payload parity and
  stale-payload rejection, and `git diff --check` passed. No new identity,
  production restart, commit or push was performed.

### Full-Canonical Peer Preflight (2026-09-28; isolated only)

- The initial same-excerpt warning was window-local. A new 803-node adversarial
  fixture puts the repair target on page 1 and an exact source peer outside
  its 800-node window. The old helper returns no peer for the visible page;
  its full-graph result includes the hidden peer. A new test failed before the
  full-canonical check existed.
- Added a read-only, revision-fenced Host query that inspects the complete
  canonical graph and returns bounded peer IDs without exporting thousands of
  nodes to the browser. Both RPC implementations and the persistent client
  transport were wired. On a text repair, query failure or a navigation race
  stops submission; a peer displays its ID and requires an issue-scoped second
  click. Commit CAS remains authoritative if another edit occurs afterward.
  This is only a duplicate-risk prompt, not AI or human semantic approval.
- Real temporary SQLite/Host tests cover the table peer, stale revision,
  unchanged text and different-row evidence. In Windows Chrome on a random
  port, the off-window fixture had no local warning before click; one click
  revealed `zz-peer` with zero commits and unchanged revision 1. An explicit
  second click on mobile 390 px changed only that disposable fixture to
  revision 2, one commit and handled issue. No browser errors or horizontal
  overflow were observed. Fixture process stopped; 3099/3119 and their graphs
  were untouched. The first browser attempt exposed an unwired persistent
  client RPC method; it was fixed before the passing check.
- Source/lib/viewer rebuilt, extension re-signed with the existing external
  identity. After correcting a negative-control expectation to follow the
  proposed row's actual peer, the focused smoke and a fresh complete Node 24
  `npm test` passed, including signed payload parity and stale-payload
  rejection. A later browser pass injected HTTP 503 into the peer preflight:
  the UI showed an error, with no confirmation or commit. Holding the response
  while switching to page 2 of the same 803-node document, then releasing it,
  likewise made no commit and did not offer stale confirmation. Both cases
  retained revision 1 and had no page errors. Only docs changed after the
  complete test run. The fixture process was stopped. No new code has been
  committed or deployed. Next: resume distinct-source discovery cases only
  if they add a real quality boundary.

### Hypothetical-Status Discovery (2026-09-28; isolated only)

- Added a distinct frozen full-graph source shape: a Chinese classroom
  dialogue with an unimplemented answer-first proposal, an explicitly
  unmeasured teacher guess and a separately observed answer-after-work group.
  The Codex-reviewed positive finding is n1's conversion of that guess into
  an observed effect; n2/n3 are faithful negative controls. The actual Host
  split has four units, and a changed `没有实施` assertion is rejected before
  SQLite seeding. The frozen revision-1 graph has three nodes and no edges.
- On idle isolated 3119, CommandCode DeepSeek V4.1 Flash completed 3/3 nodes
  and 4/4 source units in two requests. The frozen n1 defect was found. A
  separate caveat-node suggestion remains uncertain, not a fabricated second
  gold hit. Seven local issues were excluded. The Host reported 2,231 input
  and 3,929 output tokens. Raw capture, Codex same-thread decisions and
  evaluation are retained in ignored `output/discovery-zh-flash-v5-20260928.*`.
  The suggested n1 rewrite is source-supported but has not been previewed or
  persisted; no patch was applied. These synthetic results cannot estimate
  real-book quality or independent human agreement.
- Adversarial seed smoke and a fresh complete Node 24 `npm test` passed,
  including signed extension payload parity and stale-payload rejection.
  The first full-test attempt used Windows npm through the WSL PATH and failed
  before building; the corrected Linux Node 24 PATH run passed. No code was
  committed, pushed or deployed, and neither 3119 nor 3099 was restarted.
  Next useful check: replay the exact v5 proposed rewrite against an
  independent temporary persistent Host, separating source support from
  preview, transaction and conflict safety. Avoid another call on this graph.

### Dialogue Repair And Semantic Boundary (2026-09-28; isolated only)

- Replayed the exact saved v5 Flash n1 proposal and a controlled equivalent
  through the actual persistent Host in disposable SQLite. Wrong-unit citation
  failed preview; the source-backed conditional rewrite previewed read-only,
  then persisted only n1 at revision 2. Faithful n2/n3 semantics and source
  text were unchanged; citation authentication did not upgrade semantic
  entailment status. Stale preview and write both failed. The 3119 graph was
  not edited.
- A stronger false text without `可能` was rejected by the existing
  semantic-strength invariant, but a subtler false text retaining `可能` and
  extrapolating to all students passed structural preview. The latter was
  never committed. This demonstrates why exact source anchoring and the
  deterministic qualifier check are not complete semantic approval.
- The single-item UI now warns on changed node text and requires a second
  issue-scoped confirmation after a successful full-canonical source-peer
  check. Bulk text repair remains governed by its existing strict quote
  rule. A red UI smoke first exposed the one-click path. A real Windows
  Chrome pass on a random-port temporary fixture verified warning visibility
  in both the issue card and controlled AI-review result, zero writes on
  both first clicks, and one deliberate mobile second-click write to only
  that disposable graph. 1440/390 px layouts had no horizontal overflow or
  browser errors; screenshot under ignored `output/playwright/`.
- Built source/lib/viewer, re-signed with the existing external identity,
  and passed a fresh complete Node 24 `npm test` including signed payload
  parity and stale-payload rejection. `git diff --check` remains required
  after this documentation edit. All changes remain uncommitted and
  undeployed. Next: assess whether the new warning still reads clearly when
  a text proposal changes only part of a long claim; do not repeat this
  fixture's model call or conflate confirmation with semantic proof.

### Benchmark Capture Durability (2026-09-28; isolated only)

- Reproduced an interruption bug in both benchmark runners: a stale
  `raw.json.pending` made a valid capture's next save fail with `EEXIST`.
  The targeted runner also had a request-admission gap: it could POST a paid
  model call before persisting any pending-task record. The controlled test
  failed on that missing pre-admission record before the fix.
- Both runners now use a shared unique-temp, mode-0600, fsynced atomic
  writer. The targeted runner persists `admitting` before POST, then the
  admitted task ID. A capture with no task ID refuses automatic re-admission;
  a known-ID pending capture still polls. A preserved orphan cannot block a
  new save, and the test server observed the pending record before handling
  the request. This protects against silent duplicate calls but cannot
  automatically recover a task ID lost during an ambiguous admission.
- Focused targeted/discovery smoke and fresh complete Node 24 `npm test`
  passed, including signed extension payload parity and stale-payload
  rejection. No paid model request, production graph access, 3099/3119
  restart, commit or push occurred. The follow-up is to design an explicit,
  operator-reviewed adoption path for an ambiguous task only if the isolated
  Host exposes enough identity to prove it is the same request; never guess
  from a busy flag or automatically submit a second call.

### Benchmark Capture Concurrency (2026-09-28; isolated only)

- A controlled two-process HTTP test reproduced a distinct race: both targeted
  runners read the same empty output and idle task state, then each admitted
  the same paid case. The old atomic writer prevented partial JSON but not
  duplicate admissions or lost read/modify/write updates (observed 2 calls).
- Both targeted and discovery runners now acquire a private exclusive lock for
  the output before reading it or querying the service. In the same test one
  runner completed, the other failed before admission, and only 1 call was
  observed. The discovery smoke checked exclusivity, 0600 lock mode and normal
  release. Crash locks are intentionally not auto-deleted: an operator must
  inspect the recorded PID and pending task before removing one. Different
  output paths still depend on the Host's task admission fence.
- Targeted and discovery smoke, fresh complete Node 24 `npm test`, signed
  payload parity and stale-payload rejection passed. No real model request,
  production data access, service restart, commit or push occurred. Remaining
  evaluation limits are unchanged: synthetic graphs and same-thread Codex
  labels cannot establish real-book accuracy or independent human truth.

### Discovery Attribution Case (2026-09-28; isolated only)

- Froze a distinct synthetic interview graph before model use: teacher Lin's
  quoted opinion, an explicit editorial rejection, and a trial-specific
  recommendation. n1 falsely assigns Lin's opinion to the editor; n2/n3 are
  supported controls. A red Host splitter check revealed a semicolon-created
  fifth source unit; the fixture now matches that split. An adversarial
  source change from rejection to endorsement is rejected before seed write.
- In idle 3119, CommandCode DeepSeek V4.1 Flash completed full coverage of
  3/3 nodes, 0/0 edges and 5/5 source units. It found the sole frozen
  Codex-reviewed defect, but proposed no structured fix for it. Codex marked
  one other AI issue false alarm and three uncertain, rather than inflating
  positive or negative counts. Of four other proposed edits, one was
  unnecessary and three remain uncertain; none was applied. Six local-rule
  issues were excluded. Two requests reported 2,463 input and 12,930 output
  tokens; raw report, decisions and score remain in isolated ignored output.
- This broadens source-attribution coverage but is still an invented graph
  with same-thread AI labels, not an independent human or real-book quality
  result. The confirmed issue's absent fix remains an explicit follow-up for
  repair generation evaluation. The source-anchor smoke and fresh complete
  Node 24 `npm test` passed, including signed payload parity and stale-payload
  rejection. No production graph, service or user task was modified; no
  commit or deployment occurred.

### Discovery-to-Targeted-Repair Follow-Up (2026-09-28; isolated only)

- Traced the actual Host path: ordinary full verification may report a real
  issue with no edit, while issue-review independently confirms it and can
  request a structured repair. A follow-up benchmark builder binds one
  approval to the frozen discovery gold/report hashes and full graph/source.
  A red adversarial test exposed that a valid n2 deletion could inherit n1's
  approval; the builder now rejects repairs that target a different issue.
- On idle 3119, CommandCode DeepSeek V4.1 Flash confirmed the frozen n1
  attribution error and proposed an `update_node` anchored to the editor's
  exact P2 rejection. One reported request used 1,231 input and 5,172 output
  tokens. The pre-call approved repair was deletion of redundant n1, so the
  evaluator marks this distinct update **unapproved**, not unsafe or
  retroactively approved. Same-thread Codex found it source-faithful; a
  disposable SQLite/real Host replay verified wrong-anchor refusal,
  preview-only behavior, persistence of only n1's semantics, and stale
  revision rejection. Neither 3119 nor production received the patch.
- The exact raw task, run and report remain in ignored output. Targeted
  success on one synthetic issue is not full-graph repair coverage, independent
  human truth, or real-book quality. The new builder and replay smokes are
  included in the standard QA benchmark command; targeted QA and a fresh
  complete Node 24 `npm test` passed, including signed payload parity and
  stale-payload rejection. All changes remain uncommitted and undeployed.

### Targeted Repair Adjudication (2026-09-28; isolated only)

- The v6 targeted run exposed a measurement distinction: its source-backed
  `update_node` differs from the pre-call approved `delete_node`, so exact
  frozen scoring correctly reports one unapproved proposal but cannot alone
  say whether that proposal is source-faithful. Added a separate post-hoc
  layer for unapproved repairs only, bound to gold, entire run and individual
  proposal hashes. It requires complete decisions, reviewer tier, rationale
  and source-unit evidence, and leaves frozen scores untouched.
- A controlled adversarial smoke rejected changed runs, changed patches,
  missing decisions, misanchored evidence and unreviewed draft templates.
  Codex then marked the saved v6 proposal source-supported, explicitly not
  pre-approved or authorized for graph application; the temporary Host replay
  is recorded separately. No additional model call or graph edit occurred.
  The new smoke is in the standard QA benchmark command; targeted QA and a
  fresh complete Node 24 `npm test` passed, including signed payload parity
  and stale-payload rejection. No commit, deployment or restart occurred.

### Targeted Replay Provenance Fence (2026-09-28; isolated only)

- An adversarial replay changed the captured request question while retaining
  the same gold hash, issue ID, successful result and proposed patch. The old
  temporary-Host replay accepted it, so that replay alone could have been
  misread as persistence evidence for a response to the frozen question.
- The replay now validates the complete captured run against the frozen
  targeted case before inspecting or persisting its proposed fix. The red
  substituted-request case now fails, while the original controlled capture
  and saved Flash capture pass. The provenance smoke is included in the
  standard QA benchmark test. No model call, service restart, production
  access, commit or deployment occurred. This guards benchmark attribution;
  it does not establish that the model's repair is semantically correct.

### Discovery Cost Accounting (2026-09-28; isolated only)

- The full-graph discovery scorer previously reported findings and repairs but
  omitted model usage, leaving token comparisons in prose alone. An
  adversarial test first showed the missing field; the scorer now returns
  complete reported request/input/output counts and separately measured wall
  time. Missing or partial usage is `null`, not zero. An older saved Flash
  capture produced 2 requests, 2,553 input and 11,149 output tokens; it has no
  start timestamp, so elapsed time correctly remains unknown.
- This is usage reporting, not a monetary price estimate or controlled model
  speed comparison. The smoke covers complete, absent and partial provider
  accounting. Targeted QA, complete Node 24 `npm test`, signed payload parity,
  stale-payload rejection and `git diff --check` passed. No model request,
  graph edit, service restart, commit or deployment occurred.

### Full-Graph Model Attribution (2026-09-28; isolated only)

- The discovery evaluator previously trusted the capture's declared model
  without comparing it to the completed Host report. An adversarial test
  changed only the declaration and still received a valid score; another
  concealed a second model/batch behind an incomplete `modelsUsed` list.
- Real-model captures now require exact agreement among declared model,
  report model, every `modelsUsed` entry and completed batch count. Controlled
  fixtures carry explicit Host model provenance. Saved v2-v6 Flash reports
  still validate unchanged. This prevents accidental mixed-model attribution
  in the offline score; it cannot cryptographically authenticate a fabricated
  capture. Targeted QA and complete Node 24 `npm test` passed, including signed
  payload parity and stale-payload rejection. No new model request, service
  action, commit or deployment occurred.

- A follow-up adversarial test found a remaining string-label bypass: changing
  a real capture's declared model to `controlled` skipped that check. The
  evaluator now requires structured model identity for **every** run, and
  controlled Host fixtures report their explicit `fixture` model and batch
  count. The bypass is rejected; the real persistent Host smoke and existing
  saved Flash captures still pass without modifying their raw records.
  Targeted QA and fresh complete Node 24 `npm test` passed, including signed
  payload parity and stale-payload rejection.

### Live Host Build Attribution (2026-09-28; isolated only)

- The 3119 process had started before the local generated Host file changed.
  The discovery capture runner formerly hashed that *disk file* as its prompt
  version, so it could attribute an old in-memory verifier response to new
  local code. The running Host had no identity endpoint (HTTP 404). A red
  regression first failed because no build identity was exported.
- The build now embeds a SHA-256 of the generated Host body and its three
  generated local modules. A read-only HTTP endpoint returns this constant
  from the loaded process. The discovery runner requires an exact match
  before planning/admission, immediately before admission, on resume and
  before recording a terminal result. Captures retain the full build hash;
  an older capture without it cannot be silently resumed or relabelled.
  The smoke recomputes the hash from generated runtime bytes and rejects
  missing/stale identities; a persistent-Host HTTP smoke checks the endpoint
  without making a model request.
- Complete Node 24 `npm test` passed, including signed extension payload
  parity and stale-payload rejection; `git diff --check` passed. After a
  fresh idle check, only the isolated 3119 process was restarted. Its live
  endpoint returned the exact local build hash
  `e3f50449349795a65865f3901ea9809ae8afc88d99375c1baa58ea03ed7558af`.
  No model task was admitted and 3099/3109 were untouched. This fences
  accidental stale builds; it is not cryptographic remote attestation and
  does not fingerprint the external DSH harness or provider implementation.
  New work remains uncommitted and undeployed to production.

### Published-Excerpt Discovery Negative Case (2026-09-28; isolated only)

- Froze a new, attribution-licensed Chinese excerpt from a CC BY 4.0
  Feynman-learning meta-analysis before using a model. Its abstract and
  subgroup results conflict about learning-organization stability; the
  manually seeded graph's single positive defect is narrower and numeric:
  n1 reverses both the reported effect sizes and heterogeneity direction.
  Host splitting, source anchors and an adversarial changed-value case passed
  before the isolated 3119 seed. The frozen graph has 4 nodes, no edges and
  4 source units at revision 1. This is a curated excerpt, not the full paper
  or the user's book.
- Idle 3119 ran only CommandCode DeepSeek V4.1 Flash on the ordinary full
  audit after its loaded Host identity matched the local build. Coverage was
  complete, but the model **missed** the frozen n1 error. Its sole AI warning
  targeted faithful n3 for having a primary quote from only one of two
  paragraphs, despite n3's separate evidence array citing both exact
  values. Same-thread Codex review marked that warning false alarm and its
  P2-only rewrite unnecessary; no patch was applied. Seven local-rule issues
  were excluded. The measured two requests reported 2,610 input and 7,693
  output tokens, with 55,755 ms capture wall time. Raw, hash-bound review
  and score remain in isolated ignored output; source and frozen gold are
  under `scripts/fixtures/`.
- The focused benchmark suite and a fresh complete Node 24 `npm test` passed,
  including generated-source parity, signed extension payload parity and
  stale-payload rejection. `git diff --check` passed. The isolated task
  returned to idle; no model proposal was applied.
- The 0/1 discovery result is a meaningful failure on **this one planted
  real-excerpt defect**, not a general book-level recall statistic. It also
  shows that a multi-evidence node can attract a misleading primary-quote
  warning. Next compare targeted confirmation of the missed n1 and trace
  why full discovery overlooked the numeric contradiction, without changing
  frozen gold or repeating this model call. This work is uncommitted and
  undeployed to 3099.

### Published-Excerpt Miss: Targeted Follow-Up (2026-09-28; isolated only)

- The actual Host full-audit plan gave n1 a batch with all four source units,
  including both numeric subgroup paragraphs and n2-n4. A regression test
  verifies that plan. The full-discovery miss cannot be explained by absent
  P2/P3 context; the precise model/prompt cause is still not established.
- A new derived targeted benchmark case is bound to the adjudicated v7
  discovery **miss** and its report hash. Red/green tests reject tampered
  reports, wrong repair targets and lost source context. An independent red
  test found that the targeted capture runner could label an old running
  Host with new local source; both benchmark runners now share the loaded
  Host identity check. CommandCode capture is restricted to isolated 3119.
- On idle 3119, one CommandCode DeepSeek V4.1 Flash known-allegation review
  confirmed n1's numeric reversal and identified the abstract/body tension.
  It reported 1,207 input / 1,909 output tokens and 16,504 ms. The model's
  proposed `update_node` differs from the pre-approved deletion and leaves
  the old source anchor unchanged; the benchmark records one unapproved
  repair, and no graph edit occurred. This known-issue success does not
  alter the frozen full-graph 0/1 discovery score. Raw, normalized and scored
  records remain in isolated ignored `output/`. Focused tests and the full
  Node 24 `npm test` passed, including generated-source and signed-extension
  payload parity. Nothing was committed or deployed to 3099.

### Article Repair Citation Carryover (2026-09-28; isolated only)

- A disposable SQLite/real persistent Host replay of the exact saved Flash
  patch proved the risk: preview was structurally valid and read-only, but
  committing to **temporary** storage changed n1's text while retaining its
  old P0/P1 abstract-side quote and evidence. Source and other nodes stayed
  unchanged; stale preview was rejected. This proves that structural source
  anchoring is not semantic support for the new comparison. Nothing was
  written to 3119 or the production graph.
- A red UI test showed that the single-item repair preview did not expose
  this retained-citation state and truncated proposed node text at 120
  characters. Both the issue card and AI recheck result now show full
  proposed text and the exact old primary/evidence citations when a text
  rewrite carries them over. The existing second-click gate remains. Real
  browser checks against a random-port disposable SQLite fixture found the
  warning visible at 1440 and 390 px, no horizontal overflow, zero commits
  on first click and an explicit second confirmation. This warns the human;
  it does not claim to automatically judge textual entailment.
- The controlled replay is part of the benchmark suite, and the saved-model
  replay also passed. The first full Node 24 run correctly failed the signed
  CRX stale-payload gate after rebuilding the changed client; the existing
  external signing identity repacked it, and the fresh complete `npm test`
  passed with payload parity and stale-payload rejection intact.
- A second disposable SQLite/real Host replay exercised the frozen gold's
  approved `delete_node n1` alternative. Preview was valid and read-only;
  commit removed only n1, preserved n2-n4 and the complete source, and a
  stale retry conflicted. Unlike the model's text-only rewrite, deletion
  does not leave a new body-side claim under abstract-side citations. It
  also does not settle the source's abstract/body discrepancy. Reanchoring
  to P2/P3 would duplicate n3/n4 and needs semantic adjudication, so no
  reanchor was applied. No graph outside temporary SQLite was changed;
  the frozen full-audit miss and AI-versus-human label boundary are intact.
  Next use a genuinely different source/defect shape rather than rerunning
  the same v7 model case. All new work remains uncommitted and isolated.

### Versioned Rule Discovery (2026-09-28; isolated only)

- Added a new synthetic versioned training rule with a grandfathered old
  cohort. The planted n1 claim wrongly applies the new post-test-answer rule
  to all enrolled learners; n2/n3 are faithful cohort-specific controls.
  A first draft assumed five paragraphs, but the real Host splitter produced
  eight. Fixed anchors before freezing the revision-1 Host gold, and added
  an adversarial test that invalidates the gold if the old-cohort exception
  is removed. The actual full-audit batch includes all eight units.
- On idle 3119, CommandCode DeepSeek V4.1 Flash completed 3/3 node and 8/8
  source-unit coverage in two requests. Same-thread Codex review matched its
  only AI issue to the one frozen defect; six local-rule issues were excluded.
  Reported usage was 2,293 input/6,067 output tokens, 49,851 ms capture
  interval. Raw report, hash-bound review and score are ignored under
  `output/discovery-zh-flash-v8-20260928.*`. The proposed repair is
  source-supported by P2/P3 but its retained citation names only P3 and it
  changes node type, so it was not applied. This single invented case is not
  a book-level accuracy result or human truth; v7 remains a full-audit miss.
- Next examine cross-sentence version provenance as a repair-review case,
  without repeating the v8 model call or editing any canonical graph. New
  work is uncommitted and not deployed to 3099.

### Versioned Repair Citation Gate (2026-09-28; isolated only)

- Replayed the saved v8 model patch in disposable SQLite/real persistent
  Host. Its text/type change was structurally valid but left only P3
  evidence; P2 holds the explicit new-cohort applicability. An explicit
  P2+P3 reanchor was structurally valid and persisted only in that temporary
  graph. This tests representability, not semantic approval; no 3119 or
  production graph was edited.
- A red adversarial preview with a fabricated new P2 citation returned
  `valid` because authentication silently discarded the bad item before
  checking invariants. The fake quote itself was not persisted, but the
  requested scope evidence could disappear without notice. The commit
  boundary now rejects newly invalid node/edge evidence and changed primary
  quotes before sanitization in both Host routes. Existing unchanged legacy
  citations are not newly blocked. A first full test found that moving
  authentication too late allowed caller-forged provenance into SQLite;
  restored incoming authentication *after* raw-citation rejection, then
  proved the canonical-provenance trust test and full Node 24 `npm test`
  pass. Dynamic and persistent preview/commit, valid reanchor, stale CAS,
  source preservation and signed-extension parity have focused evidence.
- Remaining boundary: these deterministic checks establish quote occurrence
  and provenance, not whether quoted text entails the node's claim. The
  model's exact v8 edit still needs human semantic review; v7's discovery
  miss remains. No new model call, commit, deployment or production restart.
- A separate adversarial case sent `evidence` as a string rather than an
  array. The merge clone converted it to `[]` before citation validation and
  preview again returned valid. Both dynamic and persistent commit routes
  now reject explicit malformed evidence shape and non-text primary quotes
  before normalization. Preview and commit red/green tests plus a fresh
  complete Node 24 `npm test` (including signed payload checks) passed.
  Remaining risk is semantic entailment, not source-unit quote existence.
- A further adversarial merge used an existing relation citation plus eight
  submitted citations. The eight-item merge cap discarded the final submitted
  citation before the quote gate: a fabricated quote could return a valid
  preview, and a genuine quote could disappear without notice. Dynamic and
  persistent commit routes now validate raw incoming citations before merge,
  then reject any submitted evidence lost at the cap instead of silently
  truncating it. Focused preview/commit tests cover fabricated and genuine
  overflow on disposable graphs. This is evidence preservation, not semantic
  entailment; no production graph or 3119 preview data was changed.
- The same eight-citation cap also affected semantic `merge_node` operations:
  combining two evidence-rich nodes could discard the source node's citations
  before the submitted view reached the new loss detector. A red dynamic
  preview reproduced this. Operation preflight now refuses node or rewritten
  relation evidence unions exceeding eight with `evidence_limit`, before any
  canonical write. Dynamic preview/commit and persistent temporary-SQLite
  preview/commit tests prove the source citations and revision stay intact.
  Users must review and reduce evidence before such a merge; this does not
  decide whether the nodes are semantically equivalent. A fresh full Node 24
  `npm test`, signed-extension payload parity and `git diff --check` passed;
  no model call, commit, push or deployment occurred.
- Follow-up branch coverage in disposable SQLite confirmed the redirected
  relation case separately: two valid eight-citation `supports` relations
  would collide after `merge_node`; preview and commit now both reject with
  `evidence_limit` targeting the relation, and revision remains unchanged.
  Only the focused persistent smoke was rerun because production code was
  unchanged after the preceding full test.
- Froze a distinct synthetic full-graph discovery case, v9, for the
  non-significance/equivalence fallacy: a failed superiority test is not an
  equivalence test. Codex same-thread labels identify one unsupported node;
  they are not independent human truth. A seed smoke confirms four actual
  Host source units, that both design and interpretation qualifiers reach the
  target's full-audit batch, and that reversing the study-design evidence
  invalidates the frozen finding. No model run or accuracy claim yet: 3119 is
  idle but its running Host build differs from the current isolated checkout,
  so the live capture identity gate would reject a run. Do not bypass that
  gate; first arrange an idle, credential-safe 3119 refresh, then seed and
  capture Flash results in order.
- After confirming 3119 had no active task, refreshed only that isolated
  service with its existing launcher; its Host build hash then matched the
  isolated checkout. No credential was read or copied. The frozen v9 graph
  was seeded into the isolated SQLite and read back at revision 1 with 3
  nodes, 0 edges and 4 Host source units. Sequential CommandCode DeepSeek
  V4.1 Flash full verification completed all coverage in 2 requests:
  2,194 reported input tokens, 4,803 output tokens and 42,646 ms measured
  elapsed time. Codex same-thread source adjudication matched the one frozen
  defect, counted a second n1 issue as a duplicate, and left a n2
  completeness suggestion uncertain. The suggested n2 rewrite compounds two
  facts into one node and was not approved. One deletion proposal was judged
  source-supported but not applied. Six local-rule issues were excluded.
  This is one invented graph, not independent human truth, book accuracy or
  a cost comparison. Raw task, adjudication and score remain in ignored
  `output/`; neither 3099 nor the user's graph was touched. A fresh complete
  Node 24 `npm test`, signed-extension parity and `git diff --check` passed
  after adding v9; all new work remains uncommitted in the isolated branch.
- A separate under-cap `merge_node` replay exposed a remaining path: even
  when two nodes' citations total fewer than eight, the submitted working
  view could overwrite the operation's merged target and omit the source
  node's evidence. The persistent Host preview incorrectly returned valid.
  Operation preflight now compares the operation-produced target and
  redirected relations with the final merged view, rejecting omitted
  citations with `evidence_limit`. A red/green temporary-SQLite test covers
  preview rejection and unchanged revision; a positive control preserves
  both nodes' full evidence sets through preview and durable commit. The
  source is isolated synthetic data and no model call was needed. A fresh
  complete Node 24 `npm test`, signed-extension payload check and
  `git diff --check` passed; 3099 and the isolated 3119 service were not
  restarted for this code change.
- A separate evaluator red test used parallel relations with the same node
  endpoints. Without an explicit gold `targetRelation`, a candidate for the
  other relation could be counted as a discovery. Gold validation now
  requires the exact relation to exist and be named for every edge finding;
  the existing frozen fixtures already satisfy this contract. The focused
  benchmark smoke and full Node 24 `npm test` pass after the change, including
  signed-extension payload parity. No graph or model task was run.
- A report-origin adversarial test then changed one AI candidate's `source`
  to an unknown value. Previously it vanished into the excluded local-rule
  count and no longer required adjudication, making precision look better.
  The offline discovery scorer now rejects any issue source other than the
  Host's explicit `ai` or `local`. The red/green focused smoke and full Node
  24 `npm test` pass, including signed-extension parity. This is a
  metric-integrity check, not a new model-quality result.
- The first zero-defect control was a genuine failed Codex review, not a
  model false alarm: frozen v10 n1 omitted the source's `虚构` qualifier.
  Flash found it on idle 3119. The v10 run was disqualified without scoring
  or post-hoc relabelling; raw gold/task remain in isolated ignored `output/`.
  The evaluator now supports explicitly reviewed zero-finding gold and uses
  `null` recall instead of dividing by zero. A new v11 synthetic control was
  re-reviewed and frozen under a different ID, with source split, anchors and
  full plan checked first. Flash completed 7 nodes/5 source units in two
  requests and returned zero AI candidates; eight local hints were excluded.
  Reported usage was 2,124 input and 15,279 output tokens, capture elapsed
  138,204 ms. The v11 score has `null` recall and precision, not a perfect
  result. Same-thread Codex labels remain fallible and non-human. No repair
  was applied, and 3099/3109 were untouched. The focused evaluator/seed
  smokes pass. The first complete Node 24 `npm test` attempt failed in a
  42 ms timeout/cancellation smoke; that smoke passed alone and a second
  complete `npm test` passed through signed-extension packaging. This
  timing-sensitive failure remains a test-stability risk, not evidence that
  the first full attempt passed.
- A separate v12 connected negative control was frozen with two source-backed
  concept nodes and one explicitly stated `is_a` edge, avoiding v11's
  edge-free-topology confound. The seed smoke checked all three actual Host
  units, the relation's audit-batch context and a reversed-taxonomy mutation
  rejected before SQLite write. On idle 3119, Flash completed 2 nodes, 1 edge
  and 3 source units in two requests; the Host reported 1,922 input and
  13,010 output tokens over a 112,628 ms capture interval. It proposed one
  graph-level P0 disclaimer node and the local rules emitted one uncovered-
  paragraph hint. The frozen summary already preserves P0's fictional/no-
  efficacy limits; whether a separate canonical node is required is a graph-
  granularity judgement. Codex therefore marked the AI candidate and its
  patch `uncertain`, not a false alarm or a newly discovered frozen defect.
  Zero positive gold plus this unresolved candidate yields null recall and
  precision, not a specificity claim. No fix was applied. Raw task, frozen
  gold, hash-bound decision and score are isolated ignored `output/` artifacts.
  The focused seed smoke, complete Node 24 `npm test` including signed
  extension payload checks, and `git diff --check` passed. All changes remain
  uncommitted on the isolated branch; 3119 was not restarted for this run.
- A different source shape, v13, freezes three clauses from the public-domain
  《孙子兵法·谋攻》 text at Wikisource rather than another invented teaching
  study. The deliberately wrong n1 applies `百战不殆` to the `不知彼而知己`
  condition where the source instead says `一胜一负`. The positive label was
  frozen before the model call; Host source splitting, n1 batch context and
  a source-meaning reversal were checked by adversarial seed smoke. On idle
  3119, Flash completed all 3 nodes/3 source units in three requests but
  published **zero AI issues**, so the frozen n1 defect is a full-discovery
  miss. Four disconnected-graph local hints are excluded, not AI findings.
  The Host reported 1,865 input/1,886 output tokens; capture elapsed 33,515
  ms. The empty adjudication, exact report hash, raw task and score remain in
  isolated ignored `output/`. This tests faithful representation of a short
  real book excerpt, not the historical truth of the maxim, whole-book recall
  or an independent human judgement. No code was changed to optimize for this
  example and no patch was applied.
- Verification after freezing v13: the focused source/seed smoke and a fresh
  complete Node 24 `npm test` passed, including the signed extension payload
  and stale-package checks; `git diff --check` passed. The first full attempt
  failed in the existing `kg-timeout-cancellation-smoke` while waiting for an
  auxiliary idle-stream task to settle within two seconds, before reaching
  the new benchmark suite. That smoke passed alone and the next full run
  passed. A small diagnostic-only test change now records the last task
  progress if this recurs. The underlying timing instability has not been
  explained or fixed; no test deadline or production timeout was relaxed.
- The v13 public-domain excerpt received a separate, hash-bound **targeted**
  follow-up after the frozen full-audit miss. The approved alternatives were
  to rewrite n1 with the verbatim P1 result or delete it. An idle-3119
  CommandCode DeepSeek V4.1 Flash call confirmed the false conditional claim
  and proposed the approved rewrite, with 1,105 input/450 output tokens and
  11,009 ms capture latency over two reported requests. The follow-up builder
  smoke verified the report-hash and target fences. This does not change the
  full-discovery score: the model recognized a directly alleged defect that it
  failed to find unprompted despite both clauses appearing in the audit
  context. The mechanism of that gap is not yet proven, and this single
  excerpt is not a book-level quality estimate. Raw and normalized artifacts
  remain in isolated ignored `output/`; no graph edit, commit or deployment
  was made. Next, inspect the full-audit task framing and candidate pipeline
  with controlled contrasts rather than adding a rule for this one sentence.
- That call-chain inspection found a real context gap in the independent
  confirmation stage: its prompt included candidate allegations and original
  units but not the graph text/relationship being judged. The v13 full task
  trace shows confirmation and a retry, proving at least one initial
  normalized candidate existed, though the final report does not retain it
  and does not prove it concerned n1. A controlled Host stream test failed
  when it required the exact targeted node proposition in the verifier
  request. The verifier now receives target kind/id plus the bounded graph
  subgraph, with source text still authoritative; the reuse input hash is
  version 2 to prevent reuse of reviews made without this context. The test
  passed after the fix, and a fresh full Node 24 `npm test` passed through
  persistent reuse and signed packaging. No second full-model audit has been
  run and 3119 still serves the prior package. The context defect is fixed at
  code level, not yet measured as a changed real-model discovery result.
  A new persistent-Host adversarial test used a 320-node source-coverage
  batch: the first request fit the 64,000-character safety budget, but the
  newly added full-text confirmation subgraph exceeded it. No real model was
  called. Confirmation now reuses the compact 120-character source-coverage
  index while retaining fuller context for node/relation batches; the same
  test then passed and cancellation wrote no graph changes. This is a
  measured boundary for one hostile batch, not proof that arbitrary candidate
  lists are bounded. No new Flash full-audit run or 3119 restart occurred.
  Fresh complete Node 24 `npm test`, source/lib parity, signed-extension
  packaging and `git diff --check` passed after the compact-index change.
  Unbounded candidate-list size is a remaining resource risk for a later
  adversarial test; no production deployment or commit was made.
- The candidate-list risk was reproduced in the same persistent-Host fixture:
  25 distinct high-detail, source-anchored graph candidates caused the prior
  single confirmation request to exceed 64,000 characters. The red run was
  cancelled before a paid call or graph write. Confirmation now partitions
  candidates into bounded groups and unions only IDs approved by their own
  group; the batch is saved only after all groups finish. The green run
  covered all 25 exactly once in multiple groups and left the graph revision
  unchanged. An adversarial response that named a later group's ID failed
  after bounded retries and saved no partial batch. Reuse input version 3
  prevents old policies being reused. Fresh complete Node 24 `npm test` and
  signed extension checks passed. Repeated source context raises token cost,
  and an individually oversized candidate still fails closed; neither the
  3119 preview nor the frozen v13 Flash run was restarted or replayed.
- A further persistent-Host adversarial check found that node-only
  confirmation reintroduced the full graph summary even though the initial
  node-only pass deliberately excluded it. Thirteen nodes force a separate
  node batch; the controlled model emitted an issue for its distinctive n0
  text. The red test found an unrelated global summary in the independent
  verifier prompt. Confirmation now follows the initial batch's summary
  scope for node-only and relation-only passes. Reuse input version 4
  invalidates confirmations made with the broader context. The focused
  full-verification smoke passed after the change; this is a prompt-context
  invariant, not evidence of improved real-model recall. No Flash call,
  3119 restart, production change, or commit was made.
  Fresh complete Node 24 `npm test` passed, including the signed extension
  packaging check; `git diff --check` and generated source/lib parity passed.
