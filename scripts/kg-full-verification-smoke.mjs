import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGraphContract } from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'
import { fingerprintDiscoveryGold, inspectDiscoveryCapture, evaluateDiscoveryRun } from './kg-discovery-benchmark.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'kg-full-verification-'))
const oldDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'graph.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const contract = createGraphContract()
const model = { provider: 'fixture', model: 'full-graph-review' }

function makeGraph(documentId, count, edgeCount) {
  const paragraphs = Array.from({ length: count + 3 }, (_, i) => 'uniqueledger' + i)
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: 'n' + i, type: 'fact', text: paragraphs[i], quote: paragraphs[i], paragraph: i,
    evidence: [{ paragraph: i, quote: paragraphs[i] }],
  }))
  // One orphan and three uncovered source units exercise both boundary cases.
  nodes[count - 1].paragraph = null
  const edges = Array.from({ length: edgeCount }, (_, i) => {
    const from = i % count
    const to = (from + 1 + Math.floor(i / count) * 17) % count
    return { fromNodeId: 'n' + from, toNodeId: 'n' + to, relation: 'supports',
      evidence: [{ paragraph: from, quote: paragraphs[from] }] }
  })
  return { graph: { source: { documentId, sourceId: 'source-' + documentId, title: 'Full review fixture' }, nodes, edges },
    text: paragraphs.join('\n\n'), paragraphs }
}

