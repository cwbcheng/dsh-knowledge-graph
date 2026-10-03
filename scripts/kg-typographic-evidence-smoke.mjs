import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }

let mode = 'unique'
const extractor = {
  async extractChunk() {
    if (mode === 'unique') {
      return {
        summary: 'quote typography',
        nodes: [
          { id: 'n1', type: 'concept', text: '感觉懂了', quote: '“感觉懂了”', paragraph: 0 },
          { id: 'n2', type: 'concept', text: '行为目标', quote: '行为目标', paragraph: 0 },
        ],
        edges: [
          { fromNodeId: 'n1', toNodeId: 'n2', relation: 'not_is', evidence: [{ paragraph: 0, quote: '“感觉懂了”并不是明确的行为目标' }] },
        ],
      }
    }
    return {
      summary: 'ambiguous quote typography',
      nodes: [{ id: 'n1', type: 'concept', text: '感觉懂了', quote: '“感觉懂了”', paragraph: 0 }],
      edges: [],
    }
  },
}

hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? extractor : null },
  interval() { return () => {} },
})

async function waitTask(taskId) {
  for (let i = 0; i < 240; i += 1) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish')
}

const uniqueSource = '"感觉懂了"并不是明确的行为目标。'
const pendingStarted = await handlers.get('extract')({ title: 'typography-pending', text: uniqueSource })
const pendingDone = await waitTask(pendingStarted.taskId)
assert(pendingDone.status === 'succeeded', JSON.stringify(pendingDone))
assert(pendingDone.result.edges.length === 0, 'authenticated typography alone must not admit a high-risk relation without review')
const pendingEdge = pendingDone.result.generation.semanticReview.withheld.find(item => item.verdict === 'pending')?.edge
assert(pendingEdge?.evidence.some(item => item.quote === '"感觉懂了"并不是明确的行为目标'), 'pending review must retain the uniquely rebound evidence')
let reviewed = 0
extractor.reviewRelations = async ({ candidates, units }) => {
  assert(candidates.length === 1 && candidates[0].edge.relation === 'not_is', 'review only the fixture negative relation')
  assert(units.length === 1 && units[0].text === uniqueSource, 'review must receive exact original source spelling')
  assert(candidates[0].edge.evidence.some(item => item.quote === '"感觉懂了"并不是明确的行为目标'), 'review must receive rebound evidence')
  reviewed++
  return { verdicts: [{ id: candidates[0].id, verdict: 'supported', reason: 'Synthetic fixture reviewer', evidence: candidates[0].edge.evidence }] }
}
const uniqueStarted = await handlers.get('extract')({ title: 'typography-unique', text: uniqueSource })
const uniqueDone = await waitTask(uniqueStarted.taskId)
assert(uniqueDone.status === 'succeeded', 'unique typography extraction failed: ' + JSON.stringify(uniqueDone))
const uniqueNode = uniqueDone.result.nodes.find((node) => node.id === 'n1')
const uniqueEdge = uniqueDone.result.edges.find((edge) => edge.fromNodeId === 'n1' && edge.toNodeId === 'n2' && edge.relation === 'not_is')
assert(uniqueNode && uniqueNode.groundingStatus === 'grounded', 'unique typography drift did not become grounded')
assert(uniqueNode.quote === '"感觉懂了"', 'node quote was not rebound to the exact source spelling: ' + JSON.stringify(uniqueNode && uniqueNode.quote))
assert(uniqueNode.evidence.some((item) => item.quote === '"感觉懂了"'), 'node evidence did not preserve exact source quote')
assert(uniqueEdge && uniqueEdge.evidence.some((item) => item.quote === '"感觉懂了"并不是明确的行为目标'), 'relation evidence was dropped instead of uniquely rebound')
assert(reviewed === 1, 'typographic repair must not bypass independent relation review')

mode = 'ambiguous'
const ambiguousSource = '"感觉懂了"不是目标；再次说"感觉懂了"也不是目标。'
const ambiguousStarted = await handlers.get('extract')({ title: 'typography-ambiguous', text: ambiguousSource })
const ambiguousDone = await waitTask(ambiguousStarted.taskId)
assert(ambiguousDone.status === 'succeeded', 'ambiguous typography extraction failed: ' + JSON.stringify(ambiguousDone))
const ambiguousNode = ambiguousDone.result.nodes.find((node) => node.id === 'n1')
assert(ambiguousNode && ambiguousNode.groundingStatus === 'unsupported', 'ambiguous typography match was incorrectly authenticated')
assert(Array.isArray(ambiguousNode.evidence) && ambiguousNode.evidence.length === 0, 'ambiguous typography match received evidence')
assert(reviewed === 1, 'ambiguous node evidence must not create a relation candidate')

console.log(JSON.stringify({ ok: true, uniqueRebound: true, ambiguousFailClosed: true, unreviewedRelationWithheld: true }))
