import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import dynamicHost from '../src/index.host.js'
import * as persistentHost from '../lib/index.js'

const sourceText = '样本属于下料。\n\n掌握可能帮助人推测未见情况。'
const marker = '上一次完整候选 JSON（以此为基础做最小修复）：\n'
const initial = {
  summary: 'Learning materials',
  nodes: [
    { id: 'material', type: 'positive_example', text: '样本属于下料', quote: '样本属于下料', paragraph: 0, stage: 'data', entailmentStatus: 'verified', hidden: 'discard' },
    { id: 'meaning', type: 'intension_description', text: '掌握帮助人推测未见情况', quote: '掌握可能帮助人推测未见情况', paragraph: 1, relKind: 'basic' },
  ],
  edges: [{ fromNodeId: 'material', toNodeId: 'meaning', relation: 'exemplifies', role: 'input', mode: 'contrast', evidence: [{ paragraph: 0, quote: '样本属于下料' }] }],
}
const mutations = {
  none() {},
  node_drop(graph) { delete graph.nodes[0].stage },
  node_change(graph) { graph.nodes[0].stage = 'processed' },
  node_add(graph) { graph.nodes[0].relKind = 'basic' },
  edge_drop(graph) { delete graph.edges[0].role },
  edge_change(graph) { graph.edges[0].mode = 'analogy' },
  node_rename(graph) { graph.nodes[0].id = 'replacement'; graph.edges[0].fromNodeId = 'replacement' },
}
const dir = mkdtempSync(join(tmpdir(), 'kg-generation-semantics-'))
const previousDb = process.env.DSH_KG_DB
const previousHarness = globalThis.harness
const cleanups = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function http(api, endpoint, body = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method; req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    Promise.resolve(api(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function wait(request, started) {
  assert(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 2000; i++) {
    const result = await request('task-status', { taskId: started.taskId }, 'GET')
    if (result.status !== 'running') { await delay(5); return result }
    await delay(5)
  }
  throw Error('generation task did not settle')
}

try {
  for (const transport of ['dynamic', 'persistent']) {
    process.env.DSH_KG_DB = join(dir, transport + '.sqlite')
    const calls = [], snapshots = []
    let mode = 'none', neverRepair = false, api
    const extractor = async ({ attempt, prompt }) => {
      calls.push({ attempt, prompt })
      if (attempt === 0) return structuredClone(initial)
      assert(prompt.includes(marker), 'a targeted repair must receive its complete prior candidate')
      const graph = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      snapshots.push(structuredClone(graph))
      graph.nodes.find(node => node.id === 'meaning').text = graph.nodes.find(node => node.id === 'meaning').quote
      if (attempt === 1 || neverRepair) mutations[mode](graph)
      return graph
    }
    const handlers = new Map()
    globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
    const ctx = {
      get(name) {
        if (name === 'kgExtractor') return extractor
        if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') api = route.handler; return () => {} } }
        return null
      },
      effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup },
      interval() { return () => {} },
    }
    if (transport === 'dynamic') dynamicHost().apply(ctx)
    else persistentHost.apply(ctx)
    const request = transport === 'dynamic' ? (name, body) => handlers.get(name)(body) : (name, body, method) => http(api, name, body, method)
    for (mode of Object.keys(mutations)) {
      calls.length = 0; snapshots.length = 0
      const done = await wait(request, await request('extract', { text: sourceText, ontology: 'learning-view-v1' }))
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error))
      assert.equal(snapshots[0].nodes[0].stage, 'data', 'repair prompt must not strip unaffected node attributes')
      assert.equal(snapshots[0].nodes[1].relKind, 'basic')
      assert.equal(snapshots[0].edges[0].role, 'input', 'repair prompt must not strip unaffected relation attributes')
      assert.equal(snapshots[0].edges[0].mode, 'contrast')
      assert.equal(snapshots[0].nodes[0].entailmentStatus, undefined, 'the repair snapshot is proposer data, not host approval')
      assert.equal(snapshots[0].nodes[0].hidden, undefined)
      assert.equal(done.result.nodes.find(node => node.id === 'material')?.stage, 'data', transport + ': ' + mode)
      assert.equal(done.result.nodes.find(node => node.id === 'meaning').relKind, 'basic')
      assert.equal(done.result.edges[0].role, 'input')
      assert.equal(done.result.edges[0].mode, 'contrast')
      assert.equal(calls.length, mode === 'none' ? 2 : 3, 'a lossy repair must be corrected within the existing retry budget')
      if (mode !== 'none') assert(calls[2].prompt.includes('repair_semantic_attributes_changed'))
      assert.equal(done.result.generation.invariantErrors, 0)
      assert(done.result.nodes.every(node => node.entailmentStatus === 'unverified'), 'preserved metadata is not independent semantic approval')
    }
    mode = 'node_drop'; neverRepair = true; calls.length = 0
    const rejected = await wait(request, await request('extract', { text: sourceText, ontology: 'learning-view-v1' }))
    assert.equal(rejected.status, 'failed', 'repeated semantic loss must not become a successful fallback')
    assert.equal(rejected.error.code, 'invariant_violation')
    assert(rejected.error.message.includes('repair_semantic_attributes_changed'))
    assert.equal(calls.length, 3, 'retries must remain bounded')
    assert.equal(rejected.result, undefined)
  }
  console.log(JSON.stringify({ ok: true, dynamicAndPersistent: true, fullRepairSnapshot: true, semanticLossRejected: true, boundedRetry: true }))
} finally {
  for (const cleanup of cleanups.reverse()) cleanup()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  globalThis.harness = previousHarness
  rmSync(dir, { recursive: true, force: true })
}
