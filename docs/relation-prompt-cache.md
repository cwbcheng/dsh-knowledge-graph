# Relation Search Context and Usage

Relation discovery still uses bounded target batches and independent semantic
review. Caching does not change the target coverage ledger or the set of
admissible endpoints. No output-token cap is added.

## Prompt Layout

1. Stable system instructions and document title.
2. Canonically ordered JSON-line source paragraphs and node records shared by
   two adjacent groups.
3. The current group's remaining source paragraphs and node records.
4. Dynamic batch number, connectivity, primary targets, allowed endpoint IDs,
   candidate pairs and existing edges.
5. Retry feedback, when needed.

The shared section is an intersection, not a union. A request receives exactly
its originally selected nodes and full source paragraphs. Source text is not
truncated, and unrelated book text is not added to inflate a cache-hit ratio.
Groups with overlapping context are paired within an eight-group lookahead;
this keeps scheduling bounded for large concurrent-boundary repair plans.

`generation.connectivity.contextReuse` records group counts and shared context
character lengths. These are prompt-layout diagnostics, NOT cache-hit metrics.
Pairing applies within a relation-search invocation. Later clicks can select
different contexts; cross-invocation hits are not guaranteed. Neither prefix
length in characters nor group adjacency guarantees provider cache residency.

## Reported Usage

`callModel` accepts DSH `usage` events. Each event is a request-level snapshot,
not a token delta. The latest valid snapshot is accounted for once when the
request settles, including reported failed, retried and cancelled calls.
Usage events are not content activity and cannot extend an idle deadline.
Events arriving after timeout or cancellation cannot change task accounting.

The installed DSH `TokenUsage` contract uses disjoint fields:

- `inputTokens`: uncached input only.
- `cacheReadTokens`: input read from cache.
- `cacheWriteTokens`: input written to cache.
- `outputTokens`: output; do not add `reasoningTokens` again.
- `totalTokens`: exact total input plus output when reported.

Total input is derived from a consistent `totalTokens - outputTokens`, or
from all three explicitly reported input categories. Missing cache fields
remain unknown, not zero. Invalid or contradictory totals cannot establish
a cache-hit denominator.

`modelUsage` has version 1 and scope `current_run`. It contains started,
finished and usage-reported request counts, per-field totals with reporting
counts, and matched `cacheHit` input/read totals. Hit rate is token-weighted:
`cacheHit.readTokens / cacheHit.inputTokens`. When only some requests report
both values, the UI names that subset instead of claiming a whole-run rate.

Running task status includes `progress.modelUsage`; terminal task status
includes `modelUsage`. Successful extraction/relation-search results store
`generation.modelUsage` in SQLite, displayed as the latest run's usage.
Resume starts new accounting; these are not lifetime book totals, and old
documents are not backfilled. No provider pricing or cost is inferred.

## Verification

`npm run test:kg-connectivity` includes adversarial cache tests for exact source
preservation, stable shared prefixes, target-set preservation, duplicate usage,
parallel calls, explicit zeros versus missing fields, truncated output,
content-idle timeout, late events, cancellation and per-run isolation. It also
tests generated persistent HTTP routes, SQLite reload and unknown/partial UI
states. `npm test` remains the full repository verification command.
