# Full-Graph Discovery Benchmark

The targeted issue-review benchmark asks the model to judge a **known
allegation**. Its false negatives cannot measure defects the audit never
mentioned. This separate evaluator measures whether a completed whole-graph
review *finds* a frozen set of source-grounded defects without being told their
allegations.

## Contract

1. Freeze a graph snapshot, every source paragraph, its canonical revision,
   and positive findings before the review. Each finding has an exact target,
   source quote, defect summary, and a labelled reviewer rationale. The
   fingerprint includes all of these fields. Codex's same-thread review is
   `codex-reviewed`, not independent human ground truth.
2. Run the ordinary full-graph verification path, not targeted `issue_review`.
   Capture the pre-run `document-export` graph and source units plus the final
   `task-status` result. The evaluator rejects any snapshot mismatch, failed or
   partial task, revision mismatch, or incomplete node, edge or source-unit
   coverage. For every captured run it also requires the declared model,
   completed Host report model and every `modelsUsed` batch to agree, and all
   completed batches to be accounted for. A partial run with zero issues must
   never score as zero defects.
   Controlled fixtures use an explicit `fixture` provider and Host report
   identity; a magic string cannot bypass the same provenance check.
3. Review **every AI issue** in the resulting report. Bind each candidate to
   one gold finding or mark it `false_alarm`/`uncertain`, with a written
   rationale. The decisions are fenced by both the gold hash and the complete
   report hash. Local deterministic issues are counted separately, not credited
   as model discoveries. Repeated reports of the same finding count once plus
   a duplicate; unmatched gold findings are misses. Adjudication schema 2 also
   requires a separate `repairReview` for every AI candidate: `not_proposed`,
   `source_supported`, `not_justified`, `source_unsafe`, or `uncertain`, each
   with a rationale. A false allegation cannot authorize a corrective edit.

The result reports discovery recall on the **frozen positive findings**,
adjudicated precision on determinate AI candidates, duplicates, uncertain
candidates and local issues excluded. It cannot estimate true negatives over
all possible statements or claim live-book accuracy from synthetic cases.
The report also exposes measured request and input/output token counts when
the Host reports every request. Missing or partial accounting stays `null`,
never an invented zero. `elapsedMs` is only present when both capture times
exist; older saved runs may have token counts but no wall-time measurement.
`cost.complete` describes token-accounting completeness, not monetary price
or a controlled latency comparison.
Alternative model descriptions whose target differs from the frozen finding
are not silently auto-matched; the gold target must be revised and re-frozen
with an explicit rationale if equivalence is established.

Repair review is deliberately separate from discovery. `source_supported`
means the reviewer found the proposed edit supported by the frozen source; it
does **not** mean a Host preview succeeded, a transaction persisted, the edit
does not conflict with other edits, or it may be automatically applied. An
unnecessary but source-faithful rewrite is `not_justified`, not
`source_unsafe`. A plausible edit whose necessity is unresolved remains
`uncertain`; it is not counted as an approved repair. The evaluator checks
review completeness and report identity, not the truth of a Codex judgement.

`scripts/kg-discovery-benchmark.mjs` accepts `--gold`, `--capture` and optional
`--adjudication`/`--output`. Without adjudication it emits the exact candidates
and hashes needed for a review sheet; it does not invent labels. With complete
adjudication it scores the frozen report. The synthetic Chinese source fixture
is `scripts/fixtures/kg-discovery-source-zh-v2.json`; the immutable Host export
used for scoring is `scripts/fixtures/kg-discovery-gold-zh-v2.json`.
`scripts/kg-discovery-benchmark-seed.mjs` rejects source-unit boundaries that
disagree with the actual Host splitter before writing SQLite. The live runner
`scripts/kg-discovery-benchmark-live.mjs` is pinned to isolated 3119 and
CommandCode DeepSeek V4.1 Flash. It verifies the current graph, source,
revision and full-coverage plan before admission; a pending task is recorded
before admission and never automatically readmitted after interruption.
It also compares the local generated Host build hash with the identity served
by the loaded 3119 process before and after task admission. The hash covers
the generated Host body and its generated store, Markdown and ontology modules.
A missing or stale identity fails closed before any new model request; an old
pending capture lacking that identity must be inspected rather than silently
resumed. This prevents accidental prompt-version misattribution when files
change without a service restart, but is not a cryptographic attestation of
the external DSH harness or model provider.

The targeted runner uses the same loaded-Host identity fence. For
CommandCode it also refuses any service port other than isolated 3119; the
model restriction remains DeepSeek V4.1 Flash. A local file hash cannot be
used to label a task that ran in an older process. Existing targeted captures
without a full Host build hash fail closed on resume.

## Verified Boundary

`scripts/kg-discovery-benchmark-smoke.mjs` covers complete-versus-partial
coverage, zero-discovery misses, false alarms, duplicate reports, target
mismatches, fabricated source quotes, unreviewed candidates and changed
report/source fingerprints. `scripts/kg-full-verification-smoke.mjs` also runs
the actual persistent Host full-verification path against an isolated graph
with one known invented node claim: a controlled model returning no AI issues
produces one discovery miss, not a misleading perfect result. These are
controlled synthetic checks, not a measured model score.

## Isolated Flash Discovery Run (2026-09-28)

The initial synthetic seed was invalid: the Host splits its first source unit
at the Chinese semicolon, shifting all later paragraph anchors. It was never
sent to a model. Version 2 uses four actual Host units, freezes the exported
graph and positive labels before the live call, and has an adversarial seed
test proving the old form is rejected before any database write.

On idle 3119, full verification of the v2 graph succeeded at revision 1 with
5/5 nodes, 1/1 edge and 4/4 source units. Its raw capture is
`output/discovery-zh-flash-20260928.raw.json`; same-thread Codex decisions are
`output/discovery-zh-flash-20260928.adjudication.json`, fenced by gold and
report hashes. The Host represents graph-wide AI issue targets as `null`; an
adversarial regression exposed the evaluator's earlier string-only assumption.
The evaluator now normalizes that one canonical graph-wide identity while
still rejecting missing node/edge targets. No second model run was needed.

Flash found all three frozen positive defects. Of five AI candidates, three
matched gold, one was judged a false alarm about a faithfully limited adult
fact, and one was left uncertain because it overlaps the causal-edge defect
but asks for an additional caveat node not required by frozen gold. Six local
rule findings were excluded. The report has 3/3 frozen-findings recall and
3/4 determinate-candidate precision **on this one invented graph only**.
The Host recorded two model requests and 2,553 input / 11,149 output tokens
(13,702 total). These are reported token counts, not a monetary estimate.
Two correct error findings had no proposed fix; no model patch was applied.
This does not measure book-level accuracy, independent human agreement, or
whole-product quality. More diverse source-backed discovery fixtures and
repair validation are still needed.

