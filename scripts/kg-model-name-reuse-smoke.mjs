import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelNameReuseFixture } from './kg-model-name-reuse-fixture.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const fixture = modelNameReuseFixture(), harness = await modelLearningHarness({ fixture }), calls = [], reads = []
const tools = createModelStructureTools(); let mode = '', delayed = null
const baselineCommit = process.argv[2] ? execFileSync('git',['rev-parse','--verify',process.argv[2] + '^{commit}'],{ encoding:'utf8' }).trim() : null
const generated = baselineCommit ? execFileSync('git',['show',baselineCommit + ':extension/viewer.js'],{ encoding:'utf8',maxBuffer:8e6 }) : readFileSync(new URL('../extension/viewer.js', import.meta.url),'utf8')
const view = draftDiagnosisView(generated, harness, {
  observe: value => calls.push(value),
  transform(args, result, signal) {
    if (args.concepts && !result.error) {
      reads.push(json(result))
      // The saved graph requires text; the existing read-response boundary
      // accepts an empty name and must retain its literal key in the cache.
      for (const item of result.items) if (item.nodeId === 'constructor') item.text = ''
      const distance = result.items.find(item => item.nodeId === 'distance')
      if (distance && ['rename','blank','late'].includes(mode)) distance.text = mode === 'blank' ? '' : '读取后的距离名称'
      if (mode === 'foreign') result.documentId = 'another-document'
      if (mode === 'version') result.revision = 2
      if (mode === 'late') return new Promise(resolve => { delayed = { resolve: () => resolve(result), signal } })
    }
    return result
  },
})
const full = () => {
  const value = calls.at(-1); assert(value)
  assert.deepEqual(json(value.report), tools.diagnose(json(value.spec), { ports: json(value.ports), names: json(value.names) }))
  assert.equal(value.report.basis, 'recorded_fields_not_semantic_truth'); return value
}
const search = async query => { view.change('搜索槽位概念', query); await view.flushDebounce(); full() }
try {
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
  view.render(); await view.settle(); await view.flushDebounce(); await search('行驶')
  const initial = full(), original = json(initial.spec)
  let count = calls.length, readCount = reads.length
  for (let i = 0; i < 24; i++) await search(i % 2 ? '行驶' + ' '.repeat(i + 1) : 'absent-concept-' + i)
  assert.equal(reads.length - readCount, 24); assert.equal(reads.slice(readCount).filter(r => r.items.length === 0).length, 12)
  assert.equal(calls.length, count, 'empty and same-name real reads must reuse the whole draft report')
  assert.equal(calls.at(-1).names, initial.names); assert.equal(view.cache.size, 0)
  assert(reads.at(-1).items.some(item => item.nodeId === 'distance'))
  assert(text(view.field('选择槽位概念')).includes('行驶距离'), 'latest search options still update')

  // New literal IDs outside the first concept page must be retained, including
  // prototype-looking IDs, blank names and whitespace in an opaque identity.
  for (const [id,name] of [['__proto__','同名目录概念'], ['constructor',''], ['spaced/id:opaque identity','同名目录概念']]) {
    assert.equal(Object.prototype.hasOwnProperty.call(full().names, id), false, 'new literal ID must be outside the initial page: ' + id)
    count = calls.length; await search(id); assert.equal(calls.length, count + 1)
    assert.equal(Object.prototype.hasOwnProperty.call(full().names, id), true); assert.equal(full().names[id], name)
    assert.equal(Object.getPrototypeOf(full().names), Object.getPrototypeOf(initial.names))
    view.change('选择槽位概念', id); assert.equal(view.field('选择槽位概念').props.value, id)
    count = calls.length; await search(' ' + id + ' '); assert.equal(calls.length, count)
  }
  count = calls.length; await search('同名目录概念'); assert.equal(calls.length, count)
  assert.deepEqual(reads.at(-1).items.map(item => item.nodeId), ['__proto__','spaced/id:opaque identity'])

  view.change('槽位名称 slot-0', ''); const oldNames = full().names
  mode = 'rename'; count = calls.length; await search('行驶'); assert.equal(calls.length, count + 1)
  assert.notEqual(full().names, oldNames)
  assert(full().report.items.some(item => item.missing?.some(slot => slot.slotId === 'slot-0' && slot.name === '读取后的距离名称')))
  count = calls.length; await search(' 行驶 '); assert.equal(calls.length, count)
  mode = 'blank'; count = calls.length; await search('distance'); assert.equal(calls.length, count + 1); assert.equal(full().names.distance, '')
  count = calls.length; await search(' distance '); assert.equal(calls.length, count)
  mode = ''; await search('行驶'); assert.equal(full().names.distance, initial.names.distance)

  // Response identity/version and cancellation are checked before the merge.
  const retained = full(), retainedReport = json(view.report())
  for (const invalid of ['foreign','version']) {
    mode = invalid; count = calls.length; await search(invalid === 'foreign' ? 'distance' : ' 行驶 ')
    assert.equal(calls.length, count); assert.equal(full().names, retained.names)
    assert.deepEqual(json(view.report()), retainedReport); assert(text(view.tree).includes('概念目录身份或版本不一致'))
  }
  mode = 'late'; await search('行驶 '); assert(delayed); mode = ''
  count = calls.length; await search('distance '); assert.equal(delayed.signal.aborted, true)
  delayed.resolve(); await view.settle(); assert.equal(calls.length, count)
  assert.equal(full().names, retained.names); assert.deepEqual(json(view.report()), retainedReport)

  const expected = json(original); expected.slots[0].label = ''
  assert.deepEqual(JSON.parse(view.cache.values().next().value).spec, expected)
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
  console.log(JSON.stringify({ ok:true, equalAndEmptyNameReadReuse:true, latestConceptOptions:true, literalNewIdsAndBlankNames:true,
    actualChangedNamesRecomputed:true, foreignVersionAndLateNamesRejected:true, fullDefensiveReportParity:true,
    conditionsEvidenceBindingsIdentityAndPrivateDraftPreserved:true, actualGeneratedEditorAndHost:true, canonicalReadOnly:true, revision:1, learningCount:0 }))
} finally { view.stop(); harness.stop() }
