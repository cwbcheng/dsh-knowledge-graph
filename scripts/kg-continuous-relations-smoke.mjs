import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'kg-continuous-relations-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'test.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const cleanups = []
const fixture = (id, count = 137) => {
  const paragraphs = Array.from({ length: count }, (_, i) => '独立记录' + i + '，仅描述此项观察。')
  store.saveGraph({ source: { id: 'source-' + id, documentId: id, title: id }, summary: '', warnings: [],
    nodes: paragraphs.map((text, i) => ({ id: 'n' + i, type: 'claim', text, quote: text, paragraph: i, evidence: [{ paragraph: i, quote: text }] })), edges: [] },
  { sourceText: paragraphs.join('\n\n') })
}
function createHost(extractor) {
  let handler
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
    return name === 'kgExtractor' ? extractor : null
  }, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  return handler
}
function request(handler, endpoint, body = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method; req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    const res = { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } }
    Promise.resolve(handler(req, res)).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function terminal(handler, taskId) {
  assert(taskId)
  for (let i = 0; i < 2000; i++) {
    const status = await request(handler, 'task-status', { taskId }, 'GET')
    if (status.status !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw Error('continuous task did not settle')
}
const start = (handler, id, extra = {}) => request(handler, 'relation-retry', { documentId: id, expectedRevision: store.getDocument(id).revision, continuous: true, ...extra })
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done }), resolve } }
try {
  fixture('full')
  const targets = []
  const full = createHost({ async weaveRelations({ targetIds }) { targets.push(...targetIds); return { edges: [] } } })
  const started = await start(full, 'full')
  // The task runs entirely in Host, without a client issuing the next request.
  const finished = await terminal(full, started.taskId)
  assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error))
  const saved = store.getDocument('full')
  assert.equal(targets.length, 137)
  assert.equal(new Set(targets).size, 137, 'no duplicate targets or automatic second paid round')
  assert.equal(saved.generation.relationDiscovery.remainingTargets, 0)
  assert.equal(saved.generation.relationDiscovery.pass, 1)
  assert.equal(saved.generation.relationCompletion.savedCycles, 3)
  assert.equal(saved.revision, 4, 'each accepted batch advances CAS once')
  assert.equal(saved.edges.length, 0, 'valid empty results advance search without inventing edges')
  assert.equal((await request(full, 'task-active', {}, 'GET')).busy, false)
  targets.length = 0
  assert.equal((await terminal(full, (await start(full, 'full')).taskId)).status, 'succeeded')
  assert.equal(targets.length, 137, 'another round requires another explicit start')
  assert.equal(store.getDocument('full').generation.relationDiscovery.pass, 2)

  fixture('accepted')
  const acceptedHost = createHost({
    async weaveRelations({ targetIds, units }) {
      return { edges: [{ fromNodeId: targetIds[0], toNodeId: targetIds[1], relation: 'supports', evidence: [{ paragraph: units[0].num, quote: units[0].text }] }] }
    },
    async reviewRelations({ candidates }) {
      return { verdicts: candidates.map(item => ({ id: item.id, verdict: 'supported', reason: 'Fixture reviewer acceptance', evidence: item.edge.evidence })) }
    },
  })
  assert.equal((await terminal(acceptedHost, (await start(acceptedHost, 'accepted')).taskId)).status, 'succeeded')
  const accepted = store.getDocument('accepted')
  assert.equal(accepted.edges.length, 12)
  assert.equal(accepted.generation.relationCompletion.acceptedEdges, 12, 'accepted count accumulates after independent review across all batches')
  assert.equal(accepted.generation.relationCompletion.savedCycles, 3)

  fixture('no-reviewer', 3)
  const noReviewer = createHost({ async weaveRelations({ units }) {
    return { edges: [{ fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports', evidence: [{ paragraph: 0, quote: units[0].text }] }] }
  } })
  assert.equal((await terminal(noReviewer, (await start(noReviewer, 'no-reviewer')).taskId)).error.code, 'no_model')
  assert.equal(store.getDocument('no-reviewer').edges.length, 0, 'unavailable review must not admit proposed edges')
  assert.equal(store.getDocument('no-reviewer').revision, 1, 'unreviewed batches cannot advance the durable cursor')

  fixture('cancel')
  const reached = deferred(), release = deferred(), cancelledTargets = []
  let calls = 0
  const cancellable = createHost({ async weaveRelations({ targetIds }) {
    if (++calls === 5) { reached.resolve(); await release.promise }
    cancelledTargets.push(...targetIds)
    return { edges: [] }
  } })
  const cancelling = await start(cancellable, 'cancel')
  await reached.promise
  const progress = await request(cancellable, 'task-active', {}, 'GET')
  assert.equal(progress.task.taskId, cancelling.taskId)
  assert.equal(progress.task.progress.completion.continuous, true)
  assert.equal(progress.task.progress.completion.savedCycles, 1)
  assert.equal(progress.task.progress.completion.savedTargets, 48)
  assert.equal(store.getDocument('cancel').generation.relationDiscovery.searchedTargets, 48)
  const duplicate = await start(cancellable, 'cancel')
  assert.equal(duplicate.error.code, 'busy')
  assert.equal((await request(cancellable, 'task-cancel', { taskId: cancelling.taskId })).status, 'cancelling')
  release.resolve()
  const stopped = await terminal(cancellable, cancelling.taskId)
  assert.equal(stopped.status, 'cancelled')
  assert.match(stopped.error.message, /48\/137/)
  assert.equal(calls, 5, 'cancel must not launch another group')
  assert.equal(store.getDocument('cancel').revision, 2, 'late cancelled output cannot commit')
  const resumedTargets = []
  const restarted = createHost({ async weaveRelations({ targetIds }) { resumedTargets.push(...targetIds); return { edges: [] } } })
  assert.equal((await request(restarted, 'task-active', {}, 'GET')).busy, false, 'new Host cannot invent a live task from the stored cursor')
  assert.equal((await terminal(restarted, (await start(restarted, 'cancel')).taskId)).status, 'succeeded')
  assert.equal(resumedTargets.length, 89)
  assert(resumedTargets.every(id => !cancelledTargets.slice(0, 48).includes(id)), 'fresh Host resumes committed coverage, not the beginning')

  fixture('partial')
  const partial = createHost({ async weaveRelations({ targetIds }) { return targetIds.includes('n0') ? { malformed: true } : { edges: [] } } })
  const failed = await terminal(partial, (await start(partial, 'partial')).taskId)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'relation_weave_failed')
  assert.equal(store.getDocument('partial').generation.relationDiscovery.searchedTargets, 36, 'successful empty groups must survive another group failing')
  assert(!store.getDocument('partial').generation.relationDiscovery.completedTargetIds.includes('n0'))

  fixture('conflict')
  const conflictReached = deferred(), conflictRelease = deferred()
  let conflictCalls = 0
  const conflicting = createHost({ async weaveRelations() {
    if (++conflictCalls === 5) { conflictReached.resolve(); await conflictRelease.promise }
    return { edges: [] }
  } })
  const conflictTask = await start(conflicting, 'conflict')
  await conflictReached.promise
  const edited = store.getDocument('conflict')
  edited.summary = 'User edit must survive'
  store.saveGraph(edited, { sourceText: edited.sourceText, expectedRevision: edited.revision })
  conflictRelease.resolve()
  const conflictResult = await terminal(conflicting, conflictTask.taskId)
  assert.equal(conflictResult.error.code, 'revision_conflict')
  assert.equal(store.getDocument('conflict').summary, 'User edit must survive')
  assert.equal(store.getDocument('conflict').generation.relationDiscovery.searchedTargets, 48)

  fixture('review', 3)
  let pending = true, weaves = 0, reviews = 0
  const reviewHost = createHost({
    async weaveRelations({ units }) { weaves++; return { edges: [{ fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports', evidence: [{ paragraph: 0, quote: units.find(u => u.num === 0).text }] }] } },
    async reviewRelations({ candidates, units }) {
      reviews++
      return pending ? {} : { verdicts: candidates.map(item => ({ id: item.id, verdict: 'insufficient', reason: 'No explicit support in source', evidence: [{ paragraph: 0, quote: units[0].text }] })) }
    },
  })
  const reviewResult = await terminal(reviewHost, (await start(reviewHost, 'review')).taskId)
  assert.equal(reviewResult.error.code, 'relation_review_pending')
  assert.equal(store.getDocument('review').edges.length, 0, 'pending candidates are not canonical relations')
  assert.equal(store.getDocument('review').generation.relationRetrySemanticReview.pending, 1)
  pending = false
  const retried = await terminal(reviewHost, (await start(reviewHost, 'review')).taskId)
  assert.equal(retried.status, 'succeeded', JSON.stringify(retried.error))
  assert.equal(weaves, 1, 'finish pending review without re-searching the completed round')
  assert(reviews >= 2)
  assert.equal(store.getDocument('review').generation.relationCompletion.acceptedEdges, 0, 'semantic rejections cannot inflate accepted counts')

  const proposal = async ({ units }) => ({ edges: [{ fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports', evidence: [{ paragraph: 0, quote: units.find(u => u.num === 0).text }] }] })
  const supported = ({ candidates }) => ({ verdicts: candidates.map(item => ({ id: item.id, verdict: 'supported', reason: 'Synthetic review', evidence: item.edge.evidence })) })
  const transportError = () => Object.assign(new Error('Stream ended without finish_reason'), { code: 'llm_error', providerCode: 'TRANSPORT' })
  fixture('transport-once', 3)
  let transportCalls = 0, transportWeaves = 0
  const transportHost = createHost({
    async weaveRelations(input) { transportWeaves++; return proposal(input) },
    async reviewRelations(input) {
      if (++transportCalls === 1) throw transportError()
      assert.equal(store.getDocument('transport-once').edges.length, 0, 'no admission before retry completes')
      return supported(input)
    },
  })
  assert.equal((await terminal(transportHost, (await start(transportHost, 'transport-once')).taskId)).status, 'succeeded')
  assert.equal(transportCalls, 2)
  assert.equal(transportWeaves, 1, 'retry must review the same candidate, not regenerate it')
  assert.equal(store.getDocument('transport-once').edges.length, 1)
  assert.equal(store.getDocument('transport-once').generation.relationRetrySemanticReview.retries[0].reason, 'review_transport_retry')

  fixture('transport-persistent', 3)
  let persistentCalls = 0
  const persistentHost = createHost({ weaveRelations: proposal, async reviewRelations() { persistentCalls++; throw transportError() } })
  const persistentResult = await terminal(persistentHost, (await start(persistentHost, 'transport-persistent')).taskId)
  assert.equal(persistentCalls, 2, 'persistent outage must stop after one retry, without recursive batch splitting')
  assert.equal(persistentResult.error.code, 'relation_review_pending')
  assert.match(persistentResult.error.message, /待审 1 条/)
  assert.match(persistentResult.error.message, /Stream ended without finish_reason/)
  const pendingGraph = store.getDocument('transport-persistent')
  assert.equal(pendingGraph.edges.length, 0)
  assert.equal(pendingGraph.generation.relationDiscovery.searchedTargets, 3)
  assert.match(pendingGraph.generation.relationRetrySemanticReview.withheld[0].reason, /finish_reason/)
  const freshReviewer = createHost({ async weaveRelations() { assert.fail('resume must not re-search completed targets') }, reviewRelations: supported })
  assert.equal((await terminal(freshReviewer, (await start(freshReviewer, 'transport-persistent')).taskId)).status, 'succeeded')
  assert.equal(store.getDocument('transport-persistent').edges.length, 1)
  assert.equal(store.getDocument('transport-persistent').generation.relationDiscovery.pass, 1)

  fixture('review-auth', 3)
  let authCalls = 0
  const authHost = createHost({ weaveRelations: proposal, async reviewRelations() {
    authCalls++
    throw Object.assign(transportError(), { status: 401 })
  } })
  assert.equal((await terminal(authHost, (await start(authHost, 'review-auth')).taskId)).error.code, 'relation_review_pending')
  assert.equal(authCalls, 1, 'permanent HTTP failure overrides a generic transport code')

  fixture('review-cancel-backoff', 3)
  let cancelReviewCalls = 0
  const cancelReviewHost = createHost({ weaveRelations: proposal, async reviewRelations() { cancelReviewCalls++; throw transportError() } })
  const cancelReviewTask = await start(cancelReviewHost, 'review-cancel-backoff')
  let backoffSeen = false
  for (let i = 0; i < 200; i++) {
    const status = await request(cancelReviewHost, 'task-status', { taskId: cancelReviewTask.taskId }, 'GET')
    if (status.progress?.stage?.includes('自动重试')) { backoffSeen = true; break }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert(backoffSeen, 'backoff must be observable in task progress')
  await request(cancelReviewHost, 'task-cancel', { taskId: cancelReviewTask.taskId })
  assert.equal((await terminal(cancelReviewHost, cancelReviewTask.taskId)).status, 'cancelled')
  assert.equal(cancelReviewCalls, 1, 'cancel backoff must prevent another model call')
  assert.equal(store.getDocument('review-cancel-backoff').revision, 1, 'cancelled batch must not commit')

  fixture('dense', 3)
  const denseGraph = store.getDocument('dense')
  denseGraph.edges = [['n0', 'n1'], ['n1', 'n2'], ['n0', 'n2']].map(([fromNodeId, toNodeId]) => ({ fromNodeId, toNodeId, relation: 'supports' }))
  store.saveGraph(denseGraph, { sourceText: denseGraph.sourceText, expectedRevision: denseGraph.revision })
  const denseTargets = []
  const dense = createHost({ async weaveRelations({ targetIds }) { denseTargets.push(...targetIds); return { edges: [] } } })
  assert.equal((await terminal(dense, (await start(dense, 'dense')).taskId)).status, 'succeeded')
  assert.equal(denseTargets.length, 3, 'a connected graph is not proof that relation search is complete')
  assert.equal((await start(dense, 'dense', { continuous: 'true' })).error.code, 'invalid_input')
  assert.equal((await start(dense, 'dense', { reviewPendingOnly: 'true' })).error.code, 'invalid_input')

  const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const components = client.slice(client.indexOf('      function GenerationProgress('), client.indexOf('      // --------------------------- constants'))
  const h = (tag, props, ...children) => typeof tag === 'function' ? tag(props) : { tag, props, children }
  const ui = new Function('h', components + '; return { RelationCompletionControls, RelationCompletionStatus, GenerationProgress }')(h)
  let selected, launched = 0
  const controls = ui.RelationCompletionControls({ continuous: true, onContinuousChange: value => { selected = value }, onStart: () => { launched++ } })
  assert.equal(controls.children[0].children[0].props.checked, true)
  controls.children[0].children[0].props.onChange({ target: { checked: false } })
  assert.equal(selected, false)
  controls.children[1].props.onClick()
  assert.equal(launched, 1)
  assert(JSON.stringify(ui.RelationCompletionControls({ continuous: true, coverage: { remainingTargets: 0 } })).includes('再检索一轮'))
  assert.equal(ui.RelationCompletionControls({ continuous: false, coverage: { remainingTargets: 0 } }).children[1].children[0], '检索一批', 'single batch must not promise a full round')
  assert(JSON.stringify(ui.GenerationProgress({ progress: { completion: { continuous: true, savedCycles: 1, savedTargets: 48, totalTargets: 137, acceptedEdges: 2 }, requests: [] } })).includes('48/137'))
  assert(client.includes('continuous: continuousRelations'), 'start must send the chosen server execution mode')
  assert(!client.includes('每次检查最多 4 组重点节点'), 'old manual-only UX must be removed')
  console.log(JSON.stringify({ ok: true, continuousTargets: 137, commits: 3, oneRoundOnly: true, noInventedEdges: true, acceptedEdges: 12, missingReviewerRejected: true, cancelAndFreshHost: true, partialFailureSaved: true, casConflict: true, pendingReviewRecovery: true, denseGraph: true, controls: true }))
} finally {
  store.close()
  for (const cleanup of cleanups.reverse()) cleanup()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
