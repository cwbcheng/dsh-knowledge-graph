import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const baseline = process.argv[2] ? execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim() : null
const generated = baseline ? execFileSync('git', ['show', baseline + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const fixture = modelStructureFixture(), template = fixture.graph.nodes.find(node => node.id === 'distance')
for (const id of ['__proto__', 'constructor', 'spaced/id:opaque identity']) fixture.graph.nodes.push({ ...json(template), id, text: '同名目录概念' })
const harness = await modelLearningHarness({ fixture }), tools = createModelStructureTools(), calls = [], reads = []
const pending = [], retainedDrafts = new Map()
let delay = false, invalid = ''
const view = draftDiagnosisView(generated, harness, { observe: value => calls.push(value),
  transform(args, result, signal) {
    if (args.conceptNames) {
      if (invalid === 'document') result.documentId = 'another-document'
      if (invalid === 'version') result.revision = 2
      if (invalid === 'unsupported') delete result.modelConceptNamesVersion
      return result
    }
    if (!args.concepts) return result
    reads.push(json(result))
    if (invalid === 'document') result.documentId = 'another-document'
    if (invalid === 'version') result.revision = 2
    if (invalid === 'unsupported') delete result.modelStructureVersion
    if (delay) return new Promise(resolve => pending.push({ signal, result, resolve: () => resolve(result) }))
    return result
  },
})
const full = () => {
  const value = calls.at(-1); assert(value)
  assert.deepEqual(json(value.report), tools.diagnose(json(value.spec), { ports: json(value.ports), names: json(value.names) }))
  assert.equal(value.report.basis, 'recorded_fields_not_semantic_truth'); return value
}
const switchTo = async modelId => { view.props.modelId = modelId; view.render(); await view.settle(); await view.flushDebounce() }
const find = (element, predicate) => Array.isArray(element) ? element.flatMap(child => find(child, predicate)) : !element || typeof element !== 'object' ? []
  : [...(predicate(element) ? [element] : []), ...find(element.props?.children, predicate)]
const add = (conceptId, canonicalName) => {
  assert(text(view.field('选择槽位概念')).includes(canonicalName))
  view.change('选择槽位概念', conceptId); view.click('添加独立槽位')
  const value = full(), slot = value.spec.slots.at(-1)
  assert.equal(slot.conceptId, conceptId); assert.equal(slot.role, 'unknown')
  assert.equal(slot.label, ''); assert.deepEqual(json(slot.provenance), { kind: 'unknown', paragraph: null, quote: '', note: '' })
  assert.equal(value.names[conceptId], canonicalName, 'a selectable concept must retain its canonical name after changing models')
  assert.equal(find(view.tree, element => element.type === 'fieldset' && text(element).includes(slot.id))[0].props.children[0].props.children[0], canonicalName)
  return slot
}
// A restored private slot can be absent from the model's saved endpoints.
// While the real concept read waits, its legal ID must be rendered literally.
async function cachedLiteralFallback() {
  const late = []
  const restored = draftDiagnosisView(generated, harness, { transform(args, result, signal) {
    return args.concepts || args.conceptNames ? new Promise(resolve => { late.push({ signal, resolve: () => resolve(result) }) }) : result
  } })
  restored.props.modelId = 'unknown'
  const key = 'dsh-kg-model-structure:' + JSON.stringify([fixture.documentId, 'unknown'])
  const cached = { revision: 1, spec: { version: 1, identity: 'undetermined', slots: [{ id: 'cached-literal', conceptId: '__proto__',
    label: '', role: 'unknown', unit: '', state: '', provenance: { kind: 'unknown', paragraph: null, quote: '', note: '' } }], branches: [], examples: [] } }
  const raw = JSON.stringify(cached); restored.cache.set(key, raw)
  try {
    restored.render(); await restored.settle(); assert(late.length && late.every(read => !read.signal.aborted))
    const fieldset = find(restored.tree, element => element.type === 'fieldset')[0]; assert(fieldset)
    assert.equal(fieldset.props.children[0].props.children[0], '__proto__', 'pending canonical names must render a literal ID, not its inherited prototype')
    late.forEach(read => read.resolve()); await restored.settle(); await restored.flushDebounce()
    assert.equal(find(restored.tree, element => element.type === 'fieldset')[0].props.children[0].props.children[0], '同名目录概念')
    assert.equal(restored.cache.get(key), raw); assert.deepEqual(json(restored.report()), tools.diagnose(cached.spec,
      { ports: (await harness.post({ documentId: fixture.documentId, expectedRevision: 1, modelId: 'unknown', structureEdit: true }, 'connection-models')).legacyPorts,
        names: Object.fromEntries(fixture.graph.nodes.filter(node => node.type === 'concept').map(node => [node.id, node.text])) }))
  } finally { restored.stop() }
}
try {
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  if (process.argv.includes('--cached-literal-first')) await cachedLiteralFallback()
  view.render(); await view.settle(); await view.flushDebounce(); assert.equal(full().names.fare, '打车费用 (元)')
  const firstReadCount = reads.length
  await switchTo('multi')
  add('fare', '打车费用 (元)')
  assert.equal(reads.length, firstReadCount + 1, 'model changes refresh even an unchanged query and offset')
  for (const [modelId, conceptId] of [['multi', '__proto__'], ['unknown', 'spaced/id:opaque identity'], ['taxi', 'constructor']]) {
    if (view.props.modelId !== modelId) await switchTo(modelId)
    const slot = add(conceptId, '同名目录概念')
    view.change('时间或对象状态 ' + slot.id, '这个模型的私有对象状态：' + modelId)
    retainedDrafts.set(modelId, json(full().spec))
  }
  for (const modelId of ['multi', 'unknown', 'taxi']) {
    await switchTo(modelId); assert.deepEqual(json(full().spec), retainedDrafts.get(modelId))
    for (const slot of full().spec.slots) assert.equal(full().names[slot.conceptId], fixture.graph.nodes.find(node => node.id === slot.conceptId).text)
  }

  // Start a real old-model concept read, then hold the new-model read too.
  // Old options disappear while loading; its response cannot merge late names.
  delay = true; view.props.active = false; view.render(); await view.settle()
  view.props.active = true; view.render(); await view.settle(); assert.equal(pending.length, 1)
  const oldRead = pending[0]
  for (const item of oldRead.result.items) item.text = '迟到的旧模型目录名称'
  await switchTo('multi'); assert.equal(pending.length, 2); assert.equal(oldRead.signal.aborted, true)
  const newRead = pending[1]; assert.equal(newRead.signal.aborted, false)
  assert(!text(view.field('选择槽位概念')).includes('同名目录概念'))
  assert.equal(find(view.tree, element => element.props['aria-label'] === '添加独立槽位')[0].props.disabled, true)
  oldRead.resolve(); await view.settle()
  assert(!Object.values(full().names).includes('迟到的旧模型目录名称'))
  newRead.resolve(); await view.settle(); delay = false
  assert(text(view.field('选择槽位概念')).includes('同名目录概念'))
  assert.deepEqual(json(full().spec), retainedDrafts.get('multi'))
  assert.equal(full().names.__proto__, '同名目录概念')
  assert.equal(Object.hasOwn(full().names, '__proto__'), true)

  for (const mode of ['document', 'version', 'unsupported']) {
    invalid = mode; await switchTo(mode === 'version' ? 'taxi' : 'unknown')
    assert(!text(view.field('选择槽位概念')).includes('同名目录概念'))
    assert.equal(Object.hasOwn(full().names, 'constructor'), false)
    assert(mode === 'unsupported' ? text(view.tree).includes('尚未部署') : /概念(?:目录|名称)身份或版本不一致/.test(text(view.tree)))
    assert.deepEqual(json(full().spec), retainedDrafts.get(view.props.modelId))
    invalid = ''; view.props.active = false; view.render(); await view.settle()
    view.props.active = true; view.render(); await view.settle(); await view.flushDebounce()
    assert(text(view.field('选择槽位概念')).includes('同名目录概念'))
  }
  if (!process.argv.includes('--cached-literal-first')) await cachedLiteralFallback()
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
  console.log(JSON.stringify({ ok: true, modelSwitchRefreshesConceptDirectory: true, selectableConceptNamesPreserved: true,
    unchangedSearchAndOffset: true, structuredAndLegacyModelSwitches: true, literalSameNameConceptIdsPreserved: true,
    pendingRestoredLiteralSlotSafe: true,
    modelScopedPrivateDraftsRestored: true, oldOptionsDisabledDuringNewRead: true, oldModelLateConceptReadAborted: true,
    foreignRevisionAndUnsupportedConceptReadsRejected: true, fullDefensiveReportParity: true,
    rolesConditionsEvidenceBindingsAndCanonicalUnchanged: true, actualGeneratedEditorAndHost: true, revision: 1, learningCount: 0 }))
} finally { view.stop(); harness.stop() }
