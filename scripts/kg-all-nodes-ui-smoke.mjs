import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('         const openAllNodes = async () => {')
const end = client.indexOf('         const resumeLostTask = ', start)
assert(start >= 0 && end > start)
const actions = client.slice(start, end)
const createActions = new Function('resultView', 'allNodesGraph', 'allNodesLoading', 'documentIdOfGraph',
  'setError', 'setAllNodesLoading', 'graphCommitQueueRef', 'graphRevisionRef', 'host', 'setAllNodesGraph',
  'graphViewMetadata', 'loadGraphWindow', 'setSelectedNodeId', 'setSelectedEdgeId', 'setFocusReq',
  actions + '; return { openAllNodes, locateAllNode }')
const nodes = Array.from({ length: 5001 }, (_, index) => ({ id: 'n' + index }))
const canonical = { nodes, edges: [{ fromNodeId: 'n0', toNodeId: 'n5000', relation: 'supports' }],
  revision: 4, source: { documentId: 'document-test', revision: 4 } }
const windowGraph = { nodes: nodes.slice(0, 800), edges: [], source: { documentId: 'document-test' },
  view: { kind: 'window', nodeLimit: 800, totalNodes: nodes.length, nodeOffset: 0 } }
const opened = [], errors = [], requests = [], pages = [], selected = []
const fixture = (revision, allNodesGraph = null, reply = { documentId: 'document-test', revision: 4, graph: canonical }) => createActions(
  { graph: windowGraph }, allNodesGraph, false, graph => graph.source.documentId,
  value => errors.push(value), () => {}, { current: Promise.resolve() }, { current: revision },
  { call: async (method, body) => { requests.push({ method, body }); return reply } },
  graph => opened.push(graph), graph => ({ nodeLimit: graph.view.nodeLimit }),
  async options => { pages.push(options); return true }, value => selected.push(value), () => {}, () => {})

await fixture(4).openAllNodes()
assert.equal(requests.at(-1).method, 'document-export')
assert.equal(opened.at(-1).nodes.length, 5001, 'the explicit all-node action must not inherit the 2000-node window cap')
assert.equal(opened.at(-1).edges.length, 1, 'canonical cross-window relations must remain available')
const openedBeforeConflict = opened.length
await fixture(3).openAllNodes()
assert.equal(opened.length, openedBeforeConflict, 'a stale canonical export cannot replace the visible graph')
assert.match(errors.at(-1).message, /版本已更新/)

await fixture(4, canonical).locateAllNode('n4001')
assert.deepEqual(pages.at(-1), { page: 6, nodeLimit: 800, query: '' },
  'locating an off-window node must load the corresponding editable work window')
assert.equal(selected.at(-1), 'n4001')
assert.equal(opened.at(-1), null, 'returning to a window releases the large overview')
assert(client.includes("if (overview && !related.edgeIdx.has(i)) return null"),
  'the overview must not build thousands of relationship elements before selection')
const dialogStart = client.indexOf('      function AllNodesDialog(')
const dialogEnd = client.indexOf('      function GraphCanvas(', dialogStart)
const dialog = client.slice(dialogStart, dialogEnd)
assert(dialog.includes("layoutMode: 'overview'") && !dialog.includes('onDeleteEdge:'),
  'the complete graph must be displayed as a read-only overview, not sent through a window edit request')
console.log(JSON.stringify({ ok: true, nodes: canonical.nodes.length, crossWindowRelation: true, staleRevisionRejected: true, locatePage: 6 }))
