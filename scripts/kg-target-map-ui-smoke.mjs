import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createTargetMapTools } from '../src/kg-target-map.mjs'
import { targetMapFixture, motionTargetMap } from './kg-target-map-fixture-data.mjs'

let current, cursor = 0
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useRef: initial => slot(() => ({ current: initial })),
  useState(initial) {
    const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useEffect(fn, deps) {
    const owner = current, state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const storage = new Map(), tools = createTargetMapTools(), doc = targetMapFixture()
let storageFailure = false
const localStorage = { get length() { return storage.size }, key: i => [...storage.keys()][i], getItem: key => storage.get(key) || null,
  setItem: (key, value) => { if (storageFailure) throw new Error('quota'); storage.set(key, value) } }
const context = { window: { React }, localStorage, crypto: { randomUUID }, AbortController, console }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const Component = context.window.KGViewer.TargetMapPanel
assert.equal(typeof Component, 'function')
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
  : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
let records = [], writes = 0
const mount = (options = {}) => {
  const owner = { slots: [], effects: [], updates: [], requests: [] }
  const props = { documentId: doc.documentId, revision: doc.revision, active: true, busy: false, ...options,
    call: (args, signal) => new Promise((resolve, reject) => owner.requests.push({ args, signal, resolve, reject })) }
  owner.props = props
  owner.render = () => {
    for (let i = 0; i < 20; i++) {
      owner.updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
      owner.tree = Component(props); owner.effects.splice(0).forEach(fn => fn())
      if (!owner.updates.length) return
    }
    throw new Error('Update loop')
  }
  owner.control = label => {
    const found = all(owner.tree, node => node.props['aria-label'] === label || node.type === 'button' && text(node) === label)[0]
    assert(found, 'Missing control: ' + label); return found
  }
  owner.click = label => { const item = owner.control(label); assert(!item.props.disabled, label); item.props.onClick(); owner.render() }
  owner.change = (label, value, checked) => { const item = owner.control(label); assert(!item.props.disabled, label); item.props.onChange({ target: { value, checked } }); owner.render() }
  owner.settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); owner.render() } }
  owner.resolve = async (request, custom) => {
    const response = custom || tools.handle(doc, request.args, records)
    if (response.appendRecord) { records.push(response.appendRecord); delete response.appendRecord; writes++ }
    request.resolve(response); request.settled = true; await owner.settle()
  }
  owner.pending = () => owner.requests.filter(request => !request.settled)
  owner.load = async () => { for (const request of owner.pending()) await owner.resolve(request) }
  owner.unmount = () => { for (const state of owner.slots) state.cleanup?.() }
  owner.render(); return owner
}
const focus = { documentId: doc.documentId, revision: 1, targetId: 'motion' }
let owner = mount({ focusRequest: focus }); await owner.load()
owner.change('映射规律表述', '未保存的条件限定语')
owner.click('增加具体推测')
owner.change('例子 1 先记录预测', undefined, true)
assert(owner.control('例子 1 完整情境').props.value === '')
owner.click('打开靶图 externality'); await owner.load()
assert(text(owner.tree).includes('概念靶图'))
owner.click('打开靶图 motion'); await owner.load()
assert.equal(owner.control('映射规律表述').props.value, '未保存的条件限定语')
assert(owner.control('例子 1 先记录预测').props.checked, 'Incomplete prediction survived target navigation')
owner.unmount()
owner = mount({ focusRequest: focus }); await owner.load()
assert.equal(owner.control('映射规律表述').props.value, '未保存的条件限定语')
assert(owner.control('例子 1 先记录预测').props.checked)
owner.click('删除例子 1')
owner.change('确认保存个人靶图', undefined, true)
const submit = owner.control('保存个人靶图').props.onClick
submit(); submit(); owner.render()
assert.equal(owner.pending().filter(request => request.args.action === 'save').length, 1, 'Synchronous latch prevents double submission')
const failed = owner.pending().find(request => request.args.action === 'save')
failed.reject(new Error('temporary network failure')); failed.settled = true; await owner.settle()
assert(text(owner.tree).includes('temporary network failure'))
assert.equal(owner.control('映射规律表述').props.value, '未保存的条件限定语')
owner.click('保存个人靶图')
const retry = owner.pending().find(request => request.args.action === 'save')
assert.equal(retry.args.id, failed.args.id, 'Retry keeps idempotence identity')
await owner.resolve(retry)
assert.equal(writes, 1); assert(!owner.control('确认保存个人靶图').props.checked)
owner.change('映射规律表述', '本地并发草稿'); owner.change('本次修订理由', '修订限定语')
const competing = tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
  parentId: records[0].id, id: 'competing', reason: '另一窗口', confirm: true, map: motionTargetMap() }, records).saved
