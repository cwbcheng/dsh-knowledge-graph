import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'
import { captureReviewRun } from './kg-review-benchmark.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-gold-zh-v6.json', import.meta.url), 'utf8'))
const capture = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null
const status = capture?.cases?.find(entry => entry.caseId === 'b1:v1')?.taskStatus
if (capture) {
  const reviewGold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-followup-gold-zh-v6.json', import.meta.url), 'utf8'))
  const run = captureReviewRun(reviewGold, capture)
  assert.equal(run.predictions.length, 1)
  assert.equal(status?.status, 'succeeded')
  assert.equal(status.result?.mode, 'issue_review')
  assert.equal(status.result?.reviewedIssueId, 'b1:v1')
  assert.equal(status.result?.verdict, 'confirmed')
}
const fix = status?.result?.proposedFix || { action: 'update_node', nodePatch: { id: 'n1', patch: {
  text: '编辑写道，我们不能把林的经验判断当成已证实结论，也不据此建议所有课堂先展示答案。',
  quote: '我们不能把林的经验判断当成已证实结论，也不据此建议所有课堂先展示答案。',
  paragraph: 2 } } }
assert.equal(fix.action, 'update_node')
assert.equal(fix.nodePatch?.id, 'n1')
assert.equal(fix.nodePatch.patch.paragraph, 2)
assert(gold.sourceUnits[2].text.includes(fix.nodePatch.patch.quote))
assert.match(fix.nodePatch.patch.text, /不能把林的经验判断当成已证实结论/)
const semanticNode = node => ({ id: node.id, type: node.type, text: node.text,
  paragraph: node.paragraph, quote: node.quote,
  evidence: node.evidence?.map(ev => ({ paragraph: ev.paragraph, quote: ev.quote })) })

function request(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/' + endpoint; req.headers = {}
    const res = { body: '', setHeader() {}, writeHead() {}, end(value) {
      this.body = value || ''; resolve(JSON.parse(this.body || '{}')) } }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}

const dir = mkdtempSync(join(tmpdir(), 'kg-discovery-attribution-repair-'))
try {
  process.env.DSH_KG_DB = join(dir, 'graphs.sqlite')
  const sourceText = gold.sourceUnits.map(unit => unit.text).join('\n\n')
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(gold.graph, { sourceText, sourceUnits: gold.sourceUnits })
  store.close()
  const routes = []
  persistentHost.apply({ get(name) { return name === 'webServer' ? { register(spec) {
    routes.push(spec); return () => {}
  } } : null }, effect(fn) { return fn() }, interval() { return () => {} } })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const documentId = gold.graph.source.documentId
  const before = await request(api, 'document-export', { documentId })
  assert.equal(before.revision, 1)
  const baseNodeIds = before.graph.nodes.map(node => node.id)
  const commitFor = patch => ({ documentId, expectedRevision: 1,
    graph: { ...before.graph, nodes: before.graph.nodes.map(node => node.id === 'n1'
      ? { ...node, ...patch } : node) }, baseNodeIds, baseEdgeKeys: [] })
  const commit = commitFor(fix.nodePatch.patch)
  assert.notEqual((await request(api, 'graph-commit-preview', commitFor({
    ...fix.nodePatch.patch, paragraph: 0 }))).valid, true, 'wrong source anchor must fail')
  const preview = await request(api, 'graph-commit-preview', commit)
  assert.equal(preview.valid, true, JSON.stringify(preview))
  assert.deepEqual((await request(api, 'document-export', { documentId })).graph, before.graph)
  const saved = await request(api, 'graph-commit', commit)
  assert.equal(saved.revision, 2, JSON.stringify(saved))
  const after = await request(api, 'document-export', { documentId })
  assert.equal(after.revision, 2)
  assert.deepEqual(after.graph.nodes.filter(node => node.id !== 'n1').map(semanticNode),
    before.graph.nodes.filter(node => node.id !== 'n1').map(semanticNode),
    'faithful speaker attribution and trial recommendation must stay unchanged')
  assert(after.graph.nodes.filter(node => node.id !== 'n1').every(node => node.entailmentStatus === 'unverified'),
    'citation grounding must not be mistaken for semantic verification')
  assert.deepEqual(after.graph.edges, before.graph.edges)
  const repaired = after.graph.nodes.find(node => node.id === 'n1')
  assert.equal(repaired.text, fix.nodePatch.patch.text)
  assert.equal(repaired.quote, fix.nodePatch.patch.quote)
  assert.equal(repaired.paragraph, 2)
  assert.equal((await request(api, 'document-load', { documentId })).sourceText, sourceText)
  assert.equal((await request(api, 'graph-commit-preview', commit)).error?.code, 'revision_conflict')
  assert.equal((await request(api, 'graph-commit', commit)).error?.code, 'revision_conflict')
  console.log(JSON.stringify({ liveProposal: Boolean(capture), wrongAnchorRejected: true,
    previewReadOnly: true, onlyTargetPersisted: true, staleRejected: true, temporaryDatabase: true }))
} finally { rmSync(dir, { recursive: true, force: true }) }
