import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

// Only synthetic observations, mock extractors/streams, and an exclusively owned
// temporary SQLite database. Never connect to DSH, its providers, or saved graphs.
// --dynamic-only exercises the actual source engine with minimal instrumentation.
// Default / --built also exercises lib's production HTTP routes over loopback :0.
// Rebuild lib before built mode. v1/v2/v3 journal compatibility is deliberately
// owned by kg-relation-budget-smoke.mjs rather than repeated by this focused suite.
const flags = new Set(process.argv.slice(2))
assert([...flags].every(flag => ['--dynamic-only', '--built'].includes(flag)), 'Usage: node scripts/kg-relation-truncation-smoke.mjs [--dynamic-only | --built]')
assert(!(flags.has('--dynamic-only') && flags.has('--built')), 'Choose dynamic-only or built, not both')
const oldDb = process.env.DSH_KG_DB, oldHarness = globalThis.harness
const dir = mkdtempSync(join(tmpdir(), 'kg-relation-truncation-'))
const ownedDirectory = realpathSync(dir)
const db = join(dir, 'synthetic.sqlite')
process.env.DSH_KG_DB = db
let store = await openSqliteStore(db)
const cleanups = []
const key = edge => `${edge.fromNodeId}>${edge.toNodeId}:${edge.relation}`
const truncated = () => Object.assign(new Error('Synthetic output token budget exhausted'), { code: 'output_truncated', outputChars: 16, reasoningChars: 0 })
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done }), resolve } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function weaveRelationsHost('
assert.equal(source.split(marker).length, 2, 'Source production instrumentation anchor must be unique')
const stallDelayMarker = 'const STREAM_STALL_RETRY_DELAY_MS = 3000'
assert.equal(source.split(stallDelayMarker).length, 2, 'Fast fixture may alter only the one documented stall delay, not accounting logic')
const instrumented = source.replace(marker, `      harness.truncationTest = { weaveRelationsHost, weaveRelationsBudgetHost, runRelationRetryTask, reviewHighRiskRelationsHost, buildRelationWeaveGroupsHost, graphConnectivityHost, rememberCanonicalGraphHost, loadCanonicalDocumentHost, sha256HexHost, attach(task) { activeTask = task }, getActive() { return activeTask }, getTask(id) { return tasks.get(id) } }
${marker}`).replace(stallDelayMarker, 'const STREAM_STALL_RETRY_DELAY_MS = 0')
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))

