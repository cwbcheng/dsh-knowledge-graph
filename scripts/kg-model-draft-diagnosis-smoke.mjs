import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const harness = await modelLearningHarness({ fixture: modelBranchCountsFixture({ slots: 40, branches: 40, examples: 100 }) })
const calls = [], tools = createModelStructureTools()
let changedNames = false, changedPorts = false
const view = draftDiagnosisView(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), harness, {
  observe: value => calls.push(value),
  transform(args, result) {
    if (changedNames && args.concepts && !result.error) for (const item of result.items) if (item.nodeId === 'distance') item.text = '重新读取的距离名称'
    if (changedPorts && args.structureEdit && !result.error) {
      const port = result.legacyPorts[0]
      port.editable = false; port.role = 'unknown'
      port.citations = [{ paragraph: 0, quote: '重新读取的端点关系上下文，仍待核对' }]
    }
    return result
  },
})
const assertFullReport = () => {
  const last = calls.at(-1); assert(last)
  assert.deepEqual(json(last.report), tools.diagnose(json(last.spec), { ports: json(last.ports), names: json(last.names) }))
  assert.equal(last.report.basis, 'recorded_fields_not_semantic_truth')
  return last
}
try {
  const before = JSON.stringify(harness.store.getDocument(view.props.documentId))
  view.render(); await view.settle(); await view.flushDebounce()
  const initial = assertFullReport(), originalSpec = json(initial.spec)
  const initialReport = json(initial.report), initialCalls = calls.length
  for (let i = 0; i < 24; i++) view.change('搜索槽位概念', 'query-' + i)
  view.change('选择槽位概念', 'distance')
  view.click('成对实例 (100)'); await view.settle()
  for (let i = 0; i < 24; i++) view.change('选择编辑实例', 'example-' + i)
  view.click('下一页草稿待补充内容'); view.click('上一页草稿待补充内容')
  view.click('条件分支 (40)'); view.click('成对实例 (100)')
  view.props.busy = true; view.render(); view.props.busy = false; view.render(); await view.settle()
  assert.equal(calls.length, initialCalls, 'search, selection, pagination and unrelated state must not diagnose the unchanged whole draft')
  assert.deepEqual(json(calls.at(-1).report), initialReport)
  assert.equal(view.field('选择编辑实例').props.value, 'example-23'); assert.equal(view.cache.size, 0)

  view.click('变量槽位 (40)'); await view.settle(); assertFullReport()
  let count = calls.length, last = calls.at(-1)
  view.change('槽位名称 slot-0', ''); await view.settle()
  assert.equal(calls.length, count + 1)
  let edited = assertFullReport()
  assert.notEqual(edited.spec, last.spec); assert.equal(edited.ports, last.ports); assert.equal(edited.names, last.names)
  // A structurally invalid private edit keeps the ordinary defensive error;
  // a later valid edit must replace that report, never reuse the error.
  count = calls.length
  view.change('槽位来源类型 slot-0', 'source'); await view.settle()
  assert.equal(calls.length, count + 1)
  assert(assertFullReport().report.items.some(item => item.code === 'shape_invalid' && item.detail.includes('source fields need a quote and paragraph')))
  count = calls.length
  view.change('槽位来源类型 slot-0', 'ai'); await view.settle()
  assert.equal(calls.length, count + 1)
  edited = assertFullReport(); assert(!edited.report.items.some(item => item.code === 'shape_invalid'))
  assert.equal(edited.report.origins.ai, 1); assert(edited.report.items.some(item => item.code === 'identity_caution' && item.identity === 'hypothesis'))

  // Name-only reads are an independent diagnostic input, even when the
  // specification and legacy relation objects are exactly the same objects.
  changedNames = true; last = calls.at(-1); count = calls.length
  view.change('搜索槽位概念', '行驶'); await view.flushDebounce()
  const renamed = assertFullReport(); assert(calls.length > count)
  assert.equal(renamed.spec, last.spec); assert.equal(renamed.ports, last.ports); assert.notEqual(renamed.names, last.names)
  assert(renamed.report.items.some(item => item.missing?.some(slot => slot.slotId === 'slot-0' && slot.name === '重新读取的距离名称')))
  assert.notDeepEqual(json(renamed.report), json(last.report))

  changedPorts = true; count = calls.length; last = calls.at(-1)
  view.props.active = false; view.render(); await view.settle(); assert.equal(view.tree, null)
  view.props.active = true; view.render(); await view.settle()
  const refreshed = assertFullReport(); assert(calls.length > count)
  assert.equal(refreshed.spec, last.spec); assert.notEqual(refreshed.ports, last.ports)
  const gap = refreshed.report.items.find(item => item.code === 'legacy_port' && item.citationBasis === 'stored_relation_context')
  assert(gap); assert.deepEqual(json(gap.citations), [{ paragraph: 0, quote: '重新读取的端点关系上下文，仍待核对' }])
  assert.notDeepEqual(json(refreshed.report), json(last.report))

  // Version changes invalidate this scoped report even while a newer read
  // correctly rejects an old draft and leaves its three data references intact.
  count = calls.length; last = calls.at(-1); view.props.revision = 2; view.render(); await view.settle()
  const stale = assertFullReport(); assert.equal(calls.length, count + 1)
  assert.equal(stale.spec, last.spec); assert.equal(stale.ports, last.ports); assert.equal(stale.names, last.names)
  assert(text(view.tree).includes('草稿基于第 1 版，当前为第 2 版'))
  assert.equal(view.button('丢弃草稿并重新加载').props.disabled, false)
  assert(view.field('模型内容性质')); assert(view.tree)
  view.props.revision = 1; view.render(); await view.settle(); assertFullReport()

  const retained = JSON.parse(view.cache.values().next().value).spec
  const expected = json(originalSpec); expected.slots[0].label = ''; expected.slots[0].provenance.kind = 'ai'
  assert.deepEqual(retained, expected, 'only explicitly edited fields change; all bindings, conditions, evidence, units and identities remain')
  count = calls.length; view.props.modelId = 'multi'; view.render(); await view.settle()
  assert(calls.length > count); const other = assertFullReport()
  assert.equal(other.spec.examples.length, 0); assert.equal(other.spec.slots[0].id, 'initial-speed')
  assert.equal(other.report.origins.ai, 0)
  view.props.modelId = 'taxi'; view.render(); await view.settle(); assertFullReport()
  assert.deepEqual(JSON.parse(view.cache.values().next().value).spec, retained)
  assert.equal(view.field('槽位来源类型 slot-0').props.value, 'ai')
  assert.equal(JSON.stringify(harness.store.getDocument(view.props.documentId)), before)
  assert.equal(harness.store.getDocumentRevision(view.props.documentId), 1)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: view.props.documentId, modelId: 'taxi' })).attempts, [])
  console.log(JSON.stringify({ ok: true, unchangedDraftNavigationReuse: true, fullDefensiveReportParity: true,
    explicitDraftEditRecomputed: true, invalidDraftRecovered: true, nameOnlyReadRecomputed: true, legacyEvidenceRefreshRecomputed: true,
    revisionAndModelScopeRecomputed: true, allConditionsEvidenceBindingsUnitStatePreserved: true, actualGeneratedEditorAndHost: true,
    canonicalAndPrivateDraftSafe: true, revision: 1, learningCount: 0 }))
} finally { view.stop(); harness.stop() }
