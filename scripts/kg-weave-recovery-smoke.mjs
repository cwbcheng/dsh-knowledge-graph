import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const source = Array.from({ length: 20 }, (_, section) => '# Section ' + section + '\n\n' +
  Array.from({ length: 4 }, (_, i) => 'Record ' + (section * 4 + i) + ' describes an independent observation.').join('\n\n')).join('\n\n')
function request(api, endpoint, body = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method; req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    Promise.resolve(api(req, { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } })).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}

if (process.argv[2] === 'worker') {
  const mode = process.argv[3], runId = process.argv[4]
  let api, calls = 0
  const extractor = {
    async extractChunk({ chunk }) {
      process.send({ event: 'extract' })
      return { summary: 'Observations', nodes: chunk.units.filter(unit => unit.text.startsWith('Record')).map((unit, i) => ({
        id: 'n' + i, type: 'claim', text: unit.text, quote: unit.text, paragraph: unit.num,
      })), edges: [] }
    },
    async weaveRelations({ nodes, targetIds, units }) {
      process.send({ event: 'weave', ids: nodes.map(node => node.id), targets: targetIds })
      calls++
      if (mode === 'hole-crash' && calls <= 2) throw Error('fixture first group failed both attempts')
      if ((calls === 3 && mode === 'crash') || (calls === 5 && mode === 'hole-crash')) {
        process.send({ event: 'kill-ready' })
        await new Promise(() => { setInterval(() => {}, 1000) })
      }
      if (calls === 2 && mode !== 'resume') return { edges: [] }
      return { edges: [{ fromNodeId: nodes[0].id, toNodeId: nodes[1].id, relation: 'supports', evidence: [{ paragraph: units[0].num, quote: units[0].text }] }] }
    },
    async reviewRelations({ candidates }) {
      process.send({ event: 'review', edges: candidates.map(item => item.edge) })
      return { verdicts: candidates.map(item => ({ id: item.id, verdict: 'supported', reason: 'Fixture review', evidence: item.edge.evidence })) }
    },
  }
  host.apply({ get(name) {
    if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') api = route.handler; return () => {} } }
    return name === 'kgExtractor' ? extractor : null
  }, effect(fn) { return fn() }, interval() { return () => {} } })
  if (mode === 'injected') {
    const store = await openSqliteStore(process.env.DSH_KG_DB)
    const saved = store.loadCheckpoint(runId)
    const result = await request(api, 'extract', { text: source, checkpoint: saved.checkpoint })
    assert.equal(result.error?.code, 'checkpoint_invalid', 'client candidates cannot bypass the trusted runId restore path')
    store.close()
    process.exit(0)
  }
  const started = await request(api, runId ? 'resume-extract' : 'extract', runId ? { runId, retryFailed: true } : { text: source, concurrency: 2 })
  assert.ok(started.taskId, JSON.stringify(started))
  process.send({ event: 'started', taskId: started.taskId })
  for (let i = 0; i < 6000; i++) {
    const status = await request(api, 'task-status', { taskId: started.taskId }, 'GET')
    if (status.status !== 'running') {
      await new Promise(resolve => process.send({ event: 'done', status: status.status, error: status.error }, resolve))
      process.exit(0)
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw Error('worker timeout')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'kg-weave-recovery-'))
  const db = join(dir, 'test.sqlite')
  const store = await openSqliteStore(db)
  async function worker(mode, runId = '') {
    const events = []
    const child = fork(fileURLToPath(import.meta.url), ['worker', mode, runId], {
      env: { ...process.env, DSH_KG_DB: db }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    child.on('message', event => {
      events.push(event)
      if (event.event === 'kill-ready') child.kill('SIGKILL')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    try {
      const [code, signal] = await once(child, 'exit')
      if (mode.endsWith('crash')) assert.equal(signal, 'SIGKILL', stderr)
      else assert.equal(code, 0, stderr)
      return { events, done: events.find(event => event.event === 'done'), id: events.find(event => event.event === 'started')?.taskId }
    } finally { clearTimeout(timer) }
  }
  try {
    const first = await worker('crash')
    assert(first.events.some(event => event.event === 'kill-ready'), 'must kill during a model call, not after completion')
    const saved = store.loadCheckpoint(first.id)
    const journal = saved.checkpoint.relationWeave
    assert.equal(saved.status, 'running')
    assert.equal(Object.keys(journal.results).length, 2)
    assert(journal.results[0].norm.edges.length > 0)
    assert.equal(journal.results[1].norm.edges.length, 0, 'empty results must also survive a crash')
    assert.equal(store.listDocuments().length, 0, 'unreviewed candidates must not become canonical')
    assert.equal(saved.checkpoint.graph.edges.length, 0, 'candidate journal must not mutate the extraction base')
    const listed = store.listIncompleteRuns().find(run => run.runId === first.id)
    assert.equal(listed.savedRelationGroups, 2)
    assert.equal(listed.totalRelationGroups, journal.totalGroups)
    assert.equal((await worker('injected', first.id)).events.length, 0)
    const restore = checkpoint => store.saveCheckpoint(checkpoint, { runId: first.id, status: 'running', sourceText: saved.sourceText })
    for (const mutate of [
      checkpoint => { checkpoint.relationWeave.binding = 'wrong-plan' },
      checkpoint => { checkpoint.relationWeave.results[0].norm.edges[0].relation = 'contradicts' },
      checkpoint => { checkpoint.relationWeave.results[9999] = checkpoint.relationWeave.results[0] },
      checkpoint => { checkpoint.graph.nodes[0].text = 'Changed base' },
    ]) {
      const bad = structuredClone(saved.checkpoint)
      mutate(bad); restore(bad)
      const rejected = await worker('resume', first.id)
      assert.equal(rejected.done.error?.code, 'checkpoint_invalid', JSON.stringify(rejected))
      assert.equal(rejected.events.filter(event => ['extract', 'weave', 'review'].includes(event.event)).length, 0, 'invalid cache cannot dispatch paid calls')
    }
    restore(saved.checkpoint)
    const resumed = await worker('resume', first.id)
    assert.equal(resumed.done.status, 'succeeded', JSON.stringify(resumed.done))
    assert.equal(resumed.events.filter(event => event.event === 'extract').length, 0)
    const groupsBefore = first.events.filter(event => event.event === 'weave')
    const groupsAfter = resumed.events.filter(event => event.event === 'weave')
    assert.deepEqual(groupsAfter[0], groupsBefore[2], 'resume must start at the interrupted group')
    assert.equal(groupsAfter.length, journal.totalGroups - 2, 'saved groups, including empty groups, must not rerun')
    const reviews = resumed.events.filter(event => event.event === 'review').flatMap(event => event.edges)
    const edge = journal.results[0].norm.edges[0]
    assert(reviews.some(item => item.fromNodeId === edge.fromNodeId && item.toNodeId === edge.toNodeId), 'restored candidates must still receive independent review')
    const document = store.getDocument(saved.documentId)
    assert(document.edges.some(item => item.fromNodeId === edge.fromNodeId && item.toNodeId === edge.toNodeId))

    // Fail only the second group write, after one successful durable commit.
    store.db.exec(`CREATE TRIGGER fail_weave_save BEFORE UPDATE ON extraction_runs
      WHEN json_extract(NEW.checkpoint_json, '$.relationWeave.results."1"') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'fixture disk write failure'); END`)
    const failed = await worker('write-fail')
    assert.equal(failed.done.error?.code, 'persistence_failed', JSON.stringify(failed.done))
    assert.equal(failed.events.filter(event => event.event === 'weave').length, 2, 'no further model calls after failed persistence')
    assert.equal(failed.events.filter(event => event.event === 'review').length, 0)
    assert.equal(Object.keys(store.loadCheckpoint(failed.id).checkpoint.relationWeave.results).length, 1, 'failed write cannot advance recovery cursor')
    store.db.exec('DROP TRIGGER fail_weave_save')
    const recovered = await worker('resume', failed.id)
    assert.equal(recovered.done.status, 'succeeded', JSON.stringify(recovered.done))
    const hole = await worker('hole-crash')
    const holeSaved = store.loadCheckpoint(hole.id).checkpoint.relationWeave
    assert.deepEqual(Object.keys(holeSaved.results), ['1', '2'], 'failed groups must not get a completed marker')
    const filled = await worker('resume', hole.id)
    assert.equal(filled.done.status, 'succeeded', JSON.stringify(filled.done))
    const holeCalls = hole.events.filter(event => event.event === 'weave')
    const filledCalls = filled.events.filter(event => event.event === 'weave')
    assert.deepEqual(filledCalls[0], holeCalls[0], 'retry the failed earlier group')
    assert.deepEqual(filledCalls[1], holeCalls[4], 'then skip the saved later groups')
    console.log(JSON.stringify({ hardKillRecovery: true, candidateSurvives: true, emptyGroupSurvives: true,
      independentReview: true, tamperingRejected: true, writeFailureStopsProgress: true, failedGroupRecovery: true }))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
