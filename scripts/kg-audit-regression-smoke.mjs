import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import hostPlugin from '../src/index.host.js'

const work = mkdtempSync(join(tmpdir(), 'kg-audit-regression-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(work, 'test.sqlite')
const sourceText = 'Alpha source.\n\nBeta source.'
const graph = {
  summary: 'Original', source: { id: 'source-audit', documentId: 'audit', title: 'Audit' },
  nodes: sourceText.split('\n\n').map((text, paragraph) => ({ id: 'n' + paragraph, type: 'fact', text, quote: text, paragraph, evidence: [{ paragraph, quote: text }] })), edges: [],
}
function post(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    Object.assign(req, { method: 'POST', url: '/api/dsh-knowledge-graph/' + endpoint, headers: {} })
    const res = { setHeader() {}, writeHead() {}, end(body) { resolve(JSON.parse(body || '{}')) } }
    Promise.resolve(handler(req, res)).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
try {
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  store.saveGraph(graph, { sourceText, sourceUnits: sourceText.split('\n\n') })
  store.close()
  const routes = []
  const { apply } = await import('../lib/index.js')
  const effects = []
  apply({ get: name => name === 'webServer' ? { register(spec) { routes.push(spec); return () => {} } } : null, effect: fn => { effects.push(fn()); }, interval: () => () => {} })
  const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const handlers = new Map()
  const previousHarness = globalThis.harness
  globalThis.harness = { handle: (name, fn) => handlers.set(name, fn) }
  try {
    hostPlugin().apply({ get: name => name === 'kgExtractor' ? async () => structuredClone(graph) : null, interval: () => () => {} })
  } finally { globalThis.harness = previousHarness }
  const started = await handlers.get('extract')({ text: sourceText, title: 'Audit' })
  let status
  for (let n = 0; n < 300; n++) {
    status = await handlers.get('task-status')({ taskId: started.taskId })
    if (status.status !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(status.status, 'succeeded')
  const dynamicId = status.result.source.documentId
  for (const [id, call] of [['audit', (name, args) => post(api, name, args)], [dynamicId, (name, args) => handlers.get(name)(args)]]) {
    const loaded = await call('document-load', { documentId: id })
    const payload = { documentId: id, graph: loaded.graph, baseNodeIds: loaded.graph.nodes.map(node => node.id), baseEdgeKeys: [] }
    const edited = await call('graph-commit', { ...payload, expectedRevision: 1, graph: { ...loaded.graph, summary: 'Keep concurrent edit' } })
    assert.equal(edited.revision, 2)
    assert.equal((await call('graph-commit', { ...payload, expectedRevision: 1 })).error.code, 'revision_conflict')
    for (const expectedRevision of [undefined, null, '2', -1, 2.5]) {
      assert.equal((await call('graph-commit', { ...payload, expectedRevision })).error.code, 'invalid_input')
    }
    assert.equal((await call('relation-retry', { documentId: id })).error.code, 'invalid_input')
    const exported = await call('document-export', { documentId: id })
    assert.equal(exported.revision, 2)
    assert.equal(exported.graph.summary, 'Keep concurrent edit')
  }
  for (const dispose of effects) if (typeof dispose === 'function') dispose()

  const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('function historyMetadata('), source.indexOf('function formatTime('))
  const values = new Map()
  const localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  let docs = []
  let responder = async () => ({ documents: docs })
  const history = new Function('host', 'localStorage', 'LS_HISTORY', 'LS_HISTORY_HIDDEN', 'HISTORY_MAX', body + ';return { mergeServerHistory, appendHistory, loadHistory, saveHistory, hideHistoryEntries }')({ call: () => responder() }, localStorage, 'history', 'hidden', 20)
  const old = Array.from({ length: 20 }, (_, i) => ({ id: 'old-' + i, documentId: 'old-' + i, ts: i + 1 }))
  history.saveHistory(old)
  docs = [{ documentId: 'new', updatedAt: 9999 }, ...old.map(entry => ({ ...entry, updatedAt: entry.ts }))]
  const capped = await history.mergeServerHistory(old)
  assert.equal(capped[0].documentId, 'new', 'New server documents must not be hidden by the cap')
  const removed = capped[0]
  history.hideHistoryEntries([removed], false)
  history.saveHistory(capped.slice(1))
  assert(!(await history.mergeServerHistory(capped)).some(entry => entry.documentId === removed.documentId))

  let resolveResponse
  responder = () => new Promise(resolve => { resolveResponse = resolve })
  const pending = history.mergeServerHistory(capped)
  history.hideHistoryEntries(capped, true)
  history.saveHistory([])
  resolveResponse({ documents: docs })
  assert.deepEqual(await pending, [], 'An in-flight response must not undo Clear history')
  assert.deepEqual(history.loadHistory(), [], 'Reload must apply tombstones before the server responds')
  let rejectResponse
  responder = () => new Promise((resolve, reject) => { rejectResponse = reject })
  const failedPending = history.mergeServerHistory(capped)
  rejectResponse(new Error('offline'))
  assert.deepEqual(await failedPending, [], 'A failed in-flight response must not restore stale history')
  localStorage.removeItem('hidden')
  responder = async () => ({ documents: docs })
  assert((await history.mergeServerHistory([])).some(entry => entry.documentId === 'new'), 'Hidden records must be restorable')
  history.hideHistoryEntries([removed], false)
  history.appendHistory(history.loadHistory(), { ...removed, ts: Date.now() })
  assert((await history.mergeServerHistory(history.loadHistory())).some(entry => entry.documentId === removed.documentId), 'An explicit new visit must unhide the record')
  responder = () => new Promise(resolve => { resolveResponse = resolve })
  const visitPending = history.mergeServerHistory(history.loadHistory())
  history.appendHistory(history.loadHistory(), { id: 'during-fetch', documentId: 'during-fetch', ts: Date.now() })
  resolveResponse({ documents: docs })
  assert((await visitPending).some(entry => entry.documentId === 'during-fetch'), 'A fetch must preserve a visit made while it was pending')
  const future = Date.now() + 600000
  docs = Array.from({ length: 24 }, (_, i) => ({ documentId: 'ahead-' + i, updatedAt: future - i }))
  responder = async () => ({ documents: docs })
  const ahead = await history.mergeServerHistory([])
  history.hideHistoryEntries(ahead, true)
  history.saveHistory([])
  assert.deepEqual(await history.mergeServerHistory([]), [], 'Clock skew must not resurrect records beyond the display cap after Clear')
  console.log(JSON.stringify({ ok: true, dynamicAndPersistentCas: true, missingRevisionRejected: true, historyRemovalDurable: true, historyRaceSafe: true, newestDocumentVisible: true }))
} finally {
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(work, { recursive: true, force: true })
}
