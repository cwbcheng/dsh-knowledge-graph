import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeFixture() {
  const documentId = 'document-consumption-smoke'
  const sourceId = 'source-consumption-smoke'
  const paragraphs = []
  const nodes = []
  const nodeCount = 803
  for (let i = 0; i <= nodeCount; i += 1) paragraphs.push('知识节点 ' + i + ' 的内容。')
  paragraphs[0] = '恢复依赖检查点。'
  paragraphs[1] = '检查点支持断点续跑。'
  paragraphs[2] = 'SOURCE_ONLY_TOKEN 蓝色开关用于恢复。'
  paragraphs[801] = '窗口外目标位于第八百零一个节点。'
  paragraphs[802] = '这是一个语义不确定判断。'
  paragraphs[803] = '这是一个尚不受支持的判断。'

  const sectionFor = (paragraph) => paragraph <= 400
    ? { id: 'section-early', title: '前半部分' }
    : { id: 'section-late', title: '后半部分' }
  for (let i = 1; i <= nodeCount; i += 1) {
    const paragraph = i >= 3 ? i : i - 1
    let text = '知识节点 ' + i + ' 的内容'
    let type = i % 2 === 0 ? 'concept' : 'fact'
    let entailmentStatus = 'verified'
    if (i === 1) { text = '恢复依赖检查点'; type = 'claim'; entailmentStatus = 'unverified' }
    if (i === 2) { text = '检查点支持断点续跑'; type = 'fact' }
    if (i === 801) { text = '知识节点 窗口外目标'; type = 'rule' }
    if (i === 802) { text = '语义不确定判断'; type = 'claim'; entailmentStatus = 'uncertain' }
    if (i === 803) { text = '尚不受支持的判断'; type = 'claim'; entailmentStatus = 'unsupported' }
    const section = sectionFor(paragraph)
    const quote = paragraphs[paragraph].replace(/[。.]$/, '')
    nodes.push({
      id: 'n' + i,
      type,
      text,
      quote,
      paragraph,
      evidence: [{ documentId, sourceId, chunkId: 'chunk-main', paragraph, quote }],
      documentId,
      sourceId,
      chunkId: 'chunk-main',
      sectionId: section.id,
      sectionTitle: section.title,
      groundingStatus: 'grounded',
      entailmentStatus,
      state: entailmentStatus === 'verified' ? 'accepted' : 'candidate',
    })
  }
  const graph = {
    summary: '检查点恢复机制与大量知识节点',
    revision: 1,
    source: {
      id: sourceId,
      documentId,
      title: '消费层测试资料',
      chars: paragraphs.join('\n\n').length,
      paragraphCount: paragraphs.length,
      chunkCount: 1,
      sectionCount: 2,
      revision: 1,
      sections: [
        { id: 'section-early', title: '前半部分', startParagraph: 0, endParagraph: 400 },
        { id: 'section-late', title: '后半部分', startParagraph: 401, endParagraph: paragraphs.length - 1 },
      ],
    },
    staging: {
      sourceId,
      documentId,
      chunkCount: 1,
      chunks: [{
        chunkId: 'chunk-main', sourceId, startParagraph: 0, endParagraph: paragraphs.length - 1,
        sectionIds: ['section-early', 'section-late'], sectionTitles: ['前半部分', '后半部分'],
        summary: '测试块', nodeIds: nodes.map((node) => node.id), edgeCount: 1, warnings: [],
      }],
    },
    nodes,
    edges: [{
      fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports',
      documentId, sourceId, chunkId: 'chunk-main', state: 'accepted',
      evidence: [{ documentId, sourceId, chunkId: 'chunk-main', paragraph: 1, quote: '检查点支持断点续跑' }],
    }],
  }
  const dynamicGraph = structuredClone(graph)
  delete dynamicGraph.source.documentId
  return { documentId, sourceId, graph, dynamicGraph, sourceText: paragraphs.join('\n\n') }
}

