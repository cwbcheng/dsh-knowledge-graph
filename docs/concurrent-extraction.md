# Concurrent extraction

Text and Markdown extraction support 1, 2 (default), or 4 concurrent batches.
Append extraction uses the same scheduler. Conversation trajectory extraction
remains serial. A single top-level task still owns the canonical write boundary.

## Execution and recovery

- Each wave reads the same committed graph prefix. Workers do not merge nodes
  or allocate canonical IDs. Each worker completes extraction, deterministic
  validation, bounded repair, and mechanism coverage before returning a candidate.
- Validated primary extraction is saved with stage `coverage_pending` before
  mechanism coverage begins. Coverage works on a copy, so timeout/cancellation
  cannot corrupt the durable primary candidate. Resume reruns coverage only.
- Successful candidates are saved independently in `checkpoint.pendingWave`
  with stage `complete` (legacy entries without a stage also mean complete).
  SQLite writes are serialized and awaited. A persistence failure stops dispatch.
- The wave is merged in source order only after all workers settle successfully.
  A failed wave retains its successful siblings; no subsequent wave is dispatched.
- `nextBatchIndex` remains the first unmerged batch. It is not the number of
  successful candidates. The UI separates buffered complete candidates from
  primary candidates awaiting coverage.
- Resume verifies the source, canonical revision, wave policy, context fingerprint,
  batch identity, input fingerprint, and saved candidate invariants. It reuses
  valid saved candidates instead of requesting them again.
- Version 2 serial checkpoints remain readable. Pending waves keep their frozen
  grouping on recovery. Source partition policy is never changed by concurrency.
- Cancellation aborts all model streams through the existing per-task cancel hooks.
  Observed rate limits reduce subsequent waves to one worker with bounded backoff.
  Output token limits remain delegated to the model service.

## Cross-batch meaning

Concurrent chunks cannot refer to newly created nodes in the same wave. Their
chunk-pair boundaries are retained in the checkpoint. Final relation weaving
adds groups for those pairs, even when the graph is already connected; relation
evidence validation and high-risk semantic review remain in force. This can add
model calls and is not a guarantee of semantic equivalence to serial generation.
The final canonical graph is published only through the existing validation and
revision-checked write path. Failed relation reviews retain the existing warning
and withholding semantics rather than being described as fully verified.

## Verification

`npm test` includes `scripts/kg-concurrent-extraction-smoke.mjs`. It exercises
1/2/4-worker dispatch, reversed completion order, durable out-of-order success,
resume with both empty and nonempty graph prefixes, corrupt context rejection,
all-stream cancellation, and rate-limit reduction. Fixtures use local model mocks;
they do not measure real-provider throughput or full-book semantic quality.
