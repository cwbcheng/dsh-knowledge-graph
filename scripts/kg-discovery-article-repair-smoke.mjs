import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'
import { captureReviewRun } from './kg-review-benchmark.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-followup-gold-zh-v7.json', import.meta.url), 'utf8'))
const approvedDelete = process.argv.includes('--approved-delete')
const capture = !approvedDelete && process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null
if (capture) {
  const run = captureReviewRun(gold, capture)
  assert.equal(run.predictions.length, 1)
  assert.equal(capture.cases[0].taskStatus.result.verdict, 'confirmed')
}
const fix = capture?.cases[0].taskStatus.result.proposedFix || { action: 'update_node', nodePatch: {
  id: 'n1', patch: { text: '按正文亚组数值，合作学习模式g=0.530高于自主学习模式g=0.333，且异质性更低。' } } }
if (approvedDelete) {
  assert.deepEqual(gold.cases[0].gold.allowedFixes, [{ action: 'delete_node', nodePatch: { id: 'n1' } }])
} else {
  assert.equal(fix.action, 'update_node')
  assert.equal(fix.nodePatch.id, 'n1')
  assert.deepEqual(Object.keys(fix.nodePatch.patch), ['text'], 'the real patch must not silently reanchor the citation')
  assert.match(fix.nodePatch.patch.text, /g=0\.530.*g=0\.333/)
}
const original = gold.cases[0].graph.nodes.find(node => node.id === 'n1')
assert.equal(original.paragraph, 0)
assert.deepEqual(original.evidence.map(item => item.paragraph), [0, 1])
assert.deepEqual(gold.cases[0].input.evidence.map(item => item.paragraph), [2, 3])

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

const dir = mkdtempSync(join(tmpdir(), 'kg-discovery-article-repair-'))
try {
  process.env.DSH_KG_DB = join(dir, 'graphs.sqlite')
  const sourceUnits = gold.cases[0].sourceUnits
  const sourceText = sourceUnits.map(unit => unit.text).join('\n\n')
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(gold.cases[0].graph, { sourceText, sourceUnits })
  store.close()
  const routes = []
  persistentHost.apply({ get(name) { return name === 'webServer' ? { register(spec) {
    routes.push(spec); return () => {}
  } } : null }, effect(fn) { return fn() }, interval() { return () => {} } })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const documentId = gold.cases[0].graph.source.documentId
  const before = await request(api, 'document-export', { documentId })
  assert.equal(before.revision, 1)
  const patch = { documentId, expectedRevision: 1,
    graph: { ...before.graph, nodes: approvedDelete
      ? before.graph.nodes.filter(node => node.id !== 'n1')
      : before.graph.nodes.map(node => node.id === 'n1' ? { ...node, ...fix.nodePatch.patch } : node) },
    baseNodeIds: before.graph.nodes.map(node => node.id), baseEdgeKeys: [] }
  const preview = await request(api, 'graph-commit-preview', patch)
  assert.equal(preview.valid, true, JSON.stringify(preview))
  assert.deepEqual((await request(api, 'document-export', { documentId })).graph, before.graph,
    'preview must remain read-only')
  const saved = await request(api, 'graph-commit', patch)
  assert.equal(saved.revision, 2, JSON.stringify(saved))
  const after = await request(api, 'document-export', { documentId })
  const citation = node => ({ paragraph: node.paragraph, quote: node.quote,
    evidence: node.evidence.map(item => ({ paragraph: item.paragraph, quote: item.quote })) })
  if (approvedDelete) {
    assert.equal(after.graph.nodes.some(node => node.id === 'n1'), false)
    assert.deepEqual(after.graph.edges, before.graph.edges)
  } else {
    const storedOriginal = before.graph.nodes.find(node => node.id === 'n1')
    const updated = after.graph.nodes.find(node => node.id === 'n1')
    assert.equal(updated.text, fix.nodePatch.patch.text)
    assert.equal(updated.quote, storedOriginal.quote)
    assert.equal(updated.paragraph, storedOriginal.paragraph)
    assert.deepEqual(citation(updated), citation(storedOriginal))
  }
  assert.deepEqual(after.graph.nodes.filter(node => node.id !== 'n1').map(node => ({ id: node.id, text: node.text, ...citation(node) })),
    before.graph.nodes.filter(node => node.id !== 'n1').map(node => ({ id: node.id, text: node.text, ...citation(node) })))
  assert.equal((await request(api, 'document-load', { documentId })).sourceText, sourceText)
  assert.equal((await request(api, 'graph-commit-preview', patch)).error?.code, 'revision_conflict')
  console.log(JSON.stringify({ exactSavedModelProposal: Boolean(capture), approvedDelete,
    structuralPreviewValid: true, previewReadOnly: true,
    textChangedCitationUnchanged: !approvedDelete, stalePreviewRejected: true,
    temporaryDatabase: true }))
} finally { rmSync(dir, { recursive: true, force: true }) }
