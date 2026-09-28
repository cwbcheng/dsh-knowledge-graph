import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDiscoveryFollowupGold, buildMissedDiscoveryFollowupGold } from './kg-discovery-followup-gold.mjs'
import { fingerprintDiscoveryGold, inspectDiscoveryCapture } from './kg-discovery-benchmark.mjs'
import { expectedRequest } from './kg-review-benchmark.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-gold-zh-v6.json', import.meta.url), 'utf8'))
const review = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-followup-zh-v6.json', import.meta.url), 'utf8'))
const fixtureModel = { provider: 'fixture', model: 'controlled' }
const report = { model: fixtureModel, modelsUsed: [{ ...fixtureModel, batches: 1 }],
  coverage: { status: 'complete', revision: gold.revision, batchCount: 1,
  completedNodes: gold.graph.nodes.length, completedEdges: gold.graph.edges.length,
  completedSourceUnits: gold.sourceUnits.length },
issues: [{ id: review.issueId, source: 'ai', targetKind: 'node', targetId: 'n1',
  title: 'speaker attribution error', detail: 'teacher quote was assigned to editor',
  evidence: [{ paragraph: 2, quote: '不能把林的经验判断当成已证实结论' }],
  proposedFix: { action: 'none' } }] }
const capture = { schemaVersion: 1, datasetId: gold.datasetId, goldHash: fingerprintDiscoveryGold(gold),
  runId: 'controlled-discovery', model: fixtureModel, promptVersion: 'controlled',
  snapshot: { graph: gold.graph, sourceUnits: gold.sourceUnits, revision: gold.revision },
  taskStatus: { status: 'succeeded', result: report } }
const inspected = inspectDiscoveryCapture(gold, capture)
const approved = { ...review, reportHash: inspected.reportHash }
const followup = buildDiscoveryFollowupGold(gold, capture, approved)
assert.equal(followup.cases[0].allegation.issueId, review.issueId)
assert.deepEqual(followup.cases[0].sourceUnits, gold.sourceUnits)
assert.deepEqual(followup.cases[0].graph, gold.graph)
assert.throws(() => buildDiscoveryFollowupGold(gold, capture, review), /does not match/,
  'a different model report cannot inherit this repair approval')
assert.throws(() => buildDiscoveryFollowupGold(gold, capture, { ...approved,
  approvedFixes: [{ action: 'delete_node', nodePatch: { id: 'n2' } }] }), /target/,
  'a valid but different node must not inherit the issue repair approval')
const missedGold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-gold-zh-v7.json', import.meta.url), 'utf8'))
const missedReport = { ...report, issues: [], coverage: { ...report.coverage,
  revision: missedGold.revision, completedNodes: missedGold.graph.nodes.length,
  completedEdges: missedGold.graph.edges.length, completedSourceUnits: missedGold.sourceUnits.length } }
const missedCapture = { ...capture, datasetId: missedGold.datasetId, goldHash: fingerprintDiscoveryGold(missedGold),
  snapshot: { graph: missedGold.graph, sourceUnits: missedGold.sourceUnits, revision: missedGold.revision },
  taskStatus: { status: 'succeeded', result: missedReport } }
const missedInspected = inspectDiscoveryCapture(missedGold, missedCapture)
const missedAdjudication = { schemaVersion: 2, goldHash: missedInspected.goldHash,
  reportHash: missedInspected.reportHash, label: { status: 'codex-reviewed', reviewer: 'fixture' }, decisions: [] }
const missedReview = { schemaVersion: 1, datasetId: 'missed-numeric-comparison',
  discoveryGoldHash: missedInspected.goldHash, reportHash: missedInspected.reportHash,
  findingId: 'subgroup-comparison-reversed', category: 'numeric-comparison',
  label: { status: 'codex-reviewed', reviewer: 'fixture', reviewedAt: '2026-09-28',
    rationale: 'P2 and P3 reverse both numerical comparisons in n1.' },
  question: '核对 n1 的两组数值及异质性方向。',
  approvedFixes: [{ action: 'delete_node', nodePatch: { id: 'n1' } }] }
const missedFollowup = buildMissedDiscoveryFollowupGold(missedGold, missedCapture, missedAdjudication, missedReview)
assert.deepEqual(missedFollowup.cases[0].graph, missedGold.graph)
assert.deepEqual(missedFollowup.cases[0].input.evidence, missedGold.findings[0].evidence)
const missedRequest = expectedRequest(missedFollowup.cases[0], fixtureModel)
assert.deepEqual(missedRequest.sourceUnits, missedGold.sourceUnits)
assert.deepEqual(missedRequest.reviewIssue.evidence, missedGold.findings[0].evidence)
assert.equal(missedRequest.target.id, 'n1')
assert.throws(() => buildMissedDiscoveryFollowupGold(missedGold, missedCapture,
  { ...missedAdjudication, reportHash: '0'.repeat(64) }, missedReview), /adjudication|report/)
assert.throws(() => buildMissedDiscoveryFollowupGold(missedGold, missedCapture, missedAdjudication,
  { ...missedReview, approvedFixes: [{ action: 'delete_node', nodePatch: { id: 'n2' } }] }), /target/)
console.log(JSON.stringify({ reportHashFence: true, exactGraphAndSource: true,
  wrongRepairTargetRejected: true, missedFindingBoundToAdjudicatedReport: true }))
