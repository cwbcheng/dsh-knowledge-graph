import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { comparisonFixture, counterexampleResponse } from './kg-model-comparison-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: comparisonFixture() })
const { document, store, post } = harness
let owner = { slots: [], effects: [] }, cursor = 0, tree, Component, props
const updates = [], storage = new Map(), events = new Map(), requests = [], deferred = [], challenges = []
let paused = false, loseSave = false, invalidIdentity = false, invalidRevision = false, failCatalogOnce = false, failPairOnce = false
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
const context = { window: { React, confirm: () => true, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) },
  console, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const call = (args, signal, method = 'learning-mode') => {
  requests.push({ args, signal, method })
  const run = async () => {
    if (failCatalogOnce && method === 'connection-models' && !args.modelId) { failCatalogOnce = false; throw new Error('Catalogue temporarily unavailable') }
    if (failPairOnce && method === 'connection-models' && args.compareModelId) { failPairOnce = false; throw new Error('Comparison temporarily unavailable') }
    const result = await post(args, method)
    if (args.action === 'save' && loseSave) { loseSave = false; throw new Error('Lost challenge save response') }
    return invalidIdentity ? { ...result, documentId: 'foreign-document' } : invalidRevision ? { ...result, revision: result.revision + 1 } : result
  }
  return paused ? new Promise((resolve, reject) => deferred.push({ args, signal, resolve: () => run().then(resolve, reject) })) : run()
}
function render() {
  for (let count = 0; count < 30; count++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0
    tree = Component(props)
    for (const node of all(tree, el => el.props['aria-label'] === '比较模型候选' && el.props.ref)) {
      node.props.ref.current = owner.focusNode ||= { scrollTop: 80, focus: () => { owner.focused = (owner.focused || 0) + 1 } }
    }
    for (const node of all(tree, el => el.props['aria-label'] === '搜索比较模型' && el.props.ref)) {
      node.props.ref.current = owner.searchNode ||= { focus: () => { owner.searchFocused = (owner.searchFocused || 0) + 1 } }
    }
    for (const node of all(tree, el => el.props['aria-label'] === '比较模型读取状态' && el.props.ref)) {
      node.props.ref.current = { focus: () => { owner.pairFocused = (owner.pairFocused || 0) + 1 } }
    }
    owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('Component update loop')
}
async function settle() { for (let count = 0; count < 8; count++) { await new Promise(resolve => setImmediate(resolve)); render() } }
const text = el => Array.isArray(el) ? el.map(text).join('') : el && typeof el === 'object' ? text(el.props?.children) : String(el ?? '')
const all = (el, predicate) => Array.isArray(el) ? el.flatMap(child => all(child, predicate)) : !el || typeof el !== 'object' ? [] :
  [...(predicate(el) ? [el] : []), ...all(el.props?.children, predicate)]
const button = label => { const found = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0]; assert(found, label); return found }
const click = label => { const found = button(label); assert(!found.props.disabled, label); found.props.onClick(); render() }
const input = label => { const found = all(tree, el => ['textarea', 'select', 'input'].includes(el.type) && el.props['aria-label'] === label)[0]; assert(found, label); return found }
const candidates = () => { const node = all(tree, el => el.props['aria-label'] === '比较模型候选')[0]; assert(node, 'Candidate region stays mounted during reads'); return node }
const identity = () => { const node = all(tree, el => el.props['aria-label'] === '本次比较对象')[0]; assert(node, 'Selected comparison identity stays visible'); return text(node) }
const beforeEffects = () => { updates.splice(0).forEach(fn => fn()); cursor = 0; tree = Component(props) }
const fill = (label, value) => { const found = input(label); assert(!found.props.disabled, label); found.props.onChange({ target: { value } }); render() }
const choose = id => {
  const found = all(tree, el => el.type === 'button' && text(el).includes(id + ' · '))[0]
  assert(found, 'Missing peer ' + id); found.props.onClick(); render()
}
const mount = (name, next) => {
  owner.slots.forEach(state => state.cleanup?.()); updates.length = 0; owner = { slots: [], effects: [] }
  Component = context.window.KGViewer[name]; props = next; render()
}
try {
  const before = JSON.stringify(store.getDocument(document.documentId))
  mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
    load: (args, signal) => call(args, signal, 'connection-models'), onChallenge: id => challenges.push(id), onLocate: () => { throw new Error('Locate failed visibly') } })
  await settle()
  assert.equal(requests.filter(item => item.args.compareModelId).length, 0, 'comparison requires explicit second model selection')
  assert(!all(tree, el => el.props['aria-label'] === '本次比较对象').length, 'No second model is inferred before explicit selection')
  paused = true; choose('night')
  assert(identity().includes('模型 A · taxi')); assert(identity().includes('模型 B · night'))
  assert(identity().includes('请求版本 1'))
  assert(!identity().includes('抽取状态：'), 'Unloaded comparison cannot present model verification states')
  assert(!all(tree, el => el.props.className === 'kg-model-compare-row').length)
  deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert(identity().includes('版本 1')); assert(!identity().includes('请求版本'))
  assert(text(tree).includes('已记录的输入、输出端点相同'))
  assert(text(tree).includes('不代表条件、单位或结论等价'))
  assert(text(tree).includes('前 2 / 2 条关联材料'))
  click('挑战模型 B'); assert.deepEqual(challenges, ['night'], 'challenge targets selected secondary model, not primary by mistake')
  click('原文 P9'); await settle(); assert(text(tree).includes('Locate failed visibly'))
  const originalRows = all(tree, el => el.props.className === 'kg-model-compare-row').map(text)
  const oldCandidate = all(tree, el => el.type === 'button' && text(el).includes('unknown · '))[0]
  assert(oldCandidate)
  const readsBeforeQuery = requests.length
  fill('搜索比较模型', '没有这个模型-零结果')
  assert.equal(all(candidates(), el => el.type === 'button').length, 0, 'Pending query cannot show selectable matches for the previous query')
  assert(!text(tree).includes('匹配 28 个模型'), 'Previous count does not describe a pending query')
  assert.equal(candidates().props['aria-busy'], true)
  assert(text(tree).includes('正在更新比较搜索'))
  assert(identity().includes('模型 B · night'))
  assert.deepEqual(all(tree, el => el.props.className === 'kg-model-compare-row').map(text), originalRows)
  oldCandidate.props.onClick()
  assert.equal(updates.length, 0, 'Retired candidates cannot change explicit selection after query changes')
  assert.equal(requests.length, readsBeforeQuery, 'Debounce does not send an intermediate query')
  fill('搜索比较模型', '')
  assert(identity().includes('模型 B · night'))
  assert.equal(candidates().props['aria-busy'], false)
  assert.equal(candidates().props.tabIndex, -1)
  const beforePaging = requests.length, pairReads = requests.filter(item => item.args.compareModelId).length
  const nextPage = button('下一页比较模型').props.onClick
  paused = true
  nextPage(); nextPage(); render()
  assert.equal(requests.length, beforePaging + 1, 'Repeated page callbacks issue one catalogue request')
  assert.equal(owner.focused, 1, 'Focus moves before the page controls become unavailable')
  assert.equal(candidates().props['aria-busy'], true)
  assert.equal(owner.focusNode.scrollTop, 0)
  assert(button('上一页比较模型').props.disabled && button('下一页比较模型').props.disabled)
  nextPage(); assert.equal(updates.length, 0, 'Retired page callback cannot act during the new read')
  deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert.equal(owner.focused, 1, 'Completing a read does not steal focus back')
  assert.equal(candidates().props['aria-busy'], false)
  assert(button('下一页比较模型').props.disabled)
  button('下一页比较模型').props.onClick(); assert.equal(updates.length, 0, 'Last-page boundary is checked by the handler')
  assert(text(tree).includes('已记录的输入、输出端点相同'), 'candidate pagination does not replace the selected pair')
  assert(text(tree).includes('peer-9'))
  assert(!text(candidates()).includes('night · '), 'Selected B is outside the current candidate page')
  assert(identity().includes('模型 B · night'), 'Comparison identity does not depend on the candidate page')
  click('上一页比较模型'); await settle()
  assert.equal(owner.focused, 2)
  assert.equal(requests.filter(item => item.args.compareModelId).length, pairReads, 'Candidate paging never reloads the selected pair')
  button('上一页比较模型').props.onClick(); assert.equal(updates.length, 0, 'First-page boundary is checked by the handler')
  failCatalogOnce = true; click('下一页比较模型'); await settle()
  assert(text(tree).includes('Catalogue temporarily unavailable'))
  assert(candidates()); assert(!button('上一页比较模型').props.disabled)
  const retry = button('重试读取比较候选').props.onClick, failedRead = requests.at(-1).args
  const comparedRows = () => all(tree, el => el.props.className === 'kg-model-compare-row').map(text)
  const rowsBeforeRetry = comparedRows()
  paused = true
  retry(); retry(); render()
  const pendingRetry = deferred.splice(0)
  assert.equal(pendingRetry.length, 1, 'Double activation only retries one catalogue read')
  assert.deepEqual(pendingRetry[0].args, failedRead, 'Retry retains the failed query, filter, page and version')
  assert.equal(owner.searchFocused, 1, 'Focus moves to the persistent search before the retry button disappears')
  assert(candidates().props['aria-busy'])
  assert(!text(tree).includes('Catalogue temporarily unavailable'))
  assert.deepEqual(comparedRows(), rowsBeforeRetry, 'The selected pair and its evidence stay mounted during retry')
  assert(text(tree).includes('Locate failed visibly'), 'Catalogue retry must not reset independent source location state')
  pendingRetry[0].resolve(); paused = false; await settle()
  assert.equal(owner.searchFocused, 1, 'Retry responses do not steal focus')
  assert.equal(requests.filter(item => item.args.compareModelId).length, pairReads)
  assert.deepEqual(comparedRows(), rowsBeforeRetry)
  const readsAfterRetry = requests.length
  retry(); render(); await settle()
  assert.equal(requests.length, readsAfterRetry, 'A retired retry callback cannot initiate another read')
  click('上一页比较模型'); await settle()
  assert(text(tree).includes('已记录的输入、输出端点相同'), 'Failure and recovery retain the selected pair')
  all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } }); render(); await settle()
  fill('搜索比较模型', '待比较'); await new Promise(resolve => setTimeout(resolve, 260)); await settle()
  failCatalogOnce = true; click('下一页比较模型'); await settle()
  const filteredRead = requests.at(-1).args
  assert.equal(filteredRead.query, '待比较'); assert.equal(filteredRead.peerOf, ''); assert.equal(filteredRead.offset, 20)
  failCatalogOnce = true; click('重试读取比较候选'); await settle()
  assert(text(tree).includes('Catalogue temporarily unavailable'), 'Another failure remains retryable')
  assert.deepEqual(requests.at(-1).args, filteredRead)
  click('重试读取比较候选'); await settle()
  assert.deepEqual(requests.at(-1).args, filteredRead)
  assert.deepEqual(comparedRows(), rowsBeforeRetry)
  assert.equal(requests.filter(item => item.args.compareModelId).length, pairReads)
  all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } }); render(); await settle()
  fill('搜索比较模型', ''); await new Promise(resolve => setTimeout(resolve, 260)); await settle()
  paused = true
  choose('multi'); const old = deferred.splice(0)
  choose('unknown'); const fresh = deferred.splice(0)
  assert(old.every(item => item.signal.aborted))
  fresh.forEach(item => item.resolve()); await settle()
  old.forEach(item => item.resolve()); await settle()
  assert(text(tree).includes('端点角色或关系身份尚不完整'))
  assert(!text(tree).includes('已记录的输入、输出端点有差异'), 'late response cannot swap in another model')
  choose('night'); const hidden = deferred.splice(0)
  props.active = false; render(); assert.equal(tree, null)
  assert(hidden.every(item => item.signal.aborted))
  hidden.forEach(item => item.resolve()); await settle(); assert.equal(tree, null)
  paused = false; invalidIdentity = true
  props.active = true; render(); await settle()
  assert(text(tree).includes('比较模型身份或版本不一致'))
  assert(identity().includes('模型 B · night') && identity().includes('请求版本 1'))
  assert(!identity().includes('抽取状态：'), 'Rejected response cannot become displayed model facts')
  invalidIdentity = false; click('重新读取模型比较'); await settle()
  assert(text(tree).includes('已记录的输入、输出端点相同'))
  invalidRevision = true; click('重新读取模型比较'); await settle()
  assert(text(tree).includes('比较模型身份或版本不一致'))
  assert(identity().includes('请求版本 1') && !identity().includes('抽取状态：'), 'A response for another version is not displayed as loaded')
  invalidRevision = false
  const readsBeforeRejectedRetry = requests.length
  click('重试读取比较模型对'); await settle()
  assert.equal(requests.length, readsBeforeRejectedRetry + 1)
  assert(identity().includes('版本 1') && !identity().includes('请求版本'))
  assert(text(tree).includes('比较目录版本不一致'), 'pair recovery does not replace the independent candidate failure')
  click('重试读取比较候选'); await settle()
  failPairOnce = true; click('重新读取模型比较'); await settle()
  fill('搜索比较模型', '待比较'); await new Promise(resolve => setTimeout(resolve, 260)); await settle()
  click('下一页比较模型'); await settle()
  assert(!text(candidates()).includes('night · '), 'retry does not require B to remain on the candidate page')
  const candidateBeforePairRetry = JSON.stringify(candidates().props.children), retryReadsBefore = requests.length
  const retryModels = button('重试读取比较模型对').props.onClick
  paused = true; retryModels(); retryModels(); beforeEffects()
  assert(!text(tree).includes('Comparison temporarily unavailable'), 'retry hides the old error before effects')
  assert(identity().includes('请求版本 1') && identity().includes('模型 B · night'))
  render()
  assert.equal(deferred.length, 1); assert.equal(requests.length, retryReadsBefore + 1)
  assert.equal(requests.at(-1).args.compareModelId, 'night')
  assert.equal(JSON.stringify(candidates().props.children), candidateBeforePairRetry)
  assert.equal(input('搜索比较模型').props.value, '待比较')
  assert.equal(owner.pairFocused, 2, 'each explicit retry focuses the persistent status once')
  assert.equal(all(tree, el => el.props['aria-label'] === '比较模型读取状态')[0].props.tabIndex, -1)
  invalidIdentity = true; deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert(text(tree).includes('比较模型对读取失败：比较模型身份或版本不一致'))
  assert(identity().includes('请求版本 1') && !identity().includes('抽取状态：'))
  assert(!all(tree, el => el.props.className === 'kg-model-compare-row').length)
  invalidIdentity = false; paused = true; click('重试读取比较模型对')
  assert.equal(deferred.length, 1, 'a rejected identity remains independently retryable')
  const focusBeforePairReply = owner.pairFocused
  deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert.equal(owner.pairFocused, focusBeforePairReply, 'asynchronous replies do not move focus')
  assert.equal(JSON.stringify(candidates().props.children), candidateBeforePairRetry)
  assert(text(tree).includes('夜间附加条件') && text(tree).includes('不代表条件、单位或结论等价'))
  assert(!button('上一页比较模型').props.disabled)
  const retiredReads = requests.length
  retryModels(); render(); await settle(); assert.equal(requests.length, retiredReads)
  failCatalogOnce = true; failPairOnce = true; click('重新读取模型比较'); await settle()
  paused = true; click('重试读取比较候选')
  const independentCatalogue = deferred[0]
  click('重试读取比较模型对')
  assert.equal(deferred.length, 2); assert(!independentCatalogue.signal.aborted, 'pair retry cannot cancel an independent candidate request')
  assert.equal(independentCatalogue.args.offset, 20); assert.equal(independentCatalogue.args.query, '待比较')
  deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  assert(text(tree).includes('夜间附加条件'))

  for (const change of ['document', 'revision', 'model', 'peer', 'reload', 'hidden', 'reactivated', 'unmount']) {
    mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
      load: (args, signal) => call(args, signal, 'connection-models') })
    await settle(); failPairOnce = true; choose('night'); await settle()
    const retired = button('重试读取比较模型对').props.onClick
    paused = true
    if (change === 'document') props.documentId = 'other-document'
    if (change === 'revision') props.revision = 2
    if (change === 'model') props.modelId = 'multi'
    if (change === 'peer') choose('unknown')
    if (change === 'reload') click('重新读取模型比较')
    if (change === 'hidden' || change === 'reactivated') props.active = false
    beforeEffects()
    if (change !== 'unmount') {
      retired()
      assert.equal(updates.length, 0, 'retired pair retry cannot act before effects after ' + change)
    }
    render()
    if (change === 'reactivated') { props.active = true; render() }
    if (change === 'unmount') owner.slots.forEach(state => state.cleanup?.())
    const reads = requests.length
    retired()
    assert.equal(updates.length, 0, 'retired pair retry cannot change ' + change + ' context')
    assert.equal(requests.length, reads); assert.equal(owner.pairFocused || 0, 0)
    owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  }

  for (const change of ['document', 'revision', 'model', 'peer', 'reload', 'hidden']) {
    mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
      load: (args, signal) => call(args, signal, 'connection-models') })
    await settle()
    failPairOnce = true; choose('night'); await settle()
    assert(text(tree).includes('Comparison temporarily unavailable'))
    assert(identity().includes('模型 A · taxi') && identity().includes('模型 B · night') && identity().includes('请求版本 1'))
    assert(!all(tree, el => el.props.className === 'kg-model-compare-row').length)
    // Changes must be truthful on the first render, before effect cleanup.
    paused = true
    if (change === 'document') props.documentId = 'other-document'
    if (change === 'revision') props.revision = 2
    if (change === 'model') props.modelId = 'multi'
    if (change === 'peer') all(tree, el => el.type === 'button' && text(el).includes('unknown · '))[0].props.onClick()
    if (change === 'reload') button('重新读取模型比较').props.onClick()
    if (change === 'hidden') props.active = false
    beforeEffects()
    assert(!text(tree).includes('Comparison temporarily unavailable'), 'Old failure cannot be attributed to ' + change + ' context')
    if (['document', 'model', 'hidden'].includes(change)) assert(!all(tree, el => el.props['aria-label'] === '本次比较对象').length, 'Old B cannot belong to a new primary model or document')
    if (change === 'revision') assert(identity().includes('请求版本 2') && identity().includes('模型 B · night'))
    if (change === 'peer') assert(identity().includes('模型 B · unknown') && !identity().includes('模型 B · night'))
    render()
    owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  }

  for (const change of ['revision', 'reload']) {
    mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
      load: (args, signal) => call(args, signal, 'connection-models') })
    await settle(); choose('night'); await settle()
    paused = true
    if (change === 'revision') props.revision = 2
    else button('重新读取模型比较').props.onClick()
    beforeEffects()
    assert(identity().includes('请求版本 ' + props.revision) && !identity().includes('抽取状态：'))
    assert(!all(tree, el => el.props.className === 'kg-model-compare-row').length, 'Loaded details vanish before effects on ' + change)
    render()
    owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  }

  for (const change of ['document', 'revision', 'model', 'query', 'filter', 'reload', 'hidden', 'reactivated', 'unmount']) {
    mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
      load: (args, signal) => call(args, signal, 'connection-models') })
    await settle()
    const retired = button('下一页比较模型').props.onClick
    paused = true
    if (change === 'document') props.documentId = 'other-document'
    if (change === 'revision') props.revision = 2
    if (change === 'model') props.modelId = 'night'
    if (change === 'query') fill('搜索比较模型', 'night')
    if (change === 'filter') all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } })
    if (change === 'reload') click('重新读取模型比较')
    if (change === 'hidden' || change === 'reactivated') props.active = false
    render()
    if (change === 'reactivated') { props.active = true; render() }
    if (change === 'unmount') owner.slots.forEach(state => state.cleanup?.())
    if (change === 'query') assert(button('下一页比较模型').props.disabled, 'Pending query cannot paginate old matches')
    retired()
    assert.equal(updates.length, 0, 'Retired page action cannot change ' + change + ' context')
    assert.equal(owner.focused || 0, 0, 'Retired page action cannot move focus after ' + change)
    owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  }

  for (const change of ['document', 'revision', 'model', 'query', 'filter', 'page', 'reload', 'hidden', 'reactivated', 'unmount']) {
    mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
      load: (args, signal) => call(args, signal, 'connection-models') })
    await settle()
    failCatalogOnce = true; click('下一页比较模型'); await settle()
    const retired = button('重试读取比较候选').props.onClick
    paused = true
    if (change === 'document') props.documentId = 'other-document'
    if (change === 'revision') props.revision = 2
    if (change === 'model') props.modelId = 'night'
    if (change === 'query') fill('搜索比较模型', 'night')
    if (change === 'filter') all(tree, el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } })
    if (change === 'page') click('上一页比较模型')
    if (change === 'reload') click('重新读取模型比较')
    if (change === 'hidden' || change === 'reactivated') props.active = false
    render()
    if (change === 'reactivated') { props.active = true; render() }
    if (change === 'unmount') owner.slots.forEach(state => state.cleanup?.())
    else assert(!text(tree).includes('Catalogue temporarily unavailable'), 'Old errors are hidden after ' + change)
    const reads = requests.length
    retired()
    assert.equal(updates.length, 0, 'Retired retry cannot mutate ' + change + ' context')
    assert.equal(requests.length, reads)
    assert.equal(owner.searchFocused || 0, 0, 'Retired retry cannot move focus after ' + change)
    owner.slots.forEach(state => state.cleanup?.())
    deferred.splice(0).forEach(item => item.resolve()); paused = false; await settle()
  }

  mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
    load: (args, signal) => call(args, signal, 'connection-models') })
  await settle()
  paused = true; choose('night')
  const pendingPair = deferred.shift()
  failCatalogOnce = true; click('下一页比较模型')
  deferred.shift().resolve(); await settle()
  click('重试读取比较候选')
  const concurrentRetry = deferred.shift()
  assert(!pendingPair.signal.aborted, 'Retry cannot cancel an independently selected comparison')
  assert.equal(deferred.length, 0, 'Retry does not duplicate a pending comparison')
  pendingPair.resolve(); await settle()
  assert(text(tree).includes('已记录的输入、输出端点相同'))
  concurrentRetry.resolve(); paused = false; await settle()
  assert(text(tree).includes('已记录的输入、输出端点相同'))

  mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
    load: (args, signal) => call(args, signal, 'connection-models') })
  await settle(); choose('night'); await settle()
  const pairReadsBeforeSearch = requests.filter(item => item.args.compareModelId).length
  const pairRowsBeforeSearch = all(tree, el => el.props.className === 'kg-model-compare-row').map(text)
  fill('搜索比较模型', '没有这个模型-零结果')
  await new Promise(resolve => setTimeout(resolve, 240)); await settle()
  assert(text(tree).includes('匹配 0 个模型')); assert(button('查看全部模型'))
  fill('搜索比较模型', '夜间')
  assert(!text(tree).includes('匹配 0 个模型'), 'Old zero count cannot describe the new pending keyword')
  assert(!all(tree, el => el.type === 'button' && text(el) === '查看全部模型').length, 'Old zero-result action stays hidden')
  paused = true
  await new Promise(resolve => setTimeout(resolve, 240)); await settle()
  assert.equal(deferred.length, 1); assert.equal(deferred[0].args.query, '夜间')
  assert.equal(candidates().props['aria-busy'], true)
  assert.equal(all(candidates(), el => el.type === 'button').length, 0)
  assert.deepEqual(all(tree, el => el.props.className === 'kg-model-compare-row').map(text), pairRowsBeforeSearch)
  deferred.shift().resolve(); paused = false; await settle()
  assert(text(tree).includes('匹配 1 个模型')); assert.equal(candidates().props['aria-busy'], false)
  assert(identity().includes('模型 B · night'))
  assert.equal(requests.filter(item => item.args.compareModelId).length, pairReadsBeforeSearch)

  mount('ModelLearningPanel', { documentId: document.documentId, revision: 1, modelId: 'taxi', exercise: 'counterexample', active: true, call })
  await settle()
  const fields = { inputs: '输入', mapping: '联结与推理', outputs: '输出', boundary: '适用条件与失效边界',
    scenario: '改变后的情境', prediction: '改变后的预测', check: '可观察的验证依据', baseline: '基准情境',
    baselinePrediction: '基准预测', changedVariable: '只改变的一项与保持不变的条件', falsifier: '什么观察结果会反驳这条规律' }
  assert(text(tree).includes('反例挑战')); assert(!text(tree).includes('2 km 对应 10 元'))
  for (const [key, label] of Object.entries(fields)) {
    assert(button('保存预测').props.disabled, 'all challenge fields, including falsifier, are required')
    fill(label, counterexampleResponse[key])
  }
  assert(!button('保存预测').props.disabled)
  props.exercise = 'prediction'; render(); await settle()
  assert.equal(input('我的预测').props.value, '', 'exercise drafts cannot contaminate each other')
  fill('我的预测', '另外的未保存预测')
  props.exercise = 'counterexample'; render(); await settle()
  assert.equal(input('基准情境').props.value, counterexampleResponse.baseline)
  const preservedProps = props
  mount('ModelLearningPanel', preservedProps); await settle()
  assert.equal(input('什么观察结果会反驳这条规律').props.value, counterexampleResponse.falsifier, 'challenge draft survives remount')
  loseSave = true
  const saveButton = button('保存预测'); saveButton.props.onClick(); saveButton.props.onClick(); render(); await settle()
  assert.equal(requests.filter(item => item.args.action === 'save').length, 1)
  assert(text(tree).includes('Lost challenge save response'))
  assert.equal(input('改变后的预测').props.value, counterexampleResponse.prediction)
  click('保存预测'); await settle()
  const saves = requests.filter(item => item.args.action === 'save')
  assert.equal(saves[0].args.attemptId, saves[1].args.attemptId)
  assert(text(tree).includes('最初的预测')); assert(!text(tree).includes('2 km 对应 10 元'))
  assert(text(tree).includes('是否只改变一个条件尚未核验'), 'saved challenge is not presented as a controlled experiment already verified')
  click('展开原文对照'); await settle()
  assert(text(tree).includes('2 km 对应 10 元')); assert(text(tree).includes('不是标准答案'))
  fill('复盘判断', learnerReview.diagnosis); fill('保留或修改的理由', learnerReview.reflection); fill('下一步验证', learnerReview.nextCheck)
  click('保存复盘'); await settle()
  assert(input('保留或修改的理由').props.disabled)
  const record = store.listLearningAttempts(document.documentId, 'taxi', 'counterexample')[0]
  assert.equal(record.version, 3); assert.equal(record.response.changedVariable, counterexampleResponse.changedVariable)
  assert.equal(record.task.refutation, 'not_verified')
  props.exercise = 'prediction'; render(); await settle()
  assert.equal(input('我的预测').props.value, '另外的未保存预测')
  assert(text(tree).includes('最近 0 条'), 'prediction history excludes challenge attempts')
  props.exercise = 'counterexample'; render(); await settle()
  assert(text(tree).includes('最近 1 条'))
  assert.equal(JSON.stringify(store.getDocument(document.documentId)), before, 'actual UI plus SQLite routes preserve canonical graph')
  const savedHistory = all(tree, el => el.type === 'button' && text(el).includes(' · 已复盘'))[0]
  assert(savedHistory); savedHistory.props.onClick(); render()
  click('另开一次预测')
  fill('基准情境', '7 km'); fill('改变后的情境', '７ ｋｍ！')
  for (const [key, label] of Object.entries(fields)) if (!['baseline', 'scenario'].includes(key)) fill(label, counterexampleResponse[key])
  click('保存预测'); await settle()
  assert(text(tree).includes('仅修改标点或排版不构成条件变化'))
  assert.equal(input('基准情境').props.value, '7 km', 'invalid challenge retains all unsaved fields')
  assert.equal(store.listLearningAttempts(document.documentId, 'taxi', 'counterexample').length, 1)
  console.log(JSON.stringify({ ok: true, generatedProductionComponents: true, actualSqliteHttp: true, pairRaceFenced: true, explicitSelection: true,
    targetIdentity: true, paginationFocus: true, paginationScopeGuards: 9, pageFailureRecovery: true,
    pendingQueryHidesPreviousMatches: true, staleCandidateRejected: true, zeroResultWaitIsolation: true, independentSearchPreservesPair: true,
    catalogRetryScopeGuards: 10, independentRetry: true, independentPairRetry: true, pairRetryScopeGuards: 8,
    pairRetrySingleFlight: true, pairRetryIdentityRejection: true, pendingComparisonPreserved: true, evidenceRetained: true,
    requestedPairIdentity: true, failureFirstRenderScopes: 6, requestedRevisionNotLoadedFacts: true,
    challengeDraftScopes: true, idempotentLostResponse: true, visibleInvalidChange: true, graphUnchanged: true }))
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
