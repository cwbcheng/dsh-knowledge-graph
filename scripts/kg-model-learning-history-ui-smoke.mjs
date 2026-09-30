import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerResponse } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { feedbackResponse } from './kg-model-feedback-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelStructureFixture() })
const { document, store, post } = harness, base = { documentId: document.documentId, modelId: 'taxi' }
let owner = { slots: [], effects: [] }, cursor = 0, tree, Component, props
const updates = [], storage = new Map(), requests = [], deferred = [], events = new Map(), opened = [], linked = []
let paused = false, legacy = false, forged = false
const slot = init => { const index = cursor++; return owner.slots[index] ||= init() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [state.value, next => { updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next }) }] },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
    owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps } },
}
const context = { window: { React, confirm: () => true, addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) },
  console, URL, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const viewer = context.window.KGViewer
const call = (args, signal) => {
  requests.push({ args, signal })
  const run = async () => { const result = await post(args)
    if (legacy) { delete result.modelLearningHistoryVersion; delete result.modelUnderstandingVersion }
    if (forged && args.action === 'get' && result.attempt) result.attempt.documentId = 'wrong-document'
    return result }
  return paused ? new Promise((resolve, reject) => deferred.push({ args, signal, resolve: () => run().then(resolve, reject) })) : run()
}
function render() {
  for (let index = 0; index < 30; index++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0; tree = Component(props); owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('Component update loop')
}
async function settle() { for (let index = 0; index < 12; index++) { await new Promise(resolve => setImmediate(resolve)); render() } }
function mount(name, value) {
  owner.slots.forEach(state => state.cleanup?.()); updates.length = 0; owner = { slots: [], effects: [] }
  Component = viewer[name]; assert.equal(typeof Component, 'function', name); props = value; render()
}
const text = el => Array.isArray(el) ? el.map(text).join('') : el && typeof el === 'object' ? text(el.props?.children) : String(el ?? '')
const all = (el, predicate) => Array.isArray(el) ? el.flatMap(child => all(child, predicate)) : !el || typeof el !== 'object' ? [] :
  [...(predicate(el) ? [el] : []), ...all(el.props?.children, predicate)]
const button = label => { const found = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0];
  assert(found, 'Missing button: ' + label); return found }