records.push(competing)
owner.change('确认保存个人靶图', undefined, true); owner.click('保存个人靶图'); await owner.load()
assert(text(owner.tree).includes('靶图已有新修订'))
owner.click('重读靶图'); await owner.load()
assert.equal(owner.control('映射规律表述').props.value, '本地并发草稿')
assert(text(owner.tree).includes('当前草稿未覆盖'))
owner.click('查看最新修订'); await owner.load()
assert.equal(owner.control('映射规律表述').props.value, competing.map.mapping)
assert(owner.control('映射规律表述').props.disabled)
owner.click('返回未保存草稿')
assert.equal(owner.control('映射规律表述').props.value, '本地并发草稿')
const confirmations = all(owner.tree, item => item.type === 'input' && item.props.type === 'checkbox')
assert(confirmations.every(item => !item.props.checked), 'Review is never implicit approval')
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
assert(text(owner.tree).includes('草稿属于知识图第 1 版'))
assert(owner.control('映射规律表述').props.disabled)
assert.equal(owner.control('映射规律表述').props.value, '本地并发草稿')
owner.click('开启当前版本靶图')
assert.equal(owner.control('映射规律表述').props.value, '')
assert(JSON.parse(storage.get('dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'motion', 1]))).map.mapping === '本地并发草稿')
owner.change('映射规律表述', '当前版本的新草稿')
owner.change('本地草稿版本', '1')
assert.equal(owner.control('映射规律表述').props.value, '本地并发草稿')
assert(owner.control('映射规律表述').props.disabled)
owner.click('开启当前版本靶图')
assert.equal(owner.control('映射规律表述').props.value, '当前版本的新草稿')
storageFailure = true; owner.change('映射规律表述', '内存草稿')
assert(text(owner.tree).includes('本地草稿存储不可用'))
assert.equal(owner.control('映射规律表述').props.value, '内存草稿')
storageFailure = false; owner.unmount()
storage.set('dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'externality', 2]), '{damaged')
owner = mount({ focusRequest: { ...focus, revision: 2, targetId: 'externality' } }); await owner.load()
assert(text(owner.tree).includes('本地草稿无法读取'))
owner.change('判别规律表述', '保持损坏存储，另记内存草稿')
assert.equal(storage.get('dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'externality', 2])), '{damaged')
owner.unmount()
owner = mount({ focusRequest: { ...focus, revision: 2 } })
const late = owner.pending().find(request => request.args.action === 'read')
owner.props.focusRequest = { ...focus, targetId: 'externality', revision: 2 }; owner.render()
await owner.resolve(owner.pending().at(-1)); await owner.resolve(late)
assert(text(owner.tree).includes('概念靶图'), 'Late old-target response cannot replace current map')
owner.unmount()
assert(owner.requests.every(request => !request.signal || request.signal.aborted))
owner = mount({ focusRequest: focus }); await owner.load()
assert(!owner.requests.some(request => request.args.action === 'read'), 'Stale focus cannot open a different graph version')
owner.unmount()
doc.revision = 1; storage.clear(); records = []
for (let index = 0; index < 47; index++) {
  const map = motionTargetMap(); map.mapping += ' 历史限定语 ' + index
  records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    parentId: records.at(-1)?.id || '', id: 'history-' + index, reason: '修订 ' + index, confirm: true, map }, records, 100 + index).saved)
}
const writesBeforePaging = writes
owner = mount({ focusRequest: focus }); await owner.load()
owner.change('映射规律表述', '分页期间的未保存限定语，AI 和来源冲突仍需核查')
const latestDraft = owner.control('映射规律表述').props.value
owner.click('较早的修订记录'); await owner.load()
assert(text(owner.tree).includes('第 21-40 / 47 版'))
owner.click('查看靶图修订 history-10'); await owner.load()
assert(owner.control('映射规律表述').props.value.endsWith('历史限定语 10'))
assert(owner.control('映射规律表述').props.disabled)
owner.click('返回未保存草稿'); assert.equal(owner.control('映射规律表述').props.value, latestDraft)
owner.click('较早的修订记录'); await owner.load()
assert(text(owner.tree).includes('第 41-47 / 47 版')); assert(owner.control('较早的修订记录').props.disabled)
owner.click('较新的修订记录')
const failedPage = owner.pending().find(item => item.args.action === 'history')
failedPage.reject(new Error('history transport unavailable')); failedPage.settled = true; await owner.settle()
assert(text(owner.tree).includes('history transport unavailable'))
assert.equal(owner.control('映射规律表述').props.value, latestDraft)
owner.click('重试读取修订记录')
assert.deepEqual(owner.pending().find(item => item.args.action === 'history').args, failedPage.args)
await owner.load(); assert(text(owner.tree).includes('第 21-40 / 47 版'))
for (const mutate of [
  value => { value.documentId = 'foreign' }, value => { value.target.id = 'speed-before' }, value => { value.revision++ },
  value => { value.offset++ }, value => { value.historyHead = 'wrong' }, value => { value.historyTotal = 0 },
  value => { value.history[1] = value.history[0] }, value => { value.history[0].baseRevision = 0 },
  value => { value.history[0].reason = null }, value => { value.history.pop() },
]) {
  owner.click('重新读取修订记录')
  const pending = owner.pending().find(item => item.args.action === 'history'), response = tools.handle(doc, pending.args, records)
  mutate(response); await owner.resolve(pending, response)
  assert(text(owner.tree).includes('修订记录响应身份或分页范围不一致'), mutate.toString())
  assert.equal(owner.control('映射规律表述').props.value, latestDraft)
}
owner.click('重新读取修订记录'); await owner.load()
const map = motionTargetMap()
records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
  parentId: records.at(-1).id, id: 'history-concurrent', reason: '并发新增', confirm: true, map }, records, 200).saved)
owner.click('较早的修订记录'); await owner.load()
assert(text(owner.tree).includes('修订记录有更新'))
assert(owner.control('较早的修订记录').props.disabled)
assert(!all(owner.tree, item => String(item.props['aria-label'] || '').startsWith('查看靶图修订 ')).length, 'Withdraw obsolete history page after append conflict')
owner.click('重新读取修订记录'); await owner.load()
assert(text(owner.tree).includes('最近 20 / 48 版')); assert.equal(owner.control('映射规律表述').props.value, latestDraft)
assert(!owner.control('确认保存个人靶图').props.checked)
const reread = owner.control('重新读取修订记录').props.onClick
reread(); reread(); owner.render()
const pendingPages = owner.pending().filter(item => item.args.action === 'history')
assert(pendingPages[0].signal.aborted)
await owner.resolve(pendingPages[1]); await owner.resolve(pendingPages[0], { error: { message: 'late old failure' } })
assert(!text(owner.tree).includes('late old failure'))
owner.click('较早的修订记录')
const oldTargetPage = owner.pending().find(item => item.args.action === 'history')
owner.click('打开靶图 externality'); await owner.load()
assert(oldTargetPage.signal.aborted); assert(!text(owner.tree).includes('修订 46')); assert(text(owner.tree).includes('概念靶图'))
owner.click('打开靶图 motion'); await owner.load(); owner.click('较早的修订记录')
const oldVersionPage = owner.pending().find(item => item.args.action === 'history')
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
assert(oldVersionPage.signal.aborted); assert(text(owner.tree).includes('草稿属于知识图第 1 版'))
assert.equal(owner.control('映射规律表述').props.value, latestDraft)
assert(owner.control('映射规律表述').props.disabled)
owner.click('较早的修订记录')
const hiddenPage = owner.pending().find(item => item.args.action === 'history')
owner.props.active = false; owner.render(); assert(hiddenPage.signal.aborted)
await owner.resolve(hiddenPage); owner.unmount()
assert.equal(writes, writesBeforePaging, 'History navigation and retries must not write personal records')

doc.revision = 1; storage.clear(); records = []
const roundMap = motionTargetMap(), roundPrediction = tools.example(roundMap, 'locked-prediction', 'prediction')
roundPrediction.context = '已记录的完整情境'; roundPrediction.process = '保留全部输入的原始推测'
roundPrediction.inputs.forEach(item => { item.value = '给定值' }); roundPrediction.outputs[0].outcomeId = 'rest'
roundMap.examples.push(roundPrediction)
records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion', id: 'round-original',
  parentId: '', reason: '', confirm: true, map: roundMap }, records).saved)
