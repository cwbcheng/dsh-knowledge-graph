import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'

const harness = await modelLearningHarness()
const { store, document, post } = harness
let owner = { slots: [], effects: [] }, cursor = 0, tree
const updates = [], storage = new Map(), events = new Map(), requests = [], deferred = []
let paused = false, loseSave = true, loseReveal = true, loseReview = true
const slot = init => { const index = cursor++; return owner.slots[index] ||= init() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) {
    const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const context = { window: { React, confirm: () => true, addEventListener: (key, fn) => events.set(key, fn),
  removeEventListener: key => events.delete(key) }, console, AbortController,
  crypto: { randomUUID }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const Component = context.window.KGViewer.ModelLearningPanel
assert.equal(typeof Component, 'function')
const props = { documentId: document.documentId, modelId: 'taxi', revision: 1, active: true,
  call: (args, signal) => {
    requests.push({ args, signal })
    const run = async () => {
      const result = await post(args)
      if (args.action === 'save' && loseSave) { loseSave = false; throw new Error('Lost save response') }
      if (args.action === 'reveal' && loseReveal) { loseReveal = false; throw new Error('Lost reveal response') }
      if (args.action === 'review' && loseReview) { loseReview = false; throw new Error('Lost review response') }
      return result
    }
    return paused ? new Promise((resolve, reject) => deferred.push({ args, signal, resolve: () => run().then(resolve, reject) })) : run()
  } }
function render() {
  for (let index = 0; index < 30; index++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0
    tree = Component(props); owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('Component update loop')
}
async function settle() { for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); render() } }
const text = el => Array.isArray(el) ? el.map(text).join('') : el && typeof el === 'object' ? text(el.props?.children) : String(el ?? '')
const all = (el, predicate) => Array.isArray(el) ? el.flatMap(child => all(child, predicate)) : !el || typeof el !== 'object' ? [] :
  [...(predicate(el) ? [el] : []), ...all(el.props?.children, predicate)]
const button = label => {
  const found = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0]
  assert(found, 'Missing button: ' + label); return found
}
const click = label => { const found = button(label); assert(!found.props.disabled, label + ' disabled'); found.props.onClick(); render() }
const input = label => { const found = all(tree, el => ['textarea', 'select'].includes(el.type) && el.props['aria-label'] === label)[0]; assert(found, label); return found }
const fill = (label, value) => { const found = input(label); assert(!found.props.disabled, label); found.props.onChange({ target: { value } }); render() }
const remount = () => { owner.slots.forEach(state => state.cleanup?.()); updates.length = 0; owner = { slots: [], effects: [] }; render() }
try {
  const before = JSON.stringify(store.getDocument(document.documentId))
  render(); await settle()
  assert(!text(tree).includes('2 km 对应 10 元'), 'reference example must not be shown before prediction')
  assert(button('保存预测').props.disabled)
  const fields = { inputs: '输入', mapping: '联结与推理', outputs: '输出', boundary: '适用条件与失效边界',
    scenario: '具体的新情境', prediction: '我的预测', check: '可观察的验证依据' }
  for (const [key, label] of Object.entries(fields)) fill(label, learnerResponse[key])
  fill('此前的原文接触', 'unsure')
  props.active = false; render(); assert.equal(tree, null)
  props.active = true; render(); await settle()
  assert.equal(input('我的预测').props.value, learnerResponse.prediction, 'tab switches preserve draft')
  props.modelId = 'unknown'; render(); await settle()
  assert.equal(input('我的预测').props.value, '', 'drafts never cross models')
  props.modelId = 'taxi'; render(); await settle()
  assert.equal(input('我的预测').props.value, learnerResponse.prediction)
  remount(); await settle()
  assert.equal(input('我的预测').props.value, learnerResponse.prediction, 'session draft survives component remount')
  const saveButton = button('保存预测')
  saveButton.props.onClick(); saveButton.props.onClick(); render(); await settle()
  assert.equal(requests.filter(request => request.args.action === 'save').length, 1, 'synchronous double clicks are locked')
  assert(text(tree).includes('Lost save response'))
  assert.equal(input('我的预测').props.value, learnerResponse.prediction, 'lost acknowledgement preserves draft')
  click('保存预测'); await settle()
  const saves = requests.filter(request => request.args.action === 'save')
  assert.equal(saves[0].args.attemptId, saves[1].args.attemptId, 'retry uses identical immutable request ID')
  assert.equal(store.listLearningAttempts(document.documentId, 'taxi').length, 1)
  assert(!text(tree).includes('2 km 对应 10 元'))
  assert(text(tree).includes('最初的预测'))
  click('展开原文对照'); await settle()
  assert(text(tree).includes('Lost reveal response'))
  assert(!text(tree).includes('2 km 对应 10 元'), 'failed reveal is not falsely acknowledged')
  click('展开原文对照'); await settle()
  assert(text(tree).includes('2 km 对应 10 元'))
  assert(text(tree).includes('不是标准答案'))
  fill('复盘判断', learnerReview.diagnosis); fill('保留或修改的理由', learnerReview.reflection); fill('下一步验证', learnerReview.nextCheck)
  remount(); await settle()
  const history = all(tree, el => el.type === 'button' && text(el).includes(' · 已对照'))[0]
  assert(history); history.props.onClick(); render(); await settle()
  assert.equal(input('保留或修改的理由').props.value, learnerReview.reflection, 'unsaved reflection survives remount')
  click('保存复盘'); await settle()
  assert(text(tree).includes('Lost review response'))
  click('保存复盘'); await settle()
  assert(text(tree).includes('复盘已保存'))
  assert(input('保留或修改的理由').props.disabled, 'completed review is immutable')
  const saved = store.listLearningAttempts(document.documentId, 'taxi')[0]
  assert.equal(saved.version, 3)
  assert.equal(saved.response.prediction, learnerResponse.prediction)
  assert.equal(JSON.stringify(store.getDocument(document.documentId)), before, 'UI prediction/reveal/review never revises graph')
  let warned = false
  events.get('beforeunload')({ preventDefault: () => { warned = true } })
  assert.equal(warned, false, 'saved records must not be mistaken for unsaved drafts')

  click('另开一次预测'); fill('我的预测', '未保存的第二次预测')
  paused = true
  props.modelId = 'unknown'; render()
  const old = deferred.splice(0)
  props.modelId = 'wrong'; render()
  const fresh = deferred.splice(0)
  assert(old.every(request => request.signal.aborted))
  fresh.forEach(request => request.resolve()); await settle()
  old.forEach(request => request.resolve()); await settle()
  assert(text(tree).includes('最近 0 条'), 'late history responses cannot replace current model')
  paused = false
  props.modelId = 'taxi'; render(); await settle()
  assert.equal(input('我的预测').props.value, '未保存的第二次预测')
  store.saveGraph({ ...document.graph, summary: 'fixture source changed' }, { sourceText: document.sourceText,
    sourceUnits: document.sourceUnits, expectedRevision: 1 })
  props.revision = 2; render(); await settle()
  assert(text(tree).includes('草稿未被覆盖'))
  assert(button('保存预测').props.disabled, 'draft cannot silently adopt a new source version')
  assert.equal(input('我的预测').props.value, '未保存的第二次预测')
  click('重开当前版本练习'); assert.equal(input('我的预测').props.value, '')
  const oldRecord = all(tree, el => el.type === 'button' && text(el).includes(' · 旧版'))[0]
  oldRecord.props.onClick(); render(); await settle()
  assert(text(tree).includes('来源图已更新'))
  assert(all(tree, el => el.type === 'button' && text(el) === '定位原文').every(el => el.props.disabled),
    'old quotations cannot navigate to a silently changed current source')
  assert.equal(store.getDocumentRevision(document.documentId), 2)
  click('另开一次预测')
  for (const [key, label] of Object.entries(fields)) fill(label, learnerResponse[key])
  loseSave = true; click('保存预测'); await settle()
  assert(text(tree).includes('Lost save response'))
  const savedCount = store.listLearningAttempts(document.documentId, 'taxi').length
  store.saveGraph({ ...document.graph, summary: 'fixture third revision' }, { sourceText: document.sourceText,
    sourceUnits: document.sourceUnits, expectedRevision: 2 })
  props.revision = 3; render(); await settle()
  assert(text(tree).includes('草稿未被覆盖'))
  click('重新读取学习记录'); await settle()
  assert(text(tree).includes('已确认此前保存的预测'), 'lost save can be recovered without discarding old-version draft')
  assert.equal(store.listLearningAttempts(document.documentId, 'taxi').length, savedCount)
  click('展开原文对照'); await settle()
  fill('保留或修改的理由', learnerReview.reflection); fill('下一步验证', learnerReview.nextCheck)
  loseReview = true; click('保存复盘'); await settle()
  fill('保留或修改的理由', '响应丢失之后，另写一份尚未保存的复盘。')
  click('保存复盘'); await settle()
  assert(text(tree).includes('不能覆盖'))
  click('重新读取学习记录'); await settle()
  assert(text(tree).includes('保留的未保存复盘'))
  assert(text(tree).includes('响应丢失之后，另写一份尚未保存的复盘。'), 'conflict refresh must not silently discard the alternate draft')
  warned = false; events.get('beforeunload')({ preventDefault: () => { warned = true } })
  assert.equal(warned, true, 'closing the tab warns about the uncommitted alternate reflection')
  assert.equal(store.getDocumentRevision(document.documentId), 3)
  console.log(JSON.stringify({ ok: true, actualSqliteHttpRoutes: true, concealedUntilSavedReveal: true,
    lostResponseRetries: true, scopeRaceFenced: true, draftsPreserved: true, oldSourceExplicit: true,
    oldVersionSaveAcknowledged: true, conflictingReflectionPreserved: true }))
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
