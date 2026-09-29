import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-visual-retry-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'fixture.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const routes = [], cleanups = []
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const images = Array.from({ length: 3 }, (_, i) => ({ id: 'figure-' + (i + 1), name: 'diagram-' + (i + 1) + '.png',
  paragraphs: [0], startParagraph: 0, endParagraph: 0, interpretationStatus: 'not_requested',
  attachment: { attachmentId: 'fixture-image-' + (i + 1), mediaType: 'image/png', bytes: bytes.length, width: 1, height: 1 } }))
const selectedIds = ['figure-2', 'figure-1']
const valid = { images: selectedIds.map((id, i) => ({ imageIndex: i + 1, summary: '',
  units: [{ kind: 'text', text: 'Visible label ' + id + '.' }], warnings: [] })) }
// Closed objects after a malformed key must not be harvested as a valid prefix.
const malformed = '{"images":[{"imageIndex":1,"summary":"UNTRUSTED_PARTIAL","units" [{"kind":"text","text":"Do not publish this fragment."}]}]}'
assert.throws(() => JSON.parse(malformed), /Expected ':'/)
let activeCase
const llm = {
  async resolveModelInfo(provider, model) { return { provider, id: model, inputModalities: ['text', 'image'] } },
  stream(request) {
    const content = request.messages[0].content
    const imageBlocks = content.filter(block => block.type === 'image')
    if (!imageBlocks.length) return reply({ text: { edges: [] } })
    const index = activeCase.requests.push(request) - 1
    assert.deepEqual(imageBlocks.map(block => block.attachment.attachmentId), ['fixture-image-2', 'fixture-image-1'])
    assert.equal(request.provider, 'fixture')
    assert.equal(request.model, 'vision')
    assert.deepEqual(store.getDocument(activeCase.id), activeCase.baseline, 'No rejected transcript may change the canonical graph')
    if (index) {
      const prompt = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.match(prompt, /完整.*JSON/)
      assert(!prompt.includes('UNTRUSTED_PARTIAL'), 'Never recycle damaged model text as evidence or instructions')
    }
    return reply(activeCase.outcomes[Math.min(index, activeCase.outcomes.length - 1)])
  },
}
async function* reply(outcome) {
  if (outcome.hold) await new Promise(resolve => { activeCase.release = resolve })
  if (outcome.edit) {
    const changed = structuredClone(activeCase.baseline)
    changed.summary = 'Concurrent user edit in disposable fixture'
    store.saveGraph(changed, { sourceText: changed.sourceText, expectedRevision: changed.revision })
  }
  if (outcome.reasoning) yield { type: 'reasoning-delta', index: 0, text: 'Controlled reasoning without JSON' }
  if (outcome.text !== undefined) yield { type: 'text-delta', index: 0, text: typeof outcome.text === 'string' ? outcome.text : JSON.stringify(outcome.text) }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
  yield { type: 'finish', reason: outcome.reason || { kind: 'stop' } }
}
const extractor = { async extractChunk({ chunk }) {
  activeCase.graphCalls += 1
  return { summary: '', nodes: chunk.units.filter(unit => unit.text.includes('Visible label')).map((unit, i) => ({
    id: 'visual-' + i, type: 'fact', text: unit.text.replace('【可见文字】', ''),
    quote: unit.text.replace('【可见文字】', ''), paragraph: unit.num,
  })), edges: [] }
} }
const invoke = (api, endpoint, payload) => new Promise((resolve, reject) => {
  const request = new EventEmitter()
  const readTask = endpoint === 'task-status' || endpoint === 'task-active'
  request.method = readTask ? 'GET' : 'POST'
  request.url = '/api/dsh-knowledge-graph/' + endpoint + (readTask ? '?' + new URLSearchParams(payload) : '')
  request.headers = { 'content-type': 'application/json' }
  const response = { writeHead() {}, setHeader() {}, end(body) { resolve(body ? JSON.parse(body) : {}) } }
  Promise.resolve(api(request, response)).catch(reject)
  process.nextTick(() => { request.emit('data', Buffer.from(JSON.stringify(payload))); request.emit('end') })
})
const cases = [
  { id: 'syntax-recovery', outcomes: [{ text: malformed }, { text: valid }], calls: 2 },
  { id: 'missing-image', outcomes: [{ text: { images: [valid.images[0]] } }, { text: valid }], calls: 2 },
  { id: 'duplicate-index', outcomes: [{ text: { images: [valid.images[0], valid.images[0]] } }, { text: valid }], calls: 2 },
  { id: 'oversized-unit', outcomes: [{ text: { images: [valid.images[0], { ...valid.images[1], units: [{ kind: 'text', text: 'X'.repeat(1601) }] }] } }, { text: valid }], calls: 2 },
  { id: 'max-tokens', outcomes: [{ text: valid, reason: { kind: 'max-tokens' } }, { text: valid }], calls: 2 },
  { id: 'reasoning-only', outcomes: [{ reasoning: true }, { text: valid }], calls: 2 },
  { id: 'syntax-exhausted', outcomes: [{ text: malformed }], calls: 3, code: 'visual_json_invalid' },
  { id: 'missing-exhausted', outcomes: [{ text: { images: [valid.images[0]] } }], calls: 3, code: 'visual_schema_invalid' },
  { id: 'truncated-exhausted', outcomes: [{ text: valid, reason: { kind: 'max-tokens' } }], calls: 3, code: 'visual_output_truncated' },
  { id: 'authentication', outcomes: [{ reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', status: 401, message: 'Fixture missing credential' } } }], calls: 1, code: 'failed' },
  { id: 'unsupported-image', outcomes: [{ reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT', status: 400, message: 'Fixture text-only model' } } }], calls: 1, code: 'model_image_unsupported' },
  { id: 'cancel-retry', outcomes: [{ text: malformed }, { text: valid, hold: true }], calls: 2, code: 'cancelled', cancel: true },
  { id: 'revision-conflict', outcomes: [{ text: malformed }, { text: valid, edit: true }], calls: 2, code: 'revision_conflict' },
]
try {
  const plugin = await import('../lib/index.js?visual-retry=' + Date.now())
  plugin.apply({ get(name) {
    if (name === 'webServer') return { register(spec) { routes.push(spec); return () => {} } }
    if (name === 'llm') return llm
    if (name === 'kgExtractor') return extractor
    if (name === 'attachments') return { async readImage(ref) { return { ref, data: bytes } } }
    return null
  }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  for (const scenario of cases) {
    const sourceText = 'Preserved original source.'
    store.saveGraph({ source: { id: scenario.id, documentId: scenario.id, title: scenario.id,
      visualSource: { version: 1, kind: 'markdown-assets', images, warnings: [] } },
      nodes: [{ id: 'original', type: 'fact', text: sourceText, quote: sourceText, paragraph: 0 }], edges: [] }, { sourceText })
    activeCase = { ...scenario, requests: [], graphCalls: 0, baseline: store.getDocument(scenario.id) }
    const call = (endpoint, args = {}) => invoke(api, endpoint, { documentId: scenario.id, ...args })
    const started = await call('append-extract', { imageIds: selectedIds, expectedRevision: activeCase.baseline.revision,
      model: { provider: 'fixture', model: 'vision' } })
    assert(started.taskId, JSON.stringify(started))
    let terminal
    for (let attempt = 0; attempt < 500; attempt++) {
      const status = await call('task-status', { taskId: started.taskId })
      if (scenario.cancel && activeCase.release) {
        await call('task-cancel', { taskId: started.taskId })
        activeCase.release()
        activeCase.release = null
      }
      if (status.status !== 'running') { terminal = status; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert(terminal, 'Task must settle: ' + scenario.id)
    assert.equal(terminal.status, scenario.cancel ? 'cancelled' : scenario.code ? 'failed' : 'succeeded', scenario.id + ': ' + JSON.stringify(terminal))
    assert.equal(activeCase.requests.length, scenario.calls, scenario.id + ': retries must be bounded and targeted')
    if (!scenario.cancel) {
      assert(terminal.modelUsage.startedRequests >= scenario.calls)
      assert.equal(terminal.modelUsage.reportedRequests, terminal.modelUsage.startedRequests)
      assert.equal(terminal.modelUsage.totals.totalTokens.tokens, 30 * terminal.modelUsage.startedRequests, 'Usage must include rejected attempts')
    }
    const saved = store.getDocument(scenario.id)
    if (scenario.code) {
      assert.equal(terminal.error.code, scenario.code, scenario.id)
      if (scenario.code === 'revision_conflict') {
        assert.equal(saved.summary, 'Concurrent user edit in disposable fixture')
        assert.equal(saved.sourceText, sourceText)
      } else {
        assert.deepEqual(saved, activeCase.baseline, scenario.id + ': failure must not mutate SQLite')
        assert.equal(activeCase.graphCalls, 0, 'No graph generation before valid full transcription')
      }
      if (scenario.calls === 3) {
        assert.match(terminal.error.message, /图片视觉解读失败.*3/)
        assert(!terminal.error.message.includes('模型输出前') && !terminal.error.message.includes('AI 拆分失败'))
      }
    } else {
      assert.equal(saved.revision, activeCase.baseline.revision + 1)
      assert(saved.sourceText.startsWith(sourceText))
      assert(!saved.sourceText.includes('UNTRUSTED_PARTIAL'))
      assert.equal(saved.source.visualSource.images.filter(image => image.interpretationStatus === 'ai_unverified').length, 2)
      assert.equal(saved.source.visualSource.images[2].interpretationStatus, 'not_requested')
      for (const id of selectedIds) {
        const node = saved.nodes.find(node => node.type !== 'image' && node.text === 'Visible label ' + id + '.')
        assert(node, 'Successful retry must preserve every selected image and its content')
        assert(saved.edges.some(edge => edge.fromNodeId === node.id && edge.toNodeId === 'image:' + id && edge.relation === 'visual_source'))
      }
      const reopened = await openSqliteStore(process.env.DSH_KG_DB)
      try { assert.deepEqual(reopened.getDocument(scenario.id), saved) } finally { reopened.close() }
    }
    assert.equal((await call('task-active')).busy, false)
  }
} finally {
  activeCase?.release?.()
  for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
  store.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, cases: cases.length, originalImagesOnEveryAttempt: true,
  boundedRetries: true, persistentAtomicity: true, revisionFence: true, cancellation: true }))
