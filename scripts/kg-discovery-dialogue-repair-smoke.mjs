import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'
import { fingerprintDiscoveryGold, inspectDiscoveryCapture } from './kg-discovery-benchmark.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-gold-zh-v5.json', import.meta.url), 'utf8'))
const capture = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null
if (capture) assert.equal(capture.goldHash, fingerprintDiscoveryGold(gold))
const issue = capture ? inspectDiscoveryCapture(gold, capture).issues.find(item =>
  item.targetKind === 'node' && item.targetId === 'n1') : null
if (capture) assert(issue, 'saved Flash report must contain the frozen hypothetical-status issue')
const fix = issue?.proposedFix || { action: 'update_node', nodePatch: { id: 'n1', patch: {
  type: 'claim', text: '教师猜测先展示答案再让学生作答可能减少错误，但没有安排乙方案，也没有测量这种顺序下的错误数',
  quote: '我猜可能减少错误，但没有安排乙方案，也没有测量这种顺序下的错误数', paragraph: 1 } } }
assert.equal(fix.action, 'update_node')
assert.equal(fix.nodePatch.id, 'n1')
const patch = fix.nodePatch.patch
assert.equal(patch.paragraph, 1)
assert(gold.sourceUnits[1].text.includes(patch.quote), 'the proposed quote must be exact source text')
assert.match(patch.text, /猜测|可能/)
assert.match(patch.text, /没有.*测量/)
const semanticNode = node => ({ id: node.id, type: node.type, text: node.text,
  paragraph: node.paragraph, quote: node.quote,
  evidence: node.evidence?.map(ev => ({ paragraph: ev.paragraph, quote: ev.quote })) })

function request(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/dsh-knowledge-graph/' + endpoint
    req.headers = {}
    const res = { body: '', setHeader() {}, writeHead() {},
      end(value) { this.body = value || ''; resolve(JSON.parse(this.body || '{}')) } }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}

const dir = mkdtempSync(join(tmpdir(), 'kg-discovery-dialogue-repair-'))
try {
  process.env.DSH_KG_DB = join(dir, 'graphs.sqlite')
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  const sourceText = gold.sourceUnits.map(unit => unit.text).join('\n\n')
  store.saveGraph(gold.graph, { sourceText, sourceUnits: gold.sourceUnits })
  store.close()
  const routes = []
  persistentHost.apply({ get(name) { return name === 'webServer' ? { register(spec) {
    routes.push(spec)
    return () => {}
  } } : null }, effect(fn) { return fn() }, interval() { return () => {} } })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const documentId = gold.graph.source.documentId
  const before = await request(api, 'document-export', { documentId })
  assert.equal(before.revision, 1)
  const target = before.graph.nodes.find(node => node.id === 'n1')
  assert(target)
  const baseNodeIds = before.graph.nodes.map(node => node.id)
  const commitFor = candidatePatch => ({ documentId, expectedRevision: 1,
    graph: { ...before.graph, nodes: before.graph.nodes.map(node => node.id === 'n1'
      ? { ...node, ...candidatePatch } : node) },
    baseNodeIds, baseEdgeKeys: [] })
  const commit = commitFor(patch)
  const wrongAnchor = commitFor({ ...patch, quote: gold.sourceUnits[0].text })
  assert.notEqual((await request(api, 'graph-commit-preview', wrongAnchor)).valid, true,
    'a quote attached to the wrong source unit must fail preview')

  const falseButAnchored = commitFor({ ...patch, text: '教师猜测先展示答案可能使全部学生不再出错。' })
  const falsePreview = await request(api, 'graph-commit-preview', falseButAnchored)
  assert.equal(falsePreview.valid, true,
    'structural preview cannot prove that a text claim follows from its exact quote: ' + JSON.stringify(falsePreview))
  assert.equal((await request(api, 'document-export', { documentId })).revision, 1,
    'the adversarial semantic counterexample must remain preview-only')

  const preview = await request(api, 'graph-commit-preview', commit)
  assert.equal(preview.valid, true, 'the source-backed rewrite should pass structural preview: ' + JSON.stringify(preview))
  const afterPreview = await request(api, 'document-export', { documentId })
  assert.deepEqual(afterPreview.graph, before.graph, 'preview must not write the graph')
  assert.equal(afterPreview.revision, 1)
  const saved = await request(api, 'graph-commit', commit)
  assert.equal(saved.revision, 2, 'the reviewed rewrite should persist in temporary SQLite: ' + JSON.stringify(saved))
  const after = await request(api, 'document-export', { documentId })
  const loaded = await request(api, 'document-load', { documentId })
  assert.equal(after.revision, 2)
  assert.deepEqual(after.graph.nodes.filter(node => node.id !== 'n1').map(semanticNode),
    before.graph.nodes.filter(node => node.id !== 'n1').map(semanticNode),
    'the repair must not rewrite faithful observations or their source quotes')
  assert(after.graph.nodes.filter(node => node.id !== 'n1').every(node => node.entailmentStatus === 'unverified'),
    'citation authentication must not upgrade other nodes to semantic verification')
  const repaired = after.graph.nodes.find(node => node.id === 'n1')
  assert.equal(repaired.text, patch.text)
  assert.equal(repaired.quote, patch.quote)
  assert.equal(repaired.paragraph, patch.paragraph)
  assert.deepEqual(after.graph.edges, before.graph.edges)
  assert.equal(loaded.sourceText, sourceText)
  assert.equal((await request(api, 'graph-commit-preview', commit)).error?.code, 'revision_conflict')
  assert.equal((await request(api, 'graph-commit', commit)).error?.code, 'revision_conflict')
  console.log(JSON.stringify({ liveProposal: Boolean(capture), wrongSourceRejected: true,
    structuralPreviewNotSemanticProof: true, previewReadOnly: true, onlyTargetPersisted: true,
    stalePreviewAndWriteRejected: true, syntheticOnly: true }))
} finally { rmSync(dir, { recursive: true, force: true }) }
