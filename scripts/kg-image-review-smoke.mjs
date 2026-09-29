import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createGraphContract } from '../src/index.host.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-image-review-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'fixture.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const sourceText = '原书文字。\n\nAI 视觉转写。\n\n仅在条件 A 下适用。'
const graph = { source: { id: 'source-review', documentId: 'book-review', visualSource: { kind: 'markdown-assets', images: [
  { id: 'fig-1', name: 'same.png', caption: '条件表', summary: '条件 A 的记录', warnings: ['单位待辨认'],
    attachment: { attachmentId: 'pixels-a', mediaType: 'image/png' }, interpretationStatus: 'ai_unverified', startParagraph: 1, endParagraph: 2 },
  { id: 'fig-2', name: 'same.png', attachment: { attachmentId: 'pixels-b' }, interpretationStatus: 'not_requested' },
] } }, nodes: [{ id: 'n1', type: 'fact', text: '仅在条件 A 下适用。', paragraph: 2,
  quote: '仅在条件 A 下适用。', entailmentStatus: 'unverified' }], edges: [],
  verification: { stale: false, lastReport: { reportId: 'preserved-report', issues: [] } } }
store.saveGraph(graph, { sourceText })
const routes = [], cleanups = []
let holdFixtureTask = false, releaseFixtureTask
const invoke = (api, payload, endpoint = 'image-review') => new Promise((resolve, reject) => {
  const request = new EventEmitter()
  request.method = endpoint === 'task-status' ? 'GET' : 'POST'
  request.url = '/api/dsh-knowledge-graph/' + endpoint + (request.method === 'GET' ? '?' + new URLSearchParams(payload) : '')
  request.headers = { 'content-type': 'application/json' }
  const response = { writeHead() {}, setHeader() {}, end(body) { resolve(body ? JSON.parse(body) : {}) } }
  Promise.resolve(api(request, response)).catch(reject)
  process.nextTick(() => { request.emit('data', Buffer.from(JSON.stringify(payload))); request.emit('end') })
})
try {
  const plugin = await import('../lib/index.js?image-review=' + Date.now())
  plugin.apply({ get(name) {
    if (name === 'webServer') return { register(spec) { routes.push(spec); return () => {} } }
    if (name === 'llm') return { stream() { throw new Error('Manual image review must not use a model') } }
    if (name === 'kgExtractor') return { async extractChunk() {
      assert(holdFixtureTask, 'Manual image review must not generate nodes')
      await new Promise(resolve => { releaseFixtureTask = resolve })
      return { summary: 'Busy fixture', nodes: [{ id: 't', type: 'fact', text: '隔离占位内容。', paragraph: 0, quote: '隔离占位内容。' }], edges: [] }
    } }
    return null
  }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const call = payload => invoke(api, { documentId: 'book-review', ...payload })
  let baseline = store.getDocument('book-review')
  const list = () => call({ action: 'list', expectedRevision: baseline.revision })
  const initial = await list()
  assert(Array.isArray(initial.reviews), 'Pending image labels need a readable and writable review workflow: ' + JSON.stringify(initial))
  const first = initial.reviews.find(item => item.imageId === 'fig-1')
  assert.equal(first.status, 'pending')
  assert.equal(first.version, 0)
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(initial.reviews.find(item => item.imageId === 'fig-2').reviewable, false)
  const request = { action: 'save', imageId: 'fig-1', expectedRevision: baseline.revision,
    expectedVersion: 0, fingerprint: first.fingerprint, status: 'matched', confirmed: true, note: '' }
  holdFixtureTask = true
  const ownedTask = await invoke(api, { text: '隔离占位内容。', model: { provider: 'fixture', model: 'fixture' } }, 'extract')
  assert(ownedTask.taskId, JSON.stringify(ownedTask))
  try {
    assert.equal((await call(request)).error?.code, 'busy', 'Live Host must reject saves while a generation owns the task lock')
    assert(Array.isArray((await list()).reviews), 'Read-only review remains available during generation')
    for (let i = 0; !releaseFixtureTask && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert(releaseFixtureTask, 'Controlled task must reach its owned fixture gate')
  } finally { releaseFixtureTask?.() }
  let terminal
  for (let i = 0; i < 500; i++) {
    terminal = await invoke(api, { taskId: ownedTask.taskId }, 'task-status')
    if (terminal.status !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(terminal.status, 'succeeded', JSON.stringify(terminal))
  holdFixtureTask = false
  assert.deepEqual(store.getDocument('book-review'), baseline)
  for (const [patch, code] of [
    [{ confirmed: false }, 'invalid_input'], [{ expectedRevision: 0 }, 'revision_conflict'],
    [{ fingerprint: '0'.repeat(64) }, 'image_review_conflict'], [{ expectedVersion: 1 }, 'image_review_conflict'],
    [{ status: 'verified' }, 'invalid_input'], [{ status: 'needs_correction', note: ' ' }, 'invalid_input'],
    [{ note: 'x'.repeat(2001) }, 'invalid_input'], [{ imageId: 'fig-2' }, 'image_not_interpreted'],
    [{ imageId: 'missing' }, 'not_found'], [{ documentId: 'another-book' }, 'not_found'],
    [{ graph: { nodes: [{ id: 'n1', entailmentStatus: 'verified' }] } }, 'invalid_input'],
  ]) {
    assert.equal((await call({ ...request, ...patch })).error?.code, code, JSON.stringify(patch))
    assert.deepEqual(store.getDocument('book-review'), baseline)
  }
  store.db.exec(`CREATE TRIGGER reject_image_review BEFORE INSERT ON image_reviews BEGIN SELECT RAISE(FAIL, 'controlled review write failure'); END`)
  const rejectedWrite = await call(request)
  assert(rejectedWrite.error, 'Storage failure must not be acknowledged as saved')
  assert.deepEqual(store.listImageReviews('book-review'), [])
  assert.deepEqual(store.getDocument('book-review'), baseline)
  store.db.exec('DROP TRIGGER reject_image_review')
  const saved = await call(request)
  assert.equal(saved.review?.status, 'matched', JSON.stringify(saved))
  assert.equal(saved.review.version, 1)
  assert.equal(saved.review.reviewer, 'user')
  assert.deepEqual(store.getDocument('book-review'), baseline, 'Review metadata must not change graph, source, report or revision')
  assert.equal((await call(request)).error.code, 'image_review_conflict', 'Duplicate/stale writes must not replace a review')
  const reopened = await openSqliteStore(process.env.DSH_KG_DB)
  try { assert.equal(reopened.listImageReviews('book-review')[0].status, 'matched') } finally { reopened.close() }
  const changed = await call({ ...request, expectedVersion: 1, status: 'needs_correction', note: '原图单位不清晰，不能确认数值。' })
  assert.equal(changed.review.status, 'needs_correction')
  assert.equal(changed.review.version, 2)
  assert.equal((await call({ ...request, expectedVersion: 1 })).error.code, 'image_review_conflict')
  const revoked = await call({ ...request, expectedVersion: 2, status: 'pending', confirmed: false })
  assert.equal(revoked.review.status, 'pending')
  assert.equal(revoked.review.version, 3, 'Revocation retains CAS history instead of resetting it')
  await call({ ...request, expectedVersion: 3 })

  // An unrelated node change cannot make a pixel/transcript check authoritative for node semantics.
  const semanticEdit = structuredClone(baseline)
  semanticEdit.nodes[0].text = 'An unrelated semantic edit'
  semanticEdit.source.id = 'rekeyed-after-unrelated-append'
  store.saveGraph(semanticEdit, { sourceText, expectedRevision: baseline.revision })
  baseline = store.getDocument('book-review')
  assert.equal((await list()).reviews[0].status, 'matched')
  assert.equal((await call({ ...request, expectedVersion: 4 })).error.code, 'revision_conflict')
  // Same image ID and filename, but different pixels or transcript, must invalidate the result.
  for (const change of ['pixels', 'transcript', 'summary', 'warnings']) {
    const current = structuredClone(baseline)
    let text = current.sourceText
    const image = current.source.visualSource.images[0]
    if (change === 'pixels') image.attachment.attachmentId = 'replacement-pixels'
    if (change === 'transcript') text = text.replace('仅在条件 A 下适用。', '不适用于条件 A。')
    if (change === 'summary') image.summary += '，新增结论'
    if (change === 'warnings') image.warnings = ['新的识别疑点']
    store.saveGraph(current, { sourceText: text, expectedRevision: baseline.revision })
    baseline = store.getDocument('book-review')
    const stale = (await list()).reviews[0]
    assert.equal(stale.status, 'pending', change)
    assert.equal(stale.stale, true, change)
    assert.equal((await call({ ...request, expectedRevision: baseline.revision, expectedVersion: stale.version })).error.code, 'image_review_conflict')
    const fresh = await call({ ...request, expectedRevision: baseline.revision,
      expectedVersion: stale.version, fingerprint: stale.fingerprint })
    assert.equal(fresh.review.status, 'matched', change)
    assert.equal(fresh.review.stale, false)
    assert.deepEqual(store.getDocument('book-review'), baseline)
  }
  store.db.prepare('DELETE FROM documents WHERE document_id = ?').run('book-review')
  assert.deepEqual(store.listImageReviews('book-review'), [], 'Document deletion must remove orphan review records')

  // Exercise the dynamic Host handler with its real shared helpers and canonical snapshot.
  const host = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
  const helpers = host.slice(host.indexOf('      function imageReviewsHost('), host.indexOf('      function visualTextHost('))
  const handler = host.slice(host.indexOf("       harness.handle('image-review'"), host.indexOf("       harness.handle('image-nodes'"))
  const setup = new Function('harness', 'busy', 'loadCanonicalDocumentHost', 'imageReviewState', 'splitParagraphsHost', 'sha256HexHost', 'canonicalDocumentIdHost',
    "const busyTaskResponseHost = () => ({error:{code:'busy'}});\n" + helpers + handler)
  for (const busy of [false, true]) {
    const handlers = new Map(), state = new Map()
    const snapshot = { graph, sourceText, revision: 1 }
    setup({ handle: (name, fn) => handlers.set(name, fn) }, busy, id => id === 'book-review' ? snapshot : null,
      state, createGraphContract().splitParagraphs, value => createHash('sha256').update(value).digest('hex'), value => value.source.documentId)
    const dynamic = payload => handlers.get('image-review')({ documentId: 'book-review', expectedRevision: 1, ...payload })
    const first = (await dynamic({ action: 'list' })).reviews[0]
    const next = await dynamic({ ...request, expectedRevision: 1, fingerprint: first.fingerprint })
    if (busy) { assert.equal(next.error.code, 'busy'); assert.equal(state.size, 0) }
    else {
      assert.equal(next.review.status, 'matched')
      assert.equal((await dynamic({ action: 'list' })).reviews[0].status, 'matched')
      assert.deepEqual(snapshot, { graph, sourceText, revision: 1 })
    }
  }
  console.log(JSON.stringify({ ok: true, independentReviewState: true, durable: true, versionFence: true,
    sourceFingerprint: true, noSemanticPromotion: true, noModelCalls: true, failedWriteAtomicity: true, dynamicHost: true, busyGuard: true }))
} finally {
  for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
  store.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(directory, { recursive: true, force: true })
}
