import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const baseline = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null
const generated = baseline ? execFileSync('git', ['show', baseline + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const fixture = modelStructureFixture(), template = fixture.graph.nodes.find(node => node.id === 'distance')
for (let i = 0; i < 40; i++) fixture.graph.nodes.push({ ...json(template), id: '000-private-name-page-' + i, text: '目录占位 ' + i })
const ids = ['__proto__', 'constructor', 'spaced/id:opaque identity']
for (const id of ids) fixture.graph.nodes.push({ ...json(template), id, text: '目录末页的同名概念' })
fixture.graph.nodes.push({ ...json(template), id: '__PROTO__', text: '不同字面身份，不可替代' },
  { ...json(template), id: 'rejected-concept', state: 'rejected', text: '已拒绝概念' })
const harness = await modelLearningHarness({ fixture }), tools = createModelStructureTools(), views = []
const find = (element, predicate) => Array.isArray(element) ? element.flatMap(child => find(child, predicate))
  : !element || typeof element !== 'object' ? [] : [...(predicate(element) ? [element] : []), ...find(element.props?.children, predicate)]
const cacheKey = model => 'dsh-kg-model-structure:' + JSON.stringify([fixture.documentId, model])
function create(raw = null, transform = null, modelId = 'multi') {
  const calls = [], reads = []
  const view = draftDiagnosisView(generated, harness, { observe: value => calls.push(value), transform(args, result, signal) {
    reads.push(json(args)); return transform ? transform(args, result, signal) : result
  } })
  view.props.modelId = modelId
  if (raw) view.cache.set(cacheKey(modelId), raw)
  views.push(view)
  const full = () => {
    const value = calls.at(-1); assert(value)
    assert.deepEqual(json(value.report), tools.diagnose(json(value.spec), { ports: json(value.ports), names: json(value.names) }))
    assert.equal(value.report.basis, 'recorded_fields_not_semantic_truth'); return value
  }
  const legend = id => find(view.tree, e => e.type === 'fieldset' && find(e, c => c.props?.['aria-label'] === '槽位名称 ' + id).length)[0]?.props.children[0].props.children[0]
  const start = async () => { view.render(); await view.settle(); await view.flushDebounce() }
  return { view, reads, full, legend, start }
}
try {
  const before = JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId))
  const units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  const first = create(); await first.start()
  assert(!ids.some(id => text(first.view.field('选择槽位概念')).includes(id)))
  for (const id of ids) {
    first.view.change('搜索槽位概念', id); await first.view.flushDebounce()
    first.view.change('选择槽位概念', id); first.view.click('添加独立槽位')
    const slot = first.full().spec.slots.at(-1)
    first.view.change('时间或对象状态 ' + slot.id, '这个独立槽位的对象状态：' + id)
    first.view.change('单位 ' + slot.id, '待核对单位')
    assert.equal(first.legend(slot.id), '目录末页的同名概念')
  }
  // Independent slots may share a concept, without sharing their private labels.
  first.view.change('搜索槽位概念', '__proto__'); await first.view.flushDebounce()
  first.view.change('选择槽位概念', '__proto__'); first.view.click('添加独立槽位')
  const aliased = first.full().spec.slots.at(-1)
  first.view.change('槽位名称 ' + aliased.id, '仅此槽位的私有名称')
  const retained = json(first.full().spec), raw = first.view.cache.get(cacheKey('multi'))
  assert(raw); first.view.stop()
  const restored = create(raw); await restored.start()
  assert.deepEqual(json(restored.full().spec), retained); assert.equal(restored.view.cache.get(cacheKey('multi')), raw)
  for (const slot of retained.slots.slice(3, 6)) assert.equal(restored.legend(slot.id), '目录末页的同名概念',
    'restored private slots beyond the first concept page need current canonical names without another search')
  assert.equal(restored.legend(aliased.id), '仅此槽位的私有名称')
  if (process.argv.includes('--restore-only')) process.exitCode = 0
  else {
    const requests = restored.reads.filter(args => args.conceptNames)
    assert.equal(requests.length, 1, 'all missing private names use one bounded lookup, not all catalogue pages')
    assert.deepEqual(requests[0].conceptNames, ids)
    assert.equal(restored.reads.filter(args => args.concepts).length, 1)
    const count = restored.reads.length
    restored.view.change('时间或对象状态 ' + aliased.id, '另一个独立对象状态')
    for (let i = 0; i < 4; i++) { restored.view.render(); await restored.view.settle() }
    assert.equal(restored.reads.length, count, 'unrelated private edits and renders do not reread names')

    const document = harness.store.getCanonicalDocument(fixture.documentId), contract = createGraphContract().connectionModels
    const base = { documentId: fixture.documentId, expectedRevision: 1, modelId: 'multi' }
    const post = async extra => {
      const args = { ...base, ...extra }, result = await harness.post(args, 'connection-models')
      assert.deepEqual(result, contract(document, args)); return result
    }
    const names = await post({ conceptNames: [...ids, '__PROTO__', 'rejected-concept', 'taxi', 'missing'] })
    assert.equal(names.modelConceptNamesVersion, 1); assert.equal(names.modelId, 'multi')
    assert.deepEqual(names.conceptIds, [...ids, '__PROTO__', 'rejected-concept', 'taxi', 'missing'])
    assert.deepEqual(names.items, [...ids, '__PROTO__'].map(nodeId => ({ nodeId, text: document.graph.nodes.find(node => node.id === nodeId).text })))
    assert.deepEqual((await post({ conceptNames: [] })).items, [])
    const forty = document.graph.nodes.filter(n => n.type === 'concept' && n.state !== 'rejected').slice(0, 40).map(n => n.id)
    assert.equal(forty.length, 40); assert.equal((await post({ conceptNames: forty })).items.length, 40)
    for (const conceptNames of [null, true, 'speed', [0], [''], [' '], ['x'.repeat(161)], ['speed', 'speed'], Array(41).fill('speed')])
      assert.equal((await post({ conceptNames })).error.code, 'invalid_input')
    for (const extra of [{ concepts: true }, { diagnosis: true }, { structureSources: true }, { structureEdit: true },
      { compareModelId: 'taxi' }, { query: 'speed' }, { offset: 0 }])
      assert.equal((await post({ conceptNames: ids, ...extra })).error.code, 'invalid_input')
    assert.equal((await post({ conceptNames: ids, compareModelId: 'taxi', chainDraft: {} })).error.code, 'invalid_chain_draft')
    assert.equal((await post({ conceptNames: ids, expectedRevision: 0 })).error.code, 'revision_conflict')
    assert.equal((await post({ conceptNames: ids, modelId: 'distance' })).error.code, 'not_found')

    for (const invalid of ['document', 'revision', 'model', 'capability', 'identities', 'foreign-item', 'duplicate-item', 'invalid-text']) {
      const bad = create(raw, (args, result) => {
        if (!args.conceptNames) return result
        if (invalid === 'document') result.documentId = 'other-document'
        if (invalid === 'revision') result.revision = 2
        if (invalid === 'model') result.modelId = 'taxi'
        if (invalid === 'capability') delete result.modelConceptNamesVersion
        if (invalid === 'identities') result.conceptIds = ['speed']
        if (invalid === 'foreign-item') result.items.push({ nodeId: 'speed', text: '错误的异目标名称' })
        if (invalid === 'duplicate-item') result.items.push(result.items[0])
        if (invalid === 'invalid-text') result.items[0].text = {}
        return result
      })
      await bad.start()
      assert.deepEqual(json(bad.full().spec), retained); assert.equal(bad.view.cache.get(cacheKey('multi')), raw)
      assert.equal(bad.legend(retained.slots[3].id), '__proto__')
      assert(text(bad.view.tree).includes(invalid === 'capability' ? '概念名称读取版本尚未部署' : '概念名称身份或版本不一致'))
      bad.view.stop()
    }

    const pending = []
    const delayed = create(raw, (args, result, signal) => args.conceptNames
      ? new Promise(resolve => pending.push({ args, result, signal, resolve: () => resolve(result) })) : result)
    delayed.view.cache.set(cacheKey('unknown'), raw); await delayed.start()
    assert.equal(pending.length, 1); assert.equal(delayed.legend(retained.slots[3].id), '__proto__')
    const old = pending[0]; old.result.items.forEach(item => { item.text = '旧模型的迟到名称' })
    delayed.view.props.modelId = 'unknown'; delayed.view.render(); await delayed.view.settle()
    assert.equal(pending.length, 2); assert.equal(old.signal.aborted, true)
    old.resolve(); await delayed.view.settle(); assert(!Object.values(delayed.full().names).includes('旧模型的迟到名称'))
    pending[1].resolve(); await delayed.view.settle()
    assert.equal(delayed.legend(retained.slots[3].id), '目录末页的同名概念')
    assert.deepEqual(json(delayed.full().spec), retained)
    delayed.view.props.modelId = 'multi'; delayed.view.render(); await delayed.view.settle()
    const inactive = pending.at(-1); delayed.view.props.active = false; delayed.view.render(); await delayed.view.settle()
    assert.equal(inactive.signal.aborted, true); inactive.resolve(); await delayed.view.settle()
    delayed.view.props.active = true; delayed.view.render(); await delayed.view.settle()
    pending.at(-1).resolve(); await delayed.view.settle()
    assert.equal(delayed.legend(retained.slots[3].id), '目录末页的同名概念')
    assert.deepEqual(json(delayed.full().spec), retained)
    delayed.view.stop()

    const stale = create(JSON.stringify({ revision: 0, spec: retained })); await stale.start()
    assert.equal(stale.reads.filter(args => args.conceptNames).length, 0, 'old-version private drafts are not relabelled as a current-version structure')
    assert.equal(stale.legend(retained.slots[3].id), '__proto__'); stale.view.stop()
  }
  assert.equal(JSON.stringify(harness.store.getCanonicalDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS count FROM learning_attempts').get().count, 0)
  console.log(JSON.stringify({ ok: true, actualGeneratedEditorAndHost: true, currentCanonicalNamesBeyondFirstPage: true,
    oneBoundedLiteralIdLookup: true, independentSameConceptSlotsAndExplicitLabels: true, privateSpecificationAndCachePreserved: true,
    conditionsEvidenceBindingsAndCanonicalUnchanged: true, fullDefensiveReportParity: true, revision: 1, learningCount: 0 }))
} finally { views.forEach(({ stop }) => stop()); harness.stop() }