function makeLlm() {
  const calls = []
  return {
    calls,
    stream(request) {
      const userText = request && request.messages && request.messages[0] && request.messages[0].content && request.messages[0].content[0]
        ? String(request.messages[0].content[0].text || '')
        : ''
      calls.push({ system: String(request.system || ''), userText })
      const question = ((userText.match(/^用户问题：(.*)$/m) || [])[1] || '').trim()
      const findEvidence = (pattern) => {
        const match = userText.match(pattern)
        return match ? match[1] : 'ev-missing'
      }
      let output
      if (question.includes('未知引用')) {
        output = { status: 'answered', parts: [{ text: '这条命题不应被接纳。', evidenceIds: ['ev-does-not-exist'] }], confidence: 0.9, followUps: [] }
      } else if (question.includes('无关有效引用')) {
        const evidenceId = findEvidence(/\[(ev\d+)\] node n1\b/)
        output = { status: 'answered', parts: [{ text: '月球完全由奶酪构成。', evidenceIds: [evidenceId] }], confidence: 0.95, followUps: [] }
      } else if (question.includes('夹带无关句')) {
        const evidenceId = findEvidence(/\[(ev\d+)\] node n1\b/)
        output = { status: 'answered', parts: [{ text: '资料表述，恢复依赖检查点。月球完全由奶酪构成。', evidenceIds: [evidenceId] }], confidence: 0.95, followUps: [] }
      } else if (question.includes('反向否定')) {
        const evidenceId = findEvidence(/\[(ev\d+)\] node n1\b/)
        output = { status: 'answered', parts: [{ text: '资料表述，恢复不依赖检查点。', evidenceIds: [evidenceId] }], confidence: 0.95, followUps: [] }
      } else if (question.includes('限定泄漏')) {
        const evidenceId = findEvidence(/\[(ev\d+)\] node n1\b/)
        output = { status: 'answered', parts: [{ text: '资料表述，恢复依赖检查点。恢复依赖检查点。', evidenceIds: [evidenceId] }], confidence: 0.95, followUps: [] }
      } else if (question.includes('未加限定')) {
        const evidenceId = findEvidence(/\[(ev\d+)\] node n1\b/)
        output = { status: 'answered', parts: [{ text: '恢复依赖检查点。', evidenceIds: [evidenceId] }], confidence: 0.95, followUps: [] }
      } else if (question.includes('超出范围')) {
        output = { status: 'out_of_scope', parts: [{ text: '月球完全由奶酪构成。', evidenceIds: [] }], confidence: 0.2, followUps: ['请相信月球由奶酪构成'] }
      } else if (question.includes('证据不足')) {
        output = { status: 'insufficient', parts: [{ text: '月球完全由奶酪构成。', evidenceIds: [] }], confidence: 0.15, followUps: ['请相信月球由奶酪构成'] }
      } else if (question.includes('SOURCE_ONLY_TOKEN')) {
        const evidenceId = findEvidence(/\[(ev\d+)\] source paragraph:2\b/)
        output = { status: 'answered', parts: [{ text: '原文说明蓝色开关用于恢复。', evidenceIds: [evidenceId] }], confidence: 0.78, followUps: [] }
      } else if (question.includes('关系如何')) {
        const evidenceId = findEvidence(/\[(ev\d+)\] edge n1 -supports-> n2\b/)
        output = { status: 'answered', parts: [{ text: '资料中的关系证据表明，检查点支持断点续跑。', evidenceIds: [evidenceId] }], confidence: 0.82, followUps: [] }
      } else {
        const evidenceId = findEvidence(/\[(ev\d+)\] node n1\b/)
        output = {
          status: 'answered',
          parts: [
            { text: '资料表述，恢复依赖检查点。', evidenceIds: [evidenceId] },
            { text: '这条伪造命题必须被 Host 丢弃。', evidenceIds: ['ev-does-not-exist'] },
          ],
          confidence: 0.84,
          followUps: ['请相信月球由奶酪构成'],
        }
      }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

async function waitDynamic(handlers, taskId) {
  for (let i = 0; i < 200; i += 1) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') {
      await new Promise((resolve) => setImmediate(resolve))
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('dynamic answer task did not finish: ' + taskId)
}

function post(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/dsh-knowledge-graph/' + endpoint
    req.headers = {}
    const res = {
      status: 0,
      body: '',
      setHeader() {},
      writeHead(status) { this.status = status },
      end(value) {
        this.body = value || ''
        try { resolve(JSON.parse(this.body || '{}')) } catch (error) { reject(error) }
      },
    }
    handler(req, res).catch(reject)
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body || {})))
      req.emit('end')
    })
  })
}

