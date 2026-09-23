import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const requests = []
const llm = {
  stream(request) {
    requests.push(request)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({
        verdict: 'insufficient', answer: '需要复核。', evidence: [], proposedFix: { action: 'none' },
      }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const handlers = new Map()
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({ get(name) { return name === 'llm' ? llm : null }, interval() { return () => {} } })

const paragraphs = Array.from({ length: 350 }, (_, i) => i === 270
  ? '外延是归入概念之下的全部现象。'
  : i === 300 ? '内涵是概念的共有属性。'
    : i === 340 ? '抽象层是由判别模型形成的概念层。'
      : '普通段落 ' + i + '，此处只有常规叙述。')
const text = paragraphs.join('\n\n')
const graph = { nodes: [{ id: 'n340', type: 'concept', text: '抽象层', paragraph: 340, quote: paragraphs[340] }], edges: [] }

async function ask(question, sourceUnits) {
  const start = await handlers.get('question-graph')({
    graph, text, question, ...(sourceUnits ? { sourceUnits } : {}),
    target: { kind: 'graph', id: null }, model: { provider: 'fake', model: 'fake' },
  })
  assert(start.taskId, 'question did not start')
  for (let i = 0; i < 100; i++) {
    const status = await handlers.get('task-status')({ taskId: start.taskId })
    if (status.status !== 'running') {
      assert(status.status === 'succeeded', 'question failed: ' + JSON.stringify(status.error))
      return requests.at(-1).messages[0].content[0].text
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('question did not finish')
}

const referenced = await ask('请复核 P269-P305 的外延和内涵定义，P340 的子图是否漏拆？')
assert(referenced.includes('[P270] 外延是归入概念之下的全部现象。'), 'referenced late source paragraph was omitted')
assert(referenced.includes('[P300] 内涵是概念的共有属性。'), 'end of referenced range was omitted')
assert(referenced.includes('[P340] 抽象层是由判别模型形成的概念层。'), 'single paragraph reference was omitted')
assert(!referenced.includes('[P0] '), 'irrelevant opening paragraph displaced cited evidence')

const searched = await ask('抽象层由什么形成？')
assert(searched.includes('[P340] 抽象层是由判别模型形成的概念层。'), 'late unreferenced paragraph was not retrieved')
assert(!searched.includes('[P0] '), 'lexical retrieval regressed to the opening paragraphs')

const scoped = await ask('请复核 P269-P305 的外延和内涵定义，P340 的子图是否漏拆？', [
  { paragraph: 270, text: paragraphs[270] },
  { paragraph: 300, text: paragraphs[300] },
  { paragraph: 340, text: paragraphs[340] },
])
assert(scoped.includes('原文 P270') && scoped.includes('外延是归入概念之下的全部现象'), 'source-unit question lost original paragraph 270')
assert(scoped.includes('原文 P300') && scoped.includes('内涵是概念的共有属性'), 'source-unit question lost original paragraph 300')
assert(scoped.includes('原文 P340') && scoped.includes('抽象层是由判别模型形成的概念层'), 'source-unit question lost original paragraph 340')
console.log(JSON.stringify({ ok: true, referenced: true, searched: true, scoped: true }))
