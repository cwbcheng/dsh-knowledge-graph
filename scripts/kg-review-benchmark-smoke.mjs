import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fingerprintReviewGold, evaluateReviewRun, compareReviewRuns, renderReviewSheet,
  captureReviewRun, expectedRequest } from './kg-review-benchmark.mjs'
import { nodeCoordinatesMap, nodeTypeSet } from '../src/kg-ontology.mjs'

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
assert.equal(result.metrics.unapprovedRepairProposals, 1,
  'a repair on a false allegation must appear in the total unapproved-fix count')
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
assert.equal(delta.delta.unapprovedRepairProposals, 1)
const confirmedWrongFix = { ...baseline, runId: 'confirmed-wrong-fix', predictions: baseline.predictions.map(item =>
  item.caseId === 'positive' ? { ...item, proposedFix: {
    action: 'update_node', nodePatch: { id: 'n1', patch: { text: 'Everyone improved.' } },
  } } : item) }
const wrongRepairReport = evaluateReviewRun(gold, confirmedWrongFix)
assert.equal(wrongRepairReport.metrics.unsafeRepairProposals, 0,
  'the old unsafe metric specifically counts edits made when the allegation is not confirmed')
assert.equal(wrongRepairReport.metrics.unmatchedConfirmedRepairs, 1)
assert.equal(wrongRepairReport.metrics.unapprovedRepairProposals, 1,
  'a confirmed issue with a non-approved patch is not a successful or safe repair')
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
const requestFor = item => expectedRequest(item, model)
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
const wholeGraphCase = JSON.parse(readFileSync(new URL('./fixtures/kg-review-benchmark-codex-v1.json', import.meta.url), 'utf8'))
  .cases.find(item => item.id === 'homonym-not-duplicate')
const wholeGraphRequest = expectedRequest(wholeGraphCase, model)
assert.deepEqual(wholeGraphRequest.sourceUnits, [], 'whole-graph review must not submit scoped source units')
assert(wholeGraphRequest.text.includes(wholeGraphCase.sourceUnits[0].text) &&
  wholeGraphRequest.text.includes(wholeGraphCase.sourceUnits[1].text), 'whole-graph review must retain all source paragraphs')
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
for (const invalidFix of [
  { action: 'teleport_node' },
  { action: 'update_node', nodePatch: { id: 'missing', patch: { text: 'Only adults improved.' } } },
  { action: 'update_node', nodePatch: { id: 'n1', patch: { type: 'not_an_ontology_type' } } },
  { action: 'update_node', nodePatch: { id: 'n1', patch: { text: 'Everyone improved.' } } },
]) {
  assert.throws(() => fingerprintReviewGold({ ...gold, cases: gold.cases.map(item => item.id === 'positive' ?
    { ...item, gold: { ...item.gold, allowedFixes: [invalidFix] } } : item) }), /repair|fix/i,
  'an impossible or no-op gold repair cannot be counted as an approved success')
}
const fixture = new URL('./fixtures/kg-review-benchmark-codex-v1.json', import.meta.url)
const chineseFixture = new URL('./fixtures/kg-review-benchmark-zh-v1.json', import.meta.url)
const controlledBaseline = new URL('./fixtures/kg-review-controlled-baseline-v1.json', import.meta.url)
const controlledRegressed = new URL('./fixtures/kg-review-controlled-regressed-v1.json', import.meta.url)
const fixtureGold = JSON.parse(readFileSync(fixture, 'utf8'))
const chineseGold = JSON.parse(readFileSync(chineseFixture, 'utf8'))
assert.equal(chineseGold.cases.length, 5)
assert(chineseGold.cases.every(item => item.label.status === 'codex-reviewed' && item.label.rationale &&
  item.sourceUnits.every(unit => /[\u3400-\u9fff]/u.test(unit.text))),
  'the new Chinese cases need inspectable source and explicitly AI-reviewed labels')
assert.deepEqual(chineseGold.cases.map(item => item.gold.verdict),
  ['confirmed', 'false_positive', 'confirmed', 'false_positive', 'uncertain'],
  'source-grounded Chinese cases must include real defects, false alarms and abstention')
assert.match(fingerprintReviewGold(chineseGold), /^[0-9a-f]{64}$/)
const chineseCoordinates = nodeCoordinatesMap('learning-view-v1')
for (const item of chineseGold.cases.filter(row => row.graph.ontology === 'learning-view-v1')) {
  for (const node of item.graph.nodes) {
    assert.equal(node.modelKind, chineseCoordinates[node.type]?.modelKind)
    assert.equal(node.layer, chineseCoordinates[node.type]?.layer)
  }
}
assert.throws(() => fingerprintReviewGold({ ...chineseGold, cases: chineseGold.cases.map(item =>
  item.id === 'zh-confounded-causality' ? { ...item, graph: { ...item.graph,
    nodes: item.graph.nodes.map(node => ({ ...node, quote: '练习直接导致成绩提高。' })) } } : item) }),
/quote is not in/, 'a realistic Chinese allegation cannot be frozen with a fabricated source citation')
const replaceFixtureCase = (id, transform) => ({ ...fixtureGold, cases: fixtureGold.cases.map(item =>
  item.id === id ? transform(item) : item) })
