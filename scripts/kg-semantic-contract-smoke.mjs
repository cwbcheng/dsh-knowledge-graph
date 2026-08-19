import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const calls = []
const extractor = async ({ title, attempt, systemPrompt, prompt }) => {
  calls.push({ title, attempt, systemPrompt, prompt })
  if (title === 'semantic-modal') {
    if (attempt === 0) {
      return {
        summary: '模态漂移',
        nodes: [{ id: 'c1', type: 'claim', text: '这是世上最普遍的学习方式', quote: '这可能是世上最普遍的学习方式', paragraph: 0 }],
        edges: [],
      }
    }
    return {
      summary: '模态保真',
      nodes: [{ id: 'c1', type: 'claim', text: '这可能是世上最普遍的学习方式', quote: '这可能是世上最普遍的学习方式', paragraph: 0 }],
      edges: [],
    }
  }
  if (title === 'semantic-relations') {
    return {
      summary: '精确语义关系',
      nodes: [
        { id: 'n1', type: 'concept', text: '学习方法', quote: '学习方法', paragraph: 0 },
        { id: 'n2', type: 'concept', text: '手段', quote: '手段', paragraph: 0 },
        { id: 'n3', type: 'concept', text: '可验证的行为目标', quote: '可验证的行为目标', paragraph: 1 },
        { id: 'n4', type: 'concept', text: '感觉懂了', quote: '感觉懂了', paragraph: 2 },
        { id: 'n5', type: 'concept', text: '学习系统', quote: '学习系统', paragraph: 3 },
        { id: 'n6', type: 'concept', text: '知识基本组成', quote: '知识基本组成', paragraph: 3 },
        { id: 'n7', type: 'example', text: '增肌案例', quote: '增肌案例', paragraph: 4 },
        { id: 'n8', type: 'claim', text: '同一手段需要由正确目标驱动', quote: '同一手段需要由正确目标驱动', paragraph: 4 },
        { id: 'n9', type: 'concept', text: '本书', quote: '本书', paragraph: 5 },
      ],
      edges: [
        { fromNodeId: 'n1', toNodeId: 'n2', relation: 'is_a', evidence: [{ paragraph: 0, quote: '学习方法属于实现学习目的的手段' }] },
        { fromNodeId: 'n1', toNodeId: 'n3', relation: 'driven_by', evidence: [{ paragraph: 1, quote: '学习方法由可验证的行为目标驱动' }] },
        { fromNodeId: 'n4', toNodeId: 'n3', relation: 'not_is', evidence: [{ paragraph: 2, quote: '感觉懂了不是可验证的行为目标' }] },
        { fromNodeId: 'n5', toNodeId: 'n6', relation: 'contains', evidence: [{ paragraph: 3, quote: '学习系统包含知识基本组成' }] },
        { fromNodeId: 'n7', toNodeId: 'n8', relation: 'analogy', evidence: [{ paragraph: 4, quote: '增肌案例通过类比说明：同一手段需要由正确目标驱动' }] },
        { fromNodeId: 'n9', toNodeId: 'n5', relation: 'aims_at', evidence: [{ paragraph: 5, quote: '本书旨在重建学习系统' }] },
      ],
    }
  }
  throw new Error('unexpected fixture ' + title)
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? extractor : null },
  interval() { return () => {} },
})

