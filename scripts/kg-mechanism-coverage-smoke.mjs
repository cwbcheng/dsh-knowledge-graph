import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'
import { runGraphQaBenchmark } from './kg-qa-benchmark.mjs'

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
    if (title === 'explicit-limitation-coverage') {
      return {
        summary: '实时输入限制缓存复用',
        nodes: [
          { id: 'l1', type: 'claim', text: '缓存只能处理已经见过的相同输入。', quote: '因为缓存只能处理已经见过的相同输入', paragraph: 0 },
          { id: 'l2', type: 'claim', text: '实时输入几乎都是未见输入。', quote: '实时输入几乎都是未见输入。', paragraph: 0 },
        ],
        edges: [],
      }
    }
    if (title === 'experience-prediction-limit') {
      return {
        summary: '经验预测受未见现象限制',
        nodes: [
          { id: 'e1', type: 'claim', text: '经验预测只能用于处理已见现象该如何应对。', quote: '因为经验预测只能用于处理已见现象该如何应对。', paragraph: 0 },
          { id: 'e2', type: 'claim', text: '当人类与自然直接交互时，处处都是未见现象。', quote: '可当人类与自然直接交互时，处处都是未见现象。', paragraph: 0 },
          { id: 'b1', type: 'fact', text: '物体的微观粒子排列状态每时每刻都在变化。', quote: '物体的微观粒子排列状态每时每刻都在变化。', paragraph: 1 },
          { id: 'b2', type: 'claim', text: '在物质世界中遇到完全相同现象的概率几乎为零。', quote: '在物质世界中遇到完全相同现象的概率几乎为零。', paragraph: 2 },
          { id: 'b3', type: 'claim', text: '由于在物质世界中每次遭遇的现象均为未见，上一刻的经验无法应用于未来。', quote: '由于在物质世界中每次遭遇的现象均为未见，上一刻的经验无法应用于未来。', paragraph: 3 },
        ],
        edges: [
          { fromNodeId: 'b1', toNodeId: 'b2', relation: 'supports', evidence: [{ paragraph: 1, quote: '物体的微观粒子排列状态每时每刻都在变化。' }, { paragraph: 2, quote: '在物质世界中遇到完全相同现象的概率几乎为零。' }] },
          { fromNodeId: 'b2', toNodeId: 'b3', relation: 'supports', evidence: [{ paragraph: 2, quote: '在物质世界中遇到完全相同现象的概率几乎为零。' }, { paragraph: 3, quote: '由于在物质世界中每次遭遇的现象均为未见，上一刻的经验无法应用于未来。' }] },
        ],
      }
    }
    if (title === 'covered-subject-with-preposition') {
      return { summary: '限制结论已覆盖', nodes: [{ id: 'c2', type: 'claim', text: '基于规则的方法在数据持续变化时无法继续发挥作用。', quote: '基于规则的方法看似有效，然而在数据持续变化时无法继续发挥作用。', paragraph: 0 }], edges: [] }
    }
    if (title === 'covered-limitation') {
      return { summary: '限制结论已覆盖', nodes: [{ id: 'c1', type: 'claim', text: '旧缓存策略在数据持续变化时行不通。', quote: '旧缓存策略看似有效', paragraph: 0 }], edges: [] }
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
    if (args.title === 'explicit-limitation-coverage') {
      assert(args.graph.nodes.some((node) => String(node.text || '').includes('缓存复用在输入持续变化的实时系统中行不通')), 'deterministic limitation seed was not admitted before model review')
      assert(!args.prompt.includes('missing=行不通/失效/无法发挥'), 'deterministically recovered limitation was still reported as missing')
      assert(args.systemPrompt.includes('禁止把原因、条件和结果重新压成一个总结节点'), 'coverage contract does not protect atomic limitation conclusions')
      return { nodes: [], edges: [] }
    }
    if (args.title === 'experience-prediction-limit') {
      assert(args.graph.nodes.some((node) => String(node.text || '') === '经验预测在与自然直接交互的物质世界中行不通。'), 'experience-prediction limitation seed lost the named method or domain condition')
      return { nodes: [], edges: [] }
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
  async weaveRelations(args) {
    if (args.title === 'experience-prediction-limit') {
      const limitation = args.nodes.find((node) => String(node.text || '') === '经验预测在与自然直接交互的物质世界中行不通。')
      assert(limitation, 'relation weaver did not receive the recovered limitation node')
      const basisId = ['b3', 'b2', 'b1'].find((id) => args.prompt.includes(id + '=>' + limitation.id))
      assert(basisId, 'relation-weave recall omitted every physical-world basis-to-limitation candidate')
      const evidenceById = {
        b1: { paragraph: 1, quote: '物体的微观粒子排列状态每时每刻都在变化。' },
        b2: { paragraph: 2, quote: '在物质世界中遇到完全相同现象的概率几乎为零。' },
        b3: { paragraph: 3, quote: '由于在物质世界中每次遭遇的现象均为未见，上一刻的经验无法应用于未来。' },
      }
      return {
        edges: [{
          fromNodeId: basisId,
          toNodeId: limitation.id,
          relation: 'supports',
          evidence: [
            { paragraph: 0, quote: '经验预测符合我们的直觉，然而在与自然直接交互的物质世界中，这种方式却行不通。因为经验预测只能用于处理已见现象该如何应对。可当人类与自然直接交互时，处处都是未见现象。' },
            evidenceById[basisId],
          ],
        }],
      }
    }
    return { edges: [] }
  },
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

const limitationText = '缓存复用符合直觉，然而在输入持续变化的实时系统中，这种方式却行不通。因为缓存只能处理已经见过的相同输入，而实时输入几乎都是未见输入。'
const limitationStart = await handlers.get('extract')({ title: 'explicit-limitation-coverage', text: limitationText })
const limitation = await waitTask(limitationStart.taskId)
assert(limitation.status === 'succeeded', 'explicit limitation coverage extraction failed: ' + JSON.stringify(limitation))
const limitationNode = limitation.result.nodes.find((node) => String(node.text || '').includes('缓存复用在输入持续变化的实时系统中行不通'))
assert(limitationNode, 'explicit limitation conclusion was not recovered with its named method anchor')
assert((limitation.result.warnings || []).some((warning) => String(warning).includes('coverage_seed:explicit_limitation')), 'deterministic limitation recovery is not auditable')
const limitationCoverage = limitation.result.generation && limitation.result.generation.coverage
assert(limitationCoverage && limitationCoverage.attemptedBatches === 1 && limitationCoverage.addedNodes === 1 && limitationCoverage.prunedNodes === 0, 'explicit limitation coverage metadata is incorrect: ' + JSON.stringify(limitationCoverage))

const experienceLimitationText = [
  '经验预测符合我们的直觉，然而在与自然直接交互的物质世界中，这种方式却行不通。因为经验预测只能用于处理已见现象该如何应对。可当人类与自然直接交互时，处处都是未见现象。',
  '物体的微观粒子排列状态每时每刻都在变化。',
  '在物质世界中遇到完全相同现象的概率几乎为零。',
  '由于在物质世界中每次遭遇的现象均为未见，上一刻的经验无法应用于未来。',
].join('\n\n')
const experienceLimitationStart = await handlers.get('extract')({ title: 'experience-prediction-limit', text: experienceLimitationText })
const experienceLimitation = await waitTask(experienceLimitationStart.taskId)
assert(experienceLimitation.status === 'succeeded', 'experience-prediction limitation extraction failed: ' + JSON.stringify(experienceLimitation))
const experienceLimitationNode = experienceLimitation.result.nodes.find((node) => String(node.text || '') === '经验预测在与自然直接交互的物质世界中行不通。')
assert(experienceLimitationNode, 'frozen QA limitation conclusion was not recovered as an atomic named claim')
assert(experienceLimitation.result.edges.some((edge) => ['b1', 'b2', 'b3'].includes(edge.fromNodeId) && edge.toNodeId === experienceLimitationNode.id && edge.relation === 'supports'), 'physical-world basis was not woven into the limitation conclusion: ' + JSON.stringify({ edges: experienceLimitation.result.edges, warnings: experienceLimitation.result.warnings, connectivity: experienceLimitation.result.generation && experienceLimitation.result.generation.connectivity }))
const frozenCases = JSON.parse(readFileSync(new URL('./fixtures/world-recognition-part1-qa-cases-calibrated-v2.json', import.meta.url), 'utf8'))
const experienceCase = frozenCases.find((item) => item.id === 'experience-prediction-limit')
const experienceQa = runGraphQaBenchmark(experienceLimitation.result, [experienceCase])
assert(experienceQa.passed === 1, 'recovered graph still fails the frozen experience-prediction-limit QA case: ' + JSON.stringify(experienceQa))

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

const beforeCoveredLimitation = coverageCalls.length
const coveredLimitationStart = await handlers.get('extract')({ title: 'covered-limitation', text: '旧缓存策略看似有效，然而在数据持续变化时无法继续发挥作用。' })
const coveredLimitation = await waitTask(coveredLimitationStart.taskId)
assert(coveredLimitation.status === 'succeeded', 'covered limitation extraction failed')
assert(coverageCalls.length === beforeCoveredLimitation, 'cross-wording covered limitation or “然而在” false boundary triggered a redundant model pass')

const beforePrepositionSubject = coverageCalls.length
const prepositionSubjectStart = await handlers.get('extract')({ title: 'covered-subject-with-preposition', text: '基于规则的方法看似有效，然而在数据持续变化时无法继续发挥作用。' })
const prepositionSubject = await waitTask(prepositionSubjectStart.taskId)
assert(prepositionSubject.status === 'succeeded', 'preposition-bearing limitation extraction failed')
assert(coverageCalls.length === beforePrepositionSubject, 'method name containing “于” triggered duplicate deterministic limitation coverage')
assert(prepositionSubject.result.nodes.length === 1 && prepositionSubject.result.nodes[0].id === 'c2', 'covered preposition-bearing limitation was duplicated')

const beforePlain = coverageCalls.length
const plainStart = await handlers.get('extract')({ title: 'plain-fact', text: '项目包含三个文件。' })
const plain = await waitTask(plainStart.taskId)
assert(plain.status === 'succeeded', 'plain extraction failed')
assert(coverageCalls.length === beforePlain, 'non-mechanism text triggered an unnecessary second model pass')

const noWeaveHandlers = new Map()
const noWeaveExtractor = {
  async extractChunk({ title }) {
    if (title === 'no-weaver-positive') {
      return {
        summary: 'deterministic relation seed',
        nodes: [
          { id: 'd1', type: 'claim', text: '缓存只能处理已经见过的相同输入。', quote: '因为缓存只能处理已经见过的相同输入', paragraph: 0 },
          { id: 'd2', type: 'claim', text: '实时输入几乎都是未见输入。', quote: '实时输入几乎都是未见输入。', paragraph: 0 },
        ],
        edges: [],
      }
    }
    if (title === 'no-weaver-negative') {
      return {
        summary: 'unrelated same-paragraph claims',
        nodes: [
          { id: 'u1', type: 'claim', text: '天气原因使比赛取消。', quote: '由于天气原因，比赛取消。', paragraph: 0 },
          { id: 'u2', type: 'claim', text: '缓存策略在高并发时失效。', quote: '但是缓存策略在高并发时失效。', paragraph: 0 },
        ],
        edges: [],
      }
    }
    if (title === 'multiple-limitations') {
      return {
        summary: 'multiple explicit limitations',
        nodes: [
          { id: 'x1', type: 'claim', text: '缓存复用只能处理相同请求。', quote: '因为缓存复用只能处理相同请求。', paragraph: 0 },
          { id: 'x2', type: 'claim', text: '规则匹配只覆盖已见模式。', quote: '因为规则匹配只覆盖已见模式。', paragraph: 0 },
        ],
        edges: [],
      }
    }
    throw new Error('unexpected no-weaver title: ' + title)
  },
}
globalThis.harness = { handle(name, handler) { noWeaveHandlers.set(name, handler) } }
hostPlugin().apply({ get(name) { return name === 'kgExtractor' ? noWeaveExtractor : null }, interval() { return () => {} } })
const waitNoWeaveTask = async (taskId) => {
  for (let i = 0; i < 200; i++) {
    const status = await noWeaveHandlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('no-weaver task did not finish: ' + taskId)
}
const noWeaverPositiveText = '缓存复用符合直觉，然而在输入持续变化的实时系统中，这种方式却行不通。因为缓存只能处理已经见过的相同输入，而实时输入几乎都是未见输入。'
const noWeaverPositiveStart = await noWeaveHandlers.get('extract')({ title: 'no-weaver-positive', text: noWeaverPositiveText })
const noWeaverPositive = await waitNoWeaveTask(noWeaverPositiveStart.taskId)
assert(noWeaverPositive.status === 'succeeded', 'deterministic no-weaver limitation extraction failed')
const noWeaverLimitation = noWeaverPositive.result.nodes.find((node) => String(node.text || '').includes('缓存复用在输入持续变化的实时系统中行不通'))
assert(noWeaverLimitation, 'deterministic limitation node still depends on a coverage-review service')
assert(!noWeaverPositive.result.edges.some((edge) => edge.toNodeId === noWeaverLimitation.id), 'no-weaver mode invented a limitation relation without model-reviewed evidence')
const noWeaverNegativeStart = await noWeaveHandlers.get('extract')({ title: 'no-weaver-negative', text: '由于天气原因，比赛取消。但是缓存策略在高并发时失效。' })
const noWeaverNegative = await waitNoWeaveTask(noWeaverNegativeStart.taskId)
assert(noWeaverNegative.status === 'succeeded', 'unrelated same-paragraph limitation fixture failed')
assert(!noWeaverNegative.result.edges.some((edge) => edge.fromNodeId === 'u1' && edge.toNodeId === 'u2'), 'unrelated same-paragraph basis was falsely connected to a limitation')
const multipleLimitationsText = '缓存复用符合直觉，然而在持续变化的请求中这种方式行不通。因为缓存复用只能处理相同请求。规则匹配看似合理，但是在新模式不断出现时这种方法失效。因为规则匹配只覆盖已见模式。'
const multipleLimitationsStart = await noWeaveHandlers.get('extract')({ title: 'multiple-limitations', text: multipleLimitationsText })
const multipleLimitations = await waitNoWeaveTask(multipleLimitationsStart.taskId)
assert(multipleLimitations.status === 'succeeded', 'multiple explicit limitation fixture failed')
assert(multipleLimitations.result.nodes.some((node) => String(node.text || '').includes('缓存复用在持续变化的请求中行不通')), 'first named limitation in one unit was not recovered')
assert(multipleLimitations.result.nodes.some((node) => String(node.text || '').includes('规则匹配在新模式不断出现时失效')), 'second named limitation in one unit was not recovered')

console.log(JSON.stringify({ ok: true, recoveredNodes: coverage.addedNodes, boundedReview: true, partialPrune: true, explicitLimitationCoverage: true, experiencePredictionLimit: true, deterministicNoWeaver: true, multipleLimitations: true, relationFalsePositiveGuard: true, zeroSectionCoverage: true, plainSkipped: true }))
