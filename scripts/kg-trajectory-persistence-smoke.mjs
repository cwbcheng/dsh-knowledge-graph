import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function post(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/dsh-knowledge-graph/' + endpoint
    req.headers = {}
    const res = {
      status: 0, body: '', setHeader() {},
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve(JSON.parse(this.body || '{}')) },
    }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') })
  })
}

function get(handler, endpoint, params) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'GET'
    const query = new URLSearchParams(params || {}).toString()
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (query ? '?' + query : '')
    req.headers = {}
    const res = {
      status: 0, body: '', setHeader() {},
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve(JSON.parse(this.body || '{}')) },
    }
    handler(req, res).catch(reject)
    process.nextTick(() => req.emit('end'))
  })
}

async function waitTrajectory(api, taskId) {
  for (let i = 0; i < 300; i++) {
    const status = await get(api, 'trajectory-status', { taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('trajectory task did not finish: ' + taskId)
}

const dir = mkdtempSync('/tmp/dsh-kg-trajectory-')
const dbPath = join(dir, 'trajectory.sqlite')
process.env.DSH_KG_DB = dbPath
const sessionId = 'session-trajectory-persistence'
const session = {
  events: [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'seed' }] } },
  ],
}
let extractionCount = 0
const kgExtractor = async ({ chunk, existingNodeIds }) => {
  const unit = chunk.units[0]
  const quote = unit && unit.text ? unit.text : ''
  extractionCount += 1
  if (!Array.isArray(existingNodeIds) || existingNodeIds.length === 0) {
    return {
      summary: 'large trajectory',
      nodes: Array.from({ length: 801 }, (_, index) => ({
        id: 't' + (index + 1),
        type: 'fact',
        text: '轨迹节点 ' + (index + 1),
        quote,
        paragraph: unit.num,
      })),
      edges: [],
    }
  }
  return {
    summary: 'trajectory append ' + extractionCount,
    nodes: [{ id: 't-new-' + extractionCount, type: 'fact', text: '轨迹追加节点 ' + extractionCount, quote, paragraph: unit.num }],
    edges: [],
  }
}

const routes = []
const webServer = { register(spec) { routes.push(spec); return () => {} } }
const sessions = { get(id) { return id === sessionId ? session : undefined } }
persistentHost.apply({
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'sessions') return sessions
    if (name === 'kgExtractor') return kgExtractor
    return null
  },
  effect(fn) { return fn() },
  interval() { return () => {} },
})
const api = routes.find((route) => route.path === '/api/dsh-knowledge-graph').handler

try {
  const started = await post(api, 'trajectory-extract', { sessionId })
  assert(started && started.taskId, 'initial trajectory task was not created')
  const initial = await waitTrajectory(api, started.taskId)
  assert(initial.status === 'succeeded' && initial.result, 'initial trajectory extraction failed: ' + JSON.stringify(initial))
  assert(initial.result.nodes.length === 800 && initial.result.view && initial.result.view.totalNodes === 801, 'trajectory renderer view is not bounded at 800 nodes')
  const documentId = initial.result.source && initial.result.source.documentId
  assert(documentId, 'trajectory result has no canonical documentId')

  let store = await openSqliteStore(dbPath)
  let canonical = store.getDocument(documentId)
  assert(canonical && canonical.nodes.length === 801, 'initial trajectory canonical graph was truncated')
  assert(canonical.revision === 1, 'initial trajectory revision is not 1')
  assert(typeof canonical.traceText === 'string' && canonical.traceText.includes('用户消息：seed'), 'trajectory traceText was not persisted in graph metadata')
  assert(Array.isArray(canonical.traceEvents) && canonical.traceEvents.length === 1 && canonical.traceEvents[0].seq === 1, 'trajectory traceEvents were not persisted in graph metadata')
  store.close()

  session.events.push({ seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'append-one' }] } })
  const firstAppend = await post(api, 'trajectory-append-extract', { sessionId, documentId, expectedRevision: 1 })
  assert(firstAppend && firstAppend.taskId, 'first canonical trajectory append was not created: ' + JSON.stringify(firstAppend))
  const firstDone = await waitTrajectory(api, firstAppend.taskId)
  assert(firstDone.status === 'succeeded', 'first trajectory append failed: ' + JSON.stringify(firstDone))

  store = await openSqliteStore(dbPath)
  canonical = store.getDocument(documentId)
  assert(canonical && canonical.nodes.length === 802, 'first trajectory append lost nodes beyond the browser window')
  assert(canonical.revision === 2 && canonical.source.documentId === documentId, 'first trajectory append did not advance the same logical document')
  assert(canonical.traceEvents.length === 2 && canonical.traceEvents[1].seq === 2, 'first trajectory append did not extend canonical trace events')
  store.close()

  session.events.push({ seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'append-two' }] } })
  const secondAppend = await post(api, 'trajectory-append-extract', { sessionId, documentId, expectedRevision: 2 })
  assert(secondAppend && secondAppend.taskId, 'second canonical trajectory append was not created')
  const secondDone = await waitTrajectory(api, secondAppend.taskId)
  assert(secondDone.status === 'succeeded', 'second trajectory append failed: ' + JSON.stringify(secondDone))

  store = await openSqliteStore(dbPath)
  canonical = store.getDocument(documentId)
  const documents = store.listDocuments(20)
  assert(canonical && canonical.nodes.length === 803, 'repeated trajectory append lost canonical nodes')
  assert(canonical.revision === 3, 'repeated trajectory append did not advance revision to 3')
  assert(documents.length === 1 && documents[0].documentId === documentId, 'trajectory append created a new logical document instead of a revision')
  assert(canonical.traceEvents.length === 3 && canonical.traceEvents[2].seq === 3, 'repeated trajectory append lost trace event metadata')
  store.close()

  const stale = await post(api, 'trajectory-append-extract', { sessionId, documentId, expectedRevision: 2 })
  assert(stale && stale.error && stale.error.code === 'revision_conflict' && stale.error.currentRevision === 3, 'stale trajectory append bypassed revision fence')

  console.log(JSON.stringify({
    ok: true,
    documentId,
    initialCanonicalNodes: 801,
    finalCanonicalNodes: 803,
    finalRevision: 3,
    traceEvents: 3,
    logicalDocuments: 1,
  }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
