import assert from 'node:assert/strict'
import { fingerprintDiscoveryGold, inspectDiscoveryCapture, evaluateDiscoveryRun } from './kg-discovery-benchmark.mjs'

const sourceUnits = [
  { paragraph: 0, text: 'Only adults improved; children were not studied.' },
  { paragraph: 1, text: 'The two measurements were correlated, but causation was not established.' },
  { paragraph: 2, text: 'A separate negative result was not represented in the graph.' },
]
const graph = { nodes: [
  { id: 'n1', type: 'claim', text: 'Every learner improved.', paragraph: 0, quote: sourceUnits[0].text },
  { id: 'n2', type: 'fact', text: 'The measurements were correlated.', paragraph: 1, quote: sourceUnits[1].text },
], edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'causes',
  evidence: [{ paragraph: 1, quote: sourceUnits[1].text }] }] }
const label = { status: 'codex-reviewed', reviewer: 'Codex', rationale: 'Compared the complete synthetic source and graph.' }
const gold = { schemaVersion: 1, datasetId: 'synthetic-discovery', graph, sourceUnits, revision: 1, findings: [
  { id: 'overgeneralization', targetKind: 'node', targetId: 'n1', summary: 'Adult result generalized to everyone.',
    evidence: [{ paragraph: 0, quote: 'Only adults improved' }], label },
  { id: 'causality', targetKind: 'edge', targetId: 'n1>n2', targetRelation: 'causes',
    summary: 'Correlation mislabeled as causation.', evidence: [{ paragraph: 1, quote: 'causation was not established' }], label },
  { id: 'source-omission', targetKind: 'graph', targetId: 'graph', summary: 'Negative result missing from graph.',
    evidence: [{ paragraph: 2, quote: 'negative result' }], label },
] }
const goldHash = fingerprintDiscoveryGold(gold)
const coverage = { status: 'complete', revision: 1, batchCount: 1,
  completedNodes: 2, completedEdges: 1, completedSourceUnits: 3 }
const fixtureModel = { provider: 'fixture', model: 'controlled' }
const issues = [
  { id: 'ai-1', source: 'ai', targetKind: 'node', targetId: 'n1', title: 'Overgeneralization',
    proposedFix: { action: 'update_node', nodePatch: { nodeId: 'n1', text: 'Only adults improved.' } } },
  { id: 'ai-2', source: 'ai', targetKind: 'edge', targetId: 'n1>n2', targetRelation: 'causes', title: 'Causality' },
  { id: 'ai-3', source: 'ai', targetKind: 'graph', targetId: null, title: 'Omitted result' },
  { id: 'ai-4', source: 'ai', targetKind: 'node', targetId: 'n2', title: 'Spurious allegation',
    proposedFix: { action: 'update_node', nodePatch: { nodeId: 'n2', text: 'A longer but unnecessary label.' } } },
  { id: 'local-1', source: 'local', targetKind: 'node', targetId: 'n2', title: 'Separate local check' },
]
const capture = { schemaVersion: 1, datasetId: gold.datasetId, goldHash, runId: 'controlled-full',
  model: fixtureModel, promptVersion: 'host-test', snapshot: { graph, sourceUnits, revision: 1 },
  taskStatus: { status: 'succeeded', result: { model: fixtureModel,
    modelsUsed: [{ ...fixtureModel, batches: 1 }], coverage, issues } } }
const inspected = inspectDiscoveryCapture(gold, capture)
assert.equal(inspected.issues.length, 4)
assert.equal(inspected.localIssueCount, 1)
const decisions = [
  { issueId: 'ai-1', outcome: 'match', findingId: 'overgeneralization', rationale: 'Same target and adult limitation.',
    repairReview: { status: 'source_supported', rationale: 'The proposed text exactly matches P0 and corrects the scope.' } },
  { issueId: 'ai-2', outcome: 'match', findingId: 'causality', rationale: 'Same edge and relation.',
    repairReview: { status: 'not_proposed', rationale: 'No patch was proposed.' } },
  { issueId: 'ai-3', outcome: 'match', findingId: 'source-omission', rationale: 'Same missing paragraph.',
    repairReview: { status: 'not_proposed', rationale: 'No patch was proposed.' } },
  { issueId: 'ai-4', outcome: 'false_alarm', rationale: 'The source supports this node.',
    repairReview: { status: 'not_justified', rationale: 'The allegation is false, so its extra edit is unnecessary.' } },
]
const adjudication = { schemaVersion: 2, goldHash, reportHash: inspected.reportHash,
  label, decisions }