async function waitTask(taskId) {
  for (let i = 0; i < 160; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const modalStart = await handlers.get('extract')({ title: 'semantic-modal', text: '这可能是世上最普遍的学习方式' })
const modal = await waitTask(modalStart.taskId)
assert(modal.status === 'succeeded', 'modal fixture failed: ' + JSON.stringify(modal))
assert(calls.filter((call) => call.title === 'semantic-modal').length === 2, 'semantic-strength drift did not trigger a bounded retry')
const retry = calls.find((call) => call.title === 'semantic-modal' && call.attempt === 1)
assert(retry && retry.prompt.includes('node_semantic_strength_drift'), 'typed modal-drift feedback was not supplied to retry')
assert(modal.result.nodes[0].type === 'claim' && modal.result.nodes[0].text.includes('可能'), 'author claim was not preserved as a qualified claim')
const contractPrompt = calls.find((call) => call.title === 'semantic-modal').systemPrompt
assert(contractPrompt.includes('一节点一命题'), 'atomic proposition contract is missing')
assert(contractPrompt.includes('claim 主张'), 'claim node type is missing from extraction contract')
assert(contractPrompt.includes('作者的理论判断、经验概括、价值判断不得标 fact'), 'fact/claim boundary is not explicit')
assert(contractPrompt.includes('临时标签、修辞表达不得仅因显眼就升级为 concept'), 'concept promotion guard is missing')
assert(contractPrompt.includes('driven_by') && contractPrompt.includes('analogy') && contractPrompt.includes('aims_at'), 'precise semantic relations are missing from prompt')
assert(contractPrompt.includes('这是安全上限，不是压缩目标'), 'node cap still incentivizes proposition compression')

const relationText = [
  '学习方法属于实现学习目的的手段',
  '学习方法由可验证的行为目标驱动',
  '感觉懂了不是可验证的行为目标',
  '学习系统包含知识基本组成',
  '增肌案例通过类比说明：同一手段需要由正确目标驱动',
  '本书旨在重建学习系统',
].join('\n\n')
const relationStart = await handlers.get('extract')({ title: 'semantic-relations', text: relationText })
const relation = await waitTask(relationStart.taskId)
assert(relation.status === 'succeeded', 'new relation vocabulary was rejected: ' + JSON.stringify(relation))
const rels = new Set(relation.result.edges.map((edge) => edge.relation))
for (const expected of ['is_a', 'driven_by', 'not_is', 'contains', 'analogy', 'aims_at']) {
  assert(rels.has(expected), 'missing accepted semantic relation: ' + expected + ' / ' + JSON.stringify(relation.result.edges))
}

const quick = await handlers.get('verify-graph')({ text: relationText, graph: relation.result, mode: 'quick' })
assert(quick && quick.report && quick.report.metrics.errorCount === 0, 'new semantic relations do not survive quick verification: ' + JSON.stringify(quick && quick.report && quick.report.issues))

const db = await openSqliteStore(':memory:')
const documentId = 'semantic-claim-candidate'
const sourceId = 'source-semantic-claim'
const chunkId = 'chunk-semantic-claim'
db.saveGraph({
  summary: 'claim candidate',
  source: { id: sourceId, documentId, title: 'claim', chars: 4, paragraphCount: 1, chunkCount: 1, sectionCount: 1, sections: [{ id: 's1', title: '全文', startParagraph: 0, endParagraph: 0, summary: '' }] },
  staging: { sourceId, documentId, chunkCount: 1, chunks: [{ chunkId, sourceId, startParagraph: 0, endParagraph: 0, sectionIds: ['s1'], sectionTitles: ['全文'], summary: '', nodeIds: ['c1'], edgeCount: 0, warnings: [] }] },
  nodes: [{ id: 'c1', type: 'claim', text: '作者主张', quote: '作者主张', paragraph: 0, evidence: [{ documentId, sourceId, chunkId, paragraph: 0, quote: '作者主张' }], groundingStatus: 'grounded', entailmentStatus: 'unverified', documentId, sourceId, chunkId }],
  edges: [],
}, { sourceText: '作者主张' })
const claimCandidates = db.listCandidates({ documentId, kind: 'claim', limit: 20 })
assert(claimCandidates.some((candidate) => candidate.nodeId === 'c1' && candidate.type === 'claim'), 'claim nodes are not included in candidate review')
db.close()

console.log(JSON.stringify({
  ok: true,
  modalRetry: true,
  atomicContract: true,
  claimType: true,
  semanticRelations: Array.from(rels).sort(),
  claimCandidate: true,
}))
