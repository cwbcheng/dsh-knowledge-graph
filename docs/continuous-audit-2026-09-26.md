# Continuous Knowledge Graph Audit - 2026-09-26

## Published baseline

- Production checkout: `/mnt/d/github/dsh-knowledge-graph`, branch `main`.
- Published commit: `9370c3a3104c580f6164421b0e29edb294484adc`.
- Commit: `fix: harden resumable graph review and batch repair`.
- Full local `npm test` passed after extension packaging was regenerated using
  the existing external signing identity. The preceding CRX was backed up in
  ignored `scripts/tmp/release-before-20260926-audit/`.
- GitHub CI run `36218973754`, job `trust-gate`: completed successfully.
  <https://github.com/cwbcheng/dsh-knowledge-graph/actions/runs/36218973754>
- Port 3099 was restarted only after authenticated `task-active` returned
  `busy: false` and no task. User service main PID changed from 1502882 to
  1625652 at 2026-09-26 12:50:57 Asia/Shanghai.
- Authenticated root/ontology/document/model endpoints returned HTTP 200.
  The new source-export contract is live. The served knowledge graph client
  matches `lib/client.js` (trimmed SHA-256:
  `e72cd1236d1d3b7905fd0303a83fdd9f585d12f67172ff5fea931e1d4683be2a`).
- Canonical graph hashes and ontology hash matched across restart. The saved
  graph remained revision 246 with 4,645 nodes and 8,539 edges. No model request,
  graph edit, or automatic review resumption was made for deployment validation.

## Isolated continuation

- Worktree: `/mnt/d/github/.dsh-safe-bulk-verification-20260925`.
- Branch: `codex/kg-audit-continuation-20260926`, based on the published commit.
- The existing checkout was clean and no process had its working directory
  there before reuse. The previous branch was preserved. The desktop managed
  worktree tool was unavailable because this chat's entry directory is not a
  Git repository.
- `node_modules` is a symlink to the unchanged production dependency directory;
  source and generated output are local to this worktree. Do not run dependency
  installation or mutate dependencies through that symlink.
- Subsequent changes stay isolated and uncommitted unless separately authorized
  for publication. Do not merge, push, or restart 3099 for these changes.

## Round 2: Question Submission Ownership

The original document submit handler could finish exporting the old graph after
navigation and then initiate a model request. Both document and trajectory
handlers could attach a late admission result or error to the newly selected
view. State-only `questionPhase` also left a synchronous double-click window.

The new `scripts/kg-question-admission-smoke.mjs` reproduced an old-document
model request after navigation before the fix. The current change adds a
synchronous submission owner and validates generation plus document identity
after awaited boundaries. Unsaved graphs use view identity, while changing a
window of the same saved document remains valid. Cleanup can release only its
own submission, never a newer one. Navigation reset clears admission ownership.

Verification:

- New adversarial submission regression: passed.
- `npm run build:lib`: passed.
- `npm run test:kg-verification`: passed, including the new regression.
- Full `npm test`: passed (exit 0), including extension payload parity and
  rejection of stale packaged payloads. The test harness also checks document,
  generation and unsaved-view guards independently, without relying on the
  submission owner having been cleared by navigation.
- No deployment or production graph changes were made for round 2.

## Round 3: Comparison Context Lost Inside Issue Review

The new `scripts/kg-issue-review-context-smoke.mjs` first failed on the original
host: a review of `n1` explicitly comparing it to distant `n300` passed both
nodes to the host, but the actual model prompt contained only `n1`, `n2`, `n3`.
The comparison node `n300`, its neighbor `n301`, and their source paragraphs
were missing. `runQuestionTask` replaced the prepared context with only the
target's incident star. It also removed relations between target neighbors.

The fix builds bounded context from the target, edge endpoints, and nodes
explicitly named in the allegation/question. It retains their one-hop
neighborhoods, all induced relations, and the corresponding source paragraphs.
Unavailable comparison nodes fail before model invocation instead of allowing a
verdict from incomplete input. Existing 96-node and 95-target-relation limits
remain. A 24-reference limit matches the client signature budget; a 512-relation
limit bounds newly retained dense induced graphs. These limits reject, rather
than silently truncate, required context.

Verification:

- New adversarial regression: passed for both the dynamic host and generated
  persistent HTTP route, using an in-memory controlled model and an owned
  temporary database. No paid model or production graph was used.
- Node, edge, and graph allegations preserve distant comparisons and source
  evidence. Unrelated nodes sharing a paragraph are excluded.
- Missing comparison nodes and oversized neighborhoods cause zero model calls.
  Exact 96-node, 512-relation, and 24-reference boundaries remain usable;
  over-budget contexts fail closed. Scoped source evidence maps back to its
  original paragraph number. Input graphs remain unchanged.
- The new test is included in `test:kg-verification` and therefore `npm test`.
- Full `npm test`: passed (exit 0), including all verification regressions,
  generated ontology checks, and signed extension payload parity/stale-payload
  rejection. `git diff --check` passed. No signing identity was created or changed.
- Published baseline `9370c3a` and its successful remote `trust-gate` were
  rechecked. Production service is still active/running with main PID 1625652;
  no further restart, commit, push, or deployment was made.

## Round 4: Paired Graph and Source Snapshots

The new `scripts/kg-question-snapshot-smoke.mjs` reproduced the mixed-version
request before the fix: the document workbench exported the canonical graph
for a partial window, but sent `Old accumulated source` instead of the export's
`Canonical source`. This affects both full-text and scoped source-unit payloads.

The document question handler now waits for preceding graph writes, requests
graph plus source in the same export, and validates document identity and
revision against the accepted write boundary. A changed queue, failed write
epoch, revision change, missing source, or malformed snapshot prevents model
admission. The visible source/anchor view and accumulated source cache are
updated together after a valid read; the editable input draft is not replaced.
Complete local views retain their own paired source without adding an export.

Verification:

- The snapshot regression passed with the real production submit handler and
  source-scoping helpers. It covers full/scoped source pairing, identity and
  revision mismatches, missing source, pending writes, write/read races,
  navigation while waiting for writes, and release of failed admission locks.
- The prior question-admission and feedback UI regressions passed. Their
  canonical-export fixtures now include the real document/source/revision
  contract rather than incomplete response objects.
- Browser verification used `kg-verification-ui-fixture.mjs --snapshot`: an
  owned temporary SQLite graph with 803 nodes, an 800-node visible window,
  intentionally stale page source, and a controlled non-network model.
- Clicking the real AI review button sent the canonical `[P0] Fixture
  observation 0...` source to the model. The stale source was visible before
  submission and absent afterward; the review result displayed the canonical
  quotation and repair preview. No repair was saved.
- After the fixture advanced revision 1 to 2, another real review click showed
  the actionable revision-conflict alert. Snapshot exports increased from 2
  to 3, while question requests/model calls stayed at 2 and graph commits stayed
  at 0. All four issue statuses remained open.
- Desktop 1440x1000 and mobile 390x844 screenshots were inspected. The mobile
  document width was 390 with no horizontal overflow; browser console and
  captured runtime errors were empty. Screenshots are untracked artifacts at
  `output/playwright/question-snapshot-{desktop,mobile}.png` in this worktree.
