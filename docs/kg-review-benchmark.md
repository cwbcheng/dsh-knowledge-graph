# Knowledge Graph Issue-Review Benchmark

This is an offline evaluator for **targeted allegations and proposed repairs**.
It does not call a model, read the production database, modify a graph, or
replace the existing 25-case source/answerability QA gate. Every case contains
the source units, graph snapshot, allegation, provisional gold verdict, allowed
repair proposals, and a rationale. The generated Markdown report puts these
beside each run's answer for independent review.

## Label Review

`scripts/fixtures/kg-review-benchmark-codex-v1.json` has twelve deliberately
synthetic cases: the original seven cover reversed negation, an already-present
condition, evidence in another paragraph, same-name concepts with different
meanings, an existing unsafe merge, a distant qualifier, and a source-faithful
author claim whose real-world truth is unknown. Three more cover Chinese
condition/negation and two `learning-view-v1` type distinctions. The last two
contrast explicit causation with correlation that does not justify a causal
edge. Codex checked the source, graph, allegation and
allowed repair in a same-thread evidence pass on 2026-09-27. Two old allowed
repairs had imported a distant paragraph's conclusion into a node that kept
only the local quote; they now repair only the locally grounded statement.
The case-by-case record is in
[`kg-review-benchmark-codex-review-2026-09-27.md`](kg-review-benchmark-codex-review-2026-09-27.md).
**Codex review is not independent human ground truth**, and the fixture is
synthetic, not a representative sample of books or a measured model result.

`scripts/fixtures/kg-review-benchmark-zh-v1.json` is a separate five-case
invented Chinese suite. It preserves the twelve-case fingerprint and historical
runs, while adding necessary-versus-sufficient Learning View material, a
genuinely new verification item, a cross-paragraph causal confound, author
attribution versus external proof, and an undecidable exercise-material type.
Its same-thread Codex decisions and source-by-source rationales are recorded
in the case-review document above. It is not sourced from the user's book.

To avoid imposing full-book labelling on one person, use the Codex-adjudicated
tier with `--require-adjudicated`; it rejects draft labels and reports
`codex_reviewed_not_human_confirmed`. Keep the stronger `--require-reviewed`
gate for datasets that actually have independent human review; it rejects
Codex-only labels. Both tiers require a reviewer, date and case-specific
rationale, but these fields are self-reported, not cryptographic proof.
If no single graph edit can safely fix a confirmed issue, leave only
`{ "action": "none" }`. Editing any label or allowed repair changes the gold
SHA-256 fingerprint; regenerate run files against the corrected frozen set.
Codex should not silently promote its own authoring pass into human review.
The gold loader rejects unsupported actions, missing targets, no-op node
updates, unknown ontology types, cross-coordinate Learning View type edits,
and replacement quotes that are absent from their source paragraph. It also
checks relation endpoints and declared type constraints. This is a structural
guard against counting an impossible proposal as an approved repair, **not**
proof that an edit is semantically faithful or safe after persistence. In
particular, `feature_description` and `feature` share coordinates despite
being material and knowledge respectively; deciding between them requires
evidence review, not this structural gate.
The repository also replays five approved node updates and one relation update against an
independent temporary SQLite document through the real persistent Host
preview and commit routes. This catches quote/paragraph mismatches that a
fixture's source-unit substring check can miss when the Host segments text
differently. It verifies persistence and revision fencing for these synthetic
cases only, not arbitrary relation repairs or real-book model quality.

## Compare Two Runs

Use Node 24. These commands only read fixture JSON and write reports:

```bash
node scripts/kg-review-benchmark.mjs \
  --gold scripts/fixtures/kg-review-benchmark-codex-v1.json --fingerprint

node scripts/kg-review-benchmark.mjs \
  --gold scripts/fixtures/kg-review-benchmark-codex-v1.json \
  --baseline scripts/fixtures/kg-review-controlled-baseline-v1.json \
  --candidate scripts/fixtures/kg-review-controlled-regressed-v1.json \
  --json output/review-comparison.json \
  --markdown output/review-comparison.md \
  --require-adjudicated
```

The two supplied run files are **controlled synthetic predictions with
invented usage counters**, not outputs from any LLM. They demonstrate that a
cheaper-looking run can miss positive cases and propose harmful edits. To
compare actual model or prompt versions, capture a separate run file with the
same `schemaVersion`, `datasetId`, and current `goldHash`; give every case
exactly one result. Record `runId`, the exact DSH `model` provider/model,
`promptVersion`, and `measurementStatus: "reported_real_run"`. Each gold case
also freezes `input.text`, `input.question`, `input.detail` and source-anchored
`input.evidence`, alongside its graph, source units and allegation. Prefer
converting the original `question-graph` admission request and final
`task-status` reply rather than transcribing verdicts, repairs and token
totals by hand. A capture file has this shape (the empty objects stand for the
actual complete request/status objects, not usable benchmark inputs):