const originalRound = JSON.stringify(records[0]), roundWrites = writes
owner = mount({ focusRequest: focus }); await owner.load()
assert(owner.control('槽位 before 单位').props.disabled)
assert(owner.control('开启新一轮').props.disabled)
owner.change('新一轮理由', '纠正单位和对象/时间，旧预测继续保留')
owner.change('映射规律表述', '尚未保存的限定语')
assert(owner.control('确认开启新一轮').props.disabled)
assert(text(owner.tree).includes('先保存或核对当前改动'))
owner.change('映射规律表述', roundMap.mapping)
owner.change('确认开启新一轮', undefined, true)
const roundSubmit = owner.control('开启新一轮').props.onClick
roundSubmit(); roundSubmit(); owner.render()
const roundPending = owner.pending().filter(item => item.args.action === 'save')
assert.equal(roundPending.length, 1); assert.equal(roundPending[0].args.startRound, true)
assert.equal(roundPending[0].args.map.examples.length, 0)
assert(owner.control('新一轮理由').props.disabled)
const committedRound = tools.handle(doc, roundPending[0].args, records).saved
assert(committedRound.startsRound); records.push(committedRound)
roundPending[0].reject(new Error('round response lost')); roundPending[0].settled = true; await owner.settle()
assert(text(owner.tree).includes('round response lost')); assert.equal(owner.control('例子 3 完整情境').props.value, roundPrediction.context)
owner.click('开启新一轮')
const roundRetry = owner.pending().find(item => item.args.action === 'save')
assert.equal(roundRetry.args.id, roundPending[0].args.id); await owner.resolve(roundRetry)
assert(text(owner.tree).includes('新一轮已开启'))
assert(!owner.control('槽位 before 单位').props.disabled); assert(!owner.control('增加必要输入').props.disabled)
assert(!all(owner.tree, item => item.props['aria-label'] === '例子 1 完整情境').length)
assert(!owner.control('确认开启新一轮').props.checked)
assert.equal(writes, roundWrites, 'Only the deliberately committed lost response writes; retry is idempotent')
owner.change('槽位 before 单位', 'km/h'); owner.change('槽位 before 对象与时间', '另一物体、下一时刻')
owner.change('新一轮理由', '以后继续核对的草稿')
owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load()
assert.equal(owner.control('槽位 before 单位').props.value, 'km/h')
assert.equal(owner.control('新一轮理由').props.value, '以后继续核对的草稿')
owner.click('查看靶图修订 ' + committedRound.id); await owner.load()
assert(text(owner.tree).includes('新一轮起点'))
owner.click('查看上一轮末版'); await owner.load()
assert.equal(owner.control('例子 3 完整情境').props.value, roundPrediction.context)
assert(owner.control('例子 3 完整情境').props.disabled)
owner.click('返回未保存草稿'); assert.equal(owner.control('槽位 before 单位').props.value, 'km/h')
assert.equal(JSON.stringify(records[0]), originalRound)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
assert(owner.control('槽位 before 单位').props.disabled)
assert(owner.control('保存个人靶图').props.disabled)
assert.equal(owner.control('槽位 before 单位').props.value, 'km/h')
owner.unmount()
console.log(JSON.stringify({ ok: true, generatedComponent: true, draftNavigationAndReload: true, retryAndDoubleClick: true,
  casReview: true, versionIsolation: true, lateResponses: true, damagedStorageAndQuota: true, historyPagination: true,
  historyDraftPreserved: true, historyAppendFence: true, historyResponseFences: true, historyNoWrites: true, noAutoWrite: true,
  roundExplicitConfirmation: true, roundLostResponseRetry: true, roundHistoryAndDrafts: true, roundVersionFence: true }))