const result = evaluateDiscoveryRun(gold, capture, adjudication)
assert.deepEqual({ found: result.metrics.discovered, missed: result.metrics.missed,
  falseAlarms: result.metrics.falseAlarms, local: result.metrics.localIssuesExcluded },
{ found: 3, missed: 0, falseAlarms: 1, local: 1 })
assert.equal(result.metrics.adjudicatedPrecision, 0.75)
assert.deepEqual(result.metrics.repairReviews,
  { proposed: 2, sourceSupported: 1, notJustified: 1, sourceUnsafe: 0, uncertain: 0, notProposed: 2 })
assert.equal(result.labelState, 'codex_reviewed_not_human_confirmed')
assert.deepEqual(result.cost, { complete: false, requests: null, inputTokens: null,
  outputTokens: null, cachedInputTokens: null, elapsedMs: null },
'missing model usage and timing must not be reported as zero cost')
const meteredCapture = { ...capture, startedAtMs: 1000, finishedAtMs: 3200,
  taskStatus: { ...capture.taskStatus, modelUsage: { startedRequests: 2,
    finishedRequests: 2, reportedRequests: 2, totals: {
      totalInputTokens: { tokens: 120, requests: 2 },
      outputTokens: { tokens: 80, requests: 2 } },
    cacheHit: { requests: 1, readTokens: 30 } } } }
assert.deepEqual(evaluateDiscoveryRun(gold, meteredCapture, adjudication).cost,
  { complete: true, requests: 2, inputTokens: 120, outputTokens: 80,
    cachedInputTokens: 30, elapsedMs: 2200 },
  'a complete model run must expose measured token use and elapsed time')
const partialMeter = { ...meteredCapture, taskStatus: { ...meteredCapture.taskStatus,
  modelUsage: { ...meteredCapture.taskStatus.modelUsage, reportedRequests: 1 } } }
assert.equal(evaluateDiscoveryRun(gold, partialMeter, adjudication).cost.complete, false,
  'partial provider accounting cannot masquerade as a complete cost observation')
const model = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }
const modelCapture = { ...capture, model, taskStatus: { ...capture.taskStatus,
  result: { ...capture.taskStatus.result, model,
    modelsUsed: [{ ...model, batches: 1 }] } } }
assert.equal(inspectDiscoveryCapture(gold, modelCapture).issues.length, 4)
assert.throws(() => inspectDiscoveryCapture(gold, { ...modelCapture,
  model: { ...model, model: 'another-model' } }), /model identity/,
'the declared benchmark model cannot differ from the model in the Host report')
assert.throws(() => inspectDiscoveryCapture(gold, { ...modelCapture,
  taskStatus: { ...modelCapture.taskStatus, result: { ...modelCapture.taskStatus.result,
    modelsUsed: [...modelCapture.taskStatus.result.modelsUsed,
      { provider: 'commandcode', model: 'another-model', batches: 1 }] } } }), /model identity/,
'a mixed-model report cannot be credited to one Flash run')
assert.throws(() => inspectDiscoveryCapture(gold, { ...modelCapture,
  taskStatus: { ...modelCapture.taskStatus, result: { ...modelCapture.taskStatus.result,
    coverage: { ...modelCapture.taskStatus.result.coverage, batchCount: 2 } } } }), /model identity/,
'model provenance must account for every completed batch')
assert.throws(() => inspectDiscoveryCapture(gold, { ...modelCapture, model: 'controlled' }), /model identity/,
'a magic fixture label cannot bypass Host model provenance for a real run')
const repeatedReport = { ...capture, taskStatus: { status: 'succeeded', result: { ...capture.taskStatus.result, coverage,
  issues: [...issues, { id: 'ai-repeat', source: 'ai', targetKind: 'node', targetId: 'n1', title: 'Same issue again' }] } } }
const repeatedInspection = inspectDiscoveryCapture(gold, repeatedReport)
const repeatedResult = evaluateDiscoveryRun(gold, repeatedReport, { ...adjudication,
  reportHash: repeatedInspection.reportHash,
  decisions: [...decisions, { issueId: 'ai-repeat', outcome: 'match', findingId: 'overgeneralization',
    rationale: 'Duplicate allegation for the same target and defect.',
    repairReview: { status: 'not_proposed', rationale: 'No patch was proposed.' } }] })
assert.equal(repeatedResult.metrics.discovered, 3)
assert.equal(repeatedResult.metrics.duplicates, 1,
  'two reports of one defect must not inflate whole-graph discovery recall')

