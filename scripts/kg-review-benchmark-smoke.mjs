import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fingerprintReviewGold, evaluateReviewRun, compareReviewRuns, renderReviewSheet,
  captureReviewRun } from './kg-review-benchmark.mjs'

const makeCase = (id, category, verdict, allowedFixes) => ({ id, category,
  label: { status: 'draft', rationale: 'Synthetic source and graph make this judgment inspectable.' },
  sourceUnits: [{ paragraph: 0, text: 'Only adults improved; children were not studied.' }],
  graph: { nodes: [{ id: 'n1', type: 'claim', text: 'Everyone improved.', paragraph: 0 }], edges: [] },
  allegation: { issueId: id, targetKind: 'node', targetId: 'n1', title: 'The claim may overgeneralize.' },
  input: { text: '', question: 'Independently verify the allegation.', detail: 'Check the population.',
    evidence: [{ paragraph: 0, quote: 'Only adults improved' }] },
  gold: { verdict, allowedFixes } })
const none = { action: 'none' }
const qualified = { action: 'update_node', nodePatch: { id: 'n1', patch: { text: 'Only adults improved.' } } }
const gold = { schemaVersion: 1, datasetId: 'adversarial-fixture', cases: [
  makeCase('positive', 'qualifier', 'confirmed', [qualified]),
  makeCase('negative', 'false-alarm', 'false_positive', [none]),
  makeCase('uncertain', 'insufficient-source', 'uncertain', [none]),
] }
const hash = fingerprintReviewGold(gold)
const run = (name, predictions) => ({ schemaVersion: 1, datasetId: gold.datasetId, goldHash: hash,
  runId: name, model: 'controlled-' + name, promptVersion: 'test-v1', measurementStatus: 'controlled_fixture', predictions })
const prediction = (caseId, verdict, proposedFix, usage) => ({ caseId, verdict, proposedFix, usage })
const usage = (inputTokens, outputTokens, elapsedMs) => ({ inputTokens, outputTokens, elapsedMs })
const baseline = run('baseline', [
  prediction('positive', 'confirmed', qualified, usage(100, 20, 200)),
  prediction('negative', 'false_positive', none, usage(100, 10, 180)),
  prediction('uncertain', 'uncertain', none, usage(90, 10, 190)),
])
const weak = run('weak', [
  prediction('positive', 'false_positive', none, usage(80, 10, 120)),
  prediction('negative', 'confirmed', qualified, usage(70, 10, 110)),
  prediction('uncertain', 'uncertain', none, null),
])
const result = evaluateReviewRun(gold, weak)
assert.deepEqual(result.metrics.confusion, { tp: 0, fp: 1, fn: 1, tn: 0, positiveAbstain: 0, negativeAbstain: 0 })
assert.equal(result.metrics.unsafeRepairProposals, 1)
assert.equal(result.metrics.missedApprovedRepairs, 1)
assert.equal(result.metrics.cost.complete, false, 'unknown usage cannot become free usage')
assert.equal(result.metrics.cost.inputTokens, 150)
assert.equal(result.metrics.cost.outputTokens, 20)
assert.equal(result.metrics.cost.elapsedMs, 230)
assert.equal(result.labelState, 'draft_not_human_confirmed')
const delta = compareReviewRuns(gold, baseline, weak)
assert.equal(delta.delta.falsePositives, 1)
assert.equal(delta.delta.falseNegatives, 1)
assert.equal(delta.delta.unsafeRepairProposals, 1)
assert.equal(delta.delta.inputTokens, null, 'partial usage cannot be compared as if the missing case were free')
assert.equal(delta.delta.elapsedMs, null)
assert.equal(delta.candidate.metrics.cost.complete, false)
const measuredBase = { ...baseline, measurementStatus: 'reported_real_run' }
const measuredNext = { ...baseline, runId: 'measured-next', measurementStatus: 'reported_real_run',
  predictions: baseline.predictions.map(item => ({ ...item, usage: { ...item.usage,
    inputTokens: item.usage.inputTokens + 1 } })) }
const measuredComparison = compareReviewRuns(gold, measuredBase, measuredNext)
assert.equal(measuredComparison.costComparable, true)
assert.equal(measuredComparison.delta.inputTokens, 3)
const model = { provider: 'fixture', model: 'controlled' }
const requestFor = item => ({ graph: item.graph, text: item.input.text, sourceUnits: item.sourceUnits,
  question: item.input.question, target: { kind: item.allegation.targetKind, id: item.allegation.targetId },
  reviewIssue: { id: item.allegation.issueId, title: item.allegation.title, detail: item.input.detail,
    targetKind: item.allegation.targetKind, targetId: item.allegation.targetId, evidence: item.input.evidence }, model })
