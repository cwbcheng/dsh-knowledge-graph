import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'kg-run-delete-'))
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'test.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const cleanups = []
function createHost(extractor) {
  let handler
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
    return name === 'kgExtractor' ? extractor : null
  }, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
  return handler
}
function request(handler, endpoint, body = {}, method = 'POST', headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method; req.headers = headers
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    let status
    const res = { setHeader() {}, writeHead(code) { status = code }, end(data) { resolve({ status, body: JSON.parse(data || '{}') }) } }
    Promise.resolve(handler(req, res)).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.emit('end') })
  })
}
const seed = (runId, status = 'failed') => {
  store.saveCheckpoint({ version: 2, documentId: 'doc', sourceId: 'source-' + createHash('sha256').update('原文').digest('hex'), baseRevision: 1, graph: { nodes: [], edges: [] }, totalBatches: 1, nextBatchIndex: 0 }, { runId, status, sourceText: '原文', title: 'Task ' + runId })
  return { runId, expectedUpdatedAt: store.loadCheckpoint(runId).updatedAt }
}
try {
  store.saveGraph({ source: { documentId: 'doc', id: 'src' }, nodes: [{ id: 'n0', type: 'fact', paragraph: 0, text: '原文', quote: '原文' }], edges: [], summary: 'Keep me' }, { sourceText: '原文' })
  const graphBefore = store.getDocument('doc')
  const handler = createHost({ async extract() { return { summary: '', nodes: [], edges: [] } } })
  const target = seed('target'), sibling = seed('sibling'), orphan = seed('orphan', 'running')
  assert.equal((await request(handler, 'extraction-run-delete', target, 'GET')).status, 405)
  assert.equal((await request(handler, 'extraction-run-delete', target, 'POST', { origin: 'https://evil.example', host: '127.0.0.1:3080' })).status, 403)
  assert.equal((await request(handler, 'extraction-run-delete', target, 'POST', {})).status, 403)
  for (const input of ['{', {}, { ...target, expectedUpdatedAt: '1' }, { ...target, runId: 'x'.repeat(201) }]) {
    assert.equal((await request(handler, 'extraction-run-delete', input)).body.error.code, 'invalid_input')
  }
  assert.equal((await request(handler, 'extraction-run-delete', { ...target, expectedUpdatedAt: target.expectedUpdatedAt - 1 })).body.error.code, 'run_conflict')
  assert(store.loadCheckpoint('target'))
  assert.equal((await request(handler, 'extraction-run-delete', target)).body.deleted, true)
  assert.equal((await request(handler, 'extraction-run-delete', target)).body.deleted, false, 'repeated deletion is idempotent')
  assert.equal((await request(handler, 'resume-extract', { runId: 'target', retryFailed: true })).body.error.code, 'not_found')
  assert.equal(store.loadCheckpoint('target'), null)
  assert(store.loadCheckpoint(sibling.runId))
  assert.deepEqual(store.getDocument('doc'), graphBefore, 'canonical graph and revision must not change')
  assert.equal((await request(handler, 'extraction-run-delete', orphan)).body.deleted, true, 'orphaned running checkpoint is not a live task')
  const finished = seed('finished', 'succeeded')
  assert.equal((await request(handler, 'extraction-run-delete', finished)).body.error.code, 'run_conflict')

  // Race a resume against deletion on a newly initialized Host. The winner
  // must exclude the other operation even across lazy store initialization.
  const race = seed('race')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const racing = createHost(async () => { await gate; throw new Error('Synthetic failure') })
  const [resume, deletion] = await Promise.all([
    request(racing, 'resume-extract', { runId: race.runId, retryFailed: true }),
    request(racing, 'extraction-run-delete', race),
  ])
  assert(!(resume.body.taskId && deletion.body.deleted), 'resume and delete cannot both win')
  if (resume.body.taskId) {
    assert.equal(deletion.body.error.code, 'busy')
    assert.equal((await request(racing, 'extraction-run-delete', race)).body.error.code, 'busy')
    await request(racing, 'task-cancel', { taskId: race.runId })
  } else assert.equal(resume.body.error.code, 'not_found')
  release()
  for (let i = 0; i < 200; i++) {
    if (!(await request(racing, 'task-active', {}, 'GET')).body.busy) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal((await request(racing, 'task-active', {}, 'GET')).body.busy, false)
  const restarted = createHost(null)
  assert(!(await request(restarted, 'extraction-run-list', {}, 'GET')).body.runs.some(run => run.runId === 'target'), 'deletion survives a fresh Host')

  const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const actionCode = client.slice(client.indexOf('        const deleteSavedRun = async'), client.indexOf('        const graphRevisionRef ='))
  let calls = 0, confirm = false, error = '', rows = [{ runId: 'ui', title: 'Example', updatedAt: 42 }]
  let pending = JSON.stringify({ taskId: 'other' }), response = { deleted: true, runId: 'ui' }, refreshing = 0
  const lock = { current: false }
  const action = new Function('host', 'window', 'runActionRef', 'taskId', 'setDeletingRun', 'setRunsError', 'setIncompleteRuns', 'localStorage', 'LS_PENDING', 'toastStore', 'setRunsRefresh', actionCode + '; return deleteSavedRun')(
    { async call(name, payload) { calls++; assert.equal(name, 'extraction-run-delete'); assert.deepEqual(payload, { runId: 'ui', expectedUpdatedAt: 42 }); return response } },
    { confirm(message) { assert.match(message, /永久删除/); return confirm } }, lock, null, () => {}, value => { error = value }, fn => { rows = fn(rows) },
    { getItem() { return pending }, removeItem() { pending = null } }, 'pending', { show() {} }, () => { refreshing++ })
  const row = rows[0]
  await action(row)
  assert.equal(calls, 0, 'cancel confirmation must make no request')
  confirm = true; lock.current = true
  await action(row)
  assert.equal(calls, 0, 'concurrent resume/delete must be excluded before React rerenders')
  lock.current = false; response = { error: { message: 'Task busy' } }
  await action(row)
  assert.equal(rows.length, 1); assert.equal(error, 'Task busy'); assert.equal(refreshing, 0, 'automatic refresh must not erase a failure message')
  response = { deleted: true, runId: 'ui' }
  await action(row)
  assert.equal(rows.length, 0); assert.equal(JSON.parse(pending).taskId, 'other', 'unrelated pending reference remains intact')
  pending = JSON.stringify({ taskId: 'ui' }); await action(row)
  assert.equal(pending, null)
  console.log(JSON.stringify({ ok: true, deleteAndRestart: true, graphPreserved: true, staleGuard: true, originFence: true, activeAndResumeRace: true, confirmationAndUIErrors: true }))
} finally {
  for (const cleanup of cleanups.reverse()) cleanup()
  store.close()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
