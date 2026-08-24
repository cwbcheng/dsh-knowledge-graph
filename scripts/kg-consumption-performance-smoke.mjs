import { performance } from 'node:perf_hooks'
import { openSqliteStore } from '../src/kg-store.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const documentId = 'document-consumption-performance'
const sourceId = 'source-consumption-performance'
const nodeCount = 10005
const paragraphs = []
const nodes = []
const edges = []
for (let index = 0; index <= nodeCount; index++) paragraphs.push('共同词知识节点 ' + index + ' 的原文。')
paragraphs[nodeCount] = '共同词 PERF_EXACT_TARGET 位于文档尾部。'
paragraphs.push('ZZFALLBACKTOKEN 只存在于 canonical source unit。')
for (let index = 1; index <= nodeCount; index++) {
  const paragraph = index
  const text = index === nodeCount ? '共同词 PERF_EXACT_TARGET' : '共同词知识节点 ' + index
  const quote = paragraphs[paragraph].replace(/。$/, '')
  nodes.push({
    id: 'n' + index,
    type: 'fact',
    text,
    paragraph,
    quote,
    evidence: [{ documentId, sourceId, chunkId: 'chunk-performance', paragraph, quote }],
    documentId,
    sourceId,
    chunkId: 'chunk-performance',
    sectionId: paragraph < 5000 ? 'section-a' : 'section-b',
    sectionTitle: paragraph < 5000 ? '前部' : '后部',
    groundingStatus: 'grounded',
    entailmentStatus: 'verified',
    state: 'accepted',
  })
  if (index > 1) {
    edges.push({
      fromNodeId: 'n' + (index - 1),
      toNodeId: 'n' + index,
      relation: 'supports',
      evidence: [{ documentId, sourceId, chunkId: 'chunk-performance', paragraph, quote }],
      documentId,
      sourceId,
      chunkId: 'chunk-performance',
      state: 'accepted',
    })
  }
}
const sourceText = paragraphs.join('\n\n')
const graph = {
  summary: '消费查询性能 fixture',
  source: {
    id: sourceId,
    documentId,
    title: '消费查询性能 fixture',
    chars: sourceText.length,
    paragraphCount: paragraphs.length,
    chunkCount: 1,
    sectionCount: 2,
    sections: [
      { id: 'section-a', title: '前部', startParagraph: 0, endParagraph: 4999 },
      { id: 'section-b', title: '后部', startParagraph: 5000, endParagraph: paragraphs.length - 1 },
    ],
  },
  staging: {
    sourceId,
    documentId,
    chunkCount: 1,
    chunks: [{
      chunkId: 'chunk-performance', sourceId, startParagraph: 0, endParagraph: paragraphs.length - 1,
      sectionIds: ['section-a', 'section-b'], sectionTitles: ['前部', '后部'], summary: '性能',
      nodeIds: nodes.map((node) => node.id), edgeCount: edges.length, warnings: [],
    }],
  },
  nodes,
  edges,
}

const store = await openSqliteStore(':memory:')
try {
  const saveStarted = performance.now()
  store.saveGraph(graph, { sourceText, sourceUnits: paragraphs })
  const saveMs = performance.now() - saveStarted
  const timings = []
  let result = null
  for (let run = 0; run < 5; run++) {
    const started = performance.now()
    result = store.queryDocumentGraph(documentId, {
      query: '共同词 PERF_EXACT_TARGET',
      limit: 1,
      hops: 2,
      maxNodes: 12,
      maxEdges: 24,
    })
    timings.push(performance.now() - started)
    assert(result && result.matches[0] && result.matches[0].nodeId === 'n' + nodeCount, 'late exact match was hidden behind saturated common candidates')
    assert(result.graph.nodes.length <= 12 && result.graph.edges.length <= 24, 'performance query exceeded graph budgets')
    assert(result.sourceUnits.length <= 80 && result.sourceUnits.reduce((sum, unit) => sum + unit.text.length, 0) <= 24000, 'performance query exceeded source budgets')
    assert(!Object.prototype.hasOwnProperty.call(result, 'sourceText'), 'performance query leaked sourceText')
  }
  const fallbackStarted = performance.now()
  const fallback = store.queryDocumentGraph(documentId, {
    query: 'ZZFALLBACKTOKEN',
    limit: 4,
    hops: 0,
    includeSourceFallback: true,
  })
  const fallbackMs = performance.now() - fallbackStarted
  assert(fallback.matches.length === 0, 'source-only token unexpectedly matched graph nodes')
  assert(fallback.metrics.sourceFallbackEvaluated === true && fallback.metrics.sourceFallbackUnits === 1, 'single-pass source fallback was not evaluated exactly once')
  assert(fallback.sourceUnits.some((unit) => unit.sourceFallback === true && unit.text.includes('ZZFALLBACKTOKEN')), 'source-only fallback unit was not returned')

  const sorted = timings.slice().sort((a, b) => a - b)
  const p95Ms = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
  assert(p95Ms < 4000, 'bounded SQLite consumption query exceeded 4s p95 smoke budget: ' + p95Ms.toFixed(1) + 'ms')
  console.log(JSON.stringify({
    ok: true,
    nodes: nodes.length,
    edges: edges.length,
    saveMs: Math.round(saveMs * 10) / 10,
    queryAvgMs: Math.round((timings.reduce((sum, value) => sum + value, 0) / timings.length) * 10) / 10,
    queryP95Ms: Math.round(p95Ms * 10) / 10,
    fallbackMs: Math.round(fallbackMs * 10) / 10,
    returnedNodes: result.graph.nodes.length,
    returnedEdges: result.graph.edges.length,
  }))
} finally {
  store.close()
}
