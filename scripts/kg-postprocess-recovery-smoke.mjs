import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync('/tmp/kg-postprocess-')
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'test.sqlite')
const cleanups = []
const counts = { extract: 0, weave: 0, review: 0, repair: [], verify: [] }
let rejectSecond = true
let proposalMode = 'valid'
const fixture = [
  ['人们倾向选择相似的符号', '不用相似符号也可以指代'],
  ['书中输入采用数学含义', '有人误解输入是听课'],
]
const source = fixture.map((parts, i) => '# 第' + i + '节\n\n' + parts.join('。但') + '。').join('\n\n')
const extractor = {
  async extractChunk({ chunk }) {
    counts.extract++
    const unit = chunk.units.find(item => item.text.includes('。但'))
    const parts = fixture.find(parts => unit.text.includes(parts[0]))
    return { summary: '记录', nodes: parts.map((text, i) => ({ id: 'n' + i, type: i ? 'counter_example' : 'claim', text, quote: text, paragraph: unit.num })), edges: [{ fromNodeId: 'n1', toNodeId: 'n0', relation: 'counter_example', evidence: [{ paragraph: unit.num, quote: unit.text }] }] }
  },
  async weaveRelations() { counts.weave++; return { edges: [] } },
  async reviewRelations({ candidates, units }) {
    counts.review++
    return { verdicts: candidates.map(item => ({ id: item.id, verdict: 'insufficient', reason: '该描述不反驳目标命题', evidence: [{ paragraph: units[0].num, quote: units[0].text }] })) }
  },
  async repairNodeRole({ node }) {
    counts.repair.push(node.id)
    return { nodeId: node.id, type: 'claim', reason: '保留原句而纠正逻辑角色', evidence: [{ paragraph: node.paragraph, quote: proposalMode === 'fake-evidence' ? '这句话不在原文中' : node.quote }], edges: proposalMode === 'invent-target' ? [{ fromNodeId: node.id, toNodeId: 'invented', relation: 'supports', evidence: [{ paragraph: node.paragraph, quote: node.quote }] }] : [], ...(proposalMode === 'rewrite' ? { text: '被偷偷改写的正文' } : {}) }
  },
  async verifyNodeRoleRepair({ node }) {
    counts.verify.push(node.id)
    return { verdict: rejectSecond && node.text.includes('听课') ? 'insufficient' : 'supported', reason: '独立审校夹具', evidence: [{ paragraph: node.paragraph, quote: node.quote }] }
  },
}
function createHost() {
  let api
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') api = route.handler; return () => {} } }
    return name === 'kgExtractor' ? extractor : null
  }, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  return api
}
function request(api, endpoint, body = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method; req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    const res = { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } }
    Promise.resolve(api(req, res)).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function wait(api, started) {
  assert.ok(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 2000; i++) {
    const status = await request(api, 'task-status', { taskId: started.taskId }, 'GET')
    if (status.status !== 'running') { await new Promise(resolve => setTimeout(resolve, 10)); return status }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('task did not settle')
}
let store
try {
  const api = createHost()
  const started = await request(api, 'extract', { text: source, concurrency: 1 })
  const failed = await wait(api, started)
  assert.equal(failed.error?.code, 'semantic_review_failed', JSON.stringify(failed))
  store = await openSqliteStore(process.env.DSH_KG_DB)
  const saved = store.loadCheckpoint(started.taskId)
  assert.equal(saved.checkpoint.nextBatchIndex, 2)
  assert.equal(Object.keys(saved.checkpoint.postprocess.decisions).length, 2)
  assert.equal(Object.keys(saved.checkpoint.postprocess.repairs).length, 1)
  assert.equal(saved.checkpoint.postprocess.repairFailures.length, 1)
  assert.equal(store.listIncompleteRuns()[0].reviewedRelations, 2)
  assert.equal(store.listDocuments().length, 0, 'failed role repair must not publish an invalid graph')
  const before = structuredClone(counts)
  const injected = await request(api, 'extract', { text: source, checkpoint: saved.checkpoint })
  assert.equal(injected.error?.code, 'checkpoint_invalid', 'client-supplied semantic verdicts must not bypass model review')
  assert.deepEqual(counts, before)
  const bad = structuredClone(saved.checkpoint)
  bad.postprocess.graph.nodes[0].text = 'tampered'
  store.saveCheckpoint(bad, { runId: started.taskId, status: 'failed', sourceText: source })
  const api2 = createHost()
  const corrupt = await wait(api2, await request(api2, 'resume-extract', { runId: started.taskId, retryFailed: true }))
  assert.equal(corrupt.error?.code, 'checkpoint_invalid')
  assert.deepEqual(counts, before, 'corrupt postprocess snapshot must not dispatch model calls')
  store.saveCheckpoint(saved.checkpoint, { runId: started.taskId, status: 'failed', sourceText: source })
  rejectSecond = false
  const resumed = await wait(api2, await request(api2, 'resume-extract', { runId: started.taskId, retryFailed: true }))
  assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed.error))
  assert.equal(counts.extract, before.extract, 'completed extraction must not rerun')
  assert.equal(counts.weave, before.weave, 'completed relation weaving must not rerun')
  assert.equal(counts.review, before.review, 'saved review decisions must not rerun')
  assert.equal(counts.repair.length, before.repair.length + 1, 'only failed role repair should rerun')
  assert.equal(counts.verify.length, before.verify.length + 1, 'accepted repair must reuse its independent verification')
  assert.equal(resumed.result.generation.semanticReview.reused, 2)
  assert.equal(resumed.result.generation.semanticReview.roleRepair.repairs.length, 2)
  assert.ok(resumed.result.nodes.every(node => node.type === 'claim'))
  assert.deepEqual(resumed.result.nodes.map(node => node.text), fixture.flat(), 'role repair must preserve all source propositions')
  assert.equal(resumed.result.edges.length, 0, 'rejected targets must not be resurrected')
  for (const mode of ['rewrite', 'fake-evidence', 'invent-target']) {
    proposalMode = mode
    const invalid = await wait(api2, await request(api2, 'extract', { text: source, concurrency: 1 }))
    assert.equal(invalid.error?.code, 'semantic_review_failed', mode + ' must not be admitted')
    assert.equal(store.listDocuments().length, 1, 'invalid local repairs must not publish or overwrite canonical data')
  }
  console.log(JSON.stringify({ durableReview: true, partialRepairResume: true, noRepeatedExtractionOrWeaving: true, independentVerifier: true, corruptSnapshotRejected: true, sourcePreserved: true }))
} finally {
  if (store) store.close()
  for (const cleanup of cleanups.reverse()) cleanup()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