assert.throws(() => fingerprintReviewGold(replaceFixtureCase('lv-description-not-feature', item => ({
  ...item, gold: { verdict: 'confirmed', allowedFixes: [
    { action: 'update_node', nodePatch: { id: 'n1', patch: { type: 'rule' } } },
  ] },
}))), /repair/i, 'a type edit cannot silently retain incompatible Learning View coordinates')
assert.throws(() => fingerprintReviewGold(replaceFixtureCase('zh-condition-negation', item => ({
  ...item, gold: { ...item.gold, allowedFixes: [
    { action: 'update_node', nodePatch: { id: 'n1', patch: { quote: '原文并不存在这句话。' } } },
  ] },
}))), /repair/i, 'gold must reject a fabricated replacement quotation')
assert(fixtureGold.cases.every(item => item.label.status === 'codex-reviewed'),
  'Codex evidence review must be explicit in every benchmark label')
assert(fixtureGold.cases.some(item => item.sourceUnits.some(unit => /[\u3400-\u9fff]/u.test(unit.text))),
  'the benchmark must include Chinese source material, not only translated English cases')
assert(fixtureGold.cases.some(item => item.graph.ontology === 'learning-view-v1'),
  'the benchmark must exercise Learning View ontology distinctions')
assert(fixtureGold.cases.some(item => item.allegation.targetKind === 'edge' &&
  item.gold.allowedFixes.some(fix => fix.action === 'update_edge')),
'the benchmark must replay at least one approved relation repair, not only node edits')
const learningCoordinates = nodeCoordinatesMap('learning-view-v1')
const learningTypes = nodeTypeSet('learning-view-v1')
for (const item of fixtureGold.cases.filter(row => row.graph.ontology === 'learning-view-v1')) {
  for (const node of item.graph.nodes) {
    assert(learningTypes.has(node.type), 'Learning View fixture must use a real ontology type')
    assert.equal(node.modelKind, learningCoordinates[node.type].modelKind)
    assert.equal(node.layer, learningCoordinates[node.type].layer)
  }
}
assert.equal(fixtureGold.cases.find(item => item.id === 'lv-negative-example-mislabeled')
  .gold.allowedFixes[0].nodePatch.patch.type, 'negative_example')
for (const id of ['cross-paragraph-exception', 'distant-qualifier']) {
  const item = fixtureGold.cases.find(row => row.id === id)
  const node = item.graph.nodes.find(row => row.id === 'n1')
  assert.equal(item.gold.allowedFixes[0].nodePatch.patch.text,
    item.sourceUnits.find(row => row.paragraph === node.paragraph).text,
    'a one-node text repair must not import a distant paragraph while retaining only the local quote')
}
const codexGold = { ...gold, cases: gold.cases.map(item => ({ ...item,
  label: { status: 'codex-reviewed', reviewer: 'Codex (same-thread evidence pass)',
    reviewedAt: '2026-09-27', rationale: item.label.rationale } })) }
assert.match(fingerprintReviewGold(codexGold), /^[0-9a-f]{64}$/)
const codexRun = { ...baseline, goldHash: fingerprintReviewGold(codexGold) }
assert.equal(evaluateReviewRun(codexGold, codexRun).labelState, 'codex_reviewed_not_human_confirmed')
assert.throws(() => fingerprintReviewGold({ ...codexGold, cases: codexGold.cases.map((item, index) =>
  index === 0 ? { ...item, label: { ...item.label, reviewer: '' } } : item) }), /reviewer/)
const fixtureResult = compareReviewRuns(fixtureGold, JSON.parse(readFileSync(controlledBaseline, 'utf8')),
  JSON.parse(readFileSync(controlledRegressed, 'utf8')))
const groundedBaseline = JSON.parse(readFileSync(controlledBaseline, 'utf8'))
const legacyCrossParagraphFixes = {
  'cross-paragraph-exception': 'The program improved test scores in the adult group; its effect on children is unknown.',
  'distant-qualifier': 'Rapid feedback often helps error correction, but immediate feedback may worsen performance for learners in severe anxiety.',
}
const legacyRun = { ...groundedBaseline, predictions: groundedBaseline.predictions.map(item =>
  legacyCrossParagraphFixes[item.caseId] ? { ...item,
    proposedFix: { ...item.proposedFix, nodePatch: { ...item.proposedFix.nodePatch,
      patch: { text: legacyCrossParagraphFixes[item.caseId] } } } } : item) }
assert.equal(evaluateReviewRun(fixtureGold, legacyRun).metrics.unmatchedConfirmedRepairs, 2,
  'old cross-paragraph fixes must no longer count as approved repairs')
