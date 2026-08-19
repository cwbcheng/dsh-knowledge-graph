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

function createHost(kgExtractor) {
  const routes = []
  const webServer = { register(spec) { routes.push(spec); return () => {} } }
  persistentHost.apply({
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'kgExtractor') return kgExtractor
      return null
    },
    effect(fn) { return fn() },
    interval() { return () => {} },
  })
  return routes.find((route) => route.path === '/api/dsh-knowledge-graph').handler
}

const dir = mkdtempSync('/tmp/dsh-kg-recovery-')
const dbPath = join(dir, 'recovery.sqlite')
process.env.DSH_KG_DB = dbPath
const documentId = 'document-append-recovery'
const baseText = '旧章节正文'
const baseGraph = {
  summary: 'base recovery',
  source: {
    id: 'source-base-recovery', documentId, title: 'recovery', chars: baseText.length,
    paragraphCount: 1, chunkCount: 1, sectionCount: 1,
    sections: [{ id: 'section-base', title: '旧章节', startParagraph: 0, endParagraph: 0, summary: '旧章节' }],
  },
  staging: {
    sourceId: 'source-base-recovery', documentId, chunkCount: 1,
    chunks: [{ chunkId: 'chunk-base-recovery', sourceId: 'source-base-recovery', startParagraph: 0, endParagraph: 0, sectionIds: ['section-base'], sectionTitles: ['旧章节'], summary: '旧章节', nodeIds: ['old'], edgeCount: 0, warnings: [] }],
  },
  nodes: [{ id: 'old', type: 'fact', text: '旧事实', quote: baseText, paragraph: 0, evidence: [{ paragraph: 0, quote: baseText }], documentId, sourceId: 'source-base-recovery', chunkId: 'chunk-base-recovery', sectionId: 'section-base', sectionTitle: '旧章节' }],
  edges: [],
}
const seed = await openSqliteStore(dbPath)
seed.saveGraph(baseGraph, { sourceText: baseText })
seed.close()

const appendText = '第一段追加内容'.repeat(500) + '\n\n' + '第二段追加内容'.repeat(500)
let firstHostCalls = 0
let secondBatchStartedResolve
const secondBatchStarted = new Promise((resolve) => { secondBatchStartedResolve = resolve })
const never = new Promise(() => {})
const host1Extractor = async ({ chunk }) => {
  firstHostCalls += 1
  if (firstHostCalls >= 2) {
    secondBatchStartedResolve()
    await never
  }
  const unit = chunk.units[0]
  return {
    summary: 'first recovered chunk',
    nodes: [{ id: 'n1', type: 'fact', text: '恢复前完成的追加事实', quote: unit.text, paragraph: unit.num }],
    edges: [],
  }
}
const api1 = createHost(host1Extractor)
const append = await post(api1, 'append-extract', { documentId, title: 'recovery', text: appendText })
assert(append && append.taskId, 'append recovery task was not created')
await secondBatchStarted

const checkpointStore = await openSqliteStore(dbPath)
const savedRun = checkpointStore.loadCheckpoint(append.taskId)
assert(savedRun && savedRun.status === 'running', 'mid-append checkpoint was not durable')
assert(savedRun.checkpoint && savedRun.checkpoint.version === 2 && savedRun.checkpoint.nextBatchIndex > 0, 'mid-append checkpoint did not advance')
assert(savedRun.checkpoint.totalBatches >= 2, 'recovery fixture did not create multiple append batches')
assert(savedRun.checkpoint.baseRevision === 1, 'append checkpoint did not freeze base revision')
assert(savedRun.checkpoint.baseSource && savedRun.checkpoint.baseSource.id === baseGraph.source.id, 'append checkpoint lost base source metadata')
assert(savedRun.checkpoint.baseStaging && savedRun.checkpoint.baseStaging.chunks.length === 1, 'append checkpoint lost base staging metadata')
assert(savedRun.checkpoint.graph && savedRun.checkpoint.graph.source && savedRun.checkpoint.graph.staging, 'checkpoint semantic graph did not carry base source/staging')
checkpointStore.close()

let resumedCalls = 0
const host2Extractor = async ({ chunk }) => {
  resumedCalls += 1
  const unit = chunk.units[0]
  return {
    summary: 'resumed append chunk',
    nodes: [{ id: 'n2', type: 'fact', text: '恢复后追加事实 ' + resumedCalls, quote: unit.text, paragraph: unit.num }],
    edges: [],
  }
}
const api2 = createHost(host2Extractor)
const resumed = await post(api2, 'resume-extract', { runId: append.taskId })
assert(resumed && resumed.taskId === append.taskId && resumed.resumed === true, 'Host restart did not resume append checkpoint')
let terminal = null
for (let i = 0; i < 300; i++) {
  const status = await get(api2, 'task-status', { taskId: append.taskId })
  if (status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled') { terminal = status; break }
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert(terminal && terminal.status === 'succeeded', 'resumed append did not succeed: ' + JSON.stringify(terminal))

const verifyStore = await openSqliteStore(dbPath)
const restored = verifyStore.getDocument(documentId)
const finishedRun = verifyStore.loadCheckpoint(append.taskId)
verifyStore.close()
assert(restored && restored.revision === 2, 'resumed append did not persist revision 2')
assert(restored.source.previousId === baseGraph.source.id, 'resumed append lost previous source-version link')
assert(restored.staging.chunks.length === 1 + savedRun.checkpoint.totalBatches, 'resumed append lost base or completed chunk metadata')
assert(restored.staging.chunks.some((chunk) => chunk.chunkId === 'chunk-base-recovery' && chunk.sourceId === baseGraph.source.id), 'resumed append lost the original canonical chunk')
assert(restored.source.sections.some((section) => section.id === 'section-base'), 'resumed append lost original section metadata')
assert(restored.nodes.some((node) => node.id === 'old'), 'resumed append lost original semantic nodes')
assert(finishedRun && finishedRun.status === 'succeeded', 'resumed append checkpoint was not marked succeeded')
assert(resumedCalls === savedRun.checkpoint.totalBatches - savedRun.checkpoint.nextBatchIndex, 'resume re-ran already completed append batches')

rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({
  ok: true,
  totalAppendBatches: savedRun.checkpoint.totalBatches,
  resumedCalls,
  restoredChunks: restored.staging.chunks.length,
  restoredSections: restored.source.sections.length,
}))
