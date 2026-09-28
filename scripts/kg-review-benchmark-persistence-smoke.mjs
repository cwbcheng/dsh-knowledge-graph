import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-review-benchmark-codex-v1.json', import.meta.url), 'utf8'))
const chineseGold = JSON.parse(readFileSync(new URL('./fixtures/kg-review-benchmark-zh-v1.json', import.meta.url), 'utf8'))
const approved = [...gold.cases, ...chineseGold.cases].filter(item => item.gold.verdict === 'confirmed' &&
  item.gold.allowedFixes.some(fix => ['update_node', 'update_edge'].includes(fix.action)))
const replayPath = process.argv[2]
const replay = replayPath ? JSON.parse(readFileSync(replayPath, 'utf8')) : null
if (replay) {
  assert.equal(replay.goldHash, '2c47eb753e3e431819ca80ef793290cb7024231e548b2b9ba3d2097ab9a3fb7d')
  assert(Array.isArray(replay.predictions))
}
assert(approved.length > 0)
const semanticNode = node => ({ id: node.id, type: node.type, text: node.text,
  paragraph: node.paragraph, quote: node.quote })
const semanticEdge = edge => ({ fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId,
  relation: edge.relation })

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

const dir = mkdtempSync(join(tmpdir(), 'kg-review-repair-'))
try {
  process.env.DSH_KG_DB = join(dir, 'graphs.sqlite')
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  for (const item of approved) {
    const sourceText = item.sourceUnits.map(unit => unit.text).join('\n\n')
    store.saveGraph({ ...item.graph, source: { id: 'source-' + item.id,
      documentId: 'document-' + item.id, title: item.id,
      paragraphCount: item.sourceUnits.length, ontology: item.graph.ontology || 'proposition-v1' } },
    { sourceText, sourceUnits: item.sourceUnits })
  }
  if (replay) for (const item of gold.cases) {
    const sourceText = item.sourceUnits.map(unit => unit.text).join('\n\n')
    store.saveGraph({ ...item.graph, source: { id: 'replay-source-' + item.id,
      documentId: 'replay-document-' + item.id, title: item.id,
      paragraphCount: item.sourceUnits.length, ontology: item.graph.ontology || 'proposition-v1' } },
    { sourceText, sourceUnits: item.sourceUnits })
  }
  store.close()

  const routes = []
  persistentHost.apply({ get(name) { return name === 'webServer' ? { register(spec) {
    routes.push(spec)
    return () => {}
  } } : null }, effect(fn) { return fn() }, interval() { return () => {} } })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  for (const item of approved) {
    const documentId = 'document-' + item.id
    const before = await request(api, 'document-export', { documentId })
    assert.equal(before.revision, 1)
    const beforeSource = await request(api, 'document-load', { documentId })
    assert.equal(beforeSource.sourceText, item.sourceUnits.map(unit => unit.text).join('\n\n'))
    const fix = item.gold.allowedFixes.find(row => ['update_node', 'update_edge'].includes(row.action))
    const changedNodes = fix.action === 'update_node'
      ? before.graph.nodes.map(node => node.id === fix.nodePatch.id ? { ...node, ...fix.nodePatch.patch } : node)
      : before.graph.nodes
    const changedEdges = fix.action === 'update_edge'
      ? before.graph.edges.map(edge => edge.fromNodeId === fix.edgePatch.fromNodeId &&
        edge.toNodeId === fix.edgePatch.toNodeId && edge.relation === fix.edgePatch.oldRelation
        ? { ...edge, relation: fix.edgePatch.relation, evidence: fix.edgePatch.evidence } : edge)
      : before.graph.edges
    const commit = { documentId, expectedRevision: before.revision,
      graph: { ...before.graph, nodes: changedNodes, edges: changedEdges },
      baseNodeIds: before.graph.nodes.map(node => node.id),
      baseEdgeKeys: before.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
    const preview = await request(api, 'graph-commit-preview', commit)
    assert.equal(preview.valid, true, item.id + ': approved repair failed persistent preview: ' + JSON.stringify(preview))
    const afterPreview = await request(api, 'document-export', { documentId })
    assert.deepEqual(afterPreview.graph.nodes, before.graph.nodes, item.id + ': preview mutated nodes')
    assert.equal(afterPreview.revision, 1, item.id + ': preview mutated revision')
    const saved = await request(api, 'graph-commit', commit)
    assert.equal(saved.revision, 2, item.id + ': approved repair failed commit: ' + JSON.stringify(saved))
    const after = await request(api, 'document-export', { documentId })
    const afterSource = await request(api, 'document-load', { documentId })
    assert.deepEqual(after.graph.nodes.map(semanticNode), changedNodes.map(semanticNode),
      item.id + ': repair changed unexpected node semantics')
    assert.deepEqual(after.graph.edges.map(semanticEdge), changedEdges.map(semanticEdge),
      item.id + ': repair did not persist intended relation semantics')
    const target = fix.action === 'update_node'
      ? after.graph.nodes.find(node => node.id === fix.nodePatch.id)
      : after.graph.edges.find(edge => edge.fromNodeId === fix.edgePatch.fromNodeId &&
        edge.toNodeId === fix.edgePatch.toNodeId && edge.relation === fix.edgePatch.relation)
    assert(target && target.evidence.some(citation =>
      item.sourceUnits.find(unit => unit.paragraph === citation.paragraph)?.text.includes(citation.quote)),
    item.id + ': persisted repair lacks a source-backed citation: ' + JSON.stringify(target))
    assert.equal(afterSource.sourceText, beforeSource.sourceText, item.id + ': repair changed source text')
    const stale = await request(api, 'graph-commit-preview', commit)
    assert.equal(stale?.error?.code, 'revision_conflict', item.id + ': stale repair preview must be fenced')
  }
  if (replay) {
    const cases = new Map(gold.cases.map(item => [item.id, item]))
    const outcomes = []
    for (const prediction of replay.predictions) {
      const item = cases.get(prediction.caseId)
      assert(item, 'run refers to an unknown case: ' + prediction.caseId)
      const fix = prediction.proposedFix || { action: 'none' }
      if (fix.action === 'none') continue
      assert(['update_node', 'update_edge'].includes(fix.action), 'replay does not support ' + fix.action)
      const documentId = 'replay-document-' + item.id
      const before = await request(api, 'document-export', { documentId })
      const nextNodes = fix.action === 'update_node'
        ? before.graph.nodes.map(node => node.id === fix.nodePatch.id ? { ...node, ...fix.nodePatch.patch } : node)
        : before.graph.nodes
      const nextEdges = fix.action === 'update_edge'
        ? before.graph.edges.map(edge => edge.fromNodeId === fix.edgePatch.fromNodeId &&
          edge.toNodeId === fix.edgePatch.toNodeId && edge.relation === fix.edgePatch.oldRelation
          ? { ...edge, relation: fix.edgePatch.relation, evidence: fix.edgePatch.evidence } : edge)
        : before.graph.edges
      const commit = { documentId, expectedRevision: before.revision,
        graph: { ...before.graph, nodes: nextNodes, edges: nextEdges },
        baseNodeIds: before.graph.nodes.map(node => node.id),
        baseEdgeKeys: before.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
      const preview = await request(api, 'graph-commit-preview', commit)
      const saved = preview.valid ? await request(api, 'graph-commit', commit) : null
      const after = await request(api, 'document-export', { documentId })
      const text = fix.nodePatch?.patch?.text
      const quote = after.graph.nodes.find(node => node.id === fix.nodePatch?.id)?.quote
      outcomes.push({ caseId: item.id, action: fix.action, previewValid: preview.valid === true,
        persisted: saved?.revision === 2 && after.revision === 2,
        textExtractedFromRetainedQuote: typeof text === 'string' ? quote.includes(text) : null,
        error: preview.error?.code || saved?.error?.code || null })
    }
    console.log(JSON.stringify({ replayModel: replay.model, outcomes }))
  }
  console.log(JSON.stringify({ approvedRepairsPersisted: approved.length, relationRepair: true, previewReadOnly: true,
    revisionFence: true, syntheticOnly: true }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