## Second Frozen Graph: Homonyms And Distant Limits

`scripts/fixtures/kg-discovery-source-zh-v3.json` was independently frozen
before the next Flash call. Its five Host-parsed units distinguish learning
transfer from moving classroom equipment under the same Chinese word, and
place the trial's negative comparison and duration limits away from the
overclaimed node. Gold contains two Codex-reviewed defects: an `is_a` edge
between the homonyms and a node that turns practice-group improvement into
all-student long-term improvement. An adversarial seed test now also rejects
graph evidence attached to the wrong source unit before touching SQLite.

On idle 3119, Flash completed 5/5 nodes, 1/1 edge and 5/5 source units. The
raw result is `output/discovery-zh-flash-v3-20260928.raw.json`; the report-hash
bound Codex decisions and score are adjacent in `output/`. Both frozen
defects were found. The two additional AI candidates were separately judged
one false alarm (a faithful, source-anchored practice-group fact) and one
uncertain (whether the P4 limit requires its own graph node). Six local-rule
issues were excluded. The 2/2 and 2/3 determinate-candidate figures describe
this invented graph only. The Host reported two model requests, 1,810 billed
input tokens plus 896 cache-read input tokens, and 20,992 output tokens; the
reported total is 23,698 tokens. No patch was applied to the reviewed graph;
the separate temporary-database replay is described below.

## Relation Repair Replay

`scripts/kg-discovery-repair-persistence-smoke.mjs` loads the frozen v3 graph
into its own temporary SQLite and invokes the actual persistent Host routes.
Its optional argument is the saved Flash raw capture; it verifies the frozen
gold hash and complete report before selecting that exact proposed edge fix.
The no-argument controlled path is part of the normal benchmark test command.
Both paths passed: a source-mismatched citation and an unknown relation type
failed preview; the valid `is_a` to `not_is` proposal passed preview without
writing, then persisted exactly one relation change at revision 2. Node
semantics, their citations and source text were unchanged. Citation
authentication did not promote other nodes to semantically verified. Both a
stale preview and a stale write were rejected after commit. This establishes
structural persistence and revision safety for **this** source-grounded fix,
not blanket safety for every model-suggested relation edit. Neither 3119 nor
the production graph was modified by this replay.

## Separate Repair Adjudication (2026-09-28)

The initial discovery score hid the six actual Flash patch proposals inside
the issue verdicts. A red adversarial test reproduced the omission: the
evaluator returned no repair metrics even when a false-alarm candidate carried
an edit. The evaluator now rejects missing or contradictory repair labels and
keeps the same frozen gold and original report hashes. No model was called
again. Both saved reports were re-adjudicated by Codex using their complete
source and exact proposed fixes:

| Synthetic graph | Proposed | Source-supported | Unnecessary correction | Source-unsafe | Uncertain |
| --- | ---: | ---: | ---: | ---: | ---: |
| v2 | 3 | 1 | 1 | 0 | 1 |
| v3 | 3 | 1 | 1 | 0 | 1 |

The v3 `is_a` to `not_is` source-supported patch also has the separate
temporary-SQLite persistence proof above. The v2 source-supported `add_node`
has only source-level adjudication, not persistence proof. These counts are
same-thread Codex judgements on two invented graphs, not a repair-safety rate
for real books. The unchanged raw captures and schema-2 decisions/reports are
in isolated ignored `output/`; the test suite covers absent patch labels,
patch-present mislabelling, false-alarm approval and report-hash mismatch.

## Structural Preview Is Not Semantic Approval

An adversarial replay starts from v3's corrected `not_is` relation, then
previews changing it back to `is_a` while retaining the exact paragraph quote
that says the two concepts are **not** the same. The persistent Host correctly
accepts the proposed graph as structurally valid: the quote exists, the
relation is registered and the types fit. It does not claim semantic
entailment. The replay never commits this reversal and confirms revision 2
remains unchanged. This is a boundary of deterministic validation, not proof
that the false relation is acceptable knowledge.

The isolated client now makes that distinction explicit for `add_edge` and
`update_edge` proposals, both in the issue list and the single-review result.
It requires a second confirmation click before a relation patch is sent to
the save path. The first click only exposes the confirmation state; it does
not write a graph. Static UI regression, controlled and saved-Flash Host
replays, the complete Node 24 `npm test`, signed payload parity and
`git diff --check` passed. The WSL Playwright CLI lacked Chrome and the
desktop browser automation kernel failed to initialize, so a temporary
Windows Playwright-core installation drove the already-installed Chrome
against the dedicated `--relation-semantic` fixture on a random local port.
The browser verified both entry points: on the issue card and after a
controlled-model issue review, the warning was visible and the first repair
click changed neither revision nor commit count. The confirmation button
then appeared; only its second click changed the fixture's temporary graph.
Desktop 1440 px and mobile 390 px issue-card screenshots are retained under
ignored `output/playwright/relation-semantic-*.png`. The warning and button
had nonoverlapping bounds, and document scroll width equaled viewport width
at both sizes. The reviewed-result first-click test also confirmed zero
writes; it did not submit the second click. No 3119 or production service was
restarted or graph changed. The fixture process and its temporary SQLite were
closed after the browser pass.

## Third Frozen Graph: Table Header And Subgroup Reversal

`scripts/fixtures/kg-discovery-source-zh-v4.json` changes the source shape,
not merely the wording of the earlier prose cases. The Host splits a Markdown
table into separate units for the header, separator and each row. The frozen
Codex-reviewed finding is that n1 generalizes an 8/10 versus 7/10 result in
one subgroup to both subgroups, while the other row reverses the comparison
to 1/10 versus 3/10. Faithful row-specific n2/n3 facts are negative controls.
The source also disclaims long-term retention, but n1 does not claim it; that
is not silently added as a second gold defect. Seed smoke checks the actual
six-unit Host split, rejects a citation moved to a different table row before
any SQLite write, and rejects a swapped header against the frozen evidence.

