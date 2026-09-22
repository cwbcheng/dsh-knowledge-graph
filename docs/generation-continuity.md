# Generation and Relation Completion Continuity

## Ontology Authority

An append uses the canonical document's ontology, including after a failed
append is resumed. Proposition documents keep their existing incremental
prompt. Learning-view documents use the learning-view extraction contract plus
incremental constraints: emit only new knowledge, reference real existing IDs,
and anchor new evidence in the appended source units.

Declared node attributes (`stage`, `relKind`) and relation attributes (`role`,
`mode`) are part of the graph's meaning, not display-only metadata. They survive
reconstruction of the extraction accumulator, canonical SQLite storage,
windowed reads, consumption, neighborhood reads, and revision snapshots. The
relation-discovery and independent-review prompts also carry those attributes.
Undeclared fields and non-scalar attribute values are not admitted through this
path. These attributes do not grant grounding or semantic approval.

SQLite uses additive `attributes_json` columns on `graph_nodes` and
`graph_edges`. Existing rows receive an empty object without changing document
revisions or inventing missing values. Attributes already discarded by an older
writer cannot be reconstructed by this migration. An older binary can discard
attributes again when replacing a graph, so downgrades require a backup and
must not be treated as lossless write compatibility.

## Relation Recall

Stable concepts can be deduplicated across distant chapters. Candidate retrieval
indexes both the primary paragraph and every retained evidence paragraph;
distance ranking uses the nearest pair of anchors. Thus a later target can
retrieve an already-searched concept whose first occurrence was far away.

The existing bounded search remains: at most 72 nodes per ordinary group,
4 ordinary groups per batch, a source packing target, and rare-term retrieval
for distant passages. Complete primary evidence is never truncated to fit the
packing target. Retrieval is only a proposal step. It neither creates edges nor
bypasses evidence authentication, independent semantic review, or revision CAS.

Two-node extractions with no relation now receive a discovery pass. Single-node
graphs, and already-connected two-node graphs, do not incur that automatic
pass. An explicit relation-completion request keeps its existing behavior.

## Targeted Repair and Recovery Bindings

An invariant-repair prompt carries all ontology-declared node and edge
attributes from the normalized candidate, but not internal approval flags.
Changing an unrelated invariant cannot silently remove or rewrite a retained
node's attributes or a retained, uniquely identified relation's attributes.
Attribute drift, including renaming an attributed node out of the candidate,
produces `repair_semantic_attributes_changed` feedback and consumes the existing
three-attempt budget. A repeatedly lossy repair fails instead of being published.
Invalid or duplicate edges can still be removed/deduplicated by the existing
repair contract; preserving attributes is not a substitute for evidence or
independent semantic review.

New extraction waves record `contextVersion: 2`; new relation-weave journals use
version 2. Their context fingerprints bind the ontology and declared semantic
attributes in addition to the existing source, node, edge, and plan fields. A
mismatch is rejected before further model calls or checkpoint replacement.
Successful unchanged candidates, including empty relation searches, remain
reusable. Version-1 checkpoints/journals retain their original fingerprint codec
and validation scope for compatibility; they are not silently reinterpreted as
version 2. Subsequent new waves/journals use version 2. Unknown versions fail
closed.

## Regression Evidence

- `kg-ontology-extraction-smoke.mjs`: dynamic append prompt, source offsets,
  old/new attributes, and undeclared-field filtering.
- `kg-ontology-checkpoint-smoke.mjs`: persistent extraction failure and restart,
  append failure and restart, canonical reload, completion prompt semantics,
  and rejection of unsupported completion proposals.
- `kg-ontology-persistence-smoke.mjs`: SQLite close/reopen, projections, revision
  restore, CAS, malformed attributes, cross-ontology filtering, and legacy
  schema migration without inferred values.
- `kg-relation-discovery-smoke.mjs`: bidirectional retrieval through a repeated
  concept's later evidence, small-graph discovery, and a persistent continuous
  completion run that accepts a supported direction but rejects its reversal.
- `kg-generation-semantics-smoke.mjs`: full repair payloads, dropped/changed/
  added attributes, renamed attributed nodes, bounded retry, and persistent
  failure in both dynamic and persistent transports.
- `kg-weave-semantic-cache-smoke.mjs`: changed relation semantics invalidate a
  cached search, unchanged empty results are reused, and the version-1 codec
  still restores compatible journals without extra model calls.

Run the standard `npm test` command for these checks and the existing evidence,
concurrency, cancellation, checkpoint, semantic, and packaging regressions.
The model responses in these tests are controlled fixtures. They prove pipeline
behavior and failure boundaries, not the factual quality or recall of a live
provider on arbitrary source material.
