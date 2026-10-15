import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { modelMissingChanges } from './kg-model-diagnostic-missing-fixture-data.mjs'
import { countExampleBindingReads } from './kg-model-example-bindings-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { createModelReviewController } from './kg-model-review-controller-fixture.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const tools = createModelStructureTools()
const result = run => { try { return { report: run() } } catch (error) { return { error: { name: error.name, message: error.message, code: error.code } } } }
let cases = 0
for (const slots of [0, 2, 8, 9, 12, 40]) for (const examples of [0, 8, 9, 100]) for (const change of modelMissingChanges) {
  // Mutations require at least two examples; truncate after applying them.
  const document = modelBranchCountsFixture({ slots: Math.max(2, slots), examples: Math.max(3, examples) })
  const spec = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  change(document, spec)
  if (slots === 0) { spec.slots = []; for (const example of spec.examples) if (example) { example.inputs = []; example.outputs = [] } }
  spec.examples = spec.examples.slice(0, examples)
  const context = { invalid: '来源待复核', cautions: ['条件与边界待核对'], names: { distance: '距离' },
    ports: [{ editable: false, role: 'unknown', edgeKey: 'old', edgeIndex: 3,
      node: { nodeId: 'distance', text: '距离' }, citations: [{ paragraph: 0, quote: document.sourceText }] }] }
  const before = JSON.stringify(spec)
  assert.deepEqual(result(() => tools.diagnoseOwnedDraft(spec, context)), result(() => tools.diagnose(spec, context)))
  assert.equal(JSON.stringify(spec), before); cases++
}
const fixture = modelBranchCountsFixture({ slots: 40, branches: 40, examples: 100 })
const spec = fixture.graph.nodes.find(node => node.id === 'taxi').modelStructure
const raw = countExampleBindingReads(() => tools.diagnose(spec)), prepared = countExampleBindingReads(() => tools.diagnoseOwnedDraft(spec))
assert.deepEqual(prepared.response, raw.response)
assert.equal(raw.bindingSomeVisits, 58232); assert.equal(prepared.bindingSomeVisits, 0)
// Invalid wide drafts must keep bounded defensive reads, including overflow.
for (const mutate of [s => s.examples.push(...json(s.examples)), s => s.slots.push(...json(s.slots)),
  s => { s.examples[0].scenario = '' }, s => { s.slots[0].provenance.kind = 'source' }]) {
  const invalid = json(spec); mutate(invalid)
  const a = countExampleBindingReads(() => tools.diagnose(invalid)), b = countExampleBindingReads(() => tools.diagnoseOwnedDraft(invalid))
  assert.deepEqual(b, a); assert(a.response.items.some(item => item.code === 'shape_invalid'))
}

const harness = await modelLearningHarness({ fixture }), calls = []
const view = draftDiagnosisView(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), harness, { observe: value => calls.push(value) })
const check = () => {
  const { spec, ports, names, report } = calls.at(-1)
  assert.deepEqual(json(report), tools.diagnose(json(spec), { ports: json(ports), names: json(names) }))
  return json(report)
}
try {
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
  const state = { resultView: { graph: JSON.parse(before), sourceText: fixture.sourceText }, graphCommitQueueRef: { current: Promise.resolve() },
    currentResultRef: { current: null }, graphRevisionRef: { current: 1 }, verifyBusyRef: { current: false } }
  state.currentResultRef.current = state.resultView
  view.props.onCommit = args => {
    assert.equal(args.preview, null, 'this regression only previews, never commits')
    return createModelReviewController(state, { call: (method, body) => harness.post(body, method) })(args)
  }
  view.render(); await view.settle(); await view.flushDebounce(); check()
  view.click('成对实例 (100)'); view.change('选择编辑实例', 'example-1')
  for (const value of ['', '0', '\u2003\u00a0', '待核对的输出']) { view.change('独立槽位 1的实例状态 slot-1', value); check() }
  view.change('实例适用分支', ''); check(); view.change('实例适用分支', 'branch-6'); check()
  view.change('具体情境', ''); assert(check().items.some(item => item.code === 'shape_invalid'))
  view.change('具体情境', '个人情境，未证明映射'); assert(!check().items.some(item => item.code === 'shape_invalid'))
  view.click('移除实例绑定 slot-1'); assert(check().items.some(item => item.code === 'example_outputs' && item.target.id === 'example-1'))
  view.click('补齐输出槽位'); check(); view.change('独立槽位 1的实例状态 slot-1', '0'); check()
  view.click('条件分支 (40)')
  for (const value of ['', '需要按原文核对的完整映射']) { view.change('完整映射规律 branch-6', value); check() }
  view.change('适用条件 branch-6', '保留限定条件'); view.change('边界与未定义情形 branch-6', '边界仍未验证'); check()
  view.click('预览结构修改'); await view.settle()
  assert(text(view.tree).includes('待确认的结构修改'), text(view.tree).slice(0, 1600))
  view.change('完整映射规律 branch-6', '编辑后必须重新预览'); check()
  assert(!text(view.tree).includes('确认保存结构'))
  const retained = JSON.parse(view.cache.values().next().value).spec
  assert.deepEqual(retained, json(calls.at(-1).spec))
  assert.equal(retained.branches[6].condition.text, '保留限定条件')
  assert.equal(retained.branches[6].boundary.text, '边界仍未验证')
  assert.deepEqual(retained.branches[6].condition.provenance, spec.branches[6].condition.provenance)
  assert.equal(retained.identity, 'hypothesis')
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
  console.log(JSON.stringify({ ok: true, cases, fullOrderedReportParity: true, invalidDraftFallback: true,
    bindingVisits: [raw.bindingSomeVisits, prepared.bindingSomeVisits], generatedEditorEdits: true,
    previewInvalidatedByEdit: true, conditionsProvenanceIdentityPreserved: true, canonicalAndLearningUnchanged: true }))
} finally { view.stop(); harness.stop() }
