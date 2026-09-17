// An interrupted 《学习观》 run must resume AS a 《学习观》 run.
//
// The checkpoint did not record the ontology, so a resume resolved it from the
// bare merged graph — which carries none — and fell back to the proposition
// default. Re-seeding the stored graph then rewrote every type the default does
// not declare, so an entire learning-view run's material types became `fact`.
// That changed the accumulator, and the concurrent-wave guard correctly refused
// to continue ("并发检查点与已合并图不一致，禁止跳过批次"). The guard was right;
// the ontology was missing from the carrier that needed it.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync('/tmp/kg-ontology-checkpoint-')
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'test.sqlite')
const cleanups = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createHost(extractor) {
  let api
  host.apply({
    get(name) {
      if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') api = route.handler; return () => {} } }
      if (name === 'kgExtractor') return extractor
      return null
    },
    effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup },
    interval() { return () => {} },
  })
  return api
}

function request(api, endpoint, body = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    const res = { setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) } }
    Promise.resolve(api(req, res)).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}

async function wait(api, started) {
  assert(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 2000; i += 1) {
    const result = await request(api, 'task-status', { taskId: started.taskId }, 'GET')
    if (result.status !== 'running') { await sleep(10); return result }
    await sleep(5)
  }
  throw new Error('task never settled')
}

const source = ['甲', '乙', '丙', '丁'].map((name, i) => '# ' + name + '\n\n' + name + '设备功率为' + (i + 1) + '瓦。').join('\n\n')
const prompts = []
// Fail one batch of the SECOND wave, so the first wave is already merged and its
// learning-view types are sitting in the persisted checkpoint graph.
let failOn = 3
async function extractor({ chunk, systemPrompt }) {
  const index = Number(chunk.chunkId.slice(-4)) - 1
  prompts.push({ index, learningView: String(systemPrompt || '').includes('学习观拆解引擎') })
  await sleep(10)
  if (index === failOn) throw Object.assign(new Error('synthetic timeout'), { code: 'timeout' })
  const unit = chunk.units.find((item) => item.text.includes('设备功率')) || chunk.units[0]
  return {
    summary: '学习观记录',
    nodes: [
      { id: 'n1', type: 'intension_description', text: unit.text, quote: unit.text, paragraph: unit.num },
      { id: 'n2', type: 'positive_example', text: unit.text, quote: unit.text, paragraph: unit.num },
    ],
    edges: [{ fromNodeId: 'n2', toNodeId: 'n1', relation: 'exemplifies', evidence: [{ paragraph: unit.num, quote: unit.text }] }],
  }
}

try {
  const api1 = createHost(extractor)
  const started = await request(api1, 'extract', { text: source, concurrency: 2, ontology: 'learning-view-v1' })
  const failed = await wait(api1, started)
  assert.equal(failed.status, 'failed', 'the injected failure must fail the run')
  assert.equal(failed.error.code, 'timeout')

  const store = await openSqliteStore(process.env.DSH_KG_DB)
  const saved = store.loadCheckpoint(started.taskId)
  assert(saved && saved.checkpoint, 'the interrupted run must leave a checkpoint')
  assert.equal(saved.checkpoint.ontology, 'learning-view-v1', 'the checkpoint must record the ontology the run started under')
  assert(saved.checkpoint.pendingWave, 'the interrupted wave must be recoverable')
  assert(saved.checkpoint.graph.nodes.length > 0, 'the first wave must already be merged into the checkpoint graph')
  const storedTypes = new Set(saved.checkpoint.graph.nodes.map((node) => node.type))
  assert(storedTypes.has('intension_description') || storedTypes.has('positive_example'), 'the merged prefix must hold learning-view types: ' + [...storedTypes].join(','))

  // A fresh host is a restart: everything it knows comes from the checkpoint.
  failOn = -1
  prompts.length = 0
  const api2 = createHost(extractor)
  const resumed = await wait(api2, await request(api2, 'resume-extract', { runId: started.taskId, retryFailed: true }))
  assert.equal(resumed.error, undefined, 'resuming a learning-view run must not fail: ' + JSON.stringify(resumed.error || {}))
  assert.equal(resumed.status, 'succeeded', 'the resumed run must finish: ' + JSON.stringify(resumed.error || resumed.status))
  assert.equal(resumed.result.ontology, 'learning-view-v1', 'the resumed run must stay in its own ontology')
  assert(prompts.length > 0 && prompts.every((item) => item.learningView), 'every resumed call must use the learning-view prompt')
  const declared = new Set(['concept', 'feature', 'rule', 'discrimination_model', 'connection_model', 'intension_description', 'feature_description', 'positive_example', 'negative_example', 'contrast_group', 'extension_contrast', 'relation_material', 'factor_material', 'property_material', 'segment_example_group', 'verification_material', 'data_or_experience', 'memory_material'])
  const foreign = [...new Set(resumed.result.nodes.map((node) => node.type))].filter((type) => !declared.has(type))
  assert.deepEqual(foreign, [], 'a resumed learning-view run must contain no foreign types: ' + foreign.join(','))
  assert(resumed.result.nodes.some((node) => node.type === 'negative_example' || node.type === 'positive_example'), 'learning-view materials must survive the resume')

  console.log(JSON.stringify({
    ok: true,
    interruptedAt: 'second-wave',
    checkpointOntology: saved.checkpoint.ontology,
    resumedOntology: resumed.result.ontology,
    resumedNodes: resumed.result.nodes.length,
    foreignTypes: foreign.length,
    resumedPromptsAllLearningView: prompts.every((item) => item.learningView),
  }))
} finally {
  for (const cleanup of cleanups.reverse()) { try { cleanup() } catch (error) {} }
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
