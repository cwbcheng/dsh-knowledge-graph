import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'

const harness = await modelLearningHarness()
const { store, document, post } = harness
let owner = { slots: [], effects: [] }, cursor = 0, tree
const updates = [], storage = new Map(), events = new Map(), requests = [], deferred = []
let paused = false, loseSave = true, loseReveal = true, loseReview = true, storageFailure = false
let confirmAllowed = true, confirmations = 0
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
const context = { window: { React, confirm: () => { confirmations++; return confirmAllowed }, addEventListener: (key, fn) => events.set(key, fn),
  removeEventListener: key => events.delete(key) }, console, AbortController,
  crypto: { randomUUID }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => {
    if (storageFailure) throw new Error('QuotaExceededError')
    storage.set(key, value)
  }, removeItem: key => storage.delete(key) } }
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
const closingWarned = () => { let warned = false; events.get('beforeunload')({ preventDefault: () => { warned = true } }); return warned }
try {
  const before = JSON.stringify(store.getDocument(document.documentId))
  render(); await settle()
  assert(!text(tree).includes('2 km 对应 10 元'), 'reference example must not be shown before prediction')
  assert(button('保存预测').props.disabled)
  assert(!closingWarned(), 'Untouched defaults are not unsaved personal choices')
  const fields = { inputs: '输入', mapping: '联结与推理', outputs: '输出', boundary: '适用条件与失效边界',
    scenario: '具体的新情境', prediction: '我的预测', check: '可观察的验证依据' }
  storageFailure = true
  for (const exercise of ['prediction', 'counterexample']) {
    props.exercise = exercise; render(); await settle()
    fill('此前的原文接触', 'seen')
    assert(closingWarned(), 'Exposure-only ' + exercise + ' drafts must warn before closing')
    fill('此前的原文接触', 'unsure')
    assert(!closingWarned(), 'Restoring default exposure leaves no personal choice to discard')
    const prediction = exercise === 'counterexample' ? '改变后的预测' : '我的预测'
    const privateFields = { [prediction]: '未提交的私人预测\n仍需核验。', '适用条件与失效边界': '仅限简化模型\n夜间附加费未核验。',
      ...(exercise === 'counterexample' ? { '只改变的一项与保持不变的条件': '只改变距离\n时间条件保持不变。',
        '什么观察结果会反驳这条规律': '需实际观察\n计划不是已发生的证据。' } : {}) }
    for (const [label, value] of Object.entries(privateFields)) fill(label, value)
    fill('此前的原文接触', 'seen')
    assert(text(tree).includes('草稿缓存不可用'))
    props.active = false; render(); assert.equal(tree, null)
    props.active = true; render(); await settle()
    for (const [label, value] of Object.entries(privateFields)) assert.equal(input(label).props.value, value, 'Unavailable storage must not erase in-window ' + exercise + ' drafts')
    assert.equal(input('此前的原文接触').props.value, 'seen')
    assert(text(tree).includes('草稿缓存不可用'), 'Reactivation must retain the uncached practice warning')
    click('重新读取学习记录'); await settle()
    assert(text(tree).includes('草稿缓存不可用'), 'Reading records must not hide an uncached practice draft')
    const normalCall = props.call
    props.call = (args, signal) => args.action === 'plan' ? Promise.resolve({ error: { message: '练习服务暂不可读' } }) : normalCall(args, signal)
    render(); click('重新读取学习记录'); await settle()
    assert(text(tree).includes('练习服务暂不可读') && text(tree).includes('草稿缓存不可用'), 'Service and cache failures are independent')
    props.call = normalCall; render(); click('重新读取学习记录'); await settle()
    storageFailure = false
    fill(prediction, privateFields[prediction] + '\n缓存已恢复。')
    assert(!text(tree).includes('草稿缓存不可用'), 'Successful caching clears only the cache warning')
    storageFailure = true
    assert.equal(store.listLearningAttempts(document.documentId, 'taxi').length, 0, 'Retaining drafts must not save practice records')
    for (const label of Object.keys(privateFields)) fill(label, '')
    fill('此前的原文接触', 'unsure')
  }
  storageFailure = false; props.exercise = 'prediction'; render(); await settle()
  for (const [key, label] of Object.entries(fields)) fill(label, learnerResponse[key])
  fill('此前的原文接触', 'unsure')
  props.active = false; render(); assert.equal(tree, null)
  props.active = true; render(); await settle()
  assert.equal(input('我的预测').props.value, learnerResponse.prediction, 'tab switches preserve draft')
  props.modelId = 'unknown'; render(); await settle()
  assert.equal(input('我的预测').props.value, '', 'drafts never cross models')
  assert(!text(tree).includes('草稿缓存不可用'), 'Empty drafts do not inherit another model cache warning')
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
  click('另开一次预测'); fill('此前的原文接触', 'seen')
  const previousRecord = all(tree, el => el.type === 'button' && text(el).includes(' · 已预测'))[0]
  assert(previousRecord); previousRecord.props.onClick(); render(); await settle()
  const confirmationCount = confirmations; confirmAllowed = false
  click('另开一次预测')
  assert.equal(confirmations, confirmationCount + 1, 'Exposure-only drafts require explicit discard confirmation')
  assert(text(tree).includes('最初的预测'), 'Cancel keeps the selected record and private draft')
  click('返回未保存的预测草稿')
  assert.equal(input('此前的原文接触').props.value, 'seen')
  fill('此前的原文接触', 'unsure'); confirmAllowed = true
  previousRecord.props.onClick(); render(); await settle()
  const feedback = () => all(tree, el => el.type === context.window.KGViewer.ModelFeedbackPanel)[0]
  const feedbackMemory = feedback().props.draftMemory
  assert(feedbackMemory && typeof feedbackMemory.get === 'function', 'Practice owns the fallback for feedback children')
  props.active = false; render(); assert.equal(tree, null)
  props.active = true; render(); await settle()
  assert.equal(feedback().props.draftMemory, feedbackMemory, 'Suspended feedback children resume the same private draft memory')
  click('展开原文对照'); await settle()
  assert(text(tree).includes('Lost reveal response'))
  assert(!text(tree).includes('2 km 对应 10 元'), 'failed reveal is not falsely acknowledged')
  click('展开原文对照'); await settle()
  assert(text(tree).includes('2 km 对应 10 元'))
  assert(text(tree).includes('不是标准答案'))
  assert(!closingWarned(), 'Revealing a saved prediction does not create a review draft')
  for (const [label, selected, original] of [['复盘判断', 'boundary', 'unsure'], ['模型练习自评', 'confident', 'uncertain']]) {
    fill(label, selected); assert(closingWarned(), label + ' alone must warn before closing')
    const count = confirmations; confirmAllowed = false; click('另开一次预测')
    assert.equal(confirmations, count + 1); assert.equal(input(label).props.value, selected, 'Cancelled discard preserves ' + label)
    confirmAllowed = true; fill(label, original); assert(!closingWarned(), 'Default review choices are not dirty')
  }
  fill('复盘判断', learnerReview.diagnosis); fill('保留或修改的理由', learnerReview.reflection); fill('下一步验证', learnerReview.nextCheck)
  storageFailure = true
  fill('保留或修改的理由', learnerReview.reflection + '\n未缓存的新复盘。')
  click('重新读取学习记录'); await settle()
  assert(text(tree).includes('草稿缓存不可用'), 'Uncached reviews remain visible after reading')
  assert.equal(input('保留或修改的理由').props.value, learnerReview.reflection + '\n未缓存的新复盘。')
  storageFailure = false; fill('保留或修改的理由', learnerReview.reflection)
  assert(!text(tree).includes('草稿缓存不可用'), 'A cached review no longer warns')
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
  storageFailure = true
  fill('保留或修改的理由', '响应丢失之后，另写一份尚未保存的复盘。')
  click('保存复盘'); await settle()
  assert(text(tree).includes('不能覆盖'))
  click('重新读取学习记录'); await settle()
  assert(text(tree).includes('保留的未保存复盘'))
  assert(text(tree).includes('草稿缓存不可用'), 'A conflicting uncached review must still warn beside the saved review')
  assert(text(tree).includes('响应丢失之后，另写一份尚未保存的复盘。'), 'conflict refresh must not silently discard the alternate draft')
  warned = false; events.get('beforeunload')({ preventDefault: () => { warned = true } })
  assert.equal(warned, true, 'closing the tab warns about the uncommitted alternate reflection')
  assert.equal(store.getDocumentRevision(document.documentId), 3)
  click('另开一次预测'); fill('此前的原文接触', 'seen')
  store.saveGraph({ ...document.graph, summary: 'fixture fourth revision' }, { sourceText: document.sourceText,
    sourceUnits: document.sourceUnits, expectedRevision: 3 })
  props.revision = 4; render(); await settle()
  assert.equal(input('此前的原文接触').props.value, 'seen', 'Source changes preserve exposure-only private drafts')
  assert(text(tree).includes('草稿基于第 3 版'))
  assert(button('保存预测').props.disabled, 'Exposure-only drafts must not silently adopt the new source revision')
  confirmAllowed = false; click('重开当前版本练习')
  assert.equal(input('此前的原文接触').props.value, 'seen', 'Cancelling a new-version restart retains the choice')
  confirmAllowed = true; click('重开当前版本练习')
  assert.equal(input('此前的原文接触').props.value, 'unsure')
  assert(!closingWarned(), 'Explicitly discarded drafts no longer warn')
  const latestPlan = await post({ action: 'plan', documentId: document.documentId, modelId: 'taxi', expectedRevision: 4 })
  for (const attemptId of ['hidden-review-a', 'hidden-review-b']) {
    await post({ action: 'save', documentId: document.documentId, modelId: 'taxi', expectedRevision: 4,
      taskId: latestPlan.tasks[0].id, attemptId, selfRating: 'uncertain', response: learnerResponse })
    await post({ action: 'reveal', documentId: document.documentId, modelId: 'taxi', attemptId, expectedVersion: 1 })
  }
  const beforeHiddenGraph = JSON.stringify(store.getDocument(document.documentId))
  const beforeHiddenLearning = JSON.stringify(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all())
  click('重新读取学习记录'); await settle()
  const openRecord = id => { const found = all(tree, el => el.type === 'button' && el.props.key === id)[0]; assert(found, id); found.props.onClick(); render() }
  storageFailure = true
  openRecord('hidden-review-a'); await settle(); fill('复盘判断', 'boundary')
  assert(closingWarned())
  openRecord('hidden-review-b'); await settle()
  assert.equal(input('复盘判断').props.value, 'unsure', 'Review choices never cross prediction identities')
  assert(closingWarned(), 'A hidden uncached review must remain protected before closing')
  openRecord('hidden-review-a'); await settle()
  assert.equal(input('复盘判断').props.value, 'boundary')
  fill('保留或修改的理由', '仍待核对的私人复盘\n只适用于上述条件。')
  openRecord('hidden-review-b'); await settle(); assert(closingWarned(), 'Hidden review text is also protected')
  openRecord('hidden-review-a'); await settle()
  assert.equal(input('保留或修改的理由').props.value, '仍待核对的私人复盘\n只适用于上述条件。')
  fill('复盘判断', 'unsure'); fill('保留或修改的理由', '')
  openRecord('hidden-review-b'); await settle(); assert(!closingWarned(), 'Restored defaults in all drafts do not warn')
  click('另开一次预测'); fill('此前的原文接触', 'seen')
  props.modelId = 'unknown'; render(); await settle()
  assert(closingWarned(), 'The window also protects a remembered prediction when another model is selected')
  props.modelId = 'taxi'; render(); await settle(); fill('此前的原文接触', 'unsure')
  assert(!closingWarned())
  assert.equal(JSON.stringify(store.getDocument(document.documentId)), beforeHiddenGraph)
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()), beforeHiddenLearning,
    'History navigation and close protection never save or revise personal records')
  openRecord('hidden-review-a'); await settle()
  fill('复盘判断', learnerReview.diagnosis); fill('保留或修改的理由', learnerReview.reflection); fill('下一步验证', learnerReview.nextCheck)
  loseReview = false; paused = true; click('保存复盘')
  const heldReview = deferred.splice(0).find(item => item.args.action === 'review')
  assert(heldReview); assert.equal(store.getLearningAttempt('hidden-review-a').review, null)
  paused = false; props.modelId = 'unknown'; render(); await settle()
  props.modelId = 'taxi'; render(); await settle(); openRecord('hidden-review-a'); await settle()
  const newerReflection = '旧请求尚未确认时新写的复盘\n边界仍需另行核对。'
  fill('保留或修改的理由', newerReflection)
  heldReview.resolve(); await settle()
  assert.equal(store.getLearningAttempt('hidden-review-a').review.content.reflection, learnerReview.reflection,
    'The delayed request saves only the original confirmed review')
  click('重新读取学习记录'); await settle()
  assert(text(tree).includes('保留的未保存复盘'))
  assert(text(tree).includes(newerReflection), 'A late review receipt must not clear a newer in-window draft')
  assert(input('保留或修改的理由').props.disabled, 'Saved review stays immutable beside the newer private draft')
  openRecord('hidden-review-b'); await settle(); storageFailure = false
  fill('复盘判断', learnerReview.diagnosis); fill('保留或修改的理由', learnerReview.reflection); fill('下一步验证', learnerReview.nextCheck)
  paused = true; click('保存复盘')
  const heldCachedReview = deferred.splice(0).find(item => item.args.action === 'review'); assert(heldCachedReview)
  const cachedReviewKey = [...storage.keys()].find(key => key.endsWith(':hidden-review-b')); assert(cachedReviewKey)
  const newerCachedReview = { ...JSON.parse(storage.get(cachedReviewKey)), reflection: '另一份较新的浏览器缓存复盘，仍未提交。' }
  storage.set(cachedReviewKey, JSON.stringify(newerCachedReview)); paused = false
  heldCachedReview.resolve(); await settle()
  assert.equal(JSON.parse(storage.get(cachedReviewKey)).reflection, newerCachedReview.reflection,
    'A receipt must also preserve a newer cached draft when memory still matches the submitted content')
  assert.equal(JSON.stringify(store.getDocument(document.documentId)), beforeHiddenGraph)
  click('另开一次预测')
  for (const [key, label] of Object.entries(fields)) fill(label, learnerResponse[key])
  loseSave = true; click('保存预测'); await settle()
  assert(text(tree).includes('Lost save response'))
  const recoverablePrediction = store.listLearningAttempts(document.documentId, 'taxi').find(item => !item.revealedAt)
  assert(recoverablePrediction)
  const normalRead = props.call; let releasePredictionRead
  props.call = (args, signal) => args.action === 'get' ? new Promise((resolve, reject) => {
    releasePredictionRead = () => normalRead(args, signal).then(resolve, reject)
  }) : normalRead(args, signal)
  render(); click('重新读取学习记录'); await settle(); assert(releasePredictionRead)
  storageFailure = true
  const newerPrediction = '重读尚未返回时新写的私人预测\n仍需核对边界和附加费用。'
  fill('我的预测', newerPrediction)
  releasePredictionRead(); await settle()
  assert.equal(input('我的预测').props.value, newerPrediction, 'A late save-recovery read must not clear a newer prediction draft')
  assert.equal(store.getLearningAttempt(recoverablePrediction.attemptId).response.prediction, learnerResponse.prediction)
  props.call = normalRead; render()
  storageFailure = false
  for (const [key, label] of Object.entries(fields)) fill(label, learnerResponse[key])
  loseSave = true; click('保存预测'); await settle()
  assert(text(tree).includes('Lost save response')); remount(); await settle()
  const recoveryReads = []
  props.call = (args, signal) => args.action === 'get' ? new Promise((resolve, reject) => {
    recoveryReads.push(() => normalRead(args, signal).then(resolve, reject))
  }) : normalRead(args, signal)
  render(); click('重新读取学习记录'); await settle()
  click('重新读取学习记录'); await settle(); assert.equal(recoveryReads.length, 2)
  recoveryReads[0](); await settle()
  assert.equal(input('我的预测').props.value, learnerResponse.prediction, 'Only the newest recovery read may acknowledge the submitted draft')
  recoveryReads[1](); await settle()
  assert(text(tree).includes('已确认此前保存的预测'), 'An unchanged cached draft still recovers after remount')
  props.call = normalRead; render(); click('另开一次预测')
  for (const [key, label] of Object.entries(fields)) fill(label, learnerResponse[key])
  loseSave = true; click('保存预测'); await settle()
  const selectedReads = []
  props.call = (args, signal) => args.action === 'get' ? new Promise((resolve, reject) => {
    selectedReads.push(() => normalRead(args, signal).then(resolve, reject))
  }) : normalRead(args, signal)
  render(); click('重新读取学习记录'); await settle()
  openRecord('hidden-review-a'); await settle(); assert.equal(selectedReads.length, 1)
  selectedReads[0](); await settle()
  assert(all(tree, el => el.type === 'button' && el.props.key === 'hidden-review-a')[0].props['aria-pressed'],
    'A recovery read must not replace a subsequently selected history record')
  click('返回未保存的预测草稿'); click('重新读取学习记录'); await settle()
  const submittedCacheKey = [...storage.keys()].find(key => {
    try { return key.startsWith('dsh-kg-model-learning:') && JSON.parse(storage.get(key)).submitted === true } catch { return false }
  }); assert(submittedCacheKey)
  const newerCachedPrediction = JSON.parse(storage.get(submittedCacheKey))
  newerCachedPrediction.fields.prediction = '另一份较新的缓存预测，尚未提交。'
  storage.set(submittedCacheKey, JSON.stringify(newerCachedPrediction))
  selectedReads[1](); await settle()
  assert.equal(JSON.parse(storage.get(submittedCacheKey)).fields.prediction, newerCachedPrediction.fields.prediction,
    'Recovery cannot delete a newer cached draft even if the rendered draft has not changed')
  props.call = normalRead; render()
  assert.equal(JSON.stringify(store.getDocument(document.documentId)), beforeHiddenGraph)
  console.log(JSON.stringify({ ok: true, actualSqliteHttpRoutes: true, concealedUntilSavedReveal: true,
    lostResponseRetries: true, scopeRaceFenced: true, draftsPreserved: true, oldSourceExplicit: true,
    oldVersionSaveAcknowledged: true, conflictingReflectionPreserved: true }))
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