- Browser and fixture server were closed after verification. The CUA tool could
  not initialize its kernel assets, and the npm CLI shim was unavailable; the
  existing official Playwright CLI entry ran successfully with the bundled
  Windows Node runtime. Use the UNC worktree path for Windows commands, not a
  presumed `D:\\github` drive path.
- Full `npm test`: passed (exit 0), including the new snapshot regression and
  signed extension payload/staleness checks. `git diff --check` passed. The
  production service remains active/running with main PID 1625652; no restart,
  publication, paid model call, or production data mutation occurred.

## Round 5: Client Truncation Before Review Completeness Checks

The new `scripts/kg-question-context-completeness-smoke.mjs` first failed before
the fix: a target with one incident relation and a separately named comparison
with 94 neighbors requires 97 nodes in total. The client selected the first 96
nodes, retained the target's one relation, and submitted the request. The host's
round-3 completeness check could not detect the comparison relation that had
already been removed before transport. Reordering relations changed which
evidence was silently omitted.

Issue review now computes the complete union of all named targets/comparisons
and their one-hop neighborhoods before applying the existing 96-node,
512-relation and 95-target-relation limits. Missing endpoints or oversized
contexts fail before task admission, rather than creating an apparently valid
verdict from partial evidence. Ordinary exploratory questions retain bounded
retrieval. Review selection also reads the separately transmitted allegation,
not only the 600-character question; late comparison IDs and repeated mentions
no longer disappear from the 24-unique-reference budget.

Both single and bulk review use the strict selector. A batch records an
unreviewable item with its reason and continues other items. If an old checkpoint
already has an active task for an invalid context, it pauses and preserves that
task ID/hash instead of forgetting, cancelling, or re-requesting the task.

Verification:

- New adversarial regression: the original single-item path made one request
  where zero was expected. The fixed test covers single and bulk handlers with
  the production selector/signature helpers, not a reimplementation.
- Node, edge and graph targets, canonical exports from partial windows, long
  allegations, repeated ID mentions, missing comparison nodes, dangling
  endpoints, reordered relations, and dense induced relations passed. Exact
  96-node, 512-relation and 24-reference boundaries remain supported; over-budget
  cases make no question request. No input graph is mutated.
- The actual dynamic and generated persistent HTTP hosts successfully reviewed
  the client-selected context of a long allegation, including the comparison's
  own source paragraph. These use controlled non-network models.
- Full `npm test`: passed (exit 0), including the new regression, generated
  artifacts, ontology checks and signed extension payload/staleness checks.
  Additional graph/edge boundary assertions passed afterward; production code
  did not change after the full test. `git diff --check` passed.
- Real browser verification used `kg-verification-ui-fixture.mjs --context-limit`
  with 803 nodes in an owned temporary SQLite database. Clicking the first
  item's AI review button exported canonical context, showed the actionable
  context-limit alert, and made zero question/model requests.
- The browser then ran a four-item batch: one explicit context-limit failure,
  one repair proposal, one suspected false positive and one uncertain result.
  Only the other three items invoked the controlled model. The UI reached
  `4/4` and awaited confirmation; graph commits stayed at zero, revision stayed
  at 1 and all stored issue statuses stayed open. No save button was clicked.
- Desktop 1440x1000 and mobile 390x844 screenshots were inspected. The alert
  wraps without overflow; mobile document width is 390. Browser console and
  captured runtime errors are empty. Artifacts are under
  `output/playwright/question-context-limit-{desktop,mobile,batch}.png`.
- The browser and owned fixture server were closed, and no processes remained
  in the isolated checkout. Published commit `9370c3a` still has successful
  remote CI run `36218973754`; production is still on main with only its prior
  untracked output directory, and 3099 remains active under PID 1625652. No new
  commit, push, restart, paid model request or production graph mutation occurred.

## Round 6: Canonical Context at Single-Repair Confirmation

The new `scripts/kg-review-save-snapshot-smoke.mjs` first failed before the
fix: a review of visible `n0` depended on off-window `n801`. Another session
changed `n801`, and paging away and back advanced the local revision while
leaving the original visible neighborhood unchanged. The old handler compared
only that window signature and submitted the stale patch with the newer CAS
revision. The regression observed one write where zero was expected.

Saved-document issue reviews now capture a paired canonical graph/source
snapshot, including the report and allegation identity, the semantic context
signature, and the source hash. Confirmation waits for earlier writes, exports
the current canonical snapshot, and checks those dependencies again. It applies
the patch to that full baseline and pins the checked revision for the final
CAS write. Changes outside the dependency context can be preserved without a
new model request. Changed evidence, source, allegations, reports or issue
status require a fresh review of that issue, not another full-graph audit.

The confirmation owns a synchronous lock, rechecks navigation and write epochs,
and marks the issue applied only after a successful save. A completed write
followed by a failed refresh is reported as saved, rather than inviting a
duplicate application. Old string-only window snapshots are not accepted by
the canonical save path. Unsaved graphs and trajectory paths are not silently
treated as if they have canonical snapshot protection.

Verification:

- The new regression uses the production submission/save handlers and signature
  helpers. It covers off-window changes, unrelated edits, source/allegation/
  report/status/relation changes, malformed exports, legacy snapshots, duplicate
  clicks, navigation, pending/failed write epochs, CAS conflicts and refresh
  failures. A commit already dispatched before navigation can finish without
  overwriting the newly opened document. All assertions passed.
- The real browser fixture `kg-verification-ui-fixture.mjs --review-save` used
  an owned SQLite database with 803 nodes and an 800-node visible window. After
  a review of `n0`, its hidden dependency changed and the user paged away/back.
  Confirmation displayed the dependency-conflict alert and made zero commits.
  Revision was 2; all four issues remained open.
- A fresh review at revision 2 followed by an unrelated `n700` edit at revision
  3 saved successfully at revision 4. Exactly one repair was committed; the
  unrelated text was preserved, `n0` gained the expected source quote, and only
  its issue became applied. Model calls stayed at two total: the two explicit
  reviews, with no extra model call during confirmation.
- Reloading retained revision 4, the quotation and all issue statuses. Desktop
  and mobile screenshots were inspected; mobile viewport/document width was
  390 with no horizontal overflow. Browser console and captured runtime errors
  were empty. Screenshots are under
  `output/playwright/review-save-{hidden-conflict,persisted-desktop,persisted-mobile}.png`.
- The first browser fixture omitted required evidence on its comparison edge;
  the unchanged deterministic invariant gate correctly rejected its commit.
  The fixture was corrected with an explicit source paragraph and edge evidence
  before the successful fresh-database run above. No invariant was relaxed.
- The initial full `npm test` reached packaging and correctly failed on a stale
  signed `viewer.js` payload. Locked signing dependencies were installed only
  in the isolated `scripts/signing` directory, and the extension was repacked
  with the existing external signing identity. No new identity or weakened
  gate was introduced. The second complete `npm test` passed (exit 0), including
  payload parity and stale-payload rejection. Source, generated library/viewer
  and packaged extension now agree. `git diff --check` passed.
- The owned browser/server were closed; no process remained in the isolated
  checkout. Published baseline `9370c3a` still has successful remote trust-gate
  run `36218973754`. Production stayed active under PID 1625652. No new commit,
  push, merge, restart, paid model request or production data mutation occurred.

## Round 7: Evidence-Bound False-Positive Dismissal

