import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelNameReuseFixture } from './kg-model-name-reuse-fixture.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const baseline = process.argv[2] ? execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim() : null
const generated = baseline ? execFileSync('git', ['show', baseline + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const tools = createModelStructureTools(), orders = [['structure', 'concepts'], ['concepts', 'structure']]
for (const structured of [true, false]) for (const order of orders) {
  const fixture = modelNameReuseFixture(), structure = fixture.graph.nodes.find(node => node.id === 'taxi').modelStructure
  if (structured) {
    // These canonical concepts have no legacy edge in this model, and none of
    // its endpoints appear in the first concept page. Slots keep separate IDs.
    for (const [index, id, unit] of [[2, 'force', 'N'], [4, '__proto__', 'km'], [6, 'spaced/id:opaque identity', 'km']]) {
      structure.slots[index].conceptId = id; structure.slots[index].unit = unit
    }
  } else for (const node of fixture.graph.nodes) delete node.modelStructure
  const harness = await modelLearningHarness({ fixture }), calls = [], reads = [], pending = new Map()
  let initial = true, mode = '', late = null
  const view = draftDiagnosisView(generated, harness, {
    observe: value => calls.push(value),
    transform(args, result, signal) {
      const kind = args.structureEdit ? 'structure' : args.concepts ? 'concepts' : ''
      if (kind) reads.push({ kind, result: json(result) })
      if (initial) return new Promise(resolve => pending.set(kind, { resolve: () => resolve(result), signal }))
      if (kind === 'structure' && !result.error) {
        if (mode && result.structure) for (const slot of result.structure.slots) if (slot.conceptId === 'distance') slot.conceptText = '本次读取的概念名称'
        if (mode === 'foreign') result.documentId = 'another-document'
        if (mode === 'version') result.revision = 2
        if (mode === 'late') return new Promise(resolve => { late = { resolve: () => resolve(result), signal } })
      }
      return result
    },
  })
  const full = () => {
    const value = calls.at(-1); assert(value)
    assert.deepEqual(json(value.report), tools.diagnose(json(value.spec), { ports: json(value.ports), names: json(value.names) }))
    return value
  }
  const reload = async () => { view.props.active = false; view.render(); await view.settle(); view.props.active = true; view.render(); await view.settle() }
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    view.render(); await view.settle(); assert.equal(pending.size, 2)
    for (const kind of order) { pending.get(kind).resolve(); await view.settle() }
    initial = false; await view.flushDebounce()
    const saved = full(), original = json(saved.spec), firstPage = reads.find(read => read.kind === 'concepts').result.items
    const endpointIds = [...new Set(saved.spec.slots.map(slot => slot.conceptId))]
    assert(firstPage.every(node => !endpointIds.includes(node.nodeId)), 'Actual first page must exclude all model endpoints')
    const canonicalName = id => fixture.graph.nodes.find(node => node.id === id).text
    for (const id of endpointIds) {
      assert.equal(Object.prototype.hasOwnProperty.call(saved.names, id), true)
      assert.equal(saved.names[id], canonicalName(id), 'A concept name must not be replaced by another slot label: ' + id)
    }
    if (structured) {
      assert(!saved.ports.some(port => port.node.nodeId === 'force'))
      assert.equal(saved.spec.slots[38].label, '独立槽位 38')
      assert.equal(saved.spec.slots[39].label, '独立槽位 39')
      assert.equal(saved.names.__proto__, saved.names['spaced/id:opaque identity'])
      for (const index of [0, 1, 2, 4, 6]) view.change('槽位名称 slot-' + index, '')
      const expected = json(original); for (const index of [0, 1, 2, 4, 6]) expected.slots[index].label = ''
      assert.deepEqual(json(full().spec), expected)
      for (const index of [0, 1, 2, 4, 6]) {
        const slot = saved.spec.slots[index]
        assert(full().report.items.some(item => item.missing?.some(missing => missing.slotId === slot.id && missing.name === canonicalName(slot.conceptId))))
      }
    }
    const retained = full(), retainedNames = json(retained.names), retainedReport = json(retained.report)
    await reload(); assert.deepEqual(json(full().names), retainedNames); assert.deepEqual(json(full().report), retainedReport)
    for (const invalid of ['foreign', 'version']) {
      mode = invalid; await reload(); assert.deepEqual(json(full().names), retainedNames); assert.deepEqual(json(full().report), retainedReport)
      assert(text(view.tree).includes('结构读取身份或版本不一致'))
    }
    if (structured) {
      mode = 'changed'; await reload(); assert.equal(full().names.distance, '本次读取的概念名称')
      assert(full().report.items.some(item => item.missing?.some(slot => slot.slotId === 'slot-0' && slot.name === '本次读取的概念名称')))
    }
    mode = ''; await reload(); assert.deepEqual(json(full().names), retainedNames); assert.deepEqual(json(full().report), retainedReport)
    mode = 'late'; await reload(); assert(late); view.props.active = false; view.render(); await view.settle(); assert.equal(late.signal.aborted, true)
    late.resolve(); await view.settle(); assert.deepEqual(json(full().names), retainedNames); assert.deepEqual(json(full().report), retainedReport)
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
    assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
    assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
    console.log(JSON.stringify({ structured, order, initialConceptPageExcludedEndpoints: true, independentSlotNamesAndCanonicalNames: true }))
  } finally { view.stop(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, canonicalEndpointNames: true, independentSameConceptSlots: true, endpointWithoutLegacyEdge: true,
  sameNameLiteralIds: true, privateBlankLabelUsesCanonicalName: true, bothInitialResponseOrders: true, legacyCanonicalFallback: true,
  actualNameChangeAndRestore: true, foreignVersionAndLateStructureNamesRejected: true, fullDefensiveReportParity: true,
  conditionsEvidenceBindingsAndCanonicalUnchanged: true, actualGeneratedEditorAndHost: true, canonicalReadOnly: true }))
