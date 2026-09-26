# Knowledge Graph Code Audit - 2026-09-26

## Scope and boundaries

This pass focused on the graph review, repair, persistence, async recovery, and
large-graph client paths. It is not a claim that every line in the repository
has been audited. Existing uncommitted work was retained. No production graph
was edited, no paid model was invoked, and port 3099 was not restarted.

## Findings fixed

1. **P1: An ungrounded false-positive verdict could dismiss an issue.**
   `normalizeIssueReviewResultHost` now requires validated source evidence for
   both confirmation and dismissal. An unsupported verdict becomes uncertain.
   A new regression failed against the previous implementation before the fix.

2. **P1: Batch evidence could come from stale page text.**
   Both Host transports now offer opt-in source text in `document-export`, from
   the same saved document/revision as the graph. Review and save use that text,
   not page cache. A SHA-256 source fingerprint fences resumed results and the
   final save, including equal-length source edits. Old checkpoints without the
   fingerprint cannot silently reuse their conclusions.

3. **P1: Distinct text patches were incorrectly assumed to be independent.**
   A later patch may have been reasoned from a neighbor changed by an earlier
   patch. Batch planning now checks each review's semantic dependencies after
   earlier accepted changes. Conflicts remain open and eligible for another
   review. Fingerprints include explicitly referenced nodes, endpoint
   neighborhoods, relations between neighbors, summary, and ontology. The
   neighboring-text counterexample failed before this fix. Disconnected,
   independent repairs still apply in one revision-fenced transaction.

4. **P1: Duplicate save entry and optimistic readback could mislead the UI.**
   Batch confirmation now acquires a synchronous lock before awaiting anything,
   waits for queued edits, and checks that the originating view is still open.
   After a successful canonical commit it reloads authoritative graph/source
   data. If readback fails after commit, it reports that state without exposing
   an automatic resubmit path. The revision compare-and-swap remains mandatory.

5. **P2: Missing server tasks could automatically spend model tokens again.**
   A `not_found` response pauses the batch rather than reissuing the request.
   Resumption is an explicit user action. Existing in-flight tasks remain
   recoverable without duplicate submission after pause/refresh.

6. **P2: Late review-context loads could reopen a document the user had left.**
   Both document and trajectory workbenches now discard results after view or
   generation changes, before changing the visible graph or submitting a model
   request.

## Performance

Review-context fingerprinting now reuses node and adjacency indexes for an
immutable canonical snapshot. The deterministic 5,000-node / 10,000-edge /
100-issue counter benchmark recorded 3,002,000 endpoint property reads without
the index versus 63,000 with it, including index construction (97.9% fewer).
Indexed and unindexed signatures are asserted equal. This is not a claim of a
97.9% end-to-end speedup or any reduction in provider token charges.

## Verification

- `npm run test:kg-verification`: passed during this audit.
- `node scripts/kg-question-feedback-ui-smoke.mjs`: passed after the dependency
  hardening, including source changes, duplicate clicks, lost tasks, navigation,
  failed saves, committed-but-failed-readback, and dependent batch patches.
- `npm test`: both full runs, including the final source state, reached the
  final packaging check after all preceding gates passed. Packaging failed with
  `Stale CRX payload: viewer.css`.
  The signed `dist` files were already modified before this audit and were not
  overwritten or re-signed. No assertion or gate was weakened.
- `git diff --check`: passed.
- An isolated browser fixture used the generated client, persistent HTTP Host,
  a temporary SQLite database, and a controlled model. Four reviews made zero
  canonical commits before confirmation. One confirmation produced one commit,
  revision 1 -> 2, statuses `applied`, `applied`, `rejected`, `open`. Reload kept
  those results. Pausing/reloading/resuming retained the original first model
  request instead of submitting another. The final generated code was exercised
  again through batch save, reload, and a subsequent individual review.
- Desktop 1440x1000 and mobile 390x844 layouts were visually inspected. The
  fixture's diagnostic `pre` wrapping was corrected; document scroll width then
  matched viewport width at both sizes, with no browser console errors.

## Release boundary at audit completion

The signed browser extension needs deliberate regeneration using the existing
external signing identity, followed by the packaging gate. A live Host restart
is a separate authorized operation; local source and test success do not prove
the running 3099 process has loaded the new backend. This audit made no commit
or push.

## Authorized release follow-up

The user subsequently requested commit, push, and restart of port 3099. The
previous signed release artifacts were backed up under ignored `scripts/tmp/`
before regeneration with the existing external signing key. `npm run
pack:extension` passed payload parity and stale-payload rejection checks. A new
full `npm test` run then passed with exit code 0, including the final packaging
gate. No test gate was removed or relaxed.

Authenticated preflight found port 3099 idle and recorded the canonical graph
at revision 246 with 4,645 nodes and 8,539 edges. Restart remains conditional on
another idle check immediately beforehand; post-restart verification must
compare canonical graph hashes and the served client against the built module.