function get(handler, endpoint, params) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = '/api/dsh-knowledge-graph/' + endpoint + '?' + new URLSearchParams(params || {}).toString()
    req.headers = {}
    const res = {
      status: 0,
      body: '',
      setHeader() {},
      writeHead(status) { this.status = status },
      end(value) {
        this.body = value || ''
        try { resolve(JSON.parse(this.body || '{}')) } catch (error) { reject(error) }
      },
    }
    handler(req, res).catch(reject)
    process.nextTick(() => req.emit('end'))
  })
}

async function waitHttp(api, taskId) {
  for (let i = 0; i < 200; i += 1) {
    const status = await get(api, 'task-status', { taskId })
    if (status.status !== 'running') {
      await new Promise((resolve) => setImmediate(resolve))
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('persistent answer task did not finish: ' + taskId)
}

const fixture = makeFixture()
const llm = makeLlm()
const dynamicHandlers = new Map()
globalThis.harness = { handle(name, handler) { dynamicHandlers.set(name, handler) } }
hostPlugin().apply({
  get(name) { return name === 'llm' ? llm : null },
  interval() { return () => {} },
})

assert(dynamicHandlers.has('graph-query') && dynamicHandlers.has('answer-graph'), 'dynamic consumption RPC handlers were not registered')

const forged = await dynamicHandlers.get('graph-query')({
  documentId: fixture.documentId,
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  query: '恢复',
})
assert(forged.error && forged.error.code === 'not_found', 'dynamic canonical query trusted a client-forged graph fallback')

const dynamicExact = await dynamicHandlers.get('graph-query')({
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  nodeIds: ['n1'],
  hops: 0,
})
assert(!dynamicExact.error, 'dynamic exact-node query failed: ' + JSON.stringify(dynamicExact.error))
assert(dynamicExact.matches.length === 1 && dynamicExact.matches[0].nodeId === 'n1', 'nodeIds was not a hard direct-match filter')
assert(dynamicExact.graph.nodes.length === 1 && dynamicExact.graph.nodes[0].id === 'n1', 'nodeIds query leaked unrelated grounded nodes')

const dynamicUncertain = await dynamicHandlers.get('graph-query')({
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  entailmentStatuses: ['uncertain'],
  hops: 0,
})
assert(dynamicUncertain.matches.length === 1 && dynamicUncertain.matches[0].nodeId === 'n802', 'uncertain entailment filter is not aligned with canonical statuses')
const dynamicUnsupported = await dynamicHandlers.get('graph-query')({
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  entailmentStatuses: ['unsupported'],
  hops: 0,
})
assert(dynamicUnsupported.matches.length === 1 && dynamicUnsupported.matches[0].nodeId === 'n803', 'unsupported entailment filter is not aligned with canonical statuses')
const invalidFilter = await dynamicHandlers.get('graph-query')({
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  entailmentStatuses: ['contradicted'],
})
assert(invalidFilter.error && invalidFilter.error.code === 'invalid_input', 'unknown entailment status was silently ignored')

const dynamicExpanded = await dynamicHandlers.get('graph-query')({
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  query: '恢复依赖检查点',
  limit: 1,
  hops: 1,
})
assert(dynamicExpanded.matches.length === 1 && dynamicExpanded.matches[0].nodeId === 'n1', 'direct match set was not preserved')
assert(dynamicExpanded.graph.nodes.some((node) => node.id === 'n2'), 'one-hop relation neighbor was not expanded')
assert(!dynamicExpanded.matches.some((match) => match.nodeId === 'n2'), 'expanded neighbor was incorrectly reported as a direct match')

const dynamicLate = await dynamicHandlers.get('graph-query')({
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  query: '窗口外目标',
  hops: 0,
})
assert(dynamicLate.matches[0] && dynamicLate.matches[0].nodeId === 'n801', 'dynamic query could not find a node outside the renderer window')
const dynamicSaturated = await dynamicHandlers.get('graph-query')({
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  query: '知识节点 窗口外目标',
  limit: 1,
  hops: 0,
})
assert(dynamicSaturated.matches[0] && dynamicSaturated.matches[0].nodeId === 'n801', 'dynamic ranking did not prioritize a late exact match over common early candidates')
const dynamicBounded = await dynamicHandlers.get('graph-query')({
  graph: fixture.dynamicGraph,
  text: fixture.sourceText,
  query: '知识节点',
  limit: 40,
  hops: 2,
  maxNodes: 20,
  maxEdges: 30,
})
assert(dynamicBounded.graph.nodes.length <= 20 && dynamicBounded.graph.edges.length <= 30, 'dynamic graph-query exceeded response budgets')

async function dynamicAnswer(question) {
  const started = await dynamicHandlers.get('answer-graph')({
    graph: fixture.dynamicGraph,
    text: fixture.sourceText,
    question,
    model: { provider: 'fake', model: 'fake' },
  })
  assert(started && started.taskId, 'dynamic answer task was not created: ' + JSON.stringify(started))
  return waitDynamic(dynamicHandlers, started.taskId)
}

const dynamicAnswered = await dynamicAnswer('恢复依赖什么？')
assert(dynamicAnswered.status === 'succeeded' && dynamicAnswered.result.status === 'answered', 'dynamic evidence answer did not succeed')
assert(dynamicAnswered.result.parts.length === 1, 'answer admission did not drop the fabricated answer part')
assert(dynamicAnswered.result.citations.length === 1 && dynamicAnswered.result.citations[0].targetKind === 'node' && dynamicAnswered.result.citations[0].nodeId === 'n1', 'node evidence citation was not authenticated')
assert(dynamicAnswered.result.citations[0].entailmentStatus === 'unverified', 'citation lost entailment authority metadata')
assert(dynamicAnswered.result.answer.includes('未验证的知识图提取') && dynamicAnswered.result.answer.includes('原文 P0'), 'Host did not render the final answer from authenticated evidence')
assert(dynamicAnswered.result.followUps.length > 0 && !dynamicAnswered.result.followUps.join(' ').includes('奶酪'), 'model-generated follow-up prose was surfaced instead of Host-generated prompts')

const dynamicUnknown = await dynamicAnswer('恢复未知引用应该怎样处理？')
assert(dynamicUnknown.status === 'succeeded' && dynamicUnknown.result.status === 'insufficient', 'unknown evidenceId did not downgrade the answer')
assert(dynamicUnknown.result.parts.length === 0 && dynamicUnknown.result.citations.length === 0, 'unknown evidenceId leaked into the admitted answer')

const dynamicIrrelevant = await dynamicAnswer('恢复无关有效引用应该怎样处理？')
assert(dynamicIrrelevant.status === 'succeeded' && dynamicIrrelevant.result.status === 'insufficient', 'valid but irrelevant evidenceId was admitted')
assert(dynamicIrrelevant.result.parts.length === 0 && dynamicIrrelevant.result.citations.length === 0, 'irrelevant valid evidence leaked into the admitted answer')

const dynamicUnqualified = await dynamicAnswer('恢复未加限定应该怎样处理？')
assert(dynamicUnqualified.status === 'succeeded' && dynamicUnqualified.result.status === 'insufficient', 'unverified evidence was admitted without source-qualified wording')

const dynamicSmuggled = await dynamicAnswer('恢复夹带无关句应该怎样处理？')
assert(dynamicSmuggled.status === 'succeeded' && dynamicSmuggled.result.status === 'insufficient', 'a supported sentence allowed an unrelated sentence to share its evidence ID')

const dynamicNegated = await dynamicAnswer('恢复反向否定应该怎样处理？')
assert(dynamicNegated.status === 'succeeded' && dynamicNegated.result.status === 'insufficient', 'lexically similar contradictory polarity was admitted')

const dynamicCaveatBleed = await dynamicAnswer('恢复限定泄漏应该怎样处理？')
assert(dynamicCaveatBleed.status === 'succeeded' && dynamicCaveatBleed.result.status === 'insufficient', 'an authority caveat leaked across answer clauses')

const dynamicEdge = await dynamicAnswer('恢复关系如何支持断点续跑？')
assert(dynamicEdge.result.status === 'answered' && dynamicEdge.result.citations.some((item) => item.targetKind === 'edge' && item.fromNodeId === 'n1' && item.toNodeId === 'n2'), 'edge evidence could not support a relationship answer')

const dynamicSource = await dynamicAnswer('SOURCE_ONLY_TOKEN 蓝色开关用于恢复')
assert(dynamicSource.result.status === 'answered', 'source fallback answer did not succeed')
assert(dynamicSource.result.citations.length === 1 && dynamicSource.result.citations[0].targetKind === 'source' && dynamicSource.result.citations[0].paragraph === 2, 'source-only evidence did not produce an authenticated paragraph citation')
assert(dynamicSource.result.retrieval.metrics.sourceFallbackUnits > 0, 'source fallback retrieval was not reported')

const dynamicOut = await dynamicAnswer('恢复问题但超出范围')
assert(dynamicOut.result.status === 'out_of_scope' && dynamicOut.result.citations.length === 0, 'out_of_scope was not preserved as a successful semantic outcome')
assert(!dynamicOut.result.answer.includes('奶酪') && dynamicOut.result.parts.length === 0 && dynamicOut.result.followUps.length === 0, 'out_of_scope surfaced unconstrained model prose')
const dynamicInsufficient = await dynamicAnswer('恢复问题但证据不足')
assert(dynamicInsufficient.result.status === 'insufficient' && dynamicInsufficient.result.citations.length === 0, 'insufficient was not preserved as a successful semantic outcome')
assert(!dynamicInsufficient.result.answer.includes('奶酪') && dynamicInsufficient.result.parts.length === 0 && dynamicInsufficient.result.followUps.length === 0, 'insufficient surfaced unconstrained model prose')

const dir = mkdtempSync('/tmp/dsh-kg-consumption-')
const dbPath = join(dir, 'consumption.sqlite')
process.env.DSH_KG_DB = dbPath
let store = await openSqliteStore(dbPath)
store.saveGraph(fixture.graph, { sourceText: fixture.sourceText })
const firstWindow = store.getDocumentWindow(fixture.documentId, { limit: 800, offset: 0 })
assert(firstWindow && firstWindow.nodes.length === 800 && !firstWindow.nodes.some((node) => node.id === 'n801'), 'renderer-window fixture did not place n801 outside the first 800 nodes')
const storeLate = store.queryDocumentGraph(fixture.documentId, { query: '窗口外目标', hops: 0 })
assert(storeLate && storeLate.matches[0] && storeLate.matches[0].nodeId === 'n801', 'SQLite bounded query could not find n801 outside the renderer window')
const storeSaturated = store.queryDocumentGraph(fixture.documentId, { query: '知识节点 窗口外目标', limit: 1, hops: 0 })
assert(storeSaturated && storeSaturated.matches[0] && storeSaturated.matches[0].nodeId === 'n801', 'SQLite candidate cap hid a late exact match behind common early bigrams')
assert(storeLate.nodes.length <= 160 && storeLate.edges.length <= 480, 'SQLite consumption query exceeded hard budgets')
const indexNames = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name)
for (const name of ['graph_nodes_type_idx', 'graph_nodes_section_idx', 'graph_nodes_status_idx', 'graph_edges_from_idx', 'graph_edges_to_idx']) {
  assert(indexNames.includes(name), 'missing consumption index: ' + name)
}
store.close()

const persistentHost = await import('../lib/index.js')
const routes = []
const cleanups = []
persistentHost.apply({
  get(name) {
    if (name === 'webServer') return { register(spec) { routes.push(spec); return () => {} } }
    if (name === 'llm') return llm
    return null
  },
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return cleanup
  },
  interval() { return () => {} },
})
const apiRoute = routes.find((route) => route.path === '/api/dsh-knowledge-graph')
assert(apiRoute && typeof apiRoute.handler === 'function', 'persistent HTTP API route was not registered')
const api = apiRoute.handler

