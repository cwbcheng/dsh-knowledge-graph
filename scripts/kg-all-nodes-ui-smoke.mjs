import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const from = (startMarker, endMarker) => {
  const start = client.indexOf(startMarker)
  const end = client.indexOf(endMarker, start)
  assert(start >= 0 && end > start, `missing client code: ${startMarker}`)
  return client.slice(start, end)
}
const helpers = from('      function asAllNodesGraph(graph) {', '      function historyMetadata(entry) {')
const { asAllNodesGraph, graphCommitViewPatch } = new Function(`${helpers}; return { asAllNodesGraph, graphCommitViewPatch }`)()
const nodes = Array.from({ length: 5001 }, (_, index) => ({ id: 'n' + index, type: 'concept', text: 'Node ' + index }))
const canonical = { nodes, edges: [{ fromNodeId: 'n0', toNodeId: 'n5000', relation: 'supports' }],
  graphOntology: { id: 'proposition-v1' }, revision: 4, source: { documentId: 'document-test', revision: 4 } }
const windowGraph = { nodes: nodes.slice(0, 800), edges: [], source: { documentId: 'document-test' },
  graphOntology: { id: 'learning-view-v1' }, view: { kind: 'window', nodeLimit: 800, totalNodes: nodes.length, nodeOffset: 0 } }
const actions = from('         const openAllNodes = async (refresh = false) => {', '         const resumeLostTask = ')
const createActions = new Function('resultView', 'allNodesLoading', 'graphWindowLoading', 'documentIdOfGraph',
  'setError', 'setAllNodesLoading', 'graphCommitQueueRef', 'graphRevisionRef', 'currentResultRef', 'host', 'setChapterFilter',
  'setSelectedNodeId', 'setSelectedEdgeId', 'setActivePara', 'setFocusReq', 'setGraphPageDraft',
  'setGraphQueryDraft', 'changeLayoutMode', 'setResultView', 'makeView', 'asAllNodesGraph',
  `${actions}; return { openAllNodes }`)
const opened = [], errors = [], requests = [], layouts = []
const fixture = (revision, reply = { documentId: 'document-test', revision: 4, graph: canonical }) => {
  const view = { graph: windowGraph, sourceText: 'Original source' }
  const ref = { current: view }
  const revisionRef = { current: revision }
  const actions = createActions(view, false, false, graph => graph.source.documentId,
    value => errors.push(value), () => {}, { current: Promise.resolve() }, revisionRef, ref,
    { call: async (method, body) => { requests.push({ method, body }); return reply } },
    () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
    mode => layouts.push(mode), next => opened.push(next), (graph, sourceText) => ({ graph, sourceText }), asAllNodesGraph)
  return { ...actions, ref, revisionRef }
}

await fixture(4).openAllNodes()
assert.equal(requests.at(-1).method, 'document-export')
assert.equal(opened.at(-1).graph.nodes.length, 5001, 'the complete working graph cannot inherit the 2000-node cap')
assert.equal(opened.at(-1).graph.edges.length, 1, 'cross-window relations must remain available')
assert.equal(opened.at(-1).graph.view.kind, 'all', 'the complete graph must replace the editable resultView')
assert.equal(opened.at(-1).graph.graphOntology.id, 'learning-view-v1', 'source and node labels keep the workbench ontology')
assert.equal(opened.at(-1).sourceText, 'Original source')
assert.equal(layouts.at(-1), 'overview', 'the large graph starts in the performant overview layout')
const openedBeforeConflict = opened.length
await fixture(3).openAllNodes()
assert.equal(opened.length, openedBeforeConflict, 'a stale export cannot replace the working graph')
assert.match(errors.at(-1).message, /版本已更新/)
const refreshed = fixture(3, { documentId: 'document-test', revision: 5, graph: canonical })
await refreshed.openAllNodes(true)
assert.equal(opened.at(-1).graph.view.kind, 'all', 'refresh keeps the complete view open')
assert.equal(refreshed.revisionRef.current, 5, 'read-only refresh accepts the latest durable revision')
const openedBeforeRace = opened.length
let releaseExport
const racing = fixture(4, new Promise(resolve => { releaseExport = resolve }))
const pending = racing.openAllNodes()
await Promise.resolve()
await Promise.resolve()
racing.ref.current = { graph: { ...windowGraph, source: { documentId: 'other-document' } } }
releaseExport({ documentId: 'document-test', revision: 4, graph: canonical })
await pending
assert.equal(opened.length, openedBeforeRace, 'a late export must not replace another selected document')
assert.match(errors.at(-1).message, /视图已变化/)

