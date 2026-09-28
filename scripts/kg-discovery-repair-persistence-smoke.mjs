import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'
import { fingerprintDiscoveryGold, inspectDiscoveryCapture } from './kg-discovery-benchmark.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-gold-zh-v3.json', import.meta.url), 'utf8'))
const capturePath = process.argv[2]
const capture = capturePath ? JSON.parse(readFileSync(capturePath, 'utf8')) : null
const fix = capture ? (() => {
  assert.equal(capture.goldHash, fingerprintDiscoveryGold(gold))
  const { issues } = inspectDiscoveryCapture(gold, capture)
  const issue = issues.find(item => item.targetKind === 'edge' && item.targetId === 'n1>n2' &&
    item.targetRelation === 'is_a')
  assert(issue, 'live report lacks the frozen homonym edge finding')
  return issue.proposedFix
})() : { action: 'update_edge', edgePatch: { fromNodeId: 'n1', toNodeId: 'n2',
  oldRelation: 'is_a', relation: 'not_is', evidence: gold.graph.edges[0].evidence } }
assert.equal(fix?.action, 'update_edge')
assert.equal(fix.edgePatch.fromNodeId, 'n1')
assert.equal(fix.edgePatch.toNodeId, 'n2')
assert.equal(fix.edgePatch.oldRelation, 'is_a')
assert.equal(fix.edgePatch.relation, 'not_is')
assert(fix.edgePatch.evidence?.some(ev => gold.sourceUnits[ev.paragraph]?.text.includes(ev.quote)),
  'the proposed relation must have a retained source quote')
const semanticNode = node => ({ id: node.id, type: node.type, text: node.text,
  paragraph: node.paragraph, quote: node.quote,
  evidence: node.evidence?.map(ev => ({ paragraph: ev.paragraph, quote: ev.quote })) })
const semanticEvidence = evidence => evidence?.map(ev => ({ paragraph: ev.paragraph, quote: ev.quote }))

function request(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/dsh-knowledge-graph/' + endpoint
    req.headers = {}
    const res = { status: 0, body: '', setHeader() {},
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve(JSON.parse(this.body || '{}')) } }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}

const dir = mkdtempSync(join(tmpdir(), 'kg-discovery-repair-'))
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
  const oldEdge = before.graph.edges.find(edge => edge.fromNodeId === 'n1' && edge.toNodeId === 'n2' && edge.relation === 'is_a')
  assert(oldEdge)
  const commit = { documentId, expectedRevision: 1,
    graph: { ...before.graph, edges: before.graph.edges.map(edge => edge === oldEdge
      ? { ...edge, relation: fix.edgePatch.relation, evidence: fix.edgePatch.evidence } : edge) },
    baseNodeIds: before.graph.nodes.map(node => node.id),
    baseEdgeKeys: before.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }

  const wrongQuote = structuredClone(commit)
  wrongQuote.graph.edges[0].evidence = [{ paragraph: 2, quote: gold.sourceUnits[0].text }]
  const rejectedQuote = await request(api, 'graph-commit-preview', wrongQuote)
  assert.notEqual(rejectedQuote.valid, true, 'source-mismatched relation evidence must not receive a valid preview')
  const wrongType = structuredClone(commit)
  wrongType.graph.edges[0].relation = 'unregistered_relation'
  const rejectedType = await request(api, 'graph-commit-preview', wrongType)
  assert.notEqual(rejectedType.valid, true, 'an unregistered relation must not receive a valid preview')

  const preview = await request(api, 'graph-commit-preview', commit)
  assert.equal(preview.valid, true, 'source-backed not_is relation should pass preview: ' + JSON.stringify(preview))
  const afterPreview = await request(api, 'document-export', { documentId })
  assert.equal(afterPreview.revision, 1)
  assert.deepEqual(afterPreview.graph.edges, before.graph.edges, 'preview must not alter persisted edges')
  const saved = await request(api, 'graph-commit', commit)
  assert.equal(saved.revision, 2, 'the reviewed relation should persist: ' + JSON.stringify(saved))
  const after = await request(api, 'document-export', { documentId })
  const loaded = await request(api, 'document-load', { documentId })
  assert.equal(after.revision, 2)
  assert.equal(after.graph.edges.length, before.graph.edges.length)
  assert.equal(after.graph.edges[0].relation, 'not_is')
  assert.deepEqual(after.graph.nodes.map(semanticNode), before.graph.nodes.map(semanticNode),
    'relation repair must not rewrite node text, types or citations')
  assert(after.graph.nodes.every(node => node.entailmentStatus === 'unverified'),
    'structural citation authentication must not claim semantic verification of other nodes')
  assert.deepEqual(semanticEvidence(after.graph.edges[0].evidence), semanticEvidence(fix.edgePatch.evidence))
  assert.equal(loaded.sourceText, sourceText, 'relation repair must not rewrite source')
  const semanticReversal = { documentId, expectedRevision: 2,
    graph: { ...after.graph, edges: after.graph.edges.map(edge => ({ ...edge, relation: 'is_a' })) },
    baseNodeIds: after.graph.nodes.map(node => node.id),
    baseEdgeKeys: after.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
  const structurallyValidButFalse = await request(api, 'graph-commit-preview', semanticReversal)
  assert.equal(structurallyValidButFalse.valid, true,
    'exactly anchored evidence can pass structural preview while contradicting is_a semantics')
  assert.equal((await request(api, 'document-export', { documentId })).revision, 2,
    'the semantic counterexample must remain preview-only')
  const stale = await request(api, 'graph-commit-preview', commit)
  assert.equal(stale?.error?.code, 'revision_conflict', 'a stale preview must be fenced')
  const staleCommit = await request(api, 'graph-commit', commit)
  assert.equal(staleCommit?.error?.code, 'revision_conflict', 'a stale write must be fenced')
  console.log(JSON.stringify({ liveProposal: Boolean(capture), sourceRejected: true, typeRejected: true,
    previewReadOnly: true, relationPersisted: true, structuralPreviewNotSemanticProof: true,
    stalePreviewAndWriteRejected: true, syntheticOnly: true }))
} finally { rmSync(dir, { recursive: true, force: true }) }
