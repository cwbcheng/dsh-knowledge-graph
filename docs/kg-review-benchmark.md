# Knowledge Graph Issue-Review Benchmark

This is an offline evaluator for **targeted allegations and proposed repairs**.
It does not call a model, read the production database, modify a graph, or
replace the existing 25-case source/answerability QA gate. Every case contains
the source units, graph snapshot, allegation, draft gold verdict, allowed
repair proposals, and a rationale. The generated Markdown report puts these
beside each run's answer for independent review.

## Label Review

`scripts/fixtures/kg-review-benchmark-draft-v1.json` has seven deliberately
synthetic cases: reversed negation, an already-present condition, evidence in
another paragraph, same-name concepts with different meanings, an existing
unsafe merge, a distant qualifier, and a source-faithful author claim whose
real-world truth is unknown. **All labels are drafts, not human-confirmed
findings.** This fixture tests the evaluator and helps a reviewer inspect the
rubric; it is not a measured model-quality result or a representative sample
of books.

For a governed benchmark, an independent reviewer must check each case's full
source and graph context, decide the allegation's verdict, and inspect every
allowed repair. If no single graph edit can safely fix a confirmed issue,
leave only `{ "action": "none" }`. Correct the gold JSON as needed; then set
that case's `label.status` to `human-reviewed` and record `reviewer`,
`reviewedAt`, and a concrete `rationale`. A self-reported name/date is not
cryptographic proof of independent review. `--require-reviewed` refuses any
remaining draft case. Editing a label changes the gold SHA-256 fingerprint,
so all old run files must be regenerated against the new frozen dataset.

## Compare Two Runs

Use Node 24. These commands only read fixture JSON and write reports:

```bash
node scripts/kg-review-benchmark.mjs \
  --gold scripts/fixtures/kg-review-benchmark-draft-v1.json --fingerprint

node scripts/kg-review-benchmark.mjs \
  --gold scripts/fixtures/kg-review-benchmark-draft-v1.json \
  --baseline scripts/fixtures/kg-review-controlled-baseline-v1.json \
  --candidate scripts/fixtures/kg-review-controlled-regressed-v1.json \
  --json output/review-comparison.json \
  --markdown output/review-comparison.md
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
  --require-reviewed
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

## Interpretation

- The confusion matrix separates true positives, false positives, explicit
  false negatives, true negatives, and abstentions. Recall treats abstained
  positive cases as not found; uncertain gold cases are excluded from binary
  precision/recall and shown separately.
- A fix on a false-positive or uncertain gold case is an **unsafe proposal**.
  On a confirmed case, a fix not in `allowedFixes` is an **unmatched proposal**
  needing review; equivalently safe alternatives may exist. A confirmed case
  with an approved repair but no proposed fix is a missed repair opportunity.
- Counts can overlap. Token and summed-latency differences are shown only
  when both runs have complete usage on identical frozen cases. Better cost
  never compensates for a wrong verdict or destructive fix.
- This suite measures **per-allegation review and repair**, not full-graph
  discovery recall, source OCR fidelity, or live production accuracy. Those
  require separately labelled graph-level samples. Never advertise draft or
  controlled-fixture scores as independent human validation.
