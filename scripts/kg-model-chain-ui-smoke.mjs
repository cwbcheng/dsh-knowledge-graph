import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelChainFixture, modelChainDraft } from './kg-model-chain-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelChainFixture() })
const { document, store, post } = harness
let owner = { slots: [], effects: [] }, cursor = 0, tree, props
const updates = [], storage = new Map(), requests = [], deferred = [], events = new Map()
let paused = false, foreign = false, oldHost = false, malformed = false, transportFailure = false, storageFailure = false, confirm = true, failCatalogOnce = false, failPairOnce = false
const slot = init => { const index = cursor++; return owner.slots[index] ||= init() }
const React = {
  createElement: (type, properties, ...children) => ({ type, props: { ...properties, children } }),
  useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect(fn, deps) { const state = slot(() => ({}));
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    } },
}
const context = { window: { React, confirm: () => confirm, addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) }, console, AbortController, setTimeout, clearTimeout,
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => { if (storageFailure) throw new Error('Quota'); storage.set(key, value) } } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
let Component = context.window.KGViewer.ConnectionModelChain
const load = (args, signal) => {
  requests.push({ args, signal })
  const run = async () => {
    if (failCatalogOnce && !args.modelId) { failCatalogOnce = false; throw new Error('Chain catalogue unavailable') }
    if (failPairOnce && args.compareModelId && !args.chainDraft) { failPairOnce = false; throw new Error('Chain models unavailable') }
    if (transportFailure && args.chainDraft) throw new Error('Chain transport failed')
    const value = await post(args, 'connection-models')
    if (foreign) return { ...value, documentId: 'foreign-document' }
    if (oldHost) return { ...value, modelChainVersion: undefined }
    if (malformed && args.chainDraft) return { ...value, chain: { ...value.chain, issues: undefined } }
    return value
  }
  return paused ? new Promise((resolve, reject) => deferred.push({ args, signal, resolve: () => run().then(resolve, reject) })) : run()
}
function render() {
  for (let count = 0; count < 30; count++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0
    tree = Component(props)
    for (const node of all(tree, el => el.props['aria-label'] === '第 2 步模型候选' && el.props.ref)) {
      node.props.ref.current = owner.focusNode ||= { scrollTop: 80, focus: () => { owner.focused = (owner.focused || 0) + 1 } }
    }
    for (const node of all(tree, el => el.props['aria-label'] === '搜索第 2 步模型' && el.props.ref)) {
      node.props.ref.current = { focus: () => { owner.searchFocused = (owner.searchFocused || 0) + 1 } }
    }
    for (const node of all(tree, el => el.props['aria-label'] === '两步模型读取状态' && el.props.ref)) {
      node.props.ref.current = { focus: () => { owner.pairFocused = (owner.pairFocused || 0) + 1 } }
    }
    owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('Component update loop')
}
async function settle() { for (let count = 0; count < 8; count++) { await new Promise(resolve => setImmediate(resolve)); render() } }
function beforeEffects() { updates.splice(0).forEach(fn => fn()); cursor = 0; tree = Component(props) }
const text = el => Array.isArray(el) ? el.map(text).join('') : el && typeof el === 'object' ? text(el.props?.children) : String(el ?? '')
const all = (el, predicate) => Array.isArray(el) ? el.flatMap(child => all(child, predicate)) : !el || typeof el !== 'object' ? [] :
  [...(predicate(el) ? [el] : []), ...all(el.props?.children, predicate)]
const button = label => { const found = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0]; assert(found, 'Missing button: ' + label); return found }
const click = label => { const found = button(label); assert(!found.props.disabled, label); found.props.onClick(); render() }
const candidates = () => { const node = all(tree, el => el.props['aria-label'] === '第 2 步模型候选')[0]; assert(node, 'Candidate region stays mounted during reads'); return node }
const input = label => { const found = all(tree, el => ['textarea', 'select', 'input'].includes(el.type) && el.props['aria-label'] === label)[0]; assert(found, 'Missing field: ' + label); return found }
const fill = (label, value) => { input(label).props.onChange({ target: { value } }); render() }
const closingWarned = () => { const event = { prevented: false, preventDefault() { this.prevented = true } }; events.get('beforeunload')?.(event); return event.prevented }
const choose = id => { const found = all(tree, el => el.type === 'button' && text(el).includes(id + ' · '))[0]; assert(found, 'Missing peer: ' + id); found.props.onClick(); render() }
const mount = next => {
  owner.slots.forEach(state => state.cleanup?.()); updates.length = 0; owner = { slots: [], effects: [] }; props = { ...next }; render()
}
const basicProps = { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true, load }
const seed = modelChainDraft()
const storedKey = 'dsh-kg-model-chain:' + JSON.stringify([document.documentId, 'taxi'])
const exchange = (peerId = 'budget-model', revision = 1) => ({ format: 'dsh.model-chain-draft', version: 1,
  documentId: document.documentId, revision, modelIds: ['taxi', peerId], draft: modelChainDraft(peerId) })
