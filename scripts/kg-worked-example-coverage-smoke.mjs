import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const coverageCalls = []
let producerPrompt = ''

const source = '例子：“函数定义描述一种对应关系。”\n\n面对函数定义时，学习者可能反复阅读并记住这句话。'

const extractor = {
  async extractChunk(args) {
    producerPrompt = args.systemPrompt
    return {
      summary: '学习者可能以感觉判断是否学会',
      nodes: [{
        id: 'n1',
        type: 'example',
        text: '面对函数定义时，学习者可能反复阅读并记住这句话。',
        quote: '面对函数定义时，学习者可能反复阅读并记住这句话',
        paragraph: 1,
      }],
      edges: [],
    }
  },

  async reviewCoverage(args) {
    coverageCalls.push(args)
    assert(args.systemPrompt.includes('明确命名对象/定义型 worked example'), 'coverage prompt does not protect named worked-example context')
    assert(args.prompt.includes('结构性 worked-example 候选'), 'coverage prompt did not surface structural worked-example hints')
    assert(args.prompt.includes('[P0] 例子：“函数定义描述一种对应关系。”'), 'coverage prompt did not point at the omitted definition example')
    return {
      nodes: [{
        id: 'm1',
        type: 'example',
        text: '函数定义的学习例子。',
        quote: '函数定义描述一种对应关系',
        paragraph: 0,
      }],
      edges: [{
        fromNodeId: 'm1',
        toNodeId: 'n1',
        relation: 'example',
        evidence: [
          { paragraph: 0, quote: '例子：“函数定义描述一种对应关系。”' },
          { paragraph: 1, quote: '面对函数定义时，学习者可能反复阅读并记住这句话。' },
        ],
      }],
    }
  },

  async weaveRelations() { return { edges: [] } },
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
  throw new Error('task did not finish')
}

const started = await handlers.get('extract')({ title: 'worked-example-coverage', text: source })
const done = await waitTask(started.taskId)
assert(done.status === 'succeeded', 'worked-example extraction failed: ' + JSON.stringify(done))
assert(producerPrompt.includes('高知识密度 worked example'), 'producer prompt does not retain high-density worked examples')
assert(coverageCalls.length === 1, 'worked-example omission did not receive one bounded coverage review')
assert(done.result.nodes.some((node) => node.id === 'm1' && String(node.text || '').includes('函数定义')), 'worked-example context anchor was not recovered')
assert(done.result.edges.some((edge) => edge.fromNodeId === 'm1' && edge.toNodeId === 'n1' && edge.relation === 'example'), 'worked-example anchor was not connected to the downstream behavior')
console.log(JSON.stringify({ ok: true, workedExampleRecovered: true, boundedCoverage: true }))