The round-6 save regression was extended to run the same adversarial matrix for
both repair and false-positive dismissal. Before the fix, the false-positive
case wrote once where zero writes were expected: after an off-window comparison
changed and paging advanced the visible revision, `handleRejectIssue` persisted
the old verdict without checking its canonical review snapshot. The panel's
window signature was the only guard; the handler then optimistically replaced
the report before the store confirmed it.

AI false-positive confirmation now passes its review snapshot into the shared
canonical save path. Both decisions check full semantic dependencies, paired
source, report and allegation identity, open status, queue epochs, navigation
and pinned CAS revision. Dismissal changes only the canonical report status and
explanation: it cannot apply a node/relationship patch or replace other issue
decisions. A fresh report stays fresh when only a false-positive status changes.
The button is disabled while a save owns the lock. Ordinary manual ignore stays
separate and does not claim a model-backed conclusion.

Browser testing also reproduced a misleading retry state: a failed save followed
by a successful retry left the top-level failed-write banner visible. That
banner is now cleared only after the new save and canonical readback both
succeed. Rejected commits retain their error message and open issue status.

Verification:

- The shared production-handler regression passes for repair and dismissal:
  hidden dependencies, unrelated changes, source/report/allegation identity,
  resolved issues, malformed snapshots, legacy signatures, duplicate clicks,
  navigation, write-queue changes, failed epochs, CAS races and refresh failure.
  It uses the real status/metric helpers, checks preservation of other issue
  decisions, and proves that a dismissal's nodes and edges equal its baseline.
  No issue is marked resolved while its write is still pending. Manual ignore
  still works independently without a snapshot or model request.
- The first verification-suite run caught a brittle global source-pattern
  count after the shared helper gained a second outcome. The assertion now
  checks both workbench mutation handlers individually; its stale-report
  requirement remains intact, and behavioral tests additionally distinguish
  repair from report-only dismissal. The corrected suite passed inside the
  first full `npm test` run. The final complete rerun after the browser-discovered
  banner fix also passed (exit 0), including generated ontology checks and
  signed payload parity/stale-payload rejection. The environment's pre-existing
  npm `allow-scripts` configuration and experimental SQLite warnings remain;
  no project analyzer warning was suppressed. `git diff --check` passed.
- Real browser verification used `kg-verification-ui-fixture.mjs --review-dismiss`
  with 803 nodes in an owned temporary SQLite store and a controlled non-network
  model. Changing hidden `n801`, paging away/back and confirming the old verdict
  showed an actionable dependency alert: zero commits, revision 2 and all four
  issues still open.
- A fresh verdict remained usable after an unrelated `n700` edit. An injected
  write rejection kept revision 3 and all issue statuses unchanged; retry saved
  only `n0`'s rejection at revision 4. Reload preserved it. A second explicit
  review of `n2` exercised failure/retry with the final banner fix: failure kept
  the issue open at revision 4; success reached revision 5 and cleared all
  error alerts. Final statuses were rejected/open/rejected/open.
- Across both saved dismissals, the nodes/edges SHA-256 stayed
  `51eede54f1cc047cf8b638b462b0b9c6c8f0baec2f0a254e05b202ea18004db6`.
  Four commit requests comprised two injected failures and two successful
  report-only writes. Three explicit mock reviews were made; confirmation and
  retry made no extra model request. Existing source quotes and the unrelated
  edit were preserved.
- Desktop 1440x1000 and mobile 390x844 screenshots were inspected. Mobile
  scroll width was 375, within its 390 viewport; browser console/runtime errors
  were empty. Reload retained revision 5 and both rejection explanations.
  Artifacts are under
  `output/playwright/review-dismiss-{hidden-conflict,persisted-desktop,persisted-mobile}.png`.
  The named browser and owned fixture server were closed after verification.
- The extension was repacked with the existing external identity, without
  installing new dependencies or changing any gate. Published baseline
  `9370c3a` still has successful remote trust-gate run `36218973754`; production
  remained on main with its prior untracked output directory and service PID
  1625652. No commit, push, merge, restart, paid model call or production graph
  mutation was performed.

## Round 8: Trajectory Write-Queue Failure and Session Ownership

While tracing trajectory review read/save boundaries, the lower-level commit
queue exposed a separate persistence risk. `kg-commit-queue-smoke.mjs` was
extended to execute both real workbench persistence handlers. Before the fix,
the trajectory case failed: the first write was rejected, but the dependent
second write still returned a successful revision-2 receipt rather than being
abandoned. Its payload retained the rejected optimistic change. Meanwhile the
first failure restored the old view, so later canonical writes could disagree
with the visible rollback.

Trajectory writes now capture a queue epoch and session/document ownership.
An unconfirmed write invalidates dependent queued edits and removes their
pending semantic operations. Fresh edits after rollback can still proceed.
Session switches start an independent queue, and unmount invalidates only
undispatched work; an already-dispatched authorized request may finish, but its
late result cannot change the new session's revision, UI or saved references.
The prior failed-chain banner is cleared only by a confirmed fresh write, without
clearing errors belonging to unrelated tasks.

Verification:

- The production-handler queue regression passed for both workbenches. It
  checks ordered successful revisions, a rejected baseline stopping its
  dependent write, rollback to the original graph, removal of abandoned
  operations, no unconfirmed history writes, and successful fresh editing.
  Trajectory transport loss, missing receipts and foreign-document receipts
  likewise stop the dependent queue. A second red assertion proved the stale
  failure banner persisted after a fresh successful write; the scoped banner
  cleanup now passes and retains unrelated task errors.
- `kg-trajectory-client-smoke.mjs` runs the full production component and its
  actual restoration/session/unmount effects, for both dynamic source and the
  generated persistent client. Eight delayed-response scenarios cover
  session-switch/unmount crossed with accepted/rejected old responses. New
  session writes use their own revision without waiting for the old network
  request. Old queued edits never dispatch, late responses do not overwrite
  saved references, and the new document/report remains intact.
- The existing pinned trajectory report-save regression still passes for valid,
  malformed, rejected and switched-view receipts. No acknowledgement checks
  were removed or weakened.
- Real browser verification used `kg-verification-ui-fixture.mjs --trajectory-queue`
  on its trajectory tab, with an owned SQLite store and 37 nodes. The first
  manual ignore was held before the host could save it; a second ignore was
  queued. Both were optimistic in the UI, while the store retained four open
  issues at revision 1 and only one HTTP commit request existed.
- Rejecting the held request restored both visible issues to open. The store
  remained at revision 1 with all four issues open; the second commit was never
  sent. A new third-issue ignore then saved at revision 2 with statuses
  open/open/rejected/open. The first two changes did not leak into that fresh
  commit, and the failed-chain alert cleared. Reload preserved those statuses.
  Browser model calls, question requests and extraction submissions all stayed
  at zero.
- Desktop 1440x1000 and mobile 390x844 screenshots were inspected. Mobile scroll
  width was 375, within its viewport; runtime errors and console errors/warnings
  were empty. Artifacts are under
  `output/playwright/trajectory-queue-{rollback-desktop,recovered-desktop,recovered-mobile}.png`.
  The owned browser and fixture server were closed.
- `npm run build`, the three targeted queue/component/report regressions and
  the final full `npm test` passed (exit 0). Generated ontology checks and
  extension packaging checks passed, including payload parity and rejection of
  stale payloads. `git diff --check` passed; no owned workspace processes
  remained after verification. The trajectory code is outside the extension
  viewer payload; no new signing identity or packaging exception was introduced.