After the gold and revision-1 Host export were frozen, idle 3119 ran only
CommandCode DeepSeek V4.1 Flash. Full coverage completed for 3/3 nodes, 0/0
relations and 6/6 source units. The model found the one frozen subgroup error.
Its second AI issue, asking for a separate same-week limitation node, remains
uncertain: the source supports that wording, but the frozen graph has no
long-term claim and the need for another node was not independently established.
Six local-rule issues were excluded. The model made two requests and the Host
reported 1,301 ordinary input, 896 cache-read input and 5,915 output tokens,
8,112 total. Raw capture, report-hash-bound Codex decisions and score are in
ignored `output/discovery-zh-flash-v4-20260928.*`.

The model's n1 update is source-supported but would duplicate existing n2.
That is a graph-edit quality question distinct from whether the allegation is
correct; source-supported does not authorize automatic persistence. The
separate proposed limitation node remains unapproved/uncertain. Neither patch
was applied. One invented table and same-thread AI labels cannot establish
real-book recall, precision, repair safety or a pricing comparison. Next check
whether duplicate-result prevention and preview make the n1 edit's redundancy
visible without weakening the source-grounding gate.

## Same-Excerpt Repair Preview

The saved v4 Flash patch and a controlled equivalent were replayed through
the real persistent Host with independent temporary SQLite. Both passed
`graph-commit-preview` while the proposed n1 and existing n2 used the same
source row and exact quote. Preview left revision 1 unchanged. This is not a
Host error: citation and ontology checks cannot prove two differently worded
claims are semantically distinct. Neither replay committed a duplicate node.

The isolated client now shows the IDs of other nodes in the **current graph
window** that use the proposed update's exact paragraph and quote. It asks the
reader to check for duplication and never merges nodes automatically. An
update with such a peer requires a second, issue-scoped confirmation; the
confirmation for one issue cannot authorize another card with the same patch.
The advisory is deliberately not a semantic duplicate verdict. An off-window
peer may be absent from this local warning, and two different claims can
legitimately cite the same sentence. Bulk review still rejects this v4
paraphrase as an automatic textual fix because the resulting text is not
verbatim contained in the retained quote.

An adversarial UI smoke first failed on the missing peer comparison, then
passed with the v4 repair, unchanged-text and unrelated-operation controls.
A random-port temporary-SQLite browser fixture showed the warning at 1440
and 390 px without horizontal overflow or overlap. On the 390 px fixture,
the first repair click kept revision 1 and zero commits; only a deliberate
second click changed that disposable graph to revision 2 and marked the issue
applied. No user graph, 3119 graph or production service was changed. The
source-backed proposal replay has both a deterministic no-model variant in
the normal benchmark test command and a separately run saved-Flash variant.
The first full-suite run after the client edit correctly failed the packaging
gate on a stale CRX payload; a later run overlapped another edit and failed
the changed UI assertion. After stopping edits, rebuilding source artifacts
and re-signing with the existing external identity, a fresh complete Node 24
`npm test` passed, including payload parity and stale-payload rejection;
`git diff --check` passed. Neither failed run was counted as verification.

## Off-Window Source Peer Check

The same-excerpt warning originally inspected only the loaded graph window.
An adversarial 803-node fixture places the target in the first 800-node page
and an exact excerpt peer at `zz-peer` outside it. The old client helper finds
no peer in that page, although a full-canonical check finds one. A red UI
assertion reproduced the missing preflight. The persistent Host now exposes a
read-only, revision-fenced `graph-source-peers` query that scans the complete
canonical node set but returns at most five peer IDs and a remaining count.
Both dynamic and persistent implementations use the same comparison rule;
the browser refuses to submit the edit if the query fails or the loaded graph
changes while it is in flight. A returned peer triggers the existing
issue-scoped second confirmation and names the off-window node. The final
graph commit still uses its own revision CAS. This remains a possible-duplicate
warning, not a semantic equivalence decision.

The actual temporary-SQLite HTTP Host returned n2 for the v4 proposal,
rejected a stale revision, excluded an unchanged-text edit, and changed its
peer from n2 to n3 when the proposed citation moved to n3's row. On the
separate off-window fixture, Windows Chrome showed
no local-window warning before the click; after one click it showed
`zz-peer` from the full-graph check, a confirmation button, zero commits and
revision 1. Deliberate second confirmation on a 390 px viewport saved only
the disposable fixture (revision 2, one commit); no page errors or horizontal
overflow occurred. The fixture process was stopped. Neither 3099 nor 3119 was
restarted, and no model or user graph was touched. Full test and packaging
evidence are recorded in the roadmap after the final source/test edits.

In a follow-up adversarial browser pass on a fresh disposable copy, an HTTP
503 for `graph-source-peers` displayed a retryable error with zero commits and
no confirmation button. Holding that response while moving from graph window
1 to window 2, then releasing it, also made zero commits and did not expose
the old window's confirmation. Both left revision 1 and produced no browser
exceptions. These tests exercise transport failure and same-document navigation
after the full-canonical lookup, rather than repeating the model call.

## Fourth Frozen Graph: Untested Proposal In Dialogue

The v5 synthetic source is a classroom debrief dialogue, not another measured
comparison. P0 says the answer-first proposal was never implemented, P1 asks
what *might* happen and records a teacher's guess without any measurement,
while P2 records only the actual answer-after-work group's result. The frozen
Codex-reviewed defect is n1's conversion of that untested guess into a past
result. Faithful n2/n3 observations are negative controls. This probes the
epistemic status of a quoted speaker's conditional statement, not just a
missing population or time qualifier.

The Host splits the source into four units: it separates P2's observed result
from the following no-comparison sentence. The seed smoke freezes that actual
split and rejects changing `没有实施` to `已经实施` before touching SQLite. A
revision-1 export of 3 nodes, 0 edges and 4 units was frozen as
`kg-discovery-gold-zh-v5.json` before the model call. Idle 3119 then ran only
CommandCode DeepSeek V4.1 Flash through ordinary full verification. It
completed 3/3 nodes, 0/0 edges and 4/4 units. The model found n1's frozen
defect and proposed a source-supported conditional rewrite; its separate
suggestion to add a standalone nonimplementation caveat remains uncertain,
not a second frozen hit or a false alarm. Seven local-rule issues were
excluded. Two requests reported 2,231 input and 3,929 output tokens, 6,160
total; the capture interval was about 35.5 seconds, not a controlled latency
comparison. Original report, report-hash-bound Codex adjudication and score
are under ignored `output/discovery-zh-flash-v5-20260928.*`.

