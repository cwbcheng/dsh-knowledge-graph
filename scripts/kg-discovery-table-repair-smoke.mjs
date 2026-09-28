import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'
import { fingerprintDiscoveryGold, inspectDiscoveryCapture } from './kg-discovery-benchmark.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-gold-zh-v4.json', import.meta.url), 'utf8'))
const capture = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null
if (capture) assert.equal(capture.goldHash, fingerprintDiscoveryGold(gold))
const issue = capture ? inspectDiscoveryCapture(gold, capture).issues.find(item => item.targetKind === 'node' && item.targetId === 'n1') : null
const fix = issue?.proposedFix || { action: 'update_node', nodePatch: { id: 'n1', patch: {
  text: '已学过规则组中，策略甲达标人数（8/10）高于策略乙（7/10）。',
  quote: gold.graph.nodes.find(node => node.id === 'n2').quote, paragraph: 3 } } }
assert.equal(fix?.action, 'update_node')
assert.equal(fix.nodePatch.id, 'n1')
const patch = fix.nodePatch.patch
assert.equal(patch.quote, gold.graph.nodes.find(node => node.id === 'n2').quote)
assert.equal(patch.paragraph, gold.graph.nodes.find(node => node.id === 'n2').paragraph)

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

const dir = mkdtempSync(join(tmpdir(), 'kg-table-repair-'))
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
  const peers = await request(api, 'graph-source-peers', { documentId, expectedRevision: 1,
    nodeId: 'n1', patch })
  assert.equal(peers.error, undefined, JSON.stringify(peers.error))
  assert.deepEqual(peers.peerIds, ['n2'], 'full canonical source check must find the table-row peer')
  assert.equal(peers.additionalPeers, 0)
  assert.equal((await request(api, 'graph-source-peers', { documentId, expectedRevision: 0,
    nodeId: 'n1', patch })).error?.code, 'revision_conflict')
  assert.deepEqual((await request(api, 'graph-source-peers', { documentId, expectedRevision: 1,
    nodeId: 'n1', patch: { ...patch, text: before.graph.nodes.find(node => node.id === 'n1').text } })).peerIds, [],
    'unchanged text must not be flagged as a new same-source repair')
  assert.deepEqual((await request(api, 'graph-source-peers', { documentId, expectedRevision: 1,
    nodeId: 'n1', patch: { ...patch, quote: gold.graph.nodes.find(node => node.id === 'n3').quote,
      paragraph: gold.graph.nodes.find(node => node.id === 'n3').paragraph } })).peerIds, ['n3'],
    'the check must follow the proposed row rather than inheriting the n2 warning')
  const proposed = { ...before.graph, nodes: before.graph.nodes.map(node => node.id === 'n1'
    ? { ...node, ...patch } : node) }
  const commit = { documentId, expectedRevision: 1, graph: proposed,
    baseNodeIds: before.graph.nodes.map(node => node.id), baseEdgeKeys: [] }
  const preview = await request(api, 'graph-commit-preview', commit)
  assert.equal(preview.valid, true, 'structural preview may accept a source-backed yet duplicate semantic claim')
  assert.equal(proposed.nodes.find(node => node.id === 'n1').quote, proposed.nodes.find(node => node.id === 'n2').quote)
  assert.equal(proposed.nodes.find(node => node.id === 'n1').paragraph, proposed.nodes.find(node => node.id === 'n2').paragraph)
  const after = await request(api, 'document-export', { documentId })
  assert.equal(after.revision, 1, 'the duplicate counterexample remains preview-only')
  assert.deepEqual(after.graph.nodes, before.graph.nodes)
  console.log(JSON.stringify({ liveProposal: Boolean(capture), sourceBackedProposal: true, existingSameQuoteNode: 'n2',
    structuralPreviewValid: true, noWrite: true, syntheticOnly: true }))
} finally { rmSync(dir, { recursive: true, force: true }) }