- Original release `9370c3a` still has successful remote CI run `36218973754`,
  production remains on main and the authorized service process remains PID
  1625652. No further commit, push, merge, service restart, paid model call or
  production graph/report mutation occurred.

## Round 9: Canonical Trajectory Review and Confirmation

The trajectory question caller still supplied only its renderer window. A new
counterexample runs that exact handler through the actual host into a controlled
LLM. Before changing production code, it failed because the model did not see
the hidden n1-to-n3 relation or n3, although both existed in the canonical graph.
The host cannot reconstruct incident relationships discarded by its caller.

Trajectory questions now resolve referenced partial-window context from a paired
canonical graph/source export after pending writes settle. AI issue reviews also
bind the current report, open issue, complete dependency signature and source
hash. The existing pure neighborhood/source selection is shared with the
document workbench, including its pre-model incomplete/oversized context guards.
Off-window issue targets go through this canonical admission rather than first
pretending a target-only display window is sufficient evidence.

Confirming a trajectory repair or AI false-positive dismissal re-reads that
context and report, then saves against the exact inspected revision. Unrelated
edits remain reusable without another model request, while evidence changes,
changed allegations/reports and resolved issues stop the save. Report changes
are not presented as saved until an authoritative receipt/readback succeeds.
Save ownership is session-scoped; late cleanup cannot release a newer session's
save lock. The recheck success toast now follows actual task admission.

Verification:

- The original model-boundary counterexample passes against dynamic and
  persistent hosts. Ordinary and review retrieval limits remain unchanged.
- Question snapshot tests now cover both callers: full/scoped paired source,
  source/graph/revision identity, pending writes, queue changes, failed commits,
  navigation and admission cleanup. Review-save tests run repair and dismissal
  against both workbenches, including hidden dependencies, unrelated status
  changes, malformed exports, source/report changes, duplicate confirmation,
  revision conflicts, readback failure and session ownership.
- Real-browser testing exposed a second integration issue: rejecting a pinned
  canonical repair replaced the 800-node window with the full 803-node graph.
  A new red queue assertion reproduced it. Pinned writes are not optimistic, so
  rejection now preserves the existing view/report. Unpinned optimistic queue
  rollback is still required and tested; receipt/error checks were not weakened.
- The final browser fixture used its own 803-node SQLite graph. Changing hidden
  n801 after review stopped confirmation at revision 2 with zero commits and
  all four issues still open. A fresh review followed by an unrelated n700 edit
  and an injected save rejection retained revision 3, all open issues, and the
  800-node display window. Retrying the same decision saved n0 at revision 4
  without another model request and preserved the n700 edit.
- A controlled AI false-positive decision for n2 then saved at revision 5.
  Node/edge content hash was unchanged by dismissal. Reload retained statuses
  applied/open/rejected/open and the repair history. The final fixture recorded
  three controlled model calls, three confirmation requests (one rejected),
  seven canonical exports and no extraction submissions.
- Desktop 1440x1000 and mobile 390x844 screenshots were inspected. Mobile
  scroll width was 375; runtime errors and console errors/warnings were empty.
  Evidence is under
  `output/playwright/trajectory-review-{hidden-conflict,persisted-desktop,persisted-mobile}.png`.
  Both owned fixture instances and the named browser were closed.
- Build, targeted tests and the final full `npm test` passed (exit 0), including
  generated ontology checks and extension payload parity/stale-payload rejection.
  `git diff --check` passed. No new dependency, signing identity or weakened
  packaging gate was introduced. The extension viewer is outside this change.
- Original release `9370c3a3104c580f6164421b0e29edb294484adc` still has a successful
  completed GitHub trust-gate in run `36218973754`. Production service remains
  PID 1625652, started at 12:50:57 CST. No new commit, push, merge, restart,
  paid model call or production graph/report mutation occurred.

## Round 10: Preserve Required Evidence Under Source Limits

Source scoping previously selected keyword matches before graph evidence and
silently skipped an oversized required source unit. The host then filtered out
nodes without retained source paragraphs, along with their incident relations.
A real-host counterexample with n1 connected to n2 and only n1's source supplied
made a controlled model request instead of rejecting incomplete review context.
The companion client test failed because an oversized required unit did not
raise an error. These were reproduced before the behavior was changed.

AI issue review now gives declared node, edge and issue evidence priority over
optional retrieval context. Missing required units, the character budget and
the unit-count budget fail before model admission rather than silently reducing
the graph. Unanchored neighbors remain in the review graph as data to examine.
The model prompt includes declared distant node/edge evidence, not just primary
anchors. Raw-source inputs and the final assembled prompt also enforce the
review source budget. Ordinary exploratory questions retain their existing
retrieval behavior. Intrinsically oversized review context is still rejected;
this change does not claim to implement multi-pass review.

Verification:

- Dynamic and persistent host tests cover omitted node, relation and issue
  evidence; raw and scoped source; oversized mandatory units; more than 2,000
  required units; optional transport ordering; unanchored neighbors; distant
  declarations reaching the actual model prompt; and the exact 240,000-character
  boundary. An oversized quote line is used for the raw-source boundary because
  ordinary long prose is legitimately split into multiple source units.
- Main and trajectory callers both reject incomplete evidence without a
  question request. Batch planning records the failing item and continues
  independent items instead of pausing the whole group. Existing in-flight task
  references remain preserved and paused rather than being overwritten/retried.
  A red batch assertion demonstrated the former whole-group pause before the
  source planner was moved inside the per-item validation boundary.
- Real-browser verification used the full generated client and persistent host
  with `kg-verification-ui-fixture.mjs --source-limit`, an owned temporary SQLite
  graph, and a controlled model. Clicking n0's AI review showed a clear source
  limit alert with zero model/question requests and zero graph commits.
  Reviewing all four items then finished 4/4: one source-limit failure, one
  repair, one false positive and one uncertain result, all waiting for user
  confirmation. Exactly three controlled requests were made for the independent
  items. No confirmation was clicked; revision remained 1 and all issues open.
  The trajectory caller independently showed the same pre-admission guard,
  without increasing the three model calls. There were no runtime errors;
  mobile scroll width was 375 at viewport width 390.
- Desktop and mobile captures were inspected at
  `output/playwright/review-source-limit-desktop.png` and
  `output/playwright/review-source-limit-batch-mobile.png`. The fixture and owned
  browser were closed after testing.
- The final full Node 24 `npm test` passed (exit 0), including generated-source
  checks, ontology checks, signed extension payload parity and stale-payload
  rejection. Log: `output/round10-npm-test.log`. `git diff --check` also passed.
  Existing npm allow-scripts configuration warnings and Node's experimental
  SQLite warning remain environmental; no analyzer or packaging gate was
  suppressed. No signing identity or dependency was introduced.
- Production remains on the original release. GitHub run `36218973754` for
  `9370c3a3104c580f6164421b0e29edb294484adc` was checked as completed/success at
  this round's start. The service is a **user** unit: `systemctl --user show`
  confirms active/running, PID 1625652, original start 12:50:57 CST. No commit,
  push, merge, production restart, paid model call or production data write
  occurred. All continuation changes remain unpublished in the isolated branch.

