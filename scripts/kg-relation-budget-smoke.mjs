import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

// No server and no real models: direct source instrumentation and generated HTTP
// handlers use mocks plus a disposable SQLite database. --dynamic-only does not
// depend on rebuilt lib artifacts and exercises the journal implementation first.
const oldHarness = globalThis.harness, oldDb = process.env.DSH_KG_DB
const dir = mkdtempSync(join(tmpdir(), 'kg-relation-budget-'))
process.env.DSH_KG_DB = join(dir, 'fixture.sqlite')
let store = await openSqliteStore(process.env.DSH_KG_DB)
const cleanups = []
const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      function relationBatchBudgetHost('
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `      harness.budgetTest = { weaveRelationsBudgetHost, relationBatchBudgetHost, reviewHighRiskRelationsHost, runRelationRetryTask, runTask, rememberCanonicalGraphHost, loadCanonicalDocumentHost, buildRelationWeaveGroupsHost, prepareRelationWeaveContextsHost, graphConnectivityHost, invariantRepairSnapshotHost, sha256HexHost, getTask(id) { return tasks.get(id) }, attach(task) { activeTask = task } }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const invalidBudgets = [null, 0, -1, 21, 1.5, '3', true, NaN]
function fixture(documentId, count = 137) {
  const paragraphs = Array.from({ length: count }, (_, i) => '独立记录' + i + '，仅描述此项观察。')
  return { documentId, paragraphs, text: paragraphs.join('\n\n'), graph: {
    source: { id: 'source-' + documentId, documentId, title: 'Budget fixture' },
    summary: '', warnings: [], nodes: paragraphs.map((text, i) => ({
      id: 'n' + i, type: 'claim', text, quote: text, paragraph: i, evidence: [{ paragraph: i, quote: text }],
    })), edges: [],
  } }
}
function directHost(extractor) {
  const handlers = new Map(), harness = { handle(name, fn) { handlers.set(name, fn) } }
  globalThis.harness = harness
  plugin().apply({ get(name) { return name === 'kgExtractor' ? extractor : null }, interval() {} })
  return { ...harness.budgetTest, handlers }
}
function accumulator(graph) {
  const copy = structuredClone(graph)
  return { nodes: new Map(copy.nodes.map(node => [node.id, node])), edges: copy.edges,
    edgeKeys: new Set(copy.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation)), warnings: [] }
}
async function discover(api, f, { budget = 1, journal = null, runId = f.documentId, task: supplied } = {}) {
  const task = supplied || { id: runId, status: 'running', title: 'Budget fixture', progress: {}, cancelled: false, concurrency: 1 }
  task.relationBatchBudget = budget
  task.relationWeave = journal
  task.persistRelationWeave = async next => {
    store.saveCheckpoint({ version: 2, documentId: f.documentId, taskKind: 'extract', graph: f.graph,
      nextBatchIndex: 1, totalBatches: 1, baseRevision: 0, relationWeave: next },
    { runId, sourceText: f.text, status: 'running' })
  }
  api.attach(task)
  const acc = accumulator(f.graph)
  const result = await api.weaveRelationsBudgetHost(task, null, acc, f.paragraphs, { documentId: f.documentId }, f.text)
  return { result, task, acc }
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function proposal({ targetIds, nodes, units }, count = 1) {
  const targets = targetIds.map(id => nodes.find(node => node.id === id)).filter(Boolean)
  if (targets.length < 2) return { edges: [] }
  const from = targets[0], unit = units.find(item => item.num === from.paragraph)
  return { edges: targets.slice(1, 1 + count).map(to => ({ fromNodeId: from.id, toNodeId: to.id, relation: 'supports',
    evidence: [{ paragraph: unit.num, quote: unit.text }] })) }
}
function supported({ candidates }) {
  return { verdicts: candidates.map(item => ({ id: item.id, verdict: 'supported', reason: 'Independent mocked review', evidence: item.edge.evidence })) }
}
function timeout() { return Object.assign(new Error('Synthetic unfinished request'), { code: 'timeout' }) }
function extractor(extra = {}) {
  return { async extractChunk({ chunk }) { return { summary: '', nodes: chunk.units.map(unit => ({ id: 'n' + unit.num,
    type: 'claim', text: unit.text, quote: unit.text, paragraph: unit.num, evidence: [{ paragraph: unit.num, quote: unit.text }] })), edges: [] } },
    async weaveRelations() { return { edges: [] } }, ...extra }
}
async function dynamicTerminal(api, taskId) {
  assert.equal(typeof taskId, 'string')
  for (let i = 0; i < 2000; i++) {
    const status = await api.handlers.get('task-status')({ taskId })
    if (!['running', 'pausing'].includes(status.status)) return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Bounded source mock did not terminate: ' + taskId)
}
async function directRetry(api, sample, options = {}) {
  const current = api.loadCanonicalDocumentHost(sample.documentId)
  if (!current) api.rememberCanonicalGraphHost(structuredClone(sample.graph), sample.text, 1)
  const task = { id: sample.documentId + '-retry', kind: 'relation-retry', documentId: sample.documentId,
    status: 'running', baseRevision: api.loadCanonicalDocumentHost(sample.documentId).revision,
    title: 'Budget fixture', text: sample.text, progress: {}, cancelled: false, concurrency: 1,
    continuous: false, relationBatchBudget: 2, ...options }
  await api.runRelationRetryTask(task)
  return { task, canonical: api.loadCanonicalDocumentHost(sample.documentId) }
}
function trustedResumeTask(original, checkpoint, id) {
  return { id, kind: 'resume', status: 'running', trustedCheckpoint: true,
    checkpoint, existing: checkpoint.graph, title: original.title, text: original.text,
    documentId: original.documentId, baseRevision: checkpoint.baseRevision || 0,
    model: null, ontology: original.ontology, paragraphOffset: checkpoint.paragraphOffset || 0,
    concurrency: 1, relationBatchBudget: 1, createdAt: Date.now() }
}

try {
  let invalidCalls = 0
  const admission = directHost({ async extractChunk() { invalidCalls++; throw new Error('Must not run') },
    async weaveRelations() { invalidCalls++; throw new Error('Must not run') } })
  for (const relationBatchBudget of invalidBudgets) {
    for (const endpoint of ['extract', 'append-extract', 'resume-extract', 'relation-retry']) {
      const response = await admission.handlers.get(endpoint)({ relationBatchBudget, text: 'Fixture', continuous: true })
      assert.equal(response.error?.code, 'invalid_input', endpoint + ':' + relationBatchBudget)
      assert.equal(response.taskId, undefined)
    }
  }
  assert.equal(invalidCalls, 0)
  assert.equal(admission.relationBatchBudgetHost({}).maxBatches, 1)
  assert.equal(admission.relationBatchBudgetHost({}, true).maxBatches, 3)
  for (const budget of [1, 20]) assert.equal(admission.relationBatchBudgetHost({ relationBatchBudget: budget }).maxBatches, budget)

  const f = fixture('direct-two'), paidTargets = []
  const api = directHost({ async weaveRelations(args) { paidTargets.push(...args.targetIds); return proposal(args) } })
  const first = await discover(api, f, { budget: 2 })
  assert.equal(first.result.coverage.searchedTargets, 96)
  assert.equal(first.result.coverage.remainingTargets, 41)
  assert.equal(first.result.coverage.pass, 1)
  assert.equal(new Set(paidTargets).size, 96)
  assert.equal(first.result.candidateEdgeKeys.length, 8, 'retain proposals from both batches for independent review')
  assert.equal(first.result.completion.maxBatches, 2)
  assert.equal(first.result.completion.completedBatches, 2)
  assert.equal(first.result.completion.stopReason, 'budget_exhausted')
  assert.equal(first.task.progress.completion.checkpointOnly, true)
  assert.equal(first.task.relationWeave.version, 3)
  assert.deepEqual(first.task.relationWeave.batches.map(batch => batch.coverage.searchedTargets), [48, 96])
  assert.equal(store.getDocument(f.documentId), null, 'initial batch journals cannot write unreviewed canonical graphs')

  store.close(); store = await openSqliteStore(process.env.DSH_KG_DB)
  const saved = store.loadCheckpoint(f.documentId)
  let replayCalls = 0
  const replayApi = directHost({ async weaveRelations() { replayCalls++; throw new Error('Paid work repeated') } })
  const replay = await discover(replayApi, f, { journal: saved.checkpoint.relationWeave })
  assert.equal(replayCalls, 0)
  assert.deepEqual(replay.result.candidateEdgeKeys, first.result.candidateEdgeKeys)
  assert.equal(replay.result.coverage.searchedTargets, 96)
  assert.equal(replay.result.completion.maxBatches, 1)
  assert.equal(replay.result.completion.completedBatches, 0)
  assert.equal(replay.result.completion.replayedBatches, 2)
  const legacy = await discover(replayApi, f, { journal: first.task.relationWeave.batches[0].journal, runId: 'legacy-v2' })
  assert.equal(legacy.result.coverage.searchedTargets, 48)
  assert.equal(replayCalls, 0, 'old v2 single-batch journals retain cache compatibility')
  assert.equal(legacy.result.completion.completedBatches, 0)
  assert.equal(legacy.result.completion.replayedBatches, 1)
  const legacyV1 = structuredClone(first.task.relationWeave.batches[0].journal)
  const legacyGroups = replayApi.prepareRelationWeaveContextsHost(replayApi.buildRelationWeaveGroupsHost(f.graph.nodes,
    replayApi.graphConnectivityHost(f.graph.nodes, f.graph.edges), f.paragraphs, null, f.text).groups, f.paragraphs, {})
  legacyV1.version = 1
  legacyV1.binding = replayApi.sha256HexHost(JSON.stringify({ policy: 'relation-weave-v1', ontology: 'proposition-v1', sourceText: f.text,
    base: replayApi.invariantRepairSnapshotHost({ nodes: f.graph.nodes, edges: f.graph.edges }, 'proposition-v1'),
    groups: legacyGroups.map(group => ({ ids: group.nodes.map(node => node.id), targets: group.targetIds, context: group.sharedContext })) }))
  const oldV1 = await discover(replayApi, f, { journal: legacyV1, runId: 'legacy-v1' })
  assert.equal(oldV1.result.completion.completedBatches, 0)
  assert.equal(oldV1.result.completion.replayedBatches, 1)
  assert.equal(replayCalls, 0, 'old v1 journals remain free, independently bound replays')
  const skippedSample = fixture('disabled-complete')
  const noWeaver = directHost({})
  const skipped = await discover(noWeaver, skippedSample, { budget: 2 })
  assert.equal(skipped.task.relationWeave.finished, true)
  assert.equal(skipped.task.relationWeave.batches[0].journal, null)
  const skippedReplay = await discover(replayApi, skippedSample, { journal: skipped.task.relationWeave })
  assert.equal(skippedReplay.result.completion.completedBatches, 0)
  assert.equal(skippedReplay.result.completion.replayedBatches, 1)
  assert.equal(replayCalls, 0, 'finished disabled/skip checkpoints must not open paid discovery when a fresh Host gains a weaver')
  const tampered = structuredClone(first.task.relationWeave)
  tampered.batches[0].journal.results[0].hash = 'not-a-valid-hash'
  await assert.rejects(discover(replayApi, f, { journal: tampered, runId: 'tampered' }), error => error.code === 'checkpoint_invalid')
  assert.equal(replayCalls, 0)

  const interrupted = fixture('direct-interrupted'), completedTargets = []
  let attemptedGroups = 0
  const failApi = directHost({ async weaveRelations(args) {
    if (++attemptedGroups === 6) throw timeout()
    completedTargets.push(...args.targetIds)
    return proposal(args)
  } })
  await assert.rejects(discover(failApi, interrupted, { budget: 2 }), error => error.code === 'timeout')
  const partial = store.loadCheckpoint(interrupted.documentId).checkpoint.relationWeave
  assert.equal(partial.batches.length, 2)
  assert.equal(partial.batches[0].complete, true)
  assert.equal(partial.batches[1].complete, false)
  assert.equal(partial.batches[1].coverage.searchedTargets, 60, 'each durable group includes its exact paid cursor')
  assert.equal(completedTargets.length, 60)
  let mixedUnavailableCalls = 0
  const mixedUnavailableApi = directHost(extractor({ weaveRelations: null,
    async extractChunk() { mixedUnavailableCalls++; throw new Error('Mixed checkpoint repeated extraction') },
    async reviewRelations() { mixedUnavailableCalls++; throw new Error('Mixed incomplete checkpoint entered review') } }))
  const mixedUnavailableTask = { id: 'mixed-partial-no-provider', status: 'running', progress: {}, cancelled: false, concurrency: 1 }
  await assert.rejects(discover(mixedUnavailableApi, interrupted, { journal: structuredClone(partial), task: mixedUnavailableTask }),
    error => error.code === 'relation_weave_failed')
  assert.equal(mixedUnavailableCalls, 0)
  assert.equal(mixedUnavailableTask.relationWeave.finished, false)
  assert.deepEqual(mixedUnavailableTask.relationWeave.batches.map(batch => batch.complete), [true, false])
  assert.deepEqual(mixedUnavailableTask.relationWeave.batches.map(batch => batch.journal), partial.batches.map(batch => batch.journal))
  assert.deepEqual(mixedUnavailableTask.relationWeave.batches.map(batch => batch.coverage), partial.batches.map(batch => batch.coverage))
  assert.equal(mixedUnavailableTask.progress.completion.completedBatches, 0)
  assert.equal(mixedUnavailableTask.progress.completion.replayedBatches, 1, 'a free complete batch cannot seal the following partial batch without a provider')
  assert.equal(store.loadCheckpoint(interrupted.documentId).checkpoint.relationWeave.batches[1].coverage.searchedTargets, 60)
  assert.equal(store.loadCheckpoint(interrupted.documentId).checkpoint.relationWeave.finished, false)
  assert.equal(store.getDocument(interrupted.documentId), null)
  store.close(); store = await openSqliteStore(process.env.DSH_KG_DB)
  const newTargets = []
  const resumedApi = directHost({ async weaveRelations(args) { newTargets.push(...args.targetIds); return proposal(args) } })
  const resumed = await discover(resumedApi, interrupted, { journal: store.loadCheckpoint(interrupted.documentId).checkpoint.relationWeave })
  assert.equal(resumed.result.coverage.searchedTargets, 96)
  assert.equal(resumed.result.coverage.remainingTargets, 41)
  assert.equal(resumed.result.coverage.pass, 1)
  assert.equal(resumed.result.completion.completedBatches, 1)
  assert.equal(resumed.result.completion.replayedBatches, 1)
  assert.equal(newTargets.length, 36)
  assert(newTargets.every(id => !completedTargets.includes(id)), 'fresh Host cannot repeat durable paid targets')
  assert.equal(resumed.result.candidateEdgeKeys.length, 8)
  assert.equal(store.getDocument(interrupted.documentId), null)
  const extendedTargets = []
  const extendedApi = directHost({ async weaveRelations(args) { extendedTargets.push(...args.targetIds); return proposal(args) } })
  const extended = await discover(extendedApi, interrupted, { budget: 2, journal: structuredClone(partial), runId: 'explicit-resume-two' })
  assert.equal(extended.result.coverage.searchedTargets, 137)
  assert.equal(extended.result.coverage.pass, 1)
  assert.equal(extended.result.completion.maxBatches, 2)
  assert.equal(extended.result.completion.completedBatches, 2)
  assert.equal(extended.result.completion.stopReason, 'coverage_complete')
  assert.equal(extendedTargets.length, 77)
  assert(extendedTargets.every(id => !completedTargets.includes(id)))

  const malformedSample = fixture('direct-malformed'), malformedCompleted = []
  const malformedApi = directHost({ async weaveRelations(args) {
    if (args.targetIds.includes('n0')) return { missing: 'edges' }
    malformedCompleted.push(...args.targetIds); return proposal(args)
  } })
  await assert.rejects(discover(malformedApi, malformedSample), error => error.code === 'relation_weave_failed')
  const malformedJournal = store.loadCheckpoint(malformedSample.documentId).checkpoint.relationWeave
  assert.equal(malformedJournal.finished, false)
  assert.equal(malformedJournal.batches[0].complete, false)
  assert.equal(malformedJournal.batches[0].coverage.searchedTargets, 36)
  assert.equal(malformedJournal.completion.completedBatches, 0)
  assert.equal(store.getDocument(malformedSample.documentId), null)
  assert.equal(malformedJournal.completion.stopReason, 'error')
  let tamperCalls = 0
  const tamperApi = directHost({ async weaveRelations() { tamperCalls++; throw new Error('Changed cached authority must not call a model') } })
  for (const variant of ['evidence', 'section', 'source', 'text', 'ontology', 'legacy-outer-coverage']) {
    const changed = structuredClone(malformedSample), changedJournal = structuredClone(malformedJournal)
    if (variant === 'evidence' || variant === 'legacy-outer-coverage') changed.graph.nodes[0].evidence[0].quote += ' 被篡改的引用'
    if (variant === 'section') changed.graph.nodes[0].sectionId = 'changed-section'
    if (variant === 'source') changed.text += '\n\n修改后的原文'
    if (variant === 'text') changed.graph.nodes[0].text += ' 修改后的节点正文'
    if (variant === 'legacy-outer-coverage') delete changedJournal.batches[0].journal.coverage
    if (variant === 'evidence' || variant === 'section') {
      assert.equal(tamperApi.invariantRepairSnapshotHost({ nodes: changed.graph.nodes, edges: [] }),
        tamperApi.invariantRepairSnapshotHost({ nodes: malformedSample.graph.nodes, edges: [] }), 'metadata-only tamper does not alter legacy snapshot authority')
    }
    const task = { id: 'tamper-' + variant, status: 'running', progress: {}, cancelled: false, concurrency: 1,
      ...(variant === 'ontology' ? { ontology: 'learning-view-v1' } : {}) }
    await assert.rejects(discover(tamperApi, changed, { journal: changedJournal, runId: task.id, task }), error => error.code === 'checkpoint_invalid')
    assert.equal(tamperCalls, 0, variant + ' mismatch must fail before any paid target group')
  }
  const recoveredMalformedTargets = []
  const malformedResume = directHost({ async weaveRelations(args) { recoveredMalformedTargets.push(...args.targetIds); return proposal(args) } })
  const recoveredMalformed = await discover(malformedResume, malformedSample, { journal: malformedJournal })
  assert.equal(recoveredMalformed.result.coverage.searchedTargets, 48)
  assert.equal(recoveredMalformedTargets.length, 12)
  assert(recoveredMalformedTargets.every(id => !malformedCompleted.includes(id)))

  for (const budget of [1, 3, 20]) {
    const seen = [], sample = fixture('direct-budget-' + budget)
    const budgetApi = directHost({ async weaveRelations({ targetIds }) { seen.push(...targetIds); return { edges: [] } } })
    const { result } = await discover(budgetApi, sample, { budget })
    assert.equal(result.completion.maxBatches, budget)
    assert.equal(result.completion.completedBatches, budget === 1 ? 1 : 3)
    assert.equal(result.completion.stopReason, budget === 1 ? 'single_batch' : 'coverage_complete')
    assert.equal(result.coverage.searchedTargets, budget === 1 ? 48 : 137)
    assert.equal(result.coverage.pass, 1, 'a larger budget must never open another search round')
    assert.equal(seen.length, new Set(seen).size)
  }
  const pendingMultiSample = fixture('direct-pending-noncontinuous-two'), pendingTargets = []
  const pendingMultiApi = directHost({ async weaveRelations(args) { pendingTargets.push(...args.targetIds); return proposal(args) },
    async reviewRelations() { return {} } })
  const pendingMulti = await directRetry(pendingMultiApi, pendingMultiSample)
  assert.equal(pendingMulti.task.status, 'failed')
  assert.equal(pendingMulti.task.errorCode, 'relation_review_pending')
  assert.equal(pendingMulti.task.progress.completion.stopReason, 'pending_review')
  assert.equal(pendingMulti.task.progress.completion.savedCycles, 1)
  assert.equal(pendingMulti.canonical.revision, 2)
  assert.equal(pendingMulti.canonical.graph.edges.length, 0)
  assert.equal(pendingMulti.canonical.graph.generation.relationDiscovery.searchedTargets, 48)
  assert.equal(pendingMulti.canonical.graph.generation.relationCompletion.stopReason, 'pending_review')
  assert.equal(pendingTargets.length, 48, 'explicit noncontinuous budget two pauses after pending review, before another paid search')
  const pendingRecoveryTargets = []
  const pendingRecoveryApi = directHost({ async weaveRelations(args) { pendingRecoveryTargets.push(...args.targetIds); return proposal(args) }, reviewRelations: supported })
  pendingRecoveryApi.rememberCanonicalGraphHost(pendingMulti.canonical.graph, pendingMultiSample.text, pendingMulti.canonical.revision)
  const pendingRecovery = await directRetry(pendingRecoveryApi, pendingMultiSample)
  assert.equal(pendingRecovery.task.status, 'succeeded')
  assert.equal(pendingRecovery.canonical.graph.generation.relationDiscovery.searchedTargets, 96)
  assert.equal(pendingRecovery.task.progress.completion.completedBatches, 2)
  assert.equal(pendingRecovery.task.progress.completion.stopReason, 'budget_exhausted')
  assert.equal(pendingRecoveryTargets.length, 48, 'fresh recovery reviews old candidates before searching the next batch')
  assert(pendingRecoveryTargets.every(id => !pendingTargets.includes(id)))
  for (const budget of [1, 2]) {
    const sample = fixture('direct-malformed-retry-' + budget), searched = []
    const badRetryApi = directHost({ async weaveRelations(args) {
      if (args.targetIds.includes('n0')) return { missing: 'edges' }
      searched.push(...args.targetIds); return { edges: [] }
    }, reviewRelations: supported })
    const badRetry = await directRetry(badRetryApi, sample, { relationBatchBudget: budget })
    assert.equal(badRetry.task.status, 'failed')
    assert.equal(badRetry.task.errorCode, 'relation_weave_failed')
    assert.equal(badRetry.task.progress.completion.stopReason, 'error')
    assert.equal(searched.length, 36, 'malformed retry does not start a second batch')
    assert.equal(badRetry.canonical.revision, budget === 1 ? 1 : 2)
    assert.equal(badRetry.task.progress.completion.savedCycles, budget === 1 ? 0 : 1)
    if (budget === 2) {
      assert.equal(badRetry.canonical.graph.generation.relationDiscovery.searchedTargets, 36)
      assert.equal(badRetry.canonical.graph.generation.relationCompletion.stopReason, 'error')
    }
  }
  const pendingSingleSample = fixture('direct-pending-single-compatible')
  const pendingSingleApi = directHost({ async weaveRelations(args) { return proposal(args) }, async reviewRelations() { return {} } })
  const pendingSingle = await directRetry(pendingSingleApi, pendingSingleSample, { relationBatchBudget: undefined })
  assert.equal(pendingSingle.task.status, 'succeeded', 'default noncontinuous single-batch pending compatibility is unchanged')
  assert.equal(pendingSingle.task.progress.completion.maxBatches, 1)
  assert.equal(pendingSingle.task.progress.completion.stopReason, 'pending_review')
  assert.equal(pendingSingle.canonical.graph.edges.length, 0)

  const unavailableSample = fixture('direct-initial-review-unavailable'), unavailableTargets = []
  const unavailableApi = directHost(extractor({ async weaveRelations(args) { unavailableTargets.push(...args.targetIds); return proposal(args) } }))
  const unavailableStart = await unavailableApi.handlers.get('extract')({ documentId: unavailableSample.documentId, text: unavailableSample.text,
    title: 'Unavailable reviewer fixture', concurrency: 1, relationBatchBudget: 2 })
  const unavailableEnd = await dynamicTerminal(unavailableApi, unavailableStart.taskId)
  assert.equal(unavailableEnd.status, 'succeeded')
  const unavailableCanonical = unavailableApi.loadCanonicalDocumentHost(unavailableSample.documentId)
  assert.equal(unavailableCanonical.graph.edges.length, 0, 'initial independently discovered candidates cannot bypass an unavailable reviewer')
  assert.equal(unavailableCanonical.graph.generation.semanticReview.pending, 8)
  assert.equal(unavailableCanonical.graph.generation.semanticReview.withheld.filter(item => item.verdict === 'pending').length, 8)
  assert.equal(unavailableTargets.length, 96)
  let unavailableReplayCalls = 0
  const unavailableReplayApi = directHost(extractor({ async extractChunk() { unavailableReplayCalls++; throw new Error('Extraction repeated') },
    async weaveRelations() { unavailableReplayCalls++; throw new Error('Finished v3 discovery repeated') } }))
  const unavailableOriginal = unavailableApi.getTask(unavailableStart.taskId)
  const unavailableCheckpoint = structuredClone(unavailableOriginal.checkpoint)
  delete unavailableCheckpoint.postprocess
  const unavailableResume = { id: 'unavailable-finished-v3-resume', kind: 'resume', status: 'running', trustedCheckpoint: true,
    checkpoint: unavailableCheckpoint, existing: unavailableCheckpoint.graph, title: unavailableOriginal.title, text: unavailableSample.text,
    documentId: unavailableSample.documentId, baseRevision: 0, model: null, ontology: unavailableOriginal.ontology,
    paragraphOffset: unavailableCheckpoint.paragraphOffset || 0, concurrency: 1, relationBatchBudget: 1, createdAt: Date.now() }
  await unavailableReplayApi.runTask(unavailableResume)
  assert.equal(unavailableResume.status, 'succeeded')
  const unavailableReplayed = unavailableReplayApi.loadCanonicalDocumentHost(unavailableSample.documentId)
  assert.equal(unavailableReplayCalls, 0)
  assert.equal(unavailableReplayed.graph.edges.length, 0, 'finished v3 replay cannot admit unreviewed candidates without a model/reviewer')
  assert.equal(unavailableReplayed.graph.generation.semanticReview.pending, 8)
  assert.equal(unavailableReplayed.graph.generation.relationCompletion.completedBatches, 0)
  const restoreApi = directHost({ async weaveRelations() { throw new Error('Restoration must review saved candidates first') }, reviewRelations: supported })
  restoreApi.rememberCanonicalGraphHost(unavailableReplayed.graph, unavailableSample.text, unavailableReplayed.revision)
  const restored = await directRetry(restoreApi, unavailableSample, { reviewPendingOnly: true })
  assert.equal(restored.task.status, 'succeeded')
  assert.equal(restored.canonical.graph.edges.length, 8, 'pending candidate metadata remains recoverable for independent review')

  for (const journalVersion of [3, 2, 1]) {
    let repeatedPaidCalls = 0, reviewedWithoutWeaver = 0
    const noWeaverReviewApi = directHost(extractor({ weaveRelations: null,
      async extractChunk() { repeatedPaidCalls++; throw new Error('Completed extraction repeated without a weaver') },
      async reviewRelations(args) { reviewedWithoutWeaver += args.candidates.length; return supported(args) } }))
    const checkpoint = structuredClone(unavailableCheckpoint)
    if (journalVersion !== 3) checkpoint.relationWeave = structuredClone(checkpoint.relationWeave.batches[0].journal)
    if (journalVersion === 1) {
      const groups = noWeaverReviewApi.prepareRelationWeaveContextsHost(noWeaverReviewApi.buildRelationWeaveGroupsHost(checkpoint.graph.nodes,
        noWeaverReviewApi.graphConnectivityHost(checkpoint.graph.nodes, checkpoint.graph.edges), unavailableSample.paragraphs, null, unavailableSample.text).groups,
      unavailableSample.paragraphs, unavailableOriginal.ontology)
      checkpoint.relationWeave.version = 1
      checkpoint.relationWeave.binding = noWeaverReviewApi.sha256HexHost(JSON.stringify({ policy: 'relation-weave-v1',
        ontology: unavailableOriginal.ontology || 'proposition-v1', sourceText: unavailableSample.text,
        base: noWeaverReviewApi.invariantRepairSnapshotHost(checkpoint.graph, unavailableOriginal.ontology || 'proposition-v1'),
        groups: groups.map(group => ({ ids: group.nodes.map(node => node.id), targets: group.targetIds, context: group.sharedContext })) }))
    }
    const task = trustedResumeTask(unavailableOriginal, checkpoint, 'completed-no-weaver-v' + journalVersion)
    await noWeaverReviewApi.runTask(task)
    assert.equal(task.status, 'succeeded', 'complete v' + journalVersion + ' checkpoint finalizes with an independent reviewer but no discovery provider: ' + task.errorMessage)
    const canonical = noWeaverReviewApi.loadCanonicalDocumentHost(unavailableSample.documentId)
    const candidates = journalVersion === 3 ? 8 : 4
    assert.equal(repeatedPaidCalls, 0)
    assert.equal(reviewedWithoutWeaver, candidates, 'cached discovery candidates still require fresh independent review')
    assert.equal(canonical.graph.edges.length, candidates, 'legacy replay must not silently lose cached proposals')
    assert.equal(canonical.graph.generation.semanticReview.pending, 0)
    assert.equal(canonical.graph.generation.relationCompletion.completedBatches, 0)
    assert.equal(canonical.graph.generation.relationCompletion.replayedBatches, journalVersion === 3 ? 2 : 1)
    assert.equal(canonical.graph.generation.relationDiscovery.searchedTargets, journalVersion === 3 ? 96 : 48)
  }

  const noProviderPartialSample = fixture('direct-no-provider-incomplete'), durablePartialTargets = []
  const partialProviderApi = directHost(extractor({ async weaveRelations(args) {
    if (args.targetIds.some(id => args.nodes.find(node => node.id === id)?.paragraph === 0)) return { missing: 'edges' }
    durablePartialTargets.push(...args.targetIds); return proposal(args)
  }, reviewRelations: supported }))
  const partialStarted = await partialProviderApi.handlers.get('extract')({ documentId: noProviderPartialSample.documentId,
    text: noProviderPartialSample.text, concurrency: 1 })
  const partialStopped = await dynamicTerminal(partialProviderApi, partialStarted.taskId)
  assert.equal(partialStopped.status, 'failed')
  assert.equal(partialStopped.error?.code, 'relation_weave_failed')
  assert.equal(durablePartialTargets.length, 36)
  const partialOriginal = partialProviderApi.getTask(partialStarted.taskId), partialCheckpoint = structuredClone(partialOriginal.checkpoint)
  assert.equal(partialCheckpoint.relationWeave.finished, false)
  assert.equal(partialCheckpoint.relationWeave.batches[0].complete, false)
  assert.equal(partialCheckpoint.relationWeave.batches[0].coverage.searchedTargets, 36)
  assert.equal(Object.keys(partialCheckpoint.relationWeave.batches[0].journal.results).length, 3)
  let noProviderCalls = 0
  const noProviderPartialApi = directHost(extractor({ weaveRelations: null,
    async extractChunk() { noProviderCalls++; throw new Error('Unavailable-provider replay repeated extraction') },
    async reviewRelations() { noProviderCalls++; throw new Error('Incomplete discovery must not enter semantic review') } }))
  const noProviderPartialTask = trustedResumeTask(partialOriginal, structuredClone(partialCheckpoint), 'partial-no-provider-resume')
  await noProviderPartialApi.runTask(noProviderPartialTask)
  assert.equal(noProviderPartialTask.status, 'failed')
  assert.equal(noProviderPartialTask.errorCode, 'relation_weave_failed')
  assert.equal(noProviderCalls, 0)
  assert.equal(noProviderPartialApi.loadCanonicalDocumentHost(noProviderPartialSample.documentId), null, 'no provider must not publish or seal incomplete discovery')
  const preservedPartial = noProviderPartialTask.checkpoint
  assert.equal(preservedPartial.relationWeave.finished, false)
  assert.equal(preservedPartial.relationWeave.batches[0].complete, false)
  assert.deepEqual(preservedPartial.relationWeave.batches[0].coverage, partialCheckpoint.relationWeave.batches[0].coverage)
  assert.deepEqual(preservedPartial.relationWeave.batches[0].journal, partialCheckpoint.relationWeave.batches[0].journal,
    'provider absence preserves authenticated binding, results, evidence, and exact recovery cursor')
  const providerRestoredTargets = []
  const providerRestoredApi = directHost(extractor({ async extractChunk() { noProviderCalls++; throw new Error('Provider recovery repeated extraction') },
    async weaveRelations(args) { providerRestoredTargets.push(...args.targetIds); return proposal(args) }, reviewRelations: supported }))
  const providerRestoredTask = trustedResumeTask(partialOriginal, structuredClone(preservedPartial), 'partial-provider-restored')
  await providerRestoredApi.runTask(providerRestoredTask)
  assert.equal(providerRestoredTask.status, 'succeeded', providerRestoredTask.errorMessage)
  assert.equal(noProviderCalls, 0)
  assert.equal(providerRestoredTargets.length, 12)
  assert(providerRestoredTargets.every(id => !durablePartialTargets.includes(id)), 'only the missing target group is paid after provider recovery')
  const providerRestored = providerRestoredApi.loadCanonicalDocumentHost(noProviderPartialSample.documentId)
  assert.equal(providerRestored.graph.edges.length, 4)
  assert.equal(providerRestored.graph.generation.relationDiscovery.searchedTargets, 48)
  assert.equal(providerRestored.graph.generation.relationCompletion.completedBatches, 1)

  const reviewedSample = fixture('direct-review-cache-unavailable'), reviewedApi = directHost(extractor({ async weaveRelations(args) { return proposal(args) }, reviewRelations: supported }))
  const reviewedStart = await reviewedApi.handlers.get('extract')({ documentId: reviewedSample.documentId, text: reviewedSample.text, concurrency: 1 })
  assert.equal((await dynamicTerminal(reviewedApi, reviewedStart.taskId)).status, 'succeeded')
  const reviewedOriginal = reviewedApi.getTask(reviewedStart.taskId), reviewedCheckpoint = structuredClone(reviewedOriginal.checkpoint)
  let cachedPaidCalls = 0
  const cachedReviewApi = directHost(extractor({ weaveRelations: null,
    async extractChunk() { cachedPaidCalls++; throw new Error('Cached extraction repeated') } }))
  const cachedReviewTask = { ...unavailableResume, id: 'review-cache-unavailable-resume', status: 'running', documentId: reviewedSample.documentId,
    title: reviewedOriginal.title, text: reviewedSample.text, checkpoint: reviewedCheckpoint, existing: reviewedCheckpoint.graph,
    ontology: reviewedOriginal.ontology, paragraphOffset: reviewedCheckpoint.paragraphOffset || 0 }
  await cachedReviewApi.runTask(cachedReviewTask)
  assert.equal(cachedReviewTask.status, 'succeeded')
  const cachedReviewed = cachedReviewApi.loadCanonicalDocumentHost(reviewedSample.documentId)
  assert.equal(cachedPaidCalls, 0, 'fully validated review cache can finalize with no available reviewer and zero paid replay')
  assert.equal(cachedReviewed.graph.edges.length, 4)
  assert.equal(cachedReviewed.graph.generation.semanticReview.reviewed, 4)
  assert.equal(cachedReviewed.graph.generation.semanticReview.reused, 4)
  assert.equal(cachedReviewed.graph.generation.semanticReview.pending, 0)
  assert.equal(cachedReviewed.graph.generation.semanticReview.skippedReason, undefined, 'fully cached reviews are not reviewer-unavailable work')
  assert.equal(cachedReviewed.graph.generation.relationCompletion.completedBatches, 0)
  console.log('KG relation budget dynamic/journal/retry/review smoke passed')

  if (!process.argv.includes('--dynamic-only')) {
    const host = await import('../lib/index.js')
    function createHost(extractor) {
      let handler
      host.apply({ get(name) {
        if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
        return name === 'kgExtractor' ? extractor : null
      }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
      interval() { return () => {} }, onCleanup(fn) { cleanups.push(fn) } })
      assert.equal(typeof handler, 'function')
      return handler
    }
    async function request(handler, endpoint, body = {}, method = 'POST') {
      const req = new EventEmitter(); req.method = method; req.headers = {}
      req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
      const response = new Promise((resolve, reject) => {
        Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(text) { resolve(JSON.parse(text)) } })).catch(reject)
      })
      if (method !== 'GET') queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
      return response
    }
    async function terminal(handler, taskId) {
      assert.equal(typeof taskId, 'string')
      for (let i = 0; i < 2000; i++) {
        const status = await request(handler, 'task-status', { taskId }, 'GET')
        if (!['running', 'pausing'].includes(status.status)) return status
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      throw new Error('Bounded mock task did not terminate: ' + taskId)
    }
    function saveFixture(id, count = 137) {
      const sample = fixture(id, count)
      store.saveGraph(sample.graph, { sourceText: sample.text })
      return sample
    }
    async function startRetry(handler, documentId, options = {}) {
      return request(handler, 'relation-retry', { documentId, expectedRevision: store.getDocument(documentId).revision,
        continuous: true, concurrency: 1, ...options })
    }

    let rejectedCalls = 0
    const httpAdmission = createHost(extractor({ async extractChunk() { rejectedCalls++; throw new Error('Must not run') },
      async weaveRelations() { rejectedCalls++; throw new Error('Must not run') } }))
    for (const relationBatchBudget of invalidBudgets) for (const endpoint of ['extract', 'append-extract', 'resume-extract', 'relation-retry']) {
      const result = await request(httpAdmission, endpoint, { relationBatchBudget, text: 'Fixture', continuous: true })
      assert.equal(result.error?.code, 'invalid_input', endpoint + ':' + relationBatchBudget)
      assert.equal(result.taskId, undefined)
    }
    assert.equal(rejectedCalls, 0)
    assert.equal((await request(httpAdmission, 'task-active', {}, 'GET')).busy, false)

    for (const [id, options, searched, batches, reason] of [
      ['retry-default', {}, 137, 3, 'coverage_complete'],
      ['retry-two', { relationBatchBudget: 2 }, 96, 2, 'budget_exhausted'],
      ['retry-single', { continuous: false }, 48, 1, 'single_batch'],
      ['retry-explicit-twenty', { relationBatchBudget: 20 }, 137, 3, 'coverage_complete'],
    ]) {
      saveFixture(id)
      const targets = [], handler = createHost(extractor({ async weaveRelations({ targetIds }) { targets.push(...targetIds); return { edges: [] } } }))
      const status = await terminal(handler, (await startRetry(handler, id, options)).taskId)
      assert.equal(status.status, 'succeeded', JSON.stringify(status.error))
      const graph = store.getDocument(id)
      assert.equal(graph.generation.relationDiscovery.searchedTargets, searched)
      assert.equal(graph.generation.relationDiscovery.remainingTargets, 137 - searched)
      assert.equal(graph.generation.relationDiscovery.pass, 1)
      assert.equal(graph.generation.relationCompletion.completedBatches, batches)
      assert.equal(graph.generation.relationCompletion.stopReason, reason)
      assert.equal(graph.revision, batches + 1)
      assert.equal(targets.length, new Set(targets).size)
    }

    const initialDefault = fixture('initial-default')
    const defaultHost = createHost(extractor())
    const initialDefaultStatus = await terminal(defaultHost, (await request(defaultHost, 'extract',
      { documentId: initialDefault.documentId, text: initialDefault.text, concurrency: 1 })).taskId)
    assert.equal(initialDefaultStatus.status, 'succeeded', JSON.stringify(initialDefaultStatus.error))
    const defaultGraph = store.getDocument(initialDefault.documentId)
    assert.equal(defaultGraph.generation.relationCompletion.maxBatches, 1)
    assert.equal(defaultGraph.generation.relationCompletion.completedBatches, 1)
    assert.equal(defaultGraph.generation.relationCompletion.stopReason, 'single_batch')
    assert.equal(defaultGraph.generation.relationDiscovery.searchedTargets, 48)
    assert.equal(defaultGraph.generation.relationDiscovery.remainingTargets, 89)
    const appendHost = createHost(extractor({ async extractChunk({ chunk }) {
      return { summary: '', nodes: chunk.units.map(unit => ({ id: 'added-' + unit.num, type: 'claim', text: unit.text,
        quote: unit.text, paragraph: unit.num, evidence: [{ paragraph: unit.num, quote: unit.text }] })), edges: [] }
    } }))
    const appended = await terminal(appendHost, (await request(appendHost, 'append-extract', { documentId: initialDefault.documentId,
      expectedRevision: defaultGraph.revision, text: '新增独立观察甲。\n\n新增独立观察乙。\n\n新增独立观察丙。', concurrency: 1 })).taskId)
    assert.equal(appended.status, 'succeeded', JSON.stringify(appended.error))
    const appendedGraph = store.getDocument(initialDefault.documentId)
    assert.equal(appendedGraph.nodes.length, 140)
    assert.equal(appendedGraph.generation.relationCompletion.maxBatches, 1)
    assert.equal(appendedGraph.generation.relationCompletion.completedBatches, 1)
    assert.equal(appendedGraph.generation.relationCompletion.stopReason, 'single_batch')
    assert.equal(appendedGraph.generation.relationDiscovery.remainingTargets, 92)

    const initial = fixture('initial-two', 201), initialTargets = [], reviewed = []
    const initialHost = createHost(extractor({ async weaveRelations(args) { initialTargets.push(...args.targetIds); return proposal(args, 3) },
      async reviewRelations(args) { reviewed.push(...args.candidates.map(item => item.edge.fromNodeId + '>' + item.edge.toNodeId)); return supported(args) } }))
    const initialStatus = await terminal(initialHost, (await request(initialHost, 'extract', { documentId: initial.documentId,
      text: initial.text, concurrency: 1, relationBatchBudget: 2 })).taskId)
    assert.equal(initialStatus.status, 'succeeded', JSON.stringify(initialStatus.error))
    const initialGraph = store.getDocument(initial.documentId)
    assert.equal(initialGraph.nodes.length, 201)
    assert.equal(initialGraph.revision, 1, 'initial discovery batches remain checkpoints until final independently reviewed commit')
    assert.equal(initialGraph.generation.relationDiscovery.searchedTargets, 96)
    assert.equal(initialGraph.generation.relationDiscovery.remainingTargets, 105)
    assert.equal(initialGraph.generation.relationCompletion.completedBatches, 2)
    assert.equal(initialGraph.generation.relationCompletion.stopReason, 'budget_exhausted')
    assert.equal(initialTargets.length, new Set(initialTargets).size)
    assert.equal(reviewed.length, 24, 'all candidates from both batches require independent review')
    assert.equal(initialGraph.edges.length, 24)

    const unfinishedSample = fixture('initial-weave-resume', 201), completedInitialTargets = []
    let initialGroups = 0, missingFirstTarget = null
    const unfinishedHost = createHost(extractor({ async weaveRelations(args) {
      if (++initialGroups === 6) missingFirstTarget = args.targetIds[0]
      if (args.targetIds[0] === missingFirstTarget) return { missing: 'edges' }
      completedInitialTargets.push(...args.targetIds)
      return proposal(args, 3)
    }, async reviewRelations() { throw new Error('Cannot review an unfinished discovery stage') } }))
    const unfinishedTask = await request(unfinishedHost, 'extract', { documentId: unfinishedSample.documentId,
      text: unfinishedSample.text, concurrency: 1, relationBatchBudget: 2 })
    const unfinishedStatus = await terminal(unfinishedHost, unfinishedTask.taskId)
    assert.equal(unfinishedStatus.status, 'failed')
    assert.equal(unfinishedStatus.error?.code, 'relation_weave_failed')
    assert.equal(store.getDocument(unfinishedSample.documentId), null)
    assert.equal(completedInitialTargets.length, 84)
    const unfinishedCheckpoint = store.loadCheckpoint(unfinishedTask.taskId).checkpoint
    assert.equal(unfinishedCheckpoint.relationWeave.batches[1].coverage.searchedTargets, 84)
    assert.equal(unfinishedCheckpoint.postprocess, undefined)
    const newlySearched = [], independentlyReviewed = []
    let repeatedExtraction = 0
    const resumedDiscoveryHost = createHost(extractor({
      async extractChunk() { repeatedExtraction++; throw new Error('Completed nodes repeated') },
      async weaveRelations(args) { newlySearched.push(...args.targetIds); return proposal(args, 3) },
      async reviewRelations(args) {
        independentlyReviewed.push(...args.candidates)
        const response = supported(args)
        if (!independentlyReviewed.slice(0, -args.candidates.length).length) response.verdicts[0] = { id: response.verdicts[0].id, verdict: 'insufficient', reason: 'Independent reviewer withholds unsupported relation' }
        return response
      },
    }))
    const discoveryRecovered = await terminal(resumedDiscoveryHost, (await request(resumedDiscoveryHost, 'resume-extract',
      { runId: unfinishedTask.taskId, retryFailed: true })).taskId)
    assert.equal(discoveryRecovered.status, 'succeeded', JSON.stringify(discoveryRecovered.error))
    assert.equal(repeatedExtraction, 0)
    assert.equal(newlySearched.length, 12)
    assert(newlySearched.every(id => !completedInitialTargets.includes(id)))
    assert.equal(independentlyReviewed.length, 24)
    const resumedDiscoveryGraph = store.getDocument(unfinishedSample.documentId)
    assert.equal(resumedDiscoveryGraph.edges.length, 23, 'no old or new proposal can bypass independent review')
    assert.equal(resumedDiscoveryGraph.generation.relationDiscovery.searchedTargets, 96)
    assert.equal(resumedDiscoveryGraph.generation.relationDiscovery.remainingTargets, 105)
    assert.equal(resumedDiscoveryGraph.generation.relationCompletion.maxBatches, 1)
    assert.equal(resumedDiscoveryGraph.generation.relationCompletion.completedBatches, 1)

    // Resume after two discovered batches and one durably reviewed group. The
    // new Host must not extract nodes, weave again, or re-review cached verdicts.
    const reviewSample = fixture('initial-review-resume', 201)
    let reviewCalls = 0
    const finishedVerdicts = [], reviewFailure = createHost(extractor({ async weaveRelations(args) { return proposal(args, 3) },
      async reviewRelations(args) { if (++reviewCalls === 2) throw timeout(); finishedVerdicts.push(...args.candidates.map(item => item.edge.fromNodeId + '>' + item.edge.toNodeId)); return supported(args) } }))
    const interruptedTask = await request(reviewFailure, 'extract', { documentId: reviewSample.documentId, text: reviewSample.text, concurrency: 1, relationBatchBudget: 2 })
    const failedReview = await terminal(reviewFailure, interruptedTask.taskId)
    assert.equal(failedReview.status, 'failed')
    assert.equal(store.getDocument(reviewSample.documentId), null)
    const reviewCheckpoint = store.loadCheckpoint(interruptedTask.taskId)
    assert.equal(reviewCheckpoint.checkpoint.relationWeave.batches.length, 2)
    assert(Object.keys(reviewCheckpoint.checkpoint.postprocess.decisions).length > 0)
    let forbiddenCalls = 0
    const laterVerdicts = [], freshReviewHost = createHost(extractor({
      async extractChunk() { forbiddenCalls++; throw new Error('Completed extraction repeated') },
      async weaveRelations() { forbiddenCalls++; throw new Error('Completed weaving repeated') },
      async reviewRelations(args) { laterVerdicts.push(...args.candidates.map(item => item.edge.fromNodeId + '>' + item.edge.toNodeId)); return supported(args) },
    }))
    const continued = await request(freshReviewHost, 'resume-extract', { runId: interruptedTask.taskId, retryFailed: true })
    const recovered = await terminal(freshReviewHost, continued.taskId)
    assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered.error))
    assert.equal(forbiddenCalls, 0)
    assert(laterVerdicts.length > 0)
    assert(laterVerdicts.every(key => !finishedVerdicts.includes(key)), 'paid completed independent reviews are reused')
    const reviewedGraph = store.getDocument(reviewSample.documentId)
    assert.equal(reviewedGraph.edges.length, 24)
    assert.equal(reviewedGraph.generation.relationCompletion.maxBatches, 1)
    assert.equal(reviewedGraph.generation.relationCompletion.completedBatches, 0)
    assert.equal(reviewedGraph.generation.relationDiscovery.remainingTargets, 105)

    saveFixture('pending-review', 3)
    let pending = true, weaves = 0
    const pendingHost = createHost(extractor({ async weaveRelations(args) { weaves++; return proposal(args) },
      async reviewRelations(args) { return pending ? {} : supported(args) } }))
    const pendingResult = await terminal(pendingHost, (await startRetry(pendingHost, 'pending-review')).taskId)
    assert.equal(pendingResult.error?.code, 'relation_review_pending')
    assert.equal(store.getDocument('pending-review').edges.length, 0)
    pending = false
    assert.equal((await terminal(pendingHost, (await startRetry(pendingHost, 'pending-review')).taskId)).status, 'succeeded')
    assert.equal(weaves, 1, 'finish pending review before opening any extra discovery round')

    for (const budget of [1, 2]) {
      const id = 'http-pending-noncontinuous-' + budget
      saveFixture(id)
      const paid = []
      const handler = createHost(extractor({ async weaveRelations(args) { paid.push(...args.targetIds); return proposal(args) },
        async reviewRelations() { return {} } }))
      const options = { continuous: false, ...(budget === 2 ? { relationBatchBudget: 2 } : {}) }
      const ended = await terminal(handler, (await startRetry(handler, id, options)).taskId)
      assert.equal(ended.status, budget === 1 ? 'succeeded' : 'failed')
      assert.equal(ended.progress?.completion?.stopReason, 'pending_review', 'HTTP terminal retry must expose why bounded discovery stopped')
      if (budget === 2) assert.equal(ended.error?.code, 'relation_review_pending')
      const pendingGraph = store.getDocument(id)
      assert.equal(pendingGraph.revision, 2)
      assert.equal(pendingGraph.edges.length, 0)
      assert.equal(pendingGraph.generation.relationDiscovery.searchedTargets, 48)
      assert.equal(pendingGraph.generation.relationCompletion.savedCycles, 1)
      assert.equal(pendingGraph.generation.relationCompletion.stopReason, 'pending_review')
      assert.equal(paid.length, 48)
      if (budget === 2) {
        const nextPaid = []
        const next = createHost(extractor({ async weaveRelations(args) { nextPaid.push(...args.targetIds); return proposal(args) }, reviewRelations: supported }))
        const resumed = await terminal(next, (await startRetry(next, id, options)).taskId)
        assert.equal(resumed.status, 'succeeded')
        assert.equal(nextPaid.length, 48)
        assert(nextPaid.every(target => !paid.includes(target)), 'persistent fresh Host reviews pending candidates before novel target search')
        const saved = store.getDocument(id)
        assert.equal(saved.generation.relationDiscovery.searchedTargets, 96)
        assert.equal(saved.generation.relationCompletion.completedBatches, 2)
        assert.equal(saved.generation.relationCompletion.stopReason, 'budget_exhausted')
      }
    }
    for (const budget of [1, 2]) {
      const id = 'http-malformed-noncontinuous-' + budget
      saveFixture(id)
      const paid = []
      const handler = createHost(extractor({ async weaveRelations(args) {
        if (args.targetIds.includes('n0')) return { missing: 'edges' }
        paid.push(...args.targetIds); return { edges: [] }
      }, reviewRelations: supported }))
      const ended = await terminal(handler, (await startRetry(handler, id, { continuous: false,
        ...(budget === 2 ? { relationBatchBudget: 2 } : {}) })).taskId)
      assert.equal(ended.status, 'failed')
      assert.equal(ended.error?.code, 'relation_weave_failed')
      assert.equal(paid.length, 36)
      const saved = store.getDocument(id)
      assert.equal(saved.revision, budget === 1 ? 1 : 2)
      if (budget === 2) {
        assert.equal(saved.generation.relationDiscovery.searchedTargets, 36)
        assert.equal(saved.generation.relationCompletion.stopReason, 'error')
        assert.equal(saved.generation.relationCompletion.savedCycles, 1)
      }
    }
    const unavailableHttpSample = fixture('http-initial-unavailable-review')
    const unavailableHttp = createHost(extractor({ async weaveRelations(args) { return proposal(args) } }))
    const unavailableHttpStarted = await request(unavailableHttp, 'extract', { documentId: unavailableHttpSample.documentId,
      text: unavailableHttpSample.text, concurrency: 1, relationBatchBudget: 2 })
    assert.equal((await terminal(unavailableHttp, unavailableHttpStarted.taskId)).status, 'succeeded')
    const unavailableHttpGraph = store.getDocument(unavailableHttpSample.documentId)
    assert.equal(unavailableHttpGraph.edges.length, 0)
    assert.equal(unavailableHttpGraph.generation.semanticReview.pending, 8)
    assert.equal(unavailableHttpGraph.generation.semanticReview.withheld.filter(item => item.verdict === 'pending').length, 8)

    for (const cancel of [true, false]) {
      const id = cancel ? 'budget-cancel' : 'budget-cas'
      saveFixture(id)
      let calls = 0
      const reached = deferred(), release = deferred()
      const handler = createHost(extractor({ async weaveRelations() { if (++calls === 5) { reached.resolve(); await release.promise } return { edges: [] } } }))
      const started = await startRetry(handler, id)
      await reached.promise
      assert.equal(store.getDocument(id).generation.relationDiscovery.searchedTargets, 48)
      if (cancel) await request(handler, 'task-cancel', { taskId: started.taskId })
      else {
        const edited = store.getDocument(id); edited.summary = 'Concurrent user edit'
        store.saveGraph(edited, { sourceText: edited.sourceText, expectedRevision: edited.revision })
      }
      release.resolve()
      const stopped = await terminal(handler, started.taskId)
      assert.equal(stopped.error?.code, cancel ? 'cancelled' : 'revision_conflict')
      assert.equal(stopped.progress?.completion?.stopReason, cancel ? 'cancelled' : 'error', 'HTTP terminal cancellation/CAS failure must expose stopReason')
      assert.equal(store.getDocument(id).generation.relationDiscovery.searchedTargets, 48)
      if (cancel) assert.equal(store.getDocument(id).revision, 2)
      else assert.equal(store.getDocument(id).summary, 'Concurrent user edit')
    }
    console.log('KG relation budget HTTP/resume/review/cancel/CAS smoke passed')
  }
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup()
  store.close()
  if (oldHarness === undefined) delete globalThis.harness
  else globalThis.harness = oldHarness
  if (oldDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = oldDb
  // Verify the exact deletion target is the disposable directory created above.
  assert.equal(resolve(dir), dir)
  assert(basename(dir).startsWith('kg-relation-budget-'))
  rmSync(dir, { recursive: true, force: true })
}
