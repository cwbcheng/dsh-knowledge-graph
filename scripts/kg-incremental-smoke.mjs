import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
let capturedDigest = ''
const extractor = async ({ existingDigest }) => {
  capturedDigest = existingDigest || ''
  return {
    summary: '增量候选 smoke',
    nodes: [
      { id: 'n1', type: 'concept', text: '目标概念', quote: '目标概念', paragraph: 0 },
      { id: 'n2', type: 'fact', text: '新增事实', quote: '新增事实', paragraph: 0 },
    ],
    edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports', evidence: [{ paragraph: 0, quote: '目标概念；新增事实' }] }],
  }
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get(name) {
    return name === 'kgExtractor' ? extractor : null
  },
  interval() { return () => {} },
})

const existing = {
  source: { id: 'source-incremental-smoke', documentId: 'document-incremental-smoke', title: 'incremental smoke' },
  nodes: Array.from({ length: 151 }, (_, index) => ({
    id: 'n' + index,
    type: 'concept',
    text: index === 150 ? '目标概念' : '既有概念 ' + index,
    quote: index === 150 ? '目标概念' : '既有概念 ' + index,
    paragraph: index,
    evidence: [{ paragraph: index, quote: index === 150 ? '目标概念' : '既有概念 ' + index }],
  })),
  edges: [],
}

const started = await handlers.get('append-extract')({
  title: 'incremental smoke',
  text: '目标概念；新增事实',
  existing,
  paragraphOffset: 151,
})
assert(started && started.taskId, 'append task was not created')
let result = null
for (let i = 0; i < 100; i++) {
  const status = await handlers.get('task-status')({ taskId: started.taskId })
  if (status.status === 'succeeded') { result = status.result; break }
  if (status.status === 'failed' || status.status === 'cancelled') throw new Error('incremental task failed: ' + JSON.stringify(status))
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert(result, 'incremental task did not finish')
assert(capturedDigest.includes('n150|concept|目标概念'), 'candidate retrieval did not expose a matching node beyond the old 150-node cap')
assert(result.nodes.length === 152, 'exact duplicate was not canonicalized')
assert(result.warnings.some((warning) => warning.includes('duplicate_merged')), 'duplicate merge warning is missing')
assert(result.edges.some((edge) => edge.fromNodeId === 'n150' && edge.toNodeId === 'n152' && edge.relation === 'supports'), 'edge endpoint was not rewritten to the canonical node')
console.log(JSON.stringify({ ok: true, nodes: result.nodes.length, digestContainsTail: true, duplicateMerged: true }))
