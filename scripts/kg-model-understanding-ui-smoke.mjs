import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelStructureFixture() })
const { store, document, post } = harness
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
  console, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
let Component = context.window.KGViewer.ModelUnderstandingPanel
assert.equal(typeof Component, 'function')
const props = { documentId: document.documentId, modelId: 'taxi', revision: 1, active: true,
  call: (args, signal) => {
    requests.push({ args, signal })
    const run = async () => {
      const result = await post(args)
      if (legacy) delete result.modelUnderstandingVersion
      if (forged && args.action === 'plan') result.tasks[0].model.nodeId = 'wrong'
      if (args.action === 'save' && loseSave) { loseSave = false; throw new Error('Lost personal save response') }
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
const input = label => { const found = all(tree, el => el.type === 'textarea' && el.props['aria-label'] === label)[0]; assert(found, label); return found }
const fill = (label, value) => { const found = input(label); assert(!found.props.disabled, label); found.props.onChange({ target: { value } }); render() }
const remount = () => { owner.slots.forEach(state => state.cleanup?.()); updates.length = 0; owner = { slots: [], effects: [] }; render() }
try {
  const graphBefore = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
  render(); await settle()
  assert(button('保存我的理解').props.disabled)
  fill('我的联结规律', '仍待核对的个人解释；不是正确答案。')
  fill('尚未解决的问题', '缺少夜间费用时该如何判断？')
  props.active = false; render(); assert.equal(tree, null)
  props.active = true; render(); await settle()
  assert.equal(input('我的联结规律').props.value, '仍待核对的个人解释；不是正确答案。')
  props.modelId = 'unknown'; render(); await settle()
  assert.equal(input('我的联结规律').props.value, '')
  props.modelId = 'taxi'; render(); await settle()
  assert.equal(input('尚未解决的问题').props.value, '缺少夜间费用时该如何判断？')
  remount(); await settle()
  assert.equal(input('我的联结规律').props.value, '仍待核对的个人解释；不是正确答案。')
  const draftKey = 'dsh-kg-model-understanding:' + JSON.stringify([document.documentId, 'taxi'])
  const olderDraft = JSON.parse(storage.get(draftKey))
  olderDraft.practiceIds = ['older-not-in-page']
  storage.set(draftKey, JSON.stringify(olderDraft)); remount(); await settle()
  click('取消关联较早练习 older-not-in-page')
  assert.deepEqual(JSON.parse(storage.get(draftKey)).practiceIds, [], 'old selections outside the bounded history can still be removed')
  const save = button('保存我的理解'); save.props.onClick(); save.props.onClick(); render(); await settle()
  assert.equal(requests.filter(request => request.args.action === 'save').length, 1)
  assert(text(tree).includes('Lost personal save response'))
  assert.equal(input('我的联结规律').props.value, '仍待核对的个人解释；不是正确答案。')
  click('保存我的理解'); await settle()
  const saves = requests.filter(request => request.args.action === 'save')
  assert.equal(saves[0].args.attemptId, saves[1].args.attemptId)
  assert.equal(store.listLearningAttempts(document.documentId, 'taxi', 'understanding').length, 1)
  assert(text(tree).includes('未判定掌握'))
  let warned = false
  events.get('beforeunload')({ preventDefault: () => { warned = true } })
  assert(!warned, 'saved expression is not an unsaved draft')
  click('修订这份理解'); fill('我的联结规律', '保留未知条件，暂不做唯一预测。')
  assert(button('保存我的理解').props.disabled, 'revision requires a reason')
  fill('修改理由', '对照练习发现条件尚不充分。')
  confirm = false; click('放弃草稿')
  assert.equal(input('我的联结规律').props.value, '保留未知条件，暂不做唯一预测。')
  confirm = true
  const first = store.listLearningAttempts(document.documentId, 'taxi', 'understanding')[0]
  const peer = await post({ action: 'save', documentId: document.documentId, modelId: 'taxi', exercise: 'understanding',
    expectedRevision: 1, taskId: first.taskId, attemptId: 'peer', selfRating: 'not_assessed',
    response: { ...first.response, mapping: '另一个窗口的个人表述', parentAttemptId: first.attemptId, revisionReason: '另一个窗口修订' } })
  assert(!peer.error)
  click('保存我的理解'); await settle()
  assert(text(tree).includes('已有新版本'))
  assert.equal(input('我的联结规律').props.value, '保留未知条件，暂不做唯一预测。')
  click('重新读取个人表述'); await settle()
  assert(button('保存我的理解').props.disabled)
  assert(text(tree).includes('另一个窗口的个人表述'))
  click('以最新记录为基准保留草稿')
  assert.equal(input('我的联结规律').props.value, '保留未知条件，暂不做唯一预测。')
  store.saveGraph({ ...document.graph, summary: 'new source revision' }, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  props.revision = 2; render(); await settle()
  assert(text(tree).includes('内容未被覆盖'))
  assert(button('保存我的理解').props.disabled)
  click('对照当前模型后继续修订'); click('保存我的理解'); await settle()
  assert(text(tree).includes('图谱第 2 版'))
  const old = all(tree, el => el.type === 'button' && text(el).includes('图谱第 1 版'))[0]
  assert(old); old.props.onClick(); render()
  assert(text(tree).includes('来源图已更新'))
  assert(all(tree, el => el.type === 'button' && text(el) === '定位原文').every(el => el.props.disabled))
  click('修订这份理解'); fill('我的联结规律', '响应丢失后保留这份修订。'); fill('修改理由', '继续复盘')
  loseSave = true; click('保存我的理解'); await settle()
  assert(text(tree).includes('Lost personal save response'))
  remount(); await settle()
  assert(text(tree).includes('已确认此前保存的个人表述'))
  assert(!all(tree, el => el.type === 'textarea').length)
  assert.equal(store.listLearningAttempts(document.documentId, 'taxi', 'understanding').length, 4)
  click('修订这份理解'); fill('我的联结规律', '尚未保存的后续理解')
  paused = true; props.modelId = 'unknown'; render(); const oldResponses = deferred.splice(0)
  props.modelId = 'wrong'; render(); const freshResponses = deferred.splice(0)
  assert(oldResponses.every(request => request.signal.aborted))
  freshResponses.forEach(request => request.resolve()); await settle()
  oldResponses.forEach(request => request.resolve()); await settle()
  assert(text(tree).includes('最近 0 条'))
  paused = false; props.modelId = 'taxi'; render(); await settle()
  assert.equal(input('我的联结规律').props.value, '尚未保存的后续理解')
  warned = false; events.get('beforeunload')({ preventDefault: () => { warned = true } }); assert(warned)
  legacy = true; click('重新读取个人表述'); await settle()
  assert(text(tree).includes('Host 不支持保存'))
  assert(button('保存我的理解').props.disabled, 'legacy Host must not falsely acknowledge a personal save')
  assert.equal(input('我的联结规律').props.value, '尚未保存的后续理解')
  legacy = false; forged = true; click('重新读取个人表述'); await settle()
  assert(text(tree).includes('来源不一致'))
  assert(button('保存我的理解').props.disabled, 'a matching envelope cannot hide a snapshot for another model')
  assert.equal(input('我的联结规律').props.value, '尚未保存的后续理解')
  forged = false; click('重新读取个人表述'); await settle(); fill('修改理由', '检验晚到响应是否跨模型污染。')
  paused = true; click('保存我的理解'); const pendingWrite = deferred.splice(0)
  props.modelId = 'unknown'; render(); const unknownReads = deferred.splice(0)
  unknownReads.forEach(request => request.resolve()); await settle()
  pendingWrite.forEach(request => request.resolve()); await settle()
  assert.equal(input('我的联结规律').props.value, '', 'late successful write must not replace a different model draft')
  assert(text(tree).includes('最近 0 条'))
  paused = false; props.modelId = 'taxi'; render(); await settle()
  assert(!all(tree, el => el.type === 'textarea').length, 'acknowledged old-scope save is recovered when returning to that model')
  assert.equal(store.listLearningAttempts(document.documentId, 'taxi', 'understanding').length, 5)
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore)
  assert.deepEqual(store.getDocument(document.documentId).nodes, graphBefore.nodes)
  assert.deepEqual(store.getDocument(document.documentId).edges, graphBefore.edges)
  assert.equal(store.getDocumentRevision(document.documentId), 2, 'only explicit fixture source update changed the graph')
  owner.slots.forEach(state => state.cleanup?.()); owner = { slots: [], effects: [] }; updates.length = 0
  Component = context.window.KGViewer.ConnectionModelPanel
  let rootLegacy = true
  props.load = async args => {
    const result = await post(args, 'connection-models')
    if (rootLegacy) delete result.modelUnderstandingVersion
    return result
  }
  render(); await settle()
  assert(button('我的理解').props.disabled, 'mixed Host blocks the workbench entry before sending unsupported requests')
  assert(text(tree).includes('当前 Host 不支持保存我的理解'))
  const learningPanel = () => all(tree, el => el.type === context.window.KGViewer.ModelLearningPanel)[0]
  assert.equal(learningPanel().props.onUnderstanding, undefined, 'practice return action cannot bypass a missing Host capability')
  rootLegacy = false; click('重新读取模型'); await settle()
  assert(!button('我的理解').props.disabled)
  assert.equal(typeof learningPanel().props.onUnderstanding, 'function')
  console.log(JSON.stringify({ ok: true, actualSqliteHttp: true, doubleClickLocked: true, lostResponseRetry: true,
    remountRecovery: true, concurrentDraftPreserved: true, oldSourceExplicit: true, scopeRacesFenced: true, legacyHostBlocked: true,
    mixedHostEntryExplicit: true }))
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