## Round 11: Keep Canonical Source-Unit Boundaries

Reproduced another model-boundary error before changing production code: a
scoped code unit was trimmed and joined with another source unit, then treated
as a new document and segmented again. The following unit's local number now
pointed into the code instead of its own source. A controlled, correct citation
therefore produced `uncertain` instead of `false_positive`. A stronger case
uses an unindented line inside a mixed code block: preserving whitespace alone
cannot recover its original boundary once that line is selected in isolation.

Prepared scoped inputs now retain exact unit text and explicit unit lengths.
Those lengths reconstruct offsets without guessing segmentation. Questions,
issue review, repair-evidence validation, quick local validation, deep-review
batches and quote-based fact-check anchors use this same representation. The
latest-source invariant cache includes the boundary identity, so an identical
text string cannot reuse an index built for a different scope. Raw input and
client scoping also preserve source indentation.

Scoped verification checkpoints persist and hash the boundaries, including
when switching models during resume. Old full-source checkpoints retain their
existing hash and recovery behavior. Legacy scoped checkpoints without boundary
metadata are explicitly rejected for continuation, with their saved work left
intact; the old concatenated text cannot reliably prove where those units were.
This is not a migration or rewrite of any production report/checkpoint.

Verification:

- The red model-boundary case now passes against both dynamic and persistent
  hosts. Tests also prove that a code quotation falsely paired with the next
  paragraph is rejected, while a legitimate relation repair retains its
  canonical evidence paragraph. Reverse transport ordering, quick checks,
  deep batches, ordinary scoped questions and external-claim quote lookup all
  retain the same paragraph identity.
- Actual client source selection retains indentation using the real canonical
  segmenter. Invariant-cache tests switch between full and scoped interpretations
  of identical text, mutate a boundary array in place, and reject malformed,
  fractional, non-finite, over-budget and separator-inconsistent boundaries.
  Repeated normal validation still parses only once and caches only one source.
- An isolated SQLite test pauses a three-batch scoped review after saving its
  first batch. Tampered boundaries and a legacy scoped record both fail without
  another model request, changing paused state or deleting the saved result.
  Restoring the valid checkpoint on a fresh host and selecting a different
  fixture model resumes exactly the remaining two batches with identical source
  labels. Existing full-source pause/recovery/model-provenance tests still pass.
- Real-browser testing used `kg-verification-ui-fixture.mjs --source-boundary`
  with a mixed code block and enough source to force scoped transport. Both
  document and trajectory workbenches displayed the controlled n3 verdict with
  the correct original paragraph 4, not the neighboring code text. There were
  two controlled model requests, no commits, no pending streams, revision 1 and
  all four original issues still open. No confirmation/dismissal was clicked.
  The mobile screenshot `output/playwright/review-source-boundary-mobile.png`
  was inspected; width 390 had scroll width 375 and no runtime errors. The named
  browser and fixture process were closed.
- Targeted tests and the final full Node 24 `npm test` passed (exit 0), including
  ontology and signed extension payload parity/stale-payload checks. Log:
  `output/round11-npm-test.log`. `git diff --check` passed. No dependencies,
  signing identities, schema migrations or relaxed gates were introduced.
- GitHub run `36218973754` was independently rechecked as completed/success for
  release `9370c3a3104c580f6164421b0e29edb294484adc`. The user service remains
  active/running, PID 1625652, original start 12:50:57 CST. No continuation commit,
  push, merge, production restart, paid model invocation or production graph /
  report / task modification occurred.

## Round 12: Whole-Graph Verdicts Require Whole-Graph Context

The new adversarial assertion failed at the actual dynamic model boundary
before changing production code: reviewing a summary allegation without node
IDs produced **zero prompt nodes**, rather than the fixture's six, and only
the allegation's evidence paragraph. The host used lexical question retrieval
before adding that paragraph, then allowed a definitive issue verdict. The
same retrieval path also omitted unrelated nodes when a graph-wide allegation
named particular examples. A conclusion about the entire graph cannot be
grounded by treating that incomplete search result as the whole graph.

Graph-wide issue reviews now take a distinct complete-context path:

- Document and trajectory clients export the paired canonical snapshot even
  for allegations with no node references. A small complete graph can therefore
  be reviewed from a partial display window without pretending the window is
  authoritative. Named examples do not narrow a graph-wide allegation.
- Complete nodes and relations, including their full fields, are included in
  the host prompt along with every original source unit. Unanchored source
  paragraphs can contain qualifications and cannot be discarded as irrelevant.
- Known partial graphs, missing relation endpoints, more than 96 nodes or 512
  relations, scoped source transport, more than 2000 source units, oversized
  raw source, and a complete serialized prompt over 240000 characters fail
  before model invocation. The error requests a concrete node/relation scope;
  nothing is silently clipped. These are single-issue review limits, not new
  limits on the existing multi-batch full-graph audit.
- Batch planning records an over-budget item as failed without an AI verdict,
  continues independent items, and preserves an already admitted task for
  explicit recovery instead of replacing or cancelling it. Ordinary exploratory
  questions and existing node/edge review behavior remain separate.

Verification:

- Expanded exact-client-handler tests passed for document/trajectory review,
  canonical expansion without IDs, disconnected nodes, source/node/edge limits,
  batch continuation, and in-flight task preservation.
- Actual dynamic and generated persistent hosts passed full source/node/edge
  preservation tests, including an unanchored paragraph 304, node qualifiers
  beyond the former 200/300-character clips, required relation evidence,
  unsupported source fragments, dangling endpoints and prompt-size rejection.
  Exact 96-node and 512-edge boundaries remain usable. A whole graph containing
  25 named examples stays whole; it does not use the ordinary reference cap.
- `npm run build`, the two expanded regressions and the full verification suite
  passed. Verification suite log: `output/round12-verification-test.log`.
- Real browser fixture `--graph-review` used a temporary SQLite store and a
  controlled non-network model. Document and trajectory AI review each received
  all 37 graph nodes and 38 original source units, including the unanchored tail.
  The returned citation displayed as original paragraph 38. Two model requests,
  zero commits, revision 1 and four open issues were confirmed.
- Browser fixture `--graph-review --source-limit` showed the complete-source
  error before any question/model request. Batch review then reported one
  failed whole-graph item and three independently completed items, waiting for
  confirmation. Exactly three controlled model requests, zero commits, revision
  1 and four open issues were confirmed. The existing graph was never changed.
  Both owned fixtures and the named browser were closed afterward.
- Screenshots are under `output/playwright/review-whole-graph-desktop.png`,
  `review-whole-graph-trajectory-mobile.png`, and
  `review-whole-graph-limit-batch-mobile.png`. Both mobile views were inspected:
  width 390, scroll width 375, readable errors/evidence and no runtime errors.
- The final full Node 24 `npm test` passed (exit 0), including generated ontology,
  signed extension payload parity and stale-payload rejection. Log:
  `output/round12-npm-test.log`. `git diff --check` passed. Existing npm
  `allow-scripts` and Node experimental SQLite warnings remain environmental;
  no dependencies, signing identities or weakened gates were introduced.
- Original release `9370c3a3104c580f6164421b0e29edb294484adc` was independently
  rechecked at this round's start: GitHub run `36218973754` completed successfully.
  Production still has only its pre-existing untracked output directory, and
  the user service remains active/running, PID 1625652, start 12:50:57 CST.
  No new commit, push, merge, production restart, paid model invocation, or
  production graph/report/task modification was performed.

