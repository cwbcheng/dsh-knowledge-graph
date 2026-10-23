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
let diagnosisTransform = null, storageFailure = false
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
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => {
    if (storageFailure) throw new Error('QuotaExceededError')
    storage.set(key, value)
  }, removeItem: key => storage.delete(key) } }
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
      diagnosisTransform?.(result, args)
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
  const memoryRows = JSON.stringify(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all())
  props.draftMemory = new Map(); storageFailure = true
  render(); await settle()
  fill('反馈来源', 'reflection')
  const privateFields = { '个人复盘内容': '未提交的私人复盘\n附加收费仍须核对。', '对照情境与前提（可选）': '仅限白天行程\n夜间费用未知。',
    '比较依据与局限': '尚无实际观察\n不能据此证明预测成立。' }
  for (const [label, value] of Object.entries(privateFields)) fill(label, value)
  fill('与最初预测的比较', 'inconclusive'); fill('结果诊断', 'condition')
  assert(text(tree).includes('结果草稿缓存不可用'))
  const quotaPrediction = props.prediction
  remount(); await settle()
  assert.equal(input('反馈来源').props.value, 'reflection', 'Uncached result source survives child remount inside the same practice owner')
  assert(text(tree).includes('结果草稿缓存不可用'), 'Restoring an uncached private draft must retain its cache warning')
  legacy = true; click('重新读取验证结果'); await settle()
  assert(text(tree).includes('结果草稿缓存不可用') && text(tree).includes('服务不支持保存'), 'Cache warnings and Host read errors must remain separate')
  legacy = false; click('重新读取验证结果'); await settle()
  assert(text(tree).includes('结果草稿缓存不可用') && !text(tree).includes('服务不支持保存'))
  for (const [label, value] of Object.entries(privateFields)) assert.equal(input(label).props.value, value)
  assert.equal(input('与最初预测的比较').props.value, 'inconclusive'); assert.equal(input('结果诊断').props.value, 'condition')
  props.prediction = store.getLearningAttempt('other-prediction'); remount(); await settle()
  assert.equal(input('反馈来源').props.value, 'observation'); assert.equal(input('实际观察结果').props.value, '', 'Result drafts cannot cross prediction identity')
  assert(!text(tree).includes('结果草稿缓存不可用'), 'An empty draft for another prediction must not inherit a cache warning')
  props.prediction = quotaPrediction; remount(); await settle()
  assert(text(tree).includes('结果草稿缓存不可用'))
  for (const [label, value] of Object.entries(privateFields)) assert.equal(input(label).props.value, value)
  const retained = props.draftMemory.get(draftKey())
  assert.equal(retained.expectedVersion, quotaPrediction.version); assert.equal(retained.expectedRevision, quotaPrediction.baseRevision)
  props.prediction = { ...quotaPrediction, version: quotaPrediction.version + 1 }; remount(); await settle()
  for (const [label, value] of Object.entries(privateFields)) assert.equal(input(label).props.value, value)
  assert(text(tree).includes('草稿对照的是预测版本 ' + quotaPrediction.version), 'Recovery must not silently adopt a new prediction version')
  assert(button('保存结果记录').props.disabled)
  assert.equal(props.draftMemory.get(draftKey()).expectedVersion, quotaPrediction.version)
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()), memoryRows, 'Memory recovery never commits result records')
  props.prediction = quotaPrediction; storageFailure = false; remount(); await settle()
  fill('个人复盘内容', privateFields['个人复盘内容'])
  assert(!text(tree).includes('结果草稿缓存不可用'), 'A successful cache write clears the warning for the current draft')
  assert.equal(JSON.parse(storage.get(draftKey())).response.content, privateFields['个人复盘内容'])
  storage.delete(draftKey()); delete props.draftMemory; remount(); await settle()
  render(); await settle()
  // Switching source must not silently discard an undated observation confirmation.
  const sourceSwitchRows = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  const originalConfirm = context.window.confirm, sourceSwitchPrompts = []
  let acceptSourceSwitch = false
  context.window.confirm = message => { sourceSwitchPrompts.push(message); return acceptSourceSwitch }
  const currentDraft = () => JSON.parse(storage.get(draftKey()))
  const checkObservation = checked => {
    const found = all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0]
    assert(found && !found.props.disabled); found.props.onChange({ target: { checked } }); render()
  }
  const resetSourceDraft = async () => { storage.delete(draftKey()); remount(); await settle(); sourceSwitchPrompts.length = 0 }
  for (const type of ['reference', 'derivation', 'ai_suggestion', 'reflection']) {
    await resetSourceDraft()
    fill('实际观察结果', '实付金额仍须核对附加收费。'); fill('观察时的实际输入与条件', '7 km；附加费尚未说明。')
    fill('与最初预测的比较', 'inconclusive'); fill('比较依据与局限', '额外收费不等于映射被反驳。'); fill('结果诊断', 'condition')
    checkObservation(true)
    const savedDraft = currentDraft()
    assert.equal(savedDraft.response.observedOn, ''); assert(savedDraft.response.observationConfirmed)
    assert(button('保存结果记录').props.disabled, 'undated observation remains incomplete')
    acceptSourceSwitch = false; fill('反馈来源', type)
    assert.equal(sourceSwitchPrompts.length, 1, 'undated confirmation requires source-clear consent: ' + type)
    assert.equal(sourceSwitchPrompts[0], '更换来源类型会清除观察日期、观察确认和引用信息；结果内容仍保留。继续？')
    assert.deepEqual(currentDraft(), savedDraft, 'decline preserves the complete draft and request identity')
    assert.equal(input('反馈来源').props.value, 'observation')
    remount(); await settle(); assert.deepEqual(currentDraft(), savedDraft, 'declined draft survives remount')
    props.prediction = store.getLearningAttempt('other-prediction'); render(); await settle()
    assert.equal(input('实际观察结果').props.value, '')
    props.prediction = store.getLearningAttempt('prediction'); render(); await settle()
    assert.deepEqual(currentDraft(), savedDraft, 'each prediction retains its own confirmation and conditions')
    acceptSourceSwitch = true; fill('反馈来源', type)
    const switched = currentDraft()
    assert.equal(sourceSwitchPrompts.length, 2); assert.notEqual(switched.attemptId, savedDraft.attemptId)
    assert.deepEqual(switched, { ...savedDraft, attemptId: switched.attemptId, response: { ...savedDraft.response, type,
      observedOn: '', observedTimeZone: '', observationConfirmed: false, sourceName: '', sourceUrl: '', sourceLocator: '', reference: null } },
      'accept clears only source fields and preserves content, conditions, comparison and version fences')
  }
  await resetSourceDraft(); acceptSourceSwitch = false
  checkObservation(true)
  const confirmationOnly = currentDraft(); fill('反馈来源', 'reflection')
  assert.equal(sourceSwitchPrompts.length, 1, 'confirmation alone requires source-clear consent')
  assert.deepEqual(currentDraft(), confirmationOnly)
  await resetSourceDraft()
  fill('反馈来源', 'reflection'); assert.equal(sourceSwitchPrompts.length, 0, 'default time zone is not entered source information')
  fill('反馈来源', 'observation'); fill('实际观察结果', '只有内容，不包含要清除的观察确认。')
  fill('反馈来源', 'reflection'); assert.equal(sourceSwitchPrompts.length, 0, 'retained content alone does not trigger source-clear consent')
  fill('反馈来源', 'observation'); checkObservation(true); checkObservation(false)
  fill('反馈来源', 'reflection'); assert.equal(sourceSwitchPrompts.length, 0, 'an unchecked confirmation needs no source-clear consent')
  for (const [label, value] of [['实际发生日期', feedbackResponse().observedOn], ['观察凭证名称（可选）', '账单'],
    ['观察凭证位置（可选）', '第 1 项'], ['来源链接（可选）', 'https://example.test/receipt']]) {
    await resetSourceDraft(); fill('实际观察结果', '原来源信息应保留。'); fill(label, value)
    const savedDraft = currentDraft(); fill('反馈来源', 'reflection')
    assert.equal(sourceSwitchPrompts.length, 1, label + ' retains existing clear confirmation')
    assert.deepEqual(currentDraft(), savedDraft, 'decline retains existing source information: ' + label)
  }
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all(), sourceSwitchRows, 'source switching never saves or reveals a prediction')
  context.window.confirm = originalConfirm
  await resetSourceDraft()
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
  assert(text(tree).includes('服务不支持保存'))
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
  // Stored feedback must carry a known diagnosis before it can be opened or used as a correction basis.
  const originalPrediction = props.prediction, originalDraft = storage.get(draftKey()), diagnosisRequestsStart = requests.length
  const diagnosisLabels = { input: '输入判别需核对', mapping: '映射或推理需核对', condition: '条件漏判或边界需核对', calculation: '计算需核对',
    output: '输出判别需核对', evidence: '依据不足', no_change: '暂未发现需修改之处', unsure: '仍无法判断' }
  const sourceTypes = ['observation', 'reference', 'derivation', 'ai_suggestion', 'reflection']
  for (const [index, diagnosis] of Object.keys(diagnosisLabels).entries()) {
    const result = await post({ ...base, action: 'save-result', predictionId: 'other-prediction', expectedRevision: 1, expectedVersion: 1,
      attemptId: 'diagnosis-' + diagnosis, response: { ...feedbackResponse(sourceTypes[index % sourceTypes.length]), diagnosis } })
    assert(!result.error); assert.equal(result.attempt.response.diagnosis, diagnosis)
  }
  const diagnosisRows = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  props.prediction = store.getLearningAttempt('other-prediction'); render(); await settle()
  const storedDiagnoses = store.listModelFeedback(document.documentId, 'taxi', 'other-prediction').attempts
  let diagnosisFault = null
  diagnosisTransform = (result, args) => {
    if (!diagnosisFault || args.action !== diagnosisFault.action ||
        args.action === 'results' && args.predictionId !== 'other-prediction' ||
        diagnosisFault.attemptId && args.attemptId !== diagnosisFault.attemptId) return
    const item = args.action === 'results' ? result.attempts[0] : result.attempt
    assert(item)
    if (diagnosisFault.value === undefined) delete item.response.diagnosis
    else item.response.diagnosis = diagnosisFault.value
  }
  const invalidDiagnoses = [['missing', undefined], ['null', null], ['empty', ''], ['unknown', 'wrong-diagnosis'], ['boundary', 'boundary'],
    ['prototype-function', 'toString'], ['prototype-constructor', 'constructor'], ['prototype-object', '__proto__'], ['number', 7], ['boolean', true],
    ['object', {}], ['array', []], ['coercible-array', ['unsure']]]
  for (const [name, value] of invalidDiagnoses) {
    diagnosisFault = { action: 'results', value }; remount(); await settle()
    assert(all(tree, el => el.props.role === 'alert').length, 'reject incomplete or invalid stored diagnosis: ' + name)
    assert(text(tree).includes('请重新读取验证结果')); assert(text(tree).includes('草稿保留'))
    assert(!text(tree).includes('自述诊断：undefined'))
    assert(button('保存结果记录').props.disabled)
    assert(!all(tree, el => el.type === 'button' && text(el) === '追加结果更正').length)
    diagnosisFault = null; click('重新读取验证结果'); await settle()
    assert(!all(tree, el => el.props.role === 'alert').length); assert(!button('追加结果更正').props.disabled)
  }
  for (const [diagnosis, label] of Object.entries(diagnosisLabels)) {
    const record = storedDiagnoses.find(item => item.response.diagnosis === diagnosis)
    const entry = all(tree, el => el.type === 'button' && el.props.key === record.attemptId)[0]
    assert(entry && !entry.props.disabled); entry.props.onClick(); render()
    assert(text(tree).includes('自述诊断：' + label)); assert(text(tree).includes(record.response.context)); assert(text(tree).includes(record.response.rationale))
    assert(text(tree).includes('未独立核验'))
  }
  click('追加结果更正'); fill('结果更正理由', '条件和来源仍须核对；保留原记录。')
  const correctionDraft = storage.get(draftKey()), correctionParent = JSON.parse(correctionDraft).response.parentResultId
  for (const [name, value] of invalidDiagnoses) {
    diagnosisFault = { action: 'results', value }; click('重新读取验证结果'); await settle()
    assert(all(tree, el => el.props.role === 'alert').length, name); assert(button('保存结果记录').props.disabled)
    assert.equal(storage.get(draftKey()), correctionDraft, 'malformed reread preserves the entire correction draft: ' + name)
    diagnosisFault = null; click('重新读取验证结果'); await settle()
    assert(!all(tree, el => el.props.role === 'alert').length); assert.equal(storage.get(draftKey()), correctionDraft)
    assert(!button('保存结果记录').props.disabled)
  }
  diagnosisFault = { action: 'get', attemptId: correctionParent, value: undefined }
  click('重新读取验证结果'); await settle()
  assert(text(tree).includes('更正基准的身份不一致')); assert(button('保存结果记录').props.disabled)
  assert.equal(storage.get(draftKey()), correctionDraft)
  diagnosisFault = null; click('重新读取验证结果'); await settle(); assert.equal(storage.get(draftKey()), correctionDraft)
  click('放弃结果草稿')
  diagnosisFault = { action: 'get', attemptId: 'diagnosis-input', value: undefined }
  props.focusRequest = { resultId: 'diagnosis-input', nonce: 'invalid-diagnosis-focus' }; render(); await settle()
  assert(text(tree).includes('所选结果的预测身份或更正链不一致')); assert(button('追加结果更正').props.disabled)
  assert(text(tree).includes('自述诊断：仍无法判断'), 'failed focus retains only the previously accepted record')
  diagnosisFault = null; click('重新读取验证结果'); await settle()
  assert(text(tree).includes('自述诊断：输入判别需核对')); assert(!button('追加结果更正').props.disabled)
  delete props.focusRequest
  const savedCondition = storedDiagnoses.find(item => item.attemptId === 'diagnosis-condition')
  const pendingDiagnosis = { attemptId: savedCondition.attemptId, expectedVersion: 1, expectedRevision: 1, started: true,
    submitted: true, sourceMode: 'external', response: savedCondition.response }
  storage.set(draftKey(), JSON.stringify(pendingDiagnosis))
  diagnosisFault = { action: 'get', attemptId: savedCondition.attemptId, value: undefined }; remount(); await settle()
  assert(text(tree).includes('此前保存的结果与草稿身份或内容不一致'))
  assert.equal(storage.get(draftKey()), JSON.stringify(pendingDiagnosis), 'an invalid receipt cannot clear the submitted draft')
  diagnosisFault = null; click('重新读取验证结果'); await settle()
  assert(text(tree).includes('已确认此前保存的结果；未重复写入。')); assert(!storage.has(draftKey()))
  assert(text(tree).includes('自述诊断：条件漏判或边界需核对'))
  paused = true; diagnosisFault = { action: 'results', value: undefined }
  click('重新读取验证结果'); const lateDiagnosisReads = deferred.splice(0)
  props.prediction = originalPrediction; render(); const currentDiagnosisReads = deferred.splice(0)
  currentDiagnosisReads.forEach(item => item.resolve()); await settle()
  lateDiagnosisReads.forEach(item => item.resolve()); await settle()
  assert(!all(tree, el => el.props.role === 'alert').length, 'late malformed reads cannot affect another prediction')
  assert.equal(storage.get(draftKey()), originalDraft, 'another prediction retains its exact private draft')
  paused = false; diagnosisFault = null; diagnosisTransform = null
  assert(requests.slice(diagnosisRequestsStart).every(item => ['results', 'get'].includes(item.args.action)), 'diagnosis reads and recovery never save or reveal')
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all(), diagnosisRows)
  assert.deepEqual(store.getDocument(document.documentId).nodes, before.nodes)
  assert.deepEqual(store.getDocument(document.documentId).edges, before.edges)
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore)
  assert.equal(store.getLearningAttempt('prediction').version, 2, 'only explicit reveal changed prediction version')
  // A late receipt must respect newer in-window edits even if storage still
  // contains the older submitted request after subsequent quota failures.
  props.prediction = store.getLearningAttempt('prediction'); delete props.focusRequest
  props.draftMemory = new Map(); storage.delete(draftKey()); remount(); await settle()
  click('记录新结果'); fill('反馈来源', 'reflection'); fill('个人复盘内容', '旧请求尚未发送。')
  paused = true; click('保存结果记录'); const memoryWrite = deferred.splice(0)
  const staleStoredId = JSON.parse(storage.get(draftKey())).attemptId
  storageFailure = true; remount(); const memoryReads = deferred.splice(0)
  memoryReads.forEach(item => item.resolve()); await settle()
  assert(text(tree).includes('此前结果未保存'))
  fill('个人复盘内容', '缓存失效后新写的私人草稿\n不能被旧回应删除。')
  const newerMemory = props.draftMemory.get(draftKey())
  assert.notEqual(newerMemory.attemptId, staleStoredId)
  assert.equal(JSON.parse(storage.get(draftKey())).attemptId, staleStoredId, 'Quota failure leaves the older request in storage')
  memoryWrite.forEach(item => item.resolve()); await settle()
  assert.equal(props.draftMemory.get(draftKey())?.attemptId, newerMemory.attemptId, 'Late receipts cannot clear newer memory using stale browser storage')
  assert.equal(input('个人复盘内容').props.value, newerMemory.response.content)
  paused = false; storageFailure = false; delete props.draftMemory
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
    feedbackDiagnosisAdmission: { invalidValues: 13, validDiagnoses: 8, completeDraftPreserved: true, focusedParentAndReceiptGuarded: true, lateScopeReadIgnored: true },
    correctionConflictDraftPreserved: true, oldPredictionVersionExplicit: true, oldCitationBlocked: true, scopeAndUnmountRaces: true, mixedHostBlocked: true,
    undatedObservationSourceConsent: true, sourceSwitchDraftAndConditionsPreserved: true, emptySourceNoPrompt: true }))
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