The proposed n1 rewrite has only a source-level judgement, not a persistent
Host preview or edit approval. No model patch was applied. This is one
invented dialogue and same-thread AI labels, not a real-book accuracy claim or
independent human ground truth. The source fixture and adversarial seed test
passed; after the final fixture/test edit a fresh complete Node 24 `npm test`
passed, including signed payload parity and stale-payload rejection. An
initial `npm test` invocation accidentally selected Windows npm through WSL
PATH and stopped at build startup; it was not counted as verification. The
corrected Node 24 PATH run passed. No 3099 or 3119 restart was performed.

## Dialogue Repair Replay And Text-Semantics Warning

The exact saved Flash n1 proposal and a controlled equivalent were replayed
through the real persistent Host into separate temporary SQLite databases.
A citation attached to the wrong source unit failed preview. The legitimate
conditional rewrite passed preview without writing and then persisted only
n1 at revision 2; n2/n3 retained their texts, types and source quotes, and
source text was unchanged. Citation authentication did not promote their
semantic entailment status. Old-revision preview and commit were rejected.
No edit was made to the 3119 synthetic document or to production.

The adversarial counterpart retained an exact P1 citation and the word
"may" but asserted that *all* students would make no mistakes. It passed
structural preview even though the source does not make that universal claim;
it was never committed. A stronger false assertion without the modal word
was rejected by the existing `node_semantic_strength_drift` invariant. This
separates a useful deterministic check from a general semantic proof: adding
an exact quote and one uncertainty word cannot validate the rest of a node.

The isolated single-item UI now warns that node wording has not been
independently semantically verified and requires a second, issue-scoped click
for a changed `update_node` text. The full-canonical source-peer preflight
still runs first and must succeed; the bulk text gate remains stricter and
unchanged. A red UI smoke reproduced the previous one-click path, then passed
with the warning and confirmation. In a random-port, temporary-SQLite browser
fixture, the issue card and controlled AI-review result both showed the
warning. Their first clicks each made zero commits and left revision 1; a
separate mobile session's deliberate second click made exactly one temporary
commit and revision 2. Desktop 1440 px and mobile 390 px had no horizontal
overflow or page errors. The mobile screenshot is retained as
`output/playwright/text-semantic-mobile.png`. The fixture and its database
were closed. Source/lib/viewer were rebuilt and the extension was re-signed
with the existing external identity; a fresh complete Node 24 `npm test`,
signed payload parity and stale-payload rejection passed. This guard is a
human decision point, not automated semantic verification.

## Capture Interruption And Duplicate-Call Fence

An adversarial process-interruption reproduction left a legacy
`raw.json.pending` file next to an otherwise valid capture. Both the targeted
issue-review runner and the full-graph discovery runner then failed their next
save with `EEXIST`. Worse, the targeted runner previously sent a model request
*before* recording the pending task. A crash or transport failure in that gap
could leave no durable indication that a paid request was admitted.

Both runners now share an atomic capture writer that uses a unique, mode-0600
temporary file, syncs its bytes, then renames it over the capture. An orphan
from an earlier interruption no longer blocks a later save and remains
available for forensic inspection. The targeted runner now records an
`admitting` state before POSTing a request; after admission it records the
task ID. If interrupted in the ambiguous gap, the next invocation refuses
to submit another request automatically and asks for inspection. Known-ID
pending tasks still resume by polling rather than readmitting. This is a
fail-closed recovery boundary, not automatic recovery of an unidentified
task ID.

A controlled HTTP runner test checked the on-disk `admitting` record while
handling `/question-graph`, failure capture, explicit retry, a preserved
orphan file, known-ID resume and ambiguous-admission refusal without duplicate
admissions. The discovery smoke checked the shared writer's private file mode
and orphan tolerance. The pre-fix control failed on missing pre-admission
recording; the separate old-writer reproduction observed `EEXIST` in both
runners. No real model was called for these tests. A fresh complete Node 24
`npm test` passed, including signed payload parity and stale-payload rejection.
No 3099/3119 task or service was changed.

## Concurrent Capture Fence

A second controlled HTTP test started two issue-review capture processes for
the same output at the same time. Before the fix both observed an idle service
and submitted the same paid case, then overwrote each other's capture (two
admissions). Atomic replacement alone cannot serialize read/modify/submit.
Both runners now take an exclusive, mode-0600 lock for the output before
reading the capture or asking the service for work. The second process fails
without admission; a normal exit releases its own lock. A crash deliberately
leaves the lock in place: inspect its recorded PID and capture/task state
before manually removing it. Automatic stale-lock deletion would risk a
duplicate paid request, especially during the ambiguous admission window.
This only serializes processes that share an output path; unrelated benchmark
captures still rely on the service's task-active admission guard.

## Fifth Frozen Graph: Quoted Speaker Versus Editor

The v6 synthetic interview tests attribution rather than another population,
table or proposed-outcome qualifier. P1 attributes a claim about showing
answers early to teacher Lin and says no measurement accompanied it. P0 says
a quotation is not editorial endorsement, and P2 explicitly rejects treating
Lin's opinion as established. Node n1 nevertheless states that the editor
confirmed Lin's claim. Faithful nodes n2 and n3 are negative controls.
The single frozen positive finding is the incorrect speaker and certainty in
n1; whether every editorial caveat needs a separate node is not pre-labeled
as a defect.

A red seed test caught the Host splitting P3's semicolon into two source
units. The fixture was corrected to the actual five-unit split before the
3119 seed or model call. The adversarial seed test also rejects a source that
changes editorial disagreement into endorsement before any database write.
The frozen revision-1 Host export contains 3 nodes, 0 edges and 5 source
units. Idle 3119 ran only CommandCode DeepSeek V4.1 Flash with ordinary full
verification; all units were covered. The model found the frozen n1 defect
but proposed no structured repair for it. Of its four other AI issues,
same-thread Codex review marked one false alarm (n3 already limits the advice
to this trial) and three uncertain completeness/summary suggestions. Four
repair proposals were separately reviewed: one unnecessary clarification and
three uncertain additions; none was applied. Six local-rule issues were
excluded from AI scoring. Two model requests reported 2,463 input and
12,930 output tokens. Raw status, report-hash-bound decisions and score are
in ignored `output/discovery-zh-flash-v6-20260928.*`; the frozen source/gold
are in `scripts/fixtures/`.

This is one invented source and same-thread AI adjudication, not independent
human ground truth or a real-book precision/recall estimate. The missing
structured fix for the confirmed issue is a usability gap for subsequent
repair evaluation, not evidence that the issue was fixed. No model patch was
applied to 3119 or production.

## Targeted Follow-Up For The Attribution Issue