## Round 13: Do Not Review Clipped Claims

Reproduced the targeted node/edge path left open in round 12. Before the fix,
`runQuestionTask` turned a node's text into a 200-character preview and its
quotation into a 300-character preview, and omitted node and relation evidence
fields. A node already qualified its conclusion as applying to adults, not
children, but the qualification was after the clipped prefix. A controlled
model that judged exactly the transmitted claim returned `confirmed` and a
repair, instead of `false_positive`. The original failing assertion is saved
in `output/round13-field-context-red.log`.

Targeted issue review now preserves complete fields for all nodes and relations
in its already-bounded review neighborhood. It no longer uses display previews
as semantic input. The entire serialized user payload is checked against the
240000-character budget for every issue-review scope, including JSON escaping,
source, graph and allegation overhead. Oversized content is rejected before
model invocation, rather than shortened into a different claim. This does not
change ordinary exploratory question retrieval or multi-batch deep auditing.

A second adversarial assertion showed that the follow-up repair request could
exceed the same budget after appending the model's verdict and evidence: two
requests were observed where only the first fit. That red result is saved in
`output/round13-repair-budget-red.log`. Follow-up repair now also checks its
complete payload. If it does not fit, the independent verdict and evidence are
retained, no second model request is made, no patch is invented, and the result
reports `repairStatus: context_limit`. The single-item panel explains this
specific outcome and does not recommend an unchanged immediate retry.

Verification:

- Actual dynamic and generated persistent hosts passed the expanded regression
  for node and edge targets: long claim qualifiers, long quotations, complete
  node/relation evidence, oversized individual fields and JSON escaping.
  Exactly 240000 serialized characters remain accepted; 240001 fail before a
  model request. Source that alone fills its 240000-character limit is now
  correctly rejected when the required graph/instructions would exceed the
  combined budget, rather than dropping those fields to fit.
- The repair-overflow test preserves a confirmed verdict and its evidence with
  no proposed patch and exactly one controlled model call. Existing short repair
  generation, source identity, snapshot, canonical context, task ownership and
  confirmation tests passed in the full verification suite. Log:
  `output/round13-verification-test.log`.
- Real browser fixture `--review-fields` sent the full 315-character claim,
  373-character quotation and relation evidence, including the qualification.
  Single-item review displayed the independently controlled false-positive
  result and correct source citation. Batch review completed four items with
  one proposed repair, two suspected false positives and one uncertain item.
  The five total controlled requests included the prior single review; zero
  commits, revision 1 and four open original issues were confirmed.
- Browser fixture `--review-repair-limit` sent a complete 239414-character
  initial prompt. Its first controlled verdict was retained, but appending the
  repair input would exceed the budget. The browser displayed the budget reason
  and no unchanged retry button. Each single-item attempt made exactly one
  model call. Batch review likewise preserved this manual item and completed
  the other three, with four calls and no follow-up call for the blocked repair.
  After two single reviews and the batch there were six model calls, zero
  commits, revision 1 and four open original issues.
- That fixture also exposed a real rendering bug: a 1900-character unbroken
  model answer expanded a 390-pixel mobile page to scroll width 12079.
  `.kg-question-result` now sets `overflow-wrap: anywhere`, inherited by its answer.
  A regression assertion was added and the same browser scenario was repeated:
  mobile width 390 / scroll width 375, desktop width 1440 / scroll width 1425,
  no runtime errors. The inspected mobile viewport showed intact evidence and
  the budget explanation without horizontal overflow or overlapping controls.
- Screenshots: `output/playwright/review-complete-fields-desktop.png`,
  `review-repair-budget-desktop.png`, `review-repair-budget-mobile.png`, and
  `review-repair-budget-mobile-viewport.png`. Both owned fixture servers and the
  named browser were closed; no production task was used for these checks.
- Generated library/viewer assets were rebuilt. The changed extension payload
  was repacked with the existing external identity using the locked local
  packer, with no dependency installation, new identity or relaxed gate.
  The final full Node 24 `npm test` passed (exit 0), including generated ontology
  checks, signed payload parity and stale-payload rejection. Log:
  `output/round13-npm-test.log`. `git diff --check` passed. Existing npm
  `allow-scripts` and experimental SQLite warnings remain environmental; no
  project analyzer warning was suppressed.
- Published baseline `9370c3a3104c580f6164421b0e29edb294484adc` was independently
  checked at this round's start: GitHub run `36218973754` is completed/success.
  Production HEAD and origin/main still equal this release, with only the
  pre-existing untracked output directory. The user service remains active /
  running, PID 1625652, original start 12:50:57 CST.
  No continuation commit, push, merge, production restart, paid model call or
  production graph/report/task modification was performed.

## Round 14: Preserve Repair Meaning Before Confirmation

Proved the output-side risk identified in round 13. `sanitizeFix` silently
clipped proposed node text to 500 characters, quotation to 600, and summary to
500. A controlled model proposed a 651-character repair with the essential
adult-only qualification at the end. The host returned just the first 500
characters, turning that proposal into a different claim before confirmation.
The original failing assertion is preserved in
`output/round14-repair-patch-red.log`. This was not just a display preview:
the client applies the normalized text and the canonical store persists it.

Normalization now keeps a valid field whole or rejects the entire proposal.
The existing 500/600 limits are retained, not expanded or bypassed. A coupled
type/text or text/quote proposal cannot partially apply after a field exceeds
the limit. Summary repair uses the same policy, including legacy node-patch
fallback; null/blank legacy patches yield `none` rather than throwing or
producing an empty summary. The limit and preservation of negations, conditions
and scope are now explicit in both ontologies' deep-review/question prompts,
independent issue review, and the existing second repair pass. That bounded
second pass can regenerate a complete concise repair; repeated invalid output
keeps the confirmed issue and evidence but offers no executable patch.

Verification:

- Actual dynamic and generated persistent hosts passed the red/green regression,
  UTF-16 exact 500/600 boundaries and one-unit overflow, surrogate-pair boundary,
  coupled-field rejection, add/delete-node and summary variants, null/blank
  legacy summary payloads, and existing empty-quote behavior. Both ontologies'
  ordinary questions and independently confirmed deep-review issues retain the
  issue but reject the oversized proposal. Two-pass issue review produced a
  complete 56-character adult-only repair, with exactly two controlled calls.
  Log: `output/round14-repair-patch-green.log`.
- `npm run build` and the complete verification-specific suite passed. Log:
  `output/round14-verification-test.log`. No model, ontology, or persistence gate
  was relaxed to accommodate a rejected proposal.
- Real browser fixture `--repair-patch-limit` used the production client/host
  against an owned temporary SQLite database and controlled non-network model.
  Single review rejected two successive 651-character proposals, retained the
  confirmed verdict/evidence, displayed the unsuccessful-generation reason and
  offered no confirmation action. Two model calls, zero commits, revision 1.
- Four-item batch review then classified one unrepairable confirmed item, one
  concise valid repair, one suspected false positive and one uncertain issue.
  The unsafe item was not silently shortened and did not block the independent
  valid repair. The expanded preview displayed the full adult-only restriction.
  Confirmation made exactly one fixture commit: n1 was repaired, n2 was marked
  rejected, n0/n3 remained open. Eight total controlled model calls included the
  earlier single-item attempt. Revision became 2 and stayed 2 after reload;
  neither reload nor confirmation invoked another model.
