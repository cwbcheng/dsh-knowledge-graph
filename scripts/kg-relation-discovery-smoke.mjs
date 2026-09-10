import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function weaveRelationsHost('
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `      harness.discoveryTest = { weaveRelationsHost, buildRelationWeaveGroupsHost, graphConnectivityHost, relationEvidenceUnitsHost, finalizeRelationConnectivityHost, attach(task) { activeTask = task } }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
let mode = 'empty', calls = []
const harness = { handle() {} }
globalThis.harness = harness
plugin().apply({ get(name) { return name === 'kgExtractor' ? {
  async weaveRelations(args) {
    calls.push(args)
    assert.ok(args.nodes.length <= 72)
    for (const node of args.nodes) {
      for (const p of [node.paragraph, ...(node.evidence || []).map(e => e.paragraph)]) {
        assert.ok(args.units.some(unit => unit.num === p), 'never present a node without its source paragraph')
      }
    }
    if (mode === 'cancel') { const error = new Error('cancelled'); error.code = 'cancelled'; throw error }
    if (mode === 'fail-first' && args.targetIds.includes('n0')) return { missing: 'edges' }
    return { edges: [] }
  },
} : null }, interval() {} })
const api = harness.discoveryTest
function fixture(count) {
  const paragraphs = Array.from({ length: count }, (_, i) => '独立记录' + i + '，仅描述此项观察。')
  return { paragraphs, graph: { source: { id: 'source-discovery', documentId: 'discovery' }, summary: '', warnings: [],
    nodes: paragraphs.map((text, i) => ({ id: 'n' + i, type: 'claim', text, quote: text, paragraph: i, evidence: [{ paragraph: i, quote: text }] })), edges: [] } }
}
async function weave(f, coverage) {
  const task = { title: 'discovery regression', progress: {}, cancelled: false }
  api.attach(task)
  calls = []
  const acc = { nodes: new Map(f.graph.nodes.map(n => [n.id, n])), edges: structuredClone(f.graph.edges), edgeKeys: new Set(), warnings: [] }
  const result = await api.weaveRelationsHost(task, null, acc, f.paragraphs, { documentId: 'discovery' }, f.paragraphs.join('\n\n'), coverage)
  return { result, acc, task }
}

// Reopen real SQLite between passes. A node's appearance as context is not
// coverage, and a successful search with no edges must still advance.
const dir = mkdtempSync(join(tmpdir(), 'kg-discovery-'))
const previousDb = process.env.DSH_KG_DB
const cleanups = []
let store
try {
  const f = fixture(137), visited = new Set()
  let coverage
  for (let pass = 0; pass < 3; pass++) {
    const { result, acc, task } = await weave(f, coverage)
    assert.ok(result.groups <= 4)
    assert.equal(acc.edges.length, 0, 'connectivity targets must never manufacture edges')
    for (const id of calls.flatMap(call => call.targetIds)) {
      assert.ok(!visited.has(id), 'repeated clicks must not revisit the same initial nodes')
      visited.add(id)
    }
    assert.equal(result.coverage.searchedTargets, visited.size)
    assert.equal(task.progress.discovery.searchedTargets, visited.size)
    f.graph.generation = { relationDiscovery: result.coverage }
    store = await openSqliteStore(join(dir, 'test.sqlite'))
    store.saveGraph(f.graph, { sourceText: f.paragraphs.join('\n\n') })
    store.close()
    store = await openSqliteStore(join(dir, 'test.sqlite'))
    const restored = store.getDocument('discovery')
    coverage = restored.generation.relationDiscovery
    f.graph = restored
    store.close(); store = null
  }
  assert.equal(visited.size, 137, 'tail targets must receive the same search opportunity')
  assert.equal(coverage.remainingTargets, 0)
  const nextPass = await weave(f, coverage)
  assert.equal(nextPass.result.coverage.pass, 2, 'a new search round must be distinguishable from continuation')
  assert.equal(nextPass.result.coverage.searchedTargets, 48)
  const changed = structuredClone(f)
  changed.paragraphs[0] += '新增原文。'
  const reset = await weave(changed, coverage)
  assert.notEqual(reset.result.coverage.signature, coverage.signature)
  assert.equal(reset.result.coverage.pass, 1)

  mode = 'fail-first'
  const failed = await weave(f)
  assert.ok(!failed.result.coverage.completedTargetIds.includes('n0'), 'failed model responses cannot advance coverage')
  assert.equal(failed.result.coverage.searchedTargets, 36)
  mode = 'empty'
  await weave(f, failed.result.coverage)
  assert.ok(calls.some(call => call.targetIds.includes('n0')), 'failed targets remain retryable')
  mode = 'cancel'
  const original = structuredClone(coverage)
  await assert.rejects(weave(f, coverage), error => error.code === 'cancelled')
  assert.equal(calls.length, 1)
  assert.deepEqual(coverage, original, 'a cancelled pass cannot mutate saved coverage')
  mode = 'empty'

  const long = fixture(3)
  long.paragraphs[0] = '正文'.repeat(9000) + '，但上述条件并非总成立。'
  long.graph.nodes[0] = { ...long.graph.nodes[0], text: long.paragraphs[0], quote: long.paragraphs[0], evidence: [{ paragraph: 2, quote: long.paragraphs[2] }] }
  await weave(long)
  const full = calls.find(call => call.nodes.some(node => node.id === 'n0'))
  assert.equal(full.units.find(unit => unit.num === 0).text, long.paragraphs[0], 'do not truncate qualifications at the source tail')
  assert.ok(full.prompt.includes(long.paragraphs[0]), 'do not truncate node semantics either')

  const remote = fixture(80)
  remote.graph.nodes.forEach((node, i) => { node.text = 'unique' + i; node.paragraph = i * 20 })
  remote.graph.nodes[0].text = '独特甲乙丙丁戊己庚辛壬癸 semanticbridgemarker'
  remote.graph.nodes[79].text = 'semanticbridgemarker 另一章节的论述'
  remote.paragraphs = Array.from({ length: 1600 }, (_, i) => '原文段落' + i)
  const plan = api.buildRelationWeaveGroupsHost(remote.graph.nodes, [], api.graphConnectivityHost(remote.graph.nodes, []), remote.paragraphs, null, remote.paragraphs.join('\n\n'))
  assert.ok(plan.groups.find(group => group.targetIds.includes('n0')).nodes.some(node => node.id === 'n79'), 'rare shared terms must retrieve distant components, not just adjacent paragraphs or hubs')
  assert.ok(!plan.coverage.completedTargetIds.length, 'planning is not successful execution')

  const metrics = { before: { edgeCount: 5 }, addedEdges: 2, candidateEdgeKeys: ['a>b:supports', 'a>c:supports'] }
  api.finalizeRelationConnectivityHost(metrics, { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })), edges: [{ fromNodeId: 'a', toNodeId: 'b', relation: 'supports' }, { fromNodeId: 'b', toNodeId: 'c', relation: 'supports' }, { fromNodeId: 'b', toNodeId: 'd', relation: 'supports' }] })
  assert.equal(metrics.proposedEdges, 2)
  assert.equal(metrics.addedEdges, 1, 'rejected candidates are not accepted additions')
  assert.equal(metrics.netEdgeChange, -2)
  const legacy = { before: { edgeCount: 2723 }, addedEdges: 534 }
  api.finalizeRelationConnectivityHost(legacy, { nodes: [], edges: [] })
  assert.equal(legacy.addedEdges, null, 'unknown legacy accepted counts must stay unknown')

  const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const components = client.slice(client.indexOf('      function GenerationProgress('), client.indexOf('      // --------------------------- constants'))
  const h = (tag, props, ...children) => typeof tag === 'function' ? tag(props) : ({ tag, props, children })
  const ui = new Function('h', components + '; return { RelationDiscoveryStatus, GenerationProgress, relationNetChange }')(h)
  const tree = JSON.stringify(ui.GenerationProgress({ progress: { discovery: { totalTargets: 3729, searchedTargets: 48, remainingTargets: 3681 }, requests: [] } }))
  assert.ok(tree.includes('关系检索 48/3729'))
  assert.ok(tree.includes('关系候选检索进度'))
  assert.equal(ui.relationNetChange({ before: { edgeCount: 2723 }, after: { edgeCount: 2758 }, addedEdges: 534 }), 35, 'legacy candidate counts must not be displayed as final additions')

  process.env.DSH_KG_DB = join(dir, 'routes.sqlite')
  const routeFixture = fixture(137)
  store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(routeFixture.graph, { sourceText: routeFixture.paragraphs.join('\n\n') })
  store.close(); store = null
  let release, arrived, waitFirst = true, rejectSameParagraph = false, reviewedSameParagraph = 0
  const reached = new Promise(resolve => { arrived = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  const routeTargets = []
  function createHost() {
    let handler
    host.apply({ get(name) {
      if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
      return name === 'kgExtractor' ? { async weaveRelations(args) {
        routeTargets.push(...args.targetIds)
        if (waitFirst) { waitFirst = false; arrived(); await barrier }
        return { edges: rejectSameParagraph ? [{ fromNodeId: 'left', toNodeId: 'right', relation: 'supports', evidence: [{ paragraph: 0, quote: args.units[0].text }] }] : [] }
      }, async reviewRelations({ candidates, units }) {
        reviewedSameParagraph += candidates.length
        return { verdicts: candidates.map(item => ({ id: item.id, verdict: 'insufficient', reason: 'Same-paragraph co-occurrence is not logical support', evidence: [{ paragraph: 0, quote: units[0].text }] })) }
      } } : null
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
    for (let i = 0; i < 2000; i++) {
      const status = await request(handler, 'task-status', { taskId }, 'GET')
      if (status.status !== 'running') return status
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('persistent task did not settle')
  }
  const firstHost = createHost()
  const started = await request(firstHost, 'relation-retry', { documentId: 'discovery', expectedRevision: 1 })
  assert.ok(started.taskId, JSON.stringify(started))
  await reached
  const pendingStatus = await request(firstHost, 'task-status', { taskId: started.taskId }, 'GET')
  const active = await request(firstHost, 'task-active', {}, 'GET')
  assert.equal(active.busy, true)
  assert.equal(active.task.taskId, started.taskId, 'a fresh client without localStorage must discover the running task')
  assert.equal(active.task.kind, 'relation-retry')
  assert.equal(active.task.progress.discovery.totalTargets, 137)
  assert.ok(!JSON.stringify(active).includes('独立记录'), 'task discovery must not transfer source or graph contents')
  const duplicate = await request(firstHost, 'relation-retry', { documentId: 'discovery', expectedRevision: 1 })
  assert.equal(duplicate.error.code, 'busy')
  assert.equal(duplicate.error.activeTask.taskId, started.taskId)
  assert.ok(duplicate.error.message.includes('关系检索'), 'do not label every busy owner as extraction')
  release()
  assert.equal(pendingStatus.progress.discovery.totalTargets, 137, 'persistent HTTP status must include real search progress, not just render fake progress')
  assert.equal(pendingStatus.progress.discovery.searchedTargets, 0)
  const finished = await terminal(firstHost, started.taskId)
  assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error))
  assert.equal(finished.result.generation.relationDiscovery.searchedTargets, 48)
  const ended = await request(firstHost, 'task-active', { taskId: started.taskId }, 'GET')
  assert.equal(ended.busy, false)
  assert.equal(ended.task, null, 'completed task references must not hold the UI busy')
  assert.equal(ended.trackedTask.status, 'succeeded')
  assert.equal(ended.trackedTask.documentId, 'discovery')
  const secondHost = createHost()
  const resumed = await request(secondHost, 'relation-retry', { documentId: 'discovery', expectedRevision: finished.result.revision })
  assert.ok(resumed.taskId, JSON.stringify(resumed))
  const continued = await terminal(secondHost, resumed.taskId)
  assert.equal(continued.status, 'succeeded', JSON.stringify(continued.error))
  assert.equal(continued.result.generation.relationDiscovery.searchedTargets, 96)
  assert.equal(new Set(routeTargets).size, 96, 'fresh host must continue canonical saved coverage')
  const statements = ['红色物体位于左侧', '蓝色物体位于右侧', '绿色物体位于中央']
  const sameSource = statements.join('。') + '。'
  const sameGraph = { summary: '', warnings: [], source: { id: 'source-same', documentId: 'same-paragraph-discovery' },
    nodes: ['left', 'right', 'center'].map((id, i) => ({ id, type: 'claim', text: statements[i], quote: statements[i], paragraph: 0 })), edges: [] }
  store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(sameGraph, { sourceText: sameSource })
  store.close(); store = null
  rejectSameParagraph = true
  const sameStarted = await request(secondHost, 'relation-retry', { documentId: 'same-paragraph-discovery', expectedRevision: 1 })
  assert.ok(sameStarted.taskId, JSON.stringify(sameStarted))
  const sameResult = await terminal(secondHost, sameStarted.taskId)
  assert.equal(sameResult.status, 'succeeded', JSON.stringify(sameResult.error))
  assert.equal(reviewedSameParagraph, 1, 'even a low-risk same-paragraph proposal needs independent semantic review')
  assert.equal(sameResult.result.edges.length, 0, 'co-occurrence cannot manufacture logical support')
  assert.equal(sameResult.result.generation.connectivity.proposedEdges, 1)
  assert.equal(sameResult.result.generation.connectivity.addedEdges, 0)
  console.log(JSON.stringify({ progressiveCoverage: visited.size, sqliteReload: true, noInventedEdges: true, failedAndCancelledCoverage: true, fullEvidence: true, distantRecall: true, acceptedCounts: true, ui: true }))
} finally {
  for (const cleanup of cleanups.reverse()) cleanup()
  store?.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
