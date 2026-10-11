import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { draftCacheView, reloadDraftCache } from './kg-model-draft-cache-fixture.mjs'
import { draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const baseline = process.argv[2] ? execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim() : null
const generated = baseline ? execFileSync('git', ['show', baseline + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const tools = createModelStructureTools(), fixture = modelBranchCountsFixture({ slots: 40, branches: 40, examples: 100 })
const harness = await modelLearningHarness({ fixture }), calls = [], reads = []
let invalid = '', late = null
const view = draftCacheView(generated, harness, { observe: value => calls.push(value), transform(args, result, signal) {
  if (args.structureEdit && !result.error) {
    reads.push(json(result))
    if (invalid === 'document') result.documentId = 'foreign-document'
    if (invalid === 'model') result.model.nodeId = 'foreign-model'
    if (invalid === 'version') result.revision++
    if (invalid === 'late') return new Promise(resolve => { late = { signal, resolve: () => resolve(result) } })
  }
  return result
} })
const key = 'dsh-kg-model-structure:' + JSON.stringify([fixture.documentId, 'taxi'])
const full = () => { const value = calls.at(-1); assert(value)
  assert.deepEqual(json(value.report), tools.diagnose(json(value.spec), { ports: json(value.ports), names: json(value.names) }))
  return value }
const paths = (value, prefix = []) => value && typeof value === 'object'
  ? Object.keys(value).flatMap(key => paths(value[key], [...prefix, key])) : [prefix]
const at = (value, path) => path.reduce((item, key) => item[key], value)
const buttons = element => Array.isArray(element) ? element.flatMap(buttons) : !element || typeof element !== 'object' ? []
  : [...(element.type === 'button' ? [element] : []), ...buttons(element.props?.children)]
try {
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  view.render(); await view.settle(); await view.flushDebounce(); view.change('槽位名称 slot-0', '')
  const raw = view.cache.get(key); assert(raw && raw.length > 150000)
  await reloadDraftCache(view) // First accepted read validates this private value.
  const initial = full(), start = { ...view.work }, count = calls.length, readCount = reads.length
  for (let i = 0; i < 12; i++) {
    await reloadDraftCache(view); assert.equal(full(), initial); assert.equal(view.cache.get(key), raw)
  }
  assert.equal(reads.length - readCount, 12)
  for (const response of reads.slice(readCount)) assert.deepEqual(response, reads[0])
  assert.equal(view.work.validations - start.validations, 0, 'equal private cache must reuse complete shape validation')
  assert.equal(view.work.parses - start.parses, 0, 'equal private cache must reuse parsing')
  assert.equal(calls.length, count)
  const original = json(initial.spec), cached = JSON.parse(raw)
  const leaves = [ ['revision'], ['spec', 'identity'],
    ...paths(cached.spec.slots[0], ['spec', 'slots', 0]),
    ...paths(cached.spec.branches[0], ['spec', 'branches', 0]),
    ...paths(cached.spec.examples[0], ['spec', 'examples', 0]).filter(path => !['inputs', 'outputs'].includes(path[4]) || path[5] === 0),
  ]
  for (const path of leaves) {
    const changed = json(cached), owner = at(changed, path.slice(0, -1)), value = at(changed, path)
    owner[path.at(-1)] = typeof value === 'number' ? value + 1 : value === null ? 0 : String(value) + ':changed'
    const changedRaw = JSON.stringify(changed), work = { ...view.work }; view.cache.set(key, changedRaw)
    await reloadDraftCache(view)
    assert.equal(view.work.parses, work.parses + 1, path.join('.')); assert.equal(view.work.validations, work.validations + 1, path.join('.'))
    let badShape = false; try { tools.validateShape(changed.spec) } catch { badShape = true }
    assert.equal(text(view.tree).includes('缓存草稿格式无效'), badShape, path.join('.') + ': ' + text(view.tree).slice(0, 280))
    assert.deepEqual(json(full().spec), original, 'changed external storage cannot replace an already open private draft')
    assert.equal(view.cache.get(key), changedRaw, 'cache bytes remain intact')
    await reloadDraftCache(view); assert.equal(view.work.parses, work.parses + 1); assert.equal(view.work.validations, work.validations + 1)
    assert.equal(text(view.tree).includes('缓存草稿格式无效'), badShape, 'cached failure remains visible after another read')
    view.cache.set(key, raw); await reloadDraftCache(view)
    assert.equal(view.work.parses, work.parses + 2); assert.equal(view.work.validations, work.validations + 2)
    assert(!text(view.tree).includes('缓存草稿格式无效'))
  }
  for (const damaged of ['{broken', 'null', 'false', JSON.stringify({ revision: 1, spec: {} })]) {
    const work = { ...view.work }; view.cache.set(key, damaged); await reloadDraftCache(view)
    assert.equal(view.work.parses, work.parses + 1); const shapeCount = view.work.validations
    await reloadDraftCache(view); assert.equal(view.work.parses, work.parses + 1); assert.equal(view.work.validations, shapeCount)
    assert.equal(view.cache.get(key), damaged); assert.deepEqual(json(full().spec), original)
    view.cache.set(key, raw); await reloadDraftCache(view); assert(!text(view.tree).includes('缓存草稿格式无效'))
  }
  for (const equivalent of [JSON.stringify(cached, null, 2), JSON.stringify({ spec: cached.spec, revision: cached.revision })]) {
    const work = { ...view.work }; view.cache.set(key, equivalent); await reloadDraftCache(view)
    assert.equal(view.work.parses, work.parses + 1); assert.equal(view.work.validations, work.validations + 1)
    assert.equal(view.cache.get(key), equivalent); assert.deepEqual(json(full().spec), original)
    await reloadDraftCache(view); assert.equal(view.work.parses, work.parses + 1)
    view.cache.set(key, raw); await reloadDraftCache(view)
  }
  const get = view.cache.get
  view.cache.get = () => { throw new Error('storage read denied') }
  await reloadDraftCache(view); assert.deepEqual(json(full().spec), original)
  view.cache.get = get; const recovered = { ...view.work }; await reloadDraftCache(view)
  assert.equal(view.work.parses, recovered.parses + 1); assert.equal(view.work.validations, recovered.validations + 1)
  for (const mode of ['document', 'model', 'version']) {
    invalid = mode; const work = { ...view.work }; await reloadDraftCache(view)
    assert.deepEqual(view.work, work); assert(text(view.tree).includes('结构读取身份或版本不一致')); assert.deepEqual(json(full().spec), original)
  }
  invalid = 'late'; await reloadDraftCache(view); assert(late)
  invalid = ''; await reloadDraftCache(view); assert(late.signal.aborted)
  const lateWork = { ...view.work }; late.resolve(); await view.settle(); assert.deepEqual(view.work, lateWork)
  view.props.modelId = 'legacy'; view.render(); await view.settle()
  view.props.modelId = 'taxi'; const scoped = { ...view.work }; view.render(); await view.settle()
  assert.equal(view.work.parses, scoped.parses + 1); assert.equal(view.work.validations, scoped.validations + 1)
  assert.deepEqual(json(full().spec), original)
  for (const restored of [raw, '{broken', JSON.stringify({ revision: 1, spec: {} }), JSON.stringify({ ...cached, revision: 'invalid' })]) {
    const remountCalls = [], remount = draftCacheView(generated, harness, { observe: value => remountCalls.push(value) })
    try {
      remount.cache.set(key, restored); remount.render(); await remount.settle(); await remount.flushDebounce()
      const expected = restored === raw ? original : fixture.graph.nodes.find(node => node.id === 'taxi').modelStructure
      assert.deepEqual(json(remountCalls.at(-1).spec), json(expected)); assert.equal(remount.cache.get(key), restored)
      const work = { ...remount.work }; await reloadDraftCache(remount); assert.deepEqual(remount.work, work)
      assert.equal(text(remount.tree).includes('缓存草稿格式无效'), restored === JSON.stringify({ revision: 1, spec: {} }))
    } finally { remount.stop() }
  }
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
  // An explicitly simulated external writer changes the canonical revision.
  // The editor must recheck the same cache and keep its old draft read-only.
  const external = harness.store.getDocument(fixture.documentId)
  external.summary += ' explicit external revision fixture'
  harness.store.saveGraph(external, { sourceText: fixture.sourceText, expectedRevision: 1 })
  const externalSnapshot = JSON.stringify(harness.store.getDocument(fixture.documentId)), versionWork = { ...view.work }
  view.props.revision = 2; view.render(); await view.settle()
  assert.equal(view.work.parses, versionWork.parses + 1); assert.equal(view.work.validations, versionWork.validations + 1)
  assert(text(view.tree).includes('草稿基于第 1 版'))
  const preview = buttons(view.tree).find(element => text(element) === '预览结构修改')
  assert(preview); assert(preview.props.disabled)
  assert.equal(view.cache.get(key), raw); assert.deepEqual(json(full().spec), original)
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), externalSnapshot)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  console.log(JSON.stringify({ changedCacheLeafFields: leaves.map(path => path.join('.')) }))
} finally { view.stop(); harness.stop() }
console.log(JSON.stringify({ ok: true, equalPrivateCacheParsingAndShapeReused: true, allRepresentativeCacheFieldsRechecked: true,
  cachedShapeFailureRedisplayed: true, corruptedCacheBytesPreserved: true, changedRawFormattingRechecked: true,
  remountRestoresOnlyValidCache: true, storageReadFailureInvalidatesReuse: true,
  foreignIdentityVersionAndCancelledCacheReadsRejected: true, modelScopeRechecksCache: true,
  actualExternalRevisionRechecksCacheAndBlocksStaleWrite: true,
  existingDraftAndFullDefensiveReportPreserved: true, conditionsEvidenceBindingsAndCanonicalUnchanged: true,
  readOnlyInitialRevision: 1, externalFixtureRevision: 2, learningCount: 0 }))
