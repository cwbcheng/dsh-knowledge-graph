import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerResponse } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { feedbackResponse } from './kg-model-feedback-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelStructureFixture() })
const { document, store, post } = harness
const base = { documentId: document.documentId, modelId: 'taxi' }
const plan = await post({ ...base, action: 'plan', expectedRevision: 1 })
for (const attemptId of ['prediction', 'other-prediction']) await post({ ...base, action: 'save', expectedRevision: 1,
  taskId: plan.tasks[0].id, attemptId, selfRating: 'uncertain', response: learnerResponse })
let owner = { slots: [], effects: [] }, cursor = 0, tree
const updates = [], storage = new Map(), events = new Map(), requests = [], deferred = []
let paused = false, loseSave = true, legacy = false, forged = false, confirm = true
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
const context = { window: { React, confirm: () => confirm, addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) },
  console, URL, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
let Component = context.window.KGViewer.ModelFeedbackPanel
assert.equal(typeof Component, 'function')
const props = { ...base, revision: 1, prediction: store.getLearningAttempt('prediction'), supported: true,
  call: (args, signal) => {
    requests.push({ args, signal })
    const run = async () => {
      const result = await post(args)
      if (legacy) delete result.modelFeedbackVersion
      if (forged && args.action === 'results' && result.attempts[0]) result.attempts[0].task.predictionSnapshot.model.nodeId = 'wrong-model'
      if (args.action === 'save-result' && loseSave) { loseSave = false; throw new Error('Lost result acknowledgement') }
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
async function settle() { for (let index = 0; index < 10; index++) { await new Promise(resolve => setImmediate(resolve)); render() } }
const text = el => Array.isArray(el) ? el.map(text).join('') : el && typeof el === 'object' ? text(el.props?.children) : String(el ?? '')
const all = (el, predicate) => Array.isArray(el) ? el.flatMap(child => all(child, predicate)) : !el || typeof el !== 'object' ? [] :
  [...(predicate(el) ? [el] : []), ...all(el.props?.children, predicate)]
const button = label => {
  const found = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0]
  assert(found, 'Missing button: ' + label); return found
}
const click = label => { const found = button(label); assert(!found.props.disabled, label + ' disabled'); found.props.onClick(); render() }
const input = label => {
  const found = all(tree, el => ['textarea', 'input', 'select'].includes(el.type) && el.props['aria-label'] === label)[0]
  assert(found, label); return found
}
const fill = (label, value) => { const found = input(label); assert(!found.props.disabled, label + ' disabled'); found.props.onChange({ target: { value } }); render() }
const remount = () => { owner.slots.forEach(state => state.cleanup?.()); updates.length = 0; owner = { slots: [], effects: [] }; render() }
const draftKey = () => 'dsh-kg-model-feedback:' + JSON.stringify([props.documentId, props.modelId, props.prediction.attemptId])
try {
  const before = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
  render(); await settle()
  assert(button('保存结果记录').props.disabled)
  fill('反馈来源', 'reflection'); fill('个人复盘内容', '尚未取得真实观察结果，不把计划当作证据。')
  let warned = false; events.get('beforeunload')({ preventDefault: () => { warned = true } }); assert(warned)
  const save = button('保存结果记录'); save.props.onClick(); save.props.onClick(); render(); await settle()
  assert.equal(requests.filter(item => item.args.action === 'save-result').length, 1)
  assert(text(tree).includes('Lost result acknowledgement'))
  assert(input('个人复盘内容').props.disabled, 'unknown save outcome freezes edits until resolved')
  click('重试确认结果'); await settle()
  const writes = requests.filter(item => item.args.action === 'save-result')
  assert.equal(writes[0].args.attemptId, writes[1].args.attemptId)
  assert.equal(store.listModelFeedback(document.documentId, 'taxi', 'prediction').total, 1)
  assert(text(tree).includes('未独立核验'))
  warned = false; events.get('beforeunload')({ preventDefault: () => { warned = true } }); assert(!warned)
  click('追加结果更正'); fill('个人复盘内容', '补充说明：只有计划，没有观察。')
  assert(button('保存结果记录').props.disabled)
  fill('结果更正理由', '澄清反馈来源。')
  const first = store.listModelFeedback(document.documentId, 'taxi', 'prediction').attempts[0]
  await post({ ...base, action: 'save-result', attemptId: 'peer-correction', predictionId: 'prediction', expectedRevision: 1, expectedVersion: 1,
    response: { ...first.response, parentResultId: first.attemptId, content: '另一窗口澄清：尚未验证。', revisionReason: '另一窗口更正' } })
  click('保存结果记录'); await settle()
  assert(text(tree).includes('已有新更正'))
  assert.equal(input('个人复盘内容').props.value, '补充说明：只有计划，没有观察。')
  confirm = false; click('放弃结果草稿'); assert.equal(input('个人复盘内容').props.value, '补充说明：只有计划，没有观察。')
  confirm = true; click('重新读取验证结果'); await settle()
  assert(button('保存结果记录').props.disabled)
  click('以最新更正为基准保留草稿')
  assert.equal(input('个人复盘内容').props.value, '补充说明：只有计划，没有观察。')
  click('保存结果记录'); await settle()
  click('记录新结果'); fill('反馈来源', 'ai_suggestion'); fill('AI 建议内容', '建议检查账单中的附加收费。')
  assert(button('保存结果记录').props.disabled, 'AI source is mandatory')
  fill('生成来源（工具或模型）', '手动记录的测试 AI')
  props.prediction = (await post({ ...base, action: 'reveal', attemptId: 'prediction', expectedVersion: 1 })).attempt
  render(); await settle()
  assert(text(tree).includes('草稿对照的是预测版本 1'))
  assert(button('保存结果记录').props.disabled)
  click('对照当前预测版本后保留草稿'); click('保存结果记录'); await settle()
  assert(text(tree).includes('AI 建议'))
  assert(store.listModelFeedback(document.documentId, 'taxi', 'prediction').attempts.some(item => item.response.type === 'ai_suggestion' && item.task.assessment === 'not_independently_verified'))
  click('记录新结果'); fill('反馈来源', 'reference'); fill('引用段落', '0')
  fill('资料中的结果或表述', '这段资料只给简化模型，不是本次账单结果。')
  click('保存结果记录'); await settle()
  assert(button('定位结果所引原文').props.disabled, 'no source navigation handler means no false operable control')
  props.onLocate = () => {}; render(); assert(!button('定位结果所引原文').props.disabled)
  store.saveGraph({ ...document.graph, summary: 'Explicit fixture source revision' }, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  props.revision = 2; render(); assert(button('定位结果所引原文').props.disabled)
  assert(text(tree).includes('不作为当前第 2 版的验证'))
  click('记录新结果'); fill('实际观察结果', '实际账单有附加费，不能验证简化分段模型。')
  fill('观察时的实际输入与条件', '7 km；附加费项目存在。'); fill('实际发生日期', feedbackResponse().observedOn)
  assert(button('保存结果记录').props.disabled, 'observation requires an explicit occurred confirmation')
  const checkbox = all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0]
  checkbox.props.onChange({ target: { checked: true } }); render()
  loseSave = true; click('保存结果记录'); await settle(); remount(); await settle()
  assert(text(tree).includes('已确认此前保存的结果'))
  assert(text(tree).includes('真实观察（自述）'))
  assert.equal(store.listModelFeedback(document.documentId, 'taxi', 'prediction').total, 6)
  click('记录新结果'); fill('反馈来源', 'reflection'); fill('个人复盘内容', '尚未保存的个人记录。')
  props.prediction = store.getLearningAttempt('other-prediction'); render(); await settle()
  assert.equal(input('实际观察结果').props.value, '')
  props.prediction = store.getLearningAttempt('prediction'); render(); await settle()
  assert.equal(input('个人复盘内容').props.value, '尚未保存的个人记录。')
  legacy = true; click('重新读取验证结果'); await settle()
  assert(text(tree).includes('Host 不支持保存'))
  assert(button('保存结果记录').props.disabled)
  legacy = false; forged = true; click('重新读取验证结果'); await settle()
  assert(text(tree).includes('身份不一致'))
  assert(button('保存结果记录').props.disabled)
  forged = false; click('重新读取验证结果'); await settle()
  props.supported = false; render(); await settle()
  assert(!all(tree, el => el.type === 'button' && text(el) === '保存结果记录').length, 'mixed Host blocks entry before any unsupported save')
  props.supported = true; render(); await settle()
  assert.equal(input('个人复盘内容').props.value, '尚未保存的个人记录。')
  paused = true; click('保存结果记录'); const delayedWrite = deferred.splice(0)
  props.prediction = store.getLearningAttempt('other-prediction'); render(); const newReads = deferred.splice(0)
  newReads.forEach(item => item.resolve()); await settle()
  delayedWrite.forEach(item => item.resolve()); await settle()
  assert.equal(input('实际观察结果').props.value, '', 'late successful write cannot overwrite another prediction draft')
  paused = false; props.prediction = store.getLearningAttempt('prediction'); render(); await settle()
  assert(!all(tree, el => el.type === 'textarea').length, 'returning after acknowledgement recovers the saved result')
  assert.equal(store.listModelFeedback(document.documentId, 'taxi', 'prediction').total, 7)
  click('记录新结果'); fill('反馈来源', 'reflection'); fill('个人复盘内容', '写入尚未发出时挂载另一界面。')
  paused = true; click('保存结果记录'); const unmountedWrite = deferred.splice(0)
  remount(); const pendingReads = deferred.splice(0)
  pendingReads.forEach(item => item.resolve()); await settle()
  assert(text(tree).includes('此前结果未保存'))
  fill('个人复盘内容', '重新挂载后写的新草稿，不能被旧响应删除。')
  const newerId = JSON.parse(storage.get(draftKey())).attemptId
  unmountedWrite.forEach(item => item.resolve()); await settle()
  assert.equal(JSON.parse(storage.get(draftKey())).attemptId, newerId, 'unmounted receipt must not clear a newer sessionStorage draft')
  paused = false
  assert.deepEqual(store.getDocument(document.documentId).nodes, before.nodes)
  assert.deepEqual(store.getDocument(document.documentId).edges, before.edges)
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore)
  assert.equal(store.getLearningAttempt('prediction').version, 2, 'only explicit reveal changed prediction version')
  owner.slots.forEach(state => state.cleanup?.()); owner = { slots: [], effects: [] }; updates.length = 0
  Component = context.window.KGViewer.ConnectionModelPanel
  let rootLegacy = true
  props.load = async args => {
    const result = await post(args, 'connection-models')
    if (rootLegacy) delete result.modelFeedbackVersion
    return result
  }
  render(); await settle()
  const learningPanel = () => all(tree, el => el.type === context.window.KGViewer.ModelLearningPanel)[0]
  assert.equal(learningPanel().props.feedbackSupported, false, 'workbench explicitly propagates missing result capability')
  rootLegacy = false; click('重新读取模型'); await settle()
  assert.equal(learningPanel().props.feedbackSupported, true)
  console.log(JSON.stringify({ ok: true, generatedComponentProductionRoutes: true, lostResponseAndRemount: true, pendingEditsProtected: true,
    correctionConflictDraftPreserved: true, oldPredictionVersionExplicit: true, oldCitationBlocked: true, scopeAndUnmountRaces: true, mixedHostBlocked: true }))
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
