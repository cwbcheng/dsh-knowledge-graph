import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const extractCalls = []
const coverageCalls = []
const weaveCalls = []

const counterText = '如果不明确目标，运动可能被执行成减肥。'
const boundaryText = '并非这些学习手段本身有问题，而是这些手段缺少正确行为目标驱动。'
const analogyText = '任何手段都必须由正确的行为目标驱动，否则执行会走形。拿增肌来说，运动只有以肌纤维微损伤为目标才能增肌。'

const extractor = {
  async extractChunk(args) {
    extractCalls.push({ title: args.title, attempt: args.attempt, prompt: args.prompt })
    if (args.title === 'counter-role-hardening') {
      if (args.attempt === 0) {
        return {
          summary: '错误角色候选',
          nodes: [{ id: 'c1', type: 'counter_example', text: '不明确目标时运动可能被执行成减肥', quote: counterText, paragraph: 0 }],
          edges: [],
        }
      }
      return {
        summary: '修正后的对照案例',
        nodes: [{ id: 'c1', type: 'example', text: '不明确目标时运动可能被执行成减肥', quote: counterText, paragraph: 0 }],
        edges: [],
      }
    }
    if (args.title === 'coverage-text-authority') {
      return {
        summary: '防误推理边界',
        nodes: [{
          id: 'b1',
          type: 'claim',
          text: '真正的问题是这些手段缺少正确行为目标驱动',
          // The quote contains the omitted boundary, but the semantic text does not.
          // Coverage must not treat provenance text as if the boundary were represented.
          quote: boundaryText,
          paragraph: 0,
        }],
        edges: [],
      }
    }
    if (args.title === 'analogy-role-hardening') {
      return {
        summary: '跨域类比说明目标驱动原则',
        nodes: [
          {
            id: 'p1',
            type: 'claim',
            text: '任何手段都必须由正确的行为目标驱动，否则执行会走形',
            quote: '任何手段都必须由正确的行为目标驱动，否则执行会走形。',
            paragraph: 0,
          },
          {
            id: 'a1',
            type: 'example',
            text: '增肌案例说明运动必须以肌纤维微损伤为目标才能增肌',
            quote: '拿增肌来说，运动只有以肌纤维微损伤为目标才能增肌。',
            paragraph: 0,
          },
        ],
        edges: [],
      }
    }
    throw new Error('unexpected extraction title: ' + args.title)
  },

  async reviewCoverage(args) {
    coverageCalls.push({ title: args.title, systemPrompt: args.systemPrompt })
    if (args.title !== 'coverage-text-authority') return { nodes: [], edges: [] }
    return {
      nodes: [{
        id: 'm1',
        type: 'claim',
        text: '这些学习手段本身并非有问题',
        quote: '并非这些学习手段本身有问题',
        paragraph: 0,
      }],
      edges: [{
        fromNodeId: 'm1',
        toNodeId: 'b1',
        relation: 'supports',
        evidence: [{ paragraph: 0, quote: boundaryText }],
      }],
    }
  },

  async weaveRelations(args) {
    weaveCalls.push({ title: args.title, systemPrompt: args.systemPrompt })
    if (args.title !== 'analogy-role-hardening') return { edges: [] }
    assert(args.systemPrompt.includes('拿…来说/好比/类似于/类比'), 'relation weave prompt does not explicitly recall cross-domain analogy cues')
    return {
      edges: [{
        fromNodeId: 'a1',
        toNodeId: 'p1',
        relation: 'analogy',
        evidence: [{ paragraph: 0, quote: analogyText }],
      }],
    }
  },
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
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
  throw new Error('task did not finish: ' + taskId)
}

// 1) A counter-example with no challenged proposition is no longer publishable.
const counterStarted = await handlers.get('extract')({ title: 'counter-role-hardening', text: counterText })
const counterDone = await waitTask(counterStarted.taskId)
assert(counterDone.status === 'succeeded', 'counter-example repair task failed: ' + JSON.stringify(counterDone))
const counterCalls = extractCalls.filter((call) => call.title === 'counter-role-hardening')
assert(counterCalls.length >= 2, 'counter_example_without_target did not trigger bounded generation retry')
assert(counterCalls.some((call) => call.attempt === 1 && call.prompt.includes('counter_example_without_target')), 'typed counter-example invariant was not fed back to the retry')
assert(counterDone.result.nodes.some((node) => node.id === 'c1' && node.type === 'example'), 'corrected negative comparison was not published as example')
assert(!counterDone.result.nodes.some((node) => node.type === 'counter_example'), 'invalid counter_example survived canonical generation')

// 2) Evidence quote does not count as semantic coverage.
const coverageStarted = await handlers.get('extract')({ title: 'coverage-text-authority', text: boundaryText })
const coverageDone = await waitTask(coverageStarted.taskId)
assert(coverageDone.status === 'succeeded', 'boundary coverage task failed: ' + JSON.stringify(coverageDone))
assert(coverageCalls.filter((call) => call.title === 'coverage-text-authority').length === 1, 'boundary hidden only in quote did not trigger one bounded coverage review')
assert(coverageDone.result.nodes.some((node) => String(node.text || '').includes('学习手段本身并非有问题')), 'anti-inference boundary was not recovered into node.text')

// 3) Existing relation weave recalls explicit cross-domain analogy language.
const analogyStarted = await handlers.get('extract')({ title: 'analogy-role-hardening', text: analogyText })
const analogyDone = await waitTask(analogyStarted.taskId)
assert(analogyDone.status === 'succeeded', 'analogy relation task failed: ' + JSON.stringify(analogyDone))
assert(weaveCalls.some((call) => call.title === 'analogy-role-hardening'), 'relation weave did not inspect the analogy fixture')
assert(analogyDone.result.edges.some((edge) => edge.fromNodeId === 'a1' && edge.toNodeId === 'p1' && edge.relation === 'analogy'), 'explicit cross-domain analogy relation was not admitted')

console.log(JSON.stringify({
  ok: true,
  counterRetryCount: counterCalls.length - 1,
  semanticCoverageByText: true,
  analogyRelation: true,
}))
