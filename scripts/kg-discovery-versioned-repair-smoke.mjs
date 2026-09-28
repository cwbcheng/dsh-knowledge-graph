import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'
import { inspectDiscoveryCapture } from './kg-discovery-benchmark.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-gold-zh-v8.json', import.meta.url), 'utf8'))
const modelFix = { action: 'update_node', nodePatch: { id: 'n1', patch: {
  type: 'rule', text: '新流程（2024版）规定第一次测验提交后才展示标准答案。',
  quote: '新流程改为第一次测验提交后才展示标准答案。', paragraph: 3,
} } }
if (process.argv[2]) {
  const capture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const checked = inspectDiscoveryCapture(gold, capture)
  assert.equal(checked.issues.length, 1)
  assert.deepEqual(checked.issues[0].proposedFix, modelFix, 'saved model patch differs from this frozen replay')
}
const sourceUnits = gold.sourceUnits
assert(sourceUnits[2].text.includes('对新入学班级生效'))
assert(!sourceUnits[3].text.includes('2024版'))

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

const dir = mkdtempSync(join(tmpdir(), 'kg-discovery-versioned-repair-'))
try {
  process.env.DSH_KG_DB = join(dir, 'graphs.sqlite')
  const sourceText = sourceUnits.map(unit => unit.text).join('\n\n')
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(gold.graph, { sourceText, sourceUnits })
  store.close()
  const routes = []
  persistentHost.apply({ get(name) { return name === 'webServer' ? { register(spec) {
    routes.push(spec); return () => {}
  } } : null }, effect(fn) { return fn() }, interval() { return () => {} } })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const documentId = gold.graph.source.documentId
  const before = await request(api, 'document-export', { documentId })
  assert.equal(before.revision, 1)
  const withNode = (graph, node) => ({ ...graph, nodes: graph.nodes.map(item => item.id === node.id ? node : item) })
  const original = before.graph.nodes.find(node => node.id === 'n1')
  assert.deepEqual(original.evidence.map(item => item.paragraph), [3])
  const modelNode = { ...original, ...modelFix.nodePatch.patch }
  const modelPatch = { documentId, expectedRevision: 1,
    graph: withNode(before.graph, modelNode), baseNodeIds: before.graph.nodes.map(node => node.id), baseEdgeKeys: [] }
  const preview = await request(api, 'graph-commit-preview', modelPatch)
  assert.equal(preview.valid, true, JSON.stringify(preview))
  assert.deepEqual((await request(api, 'document-export', { documentId })).graph, before.graph,
    'preview must not write to the disposable graph')
  assert.equal((await request(api, 'graph-commit', modelPatch)).revision, 2)
  const afterModel = await request(api, 'document-export', { documentId })
  const storedModelNode = afterModel.graph.nodes.find(node => node.id === 'n1')
  assert.equal(storedModelNode.text, modelNode.text)
  assert.equal(storedModelNode.type, 'rule')
  assert.equal(storedModelNode.quote, modelNode.quote)
  assert(storedModelNode.evidence.length >= 1 &&
    storedModelNode.evidence.every(item => item.paragraph === 3),
    'structurally valid model patch still lacks the explicit version-scope citation')

  const scopedEvidence = [
    { paragraph: 2, quote: '2024版自2024年1月1日起对新入学班级生效。' },
    { paragraph: 3, quote: modelNode.quote },
  ]
  const reanchored = { ...storedModelNode, evidence: scopedEvidence }
  const reanchorPatch = { ...modelPatch, expectedRevision: 2,
    graph: withNode(afterModel.graph, reanchored) }
  const wrongQuote = structuredClone(reanchorPatch)
  wrongQuote.graph.nodes.find(node => node.id === 'n1').evidence[0].quote = '2024版适用于全部在读班级'
  assert.equal((await request(api, 'graph-commit-preview', wrongQuote)).error?.code, 'invalid_evidence_quote',
    'invented scope citation must be rejected, not silently dropped')
  assert.equal((await request(api, 'graph-commit', wrongQuote)).error?.code, 'invalid_evidence_quote')
  const wrongPrimary = structuredClone(reanchorPatch)
  wrongPrimary.graph.nodes.find(node => node.id === 'n1').quote = '2024版适用于全部在读班级'
  assert.equal((await request(api, 'graph-commit-preview', wrongPrimary)).error?.code, 'invalid_evidence_quote')
  assert.equal((await request(api, 'graph-commit', wrongPrimary)).error?.code, 'invalid_evidence_quote')
  const malformedEvidence = structuredClone(reanchorPatch)
  malformedEvidence.graph.nodes.find(node => node.id === 'n1').evidence = '2024版适用于全部在读班级'
  assert.equal((await request(api, 'graph-commit-preview', malformedEvidence)).error?.code, 'invalid_evidence_quote',
    'a malformed evidence field must not silently become an empty array')
  assert.equal((await request(api, 'graph-commit', malformedEvidence)).error?.code, 'invalid_evidence_quote')
  assert.equal((await request(api, 'graph-commit-preview', reanchorPatch)).valid, true)
  assert.deepEqual((await request(api, 'document-export', { documentId })).graph, afterModel.graph)
  assert.equal((await request(api, 'graph-commit', reanchorPatch)).revision, 3)
  const after = await request(api, 'document-export', { documentId })
  const finalEvidence = after.graph.nodes.find(node => node.id === 'n1').evidence
  assert.deepEqual(finalEvidence.map(item => ({ paragraph: item.paragraph, quote: item.quote })), scopedEvidence)
  assert(finalEvidence.every(item => item.documentId === documentId && item.sourceId === gold.graph.source.id),
    'new evidence must carry canonical, not caller-controlled, provenance')
  const semanticFields = node => ({ id: node.id, type: node.type, text: node.text,
    paragraph: node.paragraph, quote: node.quote,
    evidence: node.evidence.map(item => ({ paragraph: item.paragraph, quote: item.quote })) })
  assert.deepEqual(after.graph.nodes.filter(node => node.id !== 'n1').map(semanticFields),
    before.graph.nodes.filter(node => node.id !== 'n1').map(semanticFields))
  assert.deepEqual(after.graph.edges, before.graph.edges)
  assert.equal((await request(api, 'document-load', { documentId })).sourceText, sourceText)
  const overflowEvidence = [
    { paragraph: 2, quote: sourceUnits[2].text }, { paragraph: 2, quote: '2024版' },
    { paragraph: 2, quote: '2024年1月1日' }, { paragraph: 2, quote: '新入学班级' },
    { paragraph: 3, quote: sourceUnits[3].text }, { paragraph: 3, quote: '新流程' },
    { paragraph: 3, quote: '第一次测验提交后' }, { paragraph: 3, quote: '标准答案' },
    { paragraph: 3, quote: '提交后' },
  ]
  const overflowPatch = { ...reanchorPatch, expectedRevision: 3,
    graph: withNode(after.graph, { ...after.graph.nodes.find(node => node.id === 'n1'), evidence: overflowEvidence }) }
  const forgedOverflow = structuredClone(overflowPatch)
  forgedOverflow.graph.nodes.find(node => node.id === 'n1').evidence[8].quote = '没有出现在原文的第九项证据'
  assert.equal((await request(api, 'graph-commit-preview', forgedOverflow)).error?.code, 'invalid_evidence_quote')
  assert.equal((await request(api, 'graph-commit-preview', overflowPatch)).error?.code, 'evidence_limit')
  assert.equal((await request(api, 'graph-commit', overflowPatch)).error?.code, 'evidence_limit')
  assert.equal((await request(api, 'document-export', { documentId })).revision, 3)
  assert.equal((await request(api, 'graph-commit-preview', modelPatch)).error?.code, 'revision_conflict')
  const factQuotes = {
    n2: [sourceUnits[6].text, '2024年2月', '新入学', '甲班', '第一次测验', '结束后', '看到', '答案'],
    n3: [sourceUnits[7].text, '仍在读', '乙班', '2023年12月', '入学', '继续', '测验前', '查看答案'],
  }
  const richNodes = after.graph.nodes.map(node => factQuotes[node.id]
    ? { ...node, evidence: factQuotes[node.id].map(quote => ({ paragraph: node.id === 'n2' ? 6 : 7, quote })) }
    : node)
  const richPatch = { documentId, expectedRevision: 3, graph: { ...after.graph, nodes: richNodes },
    baseNodeIds: after.graph.nodes.map(node => node.id), baseEdgeKeys: [] }
  assert.equal((await request(api, 'graph-commit', richPatch)).revision, 4)
  const richGraph = await request(api, 'document-export', { documentId })
  assert(richGraph.graph.nodes.filter(node => factQuotes[node.id]).every(node => node.evidence.length === 8))
  const mergedFact = richGraph.graph.nodes.find(node => node.id === 'n2')
  const mergeOverflow = { documentId, expectedRevision: 4,
    operations: [{ kind: 'merge_node', fromNodeId: 'n3', intoNodeId: 'n2' }],
    graph: { ...richGraph.graph, nodes: richGraph.graph.nodes.filter(node => node.id !== 'n3')
      .map(node => node.id === 'n2' ? mergedFact : node) },
    baseNodeIds: richGraph.graph.nodes.map(node => node.id), baseEdgeKeys: [] }
  assert.equal((await request(api, 'graph-commit-preview', mergeOverflow)).error?.code, 'evidence_limit')
  assert.equal((await request(api, 'graph-commit', mergeOverflow)).error?.code, 'evidence_limit')
  assert.equal((await request(api, 'document-export', { documentId })).revision, 4)
  const edgeOnlyNodes = richGraph.graph.nodes.map(node => factQuotes[node.id]
    ? { ...node, evidence: [node.evidence[0]] } : node)
  const edgeEvidence = id => factQuotes[id].map(quote => ({ paragraph: id === 'n2' ? 6 : 7, quote }))
  const collidingEdges = ['n2', 'n3'].map(id => ({ fromNodeId: id, toNodeId: 'n1', relation: 'supports',
    evidence: edgeEvidence(id) }))
  const edgeSetup = { documentId, expectedRevision: 4,
    graph: { ...richGraph.graph, nodes: edgeOnlyNodes, edges: collidingEdges },
    baseNodeIds: edgeOnlyNodes.map(node => node.id), baseEdgeKeys: [] }
  const edgeSetupResult = await request(api, 'graph-commit', edgeSetup)
  assert.equal(edgeSetupResult.revision, 5, JSON.stringify(edgeSetupResult))
  const edgeRichGraph = await request(api, 'document-export', { documentId })
  assert(edgeRichGraph.graph.edges.length === 2 && edgeRichGraph.graph.edges.every(edge => edge.evidence.length === 8))
  const edgeMerge = { documentId, expectedRevision: 5,
    operations: [{ kind: 'merge_node', fromNodeId: 'n3', intoNodeId: 'n2' }],
    graph: { ...edgeRichGraph.graph,
      nodes: edgeRichGraph.graph.nodes.filter(node => node.id !== 'n3'),
      edges: edgeRichGraph.graph.edges.filter(edge => edge.fromNodeId === 'n2') },
    baseNodeIds: edgeRichGraph.graph.nodes.map(node => node.id),
    baseEdgeKeys: edgeRichGraph.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
  const edgePreview = await request(api, 'graph-commit-preview', edgeMerge)
  assert.equal(edgePreview.error?.code, 'evidence_limit', JSON.stringify(edgePreview))
  assert.equal(edgePreview.error?.targetKind, 'edge')
  assert.equal((await request(api, 'graph-commit', edgeMerge)).error?.code, 'evidence_limit')
  assert.equal((await request(api, 'document-export', { documentId })).revision, 5)
  const clearCollidingEdges = { documentId, expectedRevision: 5,
    graph: { ...edgeRichGraph.graph, edges: [] },
    baseNodeIds: edgeRichGraph.graph.nodes.map(node => node.id),
    baseEdgeKeys: edgeRichGraph.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
  assert.equal((await request(api, 'graph-commit', clearCollidingEdges)).revision, 6)
  const sparseGraph = await request(api, 'document-export', { documentId })
  const sparseMerge = { documentId, expectedRevision: 6,
    operations: [{ kind: 'merge_node', fromNodeId: 'n3', intoNodeId: 'n2' }],
    graph: { ...sparseGraph.graph, nodes: sparseGraph.graph.nodes.filter(node => node.id !== 'n3') },
    baseNodeIds: sparseGraph.graph.nodes.map(node => node.id), baseEdgeKeys: [] }
  assert.equal((await request(api, 'graph-commit-preview', sparseMerge)).error?.code, 'evidence_limit',
    'merge preview must not drop the source citation even when the union is below eight')
  assert.equal((await request(api, 'document-export', { documentId })).revision, 6)
  const sourceEvidence = sparseGraph.graph.nodes.find(node => node.id === 'n3').evidence
  const safeMerge = structuredClone(sparseMerge)
  safeMerge.graph.nodes.find(node => node.id === 'n2').evidence.push(...sourceEvidence)
  assert.equal((await request(api, 'graph-commit-preview', safeMerge)).valid, true,
    'a merge preserving both source citations must remain available')
  assert.equal((await request(api, 'graph-commit', safeMerge)).revision, 7)
  const afterSafeMerge = await request(api, 'document-export', { documentId })
  assert(!afterSafeMerge.graph.nodes.some(node => node.id === 'n3'))
  const persistedMergeEvidence = afterSafeMerge.graph.nodes.find(node => node.id === 'n2').evidence
  const expectedMergeEvidence = safeMerge.graph.nodes.find(node => node.id === 'n2').evidence
  assert.deepEqual(persistedMergeEvidence.map(item => [item.paragraph, item.quote]),
    expectedMergeEvidence.map(item => [item.paragraph, item.quote]),
    'a legal merge must persist both nodes\' full evidence sets')
  console.log(JSON.stringify({ temporaryDatabase: true, modelPreviewValid: true, modelEvidenceMissingP2: true,
    explicitReanchorValid: true, fabricatedCitationRejected: true, previewReadOnly: true, staleRevisionRejected: true }))
} finally { rmSync(dir, { recursive: true, force: true }) }