const rawCapture = { schemaVersion: 1, datasetId: gold.datasetId, goldHash: hash,
  runId: 'captured', promptVersion: 'test-v1', model,
  measurementStatus: 'controlled_fixture', cases: gold.cases.map((item, index) => ({
    caseId: item.id, startedAtMs: 1000 + index * 100, finishedAtMs: 1090 + index * 100,
    request: requestFor(item),
    taskStatus: { status: 'succeeded', result: { mode: 'issue_review', model: { provider: 'fixture', model: 'controlled' },
      target: { kind: 'node', id: 'n1' }, reviewedIssueId: item.id,
      verdict: baseline.predictions[index].verdict,
      proposedFix: baseline.predictions[index].proposedFix }, modelUsage: { startedRequests: 2, finishedRequests: 2,
      reportedRequests: 2, totals: { totalInputTokens: { tokens: 300, requests: 2 },
        outputTokens: { tokens: 50, requests: 2 } } } },
  })) }
const captured = captureReviewRun(gold, rawCapture)
assert.equal(captured.predictions[0].usage.inputTokens, 300)
assert.equal(captured.predictions[0].usage.elapsedMs, 90)
assert.match(captured.predictions[0].traceHash, /^[0-9a-f]{64}$/)
assert.match(captured.predictions[0].requestHash, /^[0-9a-f]{64}$/)
assert.equal(evaluateReviewRun(gold, captured).metrics.confusion.tp, 1)
assert.equal(evaluateReviewRun(gold, captured).results[0].requestHash, captured.predictions[0].requestHash)
const changeCapturedCase = (index, change) => ({ ...rawCapture, cases: rawCapture.cases.map((item, i) =>
  i === index ? { ...item, ...change(item) } : item) })
const partialUsage = changeCapturedCase(0, item => ({ taskStatus: { ...item.taskStatus,
  modelUsage: { ...item.taskStatus.modelUsage, reportedRequests: 1 } } }))
assert.equal(captureReviewRun(gold, partialUsage).predictions[0].usage, null,
  'partially reported tokens cannot be counted as complete usage')
const unaccountedRequest = changeCapturedCase(0, item => ({ taskStatus: { ...item.taskStatus,
  modelUsage: { ...item.taskStatus.modelUsage, startedRequests: 3 } } }))
assert.equal(captureReviewRun(gold, unaccountedRequest).predictions[0].usage, null,
  'a request without a finished usage record cannot become zero-cost')
assert.throws(() => captureReviewRun(gold, changeCapturedCase(0, item => ({ taskStatus: {
  ...item.taskStatus, status: 'failed' } }))), /not a successful issue review/)
assert.throws(() => captureReviewRun(gold, changeCapturedCase(0, item => ({ taskStatus: {
  ...item.taskStatus, result: { ...item.taskStatus.result, target: { kind: 'node', id: 'wrong' } } } }))),
/target does not match/)
assert.throws(() => captureReviewRun(gold, changeCapturedCase(0, item => ({ taskStatus: {
  ...item.taskStatus, result: { ...item.taskStatus.result, model: { provider: 'fixture', model: 'other' } } } }))),
/model does not match/)
assert.throws(() => captureReviewRun(gold, { ...rawCapture, cases: rawCapture.cases.slice(0, 2) }),
/missing cases/)
const swappedReplies = { ...rawCapture, cases: rawCapture.cases.map((entry, index) =>
  index < 2 ? { ...entry, taskStatus: rawCapture.cases[1 - index].taskStatus } : entry) }
assert.throws(() => captureReviewRun(gold, swappedReplies), /issue.*match/i,
  'two allegations on the same node must not accept each other\'s task-status reply')
const wrongRequestGraph = changeCapturedCase(0, item => ({ request: { ...item.request,
  graph: { ...item.request.graph, nodes: [{ ...item.request.graph.nodes[0], text: 'A different claim.' }] } } }))
assert.throws(() => captureReviewRun(gold, wrongRequestGraph), /request.*match/i,
  'a reply from a different source/graph request must not count against frozen gold')
for (const requestChange of [
  { sourceUnits: [{ paragraph: 0, text: 'Different source.' }] },
  { question: 'A different allegation.' },
  { reviewIssue: { ...rawCapture.cases[0].request.reviewIssue, detail: 'Different issue detail.' } },
]) {
  assert.throws(() => captureReviewRun(gold, changeCapturedCase(0, item => ({
    request: { ...item.request, ...requestChange } }))), /request.*match/i)
}
assert.throws(() => fingerprintReviewGold({ ...gold, cases: gold.cases.map((item, index) =>
  index === 0 ? { ...item, allegation: { ...item.allegation, issueId: '' } } : item) }), /invalid case/)
const sheet = renderReviewSheet(gold, delta)
assert.match(sheet, /Only adults improved; children were not studied/)
assert.match(sheet, /positive/)
assert.match(sheet, /false-alarm/)
assert.match(sheet, /draft_not_human_confirmed/)
assert.throws(() => evaluateReviewRun(gold, { ...weak, goldHash: '0'.repeat(64) }), /goldHash/)
assert.throws(() => evaluateReviewRun(gold, { ...weak, predictions: weak.predictions.slice(0, 2) }), /missing|complete/i)
assert.throws(() => evaluateReviewRun(gold, { ...weak, predictions: [...weak.predictions, weak.predictions[0]] }), /duplicate/i)
assert.throws(() => evaluateReviewRun(gold, { ...weak, predictions: weak.predictions.map(item =>
  item.caseId === 'uncertain' ? { ...item, usage: { inputTokens: -1, outputTokens: 0, elapsedMs: 0 } } : item) }), /usage/i)
