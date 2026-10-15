import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { createModelReviewController } from './kg-model-review-controller-fixture.mjs'
import { draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'
import { draftCopyView, copyWorkSince } from './kg-model-draft-copy-fixture.mjs'
import { reloadDraftCache } from './kg-model-draft-cache-fixture.mjs'

const source = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), tools = createModelStructureTools()
const fixture = modelBranchCountsFixture({ slots: 40, branches: 40, examples: 100 }), harness = await modelLearningHarness({ fixture })
const calls = [], view = draftCopyView(source, harness, { observe: value => calls.push(value) })
const key = 'dsh-kg-model-structure:' + JSON.stringify([fixture.documentId, 'taxi'])
const objects = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(objects)]
const current = () => calls.at(-1).spec
const check = () => {
  const value = calls.at(-1)
  assert.deepEqual(json(value.report), tools.diagnose(value.spec, { ports: value.ports, names: value.names }))
}
let edits = 0
const edit = (label, value, mutate) => {
  const previous = current(), before = structuredClone(previous), expected = json(previous)
  objects(previous).forEach(Object.freeze)
  mutate(expected); view.change(label, value); edits++
  assert.deepEqual(structuredClone(current()), expected, label)
  assert.deepEqual(structuredClone(previous), before, 'earlier draft snapshot is immutable')
  assert.notEqual(current(), previous)
  for (const name of ['slots', 'branches', 'examples']) {
    assert.notEqual(current()[name], previous[name])
    assert(current()[name].every(item => !previous[name].includes(item)), 'mutable entries are independent')
  }
  assert.deepEqual(JSON.parse(view.cache.get(key)).spec, json(expected), 'immediate complete private cache')
  check()
}
try {
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  view.render(); await view.settle(); await view.flushDebounce()
  const cold = { ...view.work }
  edit('槽位名称 slot-0', '独立输入', s => { s.slots[0].label = '独立输入' })
  assert.deepEqual(copyWorkSince(view, cold), { specStringifies: 2, draftStringifies: 1, specParses: 1, draftParses: 0, storageWrites: 1 })
  const warm = { ...view.work }
  edit('单位 slot-0', 'km', s => { s.slots[0].unit = 'km' })
  assert.deepEqual(copyWorkSince(view, warm), { specStringifies: 1, draftStringifies: 1, specParses: 0, draftParses: 1, storageWrites: 1 })
  edit('时间或对象状态 slot-0', '具体对象与时间', s => { s.slots[0].state = '具体对象与时间' })
  for (const [field, suffix, value] of [['kind', '来源类型', 'user'], ['quote', '逐字引用', '仅是资料中的引文'], ['note', '整理说明', '还需核对条件']]) {
    edit('槽位' + suffix + ' slot-0', value, s => { s.slots[0].provenance[field] = value })
  }
  for (const value of ['2', '', '-1', '1e309', 'invalid']) {
    edit('槽位原文段落 slot-0', value, s => { s.slots[0].provenance.paragraph = value === '' ? null : Number(value) - 1 })
    // The following edit keeps the previous JSON clone's non-finite -> null rule.
    edit('时间或对象状态 slot-0', value, s => { s.slots[0].state = value })
  }
  edit('槽位原文段落 slot-0', '1', s => { s.slots[0].provenance.paragraph = 0 })
  edit('模型内容性质', 'hypothesis', s => { s.identity = 'hypothesis' })
  view.click('条件分支 (40)')
  for (const [field, label] of [['condition', '适用条件'], ['mapping', '完整映射规律'], ['boundary', '边界与未定义情形']]) {
    for (const value of ['', '保留 ' + label + ' 与逐字依据']) edit(label + ' branch-1', value, s => { s.branches[1][field].text = value })
    edit(label + '整理说明 branch-1', '未验证', s => { s.branches[1][field].provenance.note = '未验证' })
  }
  view.click('成对实例 (100)'); view.change('选择编辑实例', 'example-1')
  for (const [field, label, value] of [['title', '实例名称', '个人例子'], ['scenario', '具体情境', '明确适用范围'], ['branchId', '实例适用分支', 'branch-1'], ['reasoning', '推测过程', '待核对的推测']]) {
    edit(label, value, s => { s.examples[1][field] = value })
  }
  edit('独立输入的实例状态 slot-0', '7 km', s => { s.examples[1].inputs.find(b => b.slotId === 'slot-0').value = '7 km' })
  edit('独立槽位 1的实例状态 slot-1', '预测 18 元', s => { s.examples[1].outputs.find(b => b.slotId === 'slot-1').value = '预测 18 元' })
  edit('实例整理说明 ', '个人填写不证明映射', s => { s.examples[1].provenance.note = '个人填写不证明映射' })
  view.click('移除实例绑定 slot-1'); check(); view.click('补齐输出槽位'); check()
  const privateSpec = json(current()), foreign = json(privateSpec); foreign.examples[1].reasoning = '外部缓存不能替换编辑副本'
  view.cache.set(key, JSON.stringify({ revision: 1, spec: foreign })); await reloadDraftCache(view)
  assert.deepEqual(json(current()), privateSpec)
  edit('推测过程', '继续当前私有草稿', s => { s.examples[1].reasoning = '继续当前私有草稿' })
  const set = view.cache.set, savedRaw = view.cache.get(key)
  view.cache.set = () => { throw new Error('quota exceeded') }
  view.change('推测过程', '写入失败仍保留内存草稿'); check()
  assert(text(view.tree).includes('草稿缓存不可用')); assert.equal(view.cache.get(key), savedRaw)
  view.change('具体情境', '保留写入失败后的前一字段'); check()
  assert.equal(current().examples[1].reasoning, '写入失败仍保留内存草稿')
  view.cache.set = set
  edit('推测过程', '写入恢复', s => { s.examples[1].reasoning = '写入恢复' })
  assert.equal(JSON.parse(view.cache.get(key)).spec.examples[1].scenario, '保留写入失败后的前一字段')
  // Remount and model switches must install the restored/saved draft, never a prior serialization.
  const restored = view.cache.get(key), remountCalls = [], remount = draftCopyView(source, harness, { observe: value => remountCalls.push(value) })
  try {
    remount.cache.set(key, restored); remount.render(); await remount.settle(); await remount.flushDebounce()
    assert.deepEqual(json(remountCalls.at(-1).spec), JSON.parse(restored).spec)
    remount.change('单位 slot-0', 'restored unit'); assert.equal(JSON.parse(remount.cache.get(key)).spec.slots[0].unit, 'restored unit')
  } finally { remount.stop() }
  view.props.modelId = 'multi'; view.render(); await view.settle(); await view.flushDebounce()
  assert(!text(view.tree).includes('slot-0'))
  view.props.modelId = 'taxi'; view.render(); await view.settle(); await view.flushDebounce()
  assert.deepEqual(json(current()), JSON.parse(restored).spec)
  const state = { resultView: { graph: JSON.parse(before), sourceText: fixture.sourceText }, graphCommitQueueRef: { current: Promise.resolve() },
    currentResultRef: { current: null }, graphRevisionRef: { current: 1 }, verifyBusyRef: { current: false } }
  state.currentResultRef.current = state.resultView
  view.props.onCommit = args => { assert.equal(args.preview, null); return createModelReviewController(state, { call: (method, body) => harness.post(body, method) })(args) }
  view.render(); view.click('预览结构修改'); await view.settle()
  assert(text(view.tree).includes('quote does not match'), 'unverified invented quote must still be rejected')
  edit('槽位逐字引用 slot-0', '', s => { s.slots[0].provenance.quote = '' })
  view.click('预览结构修改'); await view.settle(); assert(text(view.tree).includes('待确认的结构修改'), text(view.tree).slice(0, 1800))
  edit('单位 slot-0', '编辑使预览失效', s => { s.slots[0].unit = '编辑使预览失效' })
  assert(!text(view.tree).includes('确认保存结构'))
  view.click('丢弃草稿并重新加载'); await view.settle(); await view.flushDebounce()
  assert.equal(view.cache.has(key), false); assert.deepEqual(json(current()), fixture.graph.nodes.find(n => n.id === 'taxi').modelStructure)
  edit('单位 slot-0', '丢弃后新草稿', s => { s.slots[0].unit = '丢弃后新草稿' })
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
  // Only this explicit external-write fixture changes canonical state.
  const external = harness.store.getDocument(fixture.documentId); external.summary += ' external revision'
  harness.store.saveGraph(external, { sourceText: fixture.sourceText, expectedRevision: 1 })
  const externalSnapshot = JSON.stringify(harness.store.getDocument(fixture.documentId))
  view.props.revision = 2; view.render(); await view.settle()
  assert(text(view.tree).includes('草稿基于第 1 版')); assert.throws(() => view.button('预览结构修改'))
  const changedScope = { ...view.work }
  edit('单位 slot-0', '旧版私有文字仍保留', s => { s.slots[0].unit = '旧版私有文字仍保留' })
  assert.equal(copyWorkSince(view, changedScope).specParses, 1, 'new revision cannot reuse an old scoped copy')
  assert.equal(JSON.parse(view.cache.get(key)).revision, 1)
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), externalSnapshot)
  console.log(JSON.stringify({ ok: true, edits, wholeDraftCopyIsolation: true, fullReportAndImmediateCacheParity: true,
    warmEditSerializations: 2, coldEditSerializations: 3, storageFailuresAndExternalChanges: true, nonFiniteNormalization: true,
    remountModelRevisionDiscardScopes: true, previewInvalidated: true, canonicalAndLearningUnchangedExceptExplicitRevisionFixture: true }))
} finally { view.stop(); harness.stop() }