- Canonical readback proved n0 was byte-for-byte unchanged and n1 retained the
  exact concise text, quote, type and paragraph. Its existing evidence gained
  document/source IDs through the normal canonical provenance normalization;
  an initially over-strict byte comparison exposed only that expected metadata
  addition, not a lost or changed quotation. The refined comparison checked the
  exact metadata addition, not arbitrary differences. Reload preserved the
  target text and all four issue statuses.
- Inspected screenshots: `output/playwright/repair-patch-batch-desktop.png`
  and `repair-patch-batch-mobile.png`. The separate rejected single-item capture
  is `repair-patch-rejected-desktop.png`. Desktop width 1440 / scroll width 1425
  and mobile width 390 / scroll width 375; no runtime errors, overlapping
  controls or horizontal overflow. The owned browser and fixture were closed.
- The first full `npm test` stopped at the existing combined dynamic timeout
  assertion in `kg-timeout-cancellation-smoke.mjs`; its original message did not
  distinguish elapsed time from missing provider abort. The failure is retained
  in `output/round14-npm-test.log`, not treated as a pass. Added only failure
  diagnostics (elapsed time, calls, aborts), retaining the identical 800 ms
  threshold and abort requirement. A fresh isolated run passed with dynamic
  timeout 42 ms, cancel 5 ms, and persistent timeout 42 ms. Log:
  `output/round14-timeout-investigation.log`. This does not establish the cause
  of the original failure or prove that intermittent scheduling risk is fixed.
- Fresh full Node 24 `npm test` passed (exit 0), including generated ontology,
  signed payload parity and stale-payload rejection. The dynamic and persistent
  timeout checks both completed in 42 ms in this run. Log:
  `output/round14-npm-test-confirmation.log`. The earlier failure is retained as
  an unexplained intermittent observation, not erased by the passing repeat.
  `git diff --check` passed. Existing npm `allow-scripts` and experimental SQLite
  warnings remain environmental; no project analyzer warning was suppressed.
  No new extension identity, repack, or dependency installation was needed for
  this host-only repair validation change.
- Original release CI was independently checked: GitHub run `36218973754` for
  `9370c3a3104c580f6164421b0e29edb294484adc` is completed/success, including the
  explicit `trust-gate` job. Production HEAD/origin/main still match that SHA,
  with only its pre-existing untracked output directory. The user service is
  active/running at original PID 1625652, start 12:50:57 CST. No new commit, push,
  merge, production restart, paid model call, or production graph/report/task
  modification was performed.

## Round 15: Keep Departed Saves Out of the Current Queue

Followed manual issue dismissal through `handleRejectIssue`, `attachReport`,
`persistGraph`, its queued write and failure callback. The workbench shared a
single queue/epoch between loaded documents. A held save for document A could
fail after navigation to B; its catch incremented the shared epoch before the
document check. B's independent queued edit was then silently abandoned, while
B's optimistic "ignored" status remained visible. No B write or error reached
the user. The exact-handler red assertion is retained in
`output/round15-navigation-queue-red.log`.

Reproduced the same failure in a real browser with two isolated documents.
Clicked Ignore in A, held that request, opened B via the actual History panel,
ignored another issue and then rejected A's held request. The browser displayed
B's issue as ignored, but SQLite still had four open issues and revision 1 for
both documents; only the A commit request had been sent. Zero model requests
were involved. Browser evidence: `output/round15-browser-navigation-red.log`.

The workbench now starts a new commit queue/epoch when a history document has
actually loaded, when starting a new replacement graph, or when resetting the
workbench; unmount also invalidates ownership. Every queued dispatch and late
receipt/error verifies epoch and document ownership. Departed queued edits are
not sent, already-dispatched writes may settle without affecting the new UI,
and a late old failure cannot invalidate current edits. An old success cannot
advance a reloaded document's revision, repopulate history, or report success
through the old callback. Current-document failures still roll back and stop
their genuinely dependent optimistic edits.

The queue boundary is deliberately not coupled to verification cancellation.
History-load failure, starting an append, or changing an AI task must not leave
an optimistic current graph without its save-failure rollback. Only successful
history replacement resets that queue; an adversarial failed-load case keeps
the old ownership and confirms that a subsequent save failure still rolls back.

Verification:

- Expanded `kg-commit-queue-smoke.mjs` runs the actual history loader, reset
  helper and persist function. Covers different-document and same-document
  reloads, late failure/success/missing receipt, skipped old dependents, fresh
  writes proceeding before the old receipt, preserved revision/history/UI and
  semantic-operation cleanup. Failed navigation preserves the original queue.
  Existing document and trajectory successful/failed-chain cases still pass.
  Logs: `output/round15-navigation-queue-green.log` and
  `output/round15-large-queue-test.log` (`npm run test:kg-large`).
- `kg-paragraph-remove-smoke.mjs` passed, including pinned canonical saves,
  whole/windowed graphs, failed writes and revision handling. Log:
  `output/round15-pinned-save-test.log`. Generated artifacts were rebuilt.
- Repeated the browser scenario on a fresh owned SQLite fixture after the fix.
  B's Ignore reached SQLite and revision 2 while A's first request was still
  held. Releasing A's failure neither rolled back B nor displayed A's error.
  A hard browser reload and reopening B preserved its ignored issue. A further
  Ignore succeeded at revision 3, retaining the earlier ignored status. A stayed
  revision 1 with all issues open. Three commit attempts total (one deliberately
  failed in A, two successful in B), zero model calls, zero runtime errors.
  Evidence: `output/round15-browser-navigation-green.log`.
- Inspected `output/playwright/manual-ignore-navigation-desktop.png` and
  `manual-ignore-navigation-mobile.png`: the confirmed ignored status and other
  actions remain readable. Desktop width 1440 / scroll width 1425; mobile width
  390 / scroll width 375. Both owned fixture servers and the browser were closed.
- Full Node 24 `npm test` passed (exit 0), including verification, canonical
  snapshot/review saves, both queue implementations, generated ontology and
  signed extension payload parity/stale-payload rejection. Log:
  `output/round15-npm-test.log`. The round-14 timeout assertion did not recur:
  dynamic timeout 43 ms, persistent timeout 44 ms, both with provider aborts.
  `git diff --check` passed. Existing npm `allow-scripts` and experimental SQLite
  warnings remain environmental; no analyzer warnings or gates were suppressed.
  No signing identity, repack, or dependency installation was needed for this
  workbench-only lifecycle change.
- Original release `9370c3a3104c580f6164421b0e29edb294484adc` still matches
  production HEAD and origin/main. GitHub run `36218973754` and its explicit
  `trust-gate` job `108340494930` were checked independently: completed/success.
  Production retains only its pre-existing untracked output directory. The user
  service remains active/running, original PID 1625652 and 12:50:57 CST start.
  No continuation commit, push, merge, production restart, paid model call or
  production graph/report/task modification was performed.

## Round 16: Bind Quick Reports to Their Reviewed View and Saved Revision

