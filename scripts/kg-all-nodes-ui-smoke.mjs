import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('         const openAllNodes = async () => {')
const end = client.indexOf('         const resumeLostTask = ', start)
assert(start >= 0 && end > start)
const actions = client.slice(start, end)
const createActions = new Function('resultView', 'allNodesGraph', 'allNodesLoading', 'documentIdOfGraph',
  'setError', 'setAllNodesLoading', 'graphCommitQueueRef', 'graphRevisionRef', 'host', 'setAllNodesGraph',
  'graphViewMetadata', 'loadGraphWindow', 'setSelectedNodeId', 'setSelectedEdgeId', 'setFocusReq', 'setChapterFilter',
  actions + '; return { openAllNodes, locateAllNode }')
const nodes = Array.from({ length: 5001 }, (_, index) => ({ id: 'n' + index }))
const canonical = { nodes, edges: [{ fromNodeId: 'n0', toNodeId: 'n5000', relation: 'supports' }],
  graphOntology: { id: 'proposition-v1' }, revision: 4, source: { documentId: 'document-test', revision: 4 } }
const windowGraph = { nodes: nodes.slice(0, 800), edges: [], source: { documentId: 'document-test' },
  graphOntology: { id: 'learning-view-v1' }, view: { kind: 'window', nodeLimit: 800, totalNodes: nodes.length, nodeOffset: 0 } }
const opened = [], errors = [], requests = [], pages = [], selected = []
const fixture = (revision, allNodesGraph = null, reply = { documentId: 'document-test', revision: 4, graph: canonical }) => createActions(
  { graph: windowGraph }, allNodesGraph, false, graph => graph.source.documentId,
  value => errors.push(value), () => {}, { current: Promise.resolve() }, { current: revision },
  { call: async (method, body) => { requests.push({ method, body }); return reply } },
  graph => opened.push(graph), graph => ({ nodeLimit: graph.view.nodeLimit }),
  async options => { pages.push(options); return true }, value => selected.push(value), () => {}, () => {}, () => {})

await fixture(4).openAllNodes()
assert.equal(requests.at(-1).method, 'document-export')
assert.equal(opened.at(-1).nodes.length, 5001, 'the explicit all-node action must not inherit the 2000-node window cap')
assert.equal(opened.at(-1).edges.length, 1, 'canonical cross-window relations must remain available')
assert.equal(opened.at(-1).graphOntology.id, 'learning-view-v1',
  'the complete view must keep the verified work-window ontology for source and node labels')
const openedBeforeConflict = opened.length
await fixture(3).openAllNodes()
assert.equal(opened.length, openedBeforeConflict, 'a stale canonical export cannot replace the visible graph')
assert.match(errors.at(-1).message, /版本已更新/)

await fixture(4, canonical).locateAllNode('n4001')
assert.deepEqual(pages.at(-1), { page: 6, nodeLimit: 800, query: '' },
  'locating an off-window node must load the corresponding editable work window')
assert.equal(selected.at(-1), 'n4001')
assert(client.includes("if (overview && !related.edgeIdx.has(i)) return null"),
  'the overview must not build thousands of relationship elements before selection')
assert(!client.includes('function AllNodesDialog('), 'the overview must stay beside the source, not open in a separate dialog')
assert(client.includes("h('option', { value: 'all' }, '全部节点')"), 'the window-size selector must offer all nodes')
assert(client.includes("allNodesActive ? makeView(allNodesGraph, resultView.sourceText) : resultView"),
  'full-view paragraph and node indexes must be built from the canonical graph')
assert(client.includes('if (allNodesGraph && !allNodesActive) setAllNodesGraph(null)'),
  'switching documents or revisions must release a stale complete graph')
assert(client.includes('const off = projectedAnchor === undefined ? displayView.anchors[nodeId] : projectedAnchor')
  && client.includes('}).map(n => n.id) : displayView.paraNodes[pi] || []')
  && client.includes('nodes: graph.nodes, edges: graph.edges, anchors: displayView.anchors'),
  'both node-to-source and source-to-node navigation must use the same complete view')
assert(client.includes("layoutMode: allNodesActive ? 'overview' : layoutMode")
  && client.includes('onDeleteEdge: allNodesActive ? undefined : handleDeleteEdge')
  && client.includes('onLocateNode: allNodesActive ? locateAllNode : undefined')
  && client.includes('loadNeighborhood: allNodesActive ? undefined : async'),
  'the all-node graph must remain read-only while providing a route back to the editable window')
assert(client.includes('badges.map((t) => TYPE_META[t]?.label || t)'),
  'an unexpected canonical type must not crash the source panel')
console.log(JSON.stringify({ ok: true, nodes: canonical.nodes.length, crossWindowRelation: true, staleRevisionRejected: true, bidirectionalSourceLink: true, locatePage: 6 }))
