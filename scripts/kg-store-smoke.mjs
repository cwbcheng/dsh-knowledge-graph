import { DatabaseSync } from 'node:sqlite'
import { SqliteKnowledgeStore, openSqliteStore } from '../src/kg-store.mjs'

const store = await openSqliteStore(':memory:')
try {
  const graph = {
    summary: '书级 fixture',
    traceText: 'trace persistence smoke',
    traceEvents: [{ seq: 1, type: 'user/message', start: 0, end: 23, line: 'trace persistence smoke' }],
    generation: { invariantVersion: 1, status: 'succeeded', invariantErrors: 0, sourceAudit: 'full', retryCount: 0, autoRepairCount: 0, autoRepairs: [] },
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
      { id: 'n1', type: 'fact', text: '系统按块读取正文', paragraph: 0, quote: '按块读取', evidence: [{ documentId: 'document-smoke', sourceId: 'source-smoke', chunkId: 'chunk-1', paragraph: 0, quote: '按块读取' }], groundingStatus: 'grounded', entailmentStatus: 'unverified', documentId: 'document-smoke', sourceId: 'source-smoke', chunkId: 'chunk-1', sectionId: 'section-1', sectionTitle: '第一章' },
      { id: 'n2', type: 'concept', text: '可恢复处理', paragraph: 2, quote: '可恢复', evidence: [{ documentId: 'document-smoke', sourceId: 'source-smoke', chunkId: 'chunk-2', paragraph: 2, quote: '可恢复' }], groundingStatus: 'grounded', entailmentStatus: 'verified', documentId: 'document-smoke', sourceId: 'source-smoke', chunkId: 'chunk-2', sectionId: 'section-2', sectionTitle: '第二章' },
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
  if (restored.traceText !== graph.traceText || !Array.isArray(restored.traceEvents) || restored.traceEvents.length !== 1) throw new Error('trajectory graph metadata was not restored')
  if (restored.nodes[0].groundingStatus !== 'grounded' || !['unverified', 'verified'].includes(restored.nodes[0].entailmentStatus)) throw new Error('grounding/entailment status was not restored')
  if (!restored.generation || restored.generation.invariantErrors !== 0 || restored.generation.sourceAudit !== 'full') throw new Error('generation audit metadata was not restored from SQLite')

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
  if (!patched || patched.nodes.length !== 1 || patched.nodes[0].id !== 'n2' || patched.edges.length !== 0 || patched.sourceText !== sourceText || !patched.generation || patched.generation.invariantErrors !== 0) {
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

  // chunk_id is document/source-local provenance, never a database-global key.
  // The same literal id must coexist across documents and source versions.
  const chunkGraph = (documentId, sourceId, chunks) => ({
    summary: 'chunk identity',
    source: { id: sourceId, documentId, title: documentId, chars: 1, paragraphCount: 1, chunkCount: chunks.length, sectionCount: 0, sections: [] },
    staging: { sourceId, documentId, chunkCount: chunks.length, chunks },
    nodes: [], edges: [],
  })
  const sharedChunk = (sourceId) => ({ chunkId: 'shared-chunk', sourceId, startParagraph: 0, endParagraph: 0, sectionIds: [], sectionTitles: [], summary: '', nodeIds: [], edgeCount: 0, warnings: [] })
  store.saveGraph(chunkGraph('document-chunk-a', 'source-shared', [sharedChunk('source-shared')]), { sourceText: 'A' })
  store.saveGraph(chunkGraph('document-chunk-b', 'source-shared', [sharedChunk('source-shared')]), { sourceText: 'B' })
  if (store.getDocument('document-chunk-a').staging.chunks.length !== 1 || store.getDocument('document-chunk-b').staging.chunks.length !== 1) {
    throw new Error('same chunk_id across documents overwrote/moved a chunk')
  }
  store.saveGraph(chunkGraph('document-chunk-append', 'source-v2', [sharedChunk('source-v1'), sharedChunk('source-v2')]), { sourceText: 'AB' })
  const appendChunks = store.getDocument('document-chunk-append').staging.chunks
  if (appendChunks.length !== 2 || new Set(appendChunks.map((chunk) => chunk.sourceId + '|' + chunk.chunkId)).size !== 2) {
    throw new Error('same document append collapsed chunk ids across source versions: ' + JSON.stringify(appendChunks))
  }

  // Semantic merge operations must run against the full canonical graph, not
  // just the visible baseline window.
  const mergeGraph = {
    summary: 'merge fixture',
    source: { id: 'source-merge', documentId: 'document-merge', title: 'merge', chars: 12, paragraphCount: 1, chunkCount: 0, sectionCount: 0, sections: [] },
    staging: { sourceId: 'source-merge', documentId: 'document-merge', chunkCount: 0, chunks: [] },
    nodes: [
      { id: 'n1', type: 'fact', text: '源节点', quote: '合并原文', paragraph: 0, evidence: [{ paragraph: 0, quote: '合并原文' }] },
      { id: 'n2', type: 'fact', text: '目标节点', quote: '合并原文', paragraph: 0, evidence: [{ paragraph: 0, quote: '合并原文' }] },
      { id: 'n900', type: 'fact', text: '隐藏节点', quote: '合并原文', paragraph: 0, evidence: [{ paragraph: 0, quote: '合并原文' }] },
    ],
    edges: [{ fromNodeId: 'n1', toNodeId: 'n900', relation: 'supports', evidence: [{ paragraph: 0, quote: '合并原文' }] }],
  }
  store.saveGraph(mergeGraph, { sourceText: '合并原文' })
  const mergedStoreResult = store.commitViewGraph({
    documentId: 'document-merge', expectedRevision: 1,
    operations: [{ kind: 'merge_node', fromNodeId: 'n1', intoNodeId: 'n2' }],
    graph: { summary: 'merge fixture', nodes: [mergeGraph.nodes[1]], edges: [] },
    baseNodeIds: ['n1', 'n2'], baseEdgeKeys: [],
  })
  if (!mergedStoreResult || mergedStoreResult.revision !== 2) throw new Error('store semantic merge did not advance revision')
  const mergedCanonical = store.getDocument('document-merge')
  if (mergedCanonical.nodes.some((node) => node.id === 'n1') || !mergedCanonical.edges.some((edge) => edge.fromNodeId === 'n2' && edge.toNodeId === 'n900')) {
    throw new Error('store semantic merge lost hidden edge: ' + JSON.stringify(mergedCanonical.edges))
  }
  let hiddenIdConflict = null
  try {
    store.commitViewGraph({
      documentId: 'document-merge', expectedRevision: 2,
      graph: { summary: 'collision', nodes: [mergedCanonical.nodes.find((node) => node.id === 'n2'), { ...mergedCanonical.nodes.find((node) => node.id === 'n900'), text: '覆盖隐藏节点' }], edges: [] },
      baseNodeIds: ['n2'], baseEdgeKeys: [],
    })
  } catch (error) { hiddenIdConflict = error }
  if (!hiddenIdConflict || hiddenIdConflict.code !== 'node_id_conflict') throw new Error('store accepted a hidden canonical node id collision')

  const windowGraph = {
    summary: 'window fixture',
    source: { id: 'source-window', documentId: 'document-window', title: 'window', chars: 8, paragraphCount: 1, chunkCount: 0, sectionCount: 0, sections: [] },
    staging: { sourceId: 'source-window', documentId: 'document-window', chunkCount: 0, chunks: [] },
    nodes: Array.from({ length: 1001 }, (_, index) => ({ id: 'w' + (index + 1), type: 'fact', text: index === 1000 ? 'tail-search-target' : 'window node ' + (index + 1), quote: '窗口原文', paragraph: 0, evidence: [{ paragraph: 0, quote: '窗口原文' }] })),
    edges: [{ fromNodeId: 'w1', toNodeId: 'w1001', relation: 'supports', evidence: [{ paragraph: 0, quote: '窗口原文' }] }],
  }
  store.saveGraph(windowGraph, { sourceText: '窗口原文' })
  const dbWindow = store.getDocumentWindow('document-window', { offset: 800, limit: 800, includeSourceText: false })
  if (!dbWindow || dbWindow.nodes.length !== 201 || dbWindow.view.nodeOffset !== 800 || dbWindow.sourceText !== '') throw new Error('SQLite LIMIT/OFFSET window query is incorrect')
  const dbQuery = store.getDocumentWindow('document-window', { query: 'tail-search-target', limit: 800, includeSourceText: false })
  if (!dbQuery || dbQuery.view.kind !== 'query' || dbQuery.view.matchedNodes !== 1 || !dbQuery.nodes.some((node) => node.id === 'w1001') || !dbQuery.nodes.some((node) => node.id === 'w1') || !dbQuery.edges.some((edge) => edge.fromNodeId === 'w1' && edge.toNodeId === 'w1001')) {
    throw new Error('SQLite bounded subgraph query did not restore one-hop context')
  }

  const integrityGraph = {
    summary: 'integrity fixture',
    source: { id: 'source-integrity', documentId: 'document-integrity', title: 'integrity', chars: 6, paragraphCount: 1, chunkCount: 0, sectionCount: 0, sections: [] },
    staging: { sourceId: 'source-integrity', documentId: 'document-integrity', chunkCount: 0, chunks: [] },
    nodes: [
      { id: 'i1', type: 'fact', text: '完整性节点一', quote: '完整性原文', paragraph: 0, evidence: [{ paragraph: 0, quote: '完整性原文' }] },
      { id: 'i2', type: 'fact', text: '完整性节点二', quote: '完整性原文', paragraph: 0, evidence: [{ paragraph: 0, quote: '完整性原文' }] },
    ],
    edges: [{ fromNodeId: 'i1', toNodeId: 'i2', relation: 'supports', evidence: [{ paragraph: 0, quote: '完整性原文' }] }],
  }
  store.saveGraph(integrityGraph, { sourceText: '完整性原文' })
  const integrityCandidateCount = store.listCandidates({ documentId: 'document-integrity', limit: 20 }).length
  const invalidReplacements = [
    { label: 'null graph', graph: null },
    { label: 'array graph', graph: [] },
    { label: 'primitive graph', graph: 'invalid' },
    { label: 'non-array nodes', graph: { ...integrityGraph, nodes: {} } },
    { label: 'non-array edges', graph: { ...integrityGraph, edges: {} } },
    { label: 'empty node text', graph: { ...integrityGraph, nodes: [integrityGraph.nodes[0], { ...integrityGraph.nodes[1], text: '' }] } },
    { label: 'whitespace node id', graph: { ...integrityGraph, nodes: [{ ...integrityGraph.nodes[0], id: ' i1 ' }, integrityGraph.nodes[1]] } },
    { label: 'whitespace node text', graph: { ...integrityGraph, nodes: [{ ...integrityGraph.nodes[0], text: ' 完整性节点一 ' }, integrityGraph.nodes[1]] } },
    { label: 'duplicate node id', graph: { ...integrityGraph, nodes: [integrityGraph.nodes[0], { ...integrityGraph.nodes[1], id: 'i1' }] } },
    { label: 'whitespace edge endpoint', graph: { ...integrityGraph, edges: [{ fromNodeId: ' i1 ', toNodeId: 'i2', relation: 'supports' }] } },
    { label: 'whitespace relation', graph: { ...integrityGraph, edges: [{ fromNodeId: 'i1', toNodeId: 'i2', relation: ' supports ' }] } },
    { label: 'dangling edge', graph: { ...integrityGraph, edges: [{ fromNodeId: 'i1', toNodeId: 'ghost', relation: 'supports' }] } },
    { label: 'self-loop', graph: { ...integrityGraph, edges: [{ fromNodeId: 'i1', toNodeId: 'i1', relation: 'supports' }] } },
    { label: 'duplicate edge', graph: { ...integrityGraph, edges: [integrityGraph.edges[0], { ...integrityGraph.edges[0] }] } },
  ]
  for (const fixture of invalidReplacements) {
    let failure = null
    try { store.saveGraph(fixture.graph, { sourceText: 'replacement', expectedRevision: 1 }) } catch (error) { failure = error }
    if (!failure || failure.code !== 'invalid_graph') throw new Error('store accepted invalid replacement (' + fixture.label + ')')
    const preserved = store.getDocument('document-integrity')
    const candidatesAfter = store.listCandidates({ documentId: 'document-integrity', limit: 20 }).length
    if (!preserved || preserved.revision !== 1 || preserved.sourceText !== '完整性原文' || preserved.nodes.length !== 2 || preserved.edges.length !== 1 || preserved.edges[0].fromNodeId !== 'i1' || preserved.edges[0].toNodeId !== 'i2' || candidatesAfter !== integrityCandidateCount) {
      throw new Error('invalid replacement changed canonical state (' + fixture.label + '): ' + JSON.stringify(preserved))
    }
  }

  const legacyDb = new DatabaseSync(':memory:')
  legacyDb.exec(`
    CREATE TABLE chunks (
      chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, source_id TEXT NOT NULL,
      start_paragraph INTEGER, end_paragraph INTEGER, section_ids_json TEXT NOT NULL,
      section_titles_json TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'completed',
      node_ids_json TEXT NOT NULL, edge_count INTEGER NOT NULL DEFAULT 0, warnings_json TEXT NOT NULL,
      payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    )
  `)
  const migratedStore = new SqliteKnowledgeStore(legacyDb, ':memory:')
  const pkColumns = legacyDb.prepare('PRAGMA table_info(chunks)').all().filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name)
  if (pkColumns.join(',') !== 'document_id,source_id,chunk_id') throw new Error('legacy chunk PK migration failed: ' + pkColumns.join(','))
  migratedStore.close()

  console.log(JSON.stringify({ ok: true, saved, candidates: candidates.length, accepted, run, restoredNodes: restored.nodes.length, revision: patched.revision, chunkIdentity: 'composite', legacyChunkMigration: true, semanticMerge: true, graphIntegrity: true, sqliteWindow: dbWindow.nodes.length }))
} finally {
  store.close()
}
