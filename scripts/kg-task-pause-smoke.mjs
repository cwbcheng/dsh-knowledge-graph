import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSqliteStore } from '../src/kg-store.mjs'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import * as host from '../lib/index.js'

const source = ['甲', '乙', '丙', '丁'].map((name, i) => '# ' + name + '\n\n' + name + '设备功率为' + (i + 1) + '瓦。').join('\n\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const cleanups = []
function createHost(extractor, llm = null) {
  let api
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') api = route.handler; return () => {} } }
    return name === 'kgExtractor' ? extractor : name === 'llm' ? llm : null
  }, effect(fn) { const dispose = fn(); if (dispose) cleanups.push(dispose) }, interval() { return () => {} } })
  return (endpoint, body = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method; req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    Promise.resolve(api(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function until(fn, message) {
  for (let i = 0; i < 1000; i++) { const value = await fn(); if (value) return value; await sleep(5) }
  throw Error(message)
}
const getStatus = (api, taskId) => api('task-status', { taskId }, 'GET')
const settled = (api, taskId) => until(async () => {
  const value = await getStatus(api, taskId)
  return ['running', 'pausing'].includes(value.status) ? null : value
}, 'Task did not settle')
const resultOf = chunk => {
  const unit = chunk.units.find(unit => unit.text.includes('设备功率'))
  return { summary: '设备记录', nodes: [{ id: 'n1', type: 'fact', text: unit.text, quote: unit.text, paragraph: unit.num }], edges: [] }
}

if (process.argv[2] === 'kill-worker') {
  let entered = false
  const api = createHost(async ({ chunk }) => {
    entered = true
    await new Promise(() => { setInterval(() => {}, 1000) })
    return resultOf(chunk)
  })
  const started = await api('extract', { text: source, concurrency: 1 })
  await until(() => entered, 'No request started')
  const paused = await api('task-pause', { taskId: started.taskId })
  assert.equal(paused.status, 'pausing', 'a non-cooperative provider must keep the runtime locked')
  process.send({ taskId: started.taskId })
} else {
  const dir = mkdtempSync(join(tmpdir(), 'kg-task-pause-'))
  const previousDb = process.env.DSH_KG_DB
  process.env.DSH_KG_DB = join(dir, 'test.sqlite')
  const store = await openSqliteStore(process.env.DSH_KG_DB)
  try {
    let streams = 0, aborts = 0
    const streamingApi = createHost(null, { async *stream({ signal }) {
      streams++
      await new Promise(resolve => signal.addEventListener('abort', () => { aborts++; resolve() }, { once: true }))
    } })
    const started = await streamingApi('extract', { text: source, concurrency: 2, model: { provider: 'fixture', model: 'original' } })
    await until(() => streams === 2, 'Parallel streams did not start')
    assert.equal((await getStatus(streamingApi, started.taskId)).progress.canPause, true)
    const pause = await streamingApi('task-pause', { taskId: started.taskId })
    assert(['pausing', 'paused'].includes(pause.status), JSON.stringify(pause))
    const paused = await settled(streamingApi, started.taskId)
    assert.equal(paused.status, 'paused', JSON.stringify(paused))
    assert.equal(aborts, 2, 'pause must abort all concurrent streams')
    assert.equal(store.loadCheckpoint(started.taskId).status, 'paused')
    assert.equal(store.listIncompleteRuns().find(run => run.runId === started.taskId).status, 'paused')
    assert.equal((await streamingApi('task-pause', { taskId: started.taskId })).status, 'paused', 'pause is idempotent')
    assert.equal((await streamingApi('task-active', {}, 'GET')).busy, false)
    assert.equal((await streamingApi('resume-extract', { runId: started.taskId, retryFailed: true })).error.code, 'task_paused')
    assert.equal(streams, 2, 'retryFailed must never authorize resuming an explicitly paused task')

    const calls = []
    const recoveredApi = createHost(async ({ chunk }) => { calls.push(chunk.chunkId); return resultOf(chunk) })
    assert.equal((await recoveredApi('resume-extract', { runId: started.taskId })).error.code, 'task_paused', 'a new Host must respect durable pause intent')
    assert.equal(calls.length, 0)
    const resumed = await recoveredApi('resume-extract', { runId: started.taskId, resumePaused: true })
    assert.equal(resumed.taskId, started.taskId)
    assert.equal((await settled(recoveredApi, resumed.taskId)).status, 'succeeded')
    assert.equal(store.loadCheckpoint(started.taskId).checkpoint.model.model, 'original', 'resume preserves the original model')

    // A completed sibling remains buffered while an uncooperative sibling drains.
    let release, blocked = false
    const waveCalls = []
    const waveApi = createHost(async ({ chunk }) => {
      const index = Number(chunk.chunkId.slice(-4)) - 1
      waveCalls.push(index)
      if (index === 0) { blocked = true; await new Promise(resolve => { release = resolve }) }
      return resultOf(chunk)
    })
    const wave = await waveApi('extract', { text: source, concurrency: 2 })
    await until(() => blocked && store.loadCheckpoint(wave.taskId)?.checkpoint.pendingWave?.results?.[1]?.stage === 'complete', 'Sibling result was not saved')
    const sibling = JSON.stringify(store.loadCheckpoint(wave.taskId).checkpoint.pendingWave.results[1])
    assert.equal((await waveApi('task-pause', { taskId: wave.taskId })).status, 'pausing')
    assert.equal(store.loadCheckpoint(wave.taskId).status, 'paused')
    assert.equal((await waveApi('task-active', {}, 'GET')).busy, true, 'pausing must not release admission early')
    assert.equal((await waveApi('task-cancel', { taskId: wave.taskId })).status, 'pausing', 'a late cancel cannot replace pause intent')
    assert.equal((await waveApi('resume-extract', { runId: wave.taskId, resumePaused: true })).error.code, 'busy')
    release()
    assert.equal((await settled(waveApi, wave.taskId)).status, 'paused')
    const waveSaved = store.loadCheckpoint(wave.taskId)
    assert.equal(JSON.stringify(waveSaved.checkpoint.pendingWave.results[1]), sibling)
    const waveResumeCalls = []
    const waveResumeApi = createHost(async ({ chunk }) => { waveResumeCalls.push(Number(chunk.chunkId.slice(-4)) - 1); return resultOf(chunk) })
    const next = await waveResumeApi('resume-extract', { runId: wave.taskId, resumePaused: true })
    assert.equal((await settled(waveResumeApi, next.taskId)).status, 'succeeded')
    assert(!waveResumeCalls.includes(1), 'a completed sibling must not be regenerated')

    store.db.exec("CREATE TRIGGER reject_pause BEFORE UPDATE ON extraction_runs WHEN NEW.status = 'paused' BEGIN SELECT RAISE(ABORT, 'fixture pause write failure'); END")
    const failureStart = streams
    const failing = await streamingApi('extract', { text: source, concurrency: 2, model: { provider: 'fixture', model: 'original' } })
    await until(() => streams === failureStart + 2, 'Failure fixture did not start')
    const refused = await Promise.all([streamingApi('task-pause', { taskId: failing.taskId }), streamingApi('task-pause', { taskId: failing.taskId })])
    for (const response of refused) assert.equal(response.error?.code, 'persistence_failed', 'duplicate pause must also await durable intent')
    const failed = await settled(streamingApi, failing.taskId)
    assert.equal(failed.status, 'failed', 'failed persistence must not be advertised as safely paused')
    assert.equal(failed.error.code, 'persistence_failed')
    assert.notEqual(store.loadCheckpoint(failing.taskId).status, 'paused')
    store.db.exec('DROP TRIGGER reject_pause')

    const saveGraph = SqliteKnowledgeStore.prototype.saveGraph
    let finishCommit, committing = false
    SqliteKnowledgeStore.prototype.saveGraph = async function (...args) {
      committing = true
      await new Promise(resolve => { finishCommit = resolve })
      return saveGraph.apply(this, args)
    }
    try {
      const commit = await recoveredApi('extract', { text: source })
      await until(() => committing, 'Canonical commit did not start')
      assert.equal((await getStatus(recoveredApi, commit.taskId)).progress.canPause, false)
      assert.equal((await recoveredApi('task-pause', { taskId: commit.taskId })).error.code, 'pause_unavailable', 'a final commit cannot become a resumable checkpoint')
      finishCommit()
      assert.equal((await settled(recoveredApi, commit.taskId)).status, 'succeeded')
    } finally { SqliteKnowledgeStore.prototype.saveGraph = saveGraph }

    // Crash after the pause response, before the provider cooperates.
    const child = fork(fileURLToPath(import.meta.url), ['kill-worker'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    const exit = once(child, 'exit')
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
    let killed
    child.on('message', message => { killed = message; child.kill('SIGKILL') })
    try { const [, signal] = await exit; assert.equal(signal, 'SIGKILL', stderr); assert(killed, stderr) }
    finally { clearTimeout(timer) }
    const crashSaved = store.loadCheckpoint(killed.taskId)
    assert.equal(crashSaved.status, 'paused')
    assert.equal((await recoveredApi('resume-extract', { runId: killed.taskId })).error.code, 'task_paused')
    const bad = structuredClone(crashSaved.checkpoint)
    bad.baseRevision = 99
    store.saveCheckpoint(bad, { runId: killed.taskId, status: 'paused', sourceText: source })
    assert.equal((await recoveredApi('resume-extract', { runId: killed.taskId, resumePaused: true })).error.code, 'revision_conflict')
    assert.equal(store.loadCheckpoint(killed.taskId).status, 'paused', 'rejected resume cannot consume the checkpoint')
    store.saveCheckpoint(crashSaved.checkpoint, { runId: killed.taskId, status: 'paused', sourceText: source })
    const afterKill = await recoveredApi('resume-extract', { runId: killed.taskId, resumePaused: true })
    assert.equal((await settled(recoveredApi, afterKill.taskId)).status, 'succeeded')
    const deletedId = 'paused-delete-fixture'
    store.saveCheckpoint(crashSaved.checkpoint, { runId: deletedId, status: 'paused', sourceText: source })
    assert.equal(store.deleteIncompleteRun(deletedId, store.loadCheckpoint(deletedId).updatedAt).deleted, true)

    // Exercise the production control and polling code, not a copied UI model.
    const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
    const control = client.slice(client.indexOf('      function TaskPauseControls('), client.indexOf('      function BackgroundTaskProgress('))
    const state = [], refs = [], effects = []
    let si, ri, props, sent = [], continued = 0
    const useState = initial => { const i = si++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value }] }
    const useRef = initial => refs[ri++] ||= { current: initial }
    const useEffect = fn => effects.push(fn)
    const h = (tag, attrs, ...children) => ({ tag, attrs, children })
    const uiHost = { async call(name, args) { sent.push({ name, args }); return name === 'task-pause' ? { status: 'pausing' } : { taskId: args.runId, resumed: true } } }
    const component = new Function('h', 'useState', 'useRef', 'useEffect', 'host', control + '; return TaskPauseControls')(h, useState, useRef, useEffect, uiHost)
    const render = nextProps => { props = nextProps || props; si = ri = 0; const tree = component(props); for (const fn of effects.splice(0)) fn(); return tree }
    assert.equal(render({ taskId: 'task', status: 'running', progress: { canPause: false } }), null)
    assert.equal(render({ taskId: 'task', status: 'failed', progress: { pauseRequested: true } }), null, 'a pause failure cannot leave a fake pausing control')
    let tree = render({ taskId: 'task', status: 'running', progress: { canPause: true } })
    await Promise.all([tree.children[0].attrs.onClick(), tree.children[0].attrs.onClick()])
    assert.equal(sent.length, 1, 'double click must not send two pause requests')
    assert.equal(render().children[0].attrs.disabled, true)
    render({ taskId: 'task', status: 'paused', progress: { paused: true, pauseRequested: true }, onResumed() { continued++ } })
    tree = render()
    assert.equal(tree.children[0].attrs.disabled, false)
    await tree.children[0].attrs.onClick()
    assert.equal(sent[1].args.resumePaused, true)
    assert.equal(continued, 1)
    for (const section of client.split('// ---- adaptive-backoff polling while a task runs ----').slice(1)) {
      const prefix = section.slice(section.indexOf('useEffect('), section.indexOf("if (res && res.status === 'succeeded')"))
      let phase = 'extracting', cleared = false, polled = 0
      const code = prefix + '}; tick(); }, [taskId, phase]);'
      const values = { useEffect: fn => fn(), taskId: 'task', phase, sessionId: 'session', sessionSeq: { current: 1 },
        host: { async call() { polled++; return { status: 'paused', progress: { paused: true } } } },
        ctx: { timeout() { throw Error('Paused polling must stop') } }, setError() {}, setExtractProgress() {},
        setPhase(value) { phase = value }, forgetPendingTask() { cleared = true }, clearTrajPending() { cleared = true } }
      new Function(...Object.keys(values), code)(...Object.values(values))
      await sleep(0)
      assert.equal(phase, 'paused'); assert.equal(cleared, true); assert.equal(polled, 1)
    }
    console.log(JSON.stringify({ allStreamsAborted: true, durableExplicitPause: true, pauseSurvivesSigkill: true,
      noAutomaticResume: true, bufferedSiblingPreserved: true, writeFailureVisible: true, resumeRevisionFence: true, pauseAndResumeUI: true }))
  } finally {
    for (const dispose of cleanups.reverse()) dispose()
    store.close()
    if (previousDb === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = previousDb
    rmSync(dir, { recursive: true, force: true })
  }
}