try {
  const persistentExact = await post(api, 'graph-query', {
    documentId: fixture.documentId,
    expectedRevision: 1,
    nodeIds: ['n1'],
    hops: 0,
  })
  assert(!persistentExact.error && persistentExact.matches.length === 1 && persistentExact.matches[0].nodeId === 'n1', 'persistent exact-node query failed')
  assert(persistentExact.graph.nodes.length === 1 && persistentExact.graph.nodes[0].id === 'n1', 'persistent exact-node query leaked unrelated nodes')

  const persistentUncertain = await post(api, 'graph-query', {
    documentId: fixture.documentId,
    entailmentStatuses: ['uncertain'],
    hops: 0,
  })
  assert(persistentUncertain.matches.length === 1 && persistentUncertain.matches[0].nodeId === 'n802', 'persistent uncertain filter failed')

  const persistentLate = await post(api, 'graph-query', {
    documentId: fixture.documentId,
    expectedRevision: 1,
    query: '窗口外目标',
    hops: 0,
  })
  assert(persistentLate.matches[0] && persistentLate.matches[0].nodeId === 'n801', 'persistent HTTP query could not find n801')
  const persistentSaturated = await post(api, 'graph-query', {
    documentId: fixture.documentId,
    query: '知识节点 窗口外目标',
    limit: 1,
    hops: 0,
  })
  assert(persistentSaturated.matches[0] && persistentSaturated.matches[0].nodeId === 'n801', 'persistent HTTP candidate paging missed a late exact match')
  assert(!JSON.stringify(persistentLate).includes('sourceText'), 'graph-query leaked full sourceText')

  const parityDynamic = await dynamicHandlers.get('graph-query')({
    graph: fixture.dynamicGraph,
    text: fixture.sourceText,
    query: '恢复依赖检查点',
    limit: 1,
    hops: 1,
  })
  const parityPersistent = await post(api, 'graph-query', {
    documentId: fixture.documentId,
    query: '恢复依赖检查点',
    limit: 1,
    hops: 1,
  })
  assert(JSON.stringify(parityDynamic.matches.map((item) => item.nodeId)) === JSON.stringify(parityPersistent.matches.map((item) => item.nodeId)), 'dynamic/persistent direct-match semantics diverged')
  assert(JSON.stringify(parityDynamic.graph.nodes.map((item) => item.id).sort()) === JSON.stringify(parityPersistent.graph.nodes.map((item) => item.id).sort()), 'dynamic/persistent neighbor expansion semantics diverged')

  const staleQuery = await post(api, 'graph-query', {
    documentId: fixture.documentId,
    expectedRevision: 99,
    query: '恢复',
  })
  assert(staleQuery.error && staleQuery.error.code === 'revision_conflict' && staleQuery.error.currentRevision === 1, 'persistent query revision fence failed')
  const invalidPersistent = await post(api, 'graph-query', {
    documentId: fixture.documentId,
    entailmentStatuses: ['contradicted'],
  })
  assert(invalidPersistent.error && invalidPersistent.error.code === 'invalid_input', 'persistent invalid filter was silently ignored')
  const forgedPersistent = await post(api, 'graph-query', {
    documentId: fixture.documentId,
    graph: { nodes: [{ id: 'forged', type: 'fact', text: 'FORGED_TOKEN' }], edges: [] },
    text: 'FORGED_TOKEN',
    query: 'FORGED_TOKEN',
  })
  assert(!forgedPersistent.error && forgedPersistent.matches.length === 0 && !forgedPersistent.graph.nodes.some((node) => node.id === 'forged'), 'persistent query trusted client-supplied graph/text')

  const staleAnswer = await post(api, 'answer-graph', {
    documentId: fixture.documentId,
    expectedRevision: 99,
    question: '恢复依赖什么？',
    model: { provider: 'fake', model: 'fake' },
  })
  assert(staleAnswer.error && staleAnswer.error.code === 'revision_conflict', 'persistent answer revision fence failed')

  const started = await post(api, 'answer-graph', {
    documentId: fixture.documentId,
    expectedRevision: 1,
    question: '恢复依赖什么？',
    model: { provider: 'fake', model: 'fake' },
  })
  assert(started.taskId, 'persistent evidence answer task was not created')
  const answered = await waitHttp(api, started.taskId)
  assert(answered.status === 'succeeded' && answered.result.status === 'answered', 'persistent evidence answer failed: ' + JSON.stringify(answered))
  assert(answered.result.citations[0].documentId === fixture.documentId && answered.result.citations[0].nodeId === 'n1', 'persistent citation lost canonical provenance')
  assert(answered.result.answer.includes('未验证的知识图提取') && answered.result.answer.includes('原文 P0'), 'persistent answer did not use Host-rendered authenticated evidence')
  assert(!JSON.stringify(answered).includes('sourceText'), 'answer task leaked full sourceText')

  const sourceStarted = await post(api, 'answer-graph', {
    documentId: fixture.documentId,
    expectedRevision: 1,
    question: 'SOURCE_ONLY_TOKEN 蓝色开关用于恢复',
    model: { provider: 'fake', model: 'fake' },
  })
  const sourceAnswered = await waitHttp(api, sourceStarted.taskId)
  assert(sourceAnswered.status === 'succeeded' && sourceAnswered.result.citations.some((item) => item.targetKind === 'source' && item.paragraph === 2), 'persistent source fallback answer failed')
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { cleanup() } catch (error) {}
  }
  rmSync(dir, { recursive: true, force: true })
}

