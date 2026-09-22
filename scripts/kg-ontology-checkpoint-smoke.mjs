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
import { createHash } from 'node:crypto'
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
      { id: 'n1', type: 'intension_description', text: unit.text, quote: unit.text, paragraph: unit.num, relKind: 'basic' },
      { id: 'n2', type: 'positive_example', text: unit.text, quote: unit.text, paragraph: unit.num, stage: 'data' },
    ],
    edges: [{ fromNodeId: 'n2', toNodeId: 'n1', relation: 'exemplifies', role: 'input', mode: 'contrast', evidence: [{ paragraph: unit.num, quote: unit.text }] }],
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

  // ---- a rejected resume must not consume the checkpoint it rejected --------
  // The old order rebuilt and persisted the accumulator first and only then
  // checked the wave, so a failed resume overwrote the original with the rebuild
  // and the run stopped being recoverable. Dropping `nodeIds` from a staged chunk
  // makes the rebuild observably different from what is stored, and corrupting the
  // wave hash makes the resume fail: the stored bytes must survive untouched.
  const original = structuredClone(saved.checkpoint)
  for (const mutate of [
    checkpoint => { checkpoint.graph.nodes.find(node => node.stage).stage = 'processed' },
    checkpoint => { checkpoint.graph.nodes.find(node => node.relKind).relKind = 'advanced' },
    checkpoint => { checkpoint.graph.edges[0].role = 'output' },
    checkpoint => { checkpoint.graph.edges[0].mode = 'analogy' },
    checkpoint => { checkpoint.pendingWave.contextVersion = 999 },
  ]) {
    const changed = structuredClone(original)
    mutate(changed)
    store.saveCheckpoint(changed, { runId: started.taskId, status: 'failed', sourceText: source })
    const beforeCalls = prompts.length
    const changedApi = createHost(extractor)
    const refused = await wait(changedApi, await request(changedApi, 'resume-extract', { runId: started.taskId, retryFailed: true }))
    assert.equal(refused.error?.code, 'checkpoint_invalid', 'changed semantic context must invalidate buffered model output')
    assert.equal(prompts.length, beforeCalls, 'a mismatched context must be rejected before model calls')
    assert.deepEqual(store.loadCheckpoint(started.taskId).checkpoint.graph, changed.graph, 'refusal must preserve the recovery record')
  }
  // This is the frozen pre-v2 fingerprint format, not the current writer.
  const legacy = structuredClone(original)
  delete legacy.pendingWave.contextVersion
  const legacySnapshot = JSON.stringify({ summary: '',
    nodes: legacy.graph.nodes.map(({ id, type, text, quote, paragraph }) => ({ id, type, text, quote, paragraph })),
    edges: legacy.graph.edges.map(({ fromNodeId, toNodeId, relation, evidence }) => ({ fromNodeId, toNodeId, relation, evidence: evidence.map(({ paragraph, quote }) => ({ paragraph, quote })) })),
  })
  legacy.pendingWave.contextHash = createHash('sha256').update(legacy.sourceId + legacySnapshot).digest('hex')
  store.saveCheckpoint(legacy, { runId: started.taskId, status: 'failed', sourceText: source })
  const legacyCallStart = prompts.length
  const legacyApi = createHost(extractor)
  const legacyRetry = await wait(legacyApi, await request(legacyApi, 'resume-extract', { runId: started.taskId, retryFailed: true }))
  assert.equal(legacyRetry.error?.code, 'timeout', 'legacy checkpoints must still reach the intentionally failing unfinished batch')
  assert.deepEqual(prompts.slice(legacyCallStart).map(item => item.index), [3], 'legacy buffered work must not be regenerated')
  assert.deepEqual(store.loadCheckpoint(started.taskId).checkpoint.graph, original.graph)
  const tampered = structuredClone(saved.checkpoint)
  tampered.pendingWave.contextHash = 'corrupted'
  delete tampered.staging.chunks[0].nodeIds
  store.saveCheckpoint(tampered, { runId: started.taskId, status: 'failed', sourceText: source })
  const apiReject = createHost(extractor)
  const rejected = await wait(apiReject, await request(apiReject, 'resume-extract', { runId: started.taskId, retryFailed: true }))
  assert.equal(rejected.error && rejected.error.code, 'checkpoint_invalid', 'a wave that no longer matches must be refused: ' + JSON.stringify(rejected.error || rejected.status))
  const afterRejection = store.loadCheckpoint(started.taskId).checkpoint
  assert.equal(afterRejection.pendingWave.contextHash, 'corrupted', 'a rejected resume must not rewrite the wave it rejected')
  // The tampered chunk had its `nodeIds` removed. A rebuild would have written
  // an empty array back; leaving it absent is what proves nothing was rewritten.
  assert(!Object.hasOwn(afterRejection.staging.chunks[0], 'nodeIds'), 'a rejected resume must not rebuild the staged chunks it rejected')
  assert.equal(afterRejection.graph.nodes.length, original.graph.nodes.length, 'a rejected resume must not replace the stored graph')
  assert(/原检查点已保留/.test(rejected.error.message), 'the refusal must say the original was kept: ' + rejected.error.message)
  store.saveCheckpoint(original, { runId: started.taskId, status: 'failed', sourceText: source })

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
  for (const node of resumed.result.nodes) {
    if (node.type === 'intension_description') assert.equal(node.relKind, 'basic', 'resume must preserve declared attributes in the merged prefix as well as the pending wave')
    if (node.type === 'positive_example') assert.equal(node.stage, 'data')
  }
  for (const edge of resumed.result.edges) {
    assert.equal(edge.role, 'input', 'resume must preserve relation roles, not just relation types')
    assert.equal(edge.mode, 'contrast')
  }
  const reloaded = store.getDocument(resumed.result.source.documentId)
  assert.deepEqual(reloaded.nodes.map((node) => [node.id, node.stage, node.relKind]), resumed.result.nodes.map((node) => [node.id, node.stage, node.relKind]))
  assert.deepEqual(reloaded.edges.map((edge) => [edge.role, edge.mode]), resumed.result.edges.map((edge) => [edge.role, edge.mode]))

  // Append through a fresh persistent host, fail after its first wave, then
  // resume through another host. Both the old document and new prefix matter.
  failOn = 3
  prompts.length = 0
  const api3 = createHost(extractor)
  const appendSource = source.replace(/设备功率/g, '备用设备功率')
  const appendStarted = await request(api3, 'append-extract', { documentId: reloaded.source.documentId, text: appendSource, concurrency: 2 })
  const appendFailed = await wait(api3, appendStarted)
  assert.equal(appendFailed.error?.code, 'timeout')
  assert.equal(store.getDocument(reloaded.source.documentId).revision, reloaded.revision, 'an incomplete append must not replace the canonical graph')
  assert(prompts.length > 0 && prompts.every((item) => item.learningView), 'persistent append must use its document ontology')
  failOn = -1
  prompts.length = 0
  const api4 = createHost(extractor)
  const appendResumed = await wait(api4, await request(api4, 'resume-extract', { runId: appendStarted.taskId, retryFailed: true }))
  assert.equal(appendResumed.status, 'succeeded', JSON.stringify(appendResumed.error))
  assert(prompts.length > 0 && prompts.every((item) => item.learningView), 'resumed append must retain the same ontology prompt')
  const appendReloaded = store.getDocument(reloaded.source.documentId)
  assert.equal(appendReloaded.revision, reloaded.revision + 1)
  assert.equal(appendReloaded.nodes.length, reloaded.nodes.length * 2)
  for (const node of appendReloaded.nodes) {
    if (node.type === 'intension_description') assert.equal(node.relKind, 'basic')
    if (node.type === 'positive_example') assert.equal(node.stage, 'data')
    if (!reloaded.nodes.some((prior) => prior.id === node.id)) {
      assert(node.paragraph >= reloaded.source.paragraphCount, 'resumed append must retain canonical source offsets')
    }
  }
  assert(appendReloaded.edges.every((edge) => edge.role === 'input' && edge.mode === 'contrast'))

  let completionCalls = 0, reviewCalls = 0
  const completionApi = createHost({
    async weaveRelations({ nodes, prompt }) {
      completionCalls++
      assert(nodes.filter(node => node.type === 'positive_example').every(node => node.stage === 'data'))
      assert(prompt.includes('"stage":"data"') && prompt.includes('"relKind":"basic"'), 'model context must contain the declared node semantics')
      assert(prompt.includes('"role":"input"') && prompt.includes('"mode":"contrast"'), 'existing relation semantics must reach the model')
      const from = nodes.find(node => node.id === 'n4')
      return { edges: [{ fromNodeId: from.id, toNodeId: 'n1', relation: 'exemplifies', role: 'input', mode: 'contrast', evidence: from.evidence }] }
    },
    async reviewRelations({ prompt, candidates }) {
      reviewCalls++
      const payload = JSON.parse(prompt)
      assert.equal(payload.candidates[0].role, 'input')
      assert.equal(payload.candidates[0].mode, 'contrast')
      assert.equal(payload.candidates[0].from.stage, 'data')
      assert.equal(payload.candidates[0].to.relKind, 'basic', 'independent review must receive the full candidate meaning')
      return { verdicts: candidates.map(item => ({ id: item.id, verdict: 'insufficient', reason: 'Co-occurrence does not prove the relation', evidence: [] })) }
    },
  })
  const completed = await wait(completionApi, await request(completionApi, 'relation-retry', { documentId: reloaded.source.documentId, expectedRevision: appendReloaded.revision, continuous: true }))
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error))
  assert.equal(completionCalls, 1)
  assert.equal(reviewCalls, 1)
  assert.equal(completed.result.edges.length, appendReloaded.edges.length, 'semantic attributes must not bypass independent admission')
  const completedCanonical = store.getDocument(reloaded.source.documentId)
  assert.deepEqual(completedCanonical.nodes.map(node => [node.id, node.stage, node.relKind]), appendReloaded.nodes.map(node => [node.id, node.stage, node.relKind]))
  assert.deepEqual(completedCanonical.edges.map(edge => [edge.role, edge.mode]), appendReloaded.edges.map(edge => [edge.role, edge.mode]))
  store.close()

  console.log(JSON.stringify({
    ok: true,
    interruptedAt: 'second-wave',
    checkpointOntology: saved.checkpoint.ontology,
    resumedOntology: resumed.result.ontology,
    resumedNodes: resumed.result.nodes.length,
    foreignTypes: foreign.length,
    resumedPromptsAllLearningView: prompts.every((item) => item.learningView),
    rejectedResumeKeptCheckpoint: true,
    semanticAttributesSurviveRestart: true,
    persistentAppendResume: true,
    completionSemanticContext: true,
    semanticFingerprint: true,
    legacyWaveCompatible: true,
  }))
} finally {
  for (const cleanup of cleanups.reverse()) { try { cleanup() } catch (error) {} }
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(dir, { recursive: true, force: true })
}
