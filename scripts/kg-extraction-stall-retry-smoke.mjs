// A provider that goes silent for a whole idle window is a transport stall, not
// a verdict about the material — but it surfaces as `timeout`, which every stage
// treats as terminal. Before the fix a single 180s silence failed a real 40
// minute extraction of 《学习观》 at the semantic-review stage. This pins both
// halves of the contract: one stall is retried once and the run survives, and a
// provider that stalls forever fails fast instead of looping.
import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function streamText(value) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

// The exact shape the streaming call produces when refreshIdleDeadline expires.
function idleStall() {
  const error = new Error('模型连续 180000ms 未返回有效内容，已中止等待')
  error.code = 'timeout'
  error.phase = 'llm_stream_idle'
  error.timeoutMs = 180000
  return error
}

function requestText(request) {
  const messages = Array.isArray(request && request.messages) ? request.messages : []
  return messages.map((message) => {
    const content = message && message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n')
    return ''
  }).join('\n')
}

// Every model pass answers the same way: one anchored node, no edges. No edges
// means the weave and review stages have no candidates, so this smoke stays on
// the extraction path where the stall is injected.
function graphFor(request) {
  const numbered = Array.from(requestText(request).matchAll(/\[P(\d+)\]\s*([^\n]+)/g))
  if (!numbered.length) return { summary: '没有任何段落', nodes: [], edges: [] }
  const paragraph = Number(numbered[0][1])
  const quote = numbered[0][2].trim()
  return {
    summary: quote.slice(0, 40),
    nodes: [{ id: 'n1', type: 'fact', text: quote, quote, paragraph }],
    edges: [],
  }
}

function stallingLlm({ stallCount }) {
  const requests = []
  let stalls = 0
  return {
    requests,
    stallCount: () => stalls,
    listProviders() { return [{ id: 'text', name: 'Text' }] },
    async listModels() { return [{ id: 'text-model', name: 'Text Model', inputModalities: ['text'] }] },
    async resolveModelInfo(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'] } },
    stream(request) {
      requests.push(request)
      if (stalls < stallCount) {
        stalls += 1
        return (async function* () { throw idleStall() })()
      }
      return streamText(graphFor(request))
    },
  }
}

function mountHost(llm) {
  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({
    get(name) { return name === 'llm' ? llm : null },
    interval() { return () => {} },
  })
  return handlers
}

async function waitTask(handlers, taskId, timeoutMs = 30000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await sleep(10)
  }
  throw new Error('task did not settle: ' + taskId)
}

const sourceText = '甲导致了乙。\n丙伴随丁出现。'

// Scenario 1: exactly one stall. The run must survive it.
const survivingLlm = stallingLlm({ stallCount: 1 })
const survivingHandlers = mountHost(survivingLlm)
const started = await survivingHandlers.get('extract')({
  title: '停顿重试',
  text: sourceText,
  model: { provider: 'text', model: 'text-model' },
})
assert(started && started.taskId, 'extraction did not start')
const survived = await waitTask(survivingHandlers, started.taskId)
assert(survived.status === 'succeeded', 'a single idle stall still failed the run: ' + JSON.stringify(survived.error || survived.status))
assert(survivingLlm.stallCount() === 1, 'the smoke did not inject exactly one stall')
assert(survivingLlm.requests.length >= 2, 'the stalled request was not retried')
assert(survived.result && survived.result.nodes.length >= 1, 'retry did not produce a graph: ' + JSON.stringify(survived.result))

// Scenario 2: a provider that stalls forever must fail fast, not loop.
const deadLlm = stallingLlm({ stallCount: Number.POSITIVE_INFINITY })
const deadHandlers = mountHost(deadLlm)
const deadStarted = await deadHandlers.get('extract')({
  title: '持续停顿',
  text: sourceText,
  model: { provider: 'text', model: 'text-model' },
})
assert(deadStarted && deadStarted.taskId, 'second extraction did not start')
const dead = await waitTask(deadHandlers, deadStarted.taskId)
assert(dead.status === 'failed', 'a permanently stalling provider did not fail the run: ' + dead.status)
assert(dead.error && dead.error.code === 'timeout', 'permanent stall did not surface as a timeout: ' + JSON.stringify(dead.error))
assert(deadLlm.requests.length === 2, 'bounded retry expected exactly 2 requests, saw ' + deadLlm.requests.length)

console.log(JSON.stringify({
  ok: true,
  survivedSingleStall: survived.status,
  stallRetries: survivingLlm.requests.length,
  permanentStallStatus: dead.status,
  permanentStallRequests: deadLlm.requests.length,
  nodesAfterRetry: survived.result.nodes.length,
}))
