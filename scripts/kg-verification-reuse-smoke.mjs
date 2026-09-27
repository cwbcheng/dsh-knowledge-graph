import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'kg-verification-reuse-'))
const oldDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'graph.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const model = { provider: 'fixture', model: 'independent-review' }
const paragraphs = Array.from({ length: 83 }, (_, i) => 'Record ' + i + ': ' + ('independent evidence ' + i + ' ').repeat(4).trim())
const graph = { source: { documentId: 'reuse-document', sourceId: 'reuse-source', paragraphCount: paragraphs.length }, summary: 'Independent records.',
  nodes: Array.from({ length: 80 }, (_, i) => ({ id: 'n' + i, type: 'fact', text: 'Record ' + i,
    paragraph: i, quote: paragraphs[i], groundingStatus: 'grounded', evidence: [{ documentId: 'reuse-document', sourceId: 'reuse-source', paragraph: i, quote: paragraphs[i] }] })),
  edges: [{ fromNodeId: 'n0', toNodeId: 'n79', relation: 'supports', evidence: [{ documentId: 'reuse-document', sourceId: 'reuse-source', paragraph: 82, quote: paragraphs[82] }] }] }
let calls = 0
function createHost(stream = async function* () { calls++; yield { type: 'text-delta', index: 0, text: '{"issues":[]}' } }) {
  let handler
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
    return name === 'llm' ? { stream } : null
  }, effect(fn) { fn() }, interval() { return () => {} } })
  return (endpoint, body = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    Object.assign(req, { method, headers: {}, url: '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '') })
    Promise.resolve(handler(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
const input = (extras = {}) => ({ documentId: graph.source.documentId, expectedRevision: store.getDocumentRevision(graph.source.documentId),
  canonicalFull: true, mode: 'standard', concurrency: 2, model, ...extras })
async function until(check, message) {
  for (let i = 0; i < 1000; i++) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}
async function finish(api, extras = {}) {
  const started = await api('verify-graph', input(extras))
  assert(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 3000; i++) {
    const status = await api('task-status', { taskId: started.taskId }, 'GET')
    if (status.status !== 'running') { assert.equal(status.status, 'succeeded', JSON.stringify(status)); return { ...status, fixtureRunId: started.taskId } }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('review did not settle')
}
const edit = (change, text = paragraphs.join('\n\n')) => {
  const current = store.getDocument(graph.source.documentId)
  change(current)
  store.saveGraph(current, { expectedRevision: current.revision, sourceText: text })
}
try {
  store.saveGraph(graph, { sourceText: paragraphs.join('\n\n') })
  let api = createHost()
  const initial = await finish(api)
  const total = initial.result.coverage.batchCount
  assert.equal(initial.result.coverage.sourceUnitCount, paragraphs.length, 'fixture paragraph references must match actual source units')
  assert(total > 6)
  assert.equal(calls, total)
  api = createHost()
  const preview = await api('verification-plan', input({ reuseVerified: true }))
  assert.equal(preview.reuse?.reusedBatches, total, 'unchanged completed batches must be reusable after restart')
  assert.equal(preview.minimumModelRequests, 0)
  assert.equal(calls, total, 'preview cannot invoke a model')
  const reused = await finish(api, { reuseVerified: true })
  assert.equal(calls, total, 'unchanged input must not spend new model calls')
  assert.equal(reused.progress.verification.coverage.completedNodes, graph.nodes.length, 'terminal progress must not retain the previous incomplete snapshot')
  assert.equal(reused.result.reuse.reusedBatches, total)
  assert.equal(reused.result.reuse.reviewedBatches, 0)
  assert.equal(store.getDocumentRevision(graph.source.documentId), 1, 'review must never save the graph')

  edit(current => { current.nodes[40].text += ' Updated claim.' })
  const changed = await api('verification-plan', input({ reuseVerified: true }))
  assert(changed.reuse.reusedBatches > 0 && changed.reuse.reviewBatches > 0)
  assert(changed.minimumModelRequests < total, 'an unrelated paragraph must not invalidate the entire audit')
  const before = calls
  const incremental = await finish(api, { reuseVerified: true })
  assert.equal(calls - before, changed.minimumModelRequests)
  assert.equal(incremental.result.coverage.revision, 2)
  assert.equal(incremental.result.reuse.reviewedBatches, changed.minimumModelRequests)

  const distant = paragraphs.slice(); distant[82] += ' with the relation only holding under condition Q'
  edit(() => {}, distant.join('\n\n'))
  const sourceChange = await api('verification-plan', input({ reuseVerified: true }))
  assert(sourceChange.reuse.reviewBatches >= 2, 'both the distant source pass and relation pass must be invalidated: ' + JSON.stringify({ sourceChange, edges: store.getDocument(graph.source.documentId).edges }))
  assert(sourceChange.reuse.reusedBatches > 0)
  await finish(api, { reuseVerified: true })

  edit(current => { current.edges.push({ fromNodeId: 'n10', toNodeId: 'n60', relation: 'supports',
    evidence: [{ documentId: 'reuse-document', sourceId: 'reuse-source', paragraph: 82, quote: paragraphs[82] }] }) }, distant.join('\n\n'))
  const added = await api('verification-plan', input({ reuseVerified: true }))
  assert(added.reuse.reviewBatches > 0)
  assert.equal(added.coverage.edgeCount, 2)
  await finish(api, { reuseVerified: true })

  const switched = await api('verification-plan', input({ reuseVerified: true, model: { ...model, model: 'different-model' } }))
  assert.equal(switched.reuse.reusedBatches, 0, 'cache cannot pretend a different model performed the review')
  const fullBefore = calls
  const full = await finish(api)
  assert.equal(calls - fullBefore, full.result.coverage.batchCount, 'ordinary deep audit remains an explicit fresh review')
  assert.equal((await api('verification-plan', input({ reuseVerified: true, expectedRevision: 0 }))).error.code, 'revision_conflict')
  assert.equal((await api('verify-graph', input({ reuseVerified: true, canonicalFull: false }))).error.code, 'invalid_input')
  const other = structuredClone(graph); other.source.documentId = 'other-document'
  store.saveGraph(other, { sourceText: paragraphs.join('\n\n') })
  const unrelated = await api('verification-plan', input({ documentId: 'other-document', expectedRevision: 1, reuseVerified: true }))
  assert.equal(unrelated.reuse.reusedBatches, 0, 'reuse must be isolated by document')

  const issueModel = { ...model, model: 'review-with-findings' }
  let issueCalls = 0
  const issueHost = createHost(async function* (request) {
    issueCalls++
    const prompt = request.messages[0].content[0].text
    let reply = { issues: [] }
    if (prompt.startsWith('候选问题列表')) {
      const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('[{')))
      reply = { kept: candidates.map(candidate => ({ id: candidate.id })) }
    } else if (request.system.includes('本次是节点批')) {
      const sub = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"summary":')))
      if (sub.nodes.some(node => node.id === 'n0')) reply.issues.push({ id: 'duplicate', severity: 'warning', category: 'other',
        targetKind: 'node', targetId: 'n0', title: 'Possible duplicate', detail: 'Compare n0 and n60.', confidence: 0.95,
        evidence: [{ paragraph: 0, quote: paragraphs[0] }],
        proposedFix: { action: 'merge_nodes', nodePatch: { id: 'n0', patch: {} }, mergeIntoId: 'n60' } })
    }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(reply) }
  })
  const withIssues = await finish(issueHost, { model: issueModel })
  assert.equal(withIssues.result.issues.filter(issue => issue.source === 'ai').length, 1)
  const afterIssues = issueCalls
  const issuesReused = await finish(issueHost, { model: issueModel, reuseVerified: true })
  assert.equal(issueCalls, afterIssues, 'independently confirmed nonempty issues must also be reusable')
  assert.deepEqual(issuesReused.result.issues, withIssues.result.issues)
  const saved = store.getDocument(graph.source.documentId)
  saved.verification = { lastReport: withIssues.result }
  const closed = saved.verification.lastReport.issues.find(issue => issue.source === 'ai')
  closed.status = 'rejected'; closed.userNote = 'Already reviewed by the reader.'
  const reportSave = await issueHost('graph-commit', { documentId: graph.source.documentId, graph: saved, expectedRevision: saved.revision,
    baseNodeIds: saved.nodes.map(node => node.id), baseEdgeKeys: saved.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) })
  assert(reportSave.revision, JSON.stringify(reportSave))
  const reportOnly = await issueHost('verification-plan', input({ model: issueModel, reuseVerified: true }))
  assert.equal(reportOnly.reuse.reviewBatches, 0, 'saving the audit report cannot invalidate its own inputs')
  const retained = await finish(issueHost, { model: issueModel, reuseVerified: true })
  assert.equal(retained.result.issues.find(issue => issue.source === 'ai').status, 'rejected')
  assert.equal(retained.result.reuse.retainedDecisions, 1, 'unchanged reused findings must not reopen a handled issue')

  edit(current => { current.nodes.find(node => node.id === 'n60').text += ' Different merge destination.' }, distant.join('\n\n'))
  const outputDependency = await issueHost('verification-plan', input({ model: issueModel, reuseVerified: true }))
  assert(outputDependency.reuse.reviewBatches >= 2, 'a merge destination outside the n0 prompt must invalidate n0 too')
  const rechecked = await finish(issueHost, { model: issueModel, reuseVerified: true })
  assert.equal(rechecked.result.issues.find(issue => issue.source === 'ai').status, 'open', 'changed dependencies require a fresh issue decision')
  const recheckedReuse = await finish(issueHost, { model: issueModel, reuseVerified: true })
  assert.equal(recheckedReuse.result.issues.find(issue => issue.source === 'ai').status, 'open', 'an old decision cannot return on the next incremental run')
  edit(current => { current.nodes[40].text = 'a'.repeat(400) + ' not for children' }, distant.join('\n\n'))
  await finish(issueHost, { model: issueModel, reuseVerified: true })
  edit(current => { current.nodes[40].text = 'a'.repeat(400) + ' only for children' }, distant.join('\n\n'))
  const tailChanged = await issueHost('verification-plan', input({ model: issueModel, reuseVerified: true }))
  assert(tailChanged.reuse.reviewBatches > 0, 'changes beyond the prompt text preview must invalidate reuse')
  const certified = await finish(issueHost, { model: issueModel, reuseVerified: true })
  edit(current => { const node = current.nodes.find(node => node.id === 'n40'); node.paragraph = null; node.evidence = [] }, distant.join('\n\n'))
  await finish(issueHost, { model: issueModel, reuseVerified: true })
  const unanchoredSource = distant.slice(); unanchoredSource[81] += ' with an additional qualification'
  edit(() => {}, unanchoredSource.join('\n\n'))
  const unanchoredChange = await issueHost('verification-plan', input({ model: issueModel, reuseVerified: true }))
  assert(unanchoredChange.reuse.reviewBatches >= 2, 'a quotation without a paragraph must conservatively depend on the entire source')
  await finish(issueHost, { model: issueModel, reuseVerified: true })
  edit(current => { current.nodes.find(node => node.id === 'n70').text += ' New qualification.' }, distant.join('\n\n'))
  let held = false
  const pauseHost = createHost(async function* ({ signal }) {
    held = true
    await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }))
  })
  const pausing = await pauseHost('verify-graph', input({ model: issueModel, reuseVerified: true, concurrency: 1 }))
  await until(() => held && store.loadVerificationBatches(pausing.taskId).length, 'reuse copies must be durable before the dirty batch starts')
  await pauseHost('task-pause', { taskId: pausing.taskId })
  await until(async () => (await pauseHost('task-status', { taskId: pausing.taskId }, 'GET')).status === 'paused', 'incremental audit did not pause')
  assert.equal(store.loadCheckpoint(pausing.taskId).checkpoint.reuseVerified, true)
  const copied = store.loadVerificationBatches(pausing.taskId).length
  const resumedHost = createHost()
  const resumeAdmission = await resumedHost('resume-verify', { runId: pausing.taskId, resumePaused: true })
  assert.equal(resumeAdmission.taskId, pausing.taskId, JSON.stringify(resumeAdmission))
  const resumed = await until(async () => {
    const status = await resumedHost('task-status', { taskId: pausing.taskId }, 'GET')
    return status.status !== 'running' ? status : null
  }, 'incremental audit did not resume')
  assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed))
  assert(resumed.result.reuse.reusedBatches >= copied)
  assert.equal(store.loadVerificationBatches(pausing.taskId).length, resumed.result.coverage.batchCount)

  // A failed write must never turn a reused batch into completed coverage.
  store.db.exec("CREATE TRIGGER refuse_reuse_copy BEFORE INSERT ON verification_batch_results BEGIN SELECT RAISE(ABORT, 'fixture disk full'); END")
  const refused = await resumedHost('verify-graph', input({ model: issueModel, reuseVerified: true }))
  const failed = await until(async () => {
    const status = await resumedHost('task-status', { taskId: refused.taskId }, 'GET')
    return status.status !== 'running' ? status : null
  }, 'failed reuse copy did not settle')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.progress.verification.completedBatches, 0)
  assert.equal(store.loadVerificationBatches(refused.taskId).length, 0)
  store.db.exec('DROP TRIGGER refuse_reuse_copy')

  // Corrupt every matching copy so selection order cannot hide the corruption.
  const row = store.loadVerificationBatches(certified.fixtureRunId).find(row => row.result.issues.length)
  store.db.prepare("UPDATE verification_batch_results SET result_json = json_set(result_json, '$.issues[0].title', 'Corrupted') WHERE json_extract(result_json, '$.reuse.inputHash') = ?")
    .run(row.result.reuse.inputHash)
  const corrupted = await issueHost('verification-plan', input({ model: issueModel, reuseVerified: true }))
  assert(corrupted.reuse.reviewBatches > 0, 'a modified cached result must fail closed')
  store.db.exec("UPDATE verification_batch_results SET result_json = json_remove(result_json, '$.reuse')")
  const legacy = await issueHost('verification-plan', input({ model: issueModel, reuseVerified: true }))
  assert.equal(legacy.reuse.reusedBatches, 0, 'legacy results without dependency proof cannot be certified retroactively')
  console.log(JSON.stringify({ durableReuse: true, changedClaim: true, distantEvidence: true, newEdge: true,
    fullCoverage: true, modelIsolation: true, documentIsolation: true, freshAudit: true, readOnlyGraph: true,
    nonemptyIssues: true, outputDependencies: true, fullTextFingerprint: true, unanchoredSource: true,
    canonicalReportSave: true, decisionRetention: true, pauseResume: true, failedCopy: true, corruption: true, legacyFailClosed: true }))
} finally {
  store.close()
  if (oldDb === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = oldDb
  rmSync(dir, { recursive: true, force: true })
}
