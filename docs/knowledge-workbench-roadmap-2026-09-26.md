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
| 3 | Hierarchical reading map | Pending | Book, topic, claim and original evidence navigation; derived views never merge canonical nodes or turn AI summaries into source facts |
| 4 | Saved task perspectives | Pending | Persist filters, focus and expansion/reading state rather than copying the graph; test reload, revision changes and missing nodes |
| 5 | Cross-book concept dossiers | Pending | Candidate alignment only; retain each source, conditions, time and disagreements; distinguish faithful attribution from real-world truth |
| 6 | Learning mode | Pending | Concept discrimination, mechanism explanation and transfer to new situations; separate progress and generated tasks from canonical source knowledge |
| 7 | Expanded quality benchmark | Pending | Human-confirmed cases for negation, conditions, cross-paragraph evidence, homonyms, unsafe merges and distant dependencies; evaluate false positives/negatives, unsafe repair, cost and time |

Existing QA/quality gates remain mandatory throughout. Their current fixture
scores are not a substitute for new human-labelled semantic evaluation.
Do not claim the six pending capabilities are delivered. Existing batch review
is a foundation for item 2, not evidence that work packages already exist.

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

Item 1's first-version delivery and its history follow-up are verified and
committed. Item 2's end-to-end work-package flow is implemented and committed
on the isolated branch but remains undeployed. Begin item 3 with a
derived book-to-theme-to-claim-to-evidence reading map; do not merge canonical
nodes or present generated summaries as source facts. Neither item is pushed
or deployed to production. No further production release is authorized.