assert.equal(fixtureResult.baseline.metrics.confusion.tp, 7)
assert.equal(fixtureResult.candidate.metrics.confusion.fp, 4)
assert.equal(fixtureResult.candidate.metrics.confusion.fn, 3)
assert.equal(fixtureResult.candidate.metrics.confusion.positiveAbstain, 1)
assert.equal(fixtureResult.delta.missedPositiveCases, 4)
assert.equal(fixtureResult.candidate.metrics.unsafeRepairProposals, 5)
assert.equal(fixtureResult.candidate.metrics.unmatchedConfirmedRepairs, 2)
const byCase = new Map(fixtureResult.candidate.results.map(item => [item.caseId, item]))
assert.equal(byCase.get('zh-condition-negation').predicted, 'false_positive')
assert.equal(byCase.get('lv-description-not-feature').unsafeRepair, true,
  'converting source material into a knowledge type must be counted as an unsafe repair')
assert.equal(byCase.get('lv-negative-example-mislabeled').missedApprovedRepair, true,
  'a correct verdict without the safe type repair must remain visible')
assert.equal(byCase.get('zh-causal-relation-mislabeled').predicted, 'false_positive')
assert.equal(byCase.get('zh-correlation-not-causal').unsafeRepair, true,
  'upgrading mere correlation to causation must count as an unsafe relation repair')
assert.equal(fixtureResult.delta.inputTokens, null, 'controlled synthetic counters are not a real cost comparison')
assert.equal(fixtureResult.costComparable, false)
assert.equal(fixtureResult.candidate.labelState, 'codex_reviewed_not_human_confirmed')
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
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).candidate.metrics.unsafeRepairProposals, 5)
  assert.match(readFileSync(markdown, 'utf8'), /distant-qualifier/)
  assert.match(readFileSync(markdown, 'utf8'), /For learners in severe anxiety/)
  const rejected = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', fixture.pathname, '--candidate', controlledBaseline.pathname, '--require-reviewed'], { encoding: 'utf8' })
  assert.equal(rejected.status, 2, 'Codex-reviewed labels must not masquerade as human-confirmed ground truth')
  assert.match(rejected.stderr, /human-reviewed/)
  const codexFixtureGate = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', fixture.pathname, '--candidate', controlledBaseline.pathname, '--require-adjudicated'], { encoding: 'utf8' })
  assert.equal(codexFixtureGate.status, 0, codexFixtureGate.stderr)
  const draftAdjudication = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', goldPath, '--candidate', join(temp, 'baseline.json'), '--require-adjudicated'], { encoding: 'utf8' })
  assert.equal(draftAdjudication.status, 2, 'draft labels cannot pass the Codex adjudication gate')
  assert.match(draftAdjudication.stderr, /draft labels/)
  const codexGoldPath = join(temp, 'codex-gold.json'), codexRunPath = join(temp, 'codex-run.json')
  writeFileSync(codexGoldPath, JSON.stringify(codexGold))
  writeFileSync(codexRunPath, JSON.stringify(codexRun))
  const adjudicated = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', codexGoldPath, '--candidate', codexRunPath, '--require-adjudicated'], { encoding: 'utf8' })
  assert.equal(adjudicated.status, 0, adjudicated.stderr)
  const notHuman = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', codexGoldPath, '--candidate', codexRunPath, '--require-reviewed'], { encoding: 'utf8' })
  assert.equal(notHuman.status, 2, 'Codex adjudication must not pass the human-reviewed gate')
  assert.match(notHuman.stderr, /human-reviewed/)
  const humanGold = { ...codexGold, cases: codexGold.cases.map(item => ({ ...item,
    label: { ...item.label, status: 'human-reviewed', reviewer: 'Fixture reviewer' } })) }
  const humanRun = { ...baseline, goldHash: fingerprintReviewGold(humanGold) }
  const humanGoldPath = join(temp, 'human-gold.json'), humanRunPath = join(temp, 'human-run.json')
  writeFileSync(humanGoldPath, JSON.stringify(humanGold))
  writeFileSync(humanRunPath, JSON.stringify(humanRun))
  const humanGate = spawnSync(process.execPath, [new URL('./kg-review-benchmark.mjs', import.meta.url).pathname,
    '--gold', humanGoldPath, '--candidate', humanRunPath, '--require-reviewed'], { encoding: 'utf8' })
  assert.equal(humanGate.status, 0, humanGate.stderr)
  assert.equal(JSON.parse(humanGate.stdout).labelState, 'human_reviewed_self_reported')
} finally { rmSync(temp, { recursive: true, force: true }) }
console.log(JSON.stringify({ cases: fixtureGold.cases.length, falsePositiveDetected: true, falseNegativeDetected: true,
  unsafeRepairDetected: true, missingCostNotZero: true, codexReviewNotHuman: true }))