function createHost(stream) {
  let handler
  host.apply({
    get(name) {
      if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
      return name === 'llm' ? { stream } : null
    },
    effect(fn) { fn() }, interval() { return () => {} },
  })
  return (endpoint, body = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function until(check, label) {
  for (let i = 0; i < 3000; i++) {
    const result = await check()
    if (result) return result
    await sleep(20)
  }
  assert.fail(label)
}

try {
  const large = makeGraph('full-review-large', 4645, 8539)
  const plan = contract.buildFullVerifyPlan(large.text, large.graph)
  assert.deepEqual(plan.coverage, { nodeCount: 4645, edgeCount: 8539,
    sourceUnitCount: 4648, batchCount: plan.batches.length })
  assert(plan.batches.some(batch => batch.sourceCoverageOnly && batch.sourceUnitIds.includes(4647)),
    'uncovered source must have an omission pass')
  assert(plan.batches.some(batch => batch.sourceCoverageOnly && batch.nodes.some(node => node.id === 'n4644')),
    'orphan evidence must appear as read-only completeness context')
  assert(plan.batches.some(batch => batch.relationsOnly), 'cross-batch edges must have their own pass')
  assert.equal(plan.batches.flatMap(batch => batch.primaryNodeIds || []).length, 4645)
  assert.equal(plan.batches.flatMap(batch => batch.primaryEdgeKeys || []).length, 8539)
  assert.equal(plan.batches.flatMap(batch => batch.sourceUnitIds || []).length, 4648)
  store.saveGraph(large.graph, { sourceText: large.text })
  let calls = 0
  const api = createHost(async function* ({ signal }) {
    calls++
    if (calls === 1) { yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }; return }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  })
  assert.match(host.hostBuildSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(await api('engine-identity', {}, 'GET'), { hostBuildSha256: host.hostBuildSha256 })
  assert.equal(calls, 0, 'reading the runtime identity must not call the model')
  const preview = await api('verification-plan', { documentId: 'full-review-large', expectedRevision: 1 })
  assert.deepEqual(preview.coverage, plan.coverage)
  assert.equal(preview.minimumModelRequests, plan.coverage.batchCount)
  assert.equal(calls, 0, 'planning must not call the model')
  assert.equal((await api('verification-plan', { documentId: 'full-review-large', expectedRevision: 0 })).error.code,
    'revision_conflict')
  const request = { documentId: 'full-review-large', expectedRevision: 1, canonicalFull: true,
    mode: 'standard', concurrency: 1, model }
  const conflict = await api('verify-graph', { ...request, expectedRevision: 0 })
  assert.equal(conflict.error.code, 'revision_conflict')
  assert.equal(calls, 0)
  const started = await api('verify-graph', request)
  assert.ok(started.taskId, JSON.stringify(started))
  try {
    await until(() => calls === 2 && store.loadVerificationBatches(started.taskId).length === 1,
      'the full graph did not start and checkpoint its first reviewed batch')
  } catch (error) {
    assert.fail(error.message + ': ' + JSON.stringify({ calls, status: await api('task-status', { taskId: started.taskId }, 'GET') }))
  }
  const running = await api('task-status', { taskId: started.taskId }, 'GET')
  assert.equal(running.progress.verification.coverage.nodeCount, 4645)
  assert.equal(running.progress.verification.coverage.edgeCount, 8539)
  assert.equal(running.progress.verification.coverage.sourceUnitCount, 4648)
  await api('task-pause', { taskId: started.taskId })
  await until(async () => (await api('task-status', { taskId: started.taskId }, 'GET')).status === 'paused', 'full graph did not pause')
  const saved = store.loadCheckpoint(started.taskId)
  assert.equal(saved.checkpoint.verificationPlanVersion, 2)
  assert.equal(saved.checkpoint.graph.nodes.length, 4645)
  assert.equal(saved.nextBatchIndex, 1)
  assert.equal(store.getDocumentRevision('full-review-large'), 1, 'review must not edit the canonical graph')
  let resumedCalls = 0
  const resumedApi = createHost(async function* ({ signal }) {
    resumedCalls++
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  })
  const resumed = await resumedApi('resume-verify', { runId: started.taskId, resumePaused: true })
  assert.equal(resumed.taskId, started.taskId)
  await until(() => resumedCalls === 1, 'the next unsaved batch did not resume')
  assert.equal(store.loadVerificationBatches(started.taskId).length, 1, 'resume must not replay a saved batch')
  await resumedApi('task-pause', { taskId: started.taskId })
  await until(async () => (await resumedApi('task-status', { taskId: started.taskId }, 'GET')).status === 'paused',
    'resumed full graph did not pause')
  store.saveGraph(large.graph, { sourceText: large.text, expectedRevision: 1 })
  assert.equal((await resumedApi('resume-verify', { runId: started.taskId, resumePaused: true })).error.code, 'revision_conflict')
  assert.equal(calls, 2)

  const small = makeGraph('full-review-small', 25, 40)
  small.graph.nodes[0].text = 'An invented conclusion absent from the source.'
  store.saveGraph(small.graph, { sourceText: small.text })
  let completedCalls = 0
  const completeApi = createHost(async function* () {
    completedCalls++
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  })
  const completed = await completeApi('verify-graph', { documentId: 'full-review-small', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 2, model })
  assert.ok(completed.taskId, JSON.stringify(completed))
  const status = await until(async () => {
    const value = await completeApi('task-status', { taskId: completed.taskId }, 'GET')
    return value.status === 'succeeded' ? value : null
  }, 'complete full-graph report was not published')
  assert.equal(status.result.coverage.status, 'complete')
  assert.equal(status.result.coverage.completedNodes, 25)
  assert.equal(status.result.coverage.completedEdges, 40)
  assert.equal(status.result.coverage.completedSourceUnits, 28)
  assert.equal(status.result.coverage.revision, 1)
  assert.equal(store.getDocumentRevision('full-review-small'), 1)
  assert.equal(store.loadVerificationBatches(completed.taskId).length, completedCalls)
  const reviewedGraph = store.getDocument('full-review-small')
  const discoverySourceUnits = small.paragraphs.map((text, paragraph) => ({ paragraph, text }))
  const discoveryLabel = { status: 'codex-reviewed', reviewer: 'Codex',
    rationale: 'The node asserts text absent from its quoted source unit.' }
  const discoveryGold = { schemaVersion: 1, datasetId: 'controlled-host-discovery', revision: 1,
    graph: reviewedGraph, sourceUnits: discoverySourceUnits, findings: [{ id: 'invented-text',
      targetKind: 'node', targetId: 'n0', summary: 'The node invents a conclusion.',
      evidence: [{ paragraph: 0, quote: 'uniqueledger0' }], label: discoveryLabel }] }
  const discoveryCapture = { schemaVersion: 1, datasetId: discoveryGold.datasetId,
    goldHash: fingerprintDiscoveryGold(discoveryGold), runId: completed.taskId,
    model, promptVersion: 'full-verification-smoke',
    snapshot: { graph: reviewedGraph, sourceUnits: discoverySourceUnits, revision: 1 },
    taskStatus: status }
  const discoveryInspection = inspectDiscoveryCapture(discoveryGold, discoveryCapture)
  const discoveryScore = evaluateDiscoveryRun(discoveryGold, discoveryCapture, { schemaVersion: 2,
    goldHash: discoveryCapture.goldHash, reportHash: discoveryInspection.reportHash,
    label: discoveryLabel, decisions: [] })
  assert.equal(discoveryScore.metrics.missed, 1,
    'a completed real Host review that emits no AI issues must miss a known graph defect')
  assert.equal(discoveryScore.metrics.repairReviews.proposed, 0)
  store.saveGraph({ ...reviewedGraph, verification: { lastReport: status.result, stale: false } },
    { sourceText: small.text, expectedRevision: 1 })
  assert.equal(store.getDocument('full-review-small').verification.lastReport.coverage.completedEdges, 40)

  const parallelText = 'Evidence for both relations.'
  const parallelGraph = { source: { documentId: 'full-review-parallel-edges', sourceId: 'parallel-source' },
    nodes: [{ id: 'n0', type: 'fact', text: 'First fact', quote: parallelText, paragraph: 0 },
      { id: 'n1', type: 'fact', text: 'Second fact', quote: parallelText, paragraph: 0 }],
    edges: ['supports', 'causes'].map(relation => ({ fromNodeId: 'n0', toNodeId: 'n1', relation,
      evidence: [{ paragraph: 0, quote: parallelText }] })) }
  store.saveGraph(parallelGraph, { sourceText: parallelText })
  let parallelCalls = 0
  const parallelApi = createHost(async function* () {
    parallelCalls++
    const body = parallelCalls === 1 ? { issues: [{ id: 'e1', severity: 'warning', category: 'relation',
      targetKind: 'edge', targetId: 'n0>n1', targetRelation: 'causes', title: 'Relation issue',
      detail: 'Fixture relation', evidence: [{ paragraph: 0, quote: parallelText }], confidence: 0.9,
      proposedFix: { action: 'none' } }] } : { kept: [{ id: 'b1:e1' }] }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(body) }
  })
  const parallel = await parallelApi('verify-graph', { documentId: 'full-review-parallel-edges', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 1, model })
  const parallelStatus = await until(async () => {
    const value = await parallelApi('task-status', { taskId: parallel.taskId }, 'GET')
    return value.status === 'succeeded' ? value : null
  }, 'parallel-edge review did not complete')
  assert.equal(parallelStatus.result.issues.find(issue => issue.id === 'b1:e1').targetRelation, 'causes')
  assert.equal(parallelCalls, 2, 'relation issue must receive independent confirmation')

  const recoveredGraph = makeGraph('full-review-scope-retry', 25, 0)
  const scopedGraph = makeGraph('full-review-scoped-evidence', 25, 0)
  scopedGraph.graph.edges.push({ fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports',
    evidence: [{ paragraph: 24, quote: scopedGraph.paragraphs[24] }] })
  const scopedPlan = contract.buildFullVerifyPlan(scopedGraph.text, scopedGraph.graph)
  const scopedNodeBatch = scopedPlan.batches.find(batch => batch.nodeReviewOnly && batch.primaryNodeIds.includes('n0'))
  assert.deepEqual(scopedNodeBatch.units.map(unit => unit.num),
    [...Array.from({ length: 12 }, (_, i) => i), 24],
    'node review must include owned node and edge evidence, not unrelated source units')
  assert(scopedPlan.batches.some(batch => batch.sourceCoverageOnly && batch.sourceUnitIds.includes(27)),
    'narrowing node context must not reduce source coverage')
  store.saveGraph(recoveredGraph.graph, { sourceText: recoveredGraph.text })
  let recoveredCalls = 0
  const recoveredPrompts = []
  const recoveredApi = createHost(async function* ({ system, messages }) {
    recoveredCalls++
    recoveredPrompts.push(JSON.stringify({ system, messages }))
    const body = recoveredCalls === 1 ? { issues: [{ id: 'off-scope', severity: 'warning',
      category: 'grounding', targetKind: 'node', targetId: 'n0', title: 'Wrong target',
      detail: 'Must not be saved', evidence: [{ paragraph: 0, quote: recoveredGraph.paragraphs[0] }],
      confidence: 0.9, proposedFix: { action: 'none' } }] } : { issues: [] }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(body) }
  })
  const recovered = await recoveredApi('verify-graph', { documentId: 'full-review-scope-retry', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 1, model })
  const recoveredStatus = await until(async () => {
    const value = await recoveredApi('task-status', { taskId: recovered.taskId }, 'GET')
    return value.status === 'succeeded' ? value : null
  }, 'scope retry did not complete')
  assert.equal(recoveredCalls, recoveredStatus.result.coverage.batchCount + 1)
  assert.match(recoveredPrompts[0], /本次是原文覆盖批/)
  assert.match(recoveredPrompts[0], /targetKind=\\"graph\\"/)
  assert.match(recoveredPrompts[1], /前次回答含有不属于本批的目标/)
  assert.match(recoveredPrompts[2], /本次是节点批/)
  assert.equal(recoveredStatus.result.issues.some(issue => issue.title === 'Wrong target'), false)
  assert.equal(store.loadVerificationBatches(recovered.taskId).length, recoveredStatus.result.coverage.batchCount)
  assert.equal(store.getDocumentRevision('full-review-scope-retry'), 1)

  const invalidGraph = makeGraph('full-review-invalid-target', 25, 0)
  store.saveGraph(invalidGraph.graph, { sourceText: invalidGraph.text })
  let invalidCalls = 0
  const invalidApi = createHost(async function* () {
    invalidCalls++
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ issues: [{ id: 'off-scope', severity: 'warning',
      category: 'grounding', targetKind: 'node', targetId: 'n0', title: 'Off-scope issue', detail: 'Not a source omission',
      evidence: [{ paragraph: 0, quote: invalidGraph.paragraphs[0] }], confidence: 0.2,
      proposedFix: { action: 'none' } }] }) }
  })
  const invalid = await invalidApi('verify-graph', { documentId: 'full-review-invalid-target', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 1, model })
  assert.ok(invalid.taskId)
  const rejected = await until(async () => {
    const value = await invalidApi('task-status', { taskId: invalid.taskId }, 'GET')
    return value.status === 'failed' ? value : null
  }, 'out-of-scope AI output was not rejected')
  assert.match(rejected.error.message, /不属于当前审校批次/)
  assert.equal(invalidCalls, 2, 'repeated scope violations must fail closed after one corrective retry')
  assert.equal(store.loadVerificationBatches(invalid.taskId).length, 0)
  assert.equal(store.getDocumentRevision('full-review-invalid-target'), 1)

  const denseText = 'Dense source paragraph.'
  const denseGraph = { source: { documentId: 'full-review-confirmation-budget', sourceId: 'dense-confirmation-source' },
    nodes: Array.from({ length: 320 }, (_, i) => ({ id: 'n' + i, type: 'fact',
      text: 'dense-node-' + String(i).padStart(4, '0') + '-' + 'x'.repeat(170),
      quote: denseText, paragraph: 0 })), edges: [] }
  store.saveGraph(denseGraph, { sourceText: denseText })
  const densePrompts = []
  const denseApi = createHost(async function* ({ system, messages, signal }) {
    densePrompts.push({ system, text: messages[0].content[0].text })
    if (densePrompts.length === 1) {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ issues: [{ id: 'coverage', severity: 'warning',
        category: 'completeness', targetKind: 'graph', targetId: null, title: 'Missing coverage',
        detail: 'A source detail was omitted', evidence: [{ paragraph: 0, quote: denseText }],
        confidence: 0.9, proposedFix: { action: 'none' } }] }) }
      return
    }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  })
  const dense = await denseApi('verify-graph', { documentId: 'full-review-confirmation-budget', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 1, model })
  assert.ok(dense.taskId)
  await until(() => densePrompts.length === 2, 'dense confirmation request did not start')
  await denseApi('task-cancel', { taskId: dense.taskId })
  await until(async () => (await denseApi('task-status', { taskId: dense.taskId }, 'GET')).status === 'cancelled',
    'dense confirmation task did not cancel')
  assert.match(densePrompts[1].system, /知识图审校复核员/)
  assert(densePrompts[0].text.length <= 64000, 'initial dense batch must fit the existing budget')
  assert(densePrompts[1].text.length <= 64000,
    'independent confirmation must not exceed the same budget after graph context is added')

  const manyPrompts = [], confirmedGroups = []
  const manyIssues = Array.from({ length: 25 }, (_, i) => ({
    id: 'coverage-' + i, severity: 'warning', category: 'completeness', targetKind: 'graph',
    targetId: null, title: 'Missing coverage ' + i, detail: 'Omitted content '.repeat(60),
    evidence: [{ paragraph: 0, quote: denseText }], confidence: 0.9, proposedFix: { action: 'none' },
  }))
  const manyApi = createHost(async function* ({ system, messages }) {
    const text = messages[0].content[0].text
    manyPrompts.push({ system, text })
    if (manyPrompts.length === 1) {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ issues: manyIssues }) }
      return
    }
    if (system.includes('知识图审校复核员')) {
      const begin = text.indexOf('['), end = text.indexOf('\n\n相关原文段落：')
      const ids = JSON.parse(text.slice(begin, end)).map(issue => issue.id)
      confirmedGroups.push(ids)
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ kept: ids.map(id => ({ id })) }) }
      return
    }
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  })
  const many = await manyApi('verify-graph', { documentId: 'full-review-confirmation-budget', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 1, model })
  assert.ok(many.taskId)
  const manyStatus = await until(async () => {
    const value = await manyApi('task-status', { taskId: many.taskId }, 'GET')
    return value.status === 'succeeded' ? value : null
  }, 'many-candidate confirmation task did not complete')
  assert(confirmedGroups.length > 1, 'candidate confirmation must be split into multiple bounded requests')
  assert(manyPrompts.filter(prompt => prompt.system.includes('知识图审校复核员'))
    .every(prompt => prompt.text.length <= 64000), 'every confirmation request must fit the batch budget')
  assert.equal(new Set(confirmedGroups.flat()).size, manyIssues.length)
  assert.equal(confirmedGroups.flat().length, manyIssues.length, 'every candidate must be reviewed exactly once')
  assert.equal(manyStatus.result.issues.filter(issue => issue.source === 'ai').length, manyIssues.length)
  assert.equal(store.getDocumentRevision('full-review-confirmation-budget'), 1)
  const laterGroupId = confirmedGroups.at(-1).at(-1)
  assert(!confirmedGroups[0].includes(laterGroupId))
  let badGroupCalls = 0
  const badGroupApi = createHost(async function* ({ system }) {
    badGroupCalls++
    const body = system.includes('知识图审校复核员') ? { kept: [{ id: laterGroupId }] }
      : { issues: manyIssues }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(body) }
  })
  const badGroup = await badGroupApi('verify-graph', { documentId: 'full-review-confirmation-budget', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 1, model })
  assert.ok(badGroup.taskId)
  const badGroupStatus = await until(async () => {
    const value = await badGroupApi('task-status', { taskId: badGroup.taskId }, 'GET')
    return value.status === 'failed' ? value : null
  }, 'cross-chunk candidate ID was not rejected')
  assert.match(badGroupStatus.error.message, /不属于本批的候选编号/)
  assert.equal(badGroupCalls, 4, 'cross-chunk reply must fail after bounded retries')
  assert.equal(store.loadVerificationBatches(badGroup.taskId).length, 0,
    'a rejected confirmation chunk cannot publish a partial batch')

  const unrelatedSummary = 'GLOBAL_SUMMARY_SHOULD_NOT_ENTER_NODE_REVIEW'
  const scopedText = 'Only this source sentence supports the node.'
  const scopedReviewGraph = { source: { documentId: 'full-review-scoped-confirmation', sourceId: 'scoped-confirmation-source' },
    summary: unrelatedSummary,
    nodes: Array.from({ length: 13 }, (_, i) => ({ id: 'n' + i, type: 'fact',
      text: i === 0 ? 'Target proposition under independent review' : scopedText,
      quote: scopedText, paragraph: 0 })), edges: [] }
  store.saveGraph(scopedReviewGraph, { sourceText: scopedText })
  let scopedCandidateIssued = false, scopedConfirmationPrompt = ''
  const scopedApi = createHost(async function* ({ system, messages }) {
    if (system.includes('知识图审校复核员')) {
      scopedConfirmationPrompt = messages[0].content[0].text
      yield { type: 'text-delta', index: 0, text: '{"kept":[{"id":"b2:node-issue"}]}' }
      return
    }
    if (system.includes('本次是节点批') && !scopedCandidateIssued) {
      scopedCandidateIssued = true
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ issues: [{ id: 'node-issue',
        severity: 'warning', category: 'grounding', targetKind: 'node', targetId: 'n0',
        title: 'Target node issue', detail: 'The target proposition conflicts with this source unit',
        evidence: [{ paragraph: 0, quote: scopedText }], confidence: 0.9, proposedFix: { action: 'none' } }] }) }
      return
    }
    yield { type: 'text-delta', index: 0, text: '{"issues":[]}' }
  })
  const scopedReview = await scopedApi('verify-graph', { documentId: 'full-review-scoped-confirmation', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 1, model })
  const scopedReviewStatus = await until(async () => {
    const value = await scopedApi('task-status', { taskId: scopedReview.taskId }, 'GET')
    return value.status === 'succeeded' ? value : null
  }, 'scoped confirmation did not complete')
  assert(scopedConfirmationPrompt.includes('Target proposition under independent review'))
  assert(!scopedConfirmationPrompt.includes(unrelatedSummary),
    'node-only confirmation must not reintroduce a full-graph summary excluded from initial review')
  assert(scopedReviewStatus.result.issues.some(issue => issue.id === 'b2:node-issue'))

  const oversizedText = 'Dense source paragraph.'
  const oversizedGraph = { source: { documentId: 'full-review-oversized-unit', sourceId: 'oversized-source' },
    nodes: Array.from({ length: 600 }, (_, i) => ({ id: 'n' + i, type: 'fact',
      text: 'dense-node-' + String(i).padStart(4, '0') + '-' + 'x'.repeat(110),
      quote: oversizedText, paragraph: 0 })), edges: [] }
  store.saveGraph(oversizedGraph, { sourceText: oversizedText })
  let oversizedCalls = 0
  const oversizedApi = createHost(async function* () { oversizedCalls++; yield { type: 'text-delta', index: 0, text: '{"issues":[]}' } })
  const blockedPreview = await oversizedApi('verification-plan', { documentId: 'full-review-oversized-unit', expectedRevision: 1 })
  assert.equal(blockedPreview.error.code, 'verification_plan_invalid')
  assert.match(blockedPreview.error.message, /超过模型安全预算/)
  const oversized = await oversizedApi('verify-graph', { documentId: 'full-review-oversized-unit', expectedRevision: 1,
    canonicalFull: true, mode: 'standard', concurrency: 1, model })
  assert.ok(oversized.taskId)
  const oversizedStatus = await until(async () => {
    const value = await oversizedApi('task-status', { taskId: oversized.taskId }, 'GET')
    return value.status === 'failed' ? value : null
  }, 'oversized source inventory was not rejected')
  assert.match(oversizedStatus.error.message, /超过模型安全预算/)
  assert.equal(oversizedCalls, 0, 'oversized prompt must be blocked before model call')
  assert.equal(store.loadVerificationBatches(oversized.taskId).length, 0)
} finally {
  store.close()
  if (oldDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = oldDb
  rmSync(dir, { recursive: true, force: true })
}
console.log('full verification smoke passed')