The full-graph report's `proposedFix: none` is not the end of the product
workflow. The separate issue-review path independently rechecks an allegation
and, when confirmed without a patch, can make a second structured-repair
attempt. To test that path without changing the frozen discovery labels, a
follow-up builder binds one Codex-reviewed approval file to the exact full
report and source/graph snapshot. A red test showed that an otherwise valid
repair for n2 could be approved under n1's issue ID; the builder now rejects
repairs that target a different issue. This protects the benchmark label,
not the model's semantic correctness.

Idle 3119 ran only CommandCode DeepSeek V4.1 Flash on the frozen n1 issue.
The targeted result confirmed the attribution error and returned a structured
`update_node` for n1, replacing the false editorial endorsement with the
editor's explicit P2 rejection and an exact P2 quote. It used one reported
request (1,231 input, 5,172 output tokens). The frozen approval had listed
deleting redundant n1 as the safe repair, so the evaluator correctly marks
the model's *different* update as unapproved; the gold was not rewritten
after seeing the result. A separate same-thread Codex source check found the
update faithful to P2, and a disposable SQLite/real persistent Host replay
confirmed wrong-anchor rejection, read-only preview, one-target persistence,
unchanged n2/n3 semantics, and stale revision rejection. That replay is not
an automatic approval to apply the update to the 3119 or production graph.
The raw targeted task, converted run and report remain under ignored
`output/discovery-zh-flash-v6-followup-20260928.*`.

The disposable-Host repair replay must also prove that the model answered
the frozen targeted question. An adversarial capture kept the same gold
hash, issue ID, successful status and patch, but changed the captured
question; the former replay accepted it. The replay now calls the benchmark's
full captured-run validator, which checks the entire request, case identity
and result model. The substituted request fails, while the original
controlled and saved Flash captures pass. This is a provenance fence for the
replay evidence, not a semantic endorsement of the proposed patch.

## Post-Hoc Review Without Relabeling Gold

The targeted evaluator deliberately uses exact pre-call allowed repairs. Its
unapproved count is therefore correct for this run, but it does not say
whether an unforeseen patch is source-faithful. A separate repair-adjudication
layer now inspects only those unapproved proposals. It requires a decision
for each one, exact frozen-gold/run/proposal hashes, reviewer tier, rationale
and source-unit evidence; a draft template cannot be scored. A controlled
adversarial test rejected a different run, a changed patch, missing decisions
and evidence attached to the wrong paragraph.

For the saved v6 targeted run, same-thread Codex labeled the model's P2
rewrite source-supported after the temporary Host replay. The supplemental
report retains `frozenUnapprovedCount: 1` and separately records one
post-hoc source-supported proposal. It does not rewrite the frozen approval,
call this independent human truth, or grant permission to save the patch to
the isolated or production graph. The hash-bound decisions/report remain in
ignored `output/discovery-zh-flash-v6-followup-20260928.*`.

## Open-Article Excerpt: Conflicting Abstract And Subgroup Data

