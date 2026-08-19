import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const extractor = async ({ title }) => {
  if (title === 'relation evidence') {
    return {
      summary: '关系证据回归',
      nodes: [
        { id: 'a', type: 'fact', text: 'A 发生了', quote: 'A 发生了', paragraph: 0 },
        { id: 'b', type: 'fact', text: 'B 也发生了', quote: 'B 也发生了', paragraph: 1 },
      ],
      // Deliberately omit relation evidence. Endpoint node evidence must never
      // be synthesized into proof for A causes B.
      edges: [{ fromNodeId: 'a', toNodeId: 'b', relation: 'causes' }],
    }
  }
  return {
    summary: '801 节点回归',
    nodes: Array.from({ length: 801 }, (_, index) => ({
      id: 'n' + (index + 1),
      type: 'fact',
      text: '知识节点 ' + (index + 1),
      quote: '大型图测试',
      paragraph: 0,
    })),
    edges: [{ fromNodeId: 'n1', toNodeId: 'n801', relation: 'supports', evidence: [{ paragraph: 0, quote: '大型图测试' }] }],
  }
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? extractor : null },
  interval() { return () => {} },
})

const started = await handlers.get('extract')({ title: 'large graph', text: '大型图测试' })
assert(started && started.taskId, 'large-graph extraction was not created')
let result = null
for (let i = 0; i < 100; i++) {
  const status = await handlers.get('task-status')({ taskId: started.taskId })
  if (status.status === 'succeeded') { result = status.result; break }
  if (status.status === 'failed' || status.status === 'cancelled') throw new Error('801-node extraction must not fail: ' + JSON.stringify(status))
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert(result, '801-node extraction did not finish')
assert(result.nodes.length === 800, 'renderer window must stay bounded to 800 nodes')
assert(result.view && result.view.truncated === true, 'large graph must declare a truncated view')
assert(result.view.totalNodes === 801, 'canonical node count was lost behind the view window')

const documentId = result.source && result.source.documentId
const loaded = await handlers.get('document-load')({ documentId })
assert(loaded && !loaded.error && loaded.graph, 'canonical document could not be loaded from Host')
assert(loaded.graph.view.totalNodes === 801 && loaded.graph.nodes.length === 800, 'Host canonical graph was truncated instead of only the view')
const tail = await handlers.get('document-load')({ documentId, nodeOffset: 800 })
assert(tail && tail.graph && tail.graph.nodes.length === 1 && tail.graph.nodes[0].id === 'n801', 'tail window is not queryable past the 800-node renderer budget')
const queried = await handlers.get('document-load')({ documentId, query: '知识节点 801' })
assert(queried && queried.graph && queried.graph.view && queried.graph.view.kind === 'query', 'canonical subgraph query did not return query metadata')
assert(queried.graph.view.matchedNodes === 1 && queried.graph.nodes.some((node) => node.id === 'n801'), 'subgraph query could not locate a node outside the first renderer window')
assert(queried.graph.nodes.some((node) => node.id === 'n1'), 'subgraph query did not include a one-hop neighbor across renderer windows')
assert(queried.graph.edges.some((edge) => edge.fromNodeId === 'n1' && edge.toNodeId === 'n801'), 'subgraph query did not restore cross-window relation context')
const exported = await handlers.get('document-export')({ documentId })
assert(exported && exported.graph && exported.graph.nodes.length === 801, 'canonical export was truncated to the renderer window')

// A window must never be able to allocate an id that overwrites a canonical
// node outside the baseline. The UI now uses UUID ids, and Host rejects this
// legacy n801 collision defensively.
const idConflict = await handlers.get('graph-commit')({
  documentId,
  expectedRevision: loaded.revision,
  graph: {
    summary: loaded.graph.summary,
    nodes: loaded.graph.nodes.concat([{ id: 'n801', type: 'fact', text: '错误的新 n801', quote: '大型图测试', paragraph: 0 }]),
    edges: loaded.graph.edges,
  },
  baseNodeIds: loaded.graph.nodes.map((node) => node.id),
  baseEdgeKeys: loaded.graph.edges.map((edge) => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation),
})
assert(idConflict && idConflict.error && idConflict.error.code === 'node_id_conflict', 'hidden canonical node id collision was not rejected')

// merge_node is a semantic canonical operation. n1->n801 is invisible on the
// first 800-node window, but merging n1 into n2 must redirect that hidden edge
// to n2->n801 rather than silently deleting it.
const mergeCommit = await handlers.get('graph-commit')({
  documentId,
  expectedRevision: loaded.revision,
  operations: [{ kind: 'merge_node', fromNodeId: 'n1', intoNodeId: 'n2' }],
  graph: { summary: loaded.graph.summary, nodes: loaded.graph.nodes.filter((node) => node.id !== 'n1'), edges: loaded.graph.edges },
  baseNodeIds: loaded.graph.nodes.map((node) => node.id),
  baseEdgeKeys: loaded.graph.edges.map((edge) => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation),
})
assert(mergeCommit && !mergeCommit.error && mergeCommit.revision === loaded.revision + 1, 'canonical merge operation failed')
const afterMerge = await handlers.get('document-export')({ documentId })
assert(!afterMerge.graph.nodes.some((node) => node.id === 'n1') && afterMerge.graph.nodes.some((node) => node.id === 'n2'), 'canonical merge did not remove the source node')
assert(afterMerge.graph.edges.some((edge) => edge.fromNodeId === 'n2' && edge.toNodeId === 'n801'), 'merge did not redirect a hidden cross-window edge')
assert(!afterMerge.graph.edges.some((edge) => edge.fromNodeId === 'n1' || edge.toNodeId === 'n1'), 'merge left hidden relations pointing at the removed node')

// Deleting a node from a tail window must remove incident cross-window edges.
const tailAfterMerge = await handlers.get('document-load')({ documentId, query: '知识节点 801' })
assert(tailAfterMerge && tailAfterMerge.graph.nodes.some((node) => node.id === 'n801'), 'merged hidden node was no longer queryable')
const tailCommit = await handlers.get('graph-commit')({
  documentId,
  expectedRevision: mergeCommit.revision,
  graph: {
    summary: tailAfterMerge.graph.summary,
    nodes: tailAfterMerge.graph.nodes.filter((node) => node.id !== 'n801'),
    edges: tailAfterMerge.graph.edges.filter((edge) => edge.fromNodeId !== 'n801' && edge.toNodeId !== 'n801'),
  },
  baseNodeIds: tailAfterMerge.graph.nodes.map((node) => node.id),
  baseEdgeKeys: tailAfterMerge.graph.edges.map((edge) => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation),
})
assert(tailCommit && !tailCommit.error, 'tail-window graph commit failed')
const afterTailCommit = await handlers.get('document-export')({ documentId })
assert(afterTailCommit.graph.nodes.length === 799 && !afterTailCommit.graph.nodes.some((node) => node.id === 'n801'), 'tail-window node deletion did not update the canonical graph')
assert(!afterTailCommit.graph.edges.some((edge) => edge.fromNodeId === 'n2' && edge.toNodeId === 'n801'), 'tail-window node deletion left a dangling cross-window edge')

const relationStarted = await handlers.get('extract')({ title: 'relation evidence', text: 'A 发生了\n\nB 也发生了' })
let relationResult = null
for (let i = 0; i < 100; i++) {
  const status = await handlers.get('task-status')({ taskId: relationStarted.taskId })
  if (status.status === 'succeeded') { relationResult = status.result; break }
  if (status.status === 'failed' || status.status === 'cancelled') throw new Error('relation-evidence extraction failed: ' + JSON.stringify(status))
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert(relationResult, 'relation-evidence extraction did not finish')
assert(relationResult.edges.length === 0, 'edge without direct relation evidence was trusted')
assert(relationResult.warnings.some((warning) => warning.includes('missing_relation_evidence')), 'missing relation evidence was not diagnosed')

const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const clientSource = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
assert(hostSource.includes('version: 2'), 'checkpoint v2 marker is missing')
assert(!hostSource.includes('MAX_GRAPH_NODES'), '800-node knowledge hard limit still exists')
assert(!clientSource.includes('LS_CHECKPOINT'), 'client still persists full checkpoints in localStorage')
assert(!clientSource.includes("status !== 'cancelled' && await resumeLostTask"), 'deterministic failures can still auto-resume')
assert(clientSource.includes("if (await resumeLostTask()) return"), 'Host-restart recovery path is missing')
assert(clientSource.includes("className: 'kg-window-nav'"), 'large-graph UI window navigation is missing')
assert(clientSource.includes("loadGraphWindow({ page: windowMeta.page + 1, query: '' })"), 'large-graph next-page control is missing')
assert(clientSource.includes("placeholder: '按节点 ID / 文本 / 类型 / 章节查询子图…'"), 'large-graph subgraph query control is missing')

console.log(JSON.stringify({ ok: true, canonicalNodes: result.view.totalNodes, visibleNodes: result.nodes.length, queriedNode: 'n801', checkpointVersion: 2 }))
