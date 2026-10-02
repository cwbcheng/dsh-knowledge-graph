import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createGraphContract } from '../src/index.host.js'
import { connectionFixture } from './kg-connection-model-fixture-data.mjs'

const doc = connectionFixture(), query = createGraphContract().connectionModels
let current, cursor = 0
const updates = [], timers = new Map()
let timerId = 0
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } } },
  useState(initial) {
    const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useRef(initial) { return slot(() => ({ current: initial })) },
  useMemo(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((v, i) => !Object.is(v, state.deps[i]))) { state.value = fn(); state.deps = deps }; return state.value },
  useEffect(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((v, i) => !Object.is(v, state.deps[i]))) {
      current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const context = { window: { React }, console, AbortController, setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const Component = context.window.KGViewer.ConnectionModelPanel
assert.equal(typeof Component, 'function')
const requests = [], writes = [], located = []
const props = { documentId: doc.documentId, revision: 1,
  load(args, signal) { return new Promise((resolve, reject) => requests.push({ args, signal, resolve, reject })) },
  onLocate: reference => located.push(reference),
  onRoles: async request => { writes.push(request); return request.preview ? { saved: true } : { signature: 'approved', diff: [{ text: '距离', before: '', after: 'input' }] } },
}
const owner = { slots: [], effects: [] }
let tree
function render() {
  for (let i = 0; i < 20; i++) {
    updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
    tree = Component(props); owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('Component update loop')
}
async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); render() } }
const text = el => Array.isArray(el) ? el.map(text).join('') : el && typeof el === 'object' ? text(el.props?.children) : String(el ?? '')
const all = (el, fn) => Array.isArray(el) ? el.flatMap(child => all(child, fn)) : !el || typeof el !== 'object' ? [] : [...(fn(el) ? [el] : []), ...all(el.props?.children, fn)]
const button = label => {
  const item = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0]
  assert(item, 'Missing button: ' + label); return item
}
const click = label => { const item = button(label); assert(!item.props.disabled, 'Disabled: ' + label); item.props.onClick(); render() }
const resolve = async request => { request.resolve(query(doc, request.args)); await settle() }
render()
await resolve(requests[0])
await resolve(requests.find(request => request.args.modelId === 'taxi'))
assert(text(tree).includes('输入') && text(tree).includes('下层 · 具体情境与验证材料'))
assert(text(tree).includes('2 km 对应 10 元'))
assert.equal(writes.length, 0, 'browsing must issue no writes')
click('核对方向')
const inputRole = all(tree, el => el.type === 'select' && el.props['aria-label'] === '端点角色 distance')[0]
inputRole.props.onChange({ target: { value: 'output' } }); render()
click('预览方向修改'); await settle()
assert(text(tree).includes('待确认的方向修改'))
assert.equal(writes.length, 1)
assert.equal(writes[0].preview, null)
inputRole.props.onChange({ target: { value: '' } }); render()
assert(!text(tree).includes('确认保存方向'), 'editing invalidates approval')
click('预览方向修改'); await settle()
click('确认保存方向'); await settle()
assert.equal(writes.length, 3)
assert.equal(writes[2].preview.signature, 'approved')
await resolve(requests.filter(request => request.args.modelId === 'taxi').at(-1))
await resolve(requests.filter(request => !request.args.modelId).at(-1))

props.focusRequest = { documentId: doc.documentId, revision: props.revision, nodeId: 'unknown', type: 'connection_model' }; render()
const stale = requests.at(-1)
props.focusRequest = { documentId: doc.documentId, revision: props.revision, nodeId: 'wrong', type: 'connection_model' }; render()
const fresh = requests.at(-1)
assert(stale.signal.aborted, 'switching model aborts the old detail request')
await resolve(fresh)
assert(text(tree).includes('文本涉及错误示例'))
await resolve(stale)
assert(text(tree).includes('文本涉及错误示例'), 'late response cannot replace the selected model')
click('核对原文')
assert(text(tree).includes('模型引用'))
const sourceButton = button('原文 P5')
sourceButton.props.onClick(); await settle()
assert.equal(located[0].paragraph, 4)

const search = all(tree, el => el.type === 'input' && el.props['aria-label'] === '搜索联结模型')[0]
search.props.onChange({ target: { value: 'tail' } }); render()
for (const fn of [...timers.values()]) fn(); timers.clear(); render()
const searchRequest = requests.filter(request => !request.args.modelId).at(-1)
assert.equal(searchRequest.args.query, 'tail')
await resolve(searchRequest)
assert(text(tree).includes('跨窗口目标'))
const listItem = all(tree, el => el.type === 'button' && el.props.className === 'kg-model-list-item')[0]
listItem.props.onClick(); render()
const failure = requests.at(-1); failure.reject(new Error('fixture network error')); await settle()
assert(text(tree).includes('fixture network error'))
click('重新读取模型')
await resolve(requests.filter(request => request.args.modelId).at(-1))
assert(text(tree).includes('模型 24'))
click('返回上一个模型')
await resolve(requests.filter(request => request.args.modelId).at(-1))
assert(text(tree).includes('文本涉及错误示例'))

props.revision = 2; render()
assert(!text(tree).includes('模型引用'), 'a revision change removes stale detail immediately')
requests.at(-1).resolve({ error: { code: 'revision_conflict', message: '版本已变化' } }); await settle()
assert(text(tree).includes('版本已变化'))
const pending = requests.filter(request => !request.signal.aborted)
for (const state of owner.slots) state.cleanup?.()
assert(pending.every(request => request.signal.aborted), 'unmount aborts outstanding reads')
assert.equal(writes.length, 3, 'retries and navigation may never trigger another write')
console.log(JSON.stringify({ ok: true, staleResponsesRejected: true, previewApprovalInvalidation: true,
  errorRetry: true, wholeGraphSearch: true, sourceNavigation: true, unmountAborts: true }))
