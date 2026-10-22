import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { createGraphContract } from '../src/index.host.js'
import { connectionFixture } from './kg-connection-model-fixture-data.mjs'

const fixture = connectionFixture(), query = createGraphContract().connectionModels
const original = JSON.stringify(fixture), timers = new Map()
let current, cursor = 0, timerId = 0, writes = 0, confirmations = 0
const slot = init => { const i = cursor++; return current.slots[i] ||= init() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useRef: value => slot(() => ({ current: value })),
  useState(value) {
    const owner = current, state = slot(() => ({ value: typeof value === 'function' ? value() : value }))
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useEffect(fn, deps) {
    const owner = current, state = slot(() => ({}))
    if (!state.deps || deps.some((value, i) => !Object.is(value, state.deps[i]))) {
      owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const context = { window: { React, confirm: () => { confirmations++; return true } }, AbortController, console,
  setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
const source = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'ccd1382e48b22cac6f9011f569d97749b99a6e9c:extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
runInNewContext(source, context)
const Component = context.window.KGViewer.ConnectionModelPanel
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' || node.props.hidden ? []
  : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
const mount = (state = {}, doc = fixture) => {
  const owner = { slots: [], updates: [], effects: [], requests: [], snapshots: [], focused: 0, doc }
  owner.props = { documentId: doc.documentId, revision: 1,
    restoreState: { documentId: doc.documentId, revision: 1, modelId: 'taxi', tab: 'review', sourceOpen: true, ...state },
    load: (args, signal) => new Promise(resolve => owner.requests.push({ args, signal, resolve })),
    onStateChange: state => owner.snapshots.push(state), onRoles: () => { writes++; throw new Error('Filters cannot write') } }
  owner.render = (effects = true) => {
    for (let i = 0; i < 20; i++) {
      owner.updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
      owner.tree = Component(owner.props)
      for (const node of all(owner.tree, node => node.type === 'input' && node.props.ref)) {
        node.props.ref.current = { focus: () => owner.focused++ }
      }
      if (!effects) return
      owner.effects.splice(0).forEach(fn => fn())
      if (!owner.updates.length) return
    }
    throw new Error('Render loop')
  }
  owner.control = label => {
    const node = all(owner.tree, node => node.props['aria-label'] === label || node.props['aria-label']?.startsWith(label + '：') || node.type === 'button' && text(node) === label)[0]
    assert(node, 'Missing control: ' + label); return node
  }
  owner.click = label => { const node = owner.control(label); assert(!node.props.disabled); node.props.onClick(); owner.render() }
  owner.change = (label, value) => { owner.control(label).props.onChange({ target: { value } }); owner.render() }
  owner.settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); owner.render() } }
  owner.resolve = async request => { request.resolve(query(owner.doc, request.args)); await owner.settle() }
  owner.lastPage = () => owner.requests.filter(item => !item.args.modelId).at(-1)
  owner.filters = () => all(owner.tree, node => node.props['data-model-filter']).map(node => node.props['data-model-filter'])
  owner.options = () => text(owner.control('模型章节'))
  owner.unmount = () => owner.slots.forEach(state => state.cleanup?.())
  owner.render(); return owner
}
const state = { query: 'x > 3 → y', search: 'x > 3 → y', section: 'first', needsReview: true,
  concept: { nodeId: 'distance', text: '同名概念' }, role: 'input', offset: 20 }
const owner = mount(state)
await owner.resolve(owner.lastPage()); await owner.resolve(owner.requests.find(item => item.args.modelId))
assert.deepEqual(owner.filters(), ['query', 'section', 'review', 'concept', 'role'], 'Every active filter needs a visible, individually removable summary')
assert(text(owner.control('清除关键词筛选')).includes('x > 3 → y'), 'Query operators and direction must remain literal')
assert(text(owner.control('清除概念筛选')).includes('distance'), 'Equal names cannot hide canonical identity')
assert(text(owner.tree).includes('没有匹配的联结模型'))
assert(owner.control('查看全部模型'))
const chapters = owner.options()
owner.change('端点角色 distance', 'output')
owner.change('搜索联结模型', 'a pending search')
assert(text(owner.tree).includes('正在更新筛选…'))
assert(!all(owner.tree, node => node.props.className === 'kg-model-empty').length, 'An old empty result cannot describe a pending query')
assert.equal(timers.size, 1)
owner.click('清除关键词筛选')
assert.equal(timers.size, 0, 'Removing a pending query cancels the old debounce')
assert.equal(owner.lastPage().args.query, '')
assert.equal(owner.lastPage().args.offset, 0)
assert.equal(owner.lastPage().args.sectionId, 'first')
assert.equal(owner.lastPage().args.conceptId, 'distance')
assert.equal(owner.lastPage().args.role, 'input')
assert.equal(owner.lastPage().args.needsReview, true)
assert.equal(owner.options(), chapters, 'Document chapter choices stay visible during filtering')
assert.equal(owner.control('端点角色 distance').props.value, 'output', 'Filtering cannot discard an unsaved direction draft')
const retired = owner.lastPage(), count = owner.requests.length
owner.click('清除全部筛选')
assert.equal(owner.requests.length, count + 1, 'Clear all issues one catalogue read, no detail re-read')
assert(retired.signal.aborted)
assert.deepEqual(owner.filters(), [])
for (const name of ['query', 'sectionId', 'conceptId', 'role']) assert.equal(owner.lastPage().args[name], '')
assert.equal(owner.lastPage().args.needsReview, false)
assert.equal(owner.lastPage().args.offset, 0)
retired.resolve({ error: { message: 'retired filter response' } }); await owner.settle()
assert(!text(owner.tree).includes('retired filter response'))
await owner.resolve(owner.lastPage())
assert.equal(owner.snapshots.at(-1).modelId, 'taxi')
assert.equal(owner.snapshots.at(-1).tab, 'review')
assert.equal(owner.snapshots.at(-1).sourceOpen, true)
assert.equal(owner.control('端点角色 distance').props.value, 'output')
assert(owner.focused >= 2, 'Removing a disappearing filter restores keyboard focus to search')
assert(text(owner.tree).includes('当前 1–20 个'))
owner.click('下一页'); await owner.resolve(owner.lastPage())
assert(text(owner.tree).includes('当前 21–31 个'))
owner.change('模型章节', 'first')
owner.lastPage().resolve({ error: { message: 'current filter read failed' } }); await owner.settle()
assert(text(owner.tree).includes('current filter read failed'))
assert(!all(owner.tree, node => node.props.className === 'kg-model-empty').length, 'A failed request is not an empty result')
assert.equal(owner.options(), chapters)
const failedArgs = JSON.stringify(owner.lastPage().args), detailReads = owner.requests.filter(item => item.args.modelId).length
const beforeRetry = owner.requests.length, beforeFocus = owner.focused
owner.props.onRefresh = () => { throw new Error('Directory recovery cannot refresh the graph or discard drafts') }
const retryDirectory = owner.control('重试读取模型目录').props.onClick
retryDirectory(); retryDirectory(); owner.render()
assert.equal(owner.requests.length, beforeRetry + 1, 'Repeated activation before rendering admits one directory retry')
assert.equal(JSON.stringify(owner.lastPage().args), failedArgs, 'Retry keeps the exact document, revision, query, filters and page')
assert(!text(owner.tree).includes('current filter read failed'))
assert.equal(owner.focused, beforeFocus + 1, 'Focus returns to the persistent search control as retry disappears')
assert.equal(owner.control('端点角色 distance').props.value, 'output')
await owner.resolve(owner.lastPage())
assert.equal(owner.requests.filter(item => item.args.modelId).length, detailReads, 'Directory retry cannot remount or reload the selected detail')
assert.equal(owner.control('端点角色 distance').props.value, 'output')
assert.equal(owner.snapshots.at(-1).modelId, 'taxi')
assert.equal(owner.snapshots.at(-1).tab, 'review')
assert.equal(owner.snapshots.at(-1).sourceOpen, true)
retryDirectory(); owner.render()
assert.equal(owner.requests.length, beforeRetry + 1, 'A retired retry callback cannot fetch again after recovery')
owner.props.revision = 2; owner.render()
assert(!owner.options().includes('第一章 · 模型与实例'), 'Chapter metadata cannot survive a version change')
assert(!owner.snapshots.at(-1).topics, 'Only browsing intent may enter persisted state')
owner.unmount()

for (const change of ['document', 'revision', 'query', 'section', 'page', 'hidden', 'busy', 'unmount']) {
  const panel = mount(state)
  await panel.resolve(panel.requests.find(item => item.args.modelId))
  panel.lastPage().resolve({ error: { message: 'retired directory failure' } }); await panel.settle()
  const retry = panel.control('重试读取模型目录').props.onClick, requests = panel.requests.length
  if (change === 'document') panel.props.documentId = 'different-document'
  if (change === 'revision') panel.props.revision = 2
  if (change === 'query') panel.control('搜索联结模型').props.onChange({ target: { value: 'pending query' } })
  if (change === 'section') panel.control('模型章节').props.onChange({ target: { value: 'second' } })
  if (change === 'page') panel.control('上一页').props.onClick()
  if (change === 'hidden') panel.props.active = false
  if (change === 'busy') panel.props.busy = true
  if (change === 'unmount') panel.unmount()
  else panel.render(false)
  if (!['hidden', 'busy', 'unmount'].includes(change)) {
    assert(!text(panel.tree).includes('retired directory failure'), 'Retire old directory errors before effects: ' + change)
    assert(!all(panel.tree, node => node.type === 'button' && text(node) === '重试读取模型目录').length)
  }
  retry()
  assert.equal(panel.updates.length, 0, 'A retired or blocked callback cannot schedule a retry: ' + change)
  assert.equal(panel.requests.length, requests)
  if (change !== 'unmount') panel.unmount()
}

const interrupted = mount(state)
await interrupted.resolve(interrupted.requests.find(item => item.args.modelId))
interrupted.lastPage().resolve({ error: { message: 'first directory failure' } }); await interrupted.settle()
interrupted.click('重试读取模型目录')
const cancelledRetry = interrupted.lastPage()
interrupted.props.active = false; interrupted.render()
assert(cancelledRetry.signal.aborted)
interrupted.props.active = true; interrupted.render()
const currentRetry = interrupted.lastPage()
cancelledRetry.resolve({ error: { message: 'late cancelled retry' } }); await interrupted.settle()
assert(!text(interrupted.tree).includes('late cancelled retry'))
currentRetry.resolve({ error: { message: 'second directory failure' } }); await interrupted.settle()
interrupted.click('重试读取模型目录'); await interrupted.resolve(interrupted.lastPage())
assert(!text(interrupted.tree).includes('second directory failure'))
assert.equal(interrupted.requests.filter(item => item.args.modelId).length, 1)
interrupted.unmount()

for (const [label, field, expected] of [['清除章节筛选', 'sectionId', ''], ['清除待核对筛选', 'needsReview', false], ['清除作用筛选', 'role', ''], ['清除概念筛选', 'conceptId', '']]) {
  const panel = mount(state)
  panel.click(label)
  assert.equal(panel.lastPage().args[field], expected)
  assert.equal(panel.lastPage().args.query, state.query)
  assert.equal(panel.lastPage().args.offset, 0)
  if (field === 'conceptId') assert.equal(panel.lastPage().args.role, '', 'Clearing the concept also clears its dependent role')
  else if (field === 'role') assert.equal(panel.lastPage().args.conceptId, 'distance')
  panel.unmount()
}
const empty = mount({ modelId: '', query: 'no match', search: 'no match' })
await empty.resolve(empty.lastPage()); empty.click('查看全部模型'); await empty.resolve(empty.lastPage())
assert.equal(all(empty.tree, node => node.props['data-model-catalogue-row']).length, 20)
empty.unmount()
const last = mount({ offset: 100 })
await last.resolve(last.lastPage()); assert(text(last.tree).includes('当前页没有模型'))
last.click('返回第一页'); assert.equal(last.lastPage().args.offset, 0); last.unmount()
const noModels = structuredClone(fixture); noModels.graph.nodes = []; noModels.graph.edges = []
const blank = mount({ modelId: '' }, noModels)
await blank.resolve(blank.lastPage()); assert(text(blank.tree).includes('这份资料尚无联结模型'))
assert(!all(blank.tree, node => node.type === 'button' && text(node) === '查看全部模型').length)
blank.unmount()
assert.equal(timers.size, 0)
assert.equal(writes, 0); assert.equal(confirmations, 0); assert.equal(JSON.stringify(fixture), original)
console.log(JSON.stringify({ visibleFilters: 5, independentRemoval: true, singleClearAllRead: true, debounceCancelled: true,
  stableVersionScopedChapters: true, threeEmptyStates: true, currentReadErrorsPreserved: true, exactIdentityAndQuery: true,
  currentDetailAndDirectionDraftPreserved: true, keyboardFocusRestored: true, scopedDirectoryRetry: true,
  directoryRetryDoesNotReloadDetail: true, repeatedRetryAdmittedOnce: true, retiredRetryRejected: true, writes, browserGeometryNotTested: true }))