assert.notEqual(fingerprintReviewGold({ ...gold, cases: gold.cases.map(item => item.id === 'positive' ?
  { ...item, gold: { verdict: 'false_positive', allowedFixes: [none] } } : item) }), hash)
const fixture = new URL('./fixtures/kg-review-benchmark-draft-v1.json', import.meta.url)
const controlledBaseline = new URL('./fixtures/kg-review-controlled-baseline-v1.json', import.meta.url)
const controlledRegressed = new URL('./fixtures/kg-review-controlled-regressed-v1.json', import.meta.url)
const fixtureGold = JSON.parse(readFileSync(fixture, 'utf8'))
const fixtureResult = compareReviewRuns(fixtureGold, JSON.parse(readFileSync(controlledBaseline, 'utf8')),
  JSON.parse(readFileSync(controlledRegressed, 'utf8')))
assert.equal(fixtureResult.baseline.metrics.confusion.tp, 4)
assert.equal(fixtureResult.candidate.metrics.confusion.fp, 2)
assert.equal(fixtureResult.candidate.metrics.confusion.fn, 1)
assert.equal(fixtureResult.candidate.metrics.confusion.positiveAbstain, 1)
assert.equal(fixtureResult.delta.missedPositiveCases, 2)
assert.equal(fixtureResult.candidate.metrics.unsafeRepairProposals, 3)
assert.equal(fixtureResult.candidate.metrics.unmatchedConfirmedRepairs, 2)
assert.equal(fixtureResult.delta.inputTokens, null, 'controlled synthetic counters are not a real cost comparison')
assert.equal(fixtureResult.costComparable, false)
assert.equal(fixtureResult.candidate.labelState, 'draft_not_human_confirmed')
assert.throws(() => fingerprintReviewGold({ ...fixtureGold, cases: fixtureGold.cases.map(item =>
  item.id === 'negation-reversed' ? { ...item, graph: { ...item.graph, nodes: item.graph.nodes.map(node =>
    ({ ...node, quote: 'The trial conclusively proved improvement.' })) } } : item) }), /quote is not in/,
'a benchmark cannot silently accept a fabricated citation as gold context')
assert.throws(() => fingerprintReviewGold({ ...fixtureGold, cases: fixtureGold.cases.map(item =>
  item.id === 'condition-already-present' ? { ...item, sourceUnits: [...item.sourceUnits, item.sourceUnits[0]] } : item) }),
/duplicate source paragraph/)
const temp = mkdtempSync(join(tmpdir(), 'kg-review-benchmark-'))
try {
  const json = join(temp, 'report.json'), markdown = join(temp, 'review.md')
  const capturePath = join(temp, 'capture.json'), runPath = join(temp, 'captured-run.json')
  writeFileSync(capturePath, JSON.stringify(rawCapture))
  const goldPath = join(temp, 'capture-gold.json')
  writeFileSync(goldPath, JSON.stringify(gold))
  const capturedCli = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', goldPath, '--capture', capturePath, '--run', runPath], { encoding: 'utf8' })
  assert.equal(capturedCli.status, 0, capturedCli.stderr)
  assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).predictions[0].usage.inputTokens, 300)
  const gatedCapture = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', goldPath, '--capture', capturePath, '--run', runPath, '--require-reviewed'], { encoding: 'utf8' })
  assert.equal(gatedCapture.status, 2, 'draft labels must block capture as well as evaluation')
  assert.match(gatedCapture.stderr, /draft labels/)
  const clobber = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', goldPath, '--capture', capturePath, '--run', capturePath], { encoding: 'utf8' })
  assert.equal(clobber.status, 2, 'the converter must not overwrite its audit evidence')
  assert.match(clobber.stderr, /must not overwrite/)
  const cli = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', fixture.pathname, '--baseline', controlledBaseline.pathname,
    '--candidate', controlledRegressed.pathname, '--json', json, '--markdown', markdown], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).candidate.metrics.unsafeRepairProposals, 3)
  assert.match(readFileSync(markdown, 'utf8'), /distant-qualifier/)
  assert.match(readFileSync(markdown, 'utf8'), /For learners in severe anxiety/)
  const rejected = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', fixture.pathname, '--candidate', controlledBaseline.pathname, '--require-reviewed'], { encoding: 'utf8' })
  assert.equal(rejected.status, 2, 'draft labels must not masquerade as human-confirmed ground truth')
  assert.match(rejected.stderr, /draft labels/)
} finally { rmSync(temp, { recursive: true, force: true }) }
console.log(JSON.stringify({ cases: fixtureGold.cases.length, falsePositiveDetected: true, falseNegativeDetected: true,
  unsafeRepairDetected: true, missingCostNotZero: true, draftLabelsExplicit: true }))
