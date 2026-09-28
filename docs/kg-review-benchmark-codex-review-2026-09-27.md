# Codex Evidence Pass on the Review Benchmark

The first pass checked seven synthetic cases against their complete supplied
source units, graph snapshot, allegation and proposed allowed repairs. It was
performed by Codex in the same task lineage that produced the benchmark. It
is useful for catching internal contradictions, but is **not blinded,
independent human labelling** and provides no estimate of live-book accuracy.
No production data or paid model was used.

| Case | Verdict | Evidence and repair decision |
| --- | --- | --- |
| `negation-reversed` | Confirmed | P1 says the trial *did not show* improvement; n1 says it did. Replacing n1 text with the exact P1 sentence does not imply proven ineffectiveness. |
| `condition-already-present` | False positive | Both P1 and n1 limit the result to adults and say children were not studied. No edit. |
| `cross-paragraph-exception` | Confirmed | P1 supports adult improvement; P2 says the child effect is unknown. n1's all-learners claim is unsupported. The old allowed repair copied P2 into n1 while retaining a P1-only quote. The corrected single-node repair states only the adult result; P2 needs its own anchored representation if retained in the graph. |
| `homonym-not-duplicate` | False positive | Learning transfer and database transfer have different definitions in P1 and P2. The shared word is not a merge justification. |
| `unsafe-existing-merge` | Confirmed | n1 collapses two domain-specific meanings while quoting only P1. Deleting n1 or changing one field would lose information or leave dependent relations unreviewed. No safe single edit is approved. |
| `distant-qualifier` | Confirmed | P1 says feedback *often* helps correction, not that it always improves every learner; P10 adds an anxiety exception already represented by n9. The old allowed repair copied P10 into n1 under a P1-only quote. The corrected repair restores n1's P1 wording and leaves n9 distinct. |
| `insufficient-source` | Uncertain | n1 faithfully attributes the claim to its author, but P1 provides no independent efficacy data. The allegation about real-world ineffectiveness cannot be decided from this source. No edit. |

A second same-thread Codex evidence pass added three **invented Chinese**
source snippets. These are not excerpts from the user's book; their purpose is
to exercise language and ontology distinctions absent from the first seven.

| Case | Verdict | Evidence and repair decision |
| --- | --- | --- |
| `zh-condition-negation` | Confirmed | The synthetic P1 limits the observed result to adults after two spaced sessions and says it does not prove efficacy for children. n1 drops both conditions and asserts efficacy for children. The allowed text repair copies P1 exactly; it does not infer that the method is ineffective for children. |
| `lv-description-not-feature` | False positive | P1 explicitly presents a sentence as discrimination material. n1 is a source-grounded `feature_description`; mentioning distinguishing properties does not require replacing that material node with the abstract `feature` knowledge type. A separate knowledge node could be derived with its own provenance, but no type edit is approved here. |
| `lv-negative-example-mislabeled` | Confirmed | P1 explicitly says the shape is not a square. n1 preserves the sentence but labels it `positive_example`; the safe single-field repair changes only the type to `negative_example`. Both types have the same discrimination/lower coordinates in the declared ontology. |

A third same-thread pass added two invented Chinese relation allegations:

| Case | Verdict | Evidence and repair decision |
| --- | --- | --- |
| `zh-causal-relation-mislabeled` | Confirmed | P1 explicitly says repeated practice *directly caused* the recall improvement. The n1→n2 edge says only `supports`. Updating that edge to `causes` with the same source sentence as evidence preserves the direction and leaves both nodes intact. The isolated persistent Host accepted and grounded this repair. |
| `zh-correlation-not-causal` | False positive | P1 reports an association and explicitly says causation was not proven. Promoting the existing `supports` edge to `causes` would invent a stronger relation, so no repair is approved. |

The twelve-case fixture is labelled `codex-reviewed`, with per-case rationales and
review metadata. `--require-adjudicated` permits this tier, while the existing
`--require-reviewed` gate remains human-only. All old run files have the wrong
gold fingerprint; the supplied controlled baseline/regressed fixtures were
updated only as synthetic demonstration data. Neither their verdicts nor
their token counters measure a real model. The evaluator still scores
proposed fixes. A separate isolated test now replays five approved node edits
and one approved relation edit through the persistent Host and checks
grounding, but that does not
establish safety for every possible repair. Its false-negative metric is for
*known allegations*, not undiscovered full-graph
issues. Those require separate isolated evaluation before item 7 is complete.

## Separate Chinese Suite (2026-09-28)

The five additional cases are frozen in
`scripts/fixtures/kg-review-benchmark-zh-v1.json` under a new dataset ID and
gold fingerprint. They were authored and checked by Codex before the isolated
Flash run. They are **invented**, not excerpts from the user's book, and the
same-thread labels are not blinded or independent human judgments.

| Case | Codex verdict | Evidence and repair decision |
| --- | --- | --- |
| `lv-necessary-not-sufficient` | Confirmed | P1 calls equal sides necessary but not sufficient to identify a square. The material's `intension_description` type implies sufficiency under the declared ontology. Change only its type to `feature_description`; text, quote and upper/discrimination coordinates remain. |
| `lv-new-task-not-recycled` | False positive | The demonstration classifies a circle; the test asks learners to judge a previously unseen rounded rectangle before revealing the answer. Similar subject matter is not reuse of the same item. Keep the verification material. |
| `zh-confounded-causality` | Confirmed | P1 reports co-occurrence; P3 says extra tutoring prevents causal attribution. The node asserts direct causation. The approved single-node repair copies only P1's observation; P3 must not be imported into its P1-only quote. |
| `zh-attributed-not-proven` | False positive | The node explicitly says the author proposes a usually-applicable learning order. P1's lack of a controlled experiment limits claims of external truth, not the faithful record of the author's claim. Do not delete. |
| `lv-exercise-status-unknown` | Uncertain | The record omits whether learners predicted an output before seeing an answer. It also omits whether the task reused an old example. The particular type-change allegation cannot be established from this source; no edit is approved. A reviewer could reasonably reject this specific requested edit as unsupported, which is distinct from proving the underlying exercise type. |

The isolated DeepSeek V4.1 Flash run agreed on the four binary verdicts and
returned `false_positive` for the uncertain fifth case, with no edit. It
proposed a cross-paragraph Chinese text merge for the confirmed causality
issue; that is **not** an approved repair because the target still cites only
P1. The batch auto-save gate rejects it, and the benchmark now exposes it in
the aggregate `unapprovedRepairProposals` count. No scoring of these five
cases is an accuracy estimate on real books.