```json
{
  "schemaVersion": 1,
  "datasetId": "adversarial-fixture",
  "goldHash": "<current 64-character gold SHA-256>",
  "runId": "model-and-prompt-v1",
  "model": { "provider": "<DSH provider>", "model": "<DSH model>" },
  "promptVersion": "<exact prompt revision>",
  "measurementStatus": "reported_real_run",
  "cases": [
    {
      "caseId": "negation-reversed",
      "startedAtMs": 1000000,
      "finishedAtMs": 1008300,
      "request": {},
      "taskStatus": { "status": "succeeded", "result": {}, "modelUsage": {} }
    }
  ]
}
```

Record `startedAtMs` immediately before task admission and `finishedAtMs`
after the final status reply, including retries and queueing. They are
capture timestamps, not independently verified server timing. Each
`request` must be the exact submitted `question-graph` argument object:
full `graph`, `text`, `sourceUnits`, `question`, `target`, `reviewIssue` and
`model`. The converter compares it against the frozen gold fields, including
issue detail and evidence; extra or changed fields are rejected. Each
`taskStatus` must be the unmodified final reply for that request; retain the
raw capture securely for audit. The converter verifies task success,
issue-review mode, the exact `allegation.issueId` against the Host's
`reviewedIssueId`, model, target, case completeness and usage coverage,
then records SHA-256 traces of both the submitted request and task-status
reply:

```bash
node scripts/kg-review-benchmark.mjs \
  --gold path/to/frozen-gold.json \
  --capture path/to/raw-capture.json \
  --run path/to/normalized-run.json \
  --require-adjudicated
```

The converter can prove only consistency between the **supplied** request,
the frozen case and its supplied status. It cannot independently attest that
the request/status came from the running Host, that the Host built the intended
internal model prompt, or that `measurementStatus` is truthful. Preserve task
IDs and original transport logs with the raw capture, and review them before
treating any comparison as measured quality. Do not copy credentials or
private book text into a public repository.

Each normalized prediction contains `caseId`, `verdict` (`confirmed`,
`false_positive`, or `uncertain`), the exact DSH `proposedFix`, and `usage`:

```json
{
  "caseId": "negation-reversed",
  "verdict": "confirmed",
  "proposedFix": { "action": "none" },
  "usage": { "inputTokens": 1200, "outputTokens": 140, "elapsedMs": 8300 }
}
```

Use the exact final `question-graph` issue-review verdict and normalized fix,
not a prose interpretation. Aggregate all model calls for a case, including a
repair-generation pass. DSH `task-status.modelUsage.totals.totalInputTokens`
includes cache reads/writes when complete; do not substitute a partial
uncached count. The converter requires all started requests to be finished,
reported, and included in both input and output token totals. `elapsedMs` is
the capture interval for that case. If any counter is unavailable, the
converter sets that case's `usage` to `null`; the evaluator marks cost
incomplete and will not compute
token/time deltas against another run. It does not infer currency cost without
a verified price schedule. Store raw task-status/model outputs separately for
auditability and never put credentials in a run file.

## Isolated Live Capture

`scripts/kg-review-benchmark-live.mjs` runs the frozen issue-review requests
sequentially against a loopback DSH service. It refuses a busy service,
verifies the selected model is listed, saves an admitted task ID before
polling, and resumes a pending task rather than submitting a second billable
request. Failed tasks remain in `failures` and are not retried automatically;
inspect the cause before passing `--retry-failed`. A transport failure in the
tiny interval between server admission and saving its task ID cannot be made
idempotent without a server-side request key. Inspect `task-active` before
restarting after such a failure. Do not use a profile with user work in
progress.

For a whole-graph allegation, the Host requires the complete, unscoped
source. The runner joins all frozen contiguous source units as full text and
submits no scoped units; other allegations retain their scoped requests.
The capture converter uses the same request builder and rejects any changed
input.

After configuring an **independent** credential in an isolated profile, run
one case first, then resume the same capture to complete the dataset:

```bash
node scripts/kg-review-benchmark-live.mjs \
  --gold scripts/fixtures/kg-review-benchmark-codex-v1.json \
  --output output/kg-review-live-flash.json \
  --provider deepseek-official --model deepseek-flash --max-cases 1
node scripts/kg-review-benchmark-live.mjs \
  --gold scripts/fixtures/kg-review-benchmark-codex-v1.json \
  --output output/kg-review-live-flash.json \
  --provider deepseek-official --model deepseek-flash
node scripts/kg-review-benchmark.mjs \
  --gold scripts/fixtures/kg-review-benchmark-codex-v1.json \
  --capture output/kg-review-live-flash.json \
  --run output/kg-review-live-flash-run.json --require-adjudicated
```