const baseline = asAllNodesGraph(canonical)
const next = { ...baseline,
  nodes: [...nodes.slice(0, 4001), { ...nodes[4001], text: 'Revised' }, ...nodes.slice(4002), { id: 'new', text: 'New' }],
  edges: [{ fromNodeId: 'n4001', toNodeId: 'new', relation: 'supports' }] }
const patch = graphCommitViewPatch(next, baseline)
assert.deepEqual(patch.nodes.map(node => node.id), ['n4001', 'new'])
assert.deepEqual(patch.baseNodeIds, ['n4001'])
assert.deepEqual(patch.baseEdgeKeys, ['n0>n5000:supports'])
assert.deepEqual(patch.edges.map(edge => edge.toNodeId), ['new'])
assert(JSON.stringify(patch).length < 2000, 'one edit must not upload the whole 5001-node graph')
const removed = graphCommitViewPatch({ ...baseline, nodes: nodes.filter(node => node.id !== 'n4001'), edges: [] }, baseline)
assert.deepEqual(removed.baseNodeIds, ['n4001'], 'deletion must remove its canonical identity')
assert.deepEqual(removed.baseEdgeKeys, ['n0>n5000:supports'])
assert.deepEqual(removed.nodes, [])
const metadataOnly = graphCommitViewPatch({ ...baseline, verification: { stale: true } }, baseline)
assert.deepEqual(metadataOnly, { nodes: [], edges: [], baseNodeIds: [], baseEdgeKeys: [] },
  'review metadata must not rewrite unrelated canonical nodes or edges')

assert(client.includes("h('option', { value: 'all' }, '全部节点')"))
assert(client.includes('await restoreDocument(pending.documentId, pending.title)')
  && client.includes('const relationTaskViewing = relationTaskActive && !!resultView')
  && client.includes('relationTaskViewing ? resultPanel : null')
  && client.includes('onDeleteEdge: relationTaskActive ? undefined : handleDeleteEdge'),
  'relation completion must restore and display a read-only saved graph while polling continues')
assert(client.includes("const allNodesActive = resultView?.graph?.view?.kind === 'all'"))
assert(client.includes('const displayView = resultView'))
assert(client.includes('onDeleteEdge: handleDeleteEdge') && client.includes('onQuestionNode: handleQuestionNode')
  && client.includes('onOpenNodeIssues: handleOpenNodeIssues') && client.includes('loadNeighborhood: async'),
  'all-node mode must expose the same workbench controls')
assert(!client.includes('在工作窗口查看') && !client.includes('只读总览') && !client.includes('function AllNodesDialog('),
  'no separate read-only overview or return-to-work-window action may remain')
assert(client.includes('const off = projectedAnchor === undefined ? displayView.anchors[nodeId] : projectedAnchor')
  && client.includes('}).map(n => n.id) : displayView.paraNodes[pi] || []'),
  'node-to-source and source-to-node navigation must share the complete working view')
assert(client.includes("if (overview && !related.edgeIdx.has(i)) return null"),
  'overview must not build thousands of relationship elements before selection')
console.log(JSON.stringify({ ok: true, nodes: nodes.length, completeWorkingView: true, compactCommit: true, staleRevisionRejected: true }))
