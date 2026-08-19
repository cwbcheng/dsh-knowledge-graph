import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'

function assert(condition, message) { if (!condition) throw new Error(message) }
const handlers = new Map()
const coverageCalls = []
let producerPrompt = ''
const extractor = {
  async extractChunk({ title, systemPrompt }) {
    producerPrompt = systemPrompt
    if (title === 'semantic-closure') {
      return {
        summary: '目标应驱动方法',
        nodes: [{ id: 'n1', type: 'claim', text: '真正的问题在于学习方法缺少正确行为目标驱动', quote: '真正的问题在于学习方法缺少正确行为目标驱动。', paragraph: 1 }],
        edges: [],
      }
    }
    throw new Error('unexpected title: ' + title)
  },
  async reviewCoverage(args) {
    coverageCalls.push(args)
    assert(args.systemPrompt.includes('稳定概念锚点'), 'coverage does not review concept anchors')
    assert(args.systemPrompt.includes('防误推理'), 'coverage does not review anti-inference boundaries')
    assert(args.systemPrompt.includes('当前范围尚未给出具体答案'), 'coverage does not preserve forward-reference scope')
    return {
      nodes: [
        { id: 'm1', type: 'claim', text: '以教促学、联想记忆、保持专注和定期复习等学习手段本身并非有问题', quote: '这些学习手段本身并非有问题。', paragraph: 0 },
        { id: 'm2', type: 'concept', text: '可验证的行为目标', quote: '可验证的行为目标', paragraph: 2 },
        { id: 'm3', type: 'concept', text: '学习系统', quote: '学习系统', paragraph: 3 },
        { id: 'm4', type: 'claim', text: '当前序言尚未给出可验证的行为目标的具体内容，该问题将在后文回答', quote: '本书将在后文回答可验证的行为目标具体是什么。', paragraph: 2 },
      ],
      edges: [
        { fromNodeId: 'm1', toNodeId: 'n1', relation: 'supports', evidence: [{ paragraph: 0, quote: '这些学习手段本身并非有问题。' }, { paragraph: 1, quote: '真正的问题在于学习方法缺少正确行为目标驱动。' }] },
      ],
    }
  },
  async weaveRelations() { return { edges: [] } },
}
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({ get(name) { return name === 'kgExtractor' ? extractor : null }, interval() { return () => {} } })
async function waitTask(taskId) {
  for (let i = 0; i < 200; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish')
}
const source = [
  '这些学习手段本身并非有问题。',
  '真正的问题在于学习方法缺少正确行为目标驱动。',
  '可验证的行为目标是本书反复讨论的核心对象。本书将在后文回答可验证的行为目标具体是什么。',
  '本书旨在重建学习系统。',
].join('\n\n')
const start = await handlers.get('extract')({ title: 'semantic-closure', text: source })
const done = await waitTask(start.taskId)
assert(done.status === 'succeeded', 'semantic closure extraction failed: ' + JSON.stringify(done))
assert(coverageCalls.length === 1, 'explicit boundary/forward gap did not trigger one bounded coverage review')
for (const expected of ['学习手段本身并非有问题', '可验证的行为目标', '学习系统', '尚未给出可验证的行为目标的具体内容']) {
  assert(done.result.nodes.some((node) => String(node.text || '').includes(expected)), 'missing semantic closure node: ' + expected)
}
assert(producerPrompt.includes('被两个以上独立核心命题反复引用'), 'producer does not preserve stable concept anchors')
assert(producerPrompt.includes('负向结果、失败情形或对照情形如果仍在帮助说明/支持原命题，仍用 example'), 'counter-example role is still too broad')
assert(producerPrompt.includes('不要虚构答案'), 'forward-reference scope contract is missing')

const contrastText = '如果不明确目标，运动可能被执行成减肥。'
const contrastGraph = { nodes: [{ id: 'c1', type: 'counter_example', text: '不明确目标时运动可能变成减肥', quote: contrastText, paragraph: 0 }], edges: [] }
const quick = await handlers.get('verify-graph')({ text: contrastText, graph: contrastGraph, mode: 'quick' })
assert(quick && quick.report && quick.report.issues.some((issue) => issue.invariantCode === 'counter_example_without_target'), 'quick check did not flag a counter_example without a challenged proposition')

const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
assert(hostSource.includes('知识图解释覆盖复核器'), 'coverage pass was not generalized narrowly to explanatory coverage')
console.log(JSON.stringify({ ok: true, semanticClosure: true, counterExampleGuard: true, schemaFrozen: true }))
