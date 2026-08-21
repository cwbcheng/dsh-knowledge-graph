import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const coverageCalls = []
const extractor = {
  async extractChunk({ title }) {
    if (title === 'mechanism-coverage') {
      return {
        summary: '感觉驱动最终形成高消耗低回报',
        nodes: [{ id: 'n1', type: 'claim', text: '最终学得越多，负担越重，形成高消耗、低回报', quote: '最终学得越多，负担越重，形成高消耗、低回报。', paragraph: 5 }],
        edges: [],
      }
    }
    if (title === 'coverage-partial-prune') {
      return {
        summary: '预测支撑日常行动',
        nodes: [{ id: 'n1', type: 'claim', text: '预测能力支撑着人的行动', quote: '预测能力支撑着人的行动。', paragraph: 0 }],
        edges: [],
      }
    }
    if (title === 'zero-section-coverage') {
      return {
        summary: '第二部分已有内容',
        nodes: [{ id: 'z1', type: 'claim', text: '当前部分已有节点。', quote: '当前部分已有节点。', paragraph: 3 }],
        edges: [],
      }
    }
    if (title === 'plain-fact') {
      return { summary: '直接事实', nodes: [{ id: 'f1', type: 'fact', text: '项目包含三个文件', quote: '项目包含三个文件。', paragraph: 0 }], edges: [] }
    }
    throw new Error('unexpected title: ' + title)
  },
  async reviewCoverage(args) {
    coverageCalls.push(args)
    assert(args.systemPrompt.includes('只补漏，不重做'), 'coverage pass is not scoped as missing-node repair')
    assert(args.systemPrompt.includes('纯修辞、只重复已有原则的比喻优先省略'), 'example selection does not prefer mechanism-bearing examples')
    assert(args.prompt.includes('首轮已接受节点'), 'coverage reviewer did not receive the accepted graph')
    if (args.title === 'zero-section-coverage') {
      assert(args.prompt.includes('完全未覆盖 section 候选'), 'zero-node section was not surfaced to coverage review')
      assert(args.prompt.includes('第一部分'), 'zero-node section title was not surfaced')
      assert(args.systemPrompt.includes('显式流程步骤') && args.systemPrompt.includes('不得把可能性、能力或条件性表述提升为无条件事实'), 'coverage prompt does not protect process-step semantic strength')
      return {
        nodes: [{ id: 'm1', type: 'claim', text: '这一部分介绍颜色标记体系。', quote: '这一部分介绍颜色标记体系。', paragraph: 1 }],
        edges: [],
      }
    }
    if (args.title === 'coverage-partial-prune') {
      return {
        nodes: [
          { id: 'm1', type: 'example', text: '不经意的翻页动作基于大脑预测翻页后会看到后续内容而采取', quote: '哪怕是不经意的翻页动作，也是基于大脑预测翻页后会看到后续内容而采取的行动。', paragraph: 1 },
          { id: 'm2', type: 'claim', text: '这个现象说明预测能力持续参与日常行动', quote: '这个现象可能说明预测能力持续参与日常行动。', paragraph: 2 },
        ],
        edges: [
          { fromNodeId: 'm1', toNodeId: 'n1', relation: 'example', evidence: [{ paragraph: 1, quote: '哪怕是不经意的翻页动作，也是基于大脑预测翻页后会看到后续内容而采取的行动。' }] },
          { fromNodeId: 'm2', toNodeId: 'n1', relation: 'supports', evidence: [{ paragraph: 2, quote: '这个现象可能说明预测能力持续参与日常行动。' }] },
        ],
      }
    }
    return {
      nodes: [
        { id: 'm1', type: 'claim', text: '以感觉懂了驱动学习时，人无法根据明确目标判断学习是否完成', quote: '以感觉懂了驱动学习时，人无法根据明确目标判断学习是否完成。', paragraph: 0 },
        { id: 'm2', type: 'claim', text: '无法判断完成时，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束', quote: '因为无法判断是否完成，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束。', paragraph: 1 },
        { id: 'm3', type: 'claim', text: '学习者容易把记住讲解误认为学会知识', quote: '这样又容易把记住讲解误认为学会知识。', paragraph: 2 },
        { id: 'm4', type: 'claim', text: '学习者无法根据已经完成的程度接着学习', quote: '学习者因此无法根据已经完成的程度接着学习。', paragraph: 3 },
        { id: 'm5', type: 'claim', text: '复习实质上变成重新学习', quote: '于是复习实质上变成重新学习。', paragraph: 4 },
        { id: 'm6', type: 'example', text: '函数定义学习案例', quote: '第一次接触函数定义时，人会反复阅读直到感觉懂了，然后努力记住原话。', paragraph: 6 },
      ],
      edges: [
        { fromNodeId: 'm1', toNodeId: 'm2', relation: 'causes', evidence: [{ paragraph: 1, quote: '因为无法判断是否完成，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束。' }] },
        { fromNodeId: 'm2', toNodeId: 'm3', relation: 'causes', evidence: [{ paragraph: 2, quote: '这样又容易把记住讲解误认为学会知识。' }] },
        { fromNodeId: 'm3', toNodeId: 'm4', relation: 'causes', evidence: [{ paragraph: 3, quote: '学习者因此无法根据已经完成的程度接着学习。' }] },
        { fromNodeId: 'm4', toNodeId: 'm5', relation: 'causes', evidence: [{ paragraph: 4, quote: '于是复习实质上变成重新学习。' }] },
        { fromNodeId: 'm5', toNodeId: 'n1', relation: 'causes', evidence: [{ paragraph: 5, quote: '最终学得越多，负担越重，形成高消耗、低回报。' }] },
        { fromNodeId: 'm6', toNodeId: 'm3', relation: 'example', evidence: [{ paragraph: 6, quote: '第一次接触函数定义时，人会反复阅读直到感觉懂了，然后努力记住原话。' }] },
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
  throw new Error('task did not finish: ' + taskId)
}

const mechanismText = [
  '以感觉懂了驱动学习时，人无法根据明确目标判断学习是否完成。',
  '因为无法判断是否完成，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束。',
  '这样又容易把记住讲解误认为学会知识。',
  '学习者因此无法根据已经完成的程度接着学习。',
  '于是复习实质上变成重新学习。',
  '最终学得越多，负担越重，形成高消耗、低回报。',
  '第一次接触函数定义时，人会反复阅读直到感觉懂了，然后努力记住原话。',
].join('\n\n')
const started = await handlers.get('extract')({ title: 'mechanism-coverage', text: mechanismText })
const completed = await waitTask(started.taskId)
assert(completed.status === 'succeeded', 'mechanism coverage extraction failed: ' + JSON.stringify(completed))
assert(coverageCalls.length === 1, 'mechanism-dense batch did not receive exactly one bounded coverage review')
assert(completed.result.nodes.length === 7, 'missing mechanism nodes were not recovered: ' + JSON.stringify(completed.result.nodes))
for (const text of ['无法根据明确目标判断学习是否完成', '依赖读几遍、抄几遍、画图等学习仪式', '记住讲解误认为学会知识', '无法根据已经完成的程度接着学习', '复习实质上变成重新学习', '函数定义学习案例']) {
  assert(completed.result.nodes.some((node) => String(node.text || '').includes(text)), 'missing recovered knowledge: ' + text)
}
const initial = completed.result.generation && completed.result.generation.initial
const coverage = completed.result.generation && completed.result.generation.coverage
assert(initial && initial.nodes === 1 && initial.edges === 0, 'primary-pass metadata is incorrect: ' + JSON.stringify(initial))
assert(coverage && coverage.attemptedBatches === 1 && coverage.repairedBatches === 1 && coverage.addedNodes === 6 && coverage.prunedNodes === 0, 'coverage metadata is incorrect: ' + JSON.stringify(coverage))
assert(completed.result.edges.some((edge) => edge.fromNodeId === 'm5' && edge.toNodeId === 'n1' && edge.relation === 'causes'), 'recovered mechanism chain is not connected to the original endpoint')
assert(completed.result.edges.some((edge) => edge.fromNodeId === 'm6' && edge.toNodeId === 'm3' && edge.relation === 'example'), 'mechanism-bearing function example was not integrated')

const partialText = [
  '预测能力支撑着人的行动。',
  '哪怕是不经意的翻页动作，也是基于大脑预测翻页后会看到后续内容而采取的行动。',
  '这个现象可能说明预测能力持续参与日常行动。',
].join('\n\n')
const partialStart = await handlers.get('extract')({ title: 'coverage-partial-prune', text: partialText })
const partial = await waitTask(partialStart.taskId)
assert(partial.status === 'succeeded', 'coverage partial-prune extraction failed: ' + JSON.stringify(partial))
assert(partial.result.nodes.some((node) => node.id === 'm1'), 'valid coverage candidate was lost with the drifted sibling')
assert(!partial.result.nodes.some((node) => node.id === 'm2'), 'semantic-strength-drift coverage node was admitted')
assert(partial.result.edges.some((edge) => edge.fromNodeId === 'm1' && edge.toNodeId === 'n1' && edge.relation === 'example'), 'valid coverage edge was lost after pruning')
assert(!partial.result.edges.some((edge) => edge.fromNodeId === 'm2' || edge.toNodeId === 'm2'), 'incident edge of drifted coverage node survived pruning')
assert((partial.result.warnings || []).some((warning) => String(warning).includes('coverage_pruned:node_semantic_strength_drift:m2')), 'coverage pruning was not auditable in warnings')
assert(!(partial.result.warnings || []).some((warning) => String(warning).includes('coverage_review_failed')), 'one prunable drift incorrectly failed the whole coverage review')
const partialInitial = partial.result.generation && partial.result.generation.initial
const partialCoverage = partial.result.generation && partial.result.generation.coverage
assert(partialInitial && partialInitial.nodes === 1 && partialInitial.edges === 0, 'partial-prune primary-pass metadata is incorrect: ' + JSON.stringify(partialInitial))
assert(partialCoverage && partialCoverage.attemptedBatches === 1 && partialCoverage.repairedBatches === 1 && partialCoverage.addedNodes === 1 && partialCoverage.addedEdges === 1 && partialCoverage.prunedNodes === 1, 'partial-prune coverage metadata is incorrect: ' + JSON.stringify(partialCoverage))

const zeroSectionText = [
  '第一部分',
  '这一部分介绍颜色标记体系。',
  '第二部分',
  '当前部分已有节点。',
].join('\n\n')
const zeroSectionStart = await handlers.get('extract')({ title: 'zero-section-coverage', text: zeroSectionText })
const zeroSection = await waitTask(zeroSectionStart.taskId)
assert(zeroSection.status === 'succeeded', 'zero-section coverage extraction failed: ' + JSON.stringify(zeroSection))
const zeroSectionCall = coverageCalls.find((call) => call.title === 'zero-section-coverage')
assert(zeroSectionCall, 'zero-node section did not trigger the existing coverage pass')
assert(zeroSection.result.nodes.some((node) => node.id === 'm1' && node.sectionTitle === '第一部分'), 'missing section knowledge was not recovered into the correct section')
const zeroSectionCoverage = zeroSection.result.generation && zeroSection.result.generation.coverage
assert(zeroSectionCoverage && zeroSectionCoverage.attemptedBatches === 1 && zeroSectionCoverage.repairedBatches === 1 && zeroSectionCoverage.addedNodes === 1, 'zero-section coverage metadata is incorrect: ' + JSON.stringify(zeroSectionCoverage))

const beforePlain = coverageCalls.length
const plainStart = await handlers.get('extract')({ title: 'plain-fact', text: '项目包含三个文件。' })
const plain = await waitTask(plainStart.taskId)
assert(plain.status === 'succeeded', 'plain extraction failed')
assert(coverageCalls.length === beforePlain, 'non-mechanism text triggered an unnecessary second model pass')

console.log(JSON.stringify({ ok: true, recoveredNodes: coverage.addedNodes, boundedReview: true, partialPrune: true, zeroSectionCoverage: true, plainSkipped: true }))