function sourceHost(extractor, services = {}) {
  const handlers = new Map(), harness = { handle(name, fn) { handlers.set(name, fn) } }
  globalThis.harness = harness
  plugin().apply({ get(name) { return name === 'kgExtractor' ? extractor : services[name] || null }, interval() {} })
  assert.equal(typeof harness.truncationTest.weaveRelationsHost, 'function')
  return { ...harness.truncationTest, handlers, request(name, body = {}) {
    const handle = handlers.get(name); assert.equal(typeof handle, 'function', name); return handle(body)
  } }
}
function fixture(id, count = 12, { searched = 0, long = false } = {}) {
  const paragraphs = Array.from({ length: count }, (_, i) => `独立测试记录${i}，这里只描述合成观察，不蕴含其它命题。`)
  if (count > 20) {
    paragraphs[20] = '澄明归纳锚点：远端前提只是关系召回域中的合成观察。'
    paragraphs[Math.min(640, count - 1)] = '澄明归纳锚点：本地结论与远端前提待独立核查。'
  }
  if (long) paragraphs[0] = '完整证据起点。' + '保留本段完整长证据，不剪成引文片段。'.repeat(360) + '完整证据末端PIN_TAIL。'
  const graph = { source: { id: 'source-' + id, documentId: id, title: 'Synthetic truncation fixture' },
    summary: '', warnings: [], nodes: paragraphs.map((text, i) => ({ id: 'n' + i, type: 'claim', text, quote: text,
      paragraph: i, evidence: [{ paragraph: i, quote: text }] })), edges: [] }
  const text = paragraphs.join('\n\n')
  const signature = hash([text, graph.nodes.map(node => [node.id, node.type, node.text, node.quote, node.paragraph,
    node.evidence.map(item => [item.paragraph, item.quote]), node.sectionId]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
  const completedTargetIds = graph.nodes.slice(0, searched).map(node => node.id)
  graph.generation = { relationDiscovery: { version: 1, signature, pass: 1, totalTargets: count,
    completedTargetIds, searchedTargets: searched, remainingTargets: count - searched } }
  return { documentId: id, graph, text, paragraphs }
}
function saveFixture(sample) {
  store.saveGraph(sample.graph, { sourceText: sample.text })
  return store.getDocument(sample.documentId)
}
function accumulator(graph) {
  const copy = structuredClone(graph)
  return { nodes: new Map(copy.nodes.map(node => [node.id, node])), edges: copy.edges,
    edgeKeys: new Set(copy.edges.map(key)), warnings: copy.warnings || [] }
}
async function directWeave(api, sample, { task = {}, journal = null, persist } = {}) {
  const current = { id: sample.documentId, kind: 'relation-retry', title: 'Synthetic truncation fixture', status: 'running',
    progress: {}, concurrency: 1, cancelled: false, cancelHooks: [], ...task, relationWeave: journal }
  const runId = sample.documentId + '-journal'
  current.persistRelationWeave = persist || (async next => {
    store.saveCheckpoint({ version: 2, documentId: sample.documentId, taskKind: 'relation-retry', graph: sample.graph,
      baseRevision: store.getDocument(sample.documentId)?.revision || 0, relationWeave: next },
    { runId, sourceText: sample.text, status: 'running' })
  })
  api.attach(current)
  const acc = accumulator(sample.graph)
  const result = await api.weaveRelationsHost(current, task.model || null, acc, sample.paragraphs,
    { documentId: sample.documentId }, sample.text, sample.graph.generation?.relationDiscovery)
  return { result, task: current, acc, runId }
}
function supported({ candidates }) {
  return { verdicts: candidates.map(item => ({ id: item.id, verdict: 'supported', reason: 'Independent synthetic fixture verdict', evidence: item.edge.evidence })) }
}
function candidate(args, from = args.targetIds[0], to = args.nodes.find(node => node.id !== from)?.id) {
  if (!from || !to) return { edges: [] }
  const first = args.nodes.find(node => node.id === from)
  return { edges: [{ fromNodeId: from, toNodeId: to, relation: 'supports', evidence: [{ paragraph: first.paragraph, quote: args.units.find(unit => unit.num === first.paragraph).text }] }] }
}
function requestRecord(args) {
  return { targetIds: args.targetIds.slice(), nodes: args.nodes.map(node => node.id),
    nodeContext: structuredClone(args.nodes), edges: structuredClone(args.edges || []), prompt: args.prompt,
    systemPrompt: args.systemPrompt, outputScope: structuredClone(args.outputScope || null),
    units: args.units.map(unit => ({ ...unit })), attempt: args.attempt }
}
function assertCoverage(value, expected, total, label = '') {
  assert(value, label + ': coverage missing')
  assert.equal(value.searchedTargets, expected, label)
  assert.equal(value.remainingTargets, total - expected, label)
  assert.equal(value.completedTargetIds.length, expected, label)
  assert.equal(new Set(value.completedTargetIds).size, expected, label + ': no duplicate targets')
}

async function httpHost(extractor, services = {}) {
  const host = await import('../lib/index.js')
  let handler
  const ownCleanups = []
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
    return name === 'kgExtractor' ? extractor : services[name] || null
  }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') ownCleanups.push(cleanup); return cleanup },
  interval() { return () => {} }, onCleanup(fn) { ownCleanups.push(fn) } })
  assert.equal(typeof handler, 'function', 'Built production HTTP route must register')
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(error => {
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ unexpected: error.message }))
  }) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/'
  let closed = false
  const close = async () => { if (closed) return; closed = true; for (const fn of ownCleanups.reverse()) await fn(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  cleanups.push(close)
  const request = async (endpoint, body = {}, method = 'POST') => {
    const response = await fetch(origin + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : ''),
      { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.status, 200, endpoint + ': ' + response.status)
    return response.json()
  }
  return { request, close }
}
async function terminal(host, taskId) {
  assert.equal(typeof taskId, 'string', 'Production retry route must return taskId')
  const deadline = Date.now() + 15000
  for (;;) {
    const status = await host.request('task-status', { taskId }, 'GET')
    if (!['running', 'pausing'].includes(status.status)) return status
    assert(Date.now() < deadline, 'Bounded mocked relation-retry did not terminate')
    await delay(2)
  }
}
async function startRetry(host, id, options = {}) {
  return host.request('relation-retry', { documentId: id, expectedRevision: store.getDocument(id).revision,
    continuous: true, relationBatchBudget: 3, concurrency: 1, ...options })
}

function scopeVolume(scope) {
  assert.equal(scope?.policy, 'relation-output-partition-v1', 'Production request must expose its exact output scope')
  return scope.fromNodeIds.length * scope.toNodeIds.length * scope.relations.length
}
function requestIdentity(args) {
  return hash([args.targetIds, args.outputScope])
}
function triples(scope) {
  return scope.fromNodeIds.flatMap(from => scope.toNodeIds.flatMap(to => scope.relations.map(relation => `${from}>${to}:${relation}`)))
}
function seedSource(api, sample, revision = 1) {
  api.rememberCanonicalGraphHost(structuredClone(sample.graph), sample.text, revision)
}
async function sourceRetry(api, sample, options = {}) {
  return api.request('relation-retry', { documentId: sample.documentId,
    expectedRevision: api.loadCanonicalDocumentHost(sample.documentId).revision, concurrency: 1,
    continuous: false, relationBatchBudget: 1, ...options })
}
async function streamTruncationCase() {
  const sample = fixture('stream-finish')
  const prompts = [], rootEdge = candidate({ targetIds: ['n0'], nodes: sample.graph.nodes,
    units: sample.paragraphs.map((text, num) => ({ num, text })) }).edges[0]
  const api = sourceHost({}, { llm: { async *stream({ messages }) {
    const text = messages.map(message => typeof message.content === 'string' ? message.content :
      message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n')
    prompts.push(text)
    yield { type: 'text-delta', text: JSON.stringify({ edges: prompts.length === 1 ? [rootEdge] : [] }) }
    yield { type: 'finish', reason: { kind: prompts.length === 1 ? 'max-tokens' : 'stop' } }
  } } })
  const outcome = await directWeave(api, sample, { task: { model: { provider: 'synthetic', model: 'complete-json-max-tokens' } } })
  assert(prompts.length > 1)
  assert.equal(prompts.filter(prompt => prompt === prompts[0]).length, 1,
    'finish:max-tokens must split, never parse/admit seemingly complete root JSON or retry it')
  assert.equal(outcome.acc.edges.length, 0, 'Truncated complete-looking candidate cannot enter the accumulator')
  assertCoverage(outcome.result.coverage, 12, 12)
  return true
}
async function streamStallBudgetCases() {
  const results = {}
  for (const budget of [1, 2]) {
    const sample = fixture('stream-stall-budget-' + budget)
    let calls = 0
    const api = sourceHost({}, { llm: { async *stream() {
      calls++
      if (calls === 1) throw Object.assign(new Error('Synthetic instantaneous stream idle timeout'),
        { code: 'timeout', phase: 'llm_stream_idle' })
      yield { type: 'text-delta', text: '{"edges":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } })
    const operation = directWeave(api, sample, { task: { relationRequestBudget: budget,
      model: { provider: 'synthetic', model: 'stall-retry-accounting' } } })
    if (budget === 1) await assert.rejects(operation, { code: 'relation_request_budget_exhausted' })
    else assertCoverage((await operation).result.coverage, 12, 12)
    assert.equal(calls, budget, 'Every actual llm.stream invocation, including the hidden idle retry, consumes one shared request credit')
    assert.equal(api.getActive().progress.relationRecovery.requests, calls)
    assert.equal(api.getActive().progress.relationRecovery.weaveRequests, calls)
    results['cap' + budget] = calls
  }
  return results
}
async function durableSourceCase() {
  const sample = fixture('durable-leaf')
  const successful = [], firstRequests = []
  const api = sourceHost({ async weaveRelations(args) {
    firstRequests.push(requestRecord(args))
    if (args.outputScope.path === '') throw truncated()
    if (!successful.length) { successful.push(requestIdentity(args)); return { edges: [] } }
    throw new Error('Synthetic other leaf temporarily unavailable')
  } })
  await assert.rejects(directWeave(api, sample), { code: 'relation_weave_failed' })
  assertCoverage(api.getActive().relationWeave.coverage, 0, 12, 'One partial leaf cannot mark all root target ids searched')
  assert.equal(successful.length, 1)
  const paid = store.loadCheckpoint(sample.documentId + '-journal').checkpoint.relationWeave
  assert.equal(Object.keys(paid.results).length, 0, 'Partial root must not populate a completed legacy result')
  assert.equal(Object.keys(paid.partitions[0].results).length, 1)
  const cachedHash = Object.values(paid.partitions[0].results)[0].hash
  assert.equal(cachedHash, hash(Object.values(paid.partitions[0].results)[0].norm))
  const requests = []
  const fresh = sourceHost({ async weaveRelations(args) {
    const identity = requestIdentity(args)
    assert(!successful.includes(identity), 'Fresh source Host must not repay a completed leaf')
    assert.notEqual(args.outputScope.path, '', 'Fresh source Host must replay its root split marker, not repay root')
    requests.push(requestRecord(args)); return { edges: [] }
  } })
  const resumed = await directWeave(fresh, sample, { journal: paid })
  assert.equal(requests.length, 1, 'Exactly the single missing sibling leaf is requested')
  assertCoverage(resumed.result.coverage, 12, 12)
  assert(resumed.task.progress.relationRecovery.reusedLeaves >= 1)
  // Authenticate the new subtree rather than trusting an arbitrary saved norm.
  const tampered = structuredClone(paid)
  Object.values(tampered.partitions[0].results)[0].scopeHash = '0'.repeat(64)
  let unexpectedCalls = 0
  const reject = sourceHost({ weaveRelations() { unexpectedCalls++; throw new Error('Should not call provider') } })
  await assert.rejects(directWeave(reject, sample, { journal: tampered }), { code: 'checkpoint_invalid' })
  assert.equal(unexpectedCalls, 0)
  return true
}
async function boundedSourceCases() {
  const outcomes = {}
  for (const [name, options, count] of [
    ['depth', { relationSplitDepth: 0, relationRequestBudget: 16 }, 2],
    ['minimum', { relationSplitDepth: 20, relationRequestBudget: 128 }, 2],
    ['concurrentCap', { relationSplitDepth: 20, relationRequestBudget: 5, concurrency: 4 }, 137],
  ]) {
    const sample = fixture('source-bound-' + name, count)
    const calls = [], identities = new Set()
    let active = 0, peak = 0
    const api = sourceHost({ async weaveRelations(args) {
      assert(!identities.has(requestIdentity(args)), 'A truncated output domain must not be identically retried')
      identities.add(requestIdentity(args)); calls.push(requestRecord(args)); peak = Math.max(peak, ++active)
      await Promise.resolve(); active--; throw truncated()
    } })
    seedSource(api, sample)
    const status = await terminal(api, (await sourceRetry(api, sample, options)).taskId)
    assert.equal(status.status, 'failed', JSON.stringify(status))
    const expected = name === 'concurrentCap' ? 'relation_request_budget_exhausted' : 'output_truncated'
    assert.equal(status.error.code, expected, JSON.stringify(status))
    assertCoverage(api.loadCanonicalDocumentHost(sample.documentId).graph.generation.relationDiscovery, 0, count)
    const recovery = status.progress.relationRecovery
    assert(recovery, 'Production task-status must expose relationRecovery: ' + JSON.stringify(status))
    assert.equal(recovery.requests, calls.length)
    assert.equal(recovery.weaveRequests, calls.length)
    assert.equal(recovery.reviewRequests, 0)
    assert(calls.length <= options.relationRequestBudget)
    if (name === 'depth') assert.equal(calls.length, 1)
    if (name === 'minimum') assert(calls.some(call => scopeVolume(call.outputScope) === 1), 'Actually reach a smallest atomic output domain')
    if (name === 'concurrentCap') { assert.equal(calls.length, 5); assert.equal(peak, 4); assert(recovery.weaveSplits > 0) }
    outcomes[name] = { requests: calls.length, peak, stopCode: expected }
  }
  return outcomes
}
async function independentReviewCases() {
  const outcomes = {}
  for (const mode of ['mixedVerdicts', 'truncatedReview']) {
    const sample = fixture('source-review-' + mode, 6)
    let weaveCalls = 0
    const reviewCalls = []
    const edges = [0, 2, 4].map(index => candidate({ targetIds: ['n' + index], nodes: sample.graph.nodes,
      units: sample.paragraphs.map((text, num) => ({ num, text })) }, 'n' + index, 'n' + (index + 1)).edges[0])
    const api = sourceHost({ weaveRelations() { weaveCalls++; return { edges: structuredClone(edges) } },
      reviewRelations(args) {
        assert.equal(api.loadCanonicalDocumentHost(sample.documentId).graph.edges.length, 0,
          'Discovery is not semantic admission; canonical remains untouched before independent verdict')
        reviewCalls.push(args.candidates.map(item => item.id))
        if (mode === 'truncatedReview' && args.candidates.length === 3) throw truncated()
        if (mode === 'truncatedReview') return supported(args)
        return { verdicts: args.candidates.filter(item => item.edge.fromNodeId !== 'n4').map(item => ({ id: item.id,
          verdict: item.edge.fromNodeId === 'n0' ? 'supported' : 'contradicted', reason: 'Independent synthetic verdict', evidence: item.edge.evidence })) }
      } })
    seedSource(api, sample)
    const status = await terminal(api, (await sourceRetry(api, sample)).taskId)
    assert.equal(status.status, 'succeeded', JSON.stringify(status))
    const graph = api.loadCanonicalDocumentHost(sample.documentId).graph
    assert.equal(weaveCalls, 1)
    assert(reviewCalls.length > 0, 'Independent reviewer must run even for well-formed discovery candidates: ' +
      JSON.stringify({ edges: graph.edges, warnings: graph.warnings, connectivity: graph.generation.connectivity,
        review: graph.generation.relationRetrySemanticReview, status }))
    if (mode === 'mixedVerdicts') {
      assert.deepEqual(graph.edges.map(key), [key(edges[0])], 'Unsupported and missing-verdict pending candidates never canonical')
      assert.equal(graph.generation.relationRetrySemanticReview.pending, 1)
    } else {
      assert.equal(reviewCalls.filter(ids => ids.length === 3).length, 1, 'Truncated review root is not identically repaid')
      assert(reviewCalls.length > 1)
      assert.deepEqual(graph.edges.map(key), edges.map(key))
      assert(status.progress.relationRecovery.reviewSplits > 0)
    }
    assert.equal(status.progress.relationRecovery.requests, weaveCalls + reviewCalls.length, 'Discovery and review share the actual-call ledger')
    outcomes[mode] = true
  }
  return outcomes
}
async function dynamicWriteFailureCase() {
  const sample = fixture('source-checkpoint-write-fail')
  let calls = 0, successfulWrites = 0
  const api = sourceHost({ weaveRelations(args) { calls++; if (args.outputScope.path === '') throw truncated(); return { edges: [] } } })
  await assert.rejects(directWeave(api, sample, { persist: async next => {
    if (calls >= 2) throw Object.assign(new Error('Synthetic leaf checkpoint disk failure'), { code: 'persistence_failed' })
    successfulWrites++; store.saveCheckpoint({ version: 2, relationWeave: next }, { runId: sample.documentId, sourceText: sample.text })
  } }), { code: 'persistence_failed' })
  assert.equal(calls, 2)
  assert(successfulWrites >= 1, 'Root split marker is durable before children are requested')
  assert.equal(Object.keys(api.getActive().relationWeave.results).length, 0)
  assert.equal(Object.keys(api.getActive().relationWeave.partitions[0].results).length, 0, 'A failed leaf write cannot update task-local committed leaf state')
  assertCoverage(api.getActive().relationWeave.coverage, 0, 12)
  return true
}

const scopeSnapshot = readFileSync(new URL('./kg-relation-truncation-scope.snapshot.txt', import.meta.url), 'utf8').trimEnd()
function assertScopeSnapshot(request) {
  const label = '本叶输出域（仅限制输出；完整上下文和全部节点/证据不删减）：'
  const position = request.prompt.lastIndexOf(label)
  assert(position >= 0, 'Output scope must be visible to the model, not merely passed as JS metadata')
  const lines = request.prompt.slice(position).split('\n')
  assert.equal(lines.length, 3, 'Pinned suffix stays compact; do not snapshot the entire prompt blob')
  assert.deepEqual(JSON.parse(lines[1]), request.outputScope)
  assert.equal([lines[0], '<OUTPUT_SCOPE_JSON>', lines[2]].join('\n'), scopeSnapshot)
}
async function outsideScopeCase() {
  const sample = fixture('outside-scope', 12)
  const calls = []
  const api = sourceHost({ weaveRelations(args) {
    calls.push(requestRecord(args))
    if (args.outputScope.path === '') throw truncated()
    // This edge has two genuine original context endpoints and valid evidence,
    // but its FROM belongs to the sibling output domain. It must not be silently
    // dropped and misrepresented as a successful complete empty search.
    assert(!args.outputScope.fromNodeIds.includes('n11'))
    return candidate(args, 'n11', 'n0')
  } })
  await assert.rejects(directWeave(api, sample), { code: 'relation_weave_failed' })
  assert.equal(calls.length, 3, 'Only ordinary validation feedback may retry a malformed leaf once')
  assertCoverage(api.getActive().relationWeave.coverage, 0, 12)
  assert.equal(Object.keys(api.getActive().relationWeave.partitions[0].results).length, 0)
  return true
}
async function sharedReviewCapCase() {
  const sample = fixture('shared-review-cap', 6)
  let weaveCalls = 0, reviewCalls = 0
  const api = sourceHost({ weaveRelations(args) { weaveCalls++; return { edges: [candidate(args, 'n0', 'n1').edges[0], candidate(args, 'n2', 'n3').edges[0]] } },
    reviewRelations() { reviewCalls++; throw truncated() } })
  seedSource(api, sample)
  const status = await terminal(api, (await sourceRetry(api, sample, { relationRequestBudget: 2 })).taskId)
  assert.equal(status.error.code, 'relation_request_budget_exhausted', JSON.stringify(status))
  assert.equal(weaveCalls, 1); assert.equal(reviewCalls, 1)
  assert.equal(status.progress.relationRecovery.requests, 2)
  assert.equal(status.progress.relationRecovery.weaveRequests, 1)
  assert.equal(status.progress.relationRecovery.reviewRequests, 1)
  assertCoverage(api.loadCanonicalDocumentHost(sample.documentId).graph.generation.relationDiscovery, 0, 6)
  assert.equal(api.loadCanonicalDocumentHost(sample.documentId).graph.edges.length, 0)
  return true
}

const illegalRecoveryOptions = [
  { relationRequestBudget: null }, { relationRequestBudget: '3' }, { relationRequestBudget: 1.5 },
  { relationRequestBudget: 0 }, { relationRequestBudget: -1 }, { relationRequestBudget: 129 },
  { relationSplitDepth: null }, { relationSplitDepth: '3' }, { relationSplitDepth: 0.5 },
  { relationSplitDepth: -1 }, { relationSplitDepth: 21 },
  { retryTruncatedLeaf: 'true' }, { retryTruncatedLeaf: null },
]
async function recoveryInputValidationCases(built = false) {
  const sample = fixture(built ? 'http-invalid-new-limits' : 'source-invalid-new-limits', 2)
  let providerCalls = 0
  const extractor = { weaveRelations() { providerCalls++; return { edges: [] } } }
  const host = built ? await httpHost(extractor) : sourceHost(extractor)
  if (built) saveFixture(sample); else seedSource(host, sample)
  for (const options of illegalRecoveryOptions) {
    const rejected = built ? await startRetry(host, sample.documentId, options) : await sourceRetry(host, sample, options)
    assert.equal(rejected.error?.code, 'invalid_input', JSON.stringify({ options, rejected }))
    assert.equal(rejected.taskId, undefined, 'Illegal new limits must never create a billable task')
    assert.equal(providerCalls, 0, 'Input rejection must precede provider invocation')
  }
  const control = built ? await startRetry(host, sample.documentId, { relationRequestBudget: 1, relationSplitDepth: 0 }) :
    await sourceRetry(host, sample, { relationRequestBudget: 1, relationSplitDepth: 0 })
  assert.equal((await terminal(host, control.taskId)).status, 'succeeded', 'Boundary-valid limits must run, so invalid tests cannot pass from unrelated routing failures')
  assert.equal(providerCalls, 1)
  if (built) await host.close()
  return illegalRecoveryOptions.length
}

async function dynamicCases() {
  // Every case enters weaveRelationsHost / relation-retry, not a split helper.
  const sample = fixture('root-once', 12, { long: true })
  const requests = []
  let rootPrompt
  const api = sourceHost({ async weaveRelations(args) {
    requests.push(requestRecord(args))
    rootPrompt ??= args.prompt
    if (args.prompt === rootPrompt) throw truncated()
    return { edges: [] }
  } })
  const outcome = await directWeave(api, sample)
  assert.equal(requests.filter(request => request.prompt === rootPrompt).length, 1,
    'output_truncated root must never retry the unchanged paid request')
  assert.equal(requests.length, 3, 'One truncated root plus two complete child leaves')
  const root = requests[0], leaves = requests.slice(1)
  assert.equal(root.nodeContext.find(node => node.id === 'n0').quote, sample.paragraphs[0])
  assert.deepEqual(root.nodeContext.find(node => node.id === 'n0').evidence, sample.graph.nodes[0].evidence)
  assert(root.prompt.includes(sample.paragraphs[0]), 'The actual model-visible prompt contains every character of the long evidence, not merely the mock service units argument')
  const rootTriples = triples(root.outputScope).sort(), childTriples = leaves.flatMap(leaf => triples(leaf.outputScope)).sort()
  assert.deepEqual(childTriples, rootTriples, 'Disjoint children exactly preserve the full directed endpoint/type domain')
  assert.equal(new Set(childTriples).size, childTriples.length, 'No pair/type is lost or assigned to two leaves')
  const middle = Math.ceil(root.outputScope.fromNodeIds.length / 2)
  assert.deepEqual(leaves[0].outputScope.fromNodeIds, root.outputScope.fromNodeIds.slice(0, middle))
  assert.deepEqual(leaves[1].outputScope.fromNodeIds, root.outputScope.fromNodeIds.slice(middle))
  for (const leaf of leaves) {
    assertScopeSnapshot(leaf)
    assert.deepEqual(leaf.nodes, root.nodes, 'Splitting outputs must not narrow the candidate/evidence context')
    assert.deepEqual(leaf.nodeContext, root.nodeContext, 'All node properties, full quotations and evidence remain unchanged')
    assert.deepEqual(leaf.edges, root.edges)
    assert.equal(leaf.systemPrompt, root.systemPrompt)
    assert.equal(leaf.prompt.slice(0, leaf.prompt.lastIndexOf('本叶输出域（') - 2), root.prompt,
      'Actual model-visible root context stays byte-for-byte intact; only the compact output-domain suffix changes')
    assert.deepEqual(leaf.targetIds, root.targetIds)
    assert.deepEqual(leaf.units, root.units)
    assert.equal(leaf.units.find(unit => unit.num === 0).text, sample.paragraphs[0], 'Preserve every character of the long evidence, including PIN_TAIL')
  }
  assert(childTriples.includes('n0>n11:supports') && childTriples.includes('n11>n0:supports'),
    'Keep both directed cross-subset, cross-paragraph remote candidate domains')
  assertCoverage(outcome.result.coverage, 12, 12, 'Completed empty leaves accurately finish coverage')
  return { rootRequestedOnce: true, compactScopeSnapshot: true, completeDirectedDomainAndLongEvidence: true,
    emptyLeavesCompleteCoverage: true, streamFinishMaxTokens: await streamTruncationCase(),
    fastMockIdleRetryActualCap: await streamStallBudgetCases(),
    durableFreshSourceAndTamperGuard: await durableSourceCase(), bounds: await boundedSourceCases(),
    independentReview: await independentReviewCases(), sharedWeaveReviewCap: await sharedReviewCapCase(),
    failedLeafWrite: await dynamicWriteFailureCase(), rejectOutsideScope: await outsideScopeCase(),
    strictNewLimitInputValidation: await recoveryInputValidationCases() }
}

async function waitFor(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ': controlled fixture gate did not open')), 15000)
  })]) } finally { clearTimeout(timer) }
}
async function durableHttpCase() {
  const sample = fixture('http-durable-683', 683, { searched: 612 })
  const base = saveFixture(sample)
  const firstCalls = [], successful = []
  const firstHost = await httpHost({ weaveRelations(args) {
    firstCalls.push(requestRecord(args))
    if (args.outputScope.path === '0') { successful.push(requestIdentity(args)); return { edges: [] } }
    throw truncated()
  } })
  const firstStatus = await terminal(firstHost, (await startRetry(firstHost, sample.documentId, { relationRequestBudget: 3 })).taskId)
  assert.equal(firstStatus.error.code, 'relation_request_budget_exhausted', JSON.stringify(firstStatus))
  assert.equal(firstCalls.length, 3)
  assert.equal(successful.length, 1)
  assert.equal(store.getDocument(sample.documentId).revision, base.revision)
  assertCoverage(store.getDocument(sample.documentId).generation.relationDiscovery, 612, 683, 'Checkpoint leaves are not a whole-root canonical coverage claim')
  const paid = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
  assert(paid, 'Paid successful leaf is durably stored outside transient task state')
  assert(!('graph' in paid.checkpoint) && !('sourceText' in paid.checkpoint), 'Recovery cannot replay a graph/source snapshot over newer canonical data')
  assert.deepEqual(paid.checkpoint.relationWeave.partitions[0].splitPaths.sort(), ['', '1'])
  assert.deepEqual(Object.keys(paid.checkpoint.relationWeave.partitions[0].results), ['0'])
  assert.equal(Object.keys(paid.checkpoint.relationWeave.results).length, 0)
  await firstHost.close()
  await forgedPartialRootHttpCase(sample, base, paid)
  const calls = []
  const freshHost = await httpHost({ weaveRelations(args) {
    assert(!successful.includes(requestIdentity(args)), 'Fresh built Host / real HTTP must not repay the successful durable leaf')
    assert.notEqual(requestIdentity(args), requestIdentity(firstCalls[0]), 'Root split marker is replayed without another root provider call')
    assert.notEqual(requestIdentity(args), requestIdentity(firstCalls[2]), 'Already split missing parent is not identically repaid')
    assert(args.targetIds.every(id => Number(id.slice(1)) >= 612), '683 fixture must never re-search its already committed 612 primary targets')
    calls.push(requestRecord(args)); return { edges: [] }
  } })
  const status = await terminal(freshHost, (await startRetry(freshHost, sample.documentId)).taskId)
  assert.equal(status.status, 'succeeded', JSON.stringify(status))
  const graph = store.getDocument(sample.documentId)
  assertCoverage(graph.generation.relationDiscovery, 683, 683)
  assert.equal(graph.edges.length, 0)
  assert.equal(status.progress.relationRecovery.requests, calls.length, 'Fresh explicit retry receives a reset actual-call budget')
  assert.equal(status.progress.relationRecovery.totalRequests, firstCalls.length + calls.length)
  assert(status.progress.relationRecovery.reusedLeaves >= 1)
  assert.equal(store.loadRelationRetryCheckpoint(sample.documentId, graph.revision), null, 'Atomic canonical commit clears only its matching recovery record')
  await freshHost.close()
  return { initialActualRequests: firstCalls.length, freshMissingRequests: calls.length,
    rejectForgedIncompleteRoot: true, reusedLeaves: status.progress.relationRecovery.reusedLeaves }
}
async function forgedPartialRootHttpCase(sample, base, original) {
  const forged = structuredClone(original.checkpoint)
  const left = forged.relationWeave.partitions[0].results['0'].norm
  const norm = { summary: '', nodes: [], edges: [], warnings: structuredClone(left.warnings) }
  // Use the exact genuine split-root aggregate schema, not a leaf-only ontology
  // field, so missing sibling proof is the only thing that makes it invalid.
  // Both the legacy norm hash and the outer native SQLite checksum are genuine.
  // Only production Host's full partition proof can catch the missing sibling.
  forged.relationWeave.results[0] = { norm, hash: hash(norm) }
  store.saveRelationRetryCheckpoint(forged, { expectedRevision: base.revision, expectedVersion: original.checkpointVersion })
  let modelCalls = 0
  const host = await httpHost({ weaveRelations() { modelCalls++; return { edges: [] } } })
  try {
    const rejected = await terminal(host, (await startRetry(host, sample.documentId)).taskId)
    assert.equal(rejected.error.code, 'checkpoint_invalid', JSON.stringify(rejected))
    assert.equal(modelCalls, 0, 'Authenticating a legacy root hash cannot stand in for complete partition leaf proof')
    assert.equal(store.getDocument(sample.documentId).revision, base.revision)
    assertCoverage(store.getDocument(sample.documentId).generation.relationDiscovery, 612, 683)
  } finally { await host.close() }
  const current = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
  store.saveRelationRetryCheckpoint(original.checkpoint, { expectedRevision: base.revision, expectedVersion: current.checkpointVersion })
}
async function terminalTruncationHttpCases() {
  const outcomes = {}
  for (const mode of ['depth', 'atomic']) {
    const sample = fixture('http-known-truncation-' + mode, mode === 'depth' ? 40 : 2,
      { searched: mode === 'depth' ? 20 : 0 })
    const base = saveFixture(sample)
    const options = { relationRequestBudget: 128, relationSplitDepth: mode === 'depth' ? 0 : 20 }
    const initialCalls = []
    const first = await httpHost({ weaveRelations(args) { initialCalls.push(requestRecord(args)); throw truncated() } })
    const initial = await terminal(first, (await startRetry(first, sample.documentId, options)).taskId)
    assert.equal(initial.error.code, 'output_truncated', JSON.stringify(initial))
    if (mode === 'depth') assert.equal(initialCalls.length, 1)
    else assert.equal(scopeVolume(initialCalls.at(-1).outputScope), 1, 'First task stops immediately at a genuinely indivisible output domain')
    const paid = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
    assert.equal(paid.checkpoint.relationWeave.partitions[0].lastFailure.path, initialCalls.at(-1).outputScope.path)
    await first.close()
    let repaid = 0
    const same = await httpHost({ weaveRelations() { repaid++; throw new Error('Known truncated terminal domain must not be repaid') } })
    const blocked = await terminal(same, (await startRetry(same, sample.documentId, options)).taskId)
    assert.equal(blocked.error.code, 'output_truncated', JSON.stringify(blocked))
    assert.equal(repaid, 0, 'Same canonical revision and split limit must stop before any fresh provider call')
    assert.equal(blocked.progress.relationRecovery.requests, 0)
    assert.equal(store.getDocument(sample.documentId).revision, base.revision)
    assertCoverage(store.getDocument(sample.documentId).generation.relationDiscovery, mode === 'depth' ? 20 : 0, sample.graph.nodes.length)
    await same.close()
    if (mode === 'depth') {
      const raisedCalls = []
      const raised = await httpHost({ weaveRelations(args) {
        assert.notEqual(args.outputScope.path, '', 'Raising max depth splits the known failed root directly, never repays it')
        raisedCalls.push(requestRecord(args)); return { edges: [] }
      } })
      const finished = await terminal(raised, (await startRetry(raised, sample.documentId, { ...options, relationSplitDepth: 1 })).taskId)
      assert.equal(finished.status, 'succeeded', JSON.stringify(finished))
      assert.equal(raisedCalls.length, 2)
      assert.equal(finished.progress.relationRecovery.requests, 2)
      assertCoverage(store.getDocument(sample.documentId).generation.relationDiscovery, 40, 40)
      await raised.close()
    } else {
      const explicitCalls = []
      const explicit = await httpHost({ weaveRelations(args) {
        explicitCalls.push(requestRecord(args))
        assert.equal(args.outputScope.path, initialCalls.at(-1).outputScope.path, 'Explicit retry pays only the known minimum failed leaf, not a parent')
        assert.equal(scopeVolume(args.outputScope), 1)
        return { edges: [] }
      } })
      const forced = await terminal(explicit, (await startRetry(explicit, sample.documentId,
        { ...options, relationRequestBudget: 1, retryTruncatedLeaf: true })).taskId)
      assert.equal(forced.error.code, 'relation_request_budget_exhausted', JSON.stringify(forced))
      assert.equal(explicitCalls.length, 1, 'True must reach the real built HTTP task and acknowledge exactly one new paid minimum-leaf request')
      assert.equal(forced.progress.relationRecovery.requests, 1)
      assert.equal(store.getDocument(sample.documentId).revision, base.revision)
      assertCoverage(store.getDocument(sample.documentId).generation.relationDiscovery, 0, 2)
      assert(store.loadRelationRetryCheckpoint(sample.documentId, base.revision).checkpoint.relationWeave.partitions[0].results[initialCalls.at(-1).outputScope.path])
      await explicit.close()
    }
    outcomes[mode] = { initialActualRequests: initialCalls.length, sameLimitFreshRequests: repaid,
      ...(mode === 'atomic' ? { explicitlyAuthorizedMinimumLeafRequests: 1 } : {}) }
  }
  return outcomes
}
async function pendingAndPaidJournalHttpCase() {
  const sample = fixture('http-pending-with-paid-discovery', 40, { searched: 20 })
  const pending = { fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports', evidence: [{ paragraph: 0, quote: sample.paragraphs[0] }] }
  sample.graph.generation.relationRetrySemanticReview = { version: 1, pending: 1, reviewed: 0, accepted: [], errors: [],
    withheld: [{ edge: pending, verdict: 'pending', reason: 'Synthetic earlier unavailable independent reviewer' }] }
  const base = saveFixture(sample)
  const paidIdentities = []
  let firstReviews = 0
  const first = await httpHost({ weaveRelations(args) {
    paidIdentities.push(requestIdentity(args))
    if (args.outputScope.path === '0') return { edges: [] }
    throw truncated()
  }, reviewRelations(args) { firstReviews++; return supported(args) } })
  const initial = await terminal(first, (await startRetry(first, sample.documentId,
    { continuous: false, relationBatchBudget: 1, relationRequestBudget: 3 })).taskId)
  assert.equal(initial.error.code, 'relation_request_budget_exhausted', JSON.stringify(initial))
  assert.equal(firstReviews, 0)
  assert.equal(store.getDocument(sample.documentId).revision, base.revision)
  assert.equal(store.getDocument(sample.documentId).edges.length, 0)
  assert.equal(store.getDocument(sample.documentId).generation.relationRetrySemanticReview.pending, 1)
  assert.deepEqual(Object.keys(store.loadRelationRetryCheckpoint(sample.documentId, base.revision).checkpoint.relationWeave.partitions[0].results), ['0'])
  await first.close()
  const paid = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
  let forbiddenCalls = 0
  const reviewOnly = await httpHost({ weaveRelations() { forbiddenCalls++; assert.fail('Explicit reviewPendingOnly must not dispatch paid discovery') },
    reviewRelations() { forbiddenCalls++; assert.fail('Explicit reviewPendingOnly must not clear or rebase the incompatible paid discovery journal') } })
  const declined = await startRetry(reviewOnly, sample.documentId, { reviewPendingOnly: true })
  const conflict = declined.taskId ? await terminal(reviewOnly, declined.taskId) : declined
  assert.equal(conflict.error.code, 'checkpoint_conflict', JSON.stringify(conflict))
  assert.equal(forbiddenCalls, 0)
  const preserved = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
  assert.equal(preserved.checkpoint.binding, paid.checkpoint.binding)
  assert.equal(preserved.checkpoint.relationWeave.binding, paid.checkpoint.relationWeave.binding)
  assert.deepEqual(preserved.checkpoint.relationWeave.partitions, paid.checkpoint.relationWeave.partitions)
  assert.equal(store.getDocument(sample.documentId).revision, base.revision)
  assert.equal(store.getDocument(sample.documentId).generation.relationRetrySemanticReview.pending, 1)
  await reviewOnly.close()
  const missingCalls = [], reviewCalls = []
  const fresh = await httpHost({ weaveRelations(args) {
    assert(!paidIdentities.includes(requestIdentity(args)), 'Pending review cannot discard or rebase a pre-existing paid discovery journal')
    missingCalls.push(requestRecord(args)); return { edges: [] }
  }, reviewRelations(args) {
    assert.equal(missingCalls.length, 2, 'Continuous retry must consume the authenticated discovery journal before switching to canonical pending-only review')
    reviewCalls.push(args.candidates.map(item => key(item.edge)))
    return supported(args)
  } })
  const status = await terminal(fresh, (await startRetry(fresh, sample.documentId)).taskId)
  assert.equal(status.status, 'succeeded', JSON.stringify(status))
  assert.equal(missingCalls.length, 2)
  assert.deepEqual(reviewCalls, [[key(pending)]])
  const final = store.getDocument(sample.documentId)
  assertCoverage(final.generation.relationDiscovery, 40, 40)
  assert.deepEqual(final.edges.map(key), [key(pending)], 'Original pending edge is admitted only after independent fresh support')
  assert.equal(final.revision, base.revision + 1, 'No premature review-only commit can invalidate the paid discovery binding')
  assert.equal(store.loadRelationRetryCheckpoint(sample.documentId, final.revision), null)
  await fresh.close()
  return true
}

async function durableReviewLeafHttpCase() {
  const sample = fixture('http-paid-review-leaf', 40, { searched: 20 })
  const base = saveFixture(sample)
  const edges = [0, 2, 4].map(index => candidate({ nodes: sample.graph.nodes,
    units: sample.paragraphs.map((text, num) => ({ num, text })) }, 'n' + index, 'n' + (index + 1)).edges[0])
  let weaveCalls = 0
  const firstReviews = []
  const verdicts = args => ({ verdicts: args.candidates.map(item => ({ id: item.id,
    verdict: item.edge.fromNodeId === 'n2' ? 'contradicted' : 'supported',
    reason: 'Independent paid-review durability fixture', evidence: item.edge.evidence })) })
  const first = await httpHost({ weaveRelations() { weaveCalls++; return { edges: structuredClone(edges) } },
    reviewRelations(args) {
      firstReviews.push(args.candidates.map(item => key(item.edge)))
      if (args.candidates.length === 3) throw truncated()
      return verdicts(args)
    } })
  const stopped = await terminal(first, (await startRetry(first, sample.documentId, { relationRequestBudget: 3 })).taskId)
  assert.equal(stopped.error.code, 'relation_request_budget_exhausted', JSON.stringify(stopped))
  assert.equal(weaveCalls, 1)
  assert.deepEqual(firstReviews.map(items => items.length), [3, 2])
  assert.equal(store.getDocument(sample.documentId).revision, base.revision)
  assertCoverage(store.getDocument(sample.documentId).generation.relationDiscovery, 20, 40)
  assert.equal(store.getDocument(sample.documentId).edges.length, 0, 'Even supported paid review leaves cannot commit before missing reviewer scopes finish')
  assert(store.loadRelationRetryCheckpoint(sample.documentId, base.revision))
  await first.close()
  const missingReviews = []
  const fresh = await httpHost({ weaveRelations() { assert.fail('Complete paid discovery root must replay free') },
    reviewRelations(args) {
      missingReviews.push(args.candidates.map(item => key(item.edge)))
      assert.deepEqual(missingReviews.at(-1), [key(edges[2])], 'Only the unpaid review candidate may be sent after fresh Host restart')
      return verdicts(args)
    } })
  const finished = await terminal(fresh, (await startRetry(fresh, sample.documentId)).taskId)
  assert.equal(finished.status, 'succeeded', JSON.stringify(finished))
  assert.equal(missingReviews.length, 1)
  assert.equal(finished.progress.relationRecovery.weaveRequests, 0)
  assert.equal(finished.progress.relationRecovery.reviewRequests, 1)
  const final = store.getDocument(sample.documentId)
  assertCoverage(final.generation.relationDiscovery, 40, 40)
  assert.deepEqual(final.edges.map(key).sort(), [key(edges[0]), key(edges[2])].sort(), 'Fresh review preserves prior supported/contradicted decisions without admitting contradicted candidates')
  assert.equal(store.loadRelationRetryCheckpoint(sample.documentId, final.revision), null)
  await fresh.close()
  return { firstWeaveCalls: weaveCalls, firstReviewCalls: firstReviews.length, freshMissingReviewCalls: missingReviews.length }
}

async function waitUntil(read, label) {
  const deadline = Date.now() + 15000
  for (;;) {
    const value = read()
    if (value) return value
    assert(Date.now() < deadline, label + ': controlled fixture state did not arrive')
    await delay(2)
  }
}
async function budgetDrainPaidInflightHttpCase() {
  const sample = fixture('http-budget-drain-paid-inflight', 137)
  const base = saveFixture(sample)
  const startedB = deferred(), releaseB = deferred()
  const firstCalls = []
  const first = await httpHost({ async weaveRelations(args) {
    firstCalls.push(requestRecord(args))
    assert.equal(args.outputScope.path, '', 'The first task has only two actual provider credits')
    if (args.outputScope.rootGroup === 0) { await startedB.promise; throw truncated() }
    assert.equal(args.outputScope.rootGroup, 1)
    startedB.resolve()
    await releaseB.promise
    return { edges: [] }
  } })
  const started = await startRetry(first, sample.documentId, { relationRequestBudget: 2, concurrency: 2 })
  try {
    await waitFor(startedB.promise, 'Second provider reservation')
    await waitUntil(() => {
      const saved = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
      return saved?.checkpoint.relationWeave?.partitions?.[0]?.splitPaths.includes('') && saved
    }, 'Truncated A split marker before blocked child reservation')
    // HTTP round-trip runs after the marker write and all reservation/catch
    // microtasks. A must have hit its child cap, while B is still paid/in-flight.
    const draining = await first.request('task-status', { taskId: started.taskId }, 'GET')
    assert.equal(draining.status, 'running', 'Budget exhaustion stops new requests, but task cannot terminate before draining its already paid sibling')
    assert.equal(firstCalls.length, 2)
    releaseB.resolve()
    const stopped = await terminal(first, started.taskId)
    assert.equal(stopped.error.code, 'relation_request_budget_exhausted', JSON.stringify(stopped))
    assert.equal(stopped.progress.relationRecovery.requests, 2)
    const paid = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
    assert(paid.checkpoint.relationWeave.partitions[1].results[''], 'Late complete paid sibling must pass the full gates and persist even after a soft budget stop')
    assert(paid.checkpoint.relationWeave.results[1], 'Only the fully completed sibling root is complete in the journal')
    assert.equal(Object.keys(paid.checkpoint.relationWeave.partitions[0].results).length, 0)
    assertCoverage(store.getDocument(sample.documentId).generation.relationDiscovery, 0, 137, 'Budget stop cannot canonical-commit an incomplete batch')
    assert.equal(store.getDocument(sample.documentId).revision, base.revision)
  } finally { releaseB.resolve(); await first.close() }
  const retired = firstCalls.map(requestIdentity)
  const missingCalls = []
  const fresh = await httpHost({ weaveRelations(args) {
    assert(!retired.includes(requestIdentity(args)), 'Fresh Host must neither repay the truncated A parent nor the drained successful B root')
    missingCalls.push(requestRecord(args)); return { edges: [] }
  } })
  const finished = await terminal(fresh, (await startRetry(fresh, sample.documentId)).taskId)
  assert.equal(finished.status, 'succeeded', JSON.stringify(finished))
  assertCoverage(store.getDocument(sample.documentId).generation.relationDiscovery, 137, 137)
  await fresh.close()
  return { initialActualRequests: firstCalls.length, freshMissingRequests: missingCalls.length }
}

async function blockingHttpCase(mode) {
  const sample = fixture('http-' + mode, 40, { searched: 20 })
  const base = saveFixture(sample)
  const entered = deferred(), release = deferred()
  let calls = 0
  const host = await httpHost({ async weaveRelations(args) {
    calls++
    if (args.outputScope.path === '') throw truncated()
    if (args.outputScope.path === '0') return { edges: [] }
    assert.equal(args.outputScope.path, '1')
    entered.resolve()
    await release.promise
    return { edges: [] }
  } })
  const started = await startRetry(host, sample.documentId)
  try {
    await waitFor(entered.promise, mode)
    assert.equal(calls, 3)
    const before = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
    assert(before)
    assert.deepEqual(Object.keys(before.checkpoint.relationWeave.partitions[0].results), ['0'])
    let expectedCode, edit, externalVersion
    if (mode === 'cancel') {
      const cancelled = await host.request('task-cancel', { taskId: started.taskId })
      assert.equal(cancelled.status, 'cancelling')
      expectedCode = 'cancelled'
    } else if (mode === 'revision-cas') {
      edit = store.getDocument(sample.documentId)
      edit.nodes[0].text += ' [synthetic user edit preserved]'
      store.saveGraph(edit, { sourceText: sample.text, expectedRevision: base.revision })
      expectedCode = 'revision_conflict'
    } else {
      assert.equal(mode, 'checkpoint-cas')
      const checkpoint = { ...before.checkpoint, ownerMarker: 'synthetic independent checkpoint writer' }
      externalVersion = store.saveRelationRetryCheckpoint(checkpoint,
        { expectedRevision: base.revision, expectedVersion: before.checkpointVersion }).checkpointVersion
      expectedCode = 'checkpoint_conflict'
    }
    release.resolve()
    const status = await terminal(host, started.taskId)
    assert.equal(status.status, mode === 'cancel' ? 'cancelled' : 'failed', JSON.stringify(status))
    assert.equal(status.error.code, expectedCode, JSON.stringify(status))
    const after = store.getDocument(sample.documentId)
    assertCoverage(after.generation.relationDiscovery, 20, 40, 'In-flight leaf cannot advance committed coverage after cancel/CAS')
    assert.equal(after.edges.length, 0)
    if (mode === 'revision-cas') {
      assert.equal(after.revision, base.revision + 1)
      assert.equal(after.nodes[0].text, edit.nodes[0].text, 'Old task cannot overwrite user edits')
      assert.equal(store.loadRelationRetryCheckpoint(sample.documentId, after.revision), null, 'Stale base cursor is not actionable after an edit')
    } else {
      assert.equal(after.revision, base.revision)
      const saved = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
      assert.deepEqual(Object.keys(saved.checkpoint.relationWeave.partitions[0].results), ['0'])
      if (mode === 'checkpoint-cas') {
        assert.equal(saved.checkpointVersion, externalVersion)
        assert.equal(saved.checkpoint.ownerMarker, 'synthetic independent checkpoint writer', 'Old task cannot overwrite a concurrent checkpoint writer')
      }
    }
    return expectedCode
  } finally { release.resolve(); await host.close() }
}
async function actualSqliteWriteFailures() {
  const outcomes = {}
  for (const kind of ['leaf', 'canonical']) {
    const sample = fixture('http-write-fail-' + kind, 40, { searched: 20 })
    const base = saveFixture(sample)
    const trigger = 'synthetic_relation_' + kind + '_write_fail'
    const table = kind === 'leaf' ? 'relation_retry_checkpoints' : 'documents'
    const guard = kind === 'leaf' ? ` AND instr(NEW.checkpoint_json, '"norm"') > 0` : ''
    // A real SQLite trigger on this owned temp DB catches writes from the built
    // Host's separate connection. Patching the source Store prototype would NOT.
    store.db.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table}
      WHEN NEW.document_id = '${sample.documentId}'${guard}
      BEGIN SELECT RAISE(ABORT, 'Synthetic ${kind} disk failure'); END`)
    let calls = 0
    const host = await httpHost({ weaveRelations(args) {
      calls++; if (kind === 'leaf' && args.outputScope.path === '') throw truncated()
      return { edges: [] }
    } })
    try {
      const status = await terminal(host, (await startRetry(host, sample.documentId)).taskId)
      assert.equal(status.error.code, 'persistence_failed', JSON.stringify(status))
      const after = store.getDocument(sample.documentId)
      assert.equal(after.revision, base.revision)
      assertCoverage(after.generation.relationDiscovery, 20, 40, 'Failed native SQLite transaction cannot advance canonical coverage')
      assert.equal(after.edges.length, 0)
      const checkpoint = store.loadRelationRetryCheckpoint(sample.documentId, base.revision)
      assert(checkpoint, 'Canonical transaction rollback must preserve its durable paid recovery record')
      if (kind === 'leaf') {
        assert.equal(calls, 2)
        assert.equal(Object.keys(checkpoint.checkpoint.relationWeave.partitions[0].results).length, 0, 'Rejected leaf norm was never durable')
      } else {
        assert.equal(calls, 1)
        assert.equal(Object.keys(checkpoint.checkpoint.relationWeave.results).length, 1, 'Entire paid discovery survives canonical commit failure')
      }
    } finally { store.db.exec(`DROP TRIGGER ${trigger}`); await host.close() }
    let freshCalls = 0
    const fresh = await httpHost({ weaveRelations(args) {
      freshCalls++; assert.equal(kind, 'leaf', 'All cached complete discovery must finalize without another provider call')
      assert.notEqual(args.outputScope.path, '', 'Durable root split marker must not be repaid')
      return { edges: [] }
    } })
    const resumed = await terminal(fresh, (await startRetry(fresh, sample.documentId)).taskId)
    assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed))
    const final = store.getDocument(sample.documentId)
    assertCoverage(final.generation.relationDiscovery, 40, 40)
    assert.equal(freshCalls, kind === 'leaf' ? 2 : 0)
    assert.equal(store.loadRelationRetryCheckpoint(sample.documentId, final.revision), null)
    await fresh.close()
    outcomes[kind] = { failedActualRequests: calls, freshMissingRequests: freshCalls }
  }
  return outcomes
}

async function builtCases() {
  const sample = fixture('http-683', 683, { searched: 612 })
  saveFixture(sample)
  const requests = []
  const host = await httpHost({ async weaveRelations(args) { requests.push(requestRecord(args)); return { edges: [] } } })
  const status = await terminal(host, (await startRetry(host, sample.documentId)).taskId)
  assert.equal(status.status, 'succeeded', JSON.stringify(status))
  const graph = store.getDocument(sample.documentId)
  assertCoverage(graph.generation.relationDiscovery, 683, 683, 'Existing committed 612/683 cursor remains intact')
  const searched = requests.flatMap(request => request.targetIds)
  assert.equal(searched.length, 71)
  assert.equal(new Set(searched).size, 71)
  assert(searched.every(id => Number(id.slice(1)) >= 612), 'Previously committed targets must not be searched again')
  const remote = requests.find(request => request.targetIds.includes('n640'))
  assert(remote?.nodes.includes('n20'), 'The real large-graph planner must retain distant previously searched n20 as context for new target n640')
  assert.equal(remote.units.find(unit => unit.num === 20)?.text, sample.paragraphs[20])
  assert(remote.prompt.includes(sample.paragraphs[20]), 'Remote genuine paragraph appears in the actual model-visible prompt, not merely auxiliary units')
  assert(remote.outputScope.fromNodeIds.includes('n20') && remote.outputScope.toNodeIds.includes('n640'))
  assert(remote.outputScope.fromNodeIds.includes('n640') && remote.outputScope.toNodeIds.includes('n20'))
  await host.close()
  return { actualLoopbackHttp: true, previouslyCommitted612NotSearched: true, synthetic683Remaining71: true,
    freshHttpMissingLeafOnly: await durableHttpCase(), knownTerminalFreshGuard: await terminalTruncationHttpCases(),
    pendingWithPaidDiscoveryPriority: await pendingAndPaidJournalHttpCase(),
    durableSplitReviewLeaf: await durableReviewLeafHttpCase(), budgetDrainPaidInflight: await budgetDrainPaidInflightHttpCase(), cancellation: await blockingHttpCase('cancel'),
    userRevisionCas: await blockingHttpCase('revision-cas'), checkpointWriterCas: await blockingHttpCase('checkpoint-cas'),
    nativeSqliteWriteFailureAndRecovery: await actualSqliteWriteFailures(),
    strictNewLimitInputValidation: await recoveryInputValidationCases(true) }
}

try {
  const dynamic = await dynamicCases()
  const built = flags.has('--dynamic-only') ? null : await builtCases()
  console.log(JSON.stringify({ ok: true, zeroRealModelCalls: true, temporarySqliteOnly: true,
    legacyCacheCoverageOwner: 'kg-relation-budget-smoke.mjs', dynamic, built }))
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup()
  store.close()
  if (oldHarness === undefined) delete globalThis.harness; else globalThis.harness = oldHarness
  if (oldDb === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = oldDb
  // Never delete a computed or foreign path: compare against the exclusively
  // created directory's observed realpath and require the fixed basename prefix.
  assert.equal(realpathSync(dir), ownedDirectory)
  assert.equal(resolve(dir), ownedDirectory)
  assert(basename(ownedDirectory).startsWith('kg-relation-truncation-'))
  assert.equal(resolve(db), join(ownedDirectory, 'synthetic.sqlite'))
  rmSync(ownedDirectory, { recursive: true, force: true })
}
