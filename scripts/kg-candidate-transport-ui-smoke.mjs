import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Run the actual synchronization effect and review callback from both builds.
// The HTTP/SQLite and dynamic handlers are covered by candidate-sync-smoke.
const ref = process.argv.find(arg => arg.startsWith('--client-ref='))?.slice('--client-ref='.length)
const commit = ref ? execFileSync('git', ['rev-parse', '--verify', ref + '^{commit}'], { encoding: 'utf8' }).trim() : null
const read = path => commit ? execFileSync('git', ['show', commit + ':' + path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const sources = [['dynamic', read('src/index.client.js')], ['persistent', read('lib/client.js')]]
const graph = {
  source: { documentId: 'candidate-transport-ui', id: 'candidate-source' },
  ontology: 'proposition-v1',
  nodes: Array.from({ length: 12000 }, (_, i) => ({ id: 'n' + i, type: i % 2 ? 'fact' : 'concept',
    text: 'Candidate ' + i, quote: '完整原文'.repeat(100), paragraph: i,
    evidence: [{ paragraph: i, quote: '完整原文'.repeat(100) }] })), edges: [],
}
const original = JSON.stringify(graph)
const row = { documentId: graph.source.documentId, kind: 'claim', nodeId: 'n11999', id: 'clm_n11999', status: 'accepted' }
const key = graph.source.documentId + '|claim|n11999'

function extract(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert(start >= 0 && end > start, 'production candidate callback bounds missing')
  return source.slice(start, end)
}
function mount(source, call, viewedGraph = graph) {
  let complete
  const done = new Promise(resolve => { complete = resolve })
  const state = { reviews: {}, remote: undefined, saves: [], toasts: [], cleanup: null }
  const view = { graph: viewedGraph }
  const env = {
    resultView: view, currentResultRef: { current: view }, candidateReviewPendingRef: { current: new Set() },
    host: { call }, rpc: call,
    CANDIDATE_ENTITY_TYPES: new Set(['concept', 'definition']),
    CANDIDATE_CLAIM_TYPES: new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example']),
    candidateKindFor: node => ['concept', 'definition'].includes(node?.type) ? 'entity'
      : ['fact', 'claim', 'inference', 'rule', 'counter_example'].includes(node?.type) ? 'claim' : null,
    REVIEW_STATUS_ORDER: ['candidate', 'accepted', 'rejected'],
    useEffect: fn => { state.cleanup = fn() },
    setCandidateRemote: value => { state.remote = typeof value === 'function' ? value(state.remote) : value; complete() },
    setCandidateReviews: value => { state.reviews = value(state.reviews) },
    saveCandidateReviews: value => state.saves.push({ ...value }),
    toastStore: { show: value => state.toasts.push(value) },
  }
  const keys = extract(source, '       function reviewKeyFor(', '       function loadCandidateReviews(')
  const helper = extract(source, '       function candidateGraphPayload(', '      const SEVERITY_META')
  const effect = extract(source, '         const candidateSyncKey =', '         const loadGraphWindow =')
  new Function(...Object.keys(env), helper + effect)(...Object.values(env))
  const reviewBody = extract(source, '        const handleCandidateReview =', '        const handleCandidateLocate =')
  return { state, done, switchView: () => { env.currentResultRef.current = { graph: { ...viewedGraph, source: { documentId: 'another-document' } } } },
    review: (key, status) => new Function(...Object.keys(env), 'candidateReviews', 'candidateRemote',
    keys + helper + reviewBody + '\nreturn handleCandidateReview')(...Object.values(env), state.reviews, state.remote)(key, status) }
}

const results = []
for (const [name, source] of sources) {
  const calls = []
  const saved = mount(source, async (method, args) => { calls.push({ method, args }); return { candidates: [row], source: 'sqlite' } })
  await saved.done
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'candidate-list')
  assert(!('graph' in calls[0].args), name + ': saved candidate synchronization must not upload the graph')
  assert.equal(calls[0].args.documentId, graph.source.documentId)
  assert(Buffer.byteLength(JSON.stringify(calls[0].args)) < 200)
  assert.equal(saved.state.reviews[key], 'accepted')
  let updateFailure = false
  const reviews = mount(source, async (method, args) => {
    calls.push({ method, args })
    if (method === 'candidate-list') return { candidates: [row], source: 'sqlite' }
    if (updateFailure) return { error: { message: 'Synthetic write failure' } }
    return { candidate: { ...row, status: args.status } }
  })
  await reviews.done
  await reviews.review(key, 'rejected')
  const update = calls.at(-1)
  assert.equal(update.method, 'candidate-update')
  assert.equal(update.args.reviewOnly, true)
  assert.deepEqual(update.args.graph.nodes, [{ id: 'n11999', type: 'fact' }], 'an update beyond the list limit must send only that node')
  assert(Buffer.byteLength(JSON.stringify(update.args)) < 500)
  assert.equal(reviews.state.reviews[key], 'rejected')
  assert.equal(reviews.state.remote[0].status, 'rejected')
  updateFailure = true
  await reviews.review(key, 'accepted')
  assert.equal(reviews.state.reviews[key], 'rejected', 'failed remote update must roll back the optimistic review')
  assert.equal(reviews.state.remote[0].status, 'rejected')
  assert.equal(reviews.state.toasts.length, 1)

  const fallbackCalls = []
  const fallback = mount(source, async (method, args) => {
    fallbackCalls.push(args)
    return args.graph ? { candidates: [{ ...row, nodeId: 'n1', id: 'clm_n1' }], source: 'fallback' }
      : { candidates: [], source: 'fallback', requiresGraph: true }
  })
  await fallback.done
  assert.equal(fallbackCalls.length, 2, 'local/dynamic/SQLite failure must request the explicit graph fallback')
  assert(!('graph' in fallbackCalls[0]))
  const compact = fallbackCalls[1].graph
  assert.equal(fallbackCalls[1].reviewOnly, true)
  assert.equal(compact.ontology, graph.ontology)
  assert.equal(compact.nodes.length, 500)
  assert(compact.nodes.every(node => Object.keys(node).sort().join(',') === 'id,type'))
  assert.deepEqual(compact.nodes, graph.nodes.slice(0, 500).map(({ id, type }) => ({ id, type })))
  assert(Buffer.byteLength(JSON.stringify(fallbackCalls[1])) < 25000)
  assert.equal(fallback.state.reviews[graph.source.documentId + '|claim|n1'], 'accepted')

  let release
  const cancelledCalls = []
  const cancelled = mount(source, (method, args) => {
    cancelledCalls.push(args)
    return new Promise(resolve => { release = resolve })
  })
  cancelled.state.cleanup()
  release({ candidates: [], requiresGraph: true })
  await new Promise(setImmediate)
  assert.equal(cancelledCalls.length, 1, 'disposed synchronization must not upload the old document fallback')
  assert.equal(cancelled.state.remote, undefined)
  assert.deepEqual(cancelled.state.saves, [])

  const localCalls = []
  const local = mount(source, async (method, args) => { localCalls.push(args); return { candidates: [] } },
    { ...graph, source: { id: 'unsaved-source' } })
  await local.done
  assert.equal(localCalls[0].documentId, 'unsaved-source', 'unsaved graph must not query every stored document')
  const failed = mount(source, async () => ({ error: { code: 'invalid_input' } }))
  await failed.done
  assert.equal(failed.state.remote, null)
  assert.deepEqual(failed.state.saves, [])

  const unlistedCalls = []
  let unlistedFailure = false
  const unlisted = mount(source, async (method, args) => {
    unlistedCalls.push({ method, args })
    if (method === 'candidate-list') return { candidates: args.nodeId ? [{ ...row, status: 'candidate' }] : [], source: 'sqlite' }
    if (unlistedFailure) return { error: { message: 'Synthetic unlisted update failure' } }
    return { candidate: { id: row.id, kind: row.kind, status: args.status } }
  })
  await unlisted.done
  await unlisted.review(key, 'accepted')
  assert.equal(unlistedCalls.filter(call => call.method === 'candidate-update').length, 1,
    name + ': confirmation absent from the initial 500 remote rows must persist')
  const lookup = unlistedCalls[1]
  assert.equal(lookup.method, 'candidate-list'); assert.equal(lookup.args.nodeId, row.nodeId)
  assert.equal(lookup.args.kind, row.kind); assert.equal(lookup.args.documentId, row.documentId)
  assert.equal(lookup.args.limit, 1); assert.equal(lookup.args.status, 'all'); assert.equal(lookup.args.reviewOnly, true)
  assert(!('graph' in lookup.args)); assert(Buffer.byteLength(JSON.stringify(lookup.args)) < 250)
  assert.equal(unlistedCalls[2].args.id, row.id, 'use the host candidate identity, never construct an id from the node')
  assert.equal(unlistedCalls[2].args.graph.nodes.length, 1)
  assert.equal(unlisted.state.reviews[key], 'accepted'); assert.equal(unlisted.state.remote.length, 1)
  await unlisted.review(key, 'rejected')
  assert.equal(unlistedCalls.filter(call => call.method === 'candidate-list').length, 2, 'reuse the resolved identity on later confirmations')
  unlistedFailure = true
  await unlisted.review(key, 'accepted')
  assert.equal(unlisted.state.reviews[key], 'rejected'); assert.equal(unlisted.state.remote[0].status, 'rejected')

  const failureCases = [
    ['empty', async () => ({ candidates: [] })],
    ['lookup-error', async () => ({ error: { message: 'Synthetic lookup failure' } })],
    ['wrong-document', async () => ({ candidates: [{ ...row, documentId: 'other-document' }] })],
    ['wrong-node', async () => ({ candidates: [{ ...row, nodeId: 'n1' }] })],
    ['wrong-kind', async () => ({ candidates: [{ ...row, kind: 'entity' }] })],
    ['missing-id', async () => ({ candidates: [{ ...row, id: '' }] })],
    ['thrown', async () => { throw new Error('Synthetic lookup transport error') }],
  ]
  for (const [scenario, reply] of failureCases) {
    const trace = []
    const rejected = mount(source, async (method, args) => {
      trace.push({ method, args })
      return args.nodeId ? reply() : { candidates: [] }
    })
    await rejected.done; await rejected.review(key, 'accepted')
    assert.equal(rejected.state.reviews[key], 'candidate', scenario + ': failed identity resolution must roll back')
    assert.equal(trace.filter(call => call.method === 'candidate-update').length, 0)
    assert.equal(rejected.state.toasts.length, 1)
  }

  const fallbackLookupCalls = []
  const unlistedFallback = mount(source, async (method, args) => {
    fallbackLookupCalls.push({ method, args })
    if (method === 'candidate-update') return { candidate: { ...row, status: args.status } }
    if (!args.nodeId) return { candidates: [] }
    return args.graph ? { candidates: [{ ...row, status: 'candidate' }], source: 'fallback' }
      : { candidates: [], requiresGraph: true }
  })
  await unlistedFallback.done; await unlistedFallback.review(key, 'accepted')
  assert.equal(fallbackLookupCalls.length, 4)
  assert.equal(fallbackLookupCalls[2].args.nodeId, row.nodeId)
  assert.deepEqual(fallbackLookupCalls[2].args.graph.nodes, [{ id: row.nodeId, type: 'fact' }])
  assert.equal(unlistedFallback.state.reviews[key], 'accepted')

  for (const stage of ['lookup', 'lookup-fallback', 'update']) {
    let releasePending
    const trace = []
    const switched = mount(source, async (method, args) => {
      trace.push({ method, args })
      if (!args.nodeId) return { candidates: stage === 'update' ? [{ ...row, status: 'candidate' }] : [] }
      if (stage === 'lookup-fallback' && !args.graph) return { candidates: [], requiresGraph: true }
      return new Promise(resolve => { releasePending = resolve })
    })
    await switched.done
    const pending = switched.review(key, 'accepted')
    await new Promise(setImmediate)
    switched.switchView()
    releasePending(stage !== 'update' ? { candidates: [row] } : { candidate: { ...row, status: 'accepted' } })
    await pending
    assert.equal(trace.filter(call => call.method === 'candidate-update').length, stage === 'update' ? 1 : 0)
    assert.equal(switched.state.reviews[key], stage === 'update' ? 'accepted' : 'candidate')
    assert.equal(switched.state.remote.length, stage === 'update' ? 1 : 0)
    if (stage === 'update') assert.equal(switched.state.remote[0].status, 'candidate')
    assert.equal(switched.state.toasts.length, 0, 'old document completions must not notify the new document')
  }
  const recoveringCalls = []
  const recovering = mount(source, async (method, args) => {
    recoveringCalls.push({ method, args })
    if (method === 'candidate-update') return { candidate: { ...row, status: args.status } }
    return args.nodeId ? { candidates: [{ ...row, status: 'candidate' }] } : { error: { message: 'Initial list unavailable' } }
  })
  await recovering.done; assert.equal(recovering.state.remote, null)
  await recovering.review(key, 'accepted')
  assert.equal(recoveringCalls.filter(call => call.method === 'candidate-update').length, 1)
  assert.equal(recovering.state.reviews[key], 'accepted')

  let resolveSeed, resolveColdUpdate
  const cold = mount(source, async (method, args) => {
    if (method === 'candidate-update') return new Promise(resolve => { resolveColdUpdate = resolve })
    return args.nodeId ? { candidates: [{ ...row, status: 'candidate' }] }
      : new Promise(resolve => { resolveSeed = resolve })
  })
  const coldReview = cold.review(key, 'accepted')
  await new Promise(setImmediate)
  resolveSeed({ candidates: [{ ...row, status: 'candidate' }] }); await cold.done
  assert.equal(cold.state.reviews[key], 'candidate', 'the initial sync fixture must settle during the pending update')
  resolveColdUpdate({ candidate: { ...row, status: 'accepted' } }); await coldReview
  assert.equal(cold.state.reviews[key], 'accepted', 'confirmed status must win over the earlier list snapshot')
  let resolveLookup
  const busyCalls = []
  const busy = mount(source, async (method, args) => {
    busyCalls.push({ method, args })
    if (method === 'candidate-update') return { candidate: { ...row, status: args.status } }
    if (!args.nodeId) return { candidates: [] }
    return new Promise(resolve => { resolveLookup = resolve })
  })
  await busy.done
  const accepting = busy.review(key, 'accepted')
  await busy.review(key, 'rejected')
  assert.equal(busyCalls.length, 2, 'a repeated click while resolving must not race a second update')
  assert.equal(busy.state.reviews[key], 'accepted'); assert.equal(busy.state.toasts.length, 1)
  resolveLookup({ candidates: [{ ...row, status: 'candidate' }] }); await accepting
  await busy.review(key, 'rejected')
  assert.equal(busyCalls.filter(call => call.method === 'candidate-update').length, 2, 'completion must release the per-candidate guard')
  assert.equal(busy.state.reviews[key], 'rejected')

  const opaqueGraph = { ...graph, source: { documentId: ' spaced|claim|候选 ', id: 'opaque-source' },
    nodes: [{ ...graph.nodes.at(-1), id: '尾|entity|节点' }] }
  const opaqueRow = { ...row, documentId: opaqueGraph.source.documentId, nodeId: opaqueGraph.nodes[0].id, id: 'actual-host-opaque-id' }
  const opaqueKey = opaqueRow.documentId + '|claim|' + opaqueRow.nodeId, opaqueCalls = []
  const opaque = mount(source, async (method, args) => {
    opaqueCalls.push({ method, args })
    if (method === 'candidate-update') return { candidate: { ...opaqueRow, status: args.status } }
    return { candidates: args.nodeId ? [opaqueRow] : [] }
  }, opaqueGraph)
  await opaque.done; await opaque.review(opaqueKey, 'accepted')
  assert.equal(opaqueCalls[1].args.documentId, opaqueRow.documentId)
  assert.equal(opaqueCalls[1].args.nodeId, opaqueRow.nodeId)
  assert.equal(opaqueCalls[2].args.id, opaqueRow.id, 'delimiters and spaces in identities must not be split or trimmed')
  assert.equal(opaque.state.reviews[opaqueKey], 'accepted')

  const fullRows = Array.from({ length: 500 }, (_, i) => ({ ...row, nodeId: 'n' + i, id: 'host-row-' + i }))
  const bounded = mount(source, async (method, args) => method === 'candidate-update' ? { candidate: { ...row, status: args.status } }
    : { candidates: args.nodeId ? [row] : fullRows })
  await bounded.done; await bounded.review(key, 'accepted')
  assert.equal(bounded.state.remote.length, 500, 'resolved identities must not grow the bounded remote cache')
  assert(bounded.state.remote.some(value => value.id === row.id))
  assert.equal(JSON.stringify(graph), original, 'candidate synchronization must retain all source evidence')
  results.push({ name, nodes: graph.nodes.length, savedRequestBytes: Buffer.byteLength(JSON.stringify(calls[0].args)),
    fallbackRequestBytes: Buffer.byteLength(JSON.stringify(fallbackCalls[1])), fallbackNodes: compact.nodes.length,
    updateRequestBytes: Buffer.byteLength(JSON.stringify(update.args)), updateNodes: update.args.graph.nodes.length,
    optimisticRollback: true, disposedFallbackSkipped: true, sourceEvidencePreserved: true,
    unlistedPersisted: true, resolvedIdentityReused: true, lookupRollbackCases: failureCases.length,
    oneIdentityLookupFallback: true, documentSwitchStages: 3, repeatedClickGuard: true, opaqueIdentityPreserved: true,
    boundedResolvedCache: true, initialListRecovery: true, confirmedStatusWins: true })
}
console.log(JSON.stringify({ ok: true, candidateTransport: results }))