const emptyReport = { ...capture, taskStatus: { status: 'succeeded', result: { ...capture.taskStatus.result, coverage, issues: [] } } }
const emptyInspection = inspectDiscoveryCapture(gold, emptyReport)
const emptyResult = evaluateDiscoveryRun(gold, emptyReport, { ...adjudication,
  reportHash: emptyInspection.reportHash, decisions: [] })
assert.equal(emptyResult.metrics.missed, 3,
  'complete whole-graph coverage with no discoveries must count every known defect as missed')
assert.equal(emptyResult.metrics.adjudicatedPrecision, null,
  'no candidates cannot be represented as perfect precision')
for (const changedCoverage of [
  { ...coverage, status: 'partial' },
  { ...coverage, completedNodes: 1 },
  { ...coverage, completedEdges: 0 },
  { ...coverage, completedSourceUnits: 2 },
  { ...coverage, revision: 2 },
]) {
  assert.throws(() => inspectDiscoveryCapture(gold, { ...emptyReport,
    taskStatus: { status: 'succeeded', result: { ...capture.taskStatus.result,
      coverage: changedCoverage, issues: [] } } }),
  /coverage/, 'a partial scan cannot be scored as zero discoveries')
}
assert.throws(() => inspectDiscoveryCapture(gold, { ...capture,
  snapshot: { ...capture.snapshot, sourceUnits: [{ paragraph: 0, text: 'Different source.' }] } }), /snapshot/)
assert.throws(() => inspectDiscoveryCapture(gold, { ...capture,
  taskStatus: { status: 'succeeded', result: { ...capture.taskStatus.result, coverage, issues: issues.map(item => item.id === 'ai-1'
    ? { ...item, proposedFix: { action: 'invented_action' } } : item) } } }),
/invalid or duplicate AI discovery issue/, 'unknown repair actions cannot be adjudicated as valid patches')
assert.throws(() => inspectDiscoveryCapture(gold, { ...capture,
  taskStatus: { status: 'succeeded', result: { ...capture.taskStatus.result, coverage, issues: issues.map(item => item.id === 'ai-4'
    ? { ...item, source: 'unknown' } : item) } } }),
/issue source/, 'an unattributed AI candidate cannot disappear into the excluded local count')
assert.throws(() => evaluateDiscoveryRun(gold, capture, { ...adjudication,
  reportHash: '0'.repeat(64) }), /exact completed report/)
assert.throws(() => evaluateDiscoveryRun(gold, capture, { ...adjudication,
  decisions: decisions.slice(0, 3) }), /exact completed report/)
assert.throws(() => evaluateDiscoveryRun(gold, capture, { ...adjudication,
  decisions: decisions.map(item => item.issueId === 'ai-4' ? { ...item, repairReview: undefined } : item) }),
/repair review/, 'a proposed patch cannot silently pass without semantic review')
assert.throws(() => evaluateDiscoveryRun(gold, capture, { ...adjudication,
  decisions: decisions.map(item => item.issueId === 'ai-4' ? { ...item,
    repairReview: { status: 'not_proposed', rationale: 'Incorrectly says no patch.' } } : item) }),
/repair review/, 'a proposed patch cannot be disguised as absent')
assert.throws(() => evaluateDiscoveryRun(gold, capture, { ...adjudication,
  decisions: decisions.map(item => item.issueId === 'ai-2' ? { ...item,
    repairReview: { status: 'source_supported', rationale: 'Invented approval.' } } : item) }),
/repair review/, 'absence of a patch cannot be called source-supported')
assert.throws(() => evaluateDiscoveryRun(gold, capture, { ...adjudication,
  decisions: decisions.map(item => item.issueId === 'ai-4' ? { ...item,
    repairReview: { status: 'source_supported', rationale: 'The rewrite sounds plausible.' } } : item) }),
/repair review/, 'a false allegation cannot receive an approved corrective edit')
assert.throws(() => evaluateDiscoveryRun(gold, { ...capture,
  taskStatus: { status: 'succeeded', result: { ...capture.taskStatus.result, coverage, issues: issues.map(item => item.id === 'ai-4'
    ? { ...item, proposedFix: { action: 'none' } } : item) } } }, adjudication),
/exact completed report/, 'changing a proposed fix must invalidate its prior adjudication')
const unsafeResult = evaluateDiscoveryRun(gold, capture, { ...adjudication,
  decisions: decisions.map(item => item.issueId === 'ai-1' ? { ...item,
    repairReview: { status: 'source_unsafe', rationale: 'A synthetic reviewer rejects this patch.' } } : item) })
