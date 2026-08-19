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
    { id: 'unknown', type: 'claim', text: '序言尚未给出可验证行为目标的具体内容，留待后文展开。' },
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
  { id: 'path', question: '为什么复习会变成重学？', category: 'answerability', kind: 'path', from: { all: ['无法根据完成度', '继续学习'] }, to: { all: ['复习', '重新学习'] }, relations: ['causes'] },
  { id: 'ritual', question: '为什么依赖仪式？', category: 'answerability', kind: 'path', from: { all: ['无法判断', '完成学习'] }, to: { any: ['仪式'] }, relations: ['causes'] },
  { id: 'unknown', question: '目标具体是什么？', category: 'unknown-calibration', kind: 'unknown', guard: { any: ['尚未给出', '留待后文'] }, positive: { type: 'definition', all: ['可验证', '行为目标'] } },
  { id: 'analogy', question: '增肌案例是什么角色？', category: 'faithfulness', kind: 'relation', from: { any: ['肌纤维微损伤'] }, to: { any: ['目标', '手段'] }, relations: ['analogy'] },
  { id: 'not-counterexample', question: '减肥情形是反例吗？', category: 'forbidden-inference', kind: 'forbidden-node', selector: { type: 'counter_example', all: ['减肥'] } },
  { id: 'anchor', question: '有没有学习系统概念？', category: 'concept-anchor', kind: 'node', selector: { type: 'concept', all: ['学习系统'] } }
]

const result = runGraphQaBenchmark(graph, cases)
assert(result.ok, 'benchmark fixture did not fully pass: ' + JSON.stringify(result.results.filter((r) => !r.pass)))
assert(result.score === 100 && result.total === 6, 'benchmark aggregate score is wrong')
assert(result.categories.answerability.passed === 2, 'answerability metric is wrong')
assert(result.categories['unknown-calibration'].passed === 1, 'unknown calibration metric is wrong')
assert(result.results.find((r) => r.id === 'path').edgeEvidence.includes('progress>relearn:causes'), 'faithful path evidence is missing')
assert(result.results.find((r) => r.id === 'unknown').verdict === 'insufficient', 'unknown answer was not calibrated as insufficient')
console.log(JSON.stringify({ ok: true, score: result.score, categories: result.categories }))