const importFile = (value, overrides = {}) => {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const target = { value: 'same-file.json', files: [{ size: Buffer.byteLength(raw), text: async () => raw, ...overrides }] }
  const pending = input('选择推测草稿文件').props.onChange({ target }); render()
  assert.equal(target.value, '', 'the same file can be retried after an error or cancellation')
  return pending
}
function fillDraft() {
  fill('具体情境', seed.scenario); fill('推测目标', seed.goal)
  fill('第 1 步分支', 'extra'); fill('第 2 步分支', 'subtract')
  fill('第 1 步 · 行驶距离已知值或状态', '5'); fill('第 1 步 · 行驶距离输入依据', '本次里程记录')
  fill('第 1 步 · 基础费用预测', '14')
  fill('第 2 步 · 行程基础费用输入来源', 'link'); fill('第 2 步 · 行程基础费用承接槽位', 'fare-slot')
  for (const label of ['含义核对', '单位口径核对', '时间状态核对', '对象范围核对']) fill('第 2 步 · 行程基础费用' + label, '同一次行程的自述核对，未独立验证')
  fill('第 2 步 · 行程预算已知值或状态', '20'); fill('第 2 步 · 行程预算输入依据', '这次行程的个人预算')
  fill('第 2 步 · 剩余预算预测', '6')
  for (const index of [1, 2]) {
    fill('第 ' + index + ' 步适用条件与边界依据', '假定同一次行程没有附加支出')
    fill('第 ' + index + ' 步应用过程', '依据所选文字规律，由我填写预测')
  }
}
try {
  const graphBefore = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
  mount(basicProps); await settle()
  assert.equal(requests.filter(item => item.args.compareModelId).length, 0, 'no automatic second model selection')
  assert.equal(requests.filter(item => item.args.chainDraft).length, 0)
  assert(button('检查推测缺口').props.disabled)
  assert(button('导出推测草稿').props.disabled)
  assert(button('导入推测草稿'))
  assert(!text(tree).includes('已保留的两步草稿'), 'an unselected peer is not presented as a second model')
  assert(!closingWarned(), 'An untouched chain cannot cause a close prompt')
  choose('budget-model'); await settle()
  assert(!closingWarned(), 'Browsing a model pair alone cannot cause a close prompt')
  fill('具体情境', '  '); assert(!closingWarned()); fill('具体情境', '')
  fill('第 1 步分支', 'extra'); assert(closingWarned(), 'A branch-only private choice needs close protection')
  fill('第 1 步分支', ''); assert(!closingWarned(), 'Returning a branch to its default removes the prompt')
  fill('第 2 步 · 行程基础费用输入来源', 'link'); assert(closingWarned(), 'A source-only private choice needs close protection')
  fill('第 2 步 · 行程基础费用输入来源', 'known'); assert(!closingWarned())
  fill('第 1 步 · 行驶距离输入依据', '尚待核对的私人依据'); assert(closingWarned())
  fill('第 1 步 · 行驶距离输入依据', ''); assert(!closingWarned())
  fill('第 1 步 · 基础费用预测', '0'); assert(closingWarned(), 'Zero is a private output value')
  fill('第 1 步 · 基础费用预测', ''); assert(!closingWarned())
  fill('第 2 步适用条件与边界依据', '未提交的私人条件')
  const closeCache = JSON.stringify([...storage]), closeReads = requests.length
  assert(closingWarned()); assert.equal(JSON.stringify([...storage]), closeCache); assert.equal(requests.length, closeReads)
  props.active = false; render(); assert.equal(tree, null); assert(closingWarned(), 'Hidden task drafts stay protected')
  props.active = true; render(); await settle()
  props.modelId = 'budget-model'; render(); await settle(); assert.equal(input('具体情境').props.value, '')
  assert(closingWarned(), 'A private draft in another model stays protected')
  props.modelId = 'taxi'; render(); await settle(); fill('第 2 步适用条件与边界依据', '')
  assert(!closingWarned(), 'Clearing the last private field removes protection, including its memory copy')
  assert(!button('导出推测草稿').props.disabled, 'an unchecked, incomplete draft can be backed up')
  click('检查推测缺口'); await settle()
  assert(text(tree).includes('停在第 1 步'))
  fillDraft()
  const savedBeforeReload = storage.get(storedKey)
  const assertPreservedDraft = () => {
    const saved = all(tree, el => el.props['aria-label'] === '已保留的两步草稿')[0]
    assert(saved, 'pending and failed model reads must leave the private steps readable')
    for (const step of JSON.parse(savedBeforeReload).draft.steps) {
      for (const value of [step.modelId, step.branchId, step.conditions, step.reasoning,
        ...step.inputs.flatMap(item => Object.values(item).filter(value => value && !['known', 'link'].includes(value))),
        ...step.outputs.flatMap(item => Object.values(item))]) assert(text(saved).includes(value), 'preserved draft field: ' + value)
    }
    assert.equal(all(saved, el => ['input', 'select', 'textarea', 'button'].includes(el.type)).length, 0, 'unloaded model slots cannot be edited or used to locate current source')
    assert.equal(all(tree, el => el.props['aria-label'] === '第 1 步分支').length, 0)
    assert(button('检查推测缺口').props.disabled)
    assert(!button('导出推测草稿').props.disabled)
    assert.equal(storage.get(storedKey), savedBeforeReload, 'read failures do not rewrite any private draft or its source revision')
    assert(text(tree).includes('草稿来源版本 1 · 请求模型版本 1'))
    assert(!text(saved).includes('抽取状态：'), 'cached learner text must not masquerade as validated current model facts')
  }
  paused = true
  button('重新读取两步推测模型').props.onClick(); beforeEffects()
  assertPreservedDraft()
  render()
  assertPreservedDraft()
  const pendingModels = deferred.splice(0)
  assert.equal(pendingModels.length, 2)
  failPairOnce = true
  pendingModels.forEach(item => item.resolve()); paused = false; await settle()
  assert(text(tree).includes('Chain models unavailable'))
  assertPreservedDraft()
  const candidatePageBeforeRetry = JSON.stringify(candidates().props.children)
  const readsBeforePairRetry = requests.length
  paused = true
  const retryModels = button('重试读取两步模型').props.onClick
  retryModels(); retryModels(); beforeEffects()
  assert.equal(owner.pairFocused, 1, 'one explicit retry focuses its persistent status region once')
  assert.equal(all(tree, el => el.props['aria-label'] === '两步模型读取状态')[0].props.tabIndex, -1)
  assert(!text(tree).includes('Chain models unavailable'), 'the previous error is hidden on the first render of a new read')
  render(); assertPreservedDraft()
  assert.equal(deferred.length, 1, 'model-only retry never rereads the candidate page')
  assert.equal(requests.length, readsBeforePairRetry + 1, 'repeated callbacks enqueue one read')
  assert.equal(JSON.stringify(candidates().props.children), candidatePageBeforeRetry)
  assert.equal(requests.at(-1).args.compareModelId, 'budget-model')
  failPairOnce = true
  deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert(text(tree).includes('两步模型读取失败：Chain models unavailable'))
  assertPreservedDraft()
  paused = true; click('重试读取两步模型')
  assert.equal(deferred.length, 1, 'a new failure can be retried again')
  assert.equal(owner.pairFocused, 2)
  const focusBeforeResponse = owner.pairFocused
  deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert.equal(owner.pairFocused, focusBeforeResponse, 'asynchronous model replies do not move focus')
  assert.equal(JSON.stringify(candidates().props.children), candidatePageBeforeRetry)
  assert(!all(tree, el => el.props['aria-label'] === '已保留的两步草稿').length)
  assert.equal(input('第 2 步 · 行程基础费用承接槽位').props.value, 'fare-slot')
  assert.equal(input('第 1 步 · 基础费用预测').props.value, '14')
  assert.equal(storage.get(storedKey), savedBeforeReload)
  assert(text(tree).includes('草稿来源版本 1 · 已读取模型版本 1'))
  const checkButton = button('检查推测缺口'); checkButton.props.onClick(); checkButton.props.onClick(); render(); await settle()
  assert.equal(requests.filter(item => item.args.chainDraft).length, 2, 'single-flight check despite double click')
  assert(text(tree).includes('草稿字段已齐备'))
  assert(text(tree).includes('fare-slot → expense：14'))
  assert(text(tree).includes('尚未独立核验'))
  assert(button('导出推测草稿'))
  const cachedBeforePaging = storage.get(storedKey), readsBeforePaging = requests.length
  const oldNextPage = button('下一页第 2 步模型').props.onClick
  paused = true
  oldNextPage(); oldNextPage(); render()
  assert.equal(owner.focused, 1, 'one explicit page turn moves focus once, before the response')
  assert.equal(candidates().props.tabIndex, -1)
  assert.equal(candidates().props['aria-busy'], true)
  assert.equal(owner.focusNode.scrollTop, 0)
  assert(button('上一页第 2 步模型').props.disabled && button('下一页第 2 步模型').props.disabled)
  const pendingPage = deferred.splice(0)
  assert.equal(pendingPage.length, 1, 'double activation starts one catalogue read')
  assert.equal(pendingPage[0].args.offset, 20)
  assert.equal(pendingPage[0].args.chainOf, 'taxi')
  assert.equal(input('第 2 步 · 行程基础费用承接槽位').props.value, 'fare-slot')
  assert(text(tree).includes('fare-slot → expense：14'), 'the current private check remains visible while paging')
  pendingPage[0].resolve(); paused = false; await settle()
  assert.equal(owner.focused, 1, 'a catalogue response does not move focus again')
  assert.equal(candidates().props['aria-busy'], false)
  oldNextPage(); render(); await settle()
  assert.equal(requests.length, readsBeforePaging + 1, 'an old page callback cannot navigate again')
  click('上一页第 2 步模型'); await settle()
  failCatalogOnce = true; click('下一页第 2 步模型'); await settle()
  assert(text(tree).includes('Chain catalogue unavailable'))
  assert(candidates())
  assert(!button('上一页第 2 步模型').props.disabled, 'a failed page retains the previous-page recovery action')
  const retry = button('重试读取第 2 步候选').props.onClick
  const failedRead = requests.at(-1).args
  paused = true
  retry(); retry(); render()
  const pendingRetry = deferred.splice(0)
  assert.equal(pendingRetry.length, 1, 'double activation retries only the failed catalogue request')
  assert.deepEqual(pendingRetry[0].args, failedRead, 'retry preserves the query, filter, page, model and revision')
  assert.equal(owner.searchFocused, 1, 'retry moves focus to the persistent search field before removing its button')
  assert(candidates().props['aria-busy'])
  assert(!text(tree).includes('Chain catalogue unavailable'))
  assert(text(tree).includes('草稿字段已齐备') && text(tree).includes('fare-slot → expense：14'), 'catalogue retry leaves the selected pair and private check mounted')
  assert.equal(storage.get(storedKey), cachedBeforePaging)
  pendingRetry[0].resolve(); paused = false; await settle()
  assert.equal(owner.searchFocused, 1, 'a successful retry does not steal focus asynchronously')
  const afterRetryReads = requests.length
  retry(); render(); await settle()
  assert.equal(requests.length, afterRetryReads, 'the retired retry callback cannot start another read')
  click('上一页第 2 步模型'); await settle()
  assert(!text(tree).includes('Chain catalogue unavailable'))
  const pageReads = requests.slice(readsBeforePaging)
  assert.deepEqual(pageReads.map(item => item.args.offset), [20, 0, 20, 20, 0])
  assert(pageReads.every(item => !item.args.modelId && !item.args.chainDraft && item.args.query === '' && item.args.chainOf === 'taxi'
    && item.args.excludeModelId === 'taxi' && item.args.expectedRevision === 1), 'paging only reads the current filtered catalogue')
  assert.equal(storage.get(storedKey), cachedBeforePaging, 'paging preserves all private draft fields and their cache')
  assert(text(tree).includes('草稿字段已齐备') && text(tree).includes('fare-slot → expense：14'))
  const beforeQueryPage = button('下一页第 2 步模型').props.onClick, beforeQueryReads = requests.length, beforeQueryFocus = owner.focused
  const oldCandidate = all(candidates(), el => el.type === 'button' && text(el).includes('chain-peer-0 · '))[0]
  assert(oldCandidate)
  fill('搜索第 2 步模型', '预算')
  assert.equal(all(candidates(), el => el.type === 'button').length, 0, 'Pending chain search hides the old selectable candidates')
  assert(!all(tree, el => el.type === 'p' && /^候选 [0-9]/.test(text(el))).length, 'Old counts do not describe the new chain query')
  assert.equal(candidates().props['aria-busy'], true)
  assert(text(tree).includes('正在更新第 2 步搜索'))
  oldCandidate.props.onClick()
  assert.equal(updates.length, 0, 'A retired candidate cannot clear the second-step private draft')
  assert.equal(storage.get(storedKey), cachedBeforePaging)
  assert(text(tree).includes('草稿字段已齐备') && text(tree).includes('fare-slot → expense：14'))
  assert(button('下一页第 2 步模型').props.disabled, 'pending search cannot paginate old results')
  beforeQueryPage(); render()
  assert.equal(requests.length, beforeQueryReads)
  assert.equal(owner.focused, beforeQueryFocus, 'a stale query callback cannot steal focus')
  const pairReadsBeforeSearch = requests.filter(item => item.args.compareModelId).length
  fill('搜索第 2 步模型', '没有这个模型-零结果'); await new Promise(resolve => setTimeout(resolve, 240)); await settle()
  assert(text(tree).includes('候选 0 个')); assert(button('查看全部第 2 步模型'))
  fill('搜索第 2 步模型', '预算')
  assert(!text(tree).includes('候选 0 个'), 'Pending keyword cannot reuse the old zero count')
  assert(!all(tree, el => el.type === 'button' && text(el) === '查看全部第 2 步模型').length)
  paused = true; await new Promise(resolve => setTimeout(resolve, 240)); await settle()
  assert.equal(deferred.length, 1); assert.equal(deferred[0].args.query, '预算')
  assert.equal(candidates().props['aria-busy'], true)
  assert.equal(all(candidates(), el => el.type === 'button').length, 0)
  assert.equal(storage.get(storedKey), cachedBeforePaging)
  assert(text(tree).includes('草稿字段已齐备') && text(tree).includes('fare-slot → expense：14'))
  deferred.shift().resolve(); paused = false; await settle()
  assert.equal(candidates().props['aria-busy'], false)
  assert(all(candidates(), el => el.type === 'button').length)
  assert.equal(requests.filter(item => item.args.compareModelId).length, pairReadsBeforeSearch, 'Search does not reread models or recheck the private chain')
  assert.equal(storage.get(storedKey), cachedBeforePaging)
  fill('搜索第 2 步模型', ''); await new Promise(resolve => setTimeout(resolve, 260)); await settle()
  all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } }); render(); await settle()
  fill('搜索第 2 步模型', '预算'); await new Promise(resolve => setTimeout(resolve, 260)); await settle()
  failCatalogOnce = true; click('下一页第 2 步模型'); await settle()
  const filteredFailure = requests.at(-1).args
  assert.equal(filteredFailure.query, '预算'); assert.equal(filteredFailure.chainOf, ''); assert.equal(filteredFailure.offset, 20)
  failCatalogOnce = true; click('重试读取第 2 步候选'); await settle()
  assert(text(tree).includes('Chain catalogue unavailable'), 'a second failure offers another scoped retry')
  assert.deepEqual(requests.at(-1).args, filteredFailure)
  assert(text(tree).includes('草稿字段已齐备'))
  paused = true
  click('检查推测缺口')
  const pendingCheckDuringRetry = deferred.shift()
  click('重试读取第 2 步候选')
  const pendingFilteredRetry = deferred.shift()
  assert.equal(deferred.length, 0, 'retry does not reload the selected pair')
  assert.deepEqual(pendingFilteredRetry.args, filteredFailure)
  assert(!pendingCheckDuringRetry.signal.aborted, 'retry cannot cancel an independently requested private check')
  pendingCheckDuringRetry.resolve(); await settle()
  assert(text(tree).includes('草稿字段已齐备'))
  pendingFilteredRetry.resolve(); paused = false; await settle()
  assert(text(tree).includes('fare-slot → expense：14'))
  assert.equal(storage.get(storedKey), cachedBeforePaging)
  all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } }); render(); await settle()
  fill('搜索第 2 步模型', ''); await new Promise(resolve => setTimeout(resolve, 260)); await settle()
  assert.deepEqual(store.getDocument(document.documentId), graphBefore, 'candidate navigation leaves the canonical graph unchanged')
  const checksBeforeImport = requests.filter(item => item.args.chainDraft).length
  const cachedBeforeImport = storage.get(storedKey)
  const file = exchange(); file.draft.goal = '从文件恢复的目标'
  file.draft.scenario = '<img src=x onerror=alert(1)>'
  const legacy = { ...file, format: undefined, basis: 'recorded_fields_and_learner_reports_not_semantic_validity', persisted: false,
    status: 'worksheet_complete', firstStop: null, issues: [], steps: [{ model: { nodeId: 'forged' } }] }
  await importFile(legacy); await settle()
  assert(text(tree).includes('待导入草稿'))
  assert(!all(tree, el => el.type === 'img' || el.props?.dangerouslySetInnerHTML).length, 'file text is not mounted as HTML')
  assert.equal(storage.get(storedKey), cachedBeforeImport, 'preview leaves current text and cache intact')
  assert.equal(input('推测目标').props.value, seed.goal)
  click('取消导入'); assert.equal(storage.get(storedKey), cachedBeforeImport)
  await importFile(legacy); await settle()
  confirm = false; click('确认替换为导入草稿')
  assert.equal(storage.get(storedKey), cachedBeforeImport)
  confirm = true; click('确认替换为导入草稿'); await settle()
  assert.equal(input('推测目标').props.value, file.draft.goal)
  assert(!text(tree).includes('草稿字段已齐备'), 'imported successful receipts never become current check results')
  assert.equal(requests.filter(item => item.args.chainDraft).length, checksBeforeImport, 'import neither checks nor executes the draft automatically')
  click('检查推测缺口'); await settle(); assert(text(tree).includes('草稿字段已齐备'))
  const cacheAfterImport = storage.get(storedKey)
  for (const bad of ['{broken', { ...exchange(), documentId: 'foreign-document' }, exchange('missing-model'),
    { ...exchange(), modelIds: ['other', 'budget-model'] }, exchange('budget-model', 2)]) {
    await importFile(bad); await settle()
    assert(text(tree).includes('当前草稿未覆盖'))
    assert.equal(storage.get(storedKey), cacheAfterImport)
    assert.equal(input('推测目标').props.value, file.draft.goal)
    assert(!text(tree).includes('待导入草稿'))
  }
  await importFile(exchange(), { size: 2 * 1024 * 1024 + 1 }); await settle()
  assert(text(tree).includes('最多 2 MiB')); assert.equal(storage.get(storedKey), cacheAfterImport)
  await importFile(exchange(), { text: async () => { throw new Error('File read failed') } }); await settle()
  assert(text(tree).includes('File read failed')); assert.equal(storage.get(storedKey), cacheAfterImport)
  for (const kind of ['foreign', 'oldHost']) {
    if (kind === 'foreign') foreign = true; else oldHost = true
    await importFile(exchange()); await settle()
    assert(text(tree).includes('当前身份或服务版本不一致'))
    assert.equal(storage.get(storedKey), cacheAfterImport)
    foreign = oldHost = false
  }
  let releaseFile
  const lateFile = importFile(exchange(), { text: () => new Promise(resolve => { releaseFile = resolve }) })
  fill('推测目标', '读取文件期间继续编辑的目标')
  releaseFile(JSON.stringify(exchange())); await lateFile; await settle()
  assert.equal(input('推测目标').props.value, '读取文件期间继续编辑的目标')
  assert(!text(tree).includes('待导入草稿'), 'a delayed read cannot replace later edits')
  paused = true
  const lateModels = importFile(exchange('模型乙')); await settle()
  const pendingImport = deferred.splice(0); assert.equal(pendingImport.length, 1)
  fill('推测目标', '读取模型期间的新目标')
  assert(pendingImport[0].signal.aborted)
  pendingImport[0].resolve(); await lateModels; await settle()
  assert(!text(tree).includes('待导入草稿'))
  paused = false
  for (const peerId of ['source:model-beta', '模型乙', 'budget-model']) {
    await importFile(exchange(peerId)); await settle(); click('确认替换为导入草稿'); await settle()
    assert(text(tree).includes('第 2 步 · ' + peerId))
    assert(!text(tree).includes('草稿字段已齐备'))
    assert(text(tree).includes('草稿文字已导入'), 'pair loading must not erase the completed import status')
  }
  fill('第 1 步 · 行驶距离已知值或状态', '')
  assert(!text(tree).includes('草稿字段已齐备'), 'editing immediately invalidates the prior check receipt')
  assert(!button('导出推测草稿').props.disabled, 'missing inputs do not prevent backing up the remaining text')
  click('检查推测缺口'); await settle()
  assert(text(tree).includes('未承接上一步预测'), 'unresolved upstream input cannot silently feed a second step')
  fill('第 1 步 · 行驶距离已知值或状态', '5')
  fill('第 2 步 · 行程基础费用输入来源', 'known'); fill('第 2 步 · 行程基础费用已知值或状态', '旧手填金额')
  fill('第 2 步 · 行程基础费用输入来源', 'link'); fill('第 2 步 · 行程基础费用输入来源', 'known')
  assert.equal(input('第 2 步 · 行程基础费用已知值或状态').props.value, '旧手填金额', 'switching binding mode preserves inactive text')
  fill('第 2 步 · 行程基础费用输入来源', 'link')
  paused = true; click('检查推测缺口'); const oldCheck = deferred.splice(0)
  assert.equal(oldCheck.length, 1)
  fill('推测目标', '新的推测目标，旧回应不得替代')
  assert(oldCheck[0].signal.aborted)
  oldCheck[0].resolve(); await settle(); assert(!text(tree).includes('草稿字段已齐备'))
  paused = false
  mount(basicProps); await settle()
  assert.equal(input('推测目标').props.value, '新的推测目标，旧回应不得替代')
  assert.equal(input('第 2 步 · 行程基础费用承接槽位').props.value, 'fare-slot')
  assert(!text(tree).includes('草稿字段已齐备'), 'cached draft is not cached successful validation')
  click('下一页第 2 步模型'); await settle()
  assert.equal(input('第 2 步 · 行程基础费用承接槽位').props.value, 'fare-slot', 'pagination does not replace the active pair')
  click('上一页第 2 步模型'); await settle()
  fill('搜索第 2 步模型', 't'); await new Promise(resolve => setTimeout(resolve, 260)); await settle()
  confirm = false; choose('units'); await settle()
  assert.equal(input('第 2 步 · 行程基础费用承接槽位').props.value, 'fare-slot')
  confirm = true
  paused = true; choose('units'); const oldPair = deferred.splice(0)
  choose('times'); const nextPair = deferred.splice(0)
  assert(oldPair.every(item => item.signal.aborted))
  nextPair.forEach(item => item.resolve()); await settle(); oldPair.forEach(item => item.resolve()); await settle()
  assert(text(tree).includes('第 2 步 · times')); assert(!text(tree).includes('第 2 步 · units'))
  props.active = false; render(); assert.equal(tree, null)
  props.active = true; render(); const hiddenPair = deferred.splice(0)
  props.active = false; render(); hiddenPair.forEach(item => item.resolve()); await settle(); assert.equal(tree, null)
  assert(hiddenPair.every(item => item.signal.aborted))
  paused = false; props.active = true; render(); await settle()
  choose('budget-model'); await settle(); fillDraft()
  transportFailure = true; click('检查推测缺口'); await settle()
  assert(text(tree).includes('Chain transport failed')); assert.equal(input('第 1 步 · 基础费用预测').props.value, '14')
  transportFailure = false; malformed = true; click('检查推测缺口'); await settle()
  assert(text(tree).includes('检查回应与当前推测草稿不一致'))
  malformed = false; foreign = true; click('检查推测缺口'); await settle()
  assert(text(tree).includes('检查回应与当前推测草稿不一致'))
  foreign = false; oldHost = true; click('检查推测缺口'); await settle()
  assert(text(tree).includes('检查回应与当前推测草稿不一致'))
  oldHost = false; click('检查推测缺口'); await settle(); assert(text(tree).includes('草稿字段已齐备'))
  const current = store.getDocument(document.documentId)
  current.nodes.find(node => node.id === 'taxi').text = '来源更新后的合成计价模型'
  store.saveGraph(current, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  const oldSourceDraft = storage.get(storedKey)
  paused = true; props.revision = 2; beforeEffects()
  assert(text(tree).includes('草稿来源版本 1 · 请求模型版本 2'), 'the draft source and requested model versions are distinct before effects run')
  assert(all(tree, el => el.props['aria-label'] === '已保留的两步草稿').length)
  assert(button('对照后使用当前版本').props.disabled && button('检查推测缺口').props.disabled)
  render()
  failPairOnce = true; deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert(text(tree).includes('Chain models unavailable'))
  assert(text(tree).includes('草稿来源版本 1 · 请求模型版本 2'))
  assert(text(tree).includes('fare-slot') && text(tree).includes('expense'))
  assert(button('对照后使用当前版本').props.disabled, 'a failed newer model read cannot approve old draft text against the current version')
  assert(!button('导出推测草稿').props.disabled)
  assert.equal(storage.get(storedKey), oldSourceDraft)
  click('重新读取两步推测模型'); await settle()
  assert(text(tree).includes('草稿来源版本 1，当前版本 2'))
  assert(text(tree).includes('草稿来源版本 1 · 已读取模型版本 2'))
  assert.equal(storage.get(storedKey), oldSourceDraft, 'successful model reads do not silently rebase the draft')
  assert(button('检查推测缺口').props.disabled)
  assert.equal(input('第 1 步 · 基础费用预测').props.value, '14')
  confirm = false; click('对照后使用当前版本'); assert(button('检查推测缺口').props.disabled)
  confirm = true; click('对照后使用当前版本'); click('检查推测缺口'); await settle(); assert(text(tree).includes('草稿字段已齐备'))
  storageFailure = true; fill('推测目标', '缓存失败也保留页面文字')
  assert(text(tree).includes('标签页草稿未缓存'))
  assert.equal(input('推测目标').props.value, '缓存失败也保留页面文字')
  const privateFields = () => all(tree, el => ['textarea', 'select'].includes(el.type)).map(el => [el.props['aria-label'], el.props.value])
  const uncachedFields = privateFields()
  props.modelId = 'budget-model'; render(); await settle()
  assert.equal(input('推测目标').props.value, '', 'Another model must not display the private chain')
  props.modelId = 'taxi'; render(); await settle()
  assert.equal(input('推测目标').props.value, '缓存失败也保留页面文字', 'Returning to a model retains newer memory instead of the older browser cache')
  assert.deepEqual(privateFields(), uncachedFields, 'All branch, binding, condition and prediction fields survive scope changes')
  assert(text(tree).includes('标签页草稿未缓存'))
  props.modelId = 'budget-model'; render(); await settle()
  props.modelId = 'taxi'; props.revision = 3; render(); await settle()
  assert(text(tree).includes('草稿来源版本 2') && text(tree).includes('请求模型版本 3'))
  assert.equal(input('推测目标').props.value, '缓存失败也保留页面文字', 'Restoring memory must not rebase its source version')
  assert(button('检查推测缺口').props.disabled)
  props.revision = 2; render(); await settle(); assert.deepEqual(privateFields(), uncachedFields)
  storageFailure = false
  await importFile(exchange()); await settle(); click('确认替换为导入草稿'); await settle()
  assert(text(tree).includes('草稿来源版本 1，当前版本 2'))
  assert(button('检查推测缺口').props.disabled, 'import does not silently change the source revision')
  confirm = false; click('对照后使用当前版本'); assert(button('检查推测缺口').props.disabled)
  confirm = true; click('对照后使用当前版本'); click('检查推测缺口'); await settle(); assert(text(tree).includes('草稿字段已齐备'))
  await importFile(exchange('模型乙')); await settle()
  fill('推测目标', '预览之后的编辑必须取消替换')
  assert(!text(tree).includes('待导入草稿'))
  let hiddenFileRelease
  const hiddenImport = importFile(exchange(), { text: () => new Promise(resolve => { hiddenFileRelease = resolve }) })
  props.active = false; render()
  hiddenFileRelease(JSON.stringify(exchange())); await hiddenImport; await settle(); assert.equal(tree, null)
  props.active = true; render(); await settle()
  assert(!text(tree).includes('待导入草稿'), 'inactive workbenches do not apply or show a late import')
  props.modelId = 'multi'; render(); await settle()
  assert.equal(input('具体情境').props.value, '', 'primary model drafts are isolated')
  assert.equal(store.listLearningAttempts(document.documentId).length, 0)
  storage.set(storedKey, '{broken')
  mount({ ...basicProps, revision: 2 }); await settle()
  assert(text(tree).includes('原缓存未覆盖')); assert.equal(storage.get(storedKey), '{broken')
  fill('具体情境', '暂时编辑的情境'); assert.equal(storage.get(storedKey), '{broken')
  props.modelId = 'budget-model'; render(); await settle()
  props.modelId = 'taxi'; render(); await settle()
  assert.equal(input('具体情境').props.value, '暂时编辑的情境', 'A private edit survives even when the original cache is malformed')
  assert(text(tree).includes('原缓存未覆盖')); assert.equal(storage.get(storedKey), '{broken')
  confirm = false; click('重新建立标签页草稿'); assert.equal(storage.get(storedKey), '{broken')
  confirm = true; click('重新建立标签页草稿'); assert.notEqual(storage.get(storedKey), '{broken')
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore)
  assert.deepEqual(store.getDocument(document.documentId).edges, graphBefore.edges)
  for (const change of ['document', 'revision', 'model', 'filter', 'reload', 'hidden', 'reactivated', 'unmount']) {
    mount({ ...basicProps, revision: 2 }); await settle()
    const retired = button('下一页第 2 步模型').props.onClick
    paused = true
    if (change === 'document') props.documentId = 'other-document'
    if (change === 'revision') props.revision = 3
    if (change === 'model') props.modelId = 'multi'
    if (change === 'filter') all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } })
    if (change === 'reload') click('重新读取两步推测模型')
    if (change === 'hidden' || change === 'reactivated') props.active = false
    render()
    if (change === 'reactivated') { props.active = true; render() }
    if (change === 'unmount') owner.slots.forEach(state => state.cleanup?.())
    retired()
    assert.equal(updates.length, 0, 'retired page action cannot change ' + change + ' context')
    assert.equal(owner.focused || 0, 0, 'retired page action cannot move focus after ' + change)
    owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  }
  for (const change of ['document', 'revision', 'model', 'query', 'filter', 'page', 'reload', 'hidden', 'reactivated', 'unmount']) {
    mount({ ...basicProps, revision: 2 }); await settle()
    failCatalogOnce = true; click('下一页第 2 步模型'); await settle()
    const retired = button('重试读取第 2 步候选').props.onClick
    paused = true
    if (change === 'document') props.documentId = 'other-document'
    if (change === 'revision') props.revision = 3
    if (change === 'model') props.modelId = 'multi'
    if (change === 'query') fill('搜索第 2 步模型', '预算')
    if (change === 'filter') all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } })
    if (change === 'page') click('上一页第 2 步模型')
    if (change === 'reload') click('重新读取两步推测模型')
    if (change === 'hidden' || change === 'reactivated') props.active = false
    render()
    if (change === 'reactivated') { props.active = true; render() }
    if (change === 'unmount') owner.slots.forEach(state => state.cleanup?.())
    else assert(!text(tree).includes('Chain catalogue unavailable'), 'the old error is hidden immediately after ' + change)
    const reads = requests.length
    retired()
    assert.equal(updates.length, 0, 'retired retry cannot change ' + change + ' context')
    assert.equal(requests.length, reads)
    assert.equal(owner.searchFocused || 0, 0, 'retired retry cannot move focus after ' + change)
    owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  }
  const savedWork = { scope: JSON.stringify([document.documentId, 'taxi']), revision: 1, peerId: 'budget-model', draft: modelChainDraft() }
  savedWork.draft.steps[1].inputs[0].value = '旧手填值\n<img src=x onerror=alert(1)>'
  savedWork.draft.steps[1].inputs[0].basis = '旧手填依据，当前不使用'
  savedWork.draft.steps[1].inputs[1].fromSlotId = '此前选择的槽位'
  savedWork.draft.steps[1].inputs[1].meaning = '此前承接核对，当前不使用'
  savedWork.draft.steps[1].outputs.push({ slotId: 'retired-output', value: '旧预测仍保留' })
  storage.set(storedKey, JSON.stringify(savedWork))
  paused = true; mount({ ...basicProps, revision: 2 })
  const savedTree = all(tree, el => el.props['aria-label'] === '已保留的两步草稿')[0]
  assert(text(savedTree).includes('保留的已知输入文字（当前未使用）') && text(savedTree).includes('保留的承接核对文字（当前未使用）'))
  for (const value of ['旧手填值\n<img src=x onerror=alert(1)>', '旧手填依据，当前不使用', '此前选择的槽位', '此前承接核对，当前不使用', 'retired-output', '旧预测仍保留']) assert(text(savedTree).includes(value))
  assert.equal(all(savedTree, el => el.type === 'img' || el.props.dangerouslySetInnerHTML).length, 0, 'private draft text remains text, including multiline markup')
  foreign = true; deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert(text(tree).includes('两步推测模型版本或身份不一致'))
  assert(all(tree, el => el.props['aria-label'] === '已保留的两步草稿').length, 'rejected foreign replies cannot replace the saved draft with model facts')
  assert.equal(storage.get(storedKey), JSON.stringify(savedWork))
  foreign = false
  const checksBeforeStaleRetry = requests.filter(item => item.args.chainDraft).length
  const readsBeforeStaleRetry = requests.length
  click('重试读取两步模型'); await settle()
  assert.equal(requests.length, readsBeforeStaleRetry + 1)
  assert.equal(requests.filter(item => item.args.chainDraft).length, checksBeforeStaleRetry, 'retry never automatically checks or certifies a draft')
  assert(text(tree).includes('草稿来源版本 1 · 已读取模型版本 2'))
  assert(button('检查推测缺口').props.disabled, 'successful retry cannot bypass the stale source version confirmation')
  assert.equal(storage.get(storedKey), JSON.stringify(savedWork), 'successful retry does not rebase or rewrite private text')
  failCatalogOnce = true; failPairOnce = true; mount({ ...basicProps, revision: 2 }); await settle()
  const catalogueFailureBeforePairRetry = text(all(tree, el => el.props.role === 'alert').find(el => text(el).includes('Chain catalogue unavailable')))
  paused = true; click('重试读取第 2 步候选')
  const pendingCatalogue = deferred[0]
  click('重试读取两步模型')
  assert.equal(deferred.length, 2, 'independent catalogue retry and model retry coexist')
  assert(!pendingCatalogue.signal.aborted, 'model retry does not cancel the independent candidate request')
  deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert.equal(storage.get(storedKey), JSON.stringify(savedWork))
  assert(catalogueFailureBeforePairRetry.includes('Chain catalogue unavailable'))
  for (const change of ['document', 'revision', 'model', 'peer', 'reload', 'hidden', 'reactivated', 'unmount']) {
    failPairOnce = true; mount({ ...basicProps, revision: 2 }); await settle()
    const retired = button('重试读取两步模型').props.onClick
    paused = true
    if (change === 'document') props.documentId = 'other-document'
    if (change === 'revision') props.revision = 3
    if (change === 'model') props.modelId = 'multi'
    if (change === 'peer') choose('chain-peer-0')
    if (change === 'reload') click('重新读取两步推测模型')
    if (change === 'hidden' || change === 'reactivated') props.active = false
    render()
    if (change === 'reactivated') { props.active = true; render() }
    if (change === 'unmount') owner.slots.forEach(state => state.cleanup?.())
    const reads = requests.length
    retired()
    assert.equal(updates.length, 0, 'retired model retry cannot change ' + change + ' context')
    assert.equal(requests.length, reads)
    assert.equal(owner.pairFocused || 0, 0, 'retired model retry cannot move focus after ' + change)
    owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
    storage.set(storedKey, JSON.stringify(savedWork))
  }
  for (const change of ['document', 'revision', 'model', 'peer', 'reload', 'hidden']) {
    failPairOnce = true; mount({ ...basicProps, revision: 2 }); await settle()
    assert(text(tree).includes('Chain models unavailable'))
    paused = true
    if (change === 'document') props.documentId = 'other-document'
    if (change === 'revision') props.revision = 3
    if (change === 'model') props.modelId = 'multi'
    if (change === 'peer') all(tree, el => el.type === 'button' && text(el).includes('chain-peer-0 · '))[0].props.onClick()
    if (change === 'reload') button('重新读取两步推测模型').props.onClick()
    if (change === 'hidden') props.active = false
    beforeEffects()
    assert(!text(tree).includes('Chain models unavailable'), 'old pair failure is not attributed to the first render of ' + change)
    if (['document', 'model', 'hidden'].includes(change)) assert(!all(tree, el => el.props['aria-label'] === '已保留的两步草稿').length, 'old saved steps are not shown in another owner context')
    if (change === 'peer') {
      assert(text(tree).includes('第 2 步 · chain-peer-0'))
      assert(!text(tree).includes('第 2 步 · budget-model') && !text(tree).includes('旧预测仍保留'), 'confirmed peer replacement clears only its own old step')
      assert(text(tree).includes(savedWork.draft.steps[0].reasoning), 'the first step remains after confirmed peer replacement')
    }
    render(); owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
    storage.set(storedKey, JSON.stringify(savedWork))
  }
  mount({ ...basicProps, revision: 2, modelId: '', active: false }); await settle()
  assert.equal(tree, null)
  assert(!storage.has('dsh-kg-model-chain:' + JSON.stringify([document.documentId, ''])), 'An unselected retained owner does not write an invalid blank-model cache')
  Component = context.window.KGViewer.ConnectionModelPanel
  oldHost = true
  mount({ documentId: document.documentId, revision: 2, load,
    focusRequest: { documentId: document.documentId, revision: 2, type: 'connection_model', nodeId: 'taxi' } }); await settle()
  assert(button('两步推测').props.disabled, 'the workbench must gate the new entry, not merely reject after opening')
  assert(text(tree).includes('两步推测版本尚未就绪'))
  oldHost = false
  click('重新读取模型'); await settle()
  assert(!button('两步推测').props.disabled)
  click('两步推测')
  let chainChild = all(tree, el => el.type === context.window.KGViewer.ConnectionModelChain)[0]
  assert(chainChild.props.active)
  chainChild.props.onOpen('budget-model'); render(); await settle()
  assert.equal(all(tree, el => el.type === context.window.KGViewer.ConnectionModelChain)[0].props.modelId, 'budget-model')
  click('返回上一个模型'); await settle()
  chainChild = all(tree, el => el.type === context.window.KGViewer.ConnectionModelChain)[0]
  assert.equal(chainChild.props.modelId, 'taxi')
  assert(chainChild.props.active, 'return restores the chain tab, not just the previous model identity')
  paused = true; click('重新读取模型')
  chainChild = all(tree, el => el.type === context.window.KGViewer.ConnectionModelChain)[0]
  assert(chainChild, 'Detail reads keep the private chain owner mounted')
  assert.equal(chainChild.props.active, false, 'No chain reads or hidden focus while parent details are unavailable')
  assert.equal(chainChild.props.modelId, 'taxi')
  deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert(all(tree, el => el.type === context.window.KGViewer.ConnectionModelChain)[0].props.active)
  console.log('model chain UI: actual production route, window memory fallback by document/model, retained owner through detail reads, uncached source revision and malformed-cache private edits preserved, readable private steps through pending/failed/rejected model reads, source/request versions and first-render isolation, inactive input text and old slots, persistent candidate paging and focus, independent catalogue/model retries, single-flight and eight retired retry contexts, preserved checks, explicit selection, draft export/import preview and confirmation, untrusted receipts, import races, mode-preserving cache, stale guards, source CAS rebase, malformed cache and no learner writes passed')
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