assert.equal(unsafeResult.metrics.repairReviews.sourceUnsafe, 1,
  'a found defect may still have an unsafe proposed repair')
assert.throws(() => evaluateDiscoveryRun(gold, capture, { ...adjudication,
  decisions: decisions.map(item => item.issueId === 'ai-4' ? { ...item, outcome: 'match',
    findingId: 'overgeneralization' } : item) }), /different target/)
assert.throws(() => fingerprintDiscoveryGold({ ...gold, findings: gold.findings.map(item =>
  item.id === 'causality' ? { ...item, evidence: [{ paragraph: 1, quote: 'The source never said this.' }] } : item) }),
/not in source/)
const parallelEdgeGold = structuredClone(gold)
parallelEdgeGold.graph.edges.push({ ...parallelEdgeGold.graph.edges[0], relation: 'correlates_with' })
parallelEdgeGold.findings[1] = { ...parallelEdgeGold.findings[1], targetRelation: undefined }
assert.throws(() => fingerprintDiscoveryGold(parallelEdgeGold), /edge relation/,
  'a finding without an exact relation could credit an issue on a different parallel edge')
const cleanUnits = [{ paragraph: 0, text: 'Only adults improved.' }]
const cleanGraph = { nodes: [{ id: 'clean', type: 'fact', text: 'Only adults improved.',
  paragraph: 0, quote: cleanUnits[0].text }], edges: [] }
const cleanGold = { schemaVersion: 1, datasetId: 'synthetic-clean-graph', graph: cleanGraph,
  sourceUnits: cleanUnits, revision: 1, findings: [],
  negativeReview: { status: 'codex-reviewed', reviewer: 'Codex',
    rationale: 'Reviewed the complete synthetic source and graph; the sole claim matches the source.' } }
assert.throws(() => fingerprintDiscoveryGold({ ...cleanGold, negativeReview: undefined }), /negative review/,
  'zero gold findings require an explicit review of the whole source and graph')
const cleanHash = fingerprintDiscoveryGold(cleanGold)
const cleanCoverage = { status: 'complete', revision: 1, batchCount: 1,
  completedNodes: 1, completedEdges: 0, completedSourceUnits: 1 }
const cleanCapture = { schemaVersion: 1, datasetId: cleanGold.datasetId, goldHash: cleanHash,
  runId: 'controlled-clean', model: fixtureModel, promptVersion: 'host-test',
  snapshot: { graph: cleanGraph, sourceUnits: cleanUnits, revision: 1 },
  taskStatus: { status: 'succeeded', result: { model: fixtureModel,
    modelsUsed: [{ ...fixtureModel, batches: 1 }], coverage: cleanCoverage, issues: [] } } }
const cleanInspection = inspectDiscoveryCapture(cleanGold, cleanCapture)
const cleanScore = evaluateDiscoveryRun(cleanGold, cleanCapture, { schemaVersion: 2,
  goldHash: cleanHash, reportHash: cleanInspection.reportHash, label, decisions: [] })
assert.equal(cleanScore.metrics.discoveryRecall, null,
  'a clean graph has no positive findings, so recall is undefined rather than perfect or NaN')
assert.equal(cleanScore.metrics.adjudicatedPrecision, null)
const cleanFalseReport = { ...cleanCapture, taskStatus: { ...cleanCapture.taskStatus,
  result: { ...cleanCapture.taskStatus.result, issues: [{ id: 'ai-fp', source: 'ai',
    targetKind: 'node', targetId: 'clean', proposedFix: { action: 'none' } }] } } }
const cleanFalseInspection = inspectDiscoveryCapture(cleanGold, cleanFalseReport)
const cleanFalseScore = evaluateDiscoveryRun(cleanGold, cleanFalseReport, { schemaVersion: 2,
  goldHash: cleanHash, reportHash: cleanFalseInspection.reportHash, label,
  decisions: [{ issueId: 'ai-fp', outcome: 'false_alarm', rationale: 'The clean source supports the node.',
    repairReview: { status: 'not_proposed', rationale: 'No patch was proposed.' } }] })
assert.equal(cleanFalseScore.metrics.falseAlarms, 1)
assert.equal(cleanFalseScore.metrics.adjudicatedPrecision, 0)
assert.equal(cleanFalseScore.metrics.discoveryRecall, null)
console.log(JSON.stringify({ fullCoverageRequired: true, independentDiscoveryRecall: true,
  everyAiCandidateAdjudicated: true, localRulesExcluded: true, reportAndSnapshotFenced: true }))