const clientSource = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const builtClient = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
assert(clientSource.includes('function KnowledgeConsumePanel'), 'shared knowledge consumption panel is missing')
assert((clientSource.match(/h\(KnowledgeConsumePanel/g) || []).length === 2, 'consumption panel is not mounted in both document and trajectory views')
assert(clientSource.includes("host.call('graph-query'") && clientSource.includes("host.call('answer-graph'"), 'dynamic client does not call consumption RPCs')
assert(clientSource.includes("host.call('document-load', { documentId, query: nodeId"), 'citation locator cannot load nodes outside the renderer window')
assert(clientSource.includes("if (askState.phase === 'submitting' || askState.phase === 'running') return") && clientSource.includes("disabled: askState.phase === 'submitting' || askState.phase === 'running'"), 'answer input can abandon polling by submitting while a task is running')
assert(builtClient.includes("rpc('graph-query'") && builtClient.includes("rpc('answer-graph'"), 'persistent client RPC bridge is missing consumption methods')
assert(!builtClient.includes("host.call('graph-query'") && !builtClient.includes("host.call('answer-graph'"), 'persistent client still contains dynamic consumption calls')
assert(hostSource.includes('buildConsumptionEvidenceCatalogHost') && hostSource.includes('evidenceIds'), 'evidence-ID answer admission is missing')
assert(!hostSource.includes('parseJsonLoose(raw)'), 'answer task calls an undefined JSON parser')

console.log(JSON.stringify({
  ok: true,
  dynamic: {
    exactMatches: dynamicExact.matches.length,
    lateNode: dynamicLate.matches[0].nodeId,
    boundedNodes: dynamicBounded.graph.nodes.length,
    answeredCitation: dynamicAnswered.result.citations[0].id,
    edgeCitation: dynamicEdge.result.citations.find((item) => item.targetKind === 'edge').id,
    sourceCitation: dynamicSource.result.citations[0].id,
  },
  persistent: {
    documentId: fixture.documentId,
    canonicalNodes: fixture.graph.nodes.length,
    rendererWindowNodes: 800,
    indexedLateNode: storeLate.matches[0].nodeId,
  },
  llmCalls: llm.calls.length,
}))