Repeat with another configured model on the same isolated Host, frozen gold,
and prompt build before comparing normalized runs. Keep raw requests and
task-status replies under ignored `output/`; inspect and redact before
sharing. Catalogue presence does not prove credentials work. The first 3119
DeepSeek-official attempt failed with `MISSING_CREDENTIAL` and no model result.
The user then clarified that the **CommandCode plugin and key from 3099**
should be used on **3119**, rather than sending benchmark tasks to 3099.
Only the CommandCode provider definition and its single credential reference
were copied to the 3119 temporary profile; no secret is in this repository.
The isolated credential file is mode 0600. The runner refuses 3099 and 3109.

### 2026-09-27 CommandCode comparison

Two complete, sequential 12-case captures on 3119 used the same frozen gold
hash `2c47eb753e3e431819ca80ef793290cb7024231e548b2b9ba3d2097ab9a3fb7d`
and Host prompt-build fingerprint `host-issue-review-c4414412e7298740`.
The values below come from DSH task-status counters and wall-clock capture
intervals, not the controlled fixture's invented usage:

| Model | TP / TN / FP / FN | Uncertain gold | Unmatched confirmed repairs | Missed approved repairs | Input tokens | Output tokens | Sum of case times |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| CommandCode DeepSeek V4.1 Flash | 7 / 4 / 0 / 0 | 1 | 1 | 0 | 11,331 | 13,885 | 98.083 s |
| CommandCode DeepSeek V4 Pro | 7 / 4 / 0 / 0 | 1 | 1 | 1 | 12,005 | 17,784 | 254.391 s |

Both models proposed an `update_node` for `unsafe-existing-merge` that keeps
two source-specific meanings in one node while its quote remains anchored to
only one paragraph. The gold allows no one-step edit there, so both proposals
need human or further AI review and must not be auto-applied. Pro also
confirmed `zh-causal-relation-mislabeled` without proposing its supported
relation repair. These are findings on **Codex-reviewed synthetic cases**,
not a real-book error rate, an independently verified accuracy estimate, or
a claim that Flash is generally faster. The runs occurred at different times
while 3099 continued a separate review, so latency is not a controlled
provider benchmark. Token counts do not establish currency cost.

The raw captures and comparison are in ignored `output/`:
`kg-review-live-commandcode-v41-flash-20260927.json`,
`kg-review-live-commandcode-v4-pro-20260927.json`, and
`kg-review-commandcode-comparison-20260927.md`. No production graph or
report was read or changed.

Future CommandCode captures in this project use **DeepSeek V4.1 Flash only**;
the runner rejects other CommandCode models before any request. Historical
Pro output remains available for read-only comparison. An optional persistent
replay of the frozen Flash run showed seven proposed edits pass structural
commit, including the cross-paragraph merged text whose retained quote covers
only P1. The batch review gate now keeps such non-extractive text proposals
for single-item confirmation instead of silently including them in a group
save. Structural commit success is not semantic grounding or repair approval.
An isolated browser round-trip additionally verified one manual-only review
save does not mark unchanged graph semantics stale, while a later extractive
negation repair does. Both statuses survived reload; the unresolved merge
remained open. This is workflow evidence on synthetic data, not a real-book
quality score.

## Interpretation

- The confusion matrix separates true positives, false positives, explicit
  false negatives, true negatives, and abstentions. Recall treats abstained
  positive cases as not found; uncertain gold cases are excluded from binary
  precision/recall and shown separately.
- A fix on a false-positive or uncertain gold case is an **unsafe proposal**.
  On a confirmed case, a fix not in `allowedFixes` is an **unmatched proposal**
  needing review; equivalently safe alternatives may exist. The aggregate
  `unapprovedRepairProposals` counts both groups, so an unmatched confirmed
  repair cannot disappear behind `unsafeRepairProposals: 0`. It means outside
  this frozen approved set, not an independent proof of objective harm. A confirmed case
  with an approved repair but no proposed fix is a missed repair opportunity.
- Counts can overlap. Token and summed-latency differences are shown only
  when both runs have complete usage on identical frozen cases. Better cost
  never compensates for a wrong verdict or destructive fix.
- This suite measures **per-allegation review and repair**, not full-graph
  discovery recall, source OCR fidelity, or live production accuracy. Those
  require separately labelled graph-level samples. Never advertise Codex-only
  or controlled-fixture scores as independent human validation or production
  accuracy.
