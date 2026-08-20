import { runGraphQaBenchmark } from './kg-qa-benchmark.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const graph = {
  summary: '学习需要可验证目标；目标缺失会导致完成度判断失败和重复学习。',
  nodes: [
    { id: 'goal', type: 'concept', text: '可验证的行为目标' },
    { id: 'no-goal', type: 'claim', text: '缺少可验证的行为目标会使学习者无法判断是否完成学习。' },
    { id: 'ritual', type: 'claim', text: '无法判断是否完成学习时，只能依赖阅读、抄写等仪式宣告结束。' },
    { id: 'progress', type: 'claim', text: '缺少完成度标准会使学习者无法根据完成度继续学习。' },
    { id: 'relearn', type: 'claim', text: '复习实质上会变成重新学习。' },
    { id: 'distort', type: 'claim', text: '不知道具体的可验证目标，会使学习方法执行成低效方法。' },
    { id: 'system', type: 'concept', text: '学习系统' },
    { id: 'muscle', type: 'example', text: '增肌与肌纤维微损伤案例' },
    { id: 'principle', type: 'claim', text: '正确目标会约束和驱动手段的执行方式。' },
    { id: 'weight', type: 'example', text: '如果目标不明确，运动可能被执行成减肥。' }
  ],
  edges: [
    { fromNodeId: 'no-goal', toNodeId: 'ritual', relation: 'causes' },
    { fromNodeId: 'no-goal', toNodeId: 'progress', relation: 'causes' },
    { fromNodeId: 'progress', toNodeId: 'relearn', relation: 'causes' },
    { fromNodeId: 'muscle', toNodeId: 'principle', relation: 'analogy' }
  ]
}

const cases = [
  {
    id: 'path', question: '为什么复习会变成重学？', category: 'answerability', kind: 'path',
    from: { all: ['无法根据完成度', ['接着学习', '继续学习']] },
    to: { all: ['复习', ['重学', '重新学习']] }, relations: ['causes']
  },
  { id: 'ritual', question: '为什么依赖仪式？', category: 'answerability', kind: 'path', from: { all: ['无法判断', '完成学习'] }, to: { any: ['仪式'] }, relations: ['causes'] },
  {
    id: 'atomic-or-path', question: '为什么方法会执行走形？', category: 'answerability', kind: 'any-of',
    options: [
      { kind: 'node', selector: { all: [['不知道具体', '缺少'], ['可验证目标', '可验证的目标'], ['执行成低效', '执行走形']] } },
      { kind: 'path', from: { all: ['不存在的起点'] }, to: { all: ['不存在的终点'] }, relations: ['causes'] }
    ]
  },
  { id: 'unknown', question: '目标具体是什么？', category: 'unknown-calibration', kind: 'unknown', anchor: { any: ['可验证的行为目标'] }, positive: { type: 'definition', all: ['可验证', '行为目标'] } },
  { id: 'analogy', question: '增肌案例是什么角色？', category: 'faithfulness', kind: 'relation', from: { any: ['肌纤维微损伤'] }, to: { any: ['目标', '手段'] }, relations: ['analogy'] },
  { id: 'not-counterexample', question: '减肥情形是反例吗？', category: 'forbidden-inference', kind: 'forbidden-node', selector: { type: 'counter_example', all: ['减肥'] } },
  { id: 'anchor', question: '有没有学习系统概念？', category: 'concept-anchor', kind: 'node', selector: { type: 'concept', all: ['学习系统'] } }
]

const result = runGraphQaBenchmark(graph, cases)
assert(result.ok, 'benchmark fixture did not fully pass: ' + JSON.stringify(result.results.filter((r) => !r.pass)))
assert(result.score === 100 && result.semanticScore === 100 && result.trustedScore === 100 && result.total === 7, 'benchmark aggregate score is wrong')
assert(result.categories.answerability.passed === 3, 'answerability metric is wrong')
assert(result.categories['unknown-calibration'].passed === 1, 'unknown calibration metric is wrong')
assert(result.results.find((r) => r.id === 'path').edgeEvidence.includes('progress>relearn:causes'), 'faithful path evidence is missing')
assert(result.results.find((r) => r.id === 'atomic-or-path').matchedKind === 'node', 'atomic proposition was not accepted as alternative evidence')
assert(result.results.find((r) => r.id === 'unknown').verdict === 'insufficient', 'unknown answer was not calibrated as insufficient')
assert(result.results.find((r) => r.id === 'unknown').evidence.includes('goal'), 'unknown calibration did not preserve the topic anchor as evidence')

const unsupportedGraph = {
  ...graph,
  nodes: graph.nodes.map((node) => node.id === 'relearn' ? { ...node, groundingStatus: 'unsupported' } : node),
}
const trustResult = runGraphQaBenchmark(unsupportedGraph, cases)
assert(trustResult.semanticScore === 100, 'semantic score should still describe the full graph')
assert(trustResult.trustedScore < 100 && trustResult.score === trustResult.trustedScore, 'unsupported node still earned trusted benchmark credit')
assert(trustResult.semanticResults.find((r) => r.id === 'path').pass, 'semantic result unexpectedly lost the unsupported path')
assert(!trustResult.results.find((r) => r.id === 'path').pass, 'trusted result used an unsupported path endpoint')
assert(trustResult.excludedUnsupportedNodeIds.includes('relearn'), 'benchmark did not report excluded unsupported evidence')
assert(!trustResult.ok, 'benchmark should not be green when trusted evidence fails')
console.log(JSON.stringify({ ok: true, score: result.score, semanticScore: result.semanticScore, trustedScore: result.trustedScore, categories: result.categories }))
