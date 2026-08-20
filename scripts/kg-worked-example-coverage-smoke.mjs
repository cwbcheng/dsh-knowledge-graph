import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const coverageCalls = []
let producerPrompt = ''

const source = '拿函数定义来说：“函数定义描述一种对应关系。”面对函数定义时，学习者可能反复阅读并记住这句话。'
const simpleSource = [
  '预测能力时刻支撑人的行动。',
  '哪怕是不经意的翻页动作，也是你基于大脑预测翻页后会看到后续内容而采取的行动。',
].join('\n\n')

const extractor = {
  async extractChunk(args) {
    producerPrompt = args.systemPrompt
    if (args.title === 'simple-example-coverage') {
      return {
        summary: '预测支撑日常行动',
        nodes: [{
          id: 'n1',
          type: 'claim',
          text: '预测能力时刻支撑人的行动。',
          quote: '预测能力时刻支撑人的行动。',
          paragraph: 0,
        }],
        edges: [],
      }
    }
    return {
      summary: '学习者可能以感觉判断是否学会',
      nodes: [{
        id: 'n1',
        type: 'example',
        text: '学习者可能反复阅读并记住这句话。',
        quote: '反复阅读并记住这句话',
        paragraph: 0,
      }],
      edges: [],
    }
  },

  async reviewCoverage(args) {
    coverageCalls.push(args)
    if (args.title === 'simple-example-coverage') {
      assert(args.systemPrompt.includes('完整原文单元没有任何已接受节点'), 'coverage contract does not protect omitted independent illustrative examples')
      assert(args.prompt.includes('独立说明例子候选'), 'coverage prompt did not surface independent illustrative-example hints')
      assert(args.prompt.includes('[P1] 哪怕是不经意的翻页动作'), 'coverage prompt did not point at the omitted page-turning example')
      return {
        nodes: [{
          id: 'm1',
          type: 'example',
          text: '翻页行为基于对翻页后内容的预测。',
          quote: '哪怕是不经意的翻页动作，也是你基于大脑预测翻页后会看到后续内容而采取的行动。',
          paragraph: 1,
        }],
        edges: [{
          fromNodeId: 'm1',
          toNodeId: 'n1',
          relation: 'example',
          evidence: [{ paragraph: 1, quote: '哪怕是不经意的翻页动作，也是你基于大脑预测翻页后会看到后续内容而采取的行动。' }],
        }],
      }
    }
    assert(args.systemPrompt.includes('明确命名对象/定义型 worked example'), 'coverage prompt does not protect named worked-example context')
    assert(args.prompt.includes('结构性 worked-example 候选'), 'coverage prompt did not surface structural worked-example hints')
    assert(args.prompt.includes('[P0] 拿函数定义来说'), 'coverage prompt did not point at the omitted same-unit definition example')
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
        evidence: [{ paragraph: 0, quote: source }],
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

const simpleStarted = await handlers.get('extract')({ title: 'simple-example-coverage', text: simpleSource })
const simpleDone = await waitTask(simpleStarted.taskId)
assert(simpleDone.status === 'succeeded', 'simple illustrative-example extraction failed: ' + JSON.stringify(simpleDone))
assert(coverageCalls.length === 2, 'simple illustrative omission did not receive one additional bounded coverage review')
assert(simpleDone.result.nodes.some((node) => node.id === 'm1' && String(node.text || '').includes('翻页')), 'page-turning illustrative example was not recovered')
assert(simpleDone.result.edges.some((edge) => edge.fromNodeId === 'm1' && edge.toNodeId === 'n1' && edge.relation === 'example'), 'page-turning example was not connected to the abstract prediction claim')
console.log(JSON.stringify({ ok: true, workedExampleRecovered: true, simpleExampleRecovered: true, boundedCoverage: true }))