Traced the separate late producer identified in round 15: both document and
trajectory `startQuickVerify` handlers awaited a quick report, then called an
optimistic report attachment using the opening render's graph. Neither result,
error nor finally checked navigation ownership. The save queue's dispatch guard
was too late to protect the preceding UI update. A delayed A report could replace
B's graph/report while B's title stayed visible; the old finally could also
release a new verification's busy state. Completion was announced without
waiting for report persistence.

The exact-handler red test replaced document A with B during the request. It
observed A's revision 1 graph/source/report replacing B's revision 4 view. Log:
`output/round16-quick-lifecycle-red.log`. Independently reproduced the user-facing
failure in a real browser: started A's current-window check, held its response,
opened B through History, and released A. B's title remained visible with the
unrelated 707-warning quick report. Both SQLite documents still had their original
four-issue report at revision 1, with zero commits and zero model calls. Evidence:
`output/round16-browser-quick-red.log`. This was a false UI result, not proof that
an old report had actually been saved.

Both quick handlers now retain generation, document/session and reviewed-view
ownership; wait for earlier saves; and verify the queue epoch and revision before
using a response. Changed views, source snapshots, revisions or queued edits
cannot receive the old report. Departed results, errors and finally blocks leave
the new view's task state alone. A canonical report is saved with the reviewed
revision before replacing the displayed report or announcing completion. Failed
or unconfirmed saves retain the original report and preserve the save error.
Late save acknowledgements cannot replace a reloaded view or intervening edit.
Unsaved local graphs can still receive a noncanonical quick report.

Verification:

- Added `kg-quick-verification-lifecycle-smoke.mjs` to the standard verification
  suite. It executes both real quick handlers and persistence implementations.
  Covers document changes, same-document reloads, unmounts, late report/error/
  rejected promise/missing response, replacement graph/source, revision drift,
  changed or failed queues, waiting for prior writes, delayed confirmation,
  transport failure, missing receipt, revision conflict, post-dispatch navigation,
  intervening edits and unsaved local graphs. Green evidence:
  `output/round16-quick-lifecycle-green.log`.
- Extended the owned SQLite browser fixture with a manually held quick-response
  control. After the fix, ignored n1 in B while A's report was held; B reached
  revision 2. Releasing A left B's original report and ignored status unchanged,
  and made no old report commit. A stayed revision 1. Evidence:
  `output/round16-browser-quick-navigation-green.log`.
- In B, held the subsequent quick report save: the original report remained
  visible, the check button stayed busy and no success appeared. Deliberately
  rejected the save; B stayed revision 2 with its old report and an explicit
  error. A fresh retry saved the new report at revision 3. Hard reload plus
  reopening B preserved the same report ID and graph content hash (the baseline
  hash was taken after the earlier manual ignore). Logs:
  `output/round16-browser-quick-pending.log`,
  `output/round16-browser-quick-save-failure.log`,
  `output/round16-browser-quick-saved.log`,
  `output/round16-browser-quick-reloaded.log`.
- Repeated held-save failure and successful retry through the real trajectory
  tab. Its original report survived the rejected save; the retry persisted at
  revision 2 and survived reload, without changing B's revision 3 report. Logs:
  `output/round16-browser-trajectory-pending.log`,
  `output/round16-browser-trajectory-failed.log`,
  `output/round16-browser-trajectory-reloaded.log`.
  This browser check establishes report durability, not byte-identical nodes:
  the trajectory's first full write changed its node hash. The existing host
  authenticates incoming evidence and fills document/source provenance on full
  writes; additional losslessness testing of that normalization remains separate.
- The corrected browser run used five local verification requests and five
  commit attempts (two deliberately rejected), with zero model calls and zero
  runtime errors. Inspected `output/playwright/quick-report-restored-desktop.png`
  and `quick-report-restored-mobile.png`: report metrics and controls remain
  readable, without overlap or horizontal page overflow. Width/scroll width
  were 1440/1425 and 390/375. Both owned fixtures and the named browser were closed.
- Fresh full Node 24 `npm test` passed, exit 0; log:
  `output/round16-npm-test.log`. Includes the new lifecycle test, canonical review
  snapshots, both save queues, ontology generation and signed extension payload
  parity/stale-payload rejection. The earlier timeout assertion did not recur:
  dynamic 42 ms, persistent 44 ms, with provider aborts. Generated artifacts were
  rebuilt; no extension repack, identity change or dependency install was needed
  for these workbench/trajectory lifecycle changes. `git diff --check` passed.
  Existing npm `allow-scripts` and experimental SQLite warnings remain; no test
  gate or analyzer warning was suppressed.
- Independently rechecked original release `9370c3a3104c580f6164421b0e29edb294484adc`:
  GitHub run `36218973754` and explicit `trust-gate` job `108340494930` remain
  completed/success. Production HEAD and origin/main match that SHA, with only
  its pre-existing untracked output directory. Service is active/running at
  original PID 1625652, start 12:50:57 CST. No new commit, push, merge, production
  restart, paid model call or production graph/report/task mutation occurred.

## Release Preparation After Explicit Authorization

The user subsequently authorized merging the isolated continuation into `main`,
pushing it and restarting 3099. A fresh pre-release Node 24 `npm test` passed
(exit 0), including all continuation regressions, generated artifact checks and
signed extension payload parity. Log: `output/release-20260926-npm-test.log`.
The remote and production baseline still matched `9370c3a` before integration.

Authenticated pre-restart inspection confirmed no active task or busy lock,
HTTP 200, two ontologies, one recoverable run and the original document at
revision 246 with 4,645 nodes and 8,539 edges. Graph, source, ontology and run
record hashes were captured for a read-only post-restart comparison. Release
receipts and probe outputs remain local under `output/release-20260926-*`;
temporary outputs, browser state, dependencies and signing material are not
part of the commit. New audit work after this publication still requires new
authorization before committing, pushing, merging or restarting production.

## Next Checks

1. Intrinsically oversized whole-graph issue review now fails explicitly; a
   resumable multi-pass synthesis strategy remains unimplemented.
   Separately inspect manual ignore/report updates for cross-session lost-status
   writes; their independence from AI snapshots is not proof of race safety.
   Round 15 proves save-queue isolation across actual document replacement and
   round 16 covers late quick-report producers, not all report writers. Inspect
   overlapping history-load responses and other asynchronous producers before
   claiming general navigation safety. Also prove whether report-only full writes
   can lose existing long quotations during `authenticateGraphEvidenceHost`;
   provenance metadata normalization alone does not prove semantic losslessness.
   Repair output text/quote/summary truncation is covered by round 14; ordinary
   exploratory-question input previews and partially ignored malformed
   non-string patch fields have not been claimed lossless. Prove a concrete
   semantic risk before changing these separate contracts.
2. Exercise delayed submission/navigation in an isolated browser fixture if
   browser-level evidence would add coverage beyond the exact handler tests.
   Also check that document-workbench recheck success toasts are emitted only
   after actual task admission, not before an asynchronous snapshot check fails.
   The trajectory caller now has that guard.
   The refreshed applied issue also still labels its already-applied patch as
   an old proposal requiring review; distinguish history from actionable work
   before changing that copy.
3. Continue one evidence-backed risk at a time. Preserve existing graph data,
   user edits, paid model budgets, and all current test gates.
   If the timeout assertion recurs, use the newly recorded elapsed/call/abort
   values to distinguish a scheduler delay from a provider-abort regression;
   do not increase deadlines or dismiss the failure as flaky without evidence.
