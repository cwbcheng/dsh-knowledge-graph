import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { createModelReviewController } from './kg-model-review-controller-fixture.mjs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const generated = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const fixture = modelStructureFixture(), harness = await modelLearningHarness({ fixture })
const key = 'dsh-kg-model-structure:' + JSON.stringify([fixture.documentId, 'taxi'])
const tools = createModelStructureTools(), views = [], writes = []
const original = harness.store.getDocument(fixture.documentId), canonical = original.nodes.find(node => node.id === 'taxi').modelStructure
const units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
async function mount(raw, revision = 1) {
  let latest
  const view = draftDiagnosisView(generated, harness, { observe: value => { latest = value } })
  views.push(view)
  view.props.revision = revision
  if (raw) view.cache.set(key, raw)
  view.render(); await view.settle(); await view.flushDebounce()
  return { view, current: () => json(latest) }
}
function controller(view) {
  const graph = harness.store.getDocument(fixture.documentId)
  const state = { resultView: { graph, sourceText: fixture.sourceText }, graphCommitQueueRef: { current: Promise.resolve() },
    currentResultRef: { current: null }, graphRevisionRef: { current: graph.revision }, verifyBusyRef: { current: false } }
  state.currentResultRef.current = state.resultView
  state.onSaved = value => { state.resultView = value; view.props.revision = state.graphRevisionRef.current }
  view.props.onCommit = args => { writes.push(args); return createModelReviewController(state, { call: (method, body) => harness.post(body, method) })(args) }
  view.render()
}
const buttons = element => Array.isArray(element) ? element.flatMap(buttons) : !element || typeof element !== 'object' ? []
  : [...(element.type === 'button' ? [element] : []), ...buttons(element.props?.children)]