Version 7 is the first fixture here based on an openly licensed published
source rather than invented prose. It uses a short, whitespace-normalized
excerpt from Dai Shengjun et al., [The Impacts of the Feynman Learning Method
on Students' Learning Outcomes: A Meta-Analysis of 41 Empirical
Studies](https://pdf.hanspub.org/ae_1883852.pdf), DOI
10.12677/ae.2026.1691896 (CC BY 4.0). This is **not** a full-article import:
four source units were curated and four graph nodes manually seeded. The
article's abstract favors self-directed learning as a more stable context,
while its subgroup results report lower effect and higher heterogeneity for
self-directed than collaborative learning. The frozen positive finding is
narrower: n1 reverses both **numerical** comparisons. n2 explicitly reports
what the abstract says; n3 and n4 report the subgroup numbers and direction.

The Host splitter and all graph/finding anchors were checked before seeding;
an adversarial change to the published collaborative effect invalidates the
frozen finding. The isolated 3119 readback froze revision 1, 4 nodes, 0 edges,
4 source units and gold hash
`504a95a966ba39d405b80862bdda7296d6789d415bad07c6adeec9d2f93f9e71`
**before** any model call. The live runner matched 3119's loaded Host build
fingerprint, found the service idle, then ran only CommandCode DeepSeek V4.1
Flash. The ordinary full audit completed 4/4 nodes and 4/4 source units.

It did **not** report the frozen n1 numerical reversal. Its sole AI warning
said n3's primary quote covers only one value, but n3's evidence array cites
both exact subgroup values, so same-thread Codex review marked it a false
alarm. The proposed narrowing of n3 to only the first value was unnecessary
and was not applied. Seven local-rule issues were excluded from AI scoring.
Two actual requests reported 2,610 input and 7,693 output tokens; capture
wall time was 55,755 ms. Raw report, report-hash-bound adjudication and score
are in isolated ignored `output/discovery-zh-flash-v7-20260928.*`.

This is one curated real-source **excerpt** with a planted graph error and
same-thread AI labels. It is useful negative evidence for numeric comparison
and multi-evidence-node review, not a precision/recall estimate for the full
paper, a book, or the product. Next compare whether targeted issue review
can confirm the missed n1 issue, then investigate why ordinary discovery
focused on primary quote completeness instead of the conflicting values;
neither step may relabel the frozen full-graph result.

### Frozen Miss Follow-Up (2026-09-28)

The full-audit planner assigned n1, n2, n3 and n4 to one batch containing
all four source units, including both distant numerical paragraphs. A Host
planning regression now checks this exact context. The full-audit miss is
therefore not explained by omitted P2/P3 source text, although this one case
does not isolate a unique model or prompt cause.

The separate known-allegation follow-up was derived from the **adjudicated
miss**, not from an AI issue in the original report. Its approval is fenced
by the frozen graph/source hash, complete report hash and missed finding ID;
a changed report, found rather than missed allegation, or a repair aimed at
another node is rejected. The derived case preserves all four original
source units and the P2/P3 evidence. Before admission, an adversarial test
proved that the targeted runner used to accept a stale running Host identity;
it now checks the loaded build before and after a task and limits CommandCode
to isolated 3119.

On idle 3119, one DeepSeek V4.1 Flash targeted request **confirmed** the n1
error and explicitly compared g=0.333 versus 0.530 and I²=58.988% versus
25.528%. It also noted the abstract/body disagreement. The measured request
reported 1,207 input and 1,909 output tokens, 16,504 ms capture latency.
The model proposed rewriting n1 with the body values rather than the frozen
approved deletion. The exact-repair scorer marks that proposal unapproved;
its patch changes text but leaves n1's old abstract-side source anchor in
place. It was not applied or retroactively added to allowed fixes. This
1/1 known-allegation confirmation does **not** repair the full-audit 0/1
discovery miss or measure real-book recall. Raw capture, normalized run and
score are under ignored `output/discovery-zh-flash-v7-followup-20260928.*`.

The exact saved Flash patch was replayed in a disposable SQLite database
through the persistent Host. Structural preview accepted it without writing;
commit changed only n1's text and preserved n1's old abstract-side primary
quote and P0/P1 evidence. The source text and other nodes stayed unchanged,
and stale preview was rejected. Thus valid graph structure and paragraph
anchors do **not** establish that the new wording is supported by the
retained citations. No change was sent to 3119 or production.

The single-item review surfaces now show the complete proposed node text
instead of a 120-character prefix. When a text rewrite retains its primary
quote or evidence, they display those exact old citations and ask the user
to check them against the new wording before the existing second-click
confirmation. An adversarial UI test covers the v7 stale-citation proposal;
a real browser using temporary SQLite confirmed the warning is visible at
1440 and 390 pixels, the first click writes nothing, and the second
confirmation is explicit. This is a disclosure and human-decision guard,
not an automatic semantic classifier or permission to apply the model edit.
The first full test run exposed the intentionally stale signed extension
after the client rebuild. Repacking with the existing external signer kept
the trust gate intact; a fresh complete Node 24 `npm test` then passed,
including signed payload parity and stale-payload rejection.

The frozen gold had already allowed one specific alternative: delete the
contradictory n1 while retaining n2's abstract account and n3/n4's body
measurements. A separate disposable SQLite/real Host replay of that exact
`delete_node n1` proposal passed a read-only structural preview, removed
only n1 on commit, preserved all other node text/citations and source text,
and rejected a stale second commit. This does not resolve the article's
abstract/body disagreement; it avoids turning the model's body-side
interpretation into a newly cited canonical claim. A reanchor to P2/P3
would make the body citation explicit but duplicate n3/n4 and still require
semantic adjudication. These are same-thread Codex judgements on a frozen
synthetic graph, not independent human truth. Neither variant was applied to
3119 or production, and the full-audit miss remains unchanged.

## Versioned-Rule Transition Graph (2026-09-28)

`kg-discovery-source-zh-v8.json` is a separate invented training-program
revision notice. The 2024 procedure applies to newly enrolled cohorts, while
an explicit transition clause keeps earlier cohorts on the 2023 procedure;
an observed still-enrolled old cohort is a counterexample to n1's claim that
all enrolled learners use the new procedure. Faithful new- and old-cohort
nodes n2/n3 are negative controls. This tests effective-time applicability,
not the v3 duration limit, v4 table row, v5 untested proposal, v6 speaker
attribution, or v7 conflicting published measurements.

The first draft incorrectly assumed five Host units; a pre-seed split check
showed eight sentence units. The fixture and every paragraph anchor were
corrected before freezing revision-1 Host gold. Adversarial seed checks reject
removal of the grandfathering clause, and the actual full-audit plan gives
the n1 batch all eight units. The frozen export has 3 nodes, no edges and
8 source units. On idle 3119, only CommandCode DeepSeek V4.1 Flash ran the
ordinary full audit. Coverage completed for 3/3 nodes and 8/8 units. It
reported n1's precise scope error and no other AI candidate; six local-rule
issues were excluded. Same-thread Codex review matched the one frozen
finding. The Host reported two requests, 2,293 input and 6,067 output
tokens; capture elapsed time was 49,851 ms, not a controlled speed measure.
The raw report, hash-bound adjudication and score are in ignored
`output/discovery-zh-flash-v8-20260928.*`.

The model proposed narrowing n1 to the 2024 procedure and changing its type
to `rule`. P2/P3 together support the narrowed meaning, so the repair review
labels it source-supported, but the proposed primary quote and retained
evidence cite only P3; P2 supplies the explicit version applicability. The
type and provenance therefore still need human graph-edit review. No model
patch was applied. The observed 1/1 finding on one invented graph with
same-thread AI labels is not a real-book recall/precision estimate or
independent human truth, and it does not undo the v7 discovery miss.

### Versioned-Rule Repair Provenance Replay

The saved v8 Flash patch was replayed only in disposable SQLite through the
real persistent Host. Structural preview accepted the model's narrower text
and `rule` type, but temporary persistence retained only P3 evidence. The
P2 sentence that explicitly limits the 2024 edition to new cohorts was not
cited. A separate, explicit P2+P3 reanchor passed preview and persisted in
temporary storage; it preserved all other node meanings and source text.
This demonstrates a representable provenance improvement, not automatic
semantic approval or permission to edit the isolated 3119 graph.

An adversarial preview then supplied a fabricated P2 quote. Before repair,
the Host silently discarded that new evidence and reported a valid preview:
the fake quote was **not** persisted, but the caller could believe its
intended scope citation had been saved. The graph-commit boundary now rejects
new or changed node and relation evidence, and changed primary quotes, when
they cannot be matched to the specified source unit. Unchanged legacy
citations retain their previous treatment. Both dynamic and persistent
preview/commit paths use this check before evidence authentication; the
persistent path still authenticates the incoming graph before handing it to
SQLite, preserving the forged-provenance trust fence. Red/green tests cover
fabricated node evidence, primary quotes and relation evidence, read-only
preview, canonical provenance, the valid reanchor and stale revision.
The complete Node 24 `npm test`, including signed-extension parity and
stale-payload rejection, passed after the fix. No model was called again and
no 3119 or production graph was changed by this replay.

A further adversarial replay found a separate shape bypass: an `evidence`
string on a submitted node was normalized to `[]` before the new quote check,
so preview again reported valid while dropping the caller's intended
citation. Both commit routes now reject explicitly malformed evidence fields
and non-text primary quotes before cloning/normalization. Focused dynamic
and persistent tests cover preview and commit, and a fresh complete Node 24
`npm test` passed after this change. This is an input-contract fix, not a
claim that a valid quote semantically entails its node.

An evidence-cap adversarial replay found a third boundary: merging a relation
with existing citations can silently truncate a newly submitted ninth item.
If that item is fabricated, checking only the merged view misses it; if it is
genuine, the preview wrongly implies it will be saved. Both Host commit paths
now check the raw submitted citations before merging and fail with
`evidence_limit` when a supplied item would be dropped. Dynamic and
persistent disposable-graph tests exercise both the fabricated and genuine
cases. The eight-citation cap remains; callers must choose which evidence to
retain rather than assume an overflow item was committed.

`merge_node` operations had a related loss path before view merge: the
canonical source node's citations could be truncated while folding them into
an already evidence-rich target. Operation preflight now checks node and
redirected-relation evidence capacity before merging and returns
`evidence_limit` rather than reporting a successful preview. A red/green
dynamic test and a temporary-SQLite persistent Host test cover node-citation
loss without modifying the isolated preview graph. This is a preservation
gate, not a judgement that two nodes mean the same thing.
The temporary-SQLite replay also covers two evidence-rich relations that
collapse to the same key when their source nodes merge. The relation branch
returns `evidence_limit` in preview and commit without changing the revision.

The next frozen synthetic case, v9, targets a different inference error:
non-significant superiority evidence being reported as proven equivalence
without an equivalence design. The fixture and Codex same-thread evidence
label pass source-split, anchor, full-batch-context and adversarial
study-design-mutation checks. It has not been seeded or sent to a model.
The running 3119 Host hash differs from this worktree's generated Host; the
live runner's engine-identity fence must remain in force until an idle,
credential-safe isolated refresh is performed.

After a confirmed-idle refresh of only 3119, engine identity matched and the
v9 fixture was seeded/read back at revision 1. Flash completed the full
four-unit, three-node graph in two requests (2,194 reported input, 4,803
output tokens; 42,646 ms measured elapsed). Codex same-thread adjudication
matched the one frozen nonsignificance/equivalence defect, counted one
duplicate report of it, and left the omitted-margin completeness suggestion
uncertain. The latter's proposed compound node edit is not justified under
one-proposition-per-node. Six local hints were excluded; no patch was
applied. The raw capture, adjudication and score are ignored artifacts in
`output/`. These numbers describe one invented graph, not a real-book
accuracy estimate, independent human labels or monetary price.

An under-cap operation replay found that view merge could overwrite the
evidence-preserving `merge_node` result with a target node lacking the source
node's citations. The persistent Host had returned a valid preview despite
the omission. Its operation preflight now checks the operation-produced
target and redirected relations against the final view. Disposable-SQLite
red/green tests prove omission is rejected without a revision change and
that a legal view carrying both evidence sets remains commit-able and durable.

The offline discovery scorer also needs an unambiguous relation target. A
red fixture with two different relations between the same node pair showed
that a gold edge finding without `targetRelation` was accepted, allowing a
candidate on the other relation to receive credit. Gold validation now
requires a nonempty, existing exact relation for every edge finding. This
does not change the frozen datasets, which already specify their relation;
it prevents a future ambiguous label from inflating discovery metrics.

Another adversarial report changed one AI candidate's `source` to an unknown
value. Previously the scorer excluded it as though it were a deterministic
local warning, without requiring a verdict, which could inflate reported
precision. Completed reports now fail closed unless every issue is explicitly
`ai` or `local`; all `ai` candidates still require individual adjudication.

## Zero-Finding Control And Reviewer Fallibility

The original gold schema required at least one known defect, so it could not
score a graph with no pre-labelled issues. It now permits `findings: []` only
with an explicit `negativeReview` of the entire source and graph, included
in the frozen gold hash. Recall is `null` for such a graph, not 100%, zero or
`NaN`; any AI candidate must still be adjudicated and can count as a false
alarm. A controlled red/green evaluator test covers zero candidates, one
false alarm and missing negative review. The isolated seeder carries the
negative review into the Host-exported gold rather than inventing one.

The first attempted negative control, v10, exposed a real limitation of the
same-thread Codex labels: although it was labelled clean before the run, its
n1 omitted the source's `虚构` qualifier. Isolated 3119 Flash reported that
omission, an empty-summary warning and a possible missing descriptive-scope
claim. The v10 zero-finding gold is therefore **disqualified**, not scored as
a false-positive run or relabelled after seeing the model response. Its
frozen gold and raw task remain in ignored `output/` as evidence of the
review error; the invalid seed was removed from the versioned fixture set.

A new dataset ID, v11, was re-read by Codex against all five synthetic
source units before freezing. It explicitly retains the fictional status,
course/sample constraints, numeric observations, absent control and
unobserved groups, descriptive scope and limits on causation and transfer; it also has
a source-grounded summary. Host splitting, node anchors and full-coverage
planning passed before the model request. On the isolated 3119 service,
CommandCode DeepSeek V4.1 Flash completed the ordinary full review (7 nodes,
0 edges, 5 source units; 2 requests) and produced **zero AI candidates**.
The Host reported 2,124 input and 15,279 output tokens; capture elapsed time
was 138,204 ms. Eight local-rule hints were excluded. With no positive gold
findings or AI candidates, both recall and precision are undefined (`null`),
not a perfect score. The raw capture, frozen gold, hash-bound empty
adjudication and score are under ignored `output/discovery-zh-flash-v11-*`.
The eight excluded local hints are seven isolated-node warnings and one
disconnected-components warning: v11 is a source-grounding negative control,
not a claim that its intentionally edge-free topology is a finished graph.
This is one invented graph reviewed by the same Codex thread, not a
real-book specificity estimate or independent human truth. V10's failed
negative label is a concrete reason not to overclaim Codex adjudication.

## Connected Negative Control

The separate v12 synthetic control reduces the topology confound: its two
concept nodes are joined by an explicit `is_a` statement in the source. The
frozen graph, summary and zero-finding Codex label were checked against the
Host's three actual source units before seeding. An adversarial reversal of
the taxonomy statement invalidated the relation quote before any SQLite
write. On idle 3119, Flash completed full 2-node, 1-edge, 3-unit coverage
in two requests. The Host reported 1,922 input and 13,010 output tokens;
the capture interval was 112,628 ms. One local uncovered-paragraph hint was
excluded from AI scoring.

Flash's one AI candidate proposed making P0's fictional/no-learning-effect
disclaimer a separate graph node. The frozen summary already retains that
limitation, and the graph makes no efficacy claim. Whether this disclaimer
requires its own canonical node is unresolved granularity, not a proven
source-fidelity error. Codex marked both candidate and proposed repair
`uncertain`, did not modify the graph and did not retroactively alter the
frozen zero-finding label. The score has null recall and null precision with
one uncertain AI candidate, **not** a perfect clean-graph result. Frozen gold,
raw capture, hash-bound decision and score are in isolated ignored
`output/discovery-zh-*-v12-20260928.*`. This remains an invented same-thread
AI-reviewed example, not independent human truth or an estimate of specificity
on real books. The persistent one-paragraph hint also means this is not a
zero-warning graph; adding a node simply to silence that hint would compromise
the pre-run freeze.

## Public-Domain Book Excerpt: Conditional Claim Miss

V13 uses the three clauses beginning `知彼知己` from [《孙子兵法·谋攻》 on
Wikisource](https://zh.wikisource.org/zh-hans/孙子兵法), consulted 2026-09-28.
The versioned fixture separates the original semicolon clauses into the
Host's three source units; it is not a transcription of the user's book. Its
deliberately wrong n1 assigns `百战不殆` to the `不知彼而知己` condition, whereas
the source assigns that condition `一胜一负`. The source and graph, one positive
Codex-reviewed finding, exact citations and revision-1 Host export were
frozen before the model call. The seed smoke proves both contrasting clauses
reach n1's full-audit batch and that reversing the source contrast invalidates
the frozen finding before a SQLite write.

On idle 3119, CommandCode DeepSeek V4.1 Flash completed all 3 nodes and 3
source units in three requests, then published zero AI issues. Four local
isolated/fragmented-graph hints were excluded, not credited as discoveries.
The frozen n1 defect therefore scores as one **miss** in this single excerpt.
The Host reported 1,865 input and 1,886 output tokens; capture elapsed
33,515 ms. Raw task, frozen gold, empty hash-bound adjudication and score are
under isolated ignored `output/discovery-zh-*-v13-20260928.*`. No graph repair
was attempted and no model prompt was tuned to this case. This is a real
public-domain book *excerpt* with same-thread Codex labels, not measured
whole-book recall or independent human truth. The next diagnostic question is
whether the same Flash route can reject n1 when directly asked about it; a
targeted check must be reported separately and must not erase this full-audit
miss.

The focused seed smoke and a complete Node 24 `npm test` passed after v13,
including signed-extension parity and stale-payload rejection. An earlier
full attempt stopped in the pre-existing auxiliary idle-stream timeout smoke
before reaching the benchmark; the smoke passed alone and the later full run
passed. That intermittent timeout-test failure remains unresolved, so neither
attempt is being misreported as an uninterrupted first-pass success.

The separate v13 known-allegation diagnostic binds a Codex-reviewed approval
to the exact missed-finding gold and empty full-audit report hashes. It permits
the source-backed rewrite of n1 to `不知彼而知己，一胜一负。` or deletion, but not
the original elevated conclusion. The existing follow-up hash/target smoke
passed before a single call to the idle 3119 Flash route. That targeted call
confirmed the discrepancy, contrasted P0 with P1 and proposed exactly the
approved non-destructive rewrite. It took two reported model requests, 1,105
input and 450 output tokens, with 11,009 ms capture latency. Frozen approval,
raw response, normalized run and score are under isolated ignored
`output/discovery-zh-flash-v13-followup-*.json`. This shows the model can
reject the claim when prompted with a known allegation; it does **not**
retroactively discover the issue in the preceding full audit or establish
real-book recall. The original full-audit batch already contained both
contrasting clauses. Its task trace shows a separate confirmation stage and
a retry; the Host enters that stage only after at least one initial candidate
survives normalization. The final report does not preserve those candidates,
so it is not known whether n1 specifically was proposed then rejected. It is
incorrect to claim the model generated no candidate or to attribute the miss
solely to the discovery prompt.

Call-chain inspection found that confirmation previously sent candidate
title/detail/evidence and source units, **but omitted the actual graph
proposition or relation being judged**. A source quote can be genuine while
the attached node text is false, as n1 demonstrates. A controlled Host stream
test first failed because the confirmation request lacked the target node's
distinct text. The verifier now receives target kind/id and a batch-bounded
subgraph, explicitly told not to treat graph text as
source evidence. The verification dependency fingerprint was bumped from
input version 1 to 2 so old reviews cannot be silently reused under the
changed confirmation context. The controlled test then passed; complete Node
24 `npm test` passed, including persistent reuse and signed extension checks.
This is an evidence-context repair, not a claim that a new full-audit model
run would discover n1: 3119 still runs the previous package and no second
full-model run was made. A separate persistent-Host adversarial check then
constructed a 320-node source-coverage batch whose initial request fit the
existing 64,000-character budget. Repeating each full node text in the
confirmation request exceeded that budget: the test failed before any real
model call. The confirmation path now uses the same compact 120-character
node index as the initial source-coverage pass, while node and relation
batches retain their fuller target context. The same test passed after the
change, including cancellation without graph writes. This proves a bounded
request for that hostile batch, not a universal bound for arbitrary candidate
counts or a real-model quality improvement. No new 3119 package or full
Flash audit was started.

After the compact-index change, a fresh complete Node 24 `npm test` passed,
including the persistent full-verification adversarial test, reuse tests,
generated source/lib parity and signed-extension packaging. `git diff --check`
also passed. The 3119 preview still serves the earlier build; this is local
verification, not a live Flash quality comparison or remote CI result.

A second persistent-Host adversarial run kept that 320-node batch but returned
25 distinct, source-anchored graph-level candidates. Despite the compact
index, the old single confirmation prompt exceeded 64,000 characters; the
red test cancelled before any real model call or graph write. Confirmation now
packs candidates into deterministic size-bounded groups, checks each group's
reply against only its own IDs, and publishes the batch only after every
group succeeds. The green run confirmed all 25 exactly once in multiple
requests with the graph revision unchanged. A separate malicious reply using
an ID from a later group failed after bounded retries and saved zero batch
results. The dependency input fingerprint is version 3 so earlier reviews
cannot be reused as if they had this split-confirmation policy. Full Node 24
`npm test`, including signed-extension validation, passed. This fixes request
size and integrity for the tested case, not the cost of repeating source
context across groups; a single candidate plus context that exceeds the
budget still fails explicitly rather than calling a model with a truncated
prompt. 3119 was not restarted or asked to rerun the frozen v13 full audit.

The next controlled Host check exposed a context asymmetry in the new
independent confirmation: the initial node-only pass excluded the global
graph summary, but confirmation included it again. With 13 nodes forcing a
separate node batch, a distinctive n0 allegation and an unrelated summary,
the adversarial test failed on the summary leak. Confirmation now preserves
the initial node/relation-only summary scope and retains the target node text.
The verification input fingerprint advanced to version 4; the focused
full-verification smoke passed. No real model was called, so the effect on
v13 or other discovery quality remains unknown. Neither 3119 nor 3099 was
restarted, and the work remains uncommitted in the isolated branch.
Fresh complete Node 24 `npm test` passed, including signed-extension
validation; generated source/lib parity and `git diff --check` passed.
