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
  const env = {
    resultView: { graph: viewedGraph }, host: { call }, rpc: call,
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
  const helper = extract(source, '       function candidateGraphPayload(', '      const SEVERITY_META')
  const effect = extract(source, '         const candidateSyncKey =', '         const loadGraphWindow =')
  new Function(...Object.keys(env), helper + effect)(...Object.values(env))
  const reviewBody = extract(source, '        const handleCandidateReview =', '        const handleCandidateLocate =')
  return { state, done, review: (key, status) => new Function(...Object.keys(env), 'candidateReviews', 'candidateRemote',
    helper + reviewBody + '\nreturn handleCandidateReview')(...Object.values(env), state.reviews, state.remote)(key, status) }
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
  assert.equal(JSON.stringify(graph), original, 'candidate synchronization must retain all source evidence')
  results.push({ name, nodes: graph.nodes.length, savedRequestBytes: Buffer.byteLength(JSON.stringify(calls[0].args)),
    fallbackRequestBytes: Buffer.byteLength(JSON.stringify(fallbackCalls[1])), fallbackNodes: compact.nodes.length,
    updateRequestBytes: Buffer.byteLength(JSON.stringify(update.args)), updateNodes: update.args.graph.nodes.length,
    optimisticRollback: true, disposedFallbackSkipped: true, sourceEvidencePreserved: true })
}
console.log(JSON.stringify({ ok: true, candidateTransport: results }))