const hasConfirm = view => buttons(view.tree).some(element => text(element) === '确认保存结构')
function strict(spec) {
  assert.throws(() => tools.validateShape(spec), { code: 'invalid_model_structure' })
  const changed = json(original)
  changed.nodes.find(node => node.id === 'taxi').modelStructure = json(spec)
  assert.throws(() => harness.store.saveGraph(changed, { sourceText: fixture.sourceText, expectedRevision: 1 }))
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
}
const cases = [
  ['empty example title', view => { view.click('成对实例 (3)'); view.change('实例名称', '') }],
  ['blank example scenario', view => { view.click('成对实例 (3)'); view.change('具体情境', '  \n ') }],
  ['blank branch label', view => { view.click('条件分支 (3)'); view.change('分支名称 base', ' ') }],
  ['unfinished slot source', view => view.change('槽位来源类型 distance-slot', 'source')],
  ...['适用条件', '完整映射规律', '边界与未定义情形'].map(label => ['unfinished ' + label + ' source', view => {
    view.click('条件分支 (3)'); view.change(label + '来源类型 base', 'source')
    view.change(label + '逐字引用 base', ''); view.change(label + '原文段落 base', '')
  }]),
  ['source quote without paragraph', view => { view.click('条件分支 (3)'); view.change('适用条件原文段落 base', '') }],
  ['source paragraph without quote', view => { view.click('条件分支 (3)'); view.change('适用条件逐字引用 base', '') }],
  ['unfinished example source', view => { view.click('成对实例 (3)'); view.change('实例来源类型 ', 'source') }],
]
const damaged = [
  ['unknown fields', spec => { spec.extra = true }],
  ['wrong version', spec => { spec.version = 2 }],
  ['wrong content identity', spec => { spec.identity = 'verified' }],
  ['missing slots', spec => { delete spec.slots }],
  ['null branch', spec => { spec.branches[0] = null }],
  ['duplicate slot IDs', spec => { spec.slots[1].id = spec.slots[0].id }],
  ['duplicate branch IDs', spec => { spec.branches[1].id = spec.branches[0].id }],
  ['duplicate example IDs', spec => { spec.examples[1].id = spec.examples[0].id }],
  ['empty concept ID', spec => { spec.slots[0].conceptId = '' }],
  ['wrong label type', spec => { spec.branches[0].label = 1 }],
  ['wrong scenario type', spec => { spec.examples[0].scenario = null }],
  ['missing provenance', spec => { delete spec.slots[0].provenance }],
  ['wrong provenance kind', spec => { spec.slots[0].provenance.kind = 'verified' }],
  ['negative paragraph', spec => { spec.slots[0].provenance.paragraph = -1 }],
  ['fractional paragraph', spec => { spec.slots[0].provenance.paragraph = 0.5 }],
  ['missing binding slot', spec => { spec.examples[0].inputs[0].slotId = 'missing' }],
  ['duplicate binding slot', spec => { spec.examples[0].inputs.push(json(spec.examples[0].inputs[0])) }],
  ['incompatible binding role', spec => { spec.slots[0].role = 'output' }],
  ['missing branch reference', spec => { spec.examples[0].branchId = 'missing' }],
  ['too long text', spec => { spec.examples[0].scenario = 'x'.repeat(2001) }],
  ['too many examples', spec => { spec.examples = Array.from({ length: 101 }, (_, i) => ({ ...json(spec.examples[0]), id: 'example-' + i })) }],
  ['oversized draft', spec => { spec.examples = Array.from({ length: 100 }, (_, i) => ({ ...json(spec.examples[0]), id: 'example-' + i, scenario: 'x'.repeat(2000), reasoning: 'y'.repeat(2000) })) }],
]
try {
  const first = await mount()
  first.view.click('成对实例 (3)'); first.view.click('添加成对实例')
  first.view.change('推测过程', '尚未填完情境，保留这段个人推测。')
  const raw = first.view.cache.get(key), expected = first.current().spec
  assert.equal(expected.examples.length, 4)
  assert.equal(expected.examples.at(-1).scenario, '')
  first.view.stop()
  const restored = await mount(raw)
  assert.equal(restored.current().spec.examples.length, 4, 'reopening must restore the unfinished example instead of falling back to the three canonical examples')
  assert.deepEqual(restored.current().spec, expected)
  assert.equal(restored.view.cache.get(key), raw)
  strict(expected)
  assert.equal(tools.validateDraft(expected), expected, 'draft validation preserves the original fields')
  assert(restored.current().report.items.some(item => item.code === 'shape_invalid'))
  assert(restored.current().report.items.some(item => item.code === 'example_scenario' && item.target.id === expected.examples.at(-1).id))
  controller(restored.view)
  restored.view.click('预览结构修改'); await restored.view.settle()
  assert(text(restored.view.tree).includes('invalid text')); assert(!hasConfirm(restored.view))
  assert.equal(restored.view.cache.get(key), raw)

  for (const [name, edit] of cases) {
    const before = await mount(); edit(before.view)
    const draft = before.current().spec, cached = before.view.cache.get(key)
    strict(draft); assert.equal(tools.validateDraft(draft), draft)
    before.view.stop()
    const after = await mount(cached)
    assert.deepEqual(after.current().spec, draft, name)
    assert.equal(after.view.cache.get(key), cached, name)
    assert(!text(after.view.tree).includes('缓存草稿格式无效'), name)
    assert.deepEqual(after.current().report, tools.diagnose(draft, { ports: after.current().ports, names: after.current().names }), name)
    assert(after.current().report.items.some(item => item.code === 'shape_invalid'), name)
    controller(after.view); after.view.click('预览结构修改'); await after.view.settle()
    assert(!hasConfirm(after.view), name); assert.equal(after.view.cache.get(key), cached, name)
    assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
    after.view.change('槽位名称 distance-slot', '恢复后继续整理')
    const continued = json(draft); continued.slots[0].label = '恢复后继续整理'
    assert.deepEqual(after.current().spec, continued, name + ': later edits preserve all unfinished fields')
    after.view.stop()
  }
  for (const [name, change] of damaged) {
    const spec = json(expected); change(spec)
    assert.throws(() => tools.validateDraft(spec), { code: 'invalid_model_structure' }, name)
    const cached = JSON.stringify({ revision: 1, spec }), bad = await mount(cached)
    assert.deepEqual(bad.current().spec, json(canonical), name)
    assert.equal(bad.view.cache.get(key), cached, name)
    assert(text(bad.view.tree).includes('缓存草稿格式无效'), name)
    bad.view.stop()
  }
  restored.view.props.modelId = 'multi'; restored.view.render(); await restored.view.settle()
  assert.deepEqual(restored.current().spec, json(original.nodes.find(node => node.id === 'multi').modelStructure))
  restored.view.props.modelId = 'taxi'; restored.view.render(); await restored.view.settle()
  assert.deepEqual(restored.current().spec, expected, 'model switching restores its own incomplete draft')
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), JSON.stringify(original))

  // Finishing the missing text still requires a fresh preview and explicit save.
  restored.view.click('成对实例 (4)'); restored.view.change('选择编辑实例', expected.examples.at(-1).id)
  restored.view.change('具体情境', '情境草稿已补齐，条件与映射仍需人工核对。')
  const finished = restored.current().spec
  tools.validateShape(finished)
  restored.view.click('预览结构修改'); await restored.view.settle()
  assert(hasConfirm(restored.view)); assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  restored.view.change('推测过程', '补充个人推测，不代表外部验证。')
  assert(!hasConfirm(restored.view), 'a new edit invalidates the earlier approval')
  const approved = restored.current().spec
  restored.view.click('预览结构修改'); await restored.view.settle()
  restored.view.click('确认保存结构'); await restored.view.settle()
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 2)
  const saved = harness.store.getDocument(fixture.documentId)
  assert.deepEqual(json(saved.nodes.find(node => node.id === 'taxi').modelStructure), approved)
  assert.deepEqual(saved.edges, original.edges)
  assert.equal(restored.view.cache.has(key), false)
  assert.equal(writes.filter(write => write.preview).length, 1, 'only the explicit confirmation writes')

  const stale = await mount(raw, 2); controller(stale.view)
  assert.deepEqual(stale.current().spec, expected)
  assert(text(stale.view.tree).includes('草稿基于第 1 版'))
  const preview = buttons(stale.view.tree).find(element => text(element) === '预览结构修改'), writeCount = writes.length
  assert(preview.props.disabled); preview.props.onClick(); await stale.view.settle()
  assert.equal(writes.length, writeCount); assert.equal(stale.view.cache.get(key), raw)
  stale.view.click('丢弃草稿并重新加载'); await stale.view.settle()
  assert.equal(stale.view.cache.has(key), false)
  assert.deepEqual(stale.current().spec, approved)
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), JSON.stringify(saved))
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
} finally { views.forEach(view => view.stop()); harness.stop() }
console.log(JSON.stringify({ ok: true, unfinishedEditorCases: cases.length + 1, malformedDraftsRejected: damaged.length,
  generatedEditorAndRealHostStore: true, fullDraftAndStrictDiagnosisPreserved: true, canonicalValidationUnchanged: true,
  repairedDraftRequiresPreviewAndConfirmation: true, editInvalidatesApproval: true, modelScopeAndStaleRevisionProtected: true,
  explicitDiscardReloadsCanonical: true, sourceAndEdgesUnchanged: true, learningCount: 0 }))
