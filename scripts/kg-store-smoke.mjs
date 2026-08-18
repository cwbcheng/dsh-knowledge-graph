import { openSqliteStore } from '../src/kg-store.mjs'

const store = await openSqliteStore(':memory:')
try {
  const graph = {
    summary: '书级 fixture',
    source: {
      id: 'source-smoke',
      documentId: 'document-smoke',
      title: 'SQLite smoke',
      chars: 120,
      paragraphCount: 4,
      chunkCount: 2,
      sectionCount: 2,
      sections: [{ id: 'section-1', title: '第一章' }, { id: 'section-2', title: '第二章' }],
    },
    staging: {
      sourceId: 'source-smoke',
      documentId: 'document-smoke',
      chunkCount: 2,
      chunks: [
        { chunkId: 'chunk-1', startParagraph: 0, endParagraph: 1, sectionIds: ['section-1'], sectionTitles: ['第一章'], summary: '事实', nodeIds: ['n1'], edgeCount: 0, warnings: [] },
        { chunkId: 'chunk-2', startParagraph: 2, endParagraph: 3, sectionIds: ['section-2'], sectionTitles: ['第二章'], summary: '推论', nodeIds: ['n2'], edgeCount: 1, warnings: [] },
      ],
    },
    nodes: [
      { id: 'n1', type: 'fact', text: '系统按块读取正文', paragraph: 0, quote: '按块读取', evidence: [{ paragraph: 0, quote: '按块读取' }], documentId: 'document-smoke', sourceId: 'source-smoke', chunkId: 'chunk-1', sectionId: 'section-1', sectionTitle: '第一章' },
      { id: 'n2', type: 'concept', text: '可恢复处理', paragraph: 2, quote: '可恢复', evidence: [{ paragraph: 2, quote: '可恢复' }], documentId: 'document-smoke', sourceId: 'source-smoke', chunkId: 'chunk-2', sectionId: 'section-2', sectionTitle: '第二章' },
    ],
    edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports', evidence: [{ paragraph: 0, quote: '按块读取' }], documentId: 'document-smoke', sourceId: 'source-smoke', chunkId: 'chunk-2' }],
  }
  const sourceText = '按块读取正文。\n\n第二段。\n\n可恢复处理。\n\n第四段。'
  const saved = store.saveGraph(graph, { sourceText })
  if (saved.nodes !== 2 || saved.entityCandidates !== 1 || saved.claimCandidates !== 1 || saved.revision !== 1) throw new Error('graph persistence counts/revision are wrong: ' + JSON.stringify(saved))
  const candidates = store.listCandidates({ documentId: 'document-smoke', status: 'candidate', limit: 20 })
  if (candidates.length !== 2) throw new Error('candidate persistence is wrong: ' + JSON.stringify(candidates))
  const accepted = store.updateCandidate('entity', candidates.find((candidate) => candidate.kind === 'entity').id, 'accepted')
  if (!accepted || accepted.status !== 'accepted') throw new Error('candidate update failed')
  const checkpoint = { version: 2, taskKind: 'extract', documentId: 'document-smoke', sourceId: 'source-smoke', nextBatchIndex: 1, totalBatches: 2, graph, staging: graph.staging }
  const run = store.saveCheckpoint(checkpoint, { runId: 'run-smoke', title: 'SQLite smoke', sourceText, status: 'running' })
  const loaded = store.loadCheckpoint('run-smoke')
  if (!loaded || loaded.checkpoint.nextBatchIndex !== 1 || loaded.sourceText !== sourceText || loaded.status !== 'running') throw new Error('checkpoint persistence failed')
  const restored = store.getDocument('document-smoke')
  if (!restored || restored.nodes.length !== 2 || restored.edges.length !== 1 || restored.staging.chunks.length !== 2 || restored.sourceText !== sourceText || restored.revision !== 1) throw new Error('document restore failed')

  // Commit a UI window containing only n1 and delete n1 from that window.
  // n2 was outside the baseline window and therefore must survive; the edge
  // must disappear because its visible endpoint was deleted.
  const committed = store.commitViewGraph({
    documentId: 'document-smoke',
    expectedRevision: 1,
    graph: { summary: '人工修复后', nodes: [], edges: [] },
    baseNodeIds: ['n1'],
    baseEdgeKeys: ['n1>n2:supports'],
  })
  if (!committed || committed.revision !== 2) throw new Error('revisioned graph commit failed')
  const patched = store.getDocument('document-smoke')
  if (!patched || patched.nodes.length !== 1 || patched.nodes[0].id !== 'n2' || patched.edges.length !== 0 || patched.sourceText !== sourceText) {
    throw new Error('window commit lost unseen canonical state: ' + JSON.stringify(patched))
  }
  const remainingCandidates = store.listCandidates({ documentId: 'document-smoke', kind: 'all', status: 'all', limit: 20 })
  if (remainingCandidates.length !== 1 || remainingCandidates[0].nodeId !== 'n2' || remainingCandidates[0].status !== 'accepted') {
    throw new Error('candidate cleanup lost review state or kept a deleted-node candidate: ' + JSON.stringify(remainingCandidates))
  }
  let conflict = null
  try {
    store.commitViewGraph({ documentId: 'document-smoke', expectedRevision: 1, graph: { nodes: [], edges: [] }, baseNodeIds: [], baseEdgeKeys: [] })
  } catch (error) { conflict = error }
  if (!conflict || conflict.code !== 'revision_conflict' || conflict.currentRevision !== 2) throw new Error('stale graph revision was not rejected')

  console.log(JSON.stringify({ ok: true, saved, candidates: candidates.length, accepted, run, restoredNodes: restored.nodes.length, revision: patched.revision }))
} finally {
  store.close()
}