const click = label => { const found = button(label); assert(!found.props.disabled, label); found.props.onClick(); render() }
const field = label => { const found = all(tree, el => ['select', 'textarea'].includes(el.type) && el.props['aria-label'] === label)[0]; assert(found, label); return found }
const fill = (label, value) => { const found = field(label); assert(!found.props.disabled); found.props.onChange({ target: { value } }); render() }
try {
  const plan = await post({ ...base, action: 'plan', expectedRevision: 1 })
  await post({ ...base, action: 'save', expectedRevision: 1, taskId: plan.tasks[0].id, attemptId: 'old-prediction', selfRating: 'uncertain', response: learnerResponse })
  const originalTask = store.getLearningAttempt('old-prediction').task
  for (let index = 0; index < 125; index++) store.saveLearningAttempt({ attemptId: 'recent-' + index, documentId: base.documentId,
    expectedRevision: 1, task: originalTask, selfRating: 'confident', response: learnerResponse })
  const original = store.saveModelFeedback({ ...base, attemptId: 'old-observation', predictionId: 'old-prediction', expectedRevision: 1, expectedVersion: 1,
    response: { ...feedbackResponse(), comparison: 'different', diagnosis: 'condition' } })
  for (let index = 0; index < 105; index++) store.saveModelFeedback({ ...base, attemptId: 'recent-result-' + index,
    predictionId: 'old-prediction', expectedRevision: 1, expectedVersion: 1, response: feedbackResponse('reflection') })
  store.db.prepare("UPDATE learning_attempts SET created_at = created_at + 100000 WHERE attempt_id LIKE 'recent-result-%'").run()
  mount('ModelLearningHistoryPanel', { ...base, revision: 1, call, onOpen: value => opened.push(value) }); await settle()
  assert(text(tree).includes('本模型全部 126 次预测'))
  click('下一页记录'); await settle(); assert(text(tree).includes('第 21 至 40 条'))
  click('真实观察（自述） · 自述不同'); await settle()
  assert(text(tree).includes('符合筛选 1 次预测'))
  fill('诊断环节筛选', 'condition'); await settle()
  click('打开预测与结果')
  assert.equal(opened[0].attemptId, 'old-prediction')
  assert.equal(opened[0].resultId, 'old-observation', 'a matching result beyond the five-row preview is still reachable')
  assert(!requests.some(item => ['save', 'save-result', 'reveal', 'review'].includes(item.args.action)), 'reading counts has no write or reveal side effects')
  legacy = true; click('重新读取学习记录'); await settle()
  assert(text(tree).includes('未显示计数')); assert(!text(tree).includes('本模型全部'))
  legacy = false; paused = true; click('重新读取学习记录'); const oldReads = deferred.splice(0)
  props.modelId = 'multi'; render(); const newReads = deferred.splice(0)
  newReads.forEach(item => item.resolve()); await settle(); oldReads.forEach(item => item.resolve()); await settle()
  assert(text(tree).includes('本模型全部 0 次预测'), 'late model reads cannot replace the selected scope')
  paused = false
  mount('ModelLearningPanel', { ...base, revision: 1, call, onUnderstanding: value => linked.push(value) }); await settle()
  fill('具体的新情境', '保留未保存的预测情境。')
  props.focusRequest = { ...opened[0], nonce: 1 }; render(); await settle()
  assert(text(tree).includes('我预测费用为 18 元。'))
  assert(requests.some(item => item.args.action === 'get' && item.args.attemptId === 'old-prediction'), 'explicit get bypasses the recent history limit')
  click('返回未保存的预测草稿'); assert.equal(field('具体的新情境').props.value, '保留未保存的预测情境。')
  props.focusRequest = { ...opened[0], nonce: 2 }; render(); await settle()
  click('修订我的理解'); assert.equal(linked[0].attemptId, 'old-prediction')
  const feedbackProps = all(tree, el => el.type === viewer.ModelFeedbackPanel)[0].props
  mount('ModelFeedbackPanel', { ...feedbackProps, focusRequest: { ...opened[0], nonce: 1 } }); await settle()
  assert(text(tree).includes(original.response.content))
  assert(!all(tree, el => el.type === 'textarea').length, 'direct result selection opens the saved record, not a blank editor')
  click('查看诊断对应材料')
  const materialsProps = all(tree, el => el.type === viewer.ModelDiagnosisMaterials)[0].props
  mount('ModelDiagnosisMaterials', materialsProps); await settle()
  assert(text(tree).includes('来源材料保持隐藏'))
  assert(!all(tree, el => el.type === 'button' && text(el) === '对照材料原文').length)
  const revealed = (await post({ ...base, action: 'reveal', attemptId: 'old-prediction', expectedVersion: 1 })).attempt
  props.prediction = revealed; props.onLocate = () => {}; render(); await settle()
  assert(text(tree).includes('条件：0 <= 行驶距离 <= 3 km'))
  assert(text(tree).includes('用户解释'))
  props.revision = 2; render(); assert(button('对照材料原文').props.disabled)
  props.revision = 1; props.diagnosis = 'input'; render(); await settle()
  assert(text(tree).includes('行驶距离 / 本次行程 / km'))
  const expectedInputQuotes = revealed.task.references.filter(ref => ref.nodeId === 'distance').flatMap(ref => ref.citations.map(item => item.quote))
  for (const quote of expectedInputQuotes) assert(text(tree).includes(quote))
  props.prediction = structuredClone(revealed)
  for (const ref of props.prediction.task.references.filter(ref => ref.nodeId === 'distance')) { ref.state = 'rejected'; ref.entailmentStatus = 'unsupported' }
  render(); assert(text(tree).includes('已驳回')); assert(text(tree).includes('原文语义不支持'), 'negative source status cannot be softened into a generic uncertainty label')
  const appendCorrection = (attemptId, parentResultId, content) => post({ ...base, action: 'save-result', attemptId,
    predictionId: 'old-prediction', expectedRevision: 1, expectedVersion: 2,
    response: { ...original.response, content, parentResultId, revisionReason: '追加澄清，保留历史。' } })
  assert(!(await appendCorrection('off-window-head', original.attemptId, '窗口之外的最新更正。')).error)
  mount('ModelFeedbackPanel', { ...base, revision: 1, supported: true, prediction: revealed, call,
    focusRequest: { resultId: original.attemptId, nonce: 5 } }); await settle()
  assert(text(tree).includes('这条结果已有更正'))
  click('查看最新更正'); await settle(); assert(text(tree).includes('窗口之外的最新更正。'))
  click('追加结果更正'); fill('实际观察结果', '已编辑但尚未保存的更正。'); fill('结果更正理由', '保留这份修改理由。')
  assert(!(await appendCorrection('off-window-peer-head', 'off-window-head', '另一窗口又补充了更正。')).error)
  click('重新读取验证结果'); await settle()
  assert(button('保存结果记录').props.disabled)
  click('查看最新更正'); await settle()
  assert.equal(field('实际观察结果').props.value, '已编辑但尚未保存的更正。')
  click('以最新更正为基准保留草稿')
  assert.equal(field('结果更正理由').props.value, '保留这份修改理由。')
  click('保存结果记录'); await settle()
  assert(text(tree).includes('已编辑但尚未保存的更正。'), 'refresh after saving must not replay an old navigation request over the new receipt')
  const oldButton = all(tree, el => el.type === 'button' && text(el).includes('真实观察（自述）') && text(el).includes('已有更正'))[0]
  oldButton.props.onClick(); render(); click('查看最新更正'); await settle()
  assert(text(tree).includes('已编辑但尚未保存的更正。'), 'the same latest head can be opened again after explicitly selecting historical content')
  const recordKey = 'dsh-kg-model-understanding:' + JSON.stringify([base.documentId, base.modelId])
  mount('ModelUnderstandingPanel', { ...base, revision: 1, call }); await settle()
  fill('我的联结规律', '先保留这份正在编辑的表述。')
  props.practiceRequest = { attemptId: 'old-prediction', exercise: 'prediction', nonce: 3 }; render(); await settle()
  click('关联这次预测并修订')
  assert.equal(field('我的联结规律').props.value, '先保留这份正在编辑的表述。')
  assert.deepEqual(JSON.parse(storage.get(recordKey)).practiceIds, ['old-prediction'])
  assert(!store.listLearningAttempts(base.documentId, base.modelId, 'understanding').length, 'linking a draft does not silently save it')
  click('保存我的理解'); await settle()
  const saved = store.listLearningAttempts(base.documentId, base.modelId, 'understanding')[0]
  assert.deepEqual(saved.response.practiceIds, ['old-prediction'])
  assert(saved.task.practiceSnapshots[0].feedbackTotal > 100)
  assert.equal(saved.response.mapping, '先保留这份正在编辑的表述。')
  forged = true; props.practiceRequest = { attemptId: 'recent-0', exercise: 'prediction', nonce: 4 }; render(); await settle()
  assert(text(tree).includes('待关联的预测身份不一致'))
  assert(!all(tree, el => el.type === 'button' && text(el) === '关联这次预测并修订').length)
  console.log(JSON.stringify({ ok: true, actualComponentsSqliteRoutes: true, traceBeyondRecent100: true, correctionAwareResultGet: true,
    hiddenReferences: true, roleMaterials: true, oldSourceBlocked: true, linkPreservesDraft: true, typedCountsNoWrites: true, scopeRaces: true }))
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
