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
const storageReadFailures = new Set()
const localStorage = { get length() { return storage.size }, key: i => [...storage.keys()][i], getItem: key => { if (storageReadFailures.has(key)) throw new Error('storage read'); return storage.get(key) ?? null },
  setItem: (key, value) => { if (storageFailure) throw new Error('quota'); storage.set(key, value) } }
const sessionStorage = {
  getItem(key) { if (current.navigationFailure.read) throw new Error('session read'); return current.navigation.get(key) ?? null },
  setItem(key, value) { if (current.navigationFailure.write) throw new Error('session quota'); current.navigation.set(key, value) },
}
const observers = new Set()
class ResizeObserver {
  constructor(callback) { this.callback = callback }
  observe(element) { this.element = element; observers.add(this) }
  disconnect() { observers.delete(this) }
}
const context = { window: { React }, localStorage, sessionStorage, crypto: { randomUUID }, AbortController, ResizeObserver, console }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const Component = context.window.KGViewer.TargetMapPanel
assert.equal(typeof Component, 'function')
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
  : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
let records = [], writes = 0
const mount = (options = {}) => {
  const owner = { slots: [], effects: [], updates: [], requests: [], navigation: options.navigation || new Map(), navigationFailure: options.navigationFailure || {} }
  if (options.slotNavigation || options.recordNavigation) {
    owner.domNodes = new Map(); owner.focused = null; owner.scrolled = []; owner.exampleDetails = new Map()
    owner.panel = { nodes: [], ownerDocument: { body: {}, activeElement: null },
      querySelectorAll(selector) {
        assert(['[data-target-slot]', '[data-target-example-slot]', '[data-target-record-view]', '[data-target-record-link]', '[data-target-example-list]', '[data-target-example-feedback]', '[data-target-example-heading]', '[data-target-example-pair-side]', '[data-target-gap-field]', '[data-target-removal]', '[data-target-remove-button]', '[data-target-outcome-list]'].includes(selector))
        const attribute = selector.slice(1, -1), nodes = this.nodes.filter(node => node.attribute === attribute && node.value !== owner.removedAnchor)
        return owner.duplicateAnchors ? [...nodes, ...nodes] : nodes
      },
    }
    if (options.readingPosition) {
      owner.flowShift = 0
      owner.outer = { parentElement: null, clientTop: 0, clientHeight: 900, scrollHeight: 6000, scrollTop: 80,
        getBoundingClientRect: () => ({ top: 0, height: owner.outer.clientHeight }) }
      owner.inner = { parentElement: owner.outer, clientTop: 0, clientHeight: 600, scrollHeight: 4000, scrollTop: 750,
        getBoundingClientRect: () => ({ top: 300 - owner.outer.scrollTop, height: owner.inner.clientHeight }) }
      owner.panel.parentElement = owner.inner
      owner.panel.ownerDocument.scrollingElement = owner.outer
      owner.panel.ownerDocument.documentElement = owner.outer
      owner.panel.ownerDocument.defaultView = { getComputedStyle: element => ({ overflowY: element === owner.inner ? 'auto' : 'visible' }) }
    }
  }
  if (options.directory) {
    let scrollTop = 0
    owner.directory = { rows: [], heights: [47, 89, 63], clientHeight: 150, clientTop: 0, visible: true,
      getBoundingClientRect() { return { top: 100, width: 220, height: this.visible ? this.clientHeight : 0 } },
      get scrollTop() { return scrollTop },
      set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.rows.reduce((sum, row) => sum + row.height, 0) - this.clientHeight)) },
      querySelectorAll(selector) { assert.equal(selector, '[data-target-catalogue-row]'); return this.rows },
    }
  }
  const props = { documentId: doc.documentId, revision: doc.revision, active: true, busy: false, ...options,
    call: (args, signal) => new Promise((resolve, reject) => owner.requests.push({ args, signal, resolve, reject })) }
  owner.props = props
  owner.render = () => {
    for (let i = 0; i < 20; i++) {
      owner.updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
      owner.tree = Component(props)
      if (owner.panel) {
        assert(owner.tree.props.ref, 'Slot navigation needs a panel-scoped DOM root')
        owner.tree.props.ref.current = owner.panel
        owner.slotSelectionHeight = all(owner.tree, item => item.props['data-target-slot'] && item.props['data-selected']).length ? 32 : 0
        const attributes = ['data-target-slot', 'data-target-example-slot', 'data-target-record-view', 'data-target-record-link', 'data-target-example-list', 'data-target-example-feedback', 'data-target-example-heading', 'data-target-example-pair-side', 'data-target-gap-field', 'data-target-removal', 'data-target-remove-button', 'data-target-outcome-list']
        owner.panel.nodes = all(owner.tree, item => attributes.some(attribute => item.props[attribute])).map(item => {
          const attribute = attributes.find(attribute => item.props[attribute]), value = item.props[attribute]
          const key = attribute + ':' + value
          if (!owner.domNodes.has(key)) owner.domNodes.set(key, { attribute, value,
            getAttribute: name => name === attribute ? value : null,
            getClientRects: () => props.active && !owner.domHidden ? [{}] : [],
            focus: options => { assert.equal(options.preventScroll, true); owner.focused = key; owner.panel.ownerDocument.activeElement = owner.domNodes.get(key) },
            contains: other => other === owner.domNodes.get(key),
            scrollIntoView: options => owner.scrolled.push({ key, options }),
          })
          const node = owner.domNodes.get(key)
          if (options.readingPosition) {
            node.getBoundingClientRect = () => ({ top: owner.inner.getBoundingClientRect().top +
              (['data-target-record-link', 'data-target-example-slot'].includes(attribute) ? 900 + owner.flowShift : 0) +
              (attribute === 'data-target-example-slot' ? owner.slotSelectionHeight : 0) - owner.inner.scrollTop, height: 32 })
            node.scrollIntoView = options => {
              owner.scrolled.push({ key, options })
              owner.inner.scrollTop = ['data-target-record-link', 'data-target-example-slot'].includes(attribute) ? 900 + owner.flowShift - (owner.inner.clientHeight - 32) / 2 : 0
            }
          }
          const gapPath = attribute === 'data-target-gap-field' ? JSON.parse(value) : null
          if (attribute === 'data-target-example-slot' || attribute === 'data-target-record-link' || attribute === 'data-target-example-heading' || gapPath?.[0] === 'examples' && gapPath.length > 1) {
            const exampleId = gapPath ? gapPath[1] : attribute === 'data-target-example-slot' ? JSON.parse(value)[0] : value
            if (!owner.exampleDetails.has(exampleId)) owner.exampleDetails.set(exampleId, { tagName: 'DETAILS', open: false, parentElement: owner.panel })
            node.parentElement = owner.exampleDetails.get(exampleId)
          } else if (attribute === 'data-target-example-pair-side') {
            owner.pairDetails ||= { tagName: 'DETAILS', open: false, parentElement: owner.panel }
            node.parentElement = owner.pairDetails
          } else node.parentElement = owner.panel
          return node
        })
      }
      if (owner.directory) {
        const list = all(owner.tree, item => item.props['aria-label'] === '靶图目标列表')[0]
        assert(list?.props.ref, 'Target catalogue needs its own scroll container; filters and paging must remain outside it')
        let y = 0
        owner.directory.rows = all(list, item => item.props['data-target-catalogue-row']).map((item, i) => {
          const start = y, height = owner.directory.heights[i % owner.directory.heights.length]; y += height
          return { dataset: { targetCatalogueRow: item.props['data-target-catalogue-row'] }, height,
            getBoundingClientRect: () => ({ top: 100 + start - owner.directory.scrollTop, bottom: 100 + start + height - owner.directory.scrollTop, height }) }
        })
        owner.directory.scrollTop = owner.directory.scrollTop
        list.props.ref.current = owner.directory
      }
      owner.effects.splice(0).forEach(fn => fn())
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
  owner.scroll = value => { owner.directory.scrollTop = value; owner.control('靶图目标列表').props.onScroll(); owner.render() }
  owner.resize = heights => {
    owner.directory.heights = heights; owner.render()
    for (const observer of observers) if (observer.element === owner.directory) observer.callback()
  }
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
const beforeRemovalPreview = JSON.stringify([...storage])
owner.click('删除例子 1')
assert.equal(JSON.stringify([...storage]), beforeRemovalPreview, 'Opening removal must not destroy the only locally saved draft')
owner.click('确认删除例子 1')
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
owner.click('打开靶图 motion'); await owner.load()
assert(!text(owner.tree).includes('本地草稿无法读取'), 'A healthy target must not inherit another target cache warning')
owner.click('打开靶图 externality'); await owner.load()
assert.equal(owner.control('判别规律表述').props.value, '保持损坏存储，另记内存草稿')
assert(text(owner.tree).includes('本地草稿无法读取'), 'Returning to a memory-only draft must restore its damaged-cache warning')
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

doc.revision = 1
let historyBrowseState
const publishHistoryBrowse = state => { historyBrowseState = state }
const toggleHistory = (owner, open) => {
  const details = owner.control('个人靶图修订记录')
  assert.equal(typeof details.props.onToggle, 'function', 'Revision-list expansion must survive a workbench round trip')
  details.props.onToggle({ currentTarget: { open } }); owner.render()
}
owner = mount({ focusRequest: focus, onStateChange: publishHistoryBrowse }); await owner.load()
toggleHistory(owner, true)
owner.change('映射规律表述', '保留修订页码时的草稿')
owner.click('较早的修订记录'); await owner.load()
assert.equal(historyBrowseState.historyPosition.offset, 20)
assert.equal(historyBrowseState.historyPosition.head, 'history-concurrent')
assert.equal(historyBrowseState.historyPosition.open, true)
owner.unmount()
owner = mount({ restoreState: historyBrowseState, onStateChange: publishHistoryBrowse }); await owner.load()
const resumedPage = owner.pending().find(item => item.args.action === 'history')
assert(resumedPage, 'Remount must read the saved page instead of silently returning to the first page')
assert.equal(resumedPage.args.offset, 20); assert.equal(resumedPage.args.historyHead, 'history-concurrent')
assert(!all(owner.tree, item => String(item.props['aria-label'] || '').startsWith('查看靶图修订 ')).length, 'Do not present the first page while restoring a different page')
await owner.resolve(resumedPage)
assert(text(owner.tree).includes('第 21-40 / 48 版'))
assert.equal(owner.control('个人靶图修订记录').props.open, true)
assert.equal(owner.control('映射规律表述').props.value, '保留修订页码时的草稿')
assert(!owner.control('确认保存个人靶图').props.checked)
toggleHistory(owner, false)
const collapsedHistory = JSON.parse(JSON.stringify(historyBrowseState))
owner.unmount()
owner = mount({ restoreState: collapsedHistory, onStateChange: publishHistoryBrowse }); await owner.load()
assert.equal(owner.control('个人靶图修订记录').props.open, false)
assert(!owner.requests.some(item => item.args.action === 'history'), 'Collapsed history does not eagerly fetch an older page')
toggleHistory(owner, true)
const failedResume = owner.pending().find(item => item.args.action === 'history')
failedResume.reject(new Error('resume temporarily unavailable')); failedResume.settled = true; await owner.settle()
assert(text(owner.tree).includes('resume temporarily unavailable'))
assert(!all(owner.tree, item => String(item.props['aria-label'] || '').startsWith('查看靶图修订 ')).length)
owner.render(); assert.equal(owner.requests.filter(item => item.args.action === 'history').length, 1, 'No automatic retry loop')
owner.click('重试读取修订记录')
assert.deepEqual(owner.pending().find(item => item.args.action === 'history').args, failedResume.args)
await owner.load()
assert(text(owner.tree).includes('第 21-40 / 48 版'))
owner.props.active = false; owner.render(); owner.props.active = true; owner.render()
assert(!owner.pending().some(item => item.args.action === 'history'), 'Wait for a fresh detail read after reactivation')
await owner.load()
const hiddenResume = owner.pending().find(item => item.args.action === 'history')
assert.equal(hiddenResume.args.historyHead, 'history-concurrent')
owner.props.active = false; owner.render(); assert(hiddenResume.signal.aborted)
await owner.resolve(hiddenResume, { error: { message: 'late hidden history error' } })
assert(!text(owner.tree).includes('late hidden history error'))
owner.props.active = true; owner.render(); await owner.load(); await owner.load()
assert(text(owner.tree).includes('第 21-40 / 48 版'))
const sameHistoryContext = JSON.parse(JSON.stringify(historyBrowseState))
owner.unmount()
for (const invalid of [
  { scope: 'foreign' }, { offset: -20 }, { offset: 1 }, { offset: 20.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
  { head: null }, { head: ' ' }, { head: 'x'.repeat(121) }, { head: '' }, { open: 'true' },
]) {
  owner = mount({ restoreState: { ...sameHistoryContext, historyPosition: { ...sameHistoryContext.historyPosition, ...invalid } }, onStateChange: publishHistoryBrowse })
  await owner.load()
  assert.equal(historyBrowseState.historyPosition, null, JSON.stringify(invalid))
  assert(!owner.requests.some(item => item.args.action === 'history'), 'Invalid navigation state cannot request a page')
  owner.unmount()
}
for (const contextChange of [{ documentId: 'another-document' }, { revision: 2 }, { targetId: 'externality' }]) {
  owner = mount({ restoreState: { ...sameHistoryContext, ...contextChange }, onStateChange: publishHistoryBrowse }); await owner.load()
  assert.equal(historyBrowseState.historyPosition, null)
  assert(!owner.requests.some(item => item.args.action === 'history'), 'History positions never cross document, revision or target identity')
  owner.unmount()
}
owner = mount({ restoreState: { ...sameHistoryContext, historyPosition: { ...sameHistoryContext.historyPosition, records, confirmed: true } }, onStateChange: publishHistoryBrowse })
await owner.load()
assert.deepEqual(Object.keys(historyBrowseState.historyPosition).sort(), ['head', 'offset', 'open', 'scope'])
const unmountedResume = owner.pending().find(item => item.args.action === 'history')
const oldToggle = owner.control('个人靶图修订记录').props.onToggle
owner.unmount(); assert(unmountedResume.signal.aborted)
await owner.resolve(unmountedResume, { error: { message: 'late unmounted history error' } })
const publishedBeforeStaleToggle = JSON.stringify(historyBrowseState)
oldToggle({ currentTarget: { open: false } }); owner.render()
assert.equal(JSON.stringify(historyBrowseState), publishedBeforeStaleToggle)
records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
  parentId: records.at(-1).id, id: 'history-during-absence', reason: '离开工作台期间新增', confirm: true, map: motionTargetMap() }, records, 201).saved)
owner = mount({ restoreState: sameHistoryContext, onStateChange: publishHistoryBrowse }); await owner.load(); await owner.load()
assert(text(owner.tree).includes('修订记录有更新'), 'A fresh detail head must not silently replace the saved paging fence')
assert(!all(owner.tree, item => String(item.props['aria-label'] || '').startsWith('查看靶图修订 ')).length)
assert.equal(historyBrowseState.historyPosition.head, 'history-concurrent')
owner.click('重新读取修订记录'); await owner.load()
assert(text(owner.tree).includes('最近 20 / 49 版'))
assert.equal(historyBrowseState.historyPosition.head, 'history-during-absence'); assert.equal(historyBrowseState.historyPosition.offset, 0)
assert.equal(owner.control('映射规律表述').props.value, '保留修订页码时的草稿')
owner.click('较早的修订记录'); await owner.load()
owner.click('打开靶图 externality'); await owner.load()
owner.click('打开靶图 motion'); await owner.load()
assert.equal(historyBrowseState.historyPosition, null, 'Returning to another target starts a new history context')
owner.click('较早的修订记录'); await owner.load()
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
assert.equal(historyBrowseState.historyPosition, null)
assert.equal(owner.control('个人靶图修订记录').props.open, false)
assert(owner.control('映射规律表述').props.disabled)
owner.unmount(); doc.revision = 1
assert.equal(writes, writesBeforePaging, 'Restoring, retrying and rejecting history navigation never writes a record')

storage.clear()
owner = mount({ focusRequest: focus, onStateChange: publishHistoryBrowse }); await owner.load()
toggleHistory(owner, true); owner.click('较早的修订记录'); await owner.load()
owner.change('映射规律表述', '另存一版后从新记录开始')
owner.change('本次修订理由', '保存后重置修订页码')
owner.change('确认保存个人靶图', undefined, true); owner.click('保存个人靶图'); await owner.load()
assert.equal(historyBrowseState.historyPosition.offset, 0); assert.equal(historyBrowseState.historyPosition.head, records.at(-1).id)
assert.equal(historyBrowseState.historyPosition.open, true); assert(!owner.pending().length)
assert(text(owner.tree).includes('最近 20 / 50 版'))
owner.click('较早的修订记录'); await owner.load()
owner.change('新一轮理由', '新轮次从新记录开始'); owner.change('确认开启新一轮', undefined, true)
owner.click('开启新一轮'); await owner.load()
assert.equal(historyBrowseState.historyPosition.offset, 0); assert.equal(historyBrowseState.historyPosition.head, records.at(-1).id)
assert.equal(historyBrowseState.historyPosition.open, true); assert(!owner.pending().length)
assert(text(owner.tree).includes('最近 20 / 51 版'))
owner.unmount()

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
doc.revision = 1; storage.clear(); records = []
let browseState
const onStateChange = state => { browseState = state }
owner = mount({ focusRequest: focus, onStateChange }); await owner.load()
owner.change('靶图类型', 'connection'); await owner.load()
owner.change('搜索靶图目标', '独立模型')
all(owner.tree, item => item.type === 'form')[0].props.onSubmit({ preventDefault() {} }); owner.render(); await owner.load()
owner.click('下一页'); await owner.load()
owner.click('打开靶图 extra-21'); await owner.load()
owner.change('映射规律表述', '返回工作台仍保留的未保存限定语')
owner.change('确认保存个人靶图', undefined, true)
owner.change('搜索靶图目标', '尚未提交的搜索')
owner.unmount()
assert.equal(browseState?.targetId, 'extra-21', 'Publish selected target before workbench history unmounts the panel')
assert.equal(browseState.search, '独立模型'); assert.equal(browseState.query, '尚未提交的搜索'); assert.equal(browseState.offset, 20)
assert(!('draft' in browseState) && !('detail' in browseState) && !('confirmed' in browseState), 'Browse cache contains intent, not edits or authority')
const savedBrowse = browseState
owner = mount({ restoreState: savedBrowse, focusRequest: focus, onStateChange })
assert(owner.pending().some(item => item.args.action === 'read' && item.args.targetId === 'extra-21'), 'Consumed focus must not override the restored target')
assert(owner.pending().some(item => item.args.action === 'catalog' && item.args.offset === 20 && item.args.query === '独立模型' && item.args.mode === 'connection'))
assert(!all(owner.tree, item => item.props['aria-label'] === '映射规律表述').length, 'Re-entry must re-read canonical detail, not display a cached response')
const failedRestore = owner.pending().find(item => item.args.action === 'read')
failedRestore.reject(new Error('restore transport unavailable')); failedRestore.settled = true; await owner.load()
assert(text(owner.tree).includes('restore transport unavailable'))
owner.click('重读靶图'); await owner.load()
assert.equal(owner.control('映射规律表述').props.value, '返回工作台仍保留的未保存限定语')
assert(!owner.control('确认保存个人靶图').props.checked)
assert(owner.control('保存个人靶图').props.disabled)
assert.equal(owner.control('搜索靶图目标').props.value, '尚未提交的搜索')
assert(owner.control('打开靶图 extra-21').props['aria-pressed'])
owner.props.focusRequest = { ...focus, targetId: 'speed-before', nonce: 1 }; owner.render(); await owner.load()
owner.change('判别规律表述', '同名速度第一身份的个人草稿')
owner.props.focusRequest = { ...focus, targetId: 'speed-after', nonce: 2 }; owner.render(); await owner.load()
owner.change('判别规律表述', '同名速度第二身份的个人草稿')
const latestFocus = owner.props.focusRequest; owner.unmount()
owner = mount({ restoreState: browseState, focusRequest: latestFocus }); await owner.load()
assert.equal(owner.control('判别规律表述').props.value, '同名速度第二身份的个人草稿')
assert(owner.pending().length === 0); owner.unmount()
for (const options of [{ documentId: 'another-document' }, { revision: 2 }]) {
  owner = mount({ restoreState: savedBrowse, focusRequest: focus, ...options })
  assert(!owner.requests.some(item => item.args.action === 'read'), 'Other document/revision must not inherit a target or stale focus')
  assert.equal(owner.control('搜索靶图目标').props.value, '')
  assert(owner.requests.some(item => item.args.action === 'catalog' && item.args.offset === 0 && item.args.query === ''))
  owner.unmount()
}
owner = mount({ restoreState: { ...savedBrowse, targetId: 'missing', query: { unsafe: true }, search: 'x'.repeat(257), mode: 'other', offset: -20,
  confirmed: true, detail: { current: records[0] }, draft: {} }, onStateChange })
assert.equal(owner.control('搜索靶图目标').props.value, '')
assert.equal(owner.control('靶图类型').props.value, 'all')
await owner.load(); assert(text(owner.tree).includes('目标节点不存在或身份不唯一'))
assert(!all(owner.tree, item => item.props['aria-label'] === '保存个人靶图').length); owner.unmount()
owner = mount({ restoreState: savedBrowse, active: false, onStateChange })
assert.equal(owner.requests.length, 0)
owner.props.active = true; owner.render()
const abandonedRead = owner.pending().find(item => item.args.action === 'read')
owner.unmount(); assert(abandonedRead.signal.aborted)
await owner.resolve(abandonedRead)
assert(!all(owner.tree, item => item.props['aria-label'] === '映射规律表述').length, 'Late response after unmount cannot install restored detail')
assert.equal(writes, roundWrites, 'Browsing restoration never writes a personal record')

doc.revision = 1; storage.clear(); records = []
const refreshNavigation = new Map(), refreshWrites = writes
owner = mount({ focusRequest: focus, navigation: refreshNavigation }); await owner.load()
owner.change('靶图类型', 'connection'); await owner.load()
owner.change('搜索靶图目标', '独立模型')
all(owner.tree, item => item.type === 'form')[0].props.onSubmit({ preventDefault() {} }); owner.render(); await owner.load()
owner.click('下一页'); await owner.load(); owner.click('打开靶图 extra-21'); await owner.load()
owner.change('映射规律表述', '刷新后保留的预测依据草稿')
owner.change('确认保存个人靶图', undefined, true)
owner.change('搜索靶图目标', '刷新后仍不提交的搜索')
const refreshDraftBytes = JSON.stringify([...storage]); owner.unmount()
owner = mount({ navigation: refreshNavigation })
assert(owner.requests.some(item => item.args.action === 'read' && item.args.targetId === 'extra-21'), 'A page reload must restore the target from tab-scoped navigation, without an in-memory restoreState')
assert(owner.requests.some(item => item.args.action === 'catalog' && item.args.offset === 20 && item.args.query === '独立模型' && item.args.mode === 'connection'))
await owner.load()
assert.equal(owner.control('搜索靶图目标').props.value, '刷新后仍不提交的搜索')
assert.equal(owner.control('映射规律表述').props.value, '刷新后保留的预测依据草稿')
assert(!owner.control('确认保存个人靶图').props.checked); assert(owner.control('保存个人靶图').props.disabled)
assert.equal(JSON.stringify([...storage]), refreshDraftBytes); assert.equal(writes, refreshWrites)
owner.unmount()
const navigationKey = (documentId = doc.documentId, revision = 1) => 'dsh-kg-target-navigation:' + JSON.stringify([documentId, revision])
const refreshValue = refreshNavigation.get(navigationKey()), refreshState = JSON.parse(refreshValue)
assert.deepEqual(Object.keys(refreshState).sort(), ['state', 'version'])
assert.deepEqual(Object.keys(refreshState.state).sort(), ['directoryPosition', 'documentId', 'examplePosition', 'historyPosition', 'mode', 'offset', 'query', 'revision', 'search', 'targetId'])
for (const options of [{ documentId: 'other-document' }, { revision: 2 }, { navigation: new Map() }]) {
  owner = mount({ navigation: new Map(refreshNavigation), ...options })
  assert(!owner.requests.some(item => item.args.action === 'read'), 'A different document, graph version or browser tab must not inherit navigation')
  assert.equal(owner.control('搜索靶图目标').props.value, ''); owner.unmount()
}
owner = mount({ navigation: new Map(refreshNavigation), restoreState: savedBrowse, focusRequest: { ...focus, targetId: 'speed-after' } })
await owner.load()
assert.equal(owner.control('判别规律表述').props.disabled, false)
assert(owner.requests.some(item => item.args.action === 'read' && item.args.targetId === 'speed-after'))
assert(owner.requests.filter(item => item.args.action === 'read' && item.args.targetId !== 'speed-after').every(item => item.signal.aborted))
owner.unmount()
owner = mount({ navigation: new Map(refreshNavigation), restoreState: { ...savedBrowse, targetId: 'motion', query: '窗口内的新位置', search: '', offset: 0 } })
assert(owner.requests.some(item => item.args.action === 'read' && item.args.targetId === 'motion'))
assert.equal(owner.control('搜索靶图目标').props.value, '窗口内的新位置'); owner.unmount()
const navAttack = new Map([[navigationKey(), JSON.stringify({ ...refreshState, state: { ...refreshState.state,
  focusRequest: { ...focus, targetId: 'speed-before' }, confirmed: true, compared: true, roundConfirmed: true,
  archive: { id: 'made-up' }, detail: {}, draft: {} } })]])
owner = mount({ navigation: navAttack }); await owner.load()
assert(owner.requests.every(item => !['save', 'record'].includes(item.args.action)))
assert.equal(owner.control('映射规律表述').props.value, '刷新后保留的预测依据草稿')
assert(!owner.control('确认保存个人靶图').props.checked)
assert.deepEqual(Object.keys(JSON.parse(navAttack.get(navigationKey())).state).sort(), Object.keys(refreshState.state).sort())
owner.unmount()
for (const raw of ['', '{broken', 'null', 'x'.repeat(50001), JSON.stringify({ ...refreshState, version: 2 }),
  JSON.stringify({ ...refreshState, state: { ...refreshState.state, documentId: 'other' } }),
  JSON.stringify({ ...refreshState, state: { ...refreshState.state, revision: 2 } })]) {
  const invalidNavigation = new Map([[navigationKey(), raw]])
  owner = mount({ navigation: invalidNavigation }); await owner.load()
  assert(!owner.requests.some(item => item.args.action === 'read'))
  assert(text(owner.tree).includes('本页导航位置无法读取'))
  owner.click('打开靶图 motion'); await owner.load(); owner.change('搜索靶图目标', '不能覆盖损坏位置')
  assert.equal(invalidNavigation.get(navigationKey()), raw)
  assert(!owner.control('映射规律表述').props.disabled); owner.unmount()
}
for (const failure of ['read', 'write']) {
  const failedNavigation = new Map(refreshNavigation), failureMode = { [failure]: true }
  owner = mount({ navigation: failedNavigation, navigationFailure: failureMode, focusRequest: focus }); await owner.load()
  assert(text(owner.tree).includes(failure === 'read' ? '本页导航位置无法读取' : '本页导航位置未能保存'))
  owner.change('映射规律表述', '导航存储失败时仍能编辑自己的模型')
  assert(!owner.control('映射规律表述').props.disabled)
  assert.equal(failedNavigation.get(navigationKey()), refreshValue)
  failureMode[failure] = false; owner.change('搜索靶图目标', '恢复存储后的新导航')
  if (failure === 'read') assert.equal(failedNavigation.get(navigationKey()), refreshValue, 'An unreadable original stays protected for this mount')
  else { assert.equal(JSON.parse(failedNavigation.get(navigationKey())).state.query, '恢复存储后的新导航'); assert(!text(owner.tree).includes('本页导航位置未能保存')) }
  owner.unmount()
}
const hiddenNavigation = new Map(refreshNavigation)
owner = mount({ navigation: hiddenNavigation, active: false })
assert.equal(owner.requests.length, 0); assert.equal(hiddenNavigation.get(navigationKey()), refreshValue)
owner.props.active = true; owner.render()
const lateRefresh = owner.pending().find(item => item.args.action === 'read')
owner.unmount(); assert(lateRefresh.signal.aborted)
await owner.resolve(lateRefresh)
assert(!all(owner.tree, item => item.props['aria-label'] === '映射规律表述').length)
const failedRefreshNavigation = new Map(refreshNavigation)
owner = mount({ navigation: failedRefreshNavigation })
const failedRefresh = owner.pending().find(item => item.args.action === 'read')
failedRefresh.reject(new Error('refresh synthetic 503')); failedRefresh.settled = true; await owner.load()
assert(text(owner.tree).includes('refresh synthetic 503')); assert.equal(owner.control('搜索靶图目标').props.value, '刷新后仍不提交的搜索')
owner.click('重读靶图'); await owner.load(); assert(!owner.control('确认保存个人靶图').props.checked); owner.unmount()
for (const targetId of ['speed-before', 'speed-after', ' x ', 'x'.repeat(4096), 'x'.repeat(4097)]) {
  const identityNavigation = new Map([[navigationKey(), JSON.stringify({ ...refreshState, state: { ...refreshState.state, targetId } })]])
  owner = mount({ navigation: identityNavigation })
  assert.equal(owner.requests.find(item => item.args.action === 'read')?.args.targetId, targetId.length <= 4096 ? targetId : undefined)
  owner.unmount()
}
const positionNavigation = new Map()
owner = mount({ navigation: positionNavigation, directory: true, focusRequest: focus }); await owner.load()
owner.scroll(47 + 89 + 63 * 0.4)
const pageScroll = owner.control('靶图目标列表').props.onScroll
owner.change('搜索靶图目标', '只输入不提交的行内位置'); const beforeStaleScroll = positionNavigation.get(navigationKey())
pageScroll(); owner.render(); assert.equal(positionNavigation.get(navigationKey()), beforeStaleScroll, 'A stale scroll callback cannot roll back the newer pending search')
owner.unmount()
owner = mount({ navigation: positionNavigation, directory: true }); await owner.load()
assert(Math.abs(owner.directory.scrollTop - (47 + 89 + 63 * 0.4)) < 0.0001)
assert.equal(owner.control('搜索靶图目标').props.value, '只输入不提交的行内位置')
const hiddenScroll = owner.control('靶图目标列表').props.onScroll
owner.props.active = false; owner.render(); const beforeHiddenScroll = positionNavigation.get(navigationKey())
hiddenScroll(); owner.render(); assert.equal(positionNavigation.get(navigationKey()), beforeHiddenScroll); owner.unmount()
for (const suffix of ['A', 'B']) {
  const longDocument = 'd'.repeat(4095) + suffix, longTarget = 't'.repeat(4095) + suffix
  const exactNavigation = new Map([[navigationKey(longDocument), JSON.stringify({ version: 1,
    state: { ...refreshState.state, documentId: longDocument, targetId: longTarget } })]])
  owner = mount({ navigation: exactNavigation, documentId: longDocument })
  assert(owner.requests.some(item => item.args.documentId === longDocument && item.args.targetId === longTarget))
  owner.unmount()
  owner = mount({ navigation: exactNavigation, documentId: longDocument.slice(0, -1) + (suffix === 'A' ? 'B' : 'A') })
  assert(!owner.requests.some(item => item.args.action === 'read')); owner.unmount()
}
records = []
for (let index = 0; index < 26; index++) {
  const result = tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    parentId: records.at(-1)?.id || '', id: 'refresh-history-' + index, reason: '独立的刷新历史夹具', confirm: true, map: motionTargetMap() }, records, index + 1)
  assert(result.saved); records.push(result.saved)
}
const historyNavigation = new Map(), historyOriginals = JSON.stringify(records)
owner = mount({ navigation: historyNavigation, focusRequest: focus }); await owner.load()
toggleHistory(owner, true); owner.click('较早的修订记录'); await owner.load()
owner.change('映射规律表述', '整页刷新仍保留历史之外的草稿')
owner.click('查看靶图修订 refresh-history-2'); await owner.load()
assert(text(owner.tree).includes('历史快照 · 知识图第 1 版')); assert(owner.control('映射规律表述').props.disabled); owner.unmount()
owner = mount({ navigation: historyNavigation }); await owner.load()
const restoredHistoryRequest = owner.pending().find(item => item.args.action === 'history')
assert.equal(restoredHistoryRequest.args.offset, 20); assert.equal(restoredHistoryRequest.args.historyHead, 'refresh-history-25')
assert(!owner.requests.some(item => item.args.action === 'record'), 'Restoring navigation must not reopen a cached archive or prediction basis')
await owner.load()
assert(text(owner.tree).includes('第 21-26 / 26 版'))
assert.equal(owner.control('映射规律表述').props.value, '整页刷新仍保留历史之外的草稿')
assert(!owner.control('确认保存个人靶图').props.checked); owner.unmount()
records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
  parentId: 'refresh-history-25', id: 'refresh-history-concurrent', reason: '刷新期间另一窗口保存', confirm: true, map: motionTargetMap() }, records, 100).saved)
owner = mount({ navigation: historyNavigation }); await owner.load(); await owner.load()
assert(text(owner.tree).includes('修订记录有更新'))
assert.equal(JSON.parse(historyNavigation.get(navigationKey())).state.historyPosition.offset, 20)
assert(!all(owner.tree, item => String(item.props['aria-label'] || '').startsWith('查看靶图修订 ')).length)
owner.click('重新读取修订记录'); await owner.load()
assert.equal(JSON.parse(historyNavigation.get(navigationKey())).state.historyPosition.offset, 0)
assert.equal(JSON.stringify(records.slice(0, 26)), historyOriginals)
assert.equal(owner.control('映射规律表述').props.value, '整页刷新仍保留历史之外的草稿'); owner.unmount()
assert.equal(writes, refreshWrites, 'Tab navigation never appends learning records')

doc.revision = 1; storage.clear(); records = []
const positionWrites = writes
owner = mount({ directory: true, focusRequest: focus, onStateChange }); await owner.load()
owner.scroll(47 + 89 + 63 * 0.4)
assert.equal(browseState.directoryPosition.nodeId, 'judge')
assert(Math.abs(browseState.directoryPosition.fraction - 0.4) < 0.0001)
owner.change('搜索靶图目标', '未提交的搜索不会更改目录')
owner.change('映射规律表述', '滚动恢复不改单位、对象和时间限定语')
const savedPosition = browseState
owner.unmount()
assert.equal(observers.size, 0, 'Resize observers must disconnect on unmount')
owner = mount({ directory: true, restoreState: savedPosition, focusRequest: focus, onStateChange })
assert.equal(owner.directory.scrollTop, 0, 'Do not restore against missing or cached catalogue rows')
await owner.load()
assert.equal(owner.directory.scrollTop, 47 + 89 + 63 * 0.4)
assert.equal(owner.control('映射规律表述').props.value, '滚动恢复不改单位、对象和时间限定语')
assert(!owner.control('确认保存个人靶图').props.checked)
owner.resize([101, 55, 80])
assert.equal(owner.directory.scrollTop, 101 + 55 + 80 * 0.4, 'Keep exact row identity and its fraction after wrapping changes')
const beforeHidden = JSON.stringify(browseState.directoryPosition)
owner.props.active = false; owner.directory.visible = false; owner.render(); owner.scroll(0)
owner.resize([31, 72, 140])
assert.equal(JSON.stringify(browseState.directoryPosition), beforeHidden, 'Hidden geometry cannot replace the reading point')
owner.props.active = true; owner.directory.visible = true; owner.render(); await owner.load()
assert.equal(owner.directory.scrollTop, 31 + 72 + 140 * 0.4)
const beforeFailure = JSON.stringify(browseState.directoryPosition)
owner.props.active = false; owner.render(); owner.props.active = true; owner.render()
const catalogFailure = owner.pending().find(item => item.args.action === 'catalog')
catalogFailure.reject(new Error('catalogue transport unavailable')); catalogFailure.settled = true; await owner.load()
assert(text(owner.tree).includes('catalogue transport unavailable'))
assert(!text(owner.tree).includes('正在读取目标…'), 'Failed catalogue must not leave a perpetual loading message')
assert.equal(JSON.stringify(browseState.directoryPosition), beforeFailure)
const readsBeforeRetry = owner.requests.filter(item => item.args.action === 'read').length
owner.click('重试读取靶图目录'); await owner.load()
assert.equal(owner.directory.scrollTop, 31 + 72 + 140 * 0.4)
assert.equal(owner.requests.filter(item => item.args.action === 'read').length, readsBeforeRetry, 'Catalogue retry must not reload the personal draft')
assert(!text(owner.tree).includes('catalogue transport unavailable'))
owner.props.active = false; owner.render(); owner.props.active = true; owner.render()
for (const mutate of [
  value => { value.documentId = 'foreign' }, value => { value.revision++ }, value => { value.offset++ },
  value => { value.total = -1 }, value => { value.items.pop() }, value => { value.items[1] = value.items[0] },
  value => { value.items[0].id = null }, value => { value.items[0].text = {} }, value => { value.items[0].type = 'image' },
]) {
  const pending = owner.pending().find(item => item.args.action === 'catalog'), response = tools.handle(doc, pending.args, records)
  mutate(response); await owner.resolve(pending, response)
  assert(text(owner.tree).includes('靶图目录响应身份不一致'), mutate.toString())
  assert.equal(owner.directory.rows.length, 0, 'Do not render mismatched catalogue rows')
  assert.equal(JSON.stringify(browseState.directoryPosition), beforeFailure, 'Invalid response cannot replace the reading point')
  owner.click('重试读取靶图目录')
}
await owner.load()
owner.scroll(31 + 72 + 140 + 31 + 72 * 0.2)
assert.equal(browseState.directoryPosition.nodeId, 'speed-after', 'Same-name targets have separate reading identities')
const sameNamePosition = browseState; owner.unmount()
owner = mount({ directory: true, restoreState: sameNamePosition, onStateChange }); await owner.load()
assert(Math.abs(owner.directory.scrollTop - (47 + 89 + 63 + 47 + 89 * 0.2)) < 0.0001)
owner.change('搜索靶图目标', '独立模型')
all(owner.tree, item => item.type === 'form')[0].props.onSubmit({ preventDefault() {} }); owner.render()
const obsoleteCatalog = owner.pending().find(item => item.args.action === 'catalog')
owner.change('靶图类型', 'connection'); await owner.load()
assert(obsoleteCatalog.signal.aborted)
assert.equal(owner.directory.scrollTop, 0, 'Applied search/type changes reset the reading point')
owner.scroll(100); owner.click('下一页'); await owner.load()
assert.equal(owner.directory.scrollTop, 0, 'Another catalogue page starts at the top')
owner.unmount()
for (const directoryPosition of [
  { ...savedPosition.directoryPosition, scope: 'foreign' }, { ...savedPosition.directoryPosition, nodeId: 'removed' },
  { ...savedPosition.directoryPosition, fraction: -1 }, { ...savedPosition.directoryPosition, fraction: Infinity },
  { ...savedPosition.directoryPosition, fraction: '0.4' },
]) {
  owner = mount({ directory: true, restoreState: { ...savedPosition, directoryPosition }, onStateChange }); await owner.load()
  assert.equal(owner.directory.scrollTop, 0, 'Malformed, foreign, or removed row anchors must not reposition the directory')
  owner.unmount()
}
owner = mount({ directory: true, restoreState: savedPosition, revision: 2, onStateChange })
const changedVersion = owner.pending().find(item => item.args.action === 'catalog')
doc.revision = 2; await owner.resolve(changedVersion)
assert.equal(owner.directory.scrollTop, 0, 'Revision change must not restore an old reading point')
owner.unmount()
assert.equal(observers.size, 0); assert.equal(writes, positionWrites)

doc.revision = 1; storage.clear(); records = []
const slotMap = motionTargetMap()
records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion', id: 'slot-original',
  parentId: '', reason: '', confirm: true, map: slotMap }, records).saved)
const slotRecordsBefore = JSON.stringify(records), slotWrites = writes
owner = mount({ slotNavigation: true, focusRequest: focus }); await owner.load()
owner.change('映射规律表述', '下上对照期间的个人限定语')
const localBeforeNavigation = JSON.stringify([...storage])
owner.click('对应输入槽位 before')
assert.equal(owner.focused, 'data-target-slot:' + JSON.stringify(['input', 'before']))
assert.equal(owner.scrolled.at(-1).options.block, 'start')
assert(all(owner.tree, item => item.props['data-target-slot'] === JSON.stringify(['input', 'before']))[0].props['data-selected'])
const returnInput = owner.control('返回例子 1 的具体输入').props.onClick
owner.click('返回例子 1 的具体输入')
assert.equal(owner.focused, 'data-target-example-slot:' + JSON.stringify(['material-0', 'input', 'before']))
assert(owner.exampleDetails.get('material-0').open, 'Return opens only its original example')
assert(!owner.exampleDetails.get('material-1').open)
assert(!all(owner.tree, item => item.props['data-selected']).length)
const secondOutput = all(owner.tree, item => item.props['data-target-example-slot'] === JSON.stringify(['material-1', 'output', 'after']))[0]
secondOutput.props.onClick(); owner.render()
assert.equal(owner.focused, 'data-target-slot:' + JSON.stringify(['output', 'after']), 'Same-name input and output stay distinct')
owner.click('返回例子 2 的具体输出')
assert.equal(owner.focused, 'data-target-example-slot:' + JSON.stringify(['material-1', 'output', 'after']))
assert.equal(JSON.stringify([...storage]), localBeforeNavigation, 'Reading navigation does not edit or cache a changed draft')
owner.duplicateAnchors = true; const duplicateCount = owner.scrolled.length
owner.click('对应输入槽位 before'); assert.equal(owner.scrolled.length, duplicateCount, 'Ambiguous DOM identities are not guessed')
owner.duplicateAnchors = false
owner.click('对应输入槽位 before')
const staleJump = owner.control('对应输入槽位 before').props.onClick
owner.click('打开靶图 externality'); await owner.load()
const afterTargetChange = owner.scrolled.length
staleJump(); returnInput(); owner.render()
assert.equal(owner.scrolled.length, afterTargetChange, 'Detached callbacks cannot move focus in another target')
assert(!all(owner.tree, item => item.props['data-selected']).length)
owner.click('打开靶图 motion'); await owner.load()
assert(!all(owner.tree, item => item.props['data-selected']).length, 'Returning to a target does not revive a stale jump')
owner.click('对应输入槽位 before'); owner.click('查看靶图修订 slot-original'); await owner.load()
assert(!all(owner.tree, item => item.props['data-selected']).length, 'A history snapshot has a distinct navigation scope')
owner.click('对应输出槽位 after'); owner.click('返回例子 1 的具体输出')
assert(owner.control('映射规律表述').props.disabled, 'Read-only snapshots still support reading navigation')
owner.click('返回未保存草稿')
assert.equal(owner.control('映射规律表述').props.value, '下上对照期间的个人限定语')
owner.click('对应输入槽位 before')
const hiddenJump = owner.control('对应输入槽位 before').props.onClick
owner.props.active = false; owner.render(); const afterHidden = owner.scrolled.length
hiddenJump(); owner.render(); assert.equal(owner.scrolled.length, afterHidden)
owner.props.active = true; owner.render(); await owner.load()
assert(!all(owner.tree, item => item.props['data-selected']).length)
owner.click('对应输入槽位 before')
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
const afterVersion = owner.scrolled.length; returnInput(); staleJump(); owner.render()
assert.equal(owner.scrolled.length, afterVersion)
assert(!all(owner.tree, item => item.props['data-selected']).length)
owner.click('对应输入槽位 before'); owner.click('返回例子 1 的具体输入')
assert(owner.control('映射规律表述').props.disabled)
assert.equal(owner.control('映射规律表述').props.value, '下上对照期间的个人限定语')
owner.unmount()
const afterUnmount = owner.scrolled.length; hiddenJump(); owner.render()
assert.equal(owner.scrolled.length, afterUnmount, 'Unmounted callbacks cannot move focus')
doc.revision = 1; storage.clear()
owner = mount({ slotNavigation: true, focusRequest: focus }); await owner.load()
owner.domHidden = true; owner.click('对应输入槽位 before')
assert.equal(owner.scrolled.length, 0, 'A hidden ancestor cannot receive programmatic focus')
owner.domHidden = false; owner.click('对应输入槽位 before')
const deletedReturn = owner.control('返回例子 1 的具体输入').props.onClick, deletedJump = owner.control('对应输入槽位 before').props.onClick
owner.click('删除例子 1'); owner.click('确认删除例子 1'); const afterDelete = owner.scrolled.length
deletedReturn(); deletedJump(); owner.render()
assert.equal(owner.scrolled.length, afterDelete, 'Deleted example identity cannot be replaced by another example sharing the slot')
assert(!all(owner.tree, item => item.props['data-selected']).length)
owner.click('对应输入槽位 before')
const otherDocumentJump = owner.control('对应输入槽位 before').props.onClick
owner.props.documentId = 'different-document'; owner.render(); const afterDocument = owner.scrolled.length
otherDocumentJump(); owner.render(); assert.equal(owner.scrolled.length, afterDocument)
owner.unmount()
assert.equal(JSON.stringify(records), slotRecordsBefore); assert.equal(writes, slotWrites)
for (const trip of ['input', 'output', 'reflow', 'resize', 'edited-map', 'snapshot']) {
  doc.revision = 1; storage.clear()
  owner = mount({ slotNavigation: true, readingPosition: true, focusRequest: focus }); await owner.load()
  if (trip === 'snapshot') { owner.click('查看靶图修订 slot-original'); await owner.load(); owner.inner.scrollTop = 750 }
  const role = trip === 'output' ? 'output' : 'input', slotId = role === 'input' ? 'before' : 'after'
  const identity = JSON.stringify(['material-1', role, slotId]), key = 'data-target-example-slot:' + identity
  const entry = () => owner.domNodes.get(key)
  const initialTop = entry().getBoundingClientRect().top, localDrafts = JSON.stringify([...storage]), navigationBefore = JSON.stringify([...owner.navigation])
  const jump = all(owner.tree, item => item.props['data-target-example-slot'] === identity)[0].props.onClick
  jump(); owner.render()
  const label = '返回例子 2 的具体' + (role === 'input' ? '输入' : '输出')
  if (['reflow', 'resize'].includes(trip)) { owner.flowShift = 240; owner.outer.scrollTop = 0 }
  if (trip === 'resize') owner.outer.clientHeight = 250
  if (trip === 'edited-map') {
    const staleReturn = owner.control(label).props.onClick
    owner.change('映射规律表述', '仍需全部输入，单位、对象、时间与限定语不变')
    const position = [owner.inner.scrollTop, owner.outer.scrollTop], count = owner.scrolled.length
    jump(); staleReturn(); owner.render()
    assert.deepEqual([owner.inner.scrollTop, owner.outer.scrollTop], position, 'Detached map callbacks cannot restore an old position')
    assert.equal(owner.scrolled.length, count)
  }
  owner.click(label)
  assert.equal(entry().getBoundingClientRect().top, trip === 'resize' ? 218 : initialTop,
    'Return to the exact example reading offset, not viewport center: ' + trip)
  assert.equal(owner.focused, key); assert(owner.exampleDetails.get('material-1').open)
  assert.equal(owner.scrolled.at(-1).options.block, 'start', 'A valid anchor return must not recenter')
  if (trip !== 'edited-map') assert.equal(JSON.stringify([...storage]), localDrafts)
  else assert.equal(owner.control('映射规律表述').props.value, '仍需全部输入，单位、对象、时间与限定语不变')
  if (trip === 'snapshot') assert(owner.control('映射规律表述').props.disabled)
  assert.equal(JSON.stringify([...owner.navigation]), navigationBefore, 'Temporary reading offsets are never serialized')
  assert.equal(JSON.stringify(records), slotRecordsBefore); assert.equal(writes, slotWrites)
  owner.unmount()
}
for (const invalid of ['replaced-scroller', 'hidden-origin', 'missing-origin', 'duplicate-origin']) {
  storage.clear()
  owner = mount({ slotNavigation: true, readingPosition: true, focusRequest: focus }); await owner.load()
  if (invalid === 'hidden-origin') owner.inner.scrollTop = 0
  owner.click('对应输入槽位 before')
  const oldScroller = owner.inner, oldTop = oldScroller.scrollTop, count = owner.scrolled.length, focused = owner.focused
  if (invalid === 'replaced-scroller') { owner.inner = { ...oldScroller }; owner.panel.parentElement = owner.inner }
  if (invalid === 'missing-origin') owner.removedAnchor = JSON.stringify(['material-0', 'input', 'before'])
  if (invalid === 'duplicate-origin') owner.duplicateAnchors = true
  owner.click('返回例子 1 的具体输入')
  if (['missing-origin', 'duplicate-origin'].includes(invalid)) {
    assert.equal(owner.scrolled.length, count); assert.equal(owner.focused, focused, 'Never substitute another example with the same slot')
  } else assert.equal(owner.scrolled.at(-1).options.block, 'center', 'An unavailable offset falls back to the exact visible identity')
  if (invalid === 'replaced-scroller') assert.equal(oldScroller.scrollTop, oldTop, 'A detached scroller must remain untouched')
  owner.unmount()
}
storage.clear()
owner = mount({ slotNavigation: true, readingPosition: true, focusRequest: focus }); await owner.load()
owner.click('对应输入槽位 before')
const pendingSlotJump = owner.control('对应输入槽位 before').props.onClick, pendingSlotReturn = owner.control('返回例子 1 的具体输入').props.onClick
owner.click('查看靶图修订 slot-original')
const pendingSlotPosition = [owner.inner.scrollTop, owner.outer.scrollTop], pendingSlotCount = owner.scrolled.length
pendingSlotJump(); pendingSlotReturn(); owner.render()
assert.deepEqual([owner.inner.scrollTop, owner.outer.scrollTop], pendingSlotPosition, 'Pending snapshot reads invalidate slot reading actions')
assert.equal(owner.scrolled.length, pendingSlotCount)
assert(!all(owner.tree, item => item.props['data-selected']).length)
await owner.load()
owner.inner.scrollTop = 750; owner.click('对应输入槽位 before')
const compareSlotJump = owner.control('对应输入槽位 before').props.onClick
owner.click('对照上层表述')
const compareSlotCount = owner.scrolled.length; compareSlotJump(); owner.render()
assert.equal(owner.scrolled.length, compareSlotCount, 'Comparison views cannot revive detached slot navigation')
owner.click('快照内容')
assert(!all(owner.tree, item => item.props['data-selected']).length, 'Leaving a comparison does not revive an obsolete reading point')
assert.equal(JSON.stringify(records), slotRecordsBefore); assert.equal(writes, slotWrites)
owner.unmount()
doc.revision = 1; storage.clear(); records = []
for (let index = 0; index < 2; index++) {
  const map = motionTargetMap(); map.mapping = '不可改写的历史表述 ' + index
  records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    parentId: records.at(-1)?.id || '', id: 'preview-' + index, reason: '快照 ' + index, confirm: true, map }, records, 200 + index).saved)
}
const previewRecords = JSON.stringify(records), previewWrites = writes
owner = mount({ focusRequest: focus }); await owner.load()
owner.change('映射规律表述', '取消历史读取后继续编辑的草稿')
owner.click('查看靶图修订 preview-0'); await owner.load()
owner.click('查看靶图修订 preview-1')
const dismissedPreview = owner.pending().find(item => item.args.action === 'record')
owner.click('返回未保存草稿')
await owner.resolve(dismissedPreview)
assert.equal(owner.control('映射规律表述').props.value, '取消历史读取后继续编辑的草稿', 'A late history response must not reopen a snapshot after returning to the draft')
assert(!owner.control('映射规律表述').props.disabled)
assert(dismissedPreview.signal.aborted)
owner.change('确认保存个人靶图', undefined, true)
const saveBeforePreview = owner.control('保存个人靶图').props.onClick
owner.click('查看靶图修订 preview-0')
const cancelledPreview = owner.pending().find(item => item.args.action === 'record')
assert(text(owner.control('历史靶图读取')).includes('正在读取历史靶图'))
assert(owner.control('映射规律表述').props.disabled && !owner.control('确认保存个人靶图').props.checked)
saveBeforePreview(); owner.render()
assert(!owner.pending().some(item => item.args.action === 'save'), 'A stale save callback cannot write while a snapshot is loading')
const staleCancel = owner.control('取消读取历史靶图').props.onClick
owner.click('取消读取历史靶图')
assert(cancelledPreview.signal.aborted && !owner.control('映射规律表述').props.disabled)
saveBeforePreview(); owner.render()
assert(!owner.pending().some(item => item.args.action === 'save'), 'Cancelling a read must not revive an earlier save approval')
owner.click('查看靶图修订 preview-1')
const replacementPreview = owner.pending().find(item => item !== cancelledPreview && item.args.action === 'record')
staleCancel(); owner.render()
assert(!replacementPreview.signal.aborted, 'A stale cancel button cannot cancel a later request')
cancelledPreview.reject(new Error('cancelled late transport failure')); cancelledPreview.settled = true; await owner.settle()
assert(!text(owner.tree).includes('cancelled late transport failure'))
assert(text(owner.tree).includes('正在读取历史靶图'))
await owner.resolve(replacementPreview)
assert.equal(owner.control('映射规律表述').props.value, '不可改写的历史表述 1')
const staleReturn = owner.control('返回未保存草稿').props.onClick
owner.click('查看靶图修订 preview-0'); await owner.load()
staleReturn(); owner.render()
assert.equal(owner.control('映射规律表述').props.value, '不可改写的历史表述 0', 'An old return callback cannot dismiss a newer snapshot')
owner.click('查看靶图修订 preview-1')
const failedPreview = owner.pending().find(item => item.args.action === 'record')
failedPreview.reject(new Error('snapshot transport unavailable')); failedPreview.settled = true; await owner.settle()
assert(text(owner.tree).includes('历史靶图读取失败：snapshot transport unavailable'))
assert.equal(owner.control('映射规律表述').props.value, '不可改写的历史表述 0', 'A failed request preserves the currently displayed snapshot')
owner.click('重试读取历史靶图')
const retriedPreview = owner.pending().find(item => item.args.action === 'record')
assert.deepEqual(retriedPreview.args, failedPreview.args)
assert.notEqual(retriedPreview.signal, failedPreview.signal)
await owner.resolve(retriedPreview)
owner.click('返回未保存草稿')
assert.equal(owner.control('映射规律表述').props.value, '取消历史读取后继续编辑的草稿')
assert(!owner.control('确认保存个人靶图').props.checked)
owner.click('查看靶图修订 preview-0')
const replacedPreview = owner.pending().find(item => item.args.action === 'record')
owner.click('查看靶图修订 preview-1')
const latestPreview = owner.pending().find(item => item !== replacedPreview && item.args.action === 'record')
assert(replacedPreview.signal.aborted)
await owner.resolve(latestPreview); await owner.resolve(replacedPreview)
assert.equal(owner.control('映射规律表述').props.value, '不可改写的历史表述 1', 'Only the latest explicit snapshot request can complete')
owner.click('返回未保存草稿')
for (const mutate of [
  value => { value.documentId = 'foreign' }, value => { value.revision++ },
  value => { value.record.id = 'different-record' }, value => { value.record.target.id = 'externality' },
  value => { value.record.map.slots[1].id = value.record.map.slots[0].id },
]) {
  owner.click('查看靶图修订 preview-0')
  const request = owner.pending().find(item => item.args.action === 'record')
  const response = structuredClone(tools.handle(doc, request.args, records)); mutate(response)
  await owner.resolve(request, response)
  assert(text(owner.tree).includes('历史靶图读取失败：'))
  assert.equal(owner.control('映射规律表述').props.value, '取消历史读取后继续编辑的草稿')
  assert(!owner.control('确认保存个人靶图').props.checked)
}
owner.click('查看靶图修订 preview-0')
const conflictPreview = owner.pending().find(item => item.args.action === 'record')
await owner.resolve(conflictPreview, { error: { code: 'revision_conflict', message: '测试版本已更新' } })
assert(owner.control('重试读取历史靶图').props.disabled && owner.control('保存个人靶图').props.disabled)
owner.click('查看靶图修订 preview-1'); owner.click('取消读取历史靶图')
assert(owner.control('映射规律表述').props.disabled, 'Cancelling a read cannot remove a graph revision conflict')
owner.click('查看靶图修订 preview-0')
const reloadedPreview = owner.pending().find(item => item.args.recordId === 'preview-0')
owner.click('重读靶图'); assert(reloadedPreview.signal.aborted)
await owner.resolve(reloadedPreview); await owner.load()
assert(!text(owner.tree).includes('历史快照 ·') && !owner.control('映射规律表述').props.disabled)
const staleOpen = owner.control('查看靶图修订 preview-0').props.onClick
owner.unmount()
const requestCount = owner.requests.length; staleOpen(); owner.render()
assert.equal(owner.requests.length, requestCount, 'Unmounted record callbacks cannot start reads')
for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount']) {
  storage.clear(); doc.revision = 1
  owner = mount({ focusRequest: focus }); await owner.load()
  owner.change('映射规律表述', '上下文边界草稿')
  owner.click('查看靶图修订 preview-0')
  const request = owner.pending().find(item => item.args.action === 'record')
  const response = tools.handle(doc, request.args, records)
  if (boundary === 'target') owner.click('打开靶图 externality')
  if (boundary === 'document') { owner.props.documentId = 'other-document'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  assert(request.signal.aborted || request.settled, 'Record read cancelled at ' + boundary)
  await owner.resolve(request, response)
  assert(!text(owner.tree).includes('历史快照 ·'), 'Late snapshot stays dismissed at ' + boundary)
  if (boundary !== 'unmount') owner.unmount()
}
doc.revision = 1; storage.clear()
owner = mount({ focusRequest: focus }); await owner.load()
owner.change('新一轮理由', '核对历史后重新拆分变量')
owner.change('确认开启新一轮', undefined, true)
const staleRound = owner.control('开启新一轮').props.onClick
owner.click('查看靶图修订 preview-0'); owner.click('取消读取历史靶图')
staleRound(); owner.render()
assert(!owner.pending().some(item => item.args.action === 'save') && !owner.control('确认开启新一轮').props.checked,
  'Cancelled history inspection cannot restore an earlier new-round approval')
owner.unmount()
doc.revision = 2; storage.clear()
owner = mount({ focusRequest: { ...focus, revision: 2 }, revision: 2 }); await owner.load()
storage.set('dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'motion', 1]), JSON.stringify({ documentId: doc.documentId,
  targetId: 'motion', baseRevision: 1, parentId: records.at(-1).id, reason: '', map: motionTargetMap() }))
owner.props.active = false; owner.render(); owner.props.active = true; owner.render(); await owner.load()
owner.click('查看靶图修订 preview-0')
const switchedDraftPreview = owner.pending().find(item => item.args.action === 'record')
owner.change('本地草稿版本', '1'); assert(switchedDraftPreview.signal.aborted)
await owner.resolve(switchedDraftPreview)
assert(text(owner.tree).includes('草稿属于知识图第 1 版') && !text(owner.tree).includes('历史快照 ·'))
owner.unmount(); doc.revision = 1
assert.equal(JSON.stringify(records), previewRecords); assert.equal(writes, previewWrites)
storage.clear()
owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
owner.change('映射规律表述', '阅读旧快照前的未保存限定语')
owner.click('查看靶图修订 preview-0')
assert.equal(owner.focused, 'data-target-record-view:loading', 'Reading a snapshot from the bottom must expose its progress and cancellation')
const atProgress = owner.scrolled.length
await owner.load()
assert.equal(owner.focused, 'data-target-record-view:archive', 'A completed snapshot must receive reading focus')
assert.equal(owner.scrolled.length, atProgress + 1)
assert.equal(owner.scrolled.at(-1).options.block, 'nearest', 'Completion minimally reveals resized status rather than jumping back to the top')
owner.click('返回未保存草稿')
assert.equal(owner.focused, 'data-target-record-link:' + JSON.stringify(['history', 'preview-0']), 'Return must focus the exact originating history record')
assert(owner.exampleDetails.get(JSON.stringify(['history', 'preview-0'])).open)
assert.equal(owner.control('映射规律表述').props.value, '阅读旧快照前的未保存限定语')
const navigationStorage = JSON.stringify([...storage])
owner.click('查看靶图修订 preview-1'); const navigationCancelled = owner.pending().find(item => item.args.action === 'record')
owner.click('取消读取历史靶图')
assert.equal(owner.focused, 'data-target-record-link:' + JSON.stringify(['history', 'preview-1']))
const afterCancelFocus = owner.scrolled.length
await owner.resolve(navigationCancelled)
assert.equal(owner.scrolled.length, afterCancelFocus, 'A cancelled late response cannot move reading focus')
owner.click('查看靶图修订 preview-0')
const navigationFailed = owner.pending().find(item => item.args.action === 'record')
navigationFailed.reject(new Error('navigation transport failure')); navigationFailed.settled = true; await owner.settle()
assert.equal(owner.focused, 'data-target-record-view:error')
assert.equal(owner.scrolled.at(-1).options.block, 'nearest', 'A taller error must remain visible, including on narrow viewports')
owner.click('重试读取历史靶图'); await owner.load()
owner.click('查看靶图修订 preview-1'); await owner.load()
owner.click('返回未保存草稿')
assert.equal(owner.focused, 'data-target-record-link:' + JSON.stringify(['history', 'preview-0']), 'Nested snapshot reads retain the draft entry point, not the last archive link')
owner.click('查看靶图修订 preview-1')
owner.panel.ownerDocument.activeElement = { independentSearchField: true }
owner.focused = 'search'
const afterSearchFocus = owner.scrolled.length
await owner.load()
assert.equal(owner.focused, 'search', 'A later search focus cannot be stolen by snapshot completion')
assert.equal(owner.scrolled.length, afterSearchFocus)
owner.click('返回未保存草稿')
owner.click('查看靶图修订 preview-0'); await owner.load()
owner.removedAnchor = JSON.stringify(['history', 'preview-0'])
owner.click('返回未保存草稿')
assert.equal(owner.focused, 'data-target-record-view:draft', 'A missing source link falls back to the draft, never a same-name record')
owner.removedAnchor = null; owner.duplicateAnchors = true
const beforeDuplicate = owner.scrolled.length
owner.click('查看靶图修订 preview-0'); await owner.load(); owner.click('返回未保存草稿')
assert.equal(owner.scrolled.length, beforeDuplicate, 'Duplicate anchors cannot redirect focus')
owner.duplicateAnchors = false
assert.equal(JSON.stringify([...storage]), navigationStorage, 'Reading navigation never changes draft content')
assert.equal(JSON.stringify(records), previewRecords); assert.equal(writes, previewWrites)
owner.unmount()
for (const roundTrip of ['return', 'cancel', 'retry', 'nested', 'resize']) {
  storage.clear()
  owner = mount({ recordNavigation: true, readingPosition: true, focusRequest: focus }); await owner.load()
  owner.change('映射规律表述', '精确返回时保留全部必要输入、单位、对象与时间限定语')
  const origin = JSON.stringify(['history', 'preview-0'])
  const entry = () => owner.domNodes.get('data-target-record-link:' + origin)
  const initialTop = entry().getBoundingClientRect().top
  const localDrafts = JSON.stringify([...storage]), recordCount = writes
  owner.click('查看靶图修订 preview-0')
  const pending = owner.pending().find(item => item.args.action === 'record')
  owner.flowShift = 240
  if (roundTrip === 'cancel') owner.click('取消读取历史靶图')
  else {
    if (roundTrip === 'retry') {
      pending.reject(new Error('reading position retry')); pending.settled = true; await owner.settle()
      owner.outer.scrollTop = 0
      owner.click('重试读取历史靶图')
    }
    await owner.load()
    if (roundTrip === 'nested') { owner.click('查看靶图修订 preview-1'); await owner.load() }
    if (roundTrip === 'resize') owner.outer.clientHeight = 250
    owner.click('返回未保存草稿')
  }
  const expectedTop = roundTrip === 'resize' ? owner.outer.clientHeight - 32 : initialTop
  assert.equal(entry().getBoundingClientRect().top, expectedTop, 'Restore the original reading offset, not viewport center: ' + roundTrip)
  assert.equal(owner.focused, 'data-target-record-link:' + origin)
  assert.equal(owner.inner.scrollTop, 990, 'Changed content height is resolved by the identity anchor, not old scrollTop')
  assert.equal(JSON.stringify([...storage]), localDrafts); assert.equal(writes, recordCount)
  if (roundTrip === 'cancel') {
    const position = entry().getBoundingClientRect().top
    await owner.resolve(pending)
    assert.equal(entry().getBoundingClientRect().top, position, 'A late cancelled response cannot restore again')
  }
  owner.unmount()
}
for (const invalidPosition of ['replaced-scroller', 'hidden-entry', 'missing-entry', 'duplicate-entry']) {
  storage.clear()
  owner = mount({ recordNavigation: true, readingPosition: true, focusRequest: focus }); await owner.load()
  if (invalidPosition === 'hidden-entry') owner.inner.scrollTop = 0
  owner.click('查看靶图修订 preview-0'); await owner.load()
  const oldScroller = owner.inner, oldTop = oldScroller.scrollTop
  if (invalidPosition === 'replaced-scroller') {
    owner.inner = { ...oldScroller }; owner.panel.parentElement = owner.inner
  }
  if (invalidPosition === 'missing-entry') owner.removedAnchor = JSON.stringify(['history', 'preview-0'])
  if (invalidPosition === 'duplicate-entry') owner.duplicateAnchors = true
  const count = owner.scrolled.length
  owner.click('返回未保存草稿')
  if (invalidPosition === 'duplicate-entry') assert.equal(owner.scrolled.length, count, 'An ambiguous entry cannot restore position')
  else assert.equal(owner.scrolled.at(-1).options.block, invalidPosition === 'missing-entry' ? 'start' : 'center', 'An invalid reading position uses visible identity-based fallback')
  if (invalidPosition === 'replaced-scroller') assert.equal(oldScroller.scrollTop, oldTop, 'A detached scroll container must not be mutated')
  owner.unmount()
}
for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'reload']) {
  doc.revision = 1; storage.clear()
  owner = mount({ recordNavigation: true, readingPosition: true, focusRequest: focus }); await owner.load()
  if (boundary === 'reload') {
    owner.click('查看靶图修订 preview-0')
    await owner.resolve(owner.pending().find(item => item.args.action === 'record'), { error: { code: 'revision_conflict', message: '重新核对版本' } })
  }
  owner.click('查看靶图修订 preview-0')
  const pending = owner.pending().find(item => item.args.action === 'record'), response = tools.handle(doc, pending.args, records)
  const staleCancelNavigation = owner.control('取消读取历史靶图').props.onClick
  if (boundary === 'target') owner.click('打开靶图 externality')
  if (boundary === 'document') { owner.props.documentId = 'foreign-document'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'reload') owner.click('重读靶图')
  const afterBoundary = owner.scrolled.length
  const afterPosition = [owner.inner.scrollTop, owner.outer.scrollTop]
  staleCancelNavigation(); owner.render(); await owner.resolve(pending, response)
  assert.equal(owner.scrolled.length, afterBoundary, 'No stale history navigation across ' + boundary)
  assert.deepEqual([owner.inner.scrollTop, owner.outer.scrollTop], afterPosition, 'No stale reading position across ' + boundary)
  if (boundary !== 'unmount') owner.unmount()
}
doc.revision = 1; storage.clear()
const navigationMap = motionTargetMap(), prediction = structuredClone(navigationMap.examples[0])
prediction.id = 'navigation-prediction'; prediction.stage = 'prediction'; prediction.exposure = 'self_reported_new'; prediction.context = '导航验收独立预测情境'
navigationMap.examples.push(prediction)
const predictedRecord = tools.handle(doc, { action: 'save', documentId: doc.documentId, targetId: 'motion', expectedRevision: 1,
  parentId: 'preview-1', id: 'navigation-predicted', reason: '预测依据入口', confirm: true, map: navigationMap }, records).saved
assert(predictedRecord); records.push(predictedRecord)
const basisRecords = JSON.stringify(records), basisWrites = writes
owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
owner.click('查看预测时的上层表述'); await owner.load()
owner.click('返回未保存草稿')
assert.equal(owner.focused, 'data-target-record-link:' + JSON.stringify(['basis', prediction.id]))
assert(owner.exampleDetails.get(JSON.stringify(['basis', prediction.id])).open)
owner.click('查看靶图修订 navigation-predicted'); await owner.load(); owner.click('返回未保存草稿')
assert.equal(owner.focused, 'data-target-record-link:' + JSON.stringify(['history', 'navigation-predicted']), 'Same record ID from history and prediction basis has separate return identity')
owner.unmount()
doc.revision = 2
owner = mount({ recordNavigation: true, focusRequest: { ...focus, revision: 2 }, revision: 2 }); await owner.load()
owner.click('查看靶图修订 preview-0'); await owner.load(); owner.click('返回未保存草稿')
assert.equal(owner.focused, 'data-target-record-link:' + JSON.stringify(['history', 'preview-0']))
assert(!owner.control('确认保存个人靶图').props.checked)
owner.unmount(); doc.revision = 1
assert.equal(JSON.stringify(records), basisRecords); assert.equal(writes, basisWrites)
storage.clear(); records = []
records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
  id: 'compare-baseline', parentId: '', reason: '', confirm: true, map: motionTargetMap() }, records).saved)
owner = mount({ focusRequest: focus }); await owner.load()
owner.change('映射规律表述', '可能成立；方向和因果仍未核对，不能由两条关系或循环推出必然结论。')
owner.change('适用条件', '需要全部输入；来源甲与来源乙的条件相互冲突。')
owner.change('槽位 before 单位', 'km/h')
owner.change('槽位 before 对象与时间', '另一对象，下一时刻')
const comparisonDraft = owner.control('映射规律表述').props.value
const comparisonStorage = JSON.stringify([...storage]), comparisonRecords = JSON.stringify(records), comparisonWrites = writes
owner.click('查看靶图修订 compare-baseline'); await owner.load()
const comparisonRequests = owner.requests.length
owner.click('对照上层表述')
assert(text(owner.control('靶图上层表述对照')).includes(comparisonDraft), 'Historical and draft mappings must be readable together')
const comparedRows = () => all(owner.tree, item => item.props['data-target-compare-key'])
const comparedRow = path => {
  const row = comparedRows().find(item => item.props['data-target-compare-key'] === JSON.stringify(path))
  assert(row, 'Missing comparison row: ' + JSON.stringify(path)); return row
}
const comparedText = (path, side) => {
  const cell = all(comparedRow(path), item => item.props['data-target-compare-side'] === side)[0]
  return all(cell, item => item.type === 'pre').map(text)[0]
}
assert.equal(comparedText(['mapping'], 'history'), records[0].map.mapping)
assert.equal(comparedText(['mapping'], 'draft'), comparisonDraft)
assert.equal(comparedText(['slots', 'before', 'unit'], 'history'), 'm/s')
assert.equal(comparedText(['slots', 'before', 'unit'], 'draft'), 'km/h')
assert.equal(comparedText(['slots', 'before', 'scope'], 'draft'), '另一对象，下一时刻')
assert.equal(comparedText(['conditions'], 'draft'), '需要全部输入；来源甲与来源乙的条件相互冲突。')
assert.equal(comparedRows().length, 4)
owner.change('仅显示不同的上层字段', undefined, false)
assert.equal(comparedRows().length, 31)
assert.equal(comparedText(['slots', 'after', 'unit'], 'draft'), 'm/s', 'Same-name output keeps its own identity and unit')
owner.click('快照内容'); assert(owner.control('映射规律表述').props.disabled)
owner.click('对照上层表述'); assert(owner.control('仅显示不同的上层字段').props.checked)
assert.equal(owner.requests.length, comparisonRequests, 'Comparison uses already-read values and does not call any API')
assert.equal(JSON.stringify([...storage]), comparisonStorage)
owner.click('返回未保存草稿')
assert.equal(owner.control('映射规律表述').props.value, comparisonDraft)
assert(!owner.control('确认保存个人靶图').props.checked)
assert.equal(JSON.stringify(records), comparisonRecords); assert.equal(writes, comparisonWrites)
owner.unmount()

const openUpperComparison = async (before, after, options = {}) => {
  storage.clear(); records = []
  const targetId = options.targetId || 'motion'
  records.push(tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: doc.revision, targetId,
    id: 'compare-baseline', parentId: '', reason: '', confirm: true, map: before }, records).saved)
  assert(records[0]); tools.validate(after, { draft: true })
  if (options.newRevision) doc.revision = options.newRevision
  const value = { documentId: doc.documentId, targetId, baseRevision: doc.revision, parentId: records[0].id, reason: '', map: after }
  storage.set('dsh-kg-target-map:' + JSON.stringify([doc.documentId, targetId, doc.revision]), JSON.stringify(value))
  owner = mount({ focusRequest: { documentId: doc.documentId, revision: doc.revision, targetId }, ...options }); await owner.load()
  owner.click('查看靶图修订 compare-baseline'); await owner.load(); owner.click('对照上层表述')
}
const identityBefore = motionTargetMap(), identityAfter = structuredClone(identityBefore)
identityAfter.slots[1].id = '__proto__'; identityAfter.slots[1].name = identityBefore.slots[1].name
identityAfter.examples.forEach(item => { item.inputs[1].slotId = '__proto__' })
identityAfter.outcomes[0].id = 'uniform '
identityAfter.examples.forEach(item => { item.outputs[0].outcomeId = 'uniform ' })
await openUpperComparison(identityBefore, identityAfter)
assert.equal(comparedText(['slots', 'before', 'name'], 'history'), '速度')
assert.equal(comparedText(['slots', 'before', 'name'], 'draft'), undefined)
assert.equal(comparedText(['slots', '__proto__', 'name'], 'history'), undefined)
assert.equal(comparedText(['slots', '__proto__', 'name'], 'draft'), '速度')
assert.equal(comparedText(['outcomes', 'uniform', 'label'], 'draft'), undefined)
assert.equal(comparedText(['outcomes', 'uniform ', 'label'], 'draft'), '匀速直线运动')
assert(text(comparedRow(['slots', '__proto__', 'meaning'])).includes('该侧无此字段'))
owner.unmount()
for (const [before, after] of [['可能成立', '必然成立'], ['x^2', 'x2'], ['a b', 'ab'], ['e\u0301', '\u00e9'], ['', ' '],
  ['<img src=x onerror=alert(1)>', '<script>throw 1</script>'], ['甲'.repeat(7999) + '乙', '甲'.repeat(7999) + '丙']]) {
  const older = motionTargetMap(), newer = motionTargetMap(); older.mapping = before; newer.mapping = after
  await openUpperComparison(older, newer)
  assert.equal(comparedRows().length, 1)
  assert.equal(comparedText(['mapping'], 'history'), before || undefined); assert.equal(comparedText(['mapping'], 'draft'), after)
  assert(!all(owner.tree, item => ['script', 'img'].includes(item.type)).length)
  if (before === '') assert(text(comparedRow(['mapping'])).includes('空文本') && text(comparedRow(['mapping'])).includes('仅含空白字符'))
  owner.unmount()
}
const roleChange = motionTargetMap()
roleChange.slots[1].role = 'output'; roleChange.slots[2].role = 'input'
roleChange.outcomes.forEach(item => { item.slotId = 'before' }); roleChange.examples = []
await openUpperComparison(motionTargetMap(), roleChange)
assert.equal(comparedText(['slots', 'before', 'role'], 'history'), '输入')
assert.equal(comparedText(['slots', 'before', 'role'], 'draft'), '输出')
assert.equal(comparedText(['outcomes', 'uniform', 'slotId'], 'history'), 'after')
assert.equal(comparedText(['outcomes', 'uniform', 'slotId'], 'draft'), 'before')
owner.unmount()
const missingInput = motionTargetMap(); missingInput.slots = missingInput.slots.filter(item => item.id !== 'force')
missingInput.examples.forEach(item => { item.inputs = item.inputs.filter(value => value.slotId !== 'force') })
await openUpperComparison(motionTargetMap(), missingInput)
assert.equal(comparedText(['slots', 'force', 'name'], 'history'), '合外力')
assert.equal(comparedText(['slots', 'force', 'name'], 'draft'), undefined, 'Removing a necessary input must be visible, not treated as equivalent')
owner.unmount()
const reordered = motionTargetMap(); reordered.slots.reverse(); reordered.outcomes.reverse()
await openUpperComparison(motionTargetMap(), reordered)
assert.equal(comparedRows().length, 2); comparedRow(['slots', 'order']); comparedRow(['outcomes', 'order'])
owner.unmount()
const lowerOnly = motionTargetMap(); lowerOnly.examples[0].context = '不同的已知情境，不得把上层相同当成下层相同'
lowerOnly.examples[0].process = '循环推测与 AI 建议不构成独立证据'
await openUpperComparison(motionTargetMap(), lowerOnly)
assert.equal(comparedRows().length, 0)
assert(text(owner.control('靶图上层表述对照')).includes('上层字段逐字相同；不代表下层记录相同或模型成立。'))
assert(text(owner.control('靶图上层表述对照')).includes('不包含下层例子、预测或反馈'))
owner.unmount()
const conceptBefore = tools.blank(doc.graph.nodes.find(item => item.id === 'externality')), conceptAfter = structuredClone(conceptBefore)
conceptBefore.mapping = '免费让第三方受益'; conceptAfter.mapping = '第三方是否免费受益仍需核对'
conceptAfter.outcomes[1].label = '非 A 或待核对'
await openUpperComparison(conceptBefore, conceptAfter, { targetId: 'externality' })
assert.equal(comparedText(['mapping'], 'history'), '免费让第三方受益')
assert.equal(comparedText(['outcomes', 'no', 'label'], 'history'), '非 A')
owner.unmount()
const unknownBefore = tools.blank(doc.graph.nodes.find(item => item.id === 'unknown')), unknownAfter = structuredClone(unknownBefore)
unknownAfter.boundary = '不能由无角色连线推断方向'
await openUpperComparison(unknownBefore, unknownAfter, { targetId: 'unknown' })
owner.change('仅显示不同的上层字段', undefined, false)
assert.equal(comparedText(['mapping'], 'history'), undefined)
assert(!text(owner.control('靶图上层表述对照')).includes('speed-before'), 'Unknown graph endpoints are never invented as personal slots')
owner.unmount()
await openUpperComparison(motionTargetMap(), motionTargetMap(), { newRevision: 2 })
assert(text(owner.control('靶图上层表述对照')).includes('两侧基于不同知识图版本'))
assert(text(owner.control('靶图上层表述对照')).includes('知识图第 1 版') && text(owner.control('靶图上层表述对照')).includes('知识图第 2 版'))
owner.unmount(); doc.revision = 1
for (const change of ['target', 'document', 'revision', 'hidden', 'unmount', 'return', 'reread']) {
  await openUpperComparison(motionTargetMap(), motionTargetMap())
  const staleCompare = owner.control('对照上层表述').props.onClick
  if (change === 'target') owner.click('打开靶图 externality')
  if (change === 'document') { owner.props.documentId = 'other'; owner.render() }
  if (change === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (change === 'hidden') { owner.props.active = false; owner.render() }
  if (change === 'unmount') owner.unmount()
  if (change === 'return') owner.click('返回未保存草稿')
  if (change === 'reread') {
    owner.click('查看靶图修订 compare-baseline')
    assert(owner.control('对照上层表述').props.disabled)
    const request = owner.pending().find(item => item.args.action === 'record')
    request.reject(new Error('snapshot unavailable')); request.settled = true; await owner.settle()
    assert(!all(owner.tree, item => item.props['aria-label'] === '靶图上层表述对照').length, 'A failed newer read does not silently retain a comparison')
    owner.click('重试读取历史靶图'); await owner.load()
    assert(!all(owner.tree, item => item.props['aria-label'] === '靶图上层表述对照').length)
  }
  staleCompare(); owner.render()
  if (change !== 'unmount') assert(!all(owner.tree, item => item.props['aria-label'] === '靶图上层表述对照').length, change)
  owner.unmount(); doc.revision = 1
}
const exampleRevision = motionTargetMap()
exampleRevision.examples[0].process = '只在同一对象、同一时段且全部输入齐全时推测；来源仍需核对。'
await openUpperComparison(motionTargetMap(), exampleRevision)
owner.click('对照例子记录')
assert(text(owner.control('靶图例子记录对照')).includes(exampleRevision.examples[0].process))
assert.equal(comparedText(['examples', 'material-0', 'process'], 'history'), motionTargetMap().examples[0].process)
assert.equal(comparedText(['examples', 'material-0', 'process'], 'draft'), exampleRevision.examples[0].process)
assert.equal(comparedRows().length, 1)
const exampleStorage = JSON.stringify([...storage]), exampleRecords = JSON.stringify(records), exampleRequests = owner.requests.length, exampleWrites = writes
owner.change('选择对照例子', 'material-1')
assert(text(owner.tree).includes('这个例子的记录与绑定字段逐字相同；不代表上层依据相同或模型成立。'))
assert.equal(comparedRows().length, 0)
owner.change('仅显示不同的例子字段', undefined, false)
assert.equal(comparedText(['examples', 'material-1', 'inputs', 'before', 'slot', 'unit'], 'draft'), 'm/s')
owner.click('对照上层表述'); assert.equal(comparedRows().length, 0)
owner.click('对照例子记录'); assert(owner.control('仅显示不同的例子字段').props.checked)
owner.click('快照内容'); assert(owner.control('例子 1 推测过程').props.disabled)
owner.click('对照例子记录'); owner.click('返回未保存草稿')
assert.equal(owner.control('例子 1 推测过程').props.value, exampleRevision.examples[0].process)
assert(!owner.control('确认保存个人靶图').props.checked)
assert.equal(owner.requests.length, exampleRequests); assert.equal(JSON.stringify([...storage]), exampleStorage)
assert.equal(JSON.stringify(records), exampleRecords); assert.equal(writes, exampleWrites)
owner.unmount()
const openExampleComparison = async (before, after, options) => { await openUpperComparison(before, after, options); owner.click('对照例子记录') }
const boundAfter = motionTargetMap()
boundAfter.slots[1].unit = 'km/h'; boundAfter.slots[1].scope = '另一对象，下一时刻'; boundAfter.slots[1].meaning = '仍需核对的含义'
boundAfter.outcomes[0].label = '匀速直线运动（需全部输入）'; boundAfter.outcomes[0].detail = '不能由相关性、循环或两条可能关系断言因果'
boundAfter.examples[0].inputs[1].value = '36 km/h'; boundAfter.examples[0].outputs[0].detail = '来源甲与乙冲突；可能而非必然'
await openExampleComparison(motionTargetMap(), boundAfter)
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'before', 'slot', 'unit'], 'history'), 'm/s')
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'before', 'slot', 'unit'], 'draft'), 'km/h')
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'before', 'slot', 'scope'], 'draft'), '另一对象，下一时刻')
assert.equal(comparedText(['examples', 'material-0', 'outputs', 'after', 'outcome', 'label'], 'history'), '匀速直线运动')
assert.equal(comparedText(['examples', 'material-0', 'outputs', 'after', 'outcome', 'label'], 'draft'), boundAfter.outcomes[0].label)
owner.change('仅显示不同的例子字段', undefined, false)
assert.equal(comparedText(['examples', 'material-0', 'outputs', 'after', 'slot', 'unit'], 'draft'), 'm/s', 'Same-name output must not inherit the input unit')
owner.unmount()
const sameContext = motionTargetMap()
sameContext.examples[0].id = '__proto__'; sameContext.examples[1].id = 'material-1 '
await openExampleComparison(motionTargetMap(), sameContext)
assert.equal(owner.control('选择对照例子').props.children[0].length, 4)
assert.equal(comparedText(['examples', 'material-0', 'context'], 'draft'), undefined, 'Matching text does not join different example IDs')
owner.change('选择对照例子', '__proto__')
assert.equal(comparedText(['examples', '__proto__', 'context'], 'history'), undefined)
assert.equal(comparedText(['examples', '__proto__', 'context'], 'draft'), sameContext.examples[0].context)
owner.change('选择对照例子', 'material-1 ')
assert.equal(comparedText(['examples', 'material-1 ', 'context'], 'history'), undefined, 'Example identity whitespace is not normalized')
owner.unmount()
await openExampleComparison(identityBefore, identityAfter)
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'before', 'value'], 'draft'), undefined)
assert.equal(comparedText(['examples', 'material-0', 'inputs', '__proto__', 'value'], 'history'), undefined)
assert.equal(comparedText(['examples', 'material-0', 'outputs', 'after', 'outcomeId'], 'draft'), 'uniform ')
owner.unmount()
await openExampleComparison(motionTargetMap(), missingInput)
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'force', 'value'], 'draft'), undefined)
assert(text(comparedRow(['examples', 'material-0', 'inputs', 'force', 'value'])).includes('该侧无此字段'))
owner.unmount()
const reversedExamples = motionTargetMap(); reversedExamples.examples.reverse(); reversedExamples.examples[0].inputs.reverse()
await openExampleComparison(motionTargetMap(), reversedExamples)
assert.equal(comparedRows().length, 1); assert.equal(comparedText(['examples', 'material-0', 'position'], 'draft'), '2')
owner.change('选择对照例子', 'material-1')
assert.equal(comparedRows().length, 2); comparedRow(['examples', 'material-1', 'inputs', 'order'])
owner.unmount()
for (const [before, after] of [['可能', '必然'], ['x^2', 'x2'], ['a b', 'ab'], ['e\u0301', '\u00e9'], ['', ' '],
  ['<img src=x onerror=alert(1)>', '<script>throw 1</script>'], ['甲'.repeat(7999) + '乙', '甲'.repeat(7999) + '丙']]) {
  const old = motionTargetMap(), next = motionTargetMap(); old.examples[0].process = before; next.examples[0].process = after
  await openExampleComparison(old, next)
  assert.equal(comparedRows().length, 1)
  assert.equal(comparedText(['examples', 'material-0', 'process'], 'history'), before || undefined)
  assert.equal(comparedText(['examples', 'material-0', 'process'], 'draft'), after)
  assert(!all(owner.tree, item => ['script', 'img'].includes(item.type)).length)
  owner.unmount()
}
const predictionBefore = motionTargetMap(), feedbackAfter = motionTargetMap()
predictionBefore.examples[0].stage = 'prediction'; predictionBefore.examples[0].exposure = 'self_reported_new'
feedbackAfter.examples[0] = structuredClone(predictionBefore.examples[0]); feedbackAfter.examples[0].stage = 'reviewed'
feedbackAfter.examples[0].feedback = { kind: 'ai', text: 'AI 认为相符，另一资料存在冲突；不能当作独立验证。', source: 'AI 建议和自报判断，未外部核对' }
await openExampleComparison(predictionBefore, feedbackAfter)
assert.equal(comparedText(['examples', 'material-0', 'stage'], 'history'), '预测 · 尚无对照结果')
assert.equal(comparedText(['examples', 'material-0', 'stage'], 'draft'), '对照阶段 · 非独立验证')
assert(!text(owner.control('靶图例子记录对照')).includes('已记录对照'), 'Draft phase must not claim a persisted result')
assert.equal(comparedText(['examples', 'material-0', 'feedback', 'kind'], 'history'), undefined)
assert.equal(comparedText(['examples', 'material-0', 'feedback', 'kind'], 'draft'), 'AI 建议')
assert.equal(comparedText(['examples', 'material-0', 'feedback', 'source'], 'draft'), feedbackAfter.examples[0].feedback.source)
owner.change('仅显示不同的例子字段', undefined, false)
assert.equal(comparedText(['examples', 'material-0', 'exposure'], 'draft'), '自报未见 · 非独立证明')
owner.click('返回未保存草稿'); assert(!owner.control('确认保存个人靶图').props.checked)
assert(!owner.control('例子 1 对照结果').props.disabled)
owner.unmount()
for (const kind of ['personal', 'source', 'observation']) {
  feedbackAfter.examples[0].feedback.kind = kind
  await openExampleComparison(predictionBefore, feedbackAfter)
  assert.equal(comparedText(['examples', 'material-0', 'feedback', 'kind'], 'draft'), { personal: '个人判断', source: '资料答案', observation: '观察记录' }[kind])
  owner.unmount()
}
await openExampleComparison(unknownBefore, unknownBefore, { targetId: 'unknown' })
assert(text(owner.tree).includes('两侧均无例子记录。')); assert.equal(comparedRows().length, 0)
assert(!all(owner.tree, item => item.props['aria-label'] === '选择对照例子').length)
owner.unmount()
const conceptExamples = structuredClone(conceptBefore)
conceptExamples.examples.push(tools.example(conceptExamples, 'concept-example'))
conceptExamples.examples[0].context = '是否免费让第三方受益待核对'
conceptExamples.examples[0].outputs[0].outcomeId = 'no'
await openExampleComparison(conceptBefore, conceptExamples, { targetId: 'externality' })
assert.equal(comparedText(['examples', 'concept-example', 'outputs', 'output-1', 'outcome', 'label'], 'draft'), '非 A')
owner.unmount()
const manyBefore = motionTargetMap(), manyAfter = motionTargetMap()
manyBefore.examples = Array.from({ length: 40 }, (_, i) => ({ ...structuredClone(manyBefore.examples[0]), id: 'old-' + i }))
manyAfter.examples = Array.from({ length: 40 }, (_, i) => ({ ...structuredClone(manyAfter.examples[0]), id: 'new-' + i }))
await openExampleComparison(manyBefore, manyAfter)
assert.equal(owner.control('选择对照例子').props.children[0].length, 80)
assert.equal(all(owner.tree, item => item.props['data-target-example-comparison']).length, 1, 'Render only the selected example, not eighty expanded records')
owner.change('选择对照例子', 'new-39')
assert.equal(comparedText(['examples', 'new-39', 'context'], 'draft'), manyAfter.examples[39].context)
owner.unmount()
await openExampleComparison(motionTargetMap(), exampleRevision, { newRevision: 2 })
assert(text(owner.control('靶图例子记录对照')).includes('两侧基于不同知识图版本'))
owner.unmount(); doc.revision = 1
for (const change of ['target', 'document', 'revision', 'hidden', 'unmount', 'return', 'reread', 'upper']) {
  await openExampleComparison(motionTargetMap(), exampleRevision)
  const staleCompare = owner.control('对照例子记录').props.onClick
  const staleFilter = owner.control('仅显示不同的例子字段').props.onChange
  const staleSelect = owner.control('选择对照例子').props.onChange
  if (change === 'target') owner.click('打开靶图 externality')
  if (change === 'document') { owner.props.documentId = 'other'; owner.render() }
  if (change === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (change === 'hidden') { owner.props.active = false; owner.render() }
  if (change === 'unmount') owner.unmount()
  if (change === 'return') owner.click('返回未保存草稿')
  if (change === 'upper') owner.click('对照上层表述')
  if (change === 'reread') {
    owner.click('查看靶图修订 compare-baseline'); assert(owner.control('对照例子记录').props.disabled)
    const request = owner.pending().find(item => item.args.action === 'record')
    request.reject(new Error('example snapshot unavailable')); request.settled = true; await owner.settle()
    assert(!all(owner.tree, item => item.props['aria-label'] === '靶图例子记录对照').length)
    owner.click('重试读取历史靶图'); await owner.load()
  }
  staleFilter({ target: { checked: false } }); staleSelect({ target: { value: 'material-1' } }); owner.render()
  if (change !== 'upper') { staleCompare(); owner.render() }
  if (change !== 'unmount') assert(!all(owner.tree, item => item.props['aria-label'] === '靶图例子记录对照').length, change)
  if (change === 'upper') assert(owner.control('仅显示不同的上层字段').props.checked, 'Late lower controls cannot mutate upper comparison')
  owner.unmount(); doc.revision = 1
}
const preparePredictionBasis = (laterRound = false, feedbackKind = '') => {
  doc.revision = 1; storage.clear(); records = []
  const map = motionTargetMap(), prediction = structuredClone(map.examples[0])
  prediction.id = 'same-prediction'; prediction.stage = 'prediction'; prediction.context = '原始预测情境'; prediction.exposure = 'known'
  map.examples = [prediction]
  const save = (id, value, extra = {}) => {
    const result = tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
      id, parentId: records.at(-1)?.id || '', reason: '预测依据验收', confirm: true, map: value, ...extra }, records)
    assert(result.saved, JSON.stringify(result.error)); records.push(result.saved); return result.saved
  }
  save('basis-original', map)
  map.mapping = '修订后的规律，仍需核对；不得从循环得到独立证据'
  map.slots.find(item => item.id === 'before').meaning = '修订后的输入内涵'
  save('basis-revised', map)
  if (feedbackKind) {
    map.examples[0] = { ...map.examples[0], stage: 'reviewed',
      feedback: { kind: feedbackKind, text: '可能成立，但另一来源给出相反结果', source: '<img src=x>仅为来源说明，不是独立验证' } }
    save('basis-reviewed', map)
  }
  if (laterRound) {
    const next = structuredClone(map); next.examples = []
    save('basis-round', next, { startRound: true })
    const reused = structuredClone(prediction); reused.context = '另一轮的同名身份，不能替代旧预测'; next.examples.push(reused)
    save('basis-new-round', next)
  }
}
preparePredictionBasis(true)
owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
owner.click('查看靶图修订 basis-revised'); await owner.load()
owner.click('查看预测时的上层表述')
assert.equal(owner.pending().at(-1).args.recordId, 'basis-original', 'An archived prediction must use its own basis, not a reused example ID in the current round')
await owner.load(); owner.unmount()

preparePredictionBasis()
owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
owner.change('适用条件', '条件甲与乙冲突，通常成立不能改称必然；需要全部输入')
owner.click('填写对照结果'); owner.change('例子 1 结果来源', 'ai')
owner.change('例子 1 对照结果', 'AI 建议仍与观察矛盾'); owner.change('例子 1 结果来源说明', '未经独立复核')
const basisDraftState = JSON.stringify([...storage]), basisRecordState = JSON.stringify(records), basisWriteCount = writes
owner.click('对照预测依据与草稿'); const basisRequest = owner.pending().at(-1)
assert.equal(basisRequest.args.recordId, 'basis-original')
assert(owner.control('对照预测依据与草稿').props.disabled)
await owner.load()
assert(text(owner.control('靶图预测依据对照')).includes('来自修订 basis-revised'))
assert(text(owner.tree).includes('后续修订不能倒算为当时的依据'))
assert(text(owner.tree).includes('记录对应不等于预测正确或独立验证'))
assert.equal(all(owner.tree, item => item.type === 'pre' && item.props.className === 'kg-target-basis-context').map(text)[0], '原始预测情境')
assert.match(readFileSync(new URL('../extension/viewer.css', import.meta.url), 'utf8'), /\.kg-target-basis-context \{ white-space: pre-wrap; overflow-wrap: anywhere;/)
assert.equal(comparedText(['mapping'], 'history'), records[0].map.mapping)
assert.equal(comparedText(['mapping'], 'draft'), records[1].map.mapping)
assert.equal(comparedText(['slots', 'before', 'meaning'], 'history'), records[0].map.slots.find(item => item.id === 'before').meaning)
const basisReadCount = owner.requests.length
owner.change('仅显示不同的上层字段', undefined, false)
assert.equal(comparedText(['slots', 'before', 'unit'], 'history'), 'm/s')
assert.equal(comparedText(['slots', 'after', 'unit'], 'history'), 'm/s')
assert.equal(owner.requests.length, basisReadCount); assert.equal(JSON.stringify([...storage]), basisDraftState)
owner.click('返回未保存草稿')
assert.equal(owner.control('例子 1 对照结果').props.value, 'AI 建议仍与观察矛盾')
assert.equal(owner.focused, 'data-target-record-link:' + JSON.stringify(['basis-compare', 'same-prediction']))
assert(!owner.control('确认保存个人靶图').props.checked)
assert.equal(JSON.stringify(records), basisRecordState); assert.equal(writes, basisWriteCount)
owner.click('对照预测依据与草稿')
const failedBasis = owner.pending().at(-1); failedBasis.reject(new Error('basis unavailable')); failedBasis.settled = true; await owner.settle()
assert(!all(owner.tree, item => item.props['aria-label'] === '靶图预测依据对照').length)
owner.click('重试读取历史靶图'); assert.equal(owner.pending().at(-1).args.recordId, 'basis-original'); await owner.load()
assert(owner.control('靶图预测依据对照'), 'Retry preserves the explicit basis comparison, not a generic snapshot')
owner.click('对照上层表述')
assert(!all(owner.tree, item => item.props['aria-label'] === '靶图预测依据对照').length)
assert(owner.control('靶图上层表述对照')); owner.unmount()

preparePredictionBasis(true)
records = records.filter(record => record.id !== 'basis-new-round')
owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
assert(!all(owner.tree, item => item.type === 'button' && text(item) === '对照预测依据与草稿').length)
owner.click('查看靶图修订 basis-revised'); await owner.load(); owner.click('对照预测依据与草稿'); await owner.load()
assert(owner.control('靶图预测依据对照'), 'Past-round predictions remain navigable when absent from the current round')
assert.equal(comparedText(['mapping'], 'history'), records[0].map.mapping)
owner.click('返回未保存草稿')
assert.equal(owner.focused, 'data-target-record-link:' + JSON.stringify(['history', 'basis-revised']))
owner.unmount()

for (const bad of ['missing', 'future', 'empty', 'prototype']) {
  preparePredictionBasis()
  if (bad === 'missing') delete records[1].bases['same-prediction']
  if (bad === 'future') records[1].bases['same-prediction'].baseRevision = 2
  if (bad === 'empty') records[1].bases['same-prediction'].recordId = ''
  if (bad === 'prototype') records[1].bases = Object.create(records[1].bases)
  owner = mount({ focusRequest: focus }); await owner.load()
  assert(text(owner.tree).includes('已保存预测依据不可用'), bad)
  assert(!all(owner.tree, item => item.type === 'button' && text(item) === '对照预测依据与草稿').length, bad)
  owner.unmount()
}

for (const compareArchive of [false, true]) for (const corrupt of ['version', 'document', 'origin', 'self_reference', 'cycle', 'example_id', 'material', 'reviewed', 'context', 'process',
  'input', 'missing_input', 'outcome', 'slot_name', 'unit', 'scope', 'output_label', 'output_detail']) {
  preparePredictionBasis(); owner = mount({ focusRequest: focus }); await owner.load()
  if (compareArchive) { owner.click('查看靶图修订 basis-revised'); await owner.load() }
  owner.click(compareArchive ? '对照预测依据与此快照' : '对照预测依据与草稿')
  const request = owner.pending().at(-1), response = structuredClone(tools.handle(doc, request.args, records)), record = response.record, example = record.map.examples[0]
  if (corrupt === 'version') record.baseRevision = 2
  if (corrupt === 'document') record.documentId = 'different-document'
  if (corrupt === 'origin') record.origin = 'ai'
  if (corrupt === 'self_reference') record.bases[example.id].recordId = 'different-basis'
  if (corrupt === 'cycle') record.bases[example.id].recordId = 'basis-revised'
  if (corrupt === 'example_id') example.id += ' '
  if (corrupt === 'material') example.stage = 'material'
  if (corrupt === 'reviewed') { example.stage = 'reviewed'; example.feedback = { kind: 'ai', text: '事后答案', source: 'AI' } }
  if (corrupt === 'context') example.context += ' '
  if (corrupt === 'process') example.process = '事后改写为必然结论'
  if (corrupt === 'input') example.inputs[0].value = '另一个输入'
  if (corrupt === 'missing_input') { record.map.slots = record.map.slots.filter(item => item.id !== 'force'); example.inputs = example.inputs.filter(item => item.slotId !== 'force') }
  if (corrupt === 'outcome') example.outputs[0].outcomeId = 'accelerated'
  if (corrupt === 'slot_name') record.map.slots[0].name = record.map.slots[1].name
  if (corrupt === 'unit') record.map.slots[1].unit = 'km/h'
  if (corrupt === 'scope') record.map.slots[1].scope = '另一对象与时段'
  if (corrupt === 'output_label') record.map.outcomes[0].label = '另一个含义'
  if (corrupt === 'output_detail') record.map.outcomes[0].detail = '改写边界'
  await owner.resolve(request, response)
  assert(text(owner.tree).includes('历史靶图读取失败'), corrupt)
  assert(!all(owner.tree, item => item.props['aria-label'] === '靶图预测依据对照').length, corrupt)
  assert(!all(owner.tree, item => item.props['aria-label'] === '靶图历史预测依据对照').length, corrupt)
  if (compareArchive) {
    assert.equal(owner.control('映射规律表述').props.value, records[1].map.mapping)
    assert.equal(all(owner.tree, item => item.props['data-target-history-reference']).length, 0, 'Invalid basis must not install a pinned owner')
  } else assert(!owner.control('确认保存个人靶图').props.checked)
  owner.unmount()
}

for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'edit', 'cancel', 'newer_read', 'return']) {
  preparePredictionBasis(); owner = mount({ focusRequest: focus }); await owner.load()
  const staleBasis = owner.control('对照预测依据与草稿').props.onClick, staleEdit = owner.control('适用条件').props.onChange
  owner.click('对照预测依据与草稿')
  const pending = owner.pending().at(-1), response = tools.handle(doc, pending.args, records)
  if (boundary === 'target') owner.click('打开靶图 externality')
  if (boundary === 'document') { owner.props.documentId = 'elsewhere'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'edit') { staleEdit({ target: { value: 'pending draft changed' } }); owner.render() }
  if (boundary === 'cancel') owner.click('取消读取历史靶图')
  if (boundary === 'newer_read') owner.click('查看靶图修订 basis-revised')
  if (boundary === 'return') { await owner.resolve(pending, response); owner.click('返回未保存草稿') }
  if (!['cancel', 'return'].includes(boundary)) { staleBasis(); owner.render() }
  await owner.resolve(pending, response)
  if (boundary !== 'unmount') {
    assert(!all(owner.tree, item => item.props['aria-label'] === '靶图预测依据对照').length, boundary)
    if (boundary === 'edit') assert(text(owner.tree).includes('读取期间草稿或快照已变化'))
  }
  owner.unmount(); doc.revision = 1
}

preparePredictionBasis(); doc.revision = 2
owner = mount({ revision: 2, focusRequest: { ...focus, revision: 2 } }); await owner.load()
owner.change('映射规律表述', '新版本草稿，不是过去预测的依据')
owner.click('查看靶图修订 basis-revised'); await owner.load(); owner.click('对照预测依据与草稿'); await owner.load()
assert(text(owner.control('靶图预测依据对照')).includes('两侧基于不同知识图版本'))
assert.equal(comparedText(['mapping'], 'draft'), '新版本草稿，不是过去预测的依据')
owner.click('返回未保存草稿'); assert.equal(owner.control('映射规律表述').props.value, '新版本草稿，不是过去预测的依据')
owner.unmount(); doc.revision = 1

preparePredictionBasis(true)
owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
owner.change('映射规律表述', '未保存草稿，不属于所选历史快照')
owner.click('查看靶图修订 basis-revised'); await owner.load()
const historyBasisDraft = JSON.stringify([...storage]), historyBasisRecords = JSON.stringify(records), historyBasisWrites = writes
owner.click('对照预测依据与此快照')
assert.equal(owner.pending().at(-1).args.recordId, 'basis-original', 'Use the selected archive basis, not a reused current-round example')
await owner.load()
assert(owner.control('靶图历史预测依据对照'))
assert.equal(comparedText(['mapping'], 'history'), records[0].map.mapping)
assert.equal(comparedText(['mapping'], 'reference'), records[1].map.mapping)
assert(!text(owner.control('靶图历史预测依据对照')).includes('未保存草稿，不属于所选历史快照'))
assert.equal(JSON.stringify([...storage]), historyBasisDraft); assert.equal(JSON.stringify(records), historyBasisRecords); assert.equal(writes, historyBasisWrites)
owner.click('返回所选历史快照'); await owner.load()
assert.equal(owner.control('映射规律表述').props.value, records[1].map.mapping)
assert(owner.control('映射规律表述').props.disabled)
owner.click('返回未保存草稿')
assert.equal(owner.control('映射规律表述').props.value, '未保存草稿，不属于所选历史快照')
assert(!owner.control('确认保存个人靶图').props.checked)
owner.unmount()

const openSavedBasisOwner = async (kind = '', revision = 1) => {
  preparePredictionBasis(true, kind); doc.revision = revision
  owner = mount({ recordNavigation: true, revision, focusRequest: { ...focus, revision } }); await owner.load()
  owner.change('映射规律表述', '当前草稿：x >= 3；不是旧例子所用的模型')
  owner.click('查看靶图修订 ' + (kind ? 'basis-reviewed' : 'basis-revised')); await owner.load()
}
for (const kind of ['personal', 'source', 'observation', 'ai']) {
  await openSavedBasisOwner(kind)
  const recordBefore = JSON.stringify(records), draftBefore = JSON.stringify([...storage]), writesBefore = writes
  owner.click('对照预测依据与此快照'); await owner.load()
  const section = owner.control('靶图历史预测依据对照')
  assert(text(section).includes('来自修订 basis-reviewed') && text(section).includes('所选历史快照，不含未保存草稿'))
  assert(!text(section).includes('也不自动追溯预测依据'), 'The explicit basis action has resolved this particular prediction reference')
  assert.equal(comparedText(['mapping'], 'history'), records[0].map.mapping)
  assert.equal(comparedText(['mapping'], 'reference'), records[2].map.mapping)
  owner.change('仅显示不同的上层字段', undefined, false)
  for (const id of ['force', 'before', 'after']) assert.equal(comparedText(['slots', id, 'unit'], 'history'), records[0].map.slots.find(item => item.id === id).unit)
  owner.click('对照例子记录')
  assert(owner.control('靶图历史快照例子对照'))
  assert.equal(all(owner.tree, item => item.props['aria-label'] === '靶图历史预测依据对照').length, 0, 'Generic example comparison is not a prediction-basis comparison')
  assert.equal(comparedText(['examples', 'same-prediction', 'feedback', 'source'], 'reference'), records[2].map.examples[0].feedback.source)
  assert.equal(all(comparedRow(['examples', 'same-prediction', 'feedback', 'source']), item => ['img', 'script'].includes(item.type)).length, 0)
  assert.equal(all(owner.tree, item => item.props['data-target-compare-side'] === 'history' && text(item).includes('相反结果')).length, 0)
  assert.equal(JSON.stringify(records), recordBefore); assert.equal(JSON.stringify([...storage]), draftBefore); assert.equal(writes, writesBefore)
  owner.click('返回未保存草稿'); assert(!owner.control('确认保存个人靶图').props.checked); owner.unmount()
}

await openSavedBasisOwner('ai', 2)
owner.click('对照预测依据与此快照'); await owner.load()
assert(owner.control('靶图历史预测依据对照'))
assert(text(owner.control('靶图历史预测依据对照')).includes('知识图第 1 版'))
assert(!text(owner.control('靶图历史预测依据对照')).includes('两侧基于不同知识图版本'), 'Both historical sides remain on version 1, even with a version 2 draft')
owner.click('返回未保存草稿'); assert.equal(owner.control('映射规律表述').props.value, '当前草稿：x >= 3；不是旧例子所用的模型')
owner.unmount(); doc.revision = 1

await openSavedBasisOwner()
owner.click('固定为对照快照')
const fixedBeforeFailure = all(owner.tree, item => item.props['data-target-history-reference'])[0].props['data-target-history-reference']
owner.click('对照预测依据与此快照')
const failedHistoryBasis = owner.pending().at(-1); failedHistoryBasis.reject(new Error('HTTP 503 archived basis')); failedHistoryBasis.settled = true; await owner.settle()
assert.equal(owner.control('映射规律表述').props.value, records[1].map.mapping)
assert.equal(all(owner.tree, item => item.props['data-target-history-reference'])[0].props['data-target-history-reference'], fixedBeforeFailure)
owner.click('重试读取历史靶图'); await owner.load(); assert(owner.control('靶图历史预测依据对照'))
owner.click('返回所选历史快照')
const failedOwnerRead = owner.pending().at(-1); failedOwnerRead.reject(new Error('HTTP 503 selected snapshot')); failedOwnerRead.settled = true; await owner.settle()
assert(!all(owner.tree, item => item.props['aria-label'] === '靶图历史预测依据对照').length)
assert.equal(owner.control('映射规律表述').props.value, records[0].map.mapping)
owner.click('重试读取历史靶图'); assert.equal(owner.pending().at(-1).args.recordId, 'basis-revised'); await owner.load()
assert.equal(owner.control('映射规律表述').props.value, records[1].map.mapping)
owner.click('查看靶图修订 basis-original'); await owner.load()
assert(owner.control('对照预测依据与此快照').props.disabled)
const selfRequestCount = owner.requests.length; owner.control('对照预测依据与此快照').props.onClick(); owner.render()
assert.equal(owner.requests.length, selfRequestCount, 'Captured self-pair callback is also rejected')
owner.unmount()

for (const corrupt of ['missing', 'future', 'empty', 'prototype']) {
  await openSavedBasisOwner()
  owner.click('返回未保存草稿')
  if (corrupt === 'missing') delete records[1].bases['same-prediction']
  if (corrupt === 'future') records[1].bases['same-prediction'].baseRevision = 2
  if (corrupt === 'empty') records[1].bases['same-prediction'].recordId = ''
  if (corrupt === 'prototype') records[1].bases = Object.create(records[1].bases)
  owner.click('查看靶图修订 basis-revised'); await owner.load()
  assert(text(owner.tree).includes('已保存预测依据不可用'), corrupt)
  assert.equal(all(owner.tree, item => item.type === 'button' && text(item) === '对照预测依据与此快照').length, 0, corrupt)
  owner.unmount()
}

for (const boundary of ['target', 'target_back', 'document', 'revision', 'hidden', 'unmount', 'cancel', 'newer_read', 'return', 'reload']) {
  await openSavedBasisOwner()
  const staleOpen = owner.control('对照预测依据与此快照').props.onClick
  owner.click('对照预测依据与此快照')
  const request = owner.pending().at(-1), response = tools.handle(doc, request.args, records)
  if (boundary === 'target' || boundary === 'target_back') { owner.click('打开靶图 externality'); await owner.load() }
  if (boundary === 'target_back') { owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'different-document'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'cancel') owner.click('取消读取历史靶图')
  if (boundary === 'newer_read') owner.click('查看靶图修订 basis-new-round')
  if (boundary === 'return') owner.click('返回未保存草稿')
  if (boundary === 'reload') { await owner.resolve(request, { error: { code: 'revision_conflict', message: 'changed' } }); owner.click('重读靶图'); await owner.load() }
  if (boundary !== 'cancel') { staleOpen(); owner.render() }
  await owner.resolve(request, response)
  if (boundary !== 'unmount') {
    assert.equal(all(owner.tree, item => item.props['aria-label'] === '靶图历史预测依据对照').length, 0, boundary)
    assert.equal(all(owner.tree, item => item.props['data-target-history-reference']).length, 0, boundary)
  }
  owner.unmount(); doc.revision = 1
}

for (const boundary of ['draft', 'examples', 'upper', 'clear', 'pending']) {
  await openSavedBasisOwner()
  owner.click('对照预测依据与此快照'); await owner.load()
  const staleOwnerReturn = owner.control('返回所选历史快照').props.onClick
  if (boundary === 'draft') owner.click('返回未保存草稿')
  if (boundary === 'examples') owner.click('对照例子记录')
  if (boundary === 'upper') owner.click('对照上层表述')
  if (boundary === 'clear') owner.click('取消固定快照')
  if (boundary === 'pending') owner.click('查看靶图修订 basis-new-round')
  const requestsBeforeStaleReturn = owner.requests.length
  staleOwnerReturn(); owner.render()
  assert.equal(owner.requests.length, requestsBeforeStaleReturn, boundary)
  owner.unmount()
}

const prepareOutcomeBrowse = () => {
  storage.clear(); records = []; doc.revision = 1
  const map = motionTargetMap()
  map.slots.push({ ...map.slots[2], id: 'later', scope: '另一对象，次日', unit: 'km/h' })
  map.outcomes.push({ id: 'all', slotId: 'later', label: map.outcomes[0].label, detail: '同名异身份，不应合并' },
    { id: 'uniform-copy', slotId: 'after', label: map.outcomes[0].label, detail: '相同文字但另一取值' })
  map.examples = Array.from({ length: 5 }, (_, index) => {
    const item = tools.example(map, 'outcome-case-' + index)
    item.context = '情境 ' + index + '；匀速直线运动只是文字，不是绑定依据'
    item.inputs[0].value = '0 N'; item.inputs[1].value = '原状态，1 m/s'
    item.process = '通常成立仍需核对，不能省略多个输入或改成必然'
    item.outputs[0].outcomeId = ['uniform', 'rest', '', 'uniform', 'uniform-copy'][index]
    item.outputs[1].outcomeId = index === 0 || index === 3 ? 'all' : ''
    if (index === 3) item.stage = 'prediction'
    return item
  })
  const result = tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    id: 'outcome-record', parentId: '', reason: '', confirm: true, map }, records)
  assert(result.saved, JSON.stringify(result.error)); records.push(result.saved)
}
const outcomeChoice = (slotId, id) => JSON.stringify([slotId, id])
const visibleCases = () => all(owner.tree, node => node.props['data-target-case-id'] && !node.props.hidden).map(node => node.props['data-target-case-id'])
prepareOutcomeBrowse(); owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
const browseStorage = JSON.stringify([...storage]), browseRecords = JSON.stringify(records), browseRequests = owner.requests.length, browseWrites = writes
assert.equal(owner.control('按输出取值查看例子').props.value, 'all')
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform'))
assert.deepEqual(visibleCases(), ['outcome-case-0', 'outcome-case-3'])
assert.equal(owner.control('例子 1 输入 force').props.value, '0 N')
assert.equal(owner.control('例子 1 输入 before').props.value, '原状态，1 m/s')
assert.equal(owner.control('例子 1 对应输出 later').props.value, 'all', 'Filtering keeps all necessary inputs and other outputs')
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform-copy'))
assert.deepEqual(visibleCases(), ['outcome-case-4'], 'Equal labels and free text cannot invent a binding')
owner.change('按输出取值查看例子', 'unassigned')
assert.deepEqual(visibleCases(), ['outcome-case-1', 'outcome-case-2', 'outcome-case-4'])
owner.change('按输出取值查看例子', outcomeChoice('later', 'all'))
assert.deepEqual(visibleCases(), ['outcome-case-0', 'outcome-case-3'], 'An outcome ID named all cannot select the all-examples mode')
owner.change('按输出取值查看例子', outcomeChoice('later', 'uniform'))
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('later', 'all'), 'Wrong-slot and unknown identities are rejected')
owner.click('查看对应例子 acceleration')
assert.deepEqual(visibleCases(), [])
assert.equal(owner.focused, 'data-target-example-list:heading')
assert(text(owner.tree).includes('此取值暂无对应例子记录'))
assert.equal(JSON.stringify([...storage]), browseStorage); assert.equal(JSON.stringify(records), browseRecords)
assert.equal(owner.requests.length, browseRequests); assert.equal(writes, browseWrites)
assert(!owner.control('确认保存个人靶图').props.checked)
owner.click('查看对应例子 uniform')
owner.click('查看靶图修订 outcome-record'); await owner.load()
assert.equal(owner.control('按输出取值查看例子').props.value, 'all', 'An archive has its own filter scope')
owner.change('按输出取值查看例子', 'unassigned')
assert(owner.control('例子 1 完整情境').props.disabled)
owner.click('返回未保存草稿')
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'uniform'))
owner.click('查看靶图修订 outcome-record')
const outcomeFailed = owner.pending().at(-1); outcomeFailed.reject(new Error('synthetic outage')); outcomeFailed.settled = true; await owner.settle()
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'uniform'))
owner.click('重试读取历史靶图'); await owner.load(); owner.click('返回未保存草稿')
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'uniform'))
owner.click('增加具体推测')
assert.equal(owner.control('按输出取值查看例子').props.value, 'all', 'A new empty example must not be hidden behind the current filter')
assert.equal(visibleCases().length, 6); owner.change('例子 6 完整情境', '未保存的新例子')
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform')); owner.change('按输出取值查看例子', 'all')
assert.equal(owner.control('例子 6 完整情境').props.value, '未保存的新例子'); owner.unmount()

for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'edit', 'archive', 'reload']) {
  prepareOutcomeBrowse(); owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
  const staleFilter = owner.control('查看对应例子 uniform').props.onClick
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'elsewhere'; owner.render() }
  if (boundary === 'revision') { owner.props.revision = 2; doc.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'edit') owner.change('适用条件', '变更后的条件')
  if (boundary === 'archive') { owner.click('查看靶图修订 outcome-record'); await owner.load() }
  if (boundary === 'reload') {
    owner.click('查看靶图修订 outcome-record'); const pending = owner.pending().at(-1)
    await owner.resolve(pending, { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  staleFilter(); owner.render()
  const filter = all(owner.tree, item => item.props['aria-label'] === '按输出取值查看例子')[0]
  if (filter) assert.equal(filter.props.value, 'all', boundary + ' must reject a stale navigation handler')
  owner.unmount(); doc.revision = 1
}

const prepareExamplePair = () => {
  prepareOutcomeBrowse()
  const map = records[0].map
  map.examples[1].context = map.examples[0].context
  map.examples[1].inputs[0].value = '0 N '
  map.examples[1].inputs[1].value = '另一物体，原状态 0 m/s'
  map.examples[1].process = '可能静止；不是必然'
  map.examples[1].outputs[1].detail = '次日状态未知，尚未归类'
  map.examples[1].stage = 'reviewed'
  map.examples[1].feedback = { kind: 'ai', text: '建议判断为静止，但资料说仍需观察', source: '合成建议，非独立观察' }
  map.examples[0].process = '通常成立，不是必然\n<script>not executed</script>'
  map.examples[2].inputs[0].value = ''
  tools.validate(map)
}
const pairRows = () => all(owner.control('两个例子字段对照'), node => node.props['data-target-compare-key'])
const pairText = (path, side) => {
  const row = pairRows().find(node => node.props['data-target-compare-key'] === JSON.stringify(path))
  assert(row, 'Missing pair row: ' + path)
  return text(all(row, node => node.props['data-target-compare-side'] === side)[0])
}
prepareExamplePair(); owner = mount({ focusRequest: focus }); await owner.load()
const pairStorage = JSON.stringify([...storage]), pairRecords = JSON.stringify(records), pairRequests = owner.requests.length, pairWrites = writes
assert.equal(owner.control('左侧例子').props.value, '')
assert.equal(owner.control('右侧例子').props.value, '')
owner.change('左侧例子', 'outcome-case-0'); owner.change('右侧例子', 'outcome-case-1')
assert(pairText(['context'], 'left').includes(records[0].map.examples[0].context))
assert(pairText(['context'], 'right').includes(records[0].map.examples[1].context), 'Equal context does not merge example identities')
assert(pairText(['inputs', 'force', 'value'], 'left').endsWith('0 N'))
assert(pairText(['inputs', 'force', 'value'], 'right').endsWith('0 N '), 'Whitespace is not normalized')
assert(pairText(['inputs', 'before', 'value'], 'right').includes('另一物体'))
assert(pairText(['outputs', 'later', 'slot', 'unit'], 'left').includes('km/h'))
assert(pairText(['outputs', 'after', 'slot', 'unit'], 'left').includes('m/s'))
assert(pairText(['outputs', 'later', 'slot', 'scope'], 'right').includes('另一对象，次日'))
assert(pairText(['outputs', 'after', 'outcomeId'], 'left').includes('uniform'))
assert(pairText(['process'], 'left').includes('<script>not executed</script>'))
assert(!all(owner.control('两个例子字段对照'), node => node.props.dangerouslySetInnerHTML).length)
assert(pairText(['feedback', 'kind'], 'right').includes('AI 建议'))
assert(pairText(['feedback', 'text'], 'left').includes('该侧无此字段'))
assert(text(owner.control('两个例子字段对照')).includes('不代表因果关系、验证通过或掌握'))
const allPairRows = pairRows().length
owner.change('仅显示两个例子的不同字段', undefined, true)
assert(pairRows().length < allPairRows); assert(!pairRows().some(node => node.props['data-target-compare-key'] === '["context"]'))
owner.change('仅显示两个例子的不同字段', undefined, false)
owner.change('右侧例子', 'outcome-case-0')
assert.equal(owner.control('右侧例子').props.value, 'outcome-case-1', 'Cannot compare an example with itself')
owner.change('右侧例子', 'unknown'); assert.equal(owner.control('右侧例子').props.value, 'outcome-case-1')
owner.change('右侧例子', 'outcome-case-4')
assert(pairText(['outputs', 'after', 'outcomeId'], 'right').includes('uniform-copy'))
owner.change('右侧例子', 'outcome-case-2'); assert(pairText(['inputs', 'force', 'value'], 'right').includes('空文本'))
owner.change('右侧例子', 'outcome-case-3'); assert(pairText(['stage'], 'right').includes('尚无对照结果'))
assert(!pairRows().some(node => node.props['data-target-compare-key'] === '["feedback","text"]'))
owner.change('按输出取值查看例子', outcomeChoice('after', 'rest'))
assert.equal(owner.control('左侧例子').props.value, 'outcome-case-0', 'Output browsing does not silently change the chosen pair')
assert(pairRows().length > 0)
assert.equal(JSON.stringify([...storage]), pairStorage); assert.equal(JSON.stringify(records), pairRecords)
assert.equal(owner.requests.length, pairRequests); assert.equal(writes, pairWrites)
assert(!owner.control('确认保存个人靶图').props.checked)
owner.change('适用条件', '未保存限定语'); assert.equal(owner.control('左侧例子').props.value, '', 'Editing invalidates the previous pair snapshot')
owner.change('左侧例子', 'outcome-case-0'); owner.change('右侧例子', 'outcome-case-1')
owner.click('查看靶图修订 outcome-record')
const pairFail = owner.pending().at(-1); pairFail.reject(new Error('pair fixture unavailable')); pairFail.settled = true; await owner.settle()
assert.equal(owner.control('左侧例子').props.value, 'outcome-case-0')
owner.click('重试读取历史靶图'); await owner.load()
assert.equal(owner.control('左侧例子').props.value, '', 'Archive never reuses a draft comparison')
owner.change('左侧例子', 'outcome-case-0'); owner.change('右侧例子', 'outcome-case-1')
assert(owner.control('例子 1 完整情境').props.disabled)
assert(text(owner.control('两个例子字段对照')).includes('历史快照'))
owner.click('返回未保存草稿'); assert.equal(owner.control('左侧例子').props.value, '')
assert.equal(owner.control('适用条件').props.value, '未保存限定语'); owner.unmount()

for (const [kind, label] of [['personal', '个人判断'], ['source', '资料答案'], ['observation', '观察记录'], ['ai', 'AI 建议']]) {
  prepareExamplePair(); records[0].map.examples[1].feedback.kind = kind
  owner = mount({ focusRequest: focus }); await owner.load()
  owner.change('左侧例子', 'outcome-case-0'); owner.change('右侧例子', 'outcome-case-1')
  assert(pairText(['feedback', 'kind'], 'right').includes(label)); owner.unmount()
}
prepareExamplePair()
records[0].map.examples = Array.from({ length: 40 }, (_, index) => ({ ...structuredClone(records[0].map.examples[0]), id: 'same-' + index }))
owner = mount({ focusRequest: focus }); await owner.load()
owner.change('左侧例子', 'same-0'); owner.change('右侧例子', 'same-39')
assert.equal(owner.control('右侧例子').props.value, 'same-39')
assert(pairRows().length < 60, 'Only the selected pair is expanded, not all 40-by-40 combinations')
owner.change('仅显示两个例子的不同字段', undefined, true)
assert.equal(pairRows().length, 1, 'Identical content is not collapsed into one identity; only its position differs')
owner.unmount()
prepareExamplePair(); records[0].map.examples = []
owner = mount({ focusRequest: focus }); await owner.load()
assert(text(owner.control('两个例子字段对照')).includes('当前不足两个例子记录'))
owner.change('左侧例子', 'outcome-case-0'); assert.equal(owner.control('左侧例子').props.value, ''); owner.unmount()

for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'edit', 'archive', 'reload']) {
  prepareExamplePair(); owner = mount({ focusRequest: focus }); await owner.load()
  owner.change('左侧例子', 'outcome-case-0'); owner.change('右侧例子', 'outcome-case-1')
  const stalePick = owner.control('右侧例子').props.onChange, staleDifference = owner.control('仅显示两个例子的不同字段').props.onChange
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'elsewhere'; owner.render() }
  if (boundary === 'revision') { owner.props.revision = 2; doc.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'edit') owner.change('适用条件', '另一条限定语')
  if (boundary === 'archive') { owner.click('查看靶图修订 outcome-record'); await owner.load() }
  if (boundary === 'reload') {
    owner.click('查看靶图修订 outcome-record'); await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  stalePick({ target: { value: 'outcome-case-3' } }); staleDifference({ target: { checked: true } }); owner.render()
  const picker = all(owner.tree, node => node.props['aria-label'] === '右侧例子')[0]
  if (picker && boundary !== 'unmount') assert.equal(picker.props.value, '', boundary + ' rejects stale pair handlers')
  assert.equal(writes, pairWrites); owner.unmount(); doc.revision = 1
}

prepareOutcomeBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
const editRecords = JSON.stringify(records), editRequests = owner.requests.length, editWrites = writes
const editKey = 'dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'motion', 1])
const editBefore = JSON.parse(storage.get(editKey))
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform'))
owner.change('确认保存个人靶图', undefined, true)
owner.change('例子 1 对应输出 after', 'rest')
assert(visibleCases().includes('outcome-case-0'), 'Changing the selected output must not hide the example being edited')
assert.equal(owner.control('按输出取值查看例子').props.value, 'all')
assert.equal(owner.control('例子 1 对应输出 after').props.value, 'rest')
assert(text(owner.tree).includes('例子记录已改变，已调整筛选以保留当前编辑'))
assert(!owner.control('确认保存个人靶图').props.checked, 'An edit still revokes save approval')
editBefore.map.examples[0].outputs[0].outcomeId = 'rest'
assert.deepEqual(JSON.parse(storage.get(editKey)), editBefore, 'Only the explicit output edit may change the draft')
assert.equal(JSON.stringify(records), editRecords); assert.equal(writes, editWrites); assert.equal(owner.requests.length, editRequests)
owner.change('按输出取值查看例子', outcomeChoice('after', 'rest'))
owner.change('例子 1 推测过程', '通常静止，不是必然；不能省略另一必要输入')
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'rest'), 'Unrelated field edits preserve the filter')
owner.change('例子 1 对应输出 later', '')
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'rest'), 'Changing another output preserves a still-matching filter')
owner.change('按输出取值查看例子', 'unassigned')
owner.change('例子 3 对应输出 after', 'uniform')
assert.equal(owner.control('按输出取值查看例子').props.value, 'unassigned', 'Another unassigned output still matches')
owner.change('例子 3 对应输出 later', 'all')
assert.equal(owner.control('按输出取值查看例子').props.value, 'all')
assert(visibleCases().includes('outcome-case-2'), 'Assigning the last missing output keeps the edited example visible')
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform'))
owner.change('例子 3 对应输出 after', 'uniform-copy')
assert.equal(owner.control('按输出取值查看例子').props.value, 'all', 'Equal labels do not substitute for exact outcome identity')
assert.equal(owner.control('例子 3 输入 force').props.value, '0 N')
assert.equal(owner.control('例子 3 输入 before').props.value, '原状态，1 m/s')
assert.equal(owner.control('例子 3 对应输出 later').props.value, 'all')
const changedDraft = storage.get(editKey)
owner.click('查看靶图修订 outcome-record')
const editFailed = owner.pending().at(-1); editFailed.reject(new Error('edit fixture unavailable')); editFailed.settled = true; await owner.settle()
assert.equal(storage.get(editKey), changedDraft)
owner.click('重试读取历史靶图'); await owner.load()
assert.equal(owner.control('例子 3 对应输出 after').props.value, '')
assert(owner.control('例子 3 对应输出 after').props.disabled)
assert(!text(owner.tree).includes('例子记录已改变，已调整筛选以保留当前编辑'), 'Draft edit feedback must not appear in an unchanged archive')
owner.click('返回未保存草稿')
assert.equal(owner.control('例子 3 对应输出 after').props.value, 'uniform-copy')
assert.equal(storage.get(editKey), changedDraft)
owner.click('打开靶图 externality'); await owner.load()
assert(!text(owner.tree).includes('例子记录已改变，已调整筛选以保留当前编辑'), 'Edit feedback cannot follow a different target')
owner.unmount()

for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'edit', 'archive', 'reload', 'filter', 'hidden_example', 'busy', 'read_pending', 'save_pending', 'read_pending_sync', 'save_pending_sync']) {
  prepareOutcomeBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
  owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform'))
  let staleEdit = owner.control('例子 1 对应输出 after').props.onChange
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'elsewhere'; owner.render() }
  if (boundary === 'revision') { owner.props.revision = 2; doc.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'edit') owner.change('适用条件', '保留更新的限定语')
  if (boundary === 'archive') { owner.click('查看靶图修订 outcome-record'); await owner.load() }
  if (boundary === 'reload') {
    owner.click('查看靶图修订 outcome-record'); await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  if (boundary === 'filter') owner.change('按输出取值查看例子', outcomeChoice('after', 'rest'))
  if (boundary === 'hidden_example') { owner.change('按输出取值查看例子', outcomeChoice('after', 'rest')); staleEdit = owner.control('例子 1 对应输出 after').props.onChange }
  if (boundary === 'busy') { owner.props.busy = true; owner.render() }
  if (boundary === 'read_pending') owner.click('查看靶图修订 outcome-record')
  if (boundary === 'save_pending') { owner.change('确认保存个人靶图', undefined, true); owner.click('保存个人靶图') }
  if (boundary === 'read_pending_sync') owner.control('查看靶图修订 outcome-record').props.onClick()
  if (boundary === 'save_pending_sync') { owner.change('确认保存个人靶图', undefined, true); owner.control('保存个人靶图').props.onClick() }
  const before = JSON.stringify([...storage]), saved = JSON.stringify(records), requests = owner.requests.length
  const filter = all(owner.tree, node => node.props['aria-label'] === '按输出取值查看例子')[0]?.props.value
  staleEdit({ target: { value: 'uniform-copy' } }); owner.render()
  assert.equal(JSON.stringify([...storage]), before, boundary + ' cannot mutate draft storage through an old example handler')
  assert.equal(JSON.stringify(records), saved); assert.equal(owner.requests.length, requests)
  assert.equal(all(owner.tree, node => node.props['aria-label'] === '按输出取值查看例子')[0]?.props.value, filter, boundary + ' cannot clear the current filter')
  owner.unmount(); doc.revision = 1
}

prepareOutcomeBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
owner.change('按记录阶段查看例子', 'prediction_saved')
assert.deepEqual(visibleCases(), ['outcome-case-3'], 'Pending saved predictions must be discoverable without opening every example')
assert(owner.control('例子 4 完整情境').props.disabled)
owner.unmount()

const prepareStageBrowse = () => {
  prepareOutcomeBrowse()
  const map = structuredClone(records[0].map); records = []
  for (const [index, item] of map.examples.entries()) {
    item.outputs[0].outcomeId = index === 1 ? 'rest' : 'uniform'
    item.outputs[1].outcomeId = 'all'
    item.stage = [1, 2, 3].includes(index) ? 'prediction' : 'material'
    item.context = '同文但不同身份；多个输入和限定语不得忽略'
  }
  const args = { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion', reason: '记录阶段隔离夹具', confirm: true }
  const first = tools.handle(doc, { ...args, id: 'stage-predictions', parentId: '', map }, records)
  assert(first.saved, JSON.stringify(first.error)); records.push(first.saved)
  const revised = structuredClone(map)
  revised.examples[2].stage = 'reviewed'
  revised.examples[2].feedback = { kind: 'ai', text: '可能成立，另一个材料给出相反结果', source: '合成 AI 建议，不是独立观察' }
  const second = tools.handle(doc, { ...args, id: 'stage-feedback', parentId: 'stage-predictions', map: revised }, records)
  assert(second.saved, JSON.stringify(second.error)); records.push(second.saved)
}
prepareStageBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
owner.change('按对照来源查看例子', 'ai')
assert.deepEqual(visibleCases(), ['outcome-case-2'], 'Find AI suggestions without treating them as independently verified examples')
owner.unmount()

const prepareFeedbackBrowse = () => {
  prepareOutcomeBrowse()
  const map = structuredClone(records[0].map); records = []
  map.examples = Array.from({ length: 6 }, (_, index) => {
    const item = structuredClone(map.examples[0])
    item.id = index === 4 ? '__proto__' : 'feedback-' + index
    item.context = '同文同名：AI 建议、资料答案和观察只是情境文字'
    item.stage = index ? 'prediction' : 'material'; item.exposure = 'known'; item.feedback.kind = 'ai'
    item.outputs[0].outcomeId = index === 1 ? 'rest' : 'uniform'
    return item
  })
  const args = { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion', reason: '来源筛选隔离夹具', confirm: true }
  const first = tools.handle(doc, { ...args, id: 'feedback-predictions', parentId: '', map }, records)
  assert(first.saved, JSON.stringify(first.error)); records.push(first.saved)
  const revised = structuredClone(map)
  for (const [index, kind] of ['personal', 'source', 'observation', 'ai'].entries()) {
    revised.examples[index + 1].stage = 'reviewed'
    revised.examples[index + 1].feedback = { kind, text: '通常如此，另一份材料给出相反结果', source: '<img src=x onerror=alert(1)> 来源尚待核对' }
  }
  const second = tools.handle(doc, { ...args, id: 'feedback-sources', parentId: first.saved.id, map: revised }, records)
  assert(second.saved, JSON.stringify(second.error)); records.push(second.saved)
}
prepareFeedbackBrowse(); owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
owner.change('确认保存个人靶图', undefined, true)
const feedbackRecords = JSON.stringify(records), feedbackStorage = JSON.stringify([...storage]), feedbackRequests = owner.requests.length, feedbackWrites = writes
for (const [kind, ids] of [['none', ['feedback-0', 'feedback-5']], ['personal', ['feedback-1']], ['source', ['feedback-2']],
  ['observation', ['feedback-3']], ['ai', ['__proto__']]]) {
  owner.change('按对照来源查看例子', kind)
  assert.deepEqual(visibleCases(), ids, 'Only the recorded stage and kind classify examples: ' + kind)
}
assert(text(owner.tree).includes('不代表验证通过'))
assert(text(all(owner.tree, node => node.props['data-target-case-id'] === '__proto__')[0]).includes('未独立验证 · AI 建议'))
assert.equal(owner.control('例子 5 输入 before').props.value, '原状态，1 m/s')
assert.equal(owner.control('例子 5 对应输出 later').props.value, 'all')
for (const invalid of ['verified', 'mastered', 'AI', '', null, {}, 'source ']) {
  owner.change('按对照来源查看例子', invalid); assert.equal(owner.control('按对照来源查看例子').props.value, 'ai')
}
owner.change('按记录阶段查看例子', 'prediction_saved'); assert.deepEqual(visibleCases(), [])
assert(text(owner.tree).includes('当前筛选组合下没有例子记录；不表示该情境不可能或已全部验证'))
owner.change('按记录阶段查看例子', 'reviewed_saved'); owner.change('搜索例子文字', '相反结果')
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform-copy')); assert.deepEqual(visibleCases(), [])
owner.change('按输出取值查看例子', outcomeChoice('later', 'all')); assert.deepEqual(visibleCases(), ['__proto__'])
assert.equal(JSON.stringify([...storage]), feedbackStorage); assert.equal(JSON.stringify(records), feedbackRecords)
assert.equal(owner.requests.length, feedbackRequests); assert.equal(writes, feedbackWrites); assert(owner.control('确认保存个人靶图').props.checked)
owner.click('查看对应例子 uniform'); assert.equal(owner.control('按对照来源查看例子').props.value, 'all')
assert.deepEqual(visibleCases(), ['feedback-0', 'feedback-2', 'feedback-3', '__proto__', 'feedback-5'])
owner.change('按记录阶段查看例子', 'prediction_saved'); owner.change('按对照来源查看例子', 'none'); owner.change('搜索例子文字', '同文')
owner.click('填写对照结果')
assert.equal(owner.control('按对照来源查看例子').props.value, 'all'); assert.equal(owner.control('按记录阶段查看例子').props.value, 'all')
assert.equal(owner.control('搜索例子文字').props.value, '同文')
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'uniform'))
assert.equal(owner.focused, 'data-target-example-feedback:feedback-5')
owner.change('按记录阶段查看例子', 'reviewed_draft'); owner.change('按对照来源查看例子', 'ai')
assert.deepEqual(visibleCases(), ['feedback-5'], 'An unsaved source declaration remains a draft')
for (const invalid of ['verified', 'none', 'all', null, {}]) {
  const before = storage.get(editKey)
  owner.change('例子 6 结果来源', invalid)
  assert.equal(storage.get(editKey), before, 'Invalid source edits cannot corrupt the draft or break source filtering')
  assert.equal(owner.control('例子 6 结果来源').props.value, 'ai')
}
owner.change('例子 6 结果来源', 'personal')
assert.equal(owner.control('按对照来源查看例子').props.value, 'all', 'Changing source keeps its editor visible')
assert.equal(owner.control('按记录阶段查看例子').props.value, 'reviewed_draft'); assert.deepEqual(visibleCases(), ['feedback-5'])
owner.change('例子 6 对照结果', '通常如此，但反例尚未排除'); owner.change('例子 6 结果来源说明', '我自己的判断，不是独立观察')
owner.change('按对照来源查看例子', 'personal')
const feedbackDraft = storage.get(editKey), feedbackNavigation = owner.navigation, feedbackIntent = feedbackNavigation.get(navigationKey())
assert(!feedbackIntent.includes('反例尚未排除')); assert(!feedbackIntent.includes('我自己的判断'))
assert.equal(JSON.parse(feedbackIntent).state.examplePosition.feedback, 'personal')
owner.unmount(); owner = mount({ navigation: feedbackNavigation }); await owner.load()
assert.equal(owner.control('按对照来源查看例子').props.value, 'personal'); assert.deepEqual(visibleCases(), ['feedback-5'])
assert(!owner.control('确认保存个人靶图').props.checked); assert.equal(storage.get(editKey), feedbackDraft)
owner.click('查看靶图修订 feedback-predictions')
const feedbackFailure = owner.pending().at(-1); feedbackFailure.reject(new Error('503 source filter')); feedbackFailure.settled = true; await owner.settle()
assert.equal(owner.control('按对照来源查看例子').props.value, 'personal')
owner.click('重试读取历史靶图'); await owner.load()
owner.change('按对照来源查看例子', 'ai'); assert.deepEqual(visibleCases(), [], 'Old predictions cannot borrow later feedback')
owner.change('按对照来源查看例子', 'none'); assert.equal(visibleCases().length, 6)
assert(owner.control('例子 6 完整情境').props.disabled); assert.equal(owner.navigation.get(navigationKey()), feedbackIntent)
owner.click('返回未保存草稿'); assert.equal(owner.control('按对照来源查看例子').props.value, 'personal')
assert.equal(storage.get(editKey), feedbackDraft)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
assert.equal(owner.control('按对照来源查看例子').props.value, 'all')
owner.change('按对照来源查看例子', 'personal'); owner.change('按记录阶段查看例子', 'unconfirmed')
assert.deepEqual(visibleCases(), ['feedback-1', 'feedback-5']); assert(owner.control('例子 6 对照结果').props.disabled)
assert.equal(storage.get(editKey), feedbackDraft); assert.equal(JSON.stringify(records), feedbackRecords); assert.equal(writes, feedbackWrites)
owner.unmount(); doc.revision = 1

for (const feedback of [undefined, null, 'verified', {}, 'AI', 1]) {
  const envelope = JSON.parse(feedbackIntent)
  if (feedback === undefined) delete envelope.state.examplePosition.feedback
  else envelope.state.examplePosition.feedback = feedback
  owner = mount({ navigation: new Map([[navigationKey(), JSON.stringify(envelope)]]) }); await owner.load()
  assert.equal(owner.control('按对照来源查看例子').props.value, 'all')
  assert.equal(owner.control('搜索例子文字').props.value, feedback === undefined ? '同文' : '', 'Legacy compatible, invalid enum rejected')
  assert.equal(storage.get(editKey), feedbackDraft); owner.unmount()
}
owner = mount({ navigation: new Map([[navigationKey(), feedbackIntent]]) })
await owner.resolve(owner.pending().find(item => item.args.action === 'catalog'))
const feedbackRestoreFailure = owner.pending().find(item => item.args.action === 'read')
feedbackRestoreFailure.reject(new Error('503 feedback intent restore')); feedbackRestoreFailure.settled = true; await owner.settle()
assert.equal(JSON.parse(owner.navigation.get(navigationKey())).state.examplePosition.feedback, 'personal')
owner.click('重读靶图'); await owner.load()
assert.equal(owner.control('按对照来源查看例子').props.value, 'personal'); assert.deepEqual(visibleCases(), ['feedback-5'])
owner.change('按对照来源查看例子', 'ai'); owner.click('增加具体推测')
assert.equal(owner.control('按对照来源查看例子').props.value, 'all'); assert.equal(visibleCases().length, 7); owner.unmount()

for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'edit', 'archive', 'output', 'stage', 'query', 'feedback', 'pending', 'pending_sync']) {
  prepareFeedbackBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
  const staleFilter = owner.control('按对照来源查看例子').props.onChange
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'elsewhere'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'edit') owner.change('适用条件', '另一条限定语')
  if (boundary === 'archive') { owner.click('查看靶图修订 feedback-predictions'); await owner.load() }
  if (boundary === 'output') owner.change('按输出取值查看例子', 'unassigned')
  if (boundary === 'stage') owner.change('按记录阶段查看例子', 'material')
  if (boundary === 'query') owner.change('搜索例子文字', '同文')
  if (boundary === 'feedback') owner.change('按对照来源查看例子', 'source')
  if (boundary === 'pending') owner.click('查看靶图修订 feedback-predictions')
  if (boundary === 'pending_sync') owner.control('查看靶图修订 feedback-predictions').props.onClick()
  const state = () => JSON.stringify([[...owner.navigation], [...storage], records, owner.requests.length,
    all(owner.tree, node => node.props['aria-label'] === '按对照来源查看例子')[0]?.props.value])
  const before = state(); staleFilter({ target: { value: 'ai' } }); owner.render(); assert.equal(state(), before, boundary)
  owner.unmount(); doc.revision = 1
}
for (const boundary of ['hidden_editor', 'old_visible_editor', 'old_filter']) {
  prepareFeedbackBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
  const oldEdit = owner.control('例子 1 完整情境').props.onChange, oldOutput = owner.control('按输出取值查看例子').props.onChange
  owner.change('按对照来源查看例子', boundary === 'old_visible_editor' ? 'none' : 'ai')
  const before = JSON.stringify([...storage]), navigation = JSON.stringify([...owner.navigation]), requests = owner.requests.length
  if (boundary === 'hidden_editor') owner.change('例子 1 完整情境', '隐藏回调不应改变草稿')
  if (boundary === 'old_visible_editor') oldEdit({ target: { value: '旧来源筛选回调不应改变草稿' } })
  if (boundary === 'old_filter') oldOutput({ target: { value: 'unassigned' } })
  owner.render(); assert.equal(JSON.stringify([...storage]), before, boundary)
  assert.equal(JSON.stringify([...owner.navigation]), navigation); assert.equal(owner.requests.length, requests); owner.unmount()
}

prepareFeedbackBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
const exampleDetails = id => all(owner.tree, node => node.props['data-target-case-id'] === id)[0]
const toggleExample = (id, open) => {
  const element = { open }
  assert.equal(typeof exampleDetails(id).props.onToggle, 'function', 'Example expansion needs scoped navigation state, not uncontrolled DOM state')
  exampleDetails(id).props.onToggle({ currentTarget: element, target: element }); owner.render()
}
toggleExample('__proto__', true)
assert.equal(exampleDetails('__proto__').props.open, true)
const expansionRecords = JSON.stringify(records), expansionWrites = writes, expansionStorage = JSON.stringify([...storage]), expansionRequests = owner.requests.length
owner.change('确认保存个人靶图', undefined, true)
toggleExample('feedback-1', true); toggleExample('feedback-0', true); toggleExample('feedback-0', false)
assert.equal(exampleDetails('feedback-1').props.open, true); assert.equal(exampleDetails('feedback-2').props.open, false, 'Identical labels do not share expansion')
owner.change('按对照来源查看例子', 'ai')
assert.equal(exampleDetails('feedback-1').props.hidden, true)
toggleExample('feedback-1', false)
owner.change('按对照来源查看例子', 'all')
assert.equal(exampleDetails('feedback-1').props.open, true, 'A hidden toggle cannot rewrite navigation intent')
assert.equal(owner.requests.length, expansionRequests); assert.equal(JSON.stringify([...storage]), expansionStorage)
assert.equal(JSON.stringify(records), expansionRecords); assert.equal(writes, expansionWrites)
assert(owner.control('确认保存个人靶图').props.checked, 'Expansion is browsing, not a draft mutation or approval change')
const draftCaseKey = exampleDetails('__proto__').props.key
owner.click('查看靶图修订 feedback-predictions')
const expansionReadFailure = owner.pending().at(-1)
expansionReadFailure.reject(new Error('503 expansion')); expansionReadFailure.settled = true; await owner.settle()
assert.equal(exampleDetails('__proto__').props.open, true)
owner.click('重试读取历史靶图'); await owner.load()
assert.equal(exampleDetails('__proto__').props.open, false, 'The same ID in history cannot borrow draft DOM expansion')
assert.notEqual(exampleDetails('__proto__').props.key, draftCaseKey, 'DOM identity includes the selected snapshot, not just example ID')
const expansionArchiveNavigation = JSON.stringify([...owner.navigation])
toggleExample('feedback-2', true)
owner.click('对照上层表述'); owner.click('快照内容')
assert.equal(exampleDetails('feedback-2').props.open, true, 'Returning from comparison preserves the same snapshot expansion')
assert.equal(JSON.stringify([...owner.navigation]), expansionArchiveNavigation, 'Do not cache historical responses or expansion as draft intent')
owner.click('查看靶图修订 feedback-sources'); await owner.load()
assert.equal(exampleDetails('feedback-2').props.open, false, 'A different snapshot starts independently even with reused IDs')
toggleExample('feedback-3', true); owner.click('返回未保存草稿')
assert.equal(exampleDetails('__proto__').props.open, true); assert.equal(exampleDetails('feedback-1').props.open, true)
assert.equal(exampleDetails('feedback-3').props.open, false); assert.equal(exampleDetails('feedback-0').props.open, false)
assert.equal(JSON.stringify([...storage]), expansionStorage)
owner.change('搜索例子文字', '同文'); owner.change('按输出取值查看例子', outcomeChoice('later', 'all'))
const expansionNavigation = new Map(owner.navigation), expansionEnvelope = JSON.parse(owner.navigation.get(navigationKey()))
assert.deepEqual(expansionEnvelope.state.examplePosition.expansion, [['__proto__', true], ['feedback-1', true], ['feedback-0', false]])
assert(!JSON.stringify(expansionEnvelope).includes('来源尚待核对')); assert(!JSON.stringify(expansionEnvelope).includes('原状态'))
owner.unmount(); owner = mount({ navigation: expansionNavigation })
const expansionInitialRead = owner.pending().find(item => item.args.action === 'read')
await owner.resolve(owner.pending().find(item => item.args.action === 'catalog'))
expansionInitialRead.reject(new Error('503 restore expansion')); expansionInitialRead.settled = true; await owner.settle()
assert.equal(exampleDetails('__proto__'), undefined, 'Navigation cannot render cached records before a successful read')
assert.deepEqual(JSON.parse(owner.navigation.get(navigationKey())).state.examplePosition.expansion, expansionEnvelope.state.examplePosition.expansion)
owner.click('重读靶图'); await owner.load()
assert.equal(exampleDetails('__proto__').props.open, true); assert.equal(exampleDetails('feedback-1').props.open, true)
assert.equal(exampleDetails('feedback-0').props.open, false); assert.equal(owner.control('搜索例子文字').props.value, '同文')
assert(!owner.control('确认保存个人靶图').props.checked); assert.equal(JSON.stringify([...storage]), expansionStorage)
owner.click('增加具体推测')
let freshCase = all(owner.tree, node => node.props['data-target-case-id']).at(-1)
const freshCaseId = freshCase.props['data-target-case-id']
assert.equal(freshCase.props.open, true, 'New examples are immediately editable')
toggleExample(freshCaseId, false); owner.change('适用条件', '新增例子的折叠不因其他草稿编辑而重开')
assert.equal(exampleDetails(freshCaseId).props.open, false)
const expansionWithDraft = storage.get(editKey), expansionWithDraftNavigation = owner.navigation
owner.unmount(); owner = mount({ navigation: expansionWithDraftNavigation }); await owner.load()
assert.equal(exampleDetails(freshCaseId).props.open, false, 'Closed unsaved example remains closed after refresh')
assert.equal(exampleDetails('__proto__').props.open, true); assert.equal(storage.get(editKey), expansionWithDraft)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
assert.equal(exampleDetails('__proto__').props.open, false, 'Expansion never crosses graph versions')
assert(owner.control('例子 1 完整情境').props.disabled)
assert.equal(storage.get(editKey), expansionWithDraft); assert.equal(JSON.stringify(records), expansionRecords); assert.equal(writes, expansionWrites)
owner.unmount(); doc.revision = 1

for (const expansion of [undefined, [['missing', true]], [['__proto__', true]], null, {}, 'all', [['feedback-1', 1]],
  [['feedback-1', true], ['feedback-1', false]], [['', true]], [['x'.repeat(121), true]], [['feedback-1', true, false]], Array.from({ length: 41 }, (_, i) => ['case-' + i, true])]) {
  const envelope = structuredClone(expansionEnvelope)
  if (expansion === undefined) delete envelope.state.examplePosition.expansion
  else envelope.state.examplePosition.expansion = expansion
  owner = mount({ navigation: new Map([[navigationKey(), JSON.stringify(envelope)]]) }); await owner.load()
  assert.equal(exampleDetails('__proto__').props.open, Array.isArray(expansion) && expansion.length === 1 && expansion[0][0] === '__proto__')
  const valid = expansion === undefined || Array.isArray(expansion) && expansion.length === 1 && ['missing', '__proto__'].includes(expansion[0][0])
  assert.equal(owner.control('搜索例子文字').props.value, valid ? '同文' : '', 'Invalid expansion rejects the scoped intent; legacy fields still work')
  const restored = JSON.parse(owner.navigation.get(navigationKey())).state.examplePosition
  if (valid && expansion?.[0]?.[0] === 'missing') assert.deepEqual(restored.expansion, [], 'Deleted identities are not replaced by the first or same-name example')
  assert.equal(storage.get(editKey), expansionWithDraft); owner.unmount()
}

for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'edit', 'archive', 'output', 'stage', 'query', 'feedback', 'toggle', 'pending', 'pending_sync']) {
  prepareFeedbackBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
  const staleToggle = exampleDetails('__proto__').props.onToggle
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'elsewhere'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'edit') owner.change('适用条件', '当前限定语')
  if (boundary === 'archive') { owner.click('查看靶图修订 feedback-predictions'); await owner.load() }
  if (boundary === 'output') owner.change('按输出取值查看例子', 'unassigned')
  if (boundary === 'stage') owner.change('按记录阶段查看例子', 'material')
  if (boundary === 'query') owner.change('搜索例子文字', '同文')
  if (boundary === 'feedback') owner.change('按对照来源查看例子', 'source')
  if (boundary === 'toggle') toggleExample('feedback-1', true)
  if (boundary === 'pending') owner.click('查看靶图修订 feedback-predictions')
  if (boundary === 'pending_sync') owner.control('查看靶图修订 feedback-predictions').props.onClick()
  const state = () => JSON.stringify([[...owner.navigation], [...storage], records, owner.requests.length,
    all(owner.tree, node => node.props['data-target-case-id']).map(node => [node.props['data-target-case-id'], node.props.open])])
  const before = state(), element = { open: true }; staleToggle({ target: element, currentTarget: element }); owner.render()
  assert.equal(state(), before, 'Late toggle rejected: ' + boundary)
  owner.unmount(); doc.revision = 1
}
prepareFeedbackBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
for (const [open, connected, nested] of [['true', true, false], [true, false, false], [true, true, true]]) {
  const before = JSON.stringify([...owner.navigation]), element = { open, isConnected: connected }
  exampleDetails('__proto__').props.onToggle({ currentTarget: element, target: nested ? {} : element }); owner.render()
  assert.equal(exampleDetails('__proto__').props.open, false); assert.equal(JSON.stringify([...owner.navigation]), before)
}
owner.unmount()

prepareFeedbackBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
const committedExpansionHandler = exampleDetails('__proto__').props.onToggle
owner.render()
const committedExpansionElement = { open: true }
committedExpansionHandler({ target: committedExpansionElement, currentTarget: committedExpansionElement }); owner.render()
assert.equal(exampleDetails('__proto__').props.open, true, 'An unchanged render must not invalidate the still-committed DOM toggle handler')
owner.unmount()

prepareStageBrowse(); owner = mount({ recordNavigation: true, focusRequest: focus }); await owner.load()
owner.change('确认保存个人靶图', undefined, true)
const stageStorage = JSON.stringify([...storage]), stageRecords = JSON.stringify(records), stageRequests = owner.requests.length, stageWrites = writes
for (const [stage, ids] of [['material', [0, 4]], ['prediction_saved', [1, 3]], ['reviewed_saved', [2]], ['prediction_draft', []], ['reviewed_draft', []], ['unconfirmed', []]]) {
  owner.change('按记录阶段查看例子', stage)
  assert.deepEqual(visibleCases(), ids.map(id => 'outcome-case-' + id), stage)
}
assert(text(owner.tree).includes('当前筛选组合下没有例子记录；不表示该情境不可能或已全部验证'))
owner.change('按记录阶段查看例子', 'prediction_saved')
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform'))
assert.deepEqual(visibleCases(), ['outcome-case-3'], 'Stage and output filters intersect, never merge same-text examples')
assert.equal(owner.control('例子 4 输入 before').props.value, '原状态，1 m/s')
assert.equal(owner.control('例子 4 对应输出 later').props.value, 'all')
owner.change('按记录阶段查看例子', 'verified')
assert.equal(owner.control('按记录阶段查看例子').props.value, 'prediction_saved', 'No invented verified or mastered state')
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform-copy'))
assert.deepEqual(visibleCases(), [])
owner.click('查看对应例子 uniform')
assert.equal(owner.control('按记录阶段查看例子').props.value, 'all', 'An upper output link reveals all examples counted there')
assert.deepEqual(visibleCases(), ['outcome-case-0', 'outcome-case-2', 'outcome-case-3', 'outcome-case-4'])
assert.equal(JSON.stringify([...storage]), stageStorage); assert.equal(JSON.stringify(records), stageRecords)
assert.equal(owner.requests.length, stageRequests); assert.equal(writes, stageWrites)
assert(owner.control('确认保存个人靶图').props.checked, 'Pure browsing does not change approval')
owner.change('按记录阶段查看例子', 'prediction_saved')
all(all(owner.tree, node => node.props['data-target-case-id'] === 'outcome-case-3')[0], node => node.type === 'button' && text(node) === '填写对照结果')[0].props.onClick()
owner.render()
assert(visibleCases().includes('outcome-case-3'), 'Starting feedback keeps the editor visible')
assert.equal(owner.focused, 'data-target-example-feedback:outcome-case-3', 'The removed start button hands focus to the feedback form')
assert.equal(owner.control('按记录阶段查看例子').props.value, 'all')
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'uniform'), 'Only the invalidated stage filter resets')
owner.change('例子 4 对照结果', '尚待人工核对，不把字段填全当成验证')
owner.change('例子 4 结果来源说明', '个人推测')
owner.change('按记录阶段查看例子', 'reviewed_draft')
assert.deepEqual(visibleCases(), ['outcome-case-3'])
assert(!owner.control('确认保存个人靶图').props.checked)
owner.change('按记录阶段查看例子', 'reviewed_saved')
assert.deepEqual(visibleCases(), ['outcome-case-2'], 'Unsaved feedback cannot become recorded feedback')
assert(text(all(owner.tree, node => node.props['data-target-case-id'] === 'outcome-case-2')[0]).includes('未独立验证'))
assert.equal(owner.control('例子 3 结果来源').props.value, 'ai')
owner.click('增加具体推测')
assert.equal(owner.control('按记录阶段查看例子').props.value, 'all')
assert.equal(owner.control('按输出取值查看例子').props.value, 'all')
owner.change('例子 6 完整情境', '未保存预测的独立情境'); owner.change('例子 6 先记录预测', undefined, true)
owner.change('按记录阶段查看例子', 'prediction_draft')
assert.equal(visibleCases().length, 1)
assert.equal(owner.control('例子 6 完整情境').props.value, '未保存预测的独立情境')
owner.change('例子 6 先记录预测', undefined, false)
assert.equal(owner.control('按记录阶段查看例子').props.value, 'all', 'Changing a draft stage never hides its form')
owner.change('按记录阶段查看例子', 'reviewed_draft')
const stageEditedStorage = JSON.stringify([...storage])
owner.click('查看靶图修订 stage-predictions')
const stageFailed = owner.pending().at(-1); stageFailed.reject(new Error('stage outage')); stageFailed.settled = true; await owner.settle()
assert.equal(owner.control('按记录阶段查看例子').props.value, 'reviewed_draft')
owner.click('重试读取历史靶图'); await owner.load()
assert.equal(owner.control('按记录阶段查看例子').props.value, 'all')
owner.change('按记录阶段查看例子', 'prediction_saved')
assert.deepEqual(visibleCases(), ['outcome-case-1', 'outcome-case-2', 'outcome-case-3'], 'Archive uses its own snapshot, not later feedback')
assert(owner.control('例子 4 完整情境').props.disabled)
assert(!all(owner.tree, node => node.props['aria-label'] === '例子 4 对照结果').length)
owner.click('返回未保存草稿')
assert.equal(owner.control('按记录阶段查看例子').props.value, 'reviewed_draft')
assert.equal(JSON.stringify([...storage]), stageEditedStorage)
assert.equal(JSON.stringify(records), stageRecords); assert.equal(writes, stageWrites)
owner.props.revision = 2; doc.revision = 2; owner.render(); await owner.load()
assert.equal(owner.control('按记录阶段查看例子').props.value, 'all')
owner.change('按记录阶段查看例子', 'reviewed_draft')
assert.deepEqual(visibleCases(), [], 'A new graph version does not return the old saved head')
owner.change('按记录阶段查看例子', 'unconfirmed')
assert(visibleCases().includes('outcome-case-3')); assert(owner.control('例子 4 对照结果').props.disabled)
assert.equal(JSON.stringify([...storage]), stageEditedStorage)
owner.unmount()

for (const kind of ['personal', 'source', 'observation', 'ai']) {
  prepareStageBrowse(); records[1].map.examples[2].feedback.kind = kind
  owner = mount({ focusRequest: focus }); await owner.load()
  owner.change('按记录阶段查看例子', 'reviewed_saved')
  assert.deepEqual(visibleCases(), ['outcome-case-2'])
  assert.equal(owner.control('例子 3 结果来源').props.value, kind)
  assert(text(all(owner.tree, node => node.props['data-target-case-id'] === 'outcome-case-2')[0]).includes('未独立验证'), kind)
  owner.unmount()
}
for (const alteration of ['parent', 'context', 'input', 'output', 'feedback']) {
  prepareStageBrowse()
  const draft = { documentId: doc.documentId, targetId: 'motion', baseRevision: 1, parentId: 'stage-feedback', reason: '', map: structuredClone(records[1].map) }
  if (alteration === 'parent') draft.parentId = 'different-round'
  if (alteration === 'context') draft.map.examples[2].context += ' '
  if (alteration === 'input') draft.map.examples[2].inputs[1].value = '另一对象，次日'
  if (alteration === 'output') draft.map.examples[2].outputs[0].outcomeId = 'uniform-copy'
  if (alteration === 'feedback') draft.map.examples[2].feedback.text += ' 改写'
  storage.set(editKey, JSON.stringify(draft))
  owner = mount({ focusRequest: focus }); await owner.load()
  owner.change('按记录阶段查看例子', 'reviewed_saved'); assert.deepEqual(visibleCases(), [], alteration)
  owner.change('按记录阶段查看例子', alteration === 'parent' ? 'unconfirmed' : 'reviewed_draft')
  assert(visibleCases().includes('outcome-case-2'), 'A reused identity or altered saved field cannot prove persistence: ' + alteration)
  assert.equal(storage.get(editKey), JSON.stringify(draft)); owner.unmount()
}
for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'edit', 'archive', 'reload', 'filter', 'stage', 'pending', 'pending_sync']) {
  prepareStageBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
  const staleStage = owner.control('按记录阶段查看例子').props.onChange
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'elsewhere'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'edit') owner.change('适用条件', '另一条限定语')
  if (boundary === 'archive') { owner.click('查看靶图修订 stage-predictions'); await owner.load() }
  if (boundary === 'reload') {
    owner.click('查看靶图修订 stage-predictions'); await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  if (boundary === 'filter') owner.change('按输出取值查看例子', 'unassigned')
  if (boundary === 'stage') owner.change('按记录阶段查看例子', 'material')
  if (boundary === 'pending') owner.click('查看靶图修订 stage-predictions')
  if (boundary === 'pending_sync') owner.control('查看靶图修订 stage-predictions').props.onClick()
  const before = JSON.stringify([...storage]), requests = owner.requests.length, saved = JSON.stringify(records)
  const stage = all(owner.tree, node => node.props['aria-label'] === '按记录阶段查看例子')[0]?.props.value
  staleStage({ target: { value: 'prediction_saved' } }); owner.render()
  assert.equal(all(owner.tree, node => node.props['aria-label'] === '按记录阶段查看例子')[0]?.props.value, stage, boundary)
  assert.equal(JSON.stringify([...storage]), before); assert.equal(JSON.stringify(records), saved); assert.equal(owner.requests.length, requests)
  owner.unmount(); doc.revision = 1
}

for (const boundary of ['old_visible_handler', 'current_hidden_handler', 'changed_stage_still_visible']) {
  prepareStageBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
  let editCase = owner.control('例子 1 完整情境').props.onChange
  owner.change('按记录阶段查看例子', boundary === 'changed_stage_still_visible' ? 'material' : 'prediction_saved')
  if (boundary === 'current_hidden_handler') editCase = owner.control('例子 1 完整情境').props.onChange
  const before = JSON.stringify([...storage]), saved = JSON.stringify(records), requests = owner.requests.length
  editCase({ target: { value: '不可从隐藏或旧阶段回调覆盖' } }); owner.render()
  assert.equal(JSON.stringify([...storage]), before, boundary)
  assert.equal(JSON.stringify(records), saved); assert.equal(owner.requests.length, requests)
  assert.equal(owner.control('按记录阶段查看例子').props.value, boundary === 'changed_stage_still_visible' ? 'material' : 'prediction_saved')
  owner.unmount()
}

prepareStageBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
owner.change('搜索例子文字', '相反结果')
assert.deepEqual(visibleCases(), ['outcome-case-2'], 'Find a specific recorded result without opening every example')
owner.unmount()

prepareStageBrowse()
const searchable = records[1].map.examples
searchable[0].context = '连续限定语'.repeat(700) + '尾部小雨 SPLIT_A'
searchable[0].inputs[0].value = 'SPLIT_B x > 3; 0 N'
searchable[0].inputs[1].value = '对象甲 当前 1 m/s'
searchable[0].outputs[0].detail = '对象乙 次日 km/h [[.*]]'
searchable[0].process = 'MIXEDCase 仅当 x > 3，通常不保证；另一个必要输入仍未知'
searchable[4].process = '仅当 x >= 3，而不是 x > 3'
searchable[2].feedback.source = '<img src=x onerror=alert(1)>冲突来源'
owner = mount({ focusRequest: focus }); await owner.load()
owner.change('确认保存个人靶图', undefined, true)
const searchStorage = JSON.stringify([...storage]), searchRecords = JSON.stringify(records), searchRequests = owner.requests.length, searchWrites = writes
for (const [query, ids, field] of [['尾部小雨', [0], '完整情境'], ['SPLIT_B', [0], '输入 force'], ['对象甲 当前', [0], '输入 before'],
  ['对象乙 次日', [0], '输出细节 after'], ['mixedcase', [0], '推测过程'], ['[[.*]]', [0], '输出细节 after'],
  ['x >= 3', [4], '推测过程'], ['不保证', [0], '推测过程'], ['相反结果', [2], '对照结果'], ['<img', [2], '结果来源说明'],
  ['SPLIT_ASPLIT_B', [], ''], ['SPLIT_A\nSPLIT_B', [], ''], ['x>=3', [], ''], ['^.*$', [], ''], ['不存在', [], '']]) {
  owner.change('搜索例子文字', query)
  assert.deepEqual(visibleCases(), ids.map(id => 'outcome-case-' + id), query)
  if (field) assert(text(all(owner.tree, node => node.props['data-target-case-id'] === 'outcome-case-' + ids[0])[0]).includes('文字命中：') &&
    text(all(owner.tree, node => node.props['data-target-case-id'] === 'outcome-case-' + ids[0])[0]).includes(field), query + ' identifies the actual field')
}
assert.equal(all(owner.tree, node => node.props.dangerouslySetInnerHTML).length, 0)
assert.equal(owner.control('搜索例子文字').props.maxLength, 256)
owner.change('搜索例子文字', 'x'.repeat(257)); assert.equal(owner.control('搜索例子文字').props.value, '不存在')
owner.change('搜索例子文字', null); assert.equal(owner.control('搜索例子文字').props.value, '不存在')
owner.change('搜索例子文字', '相反结果')
owner.change('按记录阶段查看例子', 'reviewed_saved')
owner.change('按输出取值查看例子', outcomeChoice('after', 'rest')); assert.deepEqual(visibleCases(), [])
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform')); assert.deepEqual(visibleCases(), ['outcome-case-2'])
assert.equal(JSON.stringify([...storage]), searchStorage); assert.equal(JSON.stringify(records), searchRecords)
assert.equal(owner.requests.length, searchRequests); assert.equal(writes, searchWrites); assert(owner.control('确认保存个人靶图').props.checked)
owner.click('查看对应例子 uniform'); assert.equal(owner.control('搜索例子文字').props.value, '')
assert.equal(visibleCases().length, 4, 'An output link reveals the whole counted set rather than a hidden text intersection')
owner.change('搜索例子文字', '尾部小雨')
owner.change('按记录阶段查看例子', 'material')
owner.change('例子 1 完整情境', '明确改写后不含原查询词')
assert.equal(owner.control('搜索例子文字').props.value, '')
assert.equal(owner.control('按记录阶段查看例子').props.value, 'material')
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'uniform'))
assert(visibleCases().includes('outcome-case-0')); assert(!owner.control('确认保存个人靶图').props.checked)
owner.change('搜索例子文字', 'SPLIT_B'); owner.change('例子 1 推测过程', '更新未命中字段，不应解除查询')
assert.equal(owner.control('搜索例子文字').props.value, 'SPLIT_B')
owner.change('按记录阶段查看例子', 'all'); owner.change('搜索例子文字', '冲突来源')
const searchEdited = JSON.stringify([...storage])
owner.click('查看靶图修订 stage-predictions')
const searchFailure = owner.pending().at(-1); searchFailure.reject(new Error('503 search fixture')); searchFailure.settled = true; await owner.settle()
assert.equal(owner.control('搜索例子文字').props.value, '冲突来源'); assert.equal(JSON.stringify([...storage]), searchEdited)
owner.click('重试读取历史靶图'); await owner.load()
assert.equal(owner.control('搜索例子文字').props.value, '')
owner.change('搜索例子文字', '冲突来源'); assert.deepEqual(visibleCases(), [], 'An old prediction snapshot cannot search future feedback')
owner.change('搜索例子文字', '同文'); assert.equal(visibleCases().length, 5); assert(owner.control('例子 1 完整情境').props.disabled)
owner.click('返回未保存草稿'); assert.equal(owner.control('搜索例子文字').props.value, '冲突来源')
assert.equal(JSON.stringify([...storage]), searchEdited)
owner.click('增加具体推测'); assert.equal(owner.control('搜索例子文字').props.value, '')
assert.equal(visibleCases().length, 6)
owner.unmount()

for (const boundary of ['query', 'stage', 'filter', 'edit', 'target', 'document', 'revision', 'hidden', 'unmount', 'archive', 'reload', 'read_pending', 'read_pending_sync']) {
  prepareStageBrowse(); owner = mount({ focusRequest: focus }); await owner.load()
  owner.change('搜索例子文字', '同文')
  const staleSearch = owner.control('搜索例子文字').props.onChange, staleExample = owner.control('例子 1 完整情境').props.onChange
  if (boundary === 'query') owner.change('搜索例子文字', '相反结果')
  if (boundary === 'stage') owner.change('按记录阶段查看例子', 'reviewed_saved')
  if (boundary === 'filter') owner.change('按输出取值查看例子', outcomeChoice('after', 'rest'))
  if (boundary === 'edit') owner.change('适用条件', '新限定语不得被旧回调忽略')
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'another'; owner.render() }
  if (boundary === 'revision') { owner.props.revision = 2; doc.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'archive') { owner.click('查看靶图修订 stage-predictions'); await owner.load() }
  if (boundary === 'reload') {
    owner.click('查看靶图修订 stage-predictions'); await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  if (boundary === 'read_pending') owner.click('查看靶图修订 stage-predictions')
  if (boundary === 'read_pending_sync') owner.control('查看靶图修订 stage-predictions').props.onClick()
  const before = JSON.stringify([...storage]), saved = JSON.stringify(records), requests = owner.requests.length
  const query = all(owner.tree, node => node.props['aria-label'] === '搜索例子文字')[0]?.props.value
  staleSearch({ target: { value: '不允许旧查询覆盖' } }); staleExample({ target: { value: '不允许旧编辑覆盖' } }); owner.render()
  assert.equal(all(owner.tree, node => node.props['aria-label'] === '搜索例子文字')[0]?.props.value, query, boundary)
  assert.equal(JSON.stringify([...storage]), before, boundary); assert.equal(JSON.stringify(records), saved); assert.equal(owner.requests.length, requests)
  owner.unmount(); doc.revision = 1
}

prepareStageBrowse()
const filterNavigation = new Map()
owner = mount({ focusRequest: focus, navigation: filterNavigation }); await owner.load()
owner.change('适用条件', '刷新前未保存的完整限定语')
owner.change('搜索例子文字', '相反结果')
owner.change('按输出取值查看例子', outcomeChoice('after', 'uniform'))
owner.change('按记录阶段查看例子', 'reviewed_saved')
owner.change('确认保存个人靶图', undefined, true)
const filterRefreshDraft = storage.get(editKey), filterRefreshRecords = JSON.stringify(records), filterRefreshWrites = writes
owner.unmount()
owner = mount({ navigation: filterNavigation }); await owner.load()
assert.equal(owner.control('搜索例子文字').props.value, '相反结果', 'Page reload should retain the current draft example query')
assert.equal(owner.control('按输出取值查看例子').props.value, outcomeChoice('after', 'uniform'))
assert.equal(owner.control('按记录阶段查看例子').props.value, 'reviewed_saved')
assert.deepEqual(visibleCases(), ['outcome-case-2'])
assert.equal(storage.get(editKey), filterRefreshDraft); assert.equal(JSON.stringify(records), filterRefreshRecords); assert.equal(writes, filterRefreshWrites)
assert(!owner.control('确认保存个人靶图').props.checked)
owner.unmount()

const filterRefreshIntent = filterNavigation.get(navigationKey()), filterPosition = JSON.parse(filterRefreshIntent).state.examplePosition
assert.deepEqual(Object.keys(filterPosition).sort(), ['baseRevision', 'expansion', 'feedback', 'parentId', 'query', 'scope', 'stage', 'value'])
assert.equal(filterPosition.parentId, 'stage-feedback')
assert(!filterRefreshIntent.includes('刷新前未保存的完整限定语'), 'Navigation never stores personal statements')
const restoreFilter = async (position = filterPosition, options = {}, draft = filterRefreshDraft) => {
  storage.set(editKey, draft); doc.revision = 1
  const envelope = JSON.parse(filterRefreshIntent); envelope.state.examplePosition = position
  owner = mount({ navigation: new Map([[navigationKey(), JSON.stringify(envelope)]]), ...options })
  await owner.load()
}
await restoreFilter({ ...filterPosition, confirmed: true, roundConfirmed: true, map: records[1].map, record: records[1], revealedId: 'outcome-case-2' })
assert.deepEqual(Object.keys(JSON.parse(owner.navigation.get(navigationKey())).state.examplePosition).sort(), Object.keys(filterPosition).sort())
assert(!owner.control('确认保存个人靶图').props.checked)
assert(!owner.requests.some(item => ['record', 'save'].includes(item.args.action)))
owner.unmount()

for (const invalid of [{ scope: 'another-target' }, { baseRevision: 0 }, { baseRevision: 2 }, { parentId: 'wrong-parent' },
  { parentId: 'x'.repeat(121) }, { parentId: ' ' }, { query: null }, { query: 'x'.repeat(257) }, { stage: 'verified' },
  { value: '{}' }, { value: '["after"]' }, { value: '["after","uniform","extra"]' },
  { value: JSON.stringify(['after', 'x'.repeat(121)]) }, { value: JSON.stringify(['after', ' ']) }, { value: 'x'.repeat(2001) }]) {
  await restoreFilter({ ...filterPosition, ...invalid })
  assert.equal(owner.control('搜索例子文字').props.value, '', JSON.stringify(invalid))
  assert.equal(owner.control('按记录阶段查看例子').props.value, 'all')
  assert.equal(owner.control('按输出取值查看例子').props.value, 'all')
  assert.equal(storage.get(editKey), filterRefreshDraft); owner.unmount()
}
for (const query of [' 相反结果 ', 'x > 3', '[[.*]]', '通常\n而非必然', 'x'.repeat(256)]) {
  await restoreFilter({ ...filterPosition, query })
  assert.equal(owner.control('搜索例子文字').props.value, query, 'No query normalization on reload')
  owner.unmount()
}
await restoreFilter({ ...filterPosition, value: outcomeChoice('after', 'missing-output') })
assert.equal(owner.control('按输出取值查看例子').props.value, 'all', 'Missing identities are not rebound by name')
assert.equal(owner.control('搜索例子文字').props.value, '相反结果'); assert.equal(owner.control('按记录阶段查看例子').props.value, 'reviewed_saved')
assert.equal(JSON.parse(owner.navigation.get(navigationKey())).state.examplePosition.value, 'all')
owner.unmount()
await restoreFilter({ ...filterPosition, value: outcomeChoice('after', 'uniform-copy') })
assert.deepEqual(visibleCases(), [], 'Same-name output identity remains distinct after reload'); owner.unmount()
const unassignedFilterDraft = JSON.parse(filterRefreshDraft)
unassignedFilterDraft.map.examples[4].outputs[0].outcomeId = ''
await restoreFilter({ ...filterPosition, value: 'unassigned', stage: 'all', query: '' }, {}, JSON.stringify(unassignedFilterDraft))
assert.deepEqual(visibleCases(), ['outcome-case-4']); owner.unmount()

const alteredFilterDraft = JSON.parse(filterRefreshDraft)
alteredFilterDraft.map.examples[2].feedback.source += ' 未保存改动'
await restoreFilter(filterPosition, {}, JSON.stringify(alteredFilterDraft))
assert.equal(owner.control('按记录阶段查看例子').props.value, 'reviewed_saved'); assert.deepEqual(visibleCases(), [])
owner.change('按记录阶段查看例子', 'reviewed_draft'); assert.deepEqual(visibleCases(), ['outcome-case-2'])
assert.equal(storage.get(editKey), JSON.stringify(alteredFilterDraft), 'Restored stage intent does not certify changed feedback as saved')
owner.unmount()
alteredFilterDraft.parentId = 'different-head'
await restoreFilter(filterPosition, {}, JSON.stringify(alteredFilterDraft))
assert.equal(owner.control('搜索例子文字').props.value, ''); assert.equal(JSON.parse(owner.navigation.get(navigationKey())).state.examplePosition, null)
owner.unmount()

await restoreFilter()
const draftFilterIntent = owner.navigation.get(navigationKey())
owner.click('查看靶图修订 stage-predictions'); await owner.load()
owner.change('搜索例子文字', '同文'); owner.change('按记录阶段查看例子', 'prediction_saved')
assert.equal(owner.navigation.get(navigationKey()), draftFilterIntent, 'Archive browsing cannot replace the draft filter intent')
const archiveFilterNavigation = owner.navigation; owner.unmount()
owner = mount({ navigation: archiveFilterNavigation }); await owner.load()
assert.equal(owner.control('搜索例子文字').props.value, '相反结果')
assert.equal(owner.control('按记录阶段查看例子').props.value, 'reviewed_saved')
assert(!owner.control('适用条件').props.disabled); assert(!owner.requests.some(item => item.args.action === 'record'))
owner.unmount()

storage.set(editKey, filterRefreshDraft)
owner = mount({ navigation: new Map([[navigationKey(), filterRefreshIntent]]) })
const pendingFilterRead = owner.pending().find(item => item.args.action === 'read')
await owner.resolve(owner.pending().find(item => item.args.action === 'catalog'))
pendingFilterRead.reject(new Error('503 filter restore')); pendingFilterRead.settled = true; await owner.settle()
assert(text(owner.tree).includes('503 filter restore'))
assert.equal(JSON.parse(owner.navigation.get(navigationKey())).state.examplePosition.query, '相反结果')
assert.equal(storage.get(editKey), filterRefreshDraft)
owner.click('重读靶图'); await owner.load()
assert.equal(owner.control('搜索例子文字').props.value, '相反结果', 'Only a successful scoped detail read consumes pending restoration')
owner.unmount()

for (const boundary of ['document', 'revision', 'target', 'tab', 'hidden', 'reload']) {
  await restoreFilter()
  const oldSearch = owner.control('搜索例子文字').props.onChange
  if (boundary === 'document') { owner.props.documentId = doc.documentId + ' '; owner.render() }
  if (boundary === 'revision') { owner.props.revision = 2; doc.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'tab') { owner.unmount(); owner = mount({ focusRequest: focus }); await owner.load() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'reload') {
    owner.click('查看靶图修订 stage-predictions'); await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  const navigation = JSON.stringify([...owner.navigation]), local = JSON.stringify([...storage]), requests = owner.requests.length
  oldSearch({ target: { value: '旧查询不可重新持久化' } }); owner.render()
  assert.equal(JSON.stringify([...owner.navigation]), navigation, boundary)
  assert.equal(JSON.stringify([...storage]), local); assert.equal(owner.requests.length, requests)
  if (boundary === 'target' || boundary === 'reload') assert.equal(JSON.parse(owner.navigation.get(navigationKey())).state.examplePosition, null)
  owner.unmount(); doc.revision = 1
}
assert.equal(JSON.stringify(records), filterRefreshRecords); assert.equal(writes, filterRefreshWrites)

// Two saved snapshots must be comparable without repurposing the unsaved draft.
{
const openHistoryPair = async (left = motionTargetMap(), right = motionTargetMap(), options = {}) => {
  storage.clear(); records = []; doc.revision = 1
  for (const [id, map] of [['history-left', left], ['history-right', right]]) {
    if (id === 'history-right' && options.crossVersion) doc.revision = 2
    const saved = tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: doc.revision, targetId: 'motion',
      id, parentId: records.findLast(record => record.baseRevision === doc.revision)?.id || '', reason: id, confirm: true, map }, records)
    assert(!saved.error, JSON.stringify(saved.error)); records.push(saved.saved)
  }
  owner = mount({ focusRequest: { ...focus, revision: doc.revision } }); await owner.load()
  owner.change('映射规律表述', 'PRIVATE UNSAVED DRAFT, not either historical side')
  owner.click('查看靶图修订 history-right'); await owner.load()
  owner.click('固定为对照快照')
  owner.click('查看靶图修订 history-left'); await owner.load()
  owner.change('历史对照对象', 'reference')
}
const historyPairLeft = motionTargetMap(), historyPairRight = motionTargetMap()
historyPairLeft.mapping = '可能成立，先核对全部必要输入'; historyPairRight.mapping = '通常成立，不能由循环推测证明'
historyPairRight.conditions = '对象乙，另一时间；来源甲与乙冲突'
await openHistoryPair(historyPairLeft, historyPairRight)
assert(owner.control('靶图历史快照上层对照'))
assert.equal(all(owner.tree, item => item.props.className === 'kg-target-toolbar' && all(item, child => child.props['aria-label'] === '历史对照对象').length).length, 0,
  'The full-width comparison selector must not squeeze its visible label beside a maximum-length identity')
assert.equal(comparedText(['mapping'], 'history'), historyPairLeft.mapping)
assert.equal(comparedText(['mapping'], 'reference'), historyPairRight.mapping)
assert(!text(owner.control('靶图历史快照上层对照')).includes('PRIVATE UNSAVED'))
const pairSaved = JSON.stringify(records), pairLocal = JSON.stringify([...storage]), pairNavigation = JSON.stringify([...owner.navigation]), pairWrites = writes, pairRequests = owner.requests.length
owner.change('仅显示不同的上层字段', undefined, false)
owner.click('对照例子记录')
assert(owner.control('靶图历史快照例子对照'))
assert.equal(owner.control('历史对照对象').props.value, 'reference')
owner.change('仅显示不同的例子字段', undefined, false)
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'force', 'value'], 'reference'), historyPairRight.examples[0].inputs[0].value)
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'before', 'slot', 'unit'], 'reference'), 'm/s')
owner.change('选择对照例子', 'material-1')
assert.equal(comparedText(['examples', 'material-1', 'context'], 'reference'), historyPairRight.examples[1].context)
owner.change('历史对照对象', 'draft')
owner.click('对照上层表述'); assert.equal(comparedText(['mapping'], 'draft'), 'PRIVATE UNSAVED DRAFT, not either historical side')
owner.change('历史对照对象', 'reference'); assert(owner.control('靶图历史快照上层对照'))
assert.equal(owner.requests.length, pairRequests); assert.equal(JSON.stringify([...storage]), pairLocal)
assert.equal(JSON.stringify([...owner.navigation]), pairNavigation, 'Pinned responses must never enter session navigation')
assert.equal(JSON.stringify(records), pairSaved); assert.equal(writes, pairWrites)
owner.click('取消固定快照')
assert(!all(owner.tree, item => item.props['data-target-history-reference']).length)
assert(owner.control('映射规律表述').props.disabled)
owner.click('固定为对照快照')
assert(owner.control('固定为对照快照').props.disabled)
assert(!all(owner.tree, item => item.props['aria-label'] === '历史对照对象').length, 'A snapshot cannot compare against itself')
owner.click('返回未保存草稿')
assert.equal(owner.control('映射规律表述').props.value, 'PRIVATE UNSAVED DRAFT, not either historical side')
assert(!owner.control('确认保存个人靶图').props.checked); assert.equal(JSON.stringify(records), pairSaved)
owner.unmount(); doc.revision = 1

await openHistoryPair(identityBefore, identityAfter, { crossVersion: true })
assert(text(owner.control('靶图历史快照上层对照')).includes('两侧基于不同知识图版本'))
assert.equal(comparedText(['slots', '__proto__', 'name'], 'reference'), '速度')
assert.equal(comparedText(['slots', 'before', 'name'], 'reference'), undefined)
owner.click('对照例子记录'); owner.change('仅显示不同的例子字段', undefined, false)
assert.equal(comparedText(['examples', 'material-0', 'inputs', '__proto__', 'slot', 'name'], 'reference'), '速度')
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'before', 'slot', 'name'], 'reference'), undefined)
owner.unmount(); doc.revision = 1
await openHistoryPair(motionTargetMap(), boundAfter)
owner.click('对照例子记录')
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'before', 'slot', 'unit'], 'reference'), 'km/h')
assert.equal(comparedText(['examples', 'material-0', 'inputs', 'before', 'slot', 'scope'], 'reference'), '另一对象，下一时刻')
owner.unmount()
await openHistoryPair(motionTargetMap(), missingInput)
assert.equal(comparedText(['slots', 'force', 'name'], 'reference'), undefined)
owner.click('对照例子记录'); assert.equal(comparedText(['examples', 'material-0', 'inputs', 'force', 'value'], 'reference'), undefined)
owner.unmount()
await openHistoryPair(motionTargetMap(), reordered)
comparedRow(['slots', 'order']); comparedRow(['outcomes', 'order']); owner.unmount()
await openHistoryPair(manyBefore, manyAfter)
owner.click('对照例子记录'); assert.equal(owner.control('选择对照例子').props.children[0].length, 80)
assert.equal(all(owner.tree, item => item.props['data-target-example-comparison']).length, 1)
owner.change('选择对照例子', 'new-39')
assert.equal(comparedText(['examples', 'new-39', 'context'], 'reference'), manyAfter.examples[39].context)
owner.unmount()
for (const kind of ['personal', 'source', 'observation', 'ai']) {
  feedbackAfter.examples[0].feedback.kind = kind
  await openHistoryPair(predictionBefore, feedbackAfter)
  owner.click('对照例子记录')
  assert.equal(comparedText(['examples', 'material-0', 'feedback', 'kind'], 'history'), undefined)
  assert.equal(comparedText(['examples', 'material-0', 'feedback', 'kind'], 'reference'), { personal: '个人判断', source: '资料答案', observation: '观察记录', ai: 'AI 建议' }[kind])
  assert(text(owner.control('靶图历史快照例子对照')).includes('不自动追溯预测依据'))
  owner.unmount()
}
for (const [before, after] of [['x > 3，可能', 'x >= 3，必然'], ['a b', 'ab'], ['', ' '], ['e\u0301', '\u00e9'],
  ['<img src=x onerror=alert(1)>', '<script>throw 1</script>'], ['甲'.repeat(7999) + '乙', '甲'.repeat(7999) + '丙']]) {
  const left = motionTargetMap(), right = motionTargetMap(); left.mapping = before; right.mapping = after
  await openHistoryPair(left, right)
  assert.equal(comparedRows().length, 1); assert.equal(comparedText(['mapping'], 'history'), before || undefined)
  assert.equal(comparedText(['mapping'], 'reference'), after)
  assert(!all(owner.tree, item => ['img', 'script'].includes(item.type)).length); owner.unmount()
}

await openHistoryPair(historyPairLeft, historyPairRight)
owner.click('查看靶图修订 history-right')
let pairRead = owner.pending().at(-1)
assert(owner.control('固定为对照快照').props.disabled)
assert(!all(owner.tree, item => item.props['aria-label'] === '靶图历史快照上层对照').length)
pairRead.reject(new Error('synthetic pair read failure')); pairRead.settled = true; await owner.settle()
assert(text(owner.tree).includes('synthetic pair read failure'))
assert(text(owner.tree).includes('固定快照 history-right'))
owner.click('重试读取历史靶图'); await owner.load()
assert(!all(owner.tree, item => item.props['aria-label'] === '历史对照对象').length)
owner.click('查看靶图修订 history-left'); await owner.load(); owner.change('历史对照对象', 'reference')
assert.equal(comparedText(['mapping'], 'reference'), historyPairRight.mapping)
owner.unmount()

for (const mutate of [record => { record.documentId = 'foreign' }, record => { record.target.id = 'unknown' },
  record => { record.origin = 'ai_verified' }, record => { record.baseRevision = 0 }, record => { record.baseRevision = 2 },
  record => { record.baseRevision = 1.5 }, record => { record.id = 'other' }]) {
  await openHistoryPair(historyPairLeft, historyPairRight)
  owner.click('查看靶图修订 history-right'); pairRead = owner.pending().at(-1)
  const response = structuredClone(tools.handle(doc, pairRead.args, records)); mutate(response.record)
  await owner.resolve(pairRead, response)
  assert(text(owner.tree).includes('历史靶图身份不一致'))
  assert.equal(owner.control('映射规律表述').props.value, historyPairLeft.mapping)
  assert.equal(owner.control('映射规律表述').props.disabled, true)
  assert(!all(owner.tree, item => item.props['aria-label'] === '靶图历史快照上层对照').length)
  owner.unmount()
}
for (const boundary of ['target', 'document', 'revision', 'hidden', 'unmount', 'return', 'clear', 'replace', 'pending', 'reload', 'page-reload']) {
  await openHistoryPair(historyPairLeft, historyPairRight)
  owner.click('对照例子记录')
  const callbacks = [owner.control('固定为对照快照').props.onClick, owner.control('取消固定快照').props.onClick,
    () => ownerOldChoose({ target: { value: 'reference' } }), () => oldPairFilter({ target: { checked: false } }),
    () => oldPairExample({ target: { value: 'material-1' } })]
  const ownerOldChoose = owner.control('历史对照对象').props.onChange, oldPairFilter = owner.control('仅显示不同的例子字段').props.onChange,
    oldPairExample = owner.control('选择对照例子').props.onChange
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'different'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'return') owner.click('返回未保存草稿')
  if (boundary === 'clear') owner.click('取消固定快照')
  if (boundary === 'replace') owner.click('固定为对照快照')
  if (boundary === 'pending') owner.click('查看靶图修订 history-right')
  if (boundary === 'reload') {
    owner.click('查看靶图修订 history-right'); await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  if (boundary === 'page-reload') { const nav = owner.navigation; owner.unmount(); owner = mount({ navigation: nav }); await owner.load() }
  const beforeTree = text(owner.tree), beforeLocal = JSON.stringify([...storage]), beforeNav = JSON.stringify([...owner.navigation]), beforeRequests = owner.requests.length
  for (const callback of callbacks) { callback(); owner.render() }
  assert.equal(text(owner.tree), beforeTree, boundary); assert.equal(JSON.stringify([...storage]), beforeLocal)
  assert.equal(JSON.stringify([...owner.navigation]), beforeNav); assert.equal(owner.requests.length, beforeRequests)
  if (boundary === 'pending') {
    owner.click('取消读取历史靶图'); await owner.resolve(owner.pending().at(-1))
    assert.equal(owner.control('映射规律表述').props.value, historyPairLeft.mapping)
  }
  owner.unmount(); doc.revision = 1
}

}

{
const navigationMap = motionTargetMap()
navigationMap.slots.push({ ...navigationMap.slots[2], id: 'later', unit: 'km/h', scope: '另一对象，次日' })
navigationMap.outcomes.push({ id: 'all', slotId: 'later', label: navigationMap.outcomes[0].label, detail: '同名异身份，单位和时间不同' })
for (const item of navigationMap.examples) item.outputs.push({ slotId: 'later', outcomeId: 'all', detail: '不由原状态自动推断' })
navigationMap.examples = Array.from({ length: 40 }, (_, index) => {
  const item = structuredClone(navigationMap.examples[index % 2])
  item.id = index === 0 ? '__proto__' : 'nav-"' + index
  item.context = index % 2 ? '同名情境：另一对象，下一时刻' : '同名情境：本对象，原状态，可能成立'
  item.inputs[1].value = index + ' m/s，不能省略另一个必要输入'
  item.outputs[0].outcomeId = index % 5 === 0 ? 'rest' : 'uniform'
  item.stage = index % 3 === 0 ? 'reviewed' : index % 3 === 1 ? 'prediction' : 'material'
  if (item.stage === 'reviewed') item.feedback = { kind: ['personal', 'source', 'observation', 'ai'][(index / 3) % 4], text: '存在冲突，尚未独立核对', source: '来源 ' + index }
  return item
})
const navigationIds = navigationMap.examples.map(item => item.id)
const setupNavigator = async () => {
  storage.clear(); doc.revision = 1
  records = [{ id: 'navigator-record', documentId: doc.documentId, baseRevision: 1, target: { id: 'motion', type: 'connection_model', text: '资料中的模型' },
    parentId: '', reason: '隔离导航夹具', origin: 'personal_target_map_not_mastery', map: structuredClone(navigationMap), createdAt: 1, bases: {} }]
  owner = mount({ focusRequest: focus, slotNavigation: true }); await owner.load()
}
const locatorOptions = () => all(owner.control('定位例子'), node => node.type === 'option').map(item => item.props.value)
const detailsOf = id => all(owner.tree, node => node.props['data-target-case-id'] === id)[0]
await setupNavigator()
owner.change('映射规律表述', '直接对照不改未保存的限定语')
owner.change('确认保存个人靶图', undefined, true)
const pairEntryStorage = JSON.stringify([...storage]), pairEntryRecords = JSON.stringify(records), pairEntryRequests = owner.requests.length, pairEntryWrites = writes
for (const side of ['左', '右']) {
  const options = all(owner.control(side + '侧例子'), node => node.type === 'option').slice(1)
  assert.equal(options.length, 40)
  options.forEach((option, index) => assert(text(option).includes(navigationIds[index]), 'Pair options expose exact identities, not just equal context'))
}
owner.click('放入左侧对照 ' + navigationIds[19])
assert.equal(owner.control('左侧例子').props.value, navigationIds[19])
assert.equal(owner.focused, 'data-target-example-pair-side:left'); assert(owner.pairDetails.open)
assert(owner.control('放入右侧对照 ' + navigationIds[19]).props.disabled)
owner.control('放入右侧对照 ' + navigationIds[19]).props.onClick(); owner.render()
assert.equal(owner.control('右侧例子').props.value, '', 'Disabled direct commands also reject self-pairs')
owner.click('返回左侧例子')
assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[19]); assert(detailsOf(navigationIds[19]).props.open)
owner.click('放入右侧对照 ' + navigationIds[39])
assert.equal(owner.control('右侧例子').props.value, navigationIds[39]); assert.equal(owner.focused, 'data-target-example-pair-side:right')
const directRows = () => all(owner.control('两个例子字段对照'), node => node.props['data-target-compare-key'])
for (const path of [['inputs', 'force', 'value'], ['inputs', 'before', 'value'], ['outputs', 'after', 'slot', 'unit'], ['outputs', 'later', 'slot', 'scope'], ['process']]) {
  assert(directRows().some(row => row.props['data-target-compare-key'] === JSON.stringify(path)), 'Direct comparison retains every bound input and output')
}
assert(!all(owner.control('两个例子字段对照'), node => node.props.dangerouslySetInnerHTML).length)
const oldReturn = owner.control('返回右侧例子').props.onClick
owner.change('右侧例子', navigationIds[3]); const changedFocus = owner.focused
oldReturn(); owner.render(); assert.equal(owner.focused, changedFocus, 'A return from a previous pair cannot navigate to the old side')
owner.change('按输出取值查看例子', JSON.stringify(['after', 'rest']))
assert.equal(owner.control('左侧例子').props.value, navigationIds[19], 'Filtering keeps the deliberately selected pair')
assert(owner.control('返回左侧例子').props.disabled)
assert(owner.control('返回左侧例子').props.title.includes('当前筛选'))
owner.control('返回左侧例子').props.onClick(); owner.render(); assert.equal(owner.focused, changedFocus, 'Return never silently clears a filter')
owner.click('放入右侧对照 ' + navigationIds[0]); owner.click('返回右侧例子')
assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[0])
assert.equal(owner.control('按输出取值查看例子').props.value, JSON.stringify(['after', 'rest']))
for (const invalid of [null, undefined, 0, {}, [], 'missing', 'a'.repeat(121)]) {
  owner.change('右侧例子', invalid); assert.equal(owner.control('右侧例子').props.value, navigationIds[0])
}
assert.equal(JSON.stringify([...storage]), pairEntryStorage); assert.equal(JSON.stringify(records), pairEntryRecords)
assert.equal(owner.requests.length, pairEntryRequests); assert.equal(writes, pairEntryWrites)
assert(owner.control('确认保存个人靶图').props.checked)
assert(!JSON.stringify([...owner.navigation]).includes('"left"'), 'Pair selection is not a persisted navigation or approval')
owner.unmount()

const hideComparedExamples = () => {
  owner.change('按输出取值查看例子', JSON.stringify(['after', 'rest']))
  owner.change('按记录阶段查看例子', 'material')
  owner.change('按对照来源查看例子', 'observation')
  owner.change('搜索例子文字', '不存在的完整文字，不推断条件')
}
const assertClearExampleFilters = () => {
  for (const label of ['按输出取值查看例子', '按记录阶段查看例子', '按对照来源查看例子']) assert.equal(owner.control(label).props.value, 'all')
  assert.equal(owner.control('搜索例子文字').props.value, '')
}
const pairAndHide = () => {
  owner.click('放入左侧对照 ' + navigationIds[19]); owner.click('放入右侧对照 ' + navigationIds[39]); hideComparedExamples()
}
for (const side of ['左', '右']) {
  await setupNavigator()
  owner.change('映射规律表述', '通常而非必然，清除筛选不改变个人表述')
  owner.change('确认保存个人靶图', undefined, true)
  owner.click('放入左侧对照 ' + navigationIds[19]); owner.click('放入右侧对照 ' + navigationIds[39])
  owner.change('仅显示两个例子的不同字段', undefined, true)
  owner.control('下一个筛选例子 ' + navigationIds[1]).props.onClick(); owner.render()
  hideComparedExamples()
  const id = side === '左' ? navigationIds[19] : navigationIds[39]
  const before = [JSON.stringify([...storage]), JSON.stringify(records), owner.requests.length, writes]
  assert(owner.control('返回' + side + '侧例子').props.disabled, 'Ordinary return cannot secretly reset filters')
  const recover = owner.control('清除筛选并返回' + side + '侧例子')
  assert(!recover.props.disabled && recover.props.title.includes(id), 'Recovery exposes exact destination')
  recover.props.onClick(); owner.render()
  assertClearExampleFilters()
  assert.equal(owner.focused, 'data-target-example-heading:' + id)
  assert.equal(owner.control('定位例子').props.value, id)
  assert(detailsOf(id).props.open && detailsOf(navigationIds[2]).props.open, 'Open destination without erasing other expansion choices')
  assert.equal(owner.control('左侧例子').props.value, navigationIds[19]); assert.equal(owner.control('右侧例子').props.value, navigationIds[39])
  assert(owner.control('仅显示两个例子的不同字段').props.checked && owner.control('确认保存个人靶图').props.checked)
  const after = [JSON.stringify([...storage]), JSON.stringify(records), owner.requests.length, writes]
  after.forEach((value, index) => assert.equal(value, before[index], 'Explicit recovery is navigation only'))
  assert(!all(owner.tree, node => node.props['aria-label'] === '清除筛选并返回' + side + '侧例子').length)
  const nav = JSON.stringify([...owner.navigation]), count = owner.scrolled.length
  recover.props.onClick(); owner.render()
  assert.equal(JSON.stringify([...owner.navigation]), nav); assert.equal(owner.scrolled.length, count, 'A repeated stale recovery does not refocus')
  owner.unmount()
}
for (const boundary of ['pair', 'filter', 'filter-return', 'stage', 'feedback', 'text', 'edit', 'target', 'document', 'revision', 'hidden', 'hidden-return', 'unmount', 'pending', 'pending-cancel', 'archive', 'archive-return', 'reload', 'comparison-return']) {
  await setupNavigator()
  owner.click('放入左侧对照 ' + navigationIds[19]); owner.click('放入右侧对照 ' + navigationIds[39]); hideComparedExamples()
  const recover = owner.control('清除筛选并返回左侧例子').props.onClick
  if (boundary === 'pair') owner.change('左侧例子', navigationIds[3])
  if (boundary === 'filter') owner.change('按输出取值查看例子', 'all')
  if (boundary === 'filter-return') { owner.change('按输出取值查看例子', 'all'); owner.change('按输出取值查看例子', JSON.stringify(['after', 'rest'])) }
  if (boundary === 'stage') owner.change('按记录阶段查看例子', 'all')
  if (boundary === 'feedback') owner.change('按对照来源查看例子', 'all')
  if (boundary === 'text') owner.change('搜索例子文字', '原状态')
  if (boundary === 'edit') owner.change('映射规律表述', '新的条件，旧操作不可擦除筛选')
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'foreign'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'hidden-return') { owner.props.active = false; owner.render(); owner.props.active = true; owner.render(); await owner.load() }
  if (boundary === 'unmount') owner.unmount()
  if (['pending', 'pending-cancel', 'archive', 'archive-return', 'reload', 'comparison-return'].includes(boundary)) owner.click('查看靶图修订 navigator-record')
  if (boundary === 'pending-cancel') owner.click('取消读取历史靶图')
  if (['archive', 'archive-return', 'comparison-return'].includes(boundary)) await owner.load()
  if (boundary === 'archive-return') owner.click('返回未保存草稿')
  if (boundary === 'comparison-return') { owner.click('对照上层表述'); owner.click('快照内容') }
  if (boundary === 'reload') {
    await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  const before = [text(owner.tree), JSON.stringify([...storage]), JSON.stringify([...owner.navigation]), owner.focused, owner.requests.length]
  recover(); owner.render()
  const after = [text(owner.tree), JSON.stringify([...storage]), JSON.stringify([...owner.navigation]), owner.focused, owner.requests.length]
  after.forEach((value, index) => assert.equal(value, before[index], boundary + ' rejects stale filter recovery field ' + index))
  owner.unmount(); doc.revision = 1
}

await setupNavigator()
pairAndHide()
owner.click('清除筛选并返回左侧例子')
const recoveredNavigation = owner.navigation, recoveredDraft = JSON.stringify([...storage])
owner.unmount(); owner = mount({ navigation: recoveredNavigation, slotNavigation: true }); await owner.load()
assertClearExampleFilters(); assert(detailsOf(navigationIds[19]).props.open)
assert.equal(owner.control('左侧例子').props.value, '', 'Reload restores navigation, never an old comparison or save approval')
assert.equal(JSON.stringify([...storage]), recoveredDraft)
owner.unmount()

await setupNavigator()
owner.change('映射规律表述', '个人草稿和原来的筛选不能被历史恢复命令改写')
owner.change('按输出取值查看例子', JSON.stringify(['after', 'rest']))
owner.change('搜索例子文字', '原状态')
const recoveryArchiveDraft = JSON.stringify([...storage]), recoveryArchiveNav = JSON.stringify([...owner.navigation])
owner.click('查看靶图修订 navigator-record')
const recoveryRead = owner.pending().at(-1)
recoveryRead.reject(new Error('503 filter recovery')); recoveryRead.settled = true; await owner.settle()
assert.equal(JSON.stringify([...storage]), recoveryArchiveDraft)
owner.click('重试读取历史靶图'); await owner.load()
pairAndHide(); owner.click('清除筛选并返回右侧例子')
assertClearExampleFilters(); assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[39])
assert(owner.control('例子 40 完整情境').props.disabled)
assert.equal(JSON.stringify([...owner.navigation]), recoveryArchiveNav, 'Archive filter reset cannot erase draft navigation')
owner.click('返回未保存草稿')
assert.equal(owner.control('按输出取值查看例子').props.value, JSON.stringify(['after', 'rest']))
assert.equal(owner.control('搜索例子文字').props.value, '原状态')
assert.equal(JSON.stringify([...storage]), recoveryArchiveDraft)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
pairAndHide(); owner.click('清除筛选并返回左侧例子')
assertClearExampleFilters(); assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[19])
assert(owner.control('保存个人靶图').props.disabled, 'Old-version recovery is strictly browsing')
assert.equal(JSON.stringify([...storage]), recoveryArchiveDraft)
owner.unmount(); doc.revision = 1

for (const anomaly of ['missing', 'duplicate', 'hidden']) {
  await setupNavigator(); pairAndHide()
  if (anomaly === 'missing') owner.removedAnchor = navigationIds[19]
  if (anomaly === 'duplicate') owner.duplicateAnchors = true
  if (anomaly === 'hidden') owner.domHidden = true
  const previousFocus = owner.focused, previousDraft = JSON.stringify([...storage])
  owner.click('清除筛选并返回左侧例子')
  assertClearExampleFilters()
  assert.equal(owner.focused, previousFocus, anomaly + ' never redirects to a different identity')
  assert.equal(owner.control('定位例子').props.value, '', anomaly + ' does not claim successful location')
  assert.equal(JSON.stringify([...storage]), previousDraft)
  owner.unmount()
}

for (const boundary of ['pair', 'filter', 'filter-return', 'stage', 'feedback', 'text', 'edit', 'target', 'document', 'revision', 'hidden', 'hidden-return', 'unmount', 'pending', 'pending-cancel', 'archive', 'archive-return', 'reload', 'comparison-return']) {
  await setupNavigator()
  owner.click('放入左侧对照 ' + navigationIds[19]); owner.click('放入右侧对照 ' + navigationIds[39])
  const choose = owner.control('放入左侧对照 ' + navigationIds[2]).props.onClick, back = owner.control('返回右侧例子').props.onClick,
    menu = owner.control('左侧例子').props.onChange
  if (boundary === 'pair') owner.change('右侧例子', navigationIds[3])
  if (boundary === 'filter') owner.change('按输出取值查看例子', JSON.stringify(['after', 'rest']))
  if (boundary === 'filter-return') { owner.change('搜索例子文字', '原状态'); owner.change('搜索例子文字', '') }
  if (boundary === 'stage') owner.change('按记录阶段查看例子', 'material')
  if (boundary === 'feedback') owner.change('按对照来源查看例子', 'none')
  if (boundary === 'text') owner.change('搜索例子文字', '原状态')
  if (boundary === 'edit') owner.change('映射规律表述', '修改后的限定语')
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'foreign'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'hidden-return') { owner.props.active = false; owner.render(); owner.props.active = true; owner.render(); await owner.load() }
  if (boundary === 'unmount') owner.unmount()
  if (['pending', 'pending-cancel', 'archive', 'archive-return', 'reload', 'comparison-return'].includes(boundary)) owner.click('查看靶图修订 navigator-record')
  if (boundary === 'pending-cancel') owner.click('取消读取历史靶图')
  if (['archive', 'archive-return', 'comparison-return'].includes(boundary)) await owner.load()
  if (boundary === 'archive-return') owner.click('返回未保存草稿')
  if (boundary === 'comparison-return') { owner.click('对照上层表述'); owner.click('快照内容') }
  if (boundary === 'reload') {
    await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  const snapshot = [text(owner.tree), JSON.stringify([...storage]), JSON.stringify([...owner.navigation]), owner.focused, owner.requests.length]
  choose(); back(); menu({ target: { value: navigationIds[2] } }); owner.render()
  const after = [text(owner.tree), JSON.stringify([...storage]), JSON.stringify([...owner.navigation]), owner.focused, owner.requests.length]
  after.forEach((value, index) => assert.equal(value, snapshot[index], boundary + ' rejects stale pair command field ' + index))
  owner.unmount(); doc.revision = 1
}
await setupNavigator()
owner.change('映射规律表述', '历史直接对照不能覆盖草稿')
const pairRetained = JSON.stringify([...storage])
owner.click('查看靶图修订 navigator-record')
const pairEntryFailedRead = owner.pending().at(-1)
pairEntryFailedRead.reject(new Error('503 direct pair history')); pairEntryFailedRead.settled = true; await owner.settle()
assert.equal(JSON.stringify([...storage]), pairRetained)
owner.click('重试读取历史靶图'); await owner.load()
owner.click('放入左侧对照 ' + navigationIds[2]); owner.click('放入右侧对照 ' + navigationIds[39]); owner.click('返回右侧例子')
assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[39]); assert(owner.control('例子 40 完整情境').props.disabled)
owner.click('返回未保存草稿'); assert.equal(owner.control('映射规律表述').props.value, '历史直接对照不能覆盖草稿')
assert.equal(owner.control('左侧例子').props.value, ''); assert.equal(JSON.stringify([...storage]), pairRetained)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
owner.click('放入左侧对照 ' + navigationIds[2]); owner.click('放入右侧对照 ' + navigationIds[39]); owner.click('返回左侧例子')
assert(owner.control('保存个人靶图').props.disabled); assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[2])
owner.unmount(); doc.revision = 1
for (const anomaly of ['removed', 'duplicate', 'hidden']) {
  await setupNavigator()
  if (anomaly === 'removed') owner.removedAnchor = 'left'
  if (anomaly === 'duplicate') owner.duplicateAnchors = true
  if (anomaly === 'hidden') owner.domHidden = true
  owner.render(); owner.click('放入左侧对照 ' + navigationIds[2])
  assert.equal(owner.focused, null, anomaly + ' cannot focus an unrelated or hidden pair side')
  assert.equal(owner.control('左侧例子').props.value, navigationIds[2], 'Missing DOM does not corrupt the explicit pair choice')
  owner.unmount()
}
await setupNavigator()
assert.deepEqual(locatorOptions(), ['', ...navigationIds])
assert.equal(owner.control('定位例子').props.value, '', 'Loading does not claim an example has been selected')
assert(owner.control('上一个筛选例子 ' + navigationIds[0]).props.disabled)
assert(owner.control('下一个筛选例子 ' + navigationIds[39]).props.disabled)
owner.change('映射规律表述', '未保存：可能成立，不代表因果或掌握')
owner.change('确认保存个人靶图', undefined, true)
const beforeLocal = JSON.stringify([...storage]), beforeRecords = JSON.stringify(records), beforeWrites = writes, beforeRequests = owner.requests.length
owner.change('定位例子', navigationIds[19])
assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[19])
assert.equal(owner.control('定位例子').props.value, navigationIds[19])
assert.equal(detailsOf(navigationIds[19]).props.open, true)
assert.equal(detailsOf(navigationIds[18]).props.open, false, 'Same-name examples keep separate expansion')
assert.equal(owner.control('例子 20 输入 force').props.value, navigationMap.examples[19].inputs[0].value)
assert.equal(owner.control('例子 20 输入 before').props.value, navigationMap.examples[19].inputs[1].value)
owner.click('下一个筛选例子 ' + navigationIds[19]); assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[20])
owner.click('上一个筛选例子 ' + navigationIds[20]); assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[19])
owner.change('搜索例子文字', '原状态')
owner.change('按记录阶段查看例子', 'reviewed_saved')
owner.change('按对照来源查看例子', 'personal')
owner.change('按输出取值查看例子', JSON.stringify(['after', 'uniform']))
assert.deepEqual(locatorOptions(), ['', navigationIds[12], navigationIds[24], navigationIds[36]], 'Navigate the exact four-way intersection, not all examples')
assert.equal(owner.control('定位例子').props.value, '')
owner.change('定位例子', navigationIds[24]); owner.click('下一个筛选例子 ' + navigationIds[24])
assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[36])
assert(owner.control('下一个筛选例子 ' + navigationIds[36]).props.disabled)
owner.control('下一个筛选例子 ' + navigationIds[36]).props.onClick(); owner.render()
assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[36], 'The last example never wraps to the first')
for (const invalid of [navigationIds[1], '同名情境', 'missing', '', null, 1, {}, 'a'.repeat(121)]) {
  owner.change('定位例子', invalid); assert.equal(owner.control('定位例子').props.value, navigationIds[36])
}
assert.equal(JSON.stringify([...storage]), beforeLocal); assert.equal(JSON.stringify(records), beforeRecords)
assert.equal(writes, beforeWrites); assert.equal(owner.requests.length, beforeRequests)
assert(owner.control('确认保存个人靶图').props.checked, 'Pure navigation does not alter approval')
owner.change('搜索例子文字', 'no matching example')
assert(owner.control('定位例子').props.disabled); assert.deepEqual(locatorOptions(), [''])
owner.unmount()

for (const boundary of ['filter', 'filter-return', 'stage', 'feedback', 'text', 'edit', 'target', 'document', 'revision', 'hidden', 'hidden-return', 'unmount', 'pending', 'pending-cancel', 'archive', 'archive-return', 'reload']) {
  await setupNavigator()
  const choose = owner.control('定位例子').props.onChange, next = owner.control('下一个筛选例子 ' + navigationIds[1]).props.onClick
  if (boundary === 'filter') owner.change('按输出取值查看例子', JSON.stringify(['after', 'rest']))
  if (boundary === 'filter-return') { owner.change('搜索例子文字', '原状态'); owner.change('搜索例子文字', '') }
  if (boundary === 'stage') owner.change('按记录阶段查看例子', 'material')
  if (boundary === 'feedback') owner.change('按对照来源查看例子', 'none')
  if (boundary === 'text') owner.change('搜索例子文字', '原状态')
  if (boundary === 'edit') owner.change('映射规律表述', '修改后的限定语')
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'foreign'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'hidden-return') { owner.props.active = false; owner.render(); owner.props.active = true; owner.render(); await owner.load() }
  if (boundary === 'unmount') owner.unmount()
  if (['pending', 'pending-cancel', 'archive', 'archive-return', 'reload'].includes(boundary)) owner.click('查看靶图修订 navigator-record')
  if (boundary === 'pending-cancel') owner.click('取消读取历史靶图')
  if (['archive', 'archive-return'].includes(boundary)) await owner.load()
  if (boundary === 'archive-return') owner.click('返回未保存草稿')
  if (boundary === 'reload') {
    await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } })
    owner.click('重读靶图'); await owner.load()
  }
  const snapshot = [text(owner.tree), JSON.stringify([...storage]), JSON.stringify([...owner.navigation]), owner.focused, owner.requests.length]
  choose({ target: { value: navigationIds[2] } }); next(); owner.render()
  const after = [text(owner.tree), JSON.stringify([...storage]), JSON.stringify([...owner.navigation]), owner.focused, owner.requests.length]
  after.forEach((value, index) => assert(value === snapshot[index], boundary + ' rejects stale navigation, field ' + index))
  owner.unmount(); doc.revision = 1
}
await setupNavigator()
owner.change('映射规律表述', '历史浏览不能覆盖这段草稿')
const retained = JSON.stringify([...storage])
owner.click('查看靶图修订 navigator-record')
const failedNavigationRead = owner.pending().at(-1)
failedNavigationRead.reject(new Error('503 navigator history')); failedNavigationRead.settled = true; await owner.settle()
assert.equal(JSON.stringify([...storage]), retained)
owner.click('重试读取历史靶图'); await owner.load()
owner.change('定位例子', navigationIds[0]); owner.click('下一个筛选例子 ' + navigationIds[0])
assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[1])
assert(owner.control('映射规律表述').props.disabled)
const archivedChoose = owner.control('定位例子').props.onChange
owner.click('对照上层表述'); owner.click('快照内容')
assert.equal(owner.control('定位例子').props.value, '', 'Returning from field comparison does not claim an earlier navigation is still selected')
const comparisonReturnFocus = owner.focused, comparisonReturnNav = JSON.stringify([...owner.navigation])
archivedChoose({ target: { value: navigationIds[2] } }); owner.render()
assert.equal(owner.focused, comparisonReturnFocus); assert.equal(JSON.stringify([...owner.navigation]), comparisonReturnNav)
assert.equal(owner.control('定位例子').props.value, '')
owner.change('定位例子', navigationIds[2]); assert.equal(owner.control('定位例子').props.value, navigationIds[2])
owner.click('返回未保存草稿'); assert.equal(owner.control('映射规律表述').props.value, '历史浏览不能覆盖这段草稿')
assert.equal(JSON.stringify([...storage]), retained); assert.equal(owner.control('定位例子').props.value, '')
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
owner.change('定位例子', navigationIds[2])
assert.equal(owner.focused, 'data-target-example-heading:' + navigationIds[2]); assert(owner.control('保存个人靶图').props.disabled)
owner.unmount(); doc.revision = 1
for (const anomaly of ['removed', 'duplicate', 'hidden']) {
  await setupNavigator()
  if (anomaly === 'removed') owner.removedAnchor = navigationIds[2]
  if (anomaly === 'duplicate') owner.duplicateAnchors = true
  if (anomaly === 'hidden') owner.domHidden = true
  owner.render(); owner.change('定位例子', navigationIds[2])
  assert.equal(owner.focused, null, anomaly + ' cannot focus a replacement or hidden example')
  owner.unmount()
}
}

{
const id = 'gap-"39', blankMap = motionTargetMap()
blankMap.slots.push({ ...blankMap.slots[2], id: '__proto__', unit: 'km/h', scope: '另一对象，次日' })
blankMap.outcomes.push({ id: 'same-label', slotId: '__proto__', label: blankMap.outcomes[0].label, detail: '' })
blankMap.examples = Array.from({ length: 39 }, (_, index) => ({ ...structuredClone(blankMap.examples[0]), id: 'material-' + index,
  outputs: [...structuredClone(blankMap.examples[0].outputs), { slotId: '__proto__', outcomeId: 'same-label', detail: '' }] }))
blankMap.examples.push(tools.example(blankMap, id))
blankMap.mapping = ''; blankMap.slots[0].name = ''; blankMap.slots[1].meaning = ''
const setupGaps = async () => {
  storage.clear(); doc.revision = 1
  records = [tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion', id: 'gaps-record',
    parentId: '', reason: '', confirm: true, map: blankMap }, []).saved]
  assert(records[0]); owner = mount({ focusRequest: focus, slotNavigation: true }); await owner.load()
}
const action = path => '定位待整理要素 ' + JSON.stringify(path)
const gapFocus = path => 'data-target-gap-field:' + JSON.stringify(path)
const contents = () => [JSON.stringify([...storage]), JSON.stringify(records), owner.requests.length, writes]
const checkUnchanged = before => contents().forEach((value, index) => assert.equal(value, before[index], 'Gap navigation cannot write field ' + index))
await setupGaps()
owner.change('确认保存个人靶图', undefined, true)
owner.change('搜索例子文字', 'unmatched filter')
for (const path of [['slots', 'force', 'name'], ['slots', 'before', 'meaning'], ['mapping']]) {
  const before = contents(); owner.click(action(path))
  assert.equal(owner.focused, gapFocus(path)); assert.equal(owner.control('搜索例子文字').props.value, 'unmatched filter')
  assert(owner.control('确认保存个人靶图').props.checked); checkUnchanged(before)
}
const firstPath = ['examples', id, 'context'], firstAction = owner.control(action(firstPath))
assert.equal(text(firstAction), '清除筛选并定位'); assert(firstAction.props.title.includes('清除输出'))
const beforeRecovery = contents(); owner.click(action(firstPath))
assert.equal(owner.focused, gapFocus(firstPath)); assert.equal(owner.control('定位例子').props.value, id)
assert.equal(owner.control('搜索例子文字').props.value, '')
assert(all(owner.tree, node => node.props['data-target-case-id'] === id)[0].props.open)
assert.equal(text(owner.control(action(firstPath))), '定位'); checkUnchanged(beforeRecovery)
assert(owner.control('确认保存个人靶图').props.checked)
const steps = [
  ['例子 40 完整情境', '通常而非必然', ['inputs', 'force']],
  ['例子 40 输入 force', '0 N', ['inputs', 'before']],
  ['例子 40 输入 before', '未知单位与对象，不是零', ['process']],
  ['例子 40 推测过程', '循环不能证明；来源甲乙冲突', ['outputs', 'after']],
  ['例子 40 对应输出 after', 'rest', ['outputs', '__proto__']],
]
for (const [label, value, path] of steps) {
  owner.change(label, value); const before = contents()
  owner.click(action(['examples', id, ...path]))
  assert.equal(owner.focused, gapFocus(['examples', id, ...path])); checkUnchanged(before)
}
owner.change('例子 40 输出细节 __proto__', '尚不能确定，不执行公式')
assert(!text(owner.control('靶图待整理要素')).includes('例子要素未完整：' + id))
assert.equal(owner.control('例子 40 输入 before').props.value, '未知单位与对象，不是零')
assert.equal(owner.control('例子 40 推测过程').props.value, '循环不能证明；来源甲乙冲突')
owner.unmount()

for (const boundary of ['filter', 'filter-return', 'edit', 'delete', 'expansion', 'target', 'document', 'revision', 'hidden', 'hidden-return', 'pending', 'pending-cancel', 'archive', 'archive-return', 'comparison-return', 'reload', 'unmount']) {
  await setupGaps(); const old = owner.control(action(firstPath)).props.onClick
  if (boundary === 'filter') owner.change('搜索例子文字', 'new')
  if (boundary === 'filter-return') { owner.change('搜索例子文字', 'new'); owner.change('搜索例子文字', '') }
  if (boundary === 'edit') owner.change('例子 40 完整情境', '不再是原缺口')
  if (boundary === 'delete') { owner.click('删除例子 40'); owner.click('确认删除例子 40') }
  if (boundary === 'expansion') owner.change('定位例子', 'material-2')
  if (boundary === 'target') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'foreign'; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render() }
  if (boundary === 'hidden') { owner.props.active = false; owner.render() }
  if (boundary === 'hidden-return') { owner.props.active = false; owner.render(); owner.props.active = true; owner.render(); await owner.load() }
  if (boundary === 'unmount') owner.unmount()
  if (['pending', 'pending-cancel', 'archive', 'archive-return', 'comparison-return', 'reload'].includes(boundary)) owner.click('查看靶图修订 gaps-record')
  if (boundary === 'pending-cancel') owner.click('取消读取历史靶图')
  if (['archive', 'archive-return', 'comparison-return'].includes(boundary)) await owner.load()
  if (boundary === 'archive-return') owner.click('返回未保存草稿')
  if (boundary === 'comparison-return') { owner.click('对照上层表述'); owner.click('快照内容') }
  if (boundary === 'reload') { await owner.resolve(owner.pending().at(-1), { error: { code: 'revision_conflict', message: 'changed' } }); owner.click('重读靶图'); await owner.load() }
  const before = [...contents(), text(owner.tree), JSON.stringify([...owner.navigation]), owner.focused]
  old(); owner.render()
  const after = [...contents(), text(owner.tree), JSON.stringify([...owner.navigation]), owner.focused]
  after.forEach((value, index) => assert.equal(value, before[index], boundary + ' fences stale gap navigation ' + index))
  owner.unmount(); doc.revision = 1
}

await setupGaps(); owner.change('适用条件', 'PRIVATE GAP DRAFT'); owner.change('搜索例子文字', 'draft filter')
const draftBytes = JSON.stringify([...storage]), navBytes = JSON.stringify([...owner.navigation])
owner.click('查看靶图修订 gaps-record')
const failed = owner.pending().at(-1); failed.reject(new Error('503 gap read')); failed.settled = true; await owner.settle()
assert.equal(JSON.stringify([...storage]), draftBytes)
owner.click('重试读取历史靶图'); await owner.load()
owner.change('搜索例子文字', 'archive filter'); owner.click(action(firstPath))
assert.equal(owner.focused, gapFocus(firstPath)); assert(owner.control('例子 40 完整情境').props.disabled)
assert.equal(JSON.stringify([...owner.navigation]), navBytes, 'Historical gap navigation cannot replace draft filters')
owner.click('返回未保存草稿'); assert.equal(owner.control('搜索例子文字').props.value, 'draft filter')
assert.equal(JSON.stringify([...storage]), draftBytes)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load(); owner.click(action(firstPath))
assert.equal(owner.focused, gapFocus(firstPath)); assert(owner.control('保存个人靶图').props.disabled)
assert.equal(JSON.stringify([...storage]), draftBytes)
const nav = owner.navigation; owner.unmount(); doc.revision = 1
owner = mount({ focusRequest: focus, navigation: nav, slotNavigation: true }); await owner.load()
assert(!owner.focused?.startsWith('data-target-gap-field:'), 'Gap commands are not cached or replayed on reload')
owner.unmount()
for (const anomaly of ['missing', 'duplicate', 'hidden']) {
  await setupGaps()
  if (anomaly === 'missing') owner.removedAnchor = JSON.stringify(firstPath)
  if (anomaly === 'duplicate') owner.duplicateAnchors = true
  if (anomaly === 'hidden') owner.domHidden = true
  const before = contents(), priorFocus = owner.focused; owner.click(action(firstPath))
  assert.equal(owner.focused, priorFocus, anomaly + ' cannot select a substitute')
  assert.equal(owner.control('定位例子').props.value, ''); checkUnchanged(before); owner.unmount()
}
storage.clear(); records = []; doc.revision = 1
owner = mount({ focusRequest: { ...focus, targetId: 'externality' }, slotNavigation: true }); await owner.load()
owner.click(action(['mapping'])); assert.equal(owner.focused, gapFocus(['mapping']))
owner.click(action(['examples'])); assert.equal(owner.focused, gapFocus(['examples']))
assert.equal(owner.requests.filter(request => request.args.action === 'save').length, 0)
assert(!all(owner.tree, node => String(node.props['data-target-gap-field']).includes('meaning')).length)
owner.unmount()
}

{
doc.revision = 1; storage.clear(); records = []
const map = motionTargetMap(), literal = '<img src=x onerror=alert(1)>\n通常成立；方向未知；来源甲乙冲突，不由循环证明'
map.slots[0].unit = ' \n '; map.slots[0].scope = ''
map.slots[1].meaning = '预测时的原内涵'
map.slots.push({ id: '__proto__', role: 'output', name: '速度', meaning: literal, unit: 'km/h', scope: '另一对象，次日状态；不换算' })
for (const item of map.examples) item.outputs.push({ slotId: '__proto__', outcomeId: '', detail: '未知，不代入同名输出' })
map.examples[0].stage = 'prediction'
const save = id => {
  const response = tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    id, parentId: records.at(-1)?.id || '', reason: '本版槽位浏览验收', confirm: true, map }, records)
  assert(response.saved, JSON.stringify(response.error)); records.push(response.saved)
}
save('slot-basis'); map.slots[1].meaning = '后来修订的内涵'; save('slot-later')
owner = mount({ focusRequest: focus }); await owner.load()
assert.equal(all(owner.tree, node => node.props['data-target-example-model-context']).length, 2, 'Each concrete process needs its visible model rules and conditions in place')
const contextFor = (slotId, role, index = 0) => {
  const found = all(owner.tree, node => node.props['data-target-example-context'] === JSON.stringify([map.examples[index].id, role, slotId]))
  assert.equal(found.length, 1, 'Exactly one in-place context for each example slot identity'); return found[0]
}
const checkContext = (slotId, role, expected, absent = []) => {
  const context = contextFor(slotId, role)
  assert.equal(context.type, 'details'); assert.equal(context.props.open, undefined, 'Slot context is initially collapsed')
  assert.equal(context.props.onToggle, undefined, 'Reading a slot does not update the draft or persist disclosure state')
  for (const value of expected) assert(text(context).includes(value), slotId + ': ' + value)
  for (const value of absent) assert(!text(context).includes(value), slotId + ' cannot borrow ' + value)
  assert(!all(context, node => ['input', 'textarea', 'select', 'img', 'script'].includes(node.type)).length)
  return context
}
const beforeRead = [JSON.stringify([...storage]), JSON.stringify(records), writes, owner.requests.length]
checkContext('before', 'input', ['输入', '速度', 'm/s', '同一物体，原状态', '后来修订的内涵', '未保存草稿', '知识图第 1 版', '不自动视为原预测依据'], ['预测时的原内涵', '次日状态'])
checkContext('after', 'output', ['输出', '速度', 'm/s', '同一物体，后续状态'], ['同一物体，原状态', 'km/h'])
checkContext('__proto__', 'output', ['__proto__', 'km/h', '另一对象，次日状态；不换算', literal], ['同一物体，后续状态'])
assert.equal(all(contextFor('force', 'input'), node => node.type === 'p' && text(node).includes('未填写')).length, 2, 'Blank units and scope stay unknown, not zero or dimensionless')
assert.equal(all(owner.tree, node => node.props['data-target-example-context']).length, 8, 'Both necessary inputs and independent outputs remain visible per case')
assert.deepEqual([JSON.stringify([...storage]), JSON.stringify(records), writes, owner.requests.length], beforeRead)
owner.change('槽位 before 内涵表述', '未保存的内涵限定语'); owner.change('搜索例子文字', 'nothing matches')
checkContext('before', 'input', ['未保存的内涵限定语'], ['后来修订的内涵', '预测时的原内涵'])
owner.change('搜索例子文字', '')
const draftBytes = JSON.stringify([...storage]), recordsBytes = JSON.stringify(records), writeCount = writes
owner.click('查看靶图修订 slot-basis')
const failed = owner.pending().at(-1); failed.reject(new Error('503 slot context')); failed.settled = true; await owner.settle()
checkContext('before', 'input', ['未保存的内涵限定语', '未保存草稿'])
owner.click('重试读取历史靶图'); await owner.load()
checkContext('before', 'input', ['历史修订 slot-basis', '预测时的原内涵'], ['未保存的内涵限定语', '后来修订的内涵', '未保存草稿'])
owner.click('返回未保存草稿')
owner.click('查看预测时的上层表述'); await owner.load()
checkContext('before', 'input', ['历史修订 slot-basis', '预测时的原内涵', '不自动视为原预测依据'], ['未保存的内涵限定语', '不是原预测依据'])
owner.click('返回未保存草稿')
checkContext('before', 'input', ['未保存的内涵限定语', '未保存草稿'])
assert.equal(JSON.stringify([...storage]), draftBytes)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
checkContext('before', 'input', ['知识图第 1 版', '只读草稿', '未保存的内涵限定语'], ['知识图第 2 版'])
assert(owner.control('映射规律表述').props.disabled)
assert.equal(JSON.stringify([...storage]), draftBytes)
owner.click('开启当前版本靶图')
assert.equal(all(owner.tree, node => node.props['data-target-example-context']).length, 0, 'New revision cannot borrow old examples or slots')
owner.change('本地草稿版本', '1')
checkContext('before', 'input', ['只读草稿', '知识图第 1 版'])
assert.equal(JSON.stringify(records), recordsBytes); assert.equal(writes, writeCount)
owner.unmount(); doc.revision = 1; storage.clear(); records = []
const capacityMap = motionTargetMap()
for (const role of ['input', 'output']) while (capacityMap.slots.filter(slot => slot.role === role).length < 8) {
  capacityMap.slots.push({ id: role + '-' + capacityMap.slots.length, role, name: '速度', unit: '', scope: '', meaning: '独立身份，不由同名推断' })
}
capacityMap.examples = Array.from({ length: 40 }, (_, index) => tools.example(capacityMap, 'capacity-' + index))
records = [tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
  id: 'slot-capacity', parentId: '', reason: '', confirm: true, map: capacityMap }, []).saved]
assert(records[0]); owner = mount({ focusRequest: focus }); await owner.load()
const contexts = all(owner.tree, node => node.props['data-target-example-context'])
assert.equal(contexts.length, 640); assert.equal(new Set(contexts.map(node => node.props['data-target-example-context'])).size, 640)
assert(contexts.every(node => node.props.open === undefined))
owner.unmount(); storage.clear(); records = []
owner = mount({ focusRequest: { ...focus, targetId: 'externality' } }); await owner.load(); owner.click('增加具体推测')
const conceptContexts = all(owner.tree, node => node.props['data-target-example-context'])
assert.equal(conceptContexts.length, 2); assert(conceptContexts.every(node => !text(node).includes('我的内涵表述')))
assert(conceptContexts.every(node => text(node).includes('未填写') && !text(node).includes('预测时的原内涵')))
owner.unmount(); storage.clear(); records = []
}

{
doc.revision = 1; storage.clear(); records = []
const map = motionTargetMap(), basis = '预测时的规律；必须同时有合外力与原速度', later = '后来修订的规律；方向未知，不自动补齐'
const conditions = '同一物体、同一参考系；N 与 m/s 分别记录\n原状态与后续状态不同；通常成立，不删除限定语'
const boundary = '<img src=x onerror=alert(1)>\n来源甲乙冲突；循环不证明成立；不执行 a -> b -> a'
map.mapping = basis; map.conditions = conditions; map.boundary = boundary; map.examples[0].stage = 'prediction'
const save = id => {
  const response = tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    id, parentId: records.at(-1)?.id || '', reason: '例子中的规律验收', confirm: true, map }, records)
  assert(response.saved, JSON.stringify(response.error)); records.push(response.saved)
}
save('model-basis'); map.mapping = later; save('model-later')
owner = mount({ focusRequest: focus }); await owner.load()
const contextFor = (index = 0) => {
  const found = all(owner.tree, node => node.props['data-target-example-model-context'] === map.examples[index].id)
  assert.equal(found.length, 1, 'Each example identity owns one model context'); return found[0]
}
const checkContext = (expected, absent = [], index = 0) => {
  const node = contextFor(index)
  assert.equal(node.type, 'details'); assert.equal(node.props.open, undefined)
  assert.equal(node.props.onToggle, undefined, 'Native disclosure has no write or fetch handler')
  assert.equal(node.props['aria-label'], '例子 ' + (index + 1) + ' 的本版规律与条件')
  assert(!all(node, item => ['input', 'textarea', 'select', 'img', 'script'].includes(item.type)).length)
  for (const value of expected) assert(text(node).includes(value), value)
  for (const value of absent) assert(!text(node).includes(value), 'Cannot borrow: ' + value)
  for (const span of all(node, item => item.type === 'span')) {
    assert.equal(span.props.style.whiteSpace, 'pre-wrap'); assert.equal(span.props.style.overflowWrap, 'anywhere')
  }
}
const before = [JSON.stringify([...storage]), JSON.stringify(records), writes, owner.requests.length]
for (const index of [0, 1]) checkContext([later, conditions, boundary, '映射规律表述', '适用条件', '边界与不确定处', '未保存草稿', '知识图第 1 版', '不自动视为原预测依据'], [basis], index)
assert.deepEqual([JSON.stringify([...storage]), JSON.stringify(records), writes, owner.requests.length], before)
const long = 'x'.repeat(7900) + '\n方向未知；两项必要输入，不由同名代入'
owner.change('映射规律表述', long); owner.change('适用条件', ' \n '); owner.change('边界与不确定处', '')
owner.change('搜索例子文字', 'not a match')
checkContext([long], [later, basis, conditions, boundary])
assert.equal(all(contextFor(), node => node.type === 'span' && text(node) === '未填写').length, 2, 'Missing conditions and boundary do not mean unconditional validity')
owner.change('搜索例子文字', '')
const draftBytes = JSON.stringify([...storage]), recordsBytes = JSON.stringify(records), writeCount = writes
owner.click('查看靶图修订 model-basis')
const failed = owner.pending().at(-1); failed.reject(new Error('503 model context')); failed.settled = true; await owner.settle()
checkContext([long, '未保存草稿'], [basis])
assert.equal(JSON.stringify([...storage]), draftBytes)
owner.click('重试读取历史靶图'); await owner.load()
checkContext([basis, conditions, boundary, '历史修订 model-basis', '知识图第 1 版'], [long, later, '未保存草稿'])
assert(owner.control('映射规律表述').props.disabled)
owner.click('返回未保存草稿'); owner.click('查看预测时的上层表述'); await owner.load()
checkContext([basis, '历史修订 model-basis', '不自动视为原预测依据'], [long, later])
owner.click('返回未保存草稿'); checkContext([long, '未保存草稿'], [basis, later])
assert.equal(JSON.stringify([...storage]), draftBytes)
owner.unmount(); owner = mount({ focusRequest: focus }); await owner.load()
checkContext([long, '未保存草稿'], [basis, later]); assert.equal(JSON.stringify([...storage]), draftBytes)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
checkContext([long, '旧版只读草稿', '知识图第 1 版'], ['知识图第 2 版']); assert(owner.control('映射规律表述').props.disabled)
owner.click('开启当前版本靶图')
assert.equal(all(owner.tree, node => node.props['data-target-example-model-context']).length, 0)
for (const [key, value] of JSON.parse(draftBytes)) assert.equal(storage.get(key), value, 'Opening revision 2 must preserve every old draft byte')
assert.equal(storage.size, JSON.parse(draftBytes).length + 1)
const fresh = JSON.parse(storage.get('dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'motion', 2])))
assert.equal(fresh.baseRevision, 2); assert.equal(fresh.map.mapping, ''); assert.deepEqual(fresh.map.examples, [])
const versionBytes = JSON.stringify([...storage])
owner.change('本地草稿版本', '1'); checkContext([long, '旧版只读草稿'])
assert.equal(JSON.stringify([...storage]), versionBytes); assert.equal(JSON.stringify(records), recordsBytes); assert.equal(writes, writeCount)
owner.unmount(); doc.revision = 1; storage.clear(); records = []
const capacityMap = motionTargetMap(); capacityMap.mapping = long
capacityMap.examples = Array.from({ length: 40 }, (_, index) => tools.example(capacityMap, index ? 'case-' + index : '__proto__'))
records = [tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
  id: 'model-capacity', parentId: '', reason: '', confirm: true, map: capacityMap }, []).saved]
assert(records[0]); owner = mount({ focusRequest: focus }); await owner.load()
const contexts = all(owner.tree, node => node.props['data-target-example-model-context'])
assert.equal(contexts.length, 40); assert.equal(new Set(contexts.map(node => node.props['data-target-example-model-context'])).size, 40)
assert(contexts.every(node => node.props.open === undefined && text(node).includes(long)))
owner.unmount(); storage.clear(); records = []
owner = mount({ focusRequest: { ...focus, targetId: 'externality' } }); await owner.load(); owner.click('增加具体推测')
owner.change('判别规律表述', '具有免费让第三方受益的属性，归为正外部性；否则归为非正外部性')
const concept = all(owner.tree, node => node.props['data-target-example-model-context'])
assert.equal(concept.length, 1); assert(text(concept[0]).includes('判别规律表述'))
assert(text(concept[0]).includes('否则归为非正外部性')); assert(!text(concept[0]).includes('映射规律表述'))
assert.equal(all(concept[0], node => node.type === 'span' && text(node) === '未填写').length, 2)
assert(!text(concept[0]).includes(later)); assert.equal(owner.requests.filter(request => request.args.action === 'save').length, 0)
owner.unmount(); storage.clear(); records = []
}

// An edit must remain readable by the same draft contract after a full reload.
{
doc.revision = 1; storage.clear(); records = []
const draftKey = 'dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'motion', 1])
const map = motionTargetMap()
storage.set(draftKey, JSON.stringify({ documentId: doc.documentId, targetId: 'motion', baseRevision: 1, parentId: '', reason: '', map }))
owner = mount({ focusRequest: focus }); await owner.load()
const before = storage.get(draftKey), requests = owner.requests.length, writeCount = writes
owner.change('例子 1 完整情境', 'x'.repeat(8001))
assert.equal(owner.control('例子 1 完整情境').props.value, map.examples[0].context, 'Oversized edits must not replace the last recoverable draft')
assert.equal(storage.get(draftKey), before)
assert(text(owner.tree).includes('本次修改未应用'))
assert(owner.control('例子 1 完整情境').props['aria-invalid'])
assert.equal(owner.requests.length, requests); assert.equal(writes, writeCount)
owner.unmount(); owner = mount({ focusRequest: focus }); await owner.load()
assert.equal(owner.control('例子 1 完整情境').props.value, map.examples[0].context)
assert.equal(storage.get(draftKey), before)
assert(!text(owner.tree).includes('格式不兼容'))
owner.unmount(); storage.clear(); records = []

const fields = [['靶图标题', 4000], ['映射规律表述', 8000], ['适用条件', 8000], ['边界与不确定处', 8000], ['本次修订理由', 2000],
  ['槽位 before 名称', 4000], ['槽位 before 内涵表述', 4000], ['槽位 before 单位', 4000], ['槽位 before 对象与时间', 4000],
  ['输出取值 uniform 名称', 4000], ['输出取值 uniform 说明', 4000], ['例子 1 完整情境', 8000], ['例子 1 推测过程', 8000],
  ['例子 1 输入 before', 4000], ['例子 1 输出细节 after', 4000]]
for (const [label, limit] of fields) {
  storage.clear()
  storage.set(draftKey, JSON.stringify({ documentId: doc.documentId, targetId: 'motion', baseRevision: 1, parentId: '', reason: '', map }))
  owner = mount({ focusRequest: focus }); await owner.load()
  const accepted = '速'.repeat(limit - 2) + '\uD83D\uDE80'
  owner.change(label, accepted)
  assert.equal(owner.control(label).props.value, accepted, label + ': exact UTF-16 contract boundary must be accepted')
  const bytes = storage.get(draftKey), requests = owner.requests.length
  owner.change('确认保存个人靶图', undefined, true)
  owner.change(label, accepted + 'x')
  assert.equal(storage.get(draftKey), bytes, label + ': reject rather than truncate or poison the cache')
  assert.equal(owner.control(label).props.value, accepted)
  assert(owner.control(label).props['aria-invalid'])
  const described = all(owner.tree, item => item.props.id === owner.control(label).props['aria-describedby'])
  assert.equal(described.length, 1); assert.equal(described[0].props.role, 'alert')
  assert(text(described[0]).includes('本次修改未应用'))
  assert(owner.control('确认保存个人靶图').props.checked, 'Rejected input did not change the confirmed draft')
  assert.equal(owner.requests.length, requests)
  const literal = '未知方向；同名非同义；也许 0 m/s，另一对象下一时刻；循环不是证据；来源相互冲突 <script>x</script>'
  owner.change(label, literal)
  assert.equal(owner.control(label).props.value, literal)
  assert(!owner.control(label).props['aria-invalid']); assert(!text(owner.tree).includes('本次修改未应用'))
  assert(!owner.control('确认保存个人靶图').props.checked)
  tools.validate(JSON.parse(storage.get(draftKey)).map, { draft: true })
  owner.unmount(); owner = mount({ focusRequest: focus }); await owner.load()
  assert.equal(owner.control(label).props.value, literal)
  owner.unmount()
}

// The aggregate JSON limit is independent of each field's own limit and includes escaping.
storage.clear()
const full = motionTargetMap()
full.examples = Array.from({ length: 39 }, (_, i) => tools.example(full, 'full-' + i))
full.examples[0].inputs[0].value = '\\"'.repeat(2000)
for (const example of full.examples) {
  const remaining = 240000 - JSON.stringify(full).length
  example.context = 'x'.repeat(Math.min(8000, remaining))
}
assert.equal(JSON.stringify(full).length, 240000); tools.validate(full, { draft: true })
storage.set(draftKey, JSON.stringify({ documentId: doc.documentId, targetId: 'motion', baseRevision: 1, parentId: '', reason: '', map: full }))
owner = mount({ focusRequest: focus }); await owner.load()
owner.change('搜索例子文字', 'x')
const fullBytes = storage.get(draftKey), fullRequests = owner.requests.length
owner.change('靶图标题', full.title + 'x')
assert.equal(storage.get(draftKey), fullBytes)
assert(text(owner.tree).includes('单张容量'))
owner.click('增加具体推测')
assert.equal(storage.get(draftKey), fullBytes)
assert.equal(owner.control('搜索例子文字').props.value, 'x', 'A rejected structural edit cannot clear filters')
assert.equal(owner.requests.length, fullRequests)
owner.change('例子 1 完整情境', 'y'.repeat(8000))
assert.equal(JSON.stringify(JSON.parse(storage.get(draftKey)).map).length, 240000)
assert.equal(owner.control('搜索例子文字').props.value, '', 'Accepted edit still reveals the active field when its query no longer matches')
owner.change('例子 1 完整情境', '0，仍需必要输入和条件')
owner.click('增加具体推测')
assert.equal(JSON.parse(storage.get(draftKey)).map.examples.length, 40)
owner.unmount(); owner = mount({ focusRequest: focus }); await owner.load()
assert.equal(owner.control('例子 1 完整情境').props.value, '0，仍需必要输入和条件')
assert.equal(JSON.parse(storage.get(draftKey)).map.examples.length, 40)
owner.unmount(); storage.clear()

const predicted = motionTargetMap(); predicted.examples[0].stage = 'prediction'
records = [tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
  id: 'capacity-prediction', parentId: '', reason: '', confirm: true, map: predicted }, []).saved]
assert(records[0]); const recordsBytes = JSON.stringify(records)
owner = mount({ focusRequest: focus }); await owner.load()
owner.change('新一轮理由', '新'.repeat(2000))
const reasonBytes = storage.get(draftKey)
owner.change('新一轮理由', '新'.repeat(2001))
assert.equal(storage.get(draftKey), reasonBytes); assert(owner.control('新一轮理由').props['aria-invalid'])
owner.change('本次修订理由', 'x'.repeat(500001))
assert.equal(storage.get(draftKey), reasonBytes); assert(owner.control('本次修订理由').props['aria-invalid'])
owner.click('填写对照结果')
for (const [label, limit] of [['例子 1 对照结果', 8000], ['例子 1 结果来源说明', 4000]]) {
  owner.change(label, 'x'.repeat(limit))
  const bytes = storage.get(draftKey)
  owner.change(label, 'x'.repeat(limit + 1))
  assert.equal(storage.get(draftKey), bytes); assert(owner.control(label).props['aria-invalid'])
}
const longDraft = storage.get(draftKey)
owner.click('查看预测时的上层表述'); await owner.load()
assert(!text(owner.tree).includes('本次修改未应用'), 'Draft error cannot be attributed to a read-only snapshot')
owner.click('返回未保存草稿'); assert.equal(storage.get(draftKey), longDraft)
owner.click('打开靶图 externality'); await owner.load()
owner.click('打开靶图 motion')
const retryRead = owner.pending().find(request => request.args.action === 'read')
retryRead.reject(new Error('capacity fixture 503')); retryRead.settled = true; await owner.settle()
assert.equal(storage.get(draftKey), longDraft)
owner.click('重读靶图'); await owner.load()
assert.equal(storage.get(draftKey), longDraft)
assert.equal(owner.control('例子 1 对照结果').props.value.length, 8000)
doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
assert(owner.control('例子 1 对照结果').props.disabled)
assert(!text(owner.tree).includes('本次修改未应用'))
assert.equal(storage.get(draftKey), longDraft)
assert.equal(JSON.stringify(records), recordsBytes); assert.equal(writes, writeCount)
owner.unmount(); doc.revision = 1; storage.clear(); records = []
}

// Destructive draft edits need an explicit, identity-bound impact review.
{
const key = 'dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'motion', 1])
const material = motionTargetMap(), secondOutput = 'after"<>[2]'
material.slots.push({ ...material.slots[2], id: secondOutput, unit: 'km/h', scope: '另一对象，下一时刻，未知方向' })
material.outcomes.push({ id: 'same-label', slotId: secondOutput, label: material.outcomes[0].label, detail: '同名不是同身份；来源冲突' })
material.examples = Array.from({ length: 40 }, (_, index) => {
  const item = tools.example(material, 'case"<>-' + index)
  item.context = index ? '同名情境' : 'visible only <img src=x onerror=alert(1)>；通常成立，循环不是证据'
  item.inputs[0].value = '0 N'; item.inputs[1].value = '需另一个必要输入，0 m/s 不等于另一对象的静止'
  item.outputs[0].outcomeId = 'uniform'; item.outputs[0].detail = '也许适用；来源甲乙冲突'
  item.outputs[1].outcomeId = 'same-label'; item.outputs[1].detail = '另一对象和时间，保留限定语'
  item.process = '必须同时核对所有输入、单位与条件'; return item
})
tools.validate(material, { draft: true })
const seed = () => { storage.clear(); records = []; doc.revision = 1; storage.set(key, JSON.stringify({ documentId: doc.documentId, targetId: 'motion', baseRevision: 1, parentId: '', reason: '', map: material })) }
const scenarios = [
  ['slots', 'before', '删除槽位 before', '40 项输入记录', value => {
    assert.equal(value.slots.length, 3); assert(!value.slots.some(item => item.id === 'before'))
    assert(value.examples.every(item => item.inputs.length === 1 && item.inputs[0].value === '0 N'))
    assert.deepEqual(value.outcomes, material.outcomes)
    assert.deepEqual(value.examples.map(item => item.outputs), material.examples.map(item => item.outputs))
  }],
  ['slots', 'after', '删除槽位 after', '40 项输出记录，以及 3 个输出取值', value => {
    assert.equal(value.slots.length, 3); assert.equal(value.outcomes.length, 1)
    assert(value.examples.every(item => item.outputs.length === 1 && item.outputs[0].slotId === secondOutput && item.outputs[0].outcomeId === 'same-label'))
    assert.deepEqual(value.examples.map(item => item.inputs), material.examples.map(item => item.inputs))
  }],
  ['outcomes', 'uniform', '删除输出取值 uniform', '40 个例子对此取值的对应', value => {
    assert.deepEqual(value.slots, material.slots)
    assert(value.examples.every(item => item.outputs[0].outcomeId === '' && item.outputs[0].detail === material.examples[0].outputs[0].detail && item.outputs[1].outcomeId === 'same-label'))
    assert.deepEqual(value.examples.map(item => item.inputs), material.examples.map(item => item.inputs))
  }],
  ['examples', material.examples[0].id, '删除例子 1', '2 项输入、2 项输出', value => {
    assert.deepEqual(value.examples, material.examples.slice(1)); assert.deepEqual(value.slots, material.slots); assert.deepEqual(value.outcomes, material.outcomes)
  }],
]
const writeCount = writes
for (const [kind, id, label, impact, verify] of scenarios) {
  seed(); owner = mount({ focusRequest: focus, slotNavigation: true }); await owner.load()
  owner.change('搜索例子文字', 'visible only'); owner.change('确认保存个人靶图', undefined, true)
  const before = storage.get(key), requests = owner.requests.length
  owner.click(label)
  const preview = owner.control('待确认' + label)
  assert(text(preview).includes(impact)); assert(text(preview).includes('包含筛选外记录'))
  assert(text(preview).includes(id)); assert.equal(storage.get(key), before)
  assert(owner.control('确认保存个人靶图').props.checked)
  assert.equal(owner.focused, 'data-target-removal:' + JSON.stringify([kind, id]))
  const abandoned = owner.control('确认' + label).props.onClick
  owner.click('取消' + label)
  assert.equal(storage.get(key), before); assert(owner.control('确认保存个人靶图').props.checked)
  assert.equal(owner.focused, 'data-target-remove-button:' + JSON.stringify([kind, id]))
  owner.click(label); abandoned(); owner.render()
  assert.equal(storage.get(key), before, 'A canceled confirmation cannot approve a later identical request')
  const confirm = owner.control('确认' + label).props.onClick
  confirm(); confirm(); owner.render()
  const next = JSON.parse(storage.get(key)).map; verify(next); tools.validate(next, { draft: true })
  assert.equal(next.mapping, material.mapping); assert.equal(next.conditions, material.conditions); assert.equal(next.boundary, material.boundary)
  assert(!owner.control('确认保存个人靶图').props.checked); assert.equal(owner.requests.length, requests)
  assert(!all(owner.tree, item => item.props['data-target-removal']).length)
  assert(owner.control('撤销上次删除'), 'A confirmed deletion needs a bounded recovery action before another edit')
  assert.equal(owner.focused, kind === 'slots' ? 'data-target-record-view:draft' : kind === 'examples' ? 'data-target-example-list:heading' : 'data-target-outcome-list:heading')
  owner.unmount(); owner = mount({ focusRequest: focus }); await owner.load(); verify(JSON.parse(storage.get(key)).map); owner.unmount()
}
for (const [kind, id, label] of scenarios) {
  seed(); owner = mount({ focusRequest: focus, slotNavigation: true }); await owner.load()
  owner.change('本次修订理由', '撤销不能恢复旧批准或删除理由'); const original = storage.get(key), requests = owner.requests.length
  owner.click(label); owner.click('确认' + label)
  const undo = owner.control('撤销上次删除').props.onClick
  owner.change('搜索例子文字', '没有匹配例子'); owner.change('确认保存个人靶图', undefined, true)
  owner.change('映射规律表述', 'x'.repeat(8001))
  assert(text(owner.tree).includes('本次修改未应用')); assert(owner.control('撤销上次删除'))
  undo(); undo(); owner.render()
  assert.equal(storage.get(key), original, 'Undo restores the complete original draft including identities and all hidden cases: ' + kind)
  assert.equal(owner.control('搜索例子文字').props.value, '没有匹配例子', 'Undo does not silently change browsing filters')
  assert(!owner.control('确认保存个人靶图').props.checked); assert.equal(owner.requests.length, requests)
  assert(!all(owner.tree, item => item.props['aria-label'] === '撤销上次删除').length)
  assert.equal(owner.focused, kind === 'slots' ? 'data-target-record-view:draft' : kind === 'examples' ? 'data-target-example-list:heading' : 'data-target-outcome-list:heading')
  owner.unmount(); owner = mount({ focusRequest: focus }); await owner.load()
  assert.equal(storage.get(key), original); assert(!all(owner.tree, item => item.props['aria-label'] === '撤销上次删除').length); owner.unmount()
}
seed(); owner = mount({ focusRequest: focus }); await owner.load()
owner.click('删除槽位 before'); owner.click('确认删除槽位 before')
const firstUndo = owner.control('撤销上次删除').props.onClick, afterFirst = storage.get(key)
owner.click('删除槽位 after'); owner.click('确认删除槽位 after')
const afterSecond = storage.get(key)
firstUndo(); owner.render(); assert.equal(storage.get(key), afterSecond, 'An older receipt cannot undo two deletions')
owner.click('撤销上次删除'); assert.equal(storage.get(key), afterFirst)
firstUndo(); owner.render(); assert.equal(storage.get(key), afterFirst)
assert(!all(owner.tree, item => item.props['aria-label'] === '撤销上次删除').length); owner.unmount()
for (const boundary of ['edit-sync', 'reason', 'add', 'busy-return', 'hide-return', 'target-return', 'revision', 'document', 'history-sync', 'history-cancel', 'history-return', 'read-error', 'save-sync', 'save-error', 'unmount', 'reload']) {
  seed()
  if (boundary.startsWith('history')) records = [tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    id: 'undo-history', parentId: '', reason: '', confirm: true, map: motionTargetMap() }, []).saved]
  owner = mount({ focusRequest: focus }); await owner.load()
  owner.click('删除例子 1'); owner.click('确认删除例子 1'); const undo = owner.control('撤销上次删除').props.onClick
  if (boundary === 'edit-sync') owner.control('映射规律表述').props.onChange({ target: { value: '刚刚输入的新限定语，旧撤销不能覆盖' } })
  if (boundary === 'reason') owner.change('本次修订理由', '另一项改动')
  if (boundary === 'add') owner.click('增加具体推测')
  if (boundary === 'busy-return') { owner.props.busy = true; owner.render(); owner.props.busy = false; owner.render() }
  if (boundary === 'hide-return') { owner.props.active = false; owner.render(); owner.props.active = true; owner.render(); await owner.load() }
  if (boundary === 'target-return') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'another-document'; owner.render() }
  if (boundary.startsWith('history')) {
    owner.control('查看靶图修订 undo-history').props.onClick()
    if (boundary !== 'history-sync') {
      owner.render()
      if (boundary === 'history-cancel') owner.click('取消读取历史靶图')
      else { await owner.load(); owner.click('返回未保存草稿') }
    }
  }
  if (boundary === 'read-error') {
    owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion')
    const read = owner.pending().find(item => item.args.action === 'read'); read.reject(new Error('undo fixture 503')); read.settled = true; await owner.settle()
  }
  if (boundary.startsWith('save')) {
    owner.change('本次修订理由', '本地人工记录，不表示语义成立')
    owner.click('删除例子 1'); owner.click('确认删除例子 1')
    const latest = owner.control('撤销上次删除').props.onClick
    owner.change('确认保存个人靶图', undefined, true); owner.control('保存个人靶图').props.onClick()
    const bytes = storage.get(key); latest(); owner.render(); assert.equal(storage.get(key), bytes)
    const request = owner.pending().find(item => item.args.action === 'save'); assert(request)
    request.reject(new Error('save result unknown')); request.settled = true; await owner.settle()
    latest(); owner.render(); assert.equal(storage.get(key), bytes)
  }
  if (['unmount', 'reload'].includes(boundary)) owner.unmount()
  const bytes = JSON.stringify([...storage]), requests = owner.requests.length
  undo(); owner.render(); assert.equal(JSON.stringify([...storage]), bytes, boundary); assert.equal(owner.requests.length, requests, boundary)
  assert(!all(owner.tree, item => item.props['aria-label'] === '撤销上次删除').length, boundary)
  if (boundary === 'reload') { owner = mount({ focusRequest: focus }); await owner.load(); assert(!all(owner.tree, item => item.props['aria-label'] === '撤销上次删除').length) }
  owner.unmount()
}
seed(); owner = mount({ focusRequest: focus }); await owner.load()
owner.click('删除例子 1'); const outdatedConfirmation = owner.control('确认删除例子 1').props.onClick
owner.control('映射规律表述').props.onChange({ target: { value: '同一批事件中的新内容' } })
const newBytes = storage.get(key); outdatedConfirmation(); owner.render(); assert.equal(storage.get(key), newBytes)
assert.equal(JSON.parse(storage.get(key)).map.examples.length, 40, 'An accepted edit invalidates pending deletion synchronously')
owner.click('删除例子 1'); owner.click('确认删除例子 1'); const cachedDeletion = storage.get(key)
storageFailure = true; owner.click('撤销上次删除')
assert.equal(storage.get(key), cachedDeletion); assert(text(owner.tree).includes('本地草稿存储不可用'))
assert.equal(owner.control('例子 1 完整情境').props.value, material.examples[0].context)
storageFailure = false; owner.change('本次修订理由', '恢复存储后保留原来的全部例子')
assert.equal(JSON.parse(storage.get(key)).map.examples.length, 40); owner.unmount()
for (const boundary of ['edit', 'reason', 'filter', 'filter-return', 'busy', 'busy-return', 'hide', 'hide-return', 'target', 'target-return', 'revision', 'document', 'history', 'history-cancel', 'history-return', 'read-error', 'unmount']) {
  seed()
  if (boundary.startsWith('history')) records = [tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    id: 'removal-history', parentId: '', reason: '', confirm: true, map: motionTargetMap() }, []).saved]
  owner = mount({ focusRequest: focus }); await owner.load()
  const request = owner.control('删除例子 1').props.onClick
  request(); owner.render(); const confirm = owner.control('确认删除例子 1').props.onClick
  if (boundary === 'edit') owner.change('映射规律表述', '也许适用，但来源冲突')
  if (boundary === 'reason') owner.change('本次修订理由', '另一个草稿身份')
  if (boundary.startsWith('filter')) { owner.change('搜索例子文字', '不存在'); if (boundary === 'filter-return') owner.change('搜索例子文字', '') }
  if (boundary.startsWith('busy')) { owner.props.busy = true; owner.render(); if (boundary === 'busy-return') { owner.props.busy = false; owner.render() } }
  if (boundary.startsWith('hide')) { owner.props.active = false; owner.render(); if (boundary === 'hide-return') { owner.props.active = true; owner.render(); await owner.load() } }
  if (boundary.startsWith('target')) { owner.click('打开靶图 externality'); await owner.load(); if (boundary === 'target-return') { owner.click('打开靶图 motion'); await owner.load() } }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'document') { owner.props.documentId = 'another-document'; owner.render() }
  if (boundary.startsWith('history')) {
    owner.click('查看靶图修订 removal-history')
    if (boundary === 'history-cancel') owner.click('取消读取历史靶图')
    else { await owner.load(); if (boundary === 'history-return') owner.click('返回未保存草稿') }
  }
  if (boundary === 'read-error') {
    owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion')
    const read = owner.pending().find(item => item.args.action === 'read'); read.reject(new Error('removal fixture 503')); read.settled = true; await owner.settle()
  }
  if (boundary === 'unmount') owner.unmount()
  const bytes = JSON.stringify([...storage]), requests = owner.requests.length
  confirm(); request(); owner.render(); assert.equal(JSON.stringify([...storage]), bytes, boundary); assert(!all(owner.tree, item => item.props['data-target-removal']).length, boundary)
  assert.equal(owner.requests.length, requests); owner.unmount()
}
doc.revision = 1; seed()
const protectedMap = motionTargetMap(); protectedMap.examples[0].stage = 'prediction'
records = [tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion', id: 'removal-protected', parentId: '', reason: '', confirm: true, map: protectedMap }, []).saved]
storage.clear(); owner = mount({ focusRequest: focus }); await owner.load()
assert(owner.control('删除例子 1').props.disabled); assert(owner.control('删除槽位 before').props.disabled); assert(owner.control('删除输出取值 uniform').props.disabled)
assert(owner.control('删除槽位 after').props.disabled, 'Last required output cannot be removed')
owner.control('删除例子 1').props.onClick(); owner.render()
assert(!all(owner.tree, item => item.props['data-target-removal']).length)
assert.equal(writes, writeCount); owner.unmount(); storage.clear(); records = []; doc.revision = 1
}

// A successful write for another identity cannot repair a protected, memory-only draft.
{
const writeCount = writes, documentId = doc.documentId
const draftKey = (targetId, revision = 1) => 'dsh-kg-target-map:' + JSON.stringify([documentId, targetId, revision])
const cacheAlert = () => all(owner.tree, item => item.props.role === 'alert').map(text).find(value => value.includes('本地草稿')) || ''
for (const raw of ['null', 'false', '0', '""', '']) {
  storage.clear(); storage.set(draftKey('motion'), raw)
  owner = mount({ focusRequest: focus }); await owner.load()
  assert.equal(storage.get(draftKey('motion')), raw, 'A present but falsy cache is damaged data, not an absent draft')
  assert(cacheAlert().includes('本地草稿'))
  owner.change('映射规律表述', '只在窗口中的草稿'); assert.equal(storage.get(draftKey('motion')), raw)
  owner.unmount()
}
for (const damage of ['json', 'schema', 'identity', 'size', 'read']) {
  storage.clear(); doc.revision = 1
  records = [tools.handle(doc, { action: 'save', documentId, expectedRevision: 1, targetId: 'motion', id: 'cache-history', parentId: '', reason: '', confirm: true, map: motionTargetMap() }, []).saved]
  const valid = { documentId, targetId: 'motion', baseRevision: 1, parentId: 'cache-history', reason: '', map: motionTargetMap() }
  const raw = damage === 'json' ? '{damaged' : damage === 'schema' ? JSON.stringify({ ...valid, map: {} }) :
    damage === 'identity' ? JSON.stringify({ ...valid, targetId: 'motion ' }) : damage === 'size' ? ' '.repeat(500001) : JSON.stringify(valid)
  storage.set(draftKey('motion'), raw)
  storage.set(draftKey('motion', 3), '{unreadable future cache')
  if (damage === 'read') storageReadFailures.add(draftKey('motion'))
  owner = mount({ focusRequest: focus }); await owner.load()
  storageReadFailures.clear()
  const originalWarning = cacheAlert()
  assert(originalWarning.includes('知识图第 1 版') && originalWarning.includes(damage === 'schema' || damage === 'identity' ? '身份或格式不兼容' : '无法读取'), damage)
  const mapping = '<script>not executable</script>\n方向未知；两个必要输入；对象与时间不同；N 与 m/s；通常；来源冲突；循环不是证明'
  owner.change('映射规律表述', mapping); owner.change('确认保存个人靶图', undefined, true)
  assert.equal(cacheAlert(), originalWarning); assert.equal(storage.get(draftKey('motion')), raw)
  const oldEdit = owner.control('映射规律表述').props.onChange
  owner.click('打开靶图 externality')
  assert.equal(cacheAlert(), '', 'Even while loading, another target must not inherit the warning')
  const failed = owner.pending().find(item => item.args.action === 'read'); failed.reject(new Error('cache fixture read failure')); failed.settled = true; await owner.settle()
  assert.equal(cacheAlert(), '', 'An HTTP failure cannot relabel the previous draft as this target')
  owner.click('重读靶图'); await owner.load(); owner.change('判别规律表述', '健康草稿')
  const healthyBytes = storage.get(draftKey('externality'))
  oldEdit({ target: { value: 'late edit' } }); owner.render()
  assert.equal(storage.get(draftKey('externality')), healthyBytes); assert.equal(storage.get(draftKey('motion')), raw)
  owner.click('打开靶图 motion'); await owner.load()
  assert.equal(owner.control('映射规律表述').props.value, mapping); assert.equal(cacheAlert(), originalWarning)
  assert(!owner.control('确认保存个人靶图').props.checked, 'Reopening does not restore approval')
  owner.click('查看靶图修订 cache-history'); await owner.load()
  assert.equal(cacheAlert(), '', 'A historical server snapshot is not the memory-only local draft')
  owner.click('返回未保存草稿'); assert.equal(cacheAlert(), originalWarning)
  owner.props.active = false; owner.render(); assert.equal(cacheAlert(), '')
  owner.props.active = true; owner.render(); await owner.load(); assert.equal(cacheAlert(), originalWarning)
  owner.props.documentId = documentId + ' '; owner.render(); assert.equal(cacheAlert(), '', 'Document identity is exact, not trimmed')
  owner.props.documentId = documentId; owner.render(); await owner.load(); assert.equal(cacheAlert(), originalWarning)
  doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
  assert.equal(cacheAlert(), originalWarning, 'The warning refers to the retained old draft, not the new graph revision')
  assert(owner.control('映射规律表述').props.disabled)
  owner.click('开启当前版本靶图'); owner.change('映射规律表述', '健康的新版草稿')
  assert.equal(cacheAlert(), '')
  owner.change('本地草稿版本', '3')
  assert(cacheAlert().includes('知识图第 3 版'), 'A failed version selection identifies the cache actually read')
  assert(cacheAlert().includes('当前草稿未被替换') && !cacheAlert().includes('当前编辑暂留窗口'), 'A failed alternative read must not imply the healthy active draft is memory-only')
  assert.equal(owner.control('映射规律表述').props.value, '健康的新版草稿')
  owner.change('本地草稿版本', '1'); assert.equal(cacheAlert(), originalWarning)
  assert.equal(owner.control('映射规律表述').props.value, mapping)
  owner.change('本地草稿版本', '3')
  const warnings = all(owner.tree, item => item.props.role === 'alert').map(text).filter(value => value.includes('本地草稿'))
  assert.equal(warnings.length, 2, 'A failed read of another version must not erase the active memory-only draft warning')
  assert.equal(warnings[0], originalWarning); assert(warnings[1].includes('知识图第 3 版'))
  assert(warnings[1].includes('当前草稿未被替换') && !warnings[1].includes('当前编辑暂留窗口'))
  assert.equal(storage.get(draftKey('motion')), raw); assert.equal(storage.get(draftKey('externality')), healthyBytes)
  owner.unmount(); doc.revision = 1
  owner = mount({ focusRequest: focus }); await owner.load()
  if (damage !== 'read') assert.equal(cacheAlert(), originalWarning, 'Remount rechecks the untouched damaged bytes')
  else assert.equal(cacheAlert(), '', 'A new mount can read the intact cache after a transient read failure')
  owner.unmount()
}
storage.clear(); records = []; doc.revision = 1
owner = mount({ focusRequest: focus }); await owner.load()
const stored = storage.get(draftKey('motion'))
storageFailure = true; owner.change('映射规律表述', '尚未落盘的配额失败草稿')
assert(cacheAlert().includes('存储不可用')); assert.equal(storage.get(draftKey('motion')), stored)
owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load()
assert(cacheAlert().includes('知识图第 1 版') && cacheAlert().includes('存储不可用'))
assert.equal(owner.control('映射规律表述').props.value, '尚未落盘的配额失败草稿')
storageFailure = false; owner.click('打开靶图 externality'); await owner.load()
assert.equal(storage.get(draftKey('motion')), stored, 'Writing another draft does not persist the failed one')
owner.click('打开靶图 motion'); await owner.load()
assert.equal(cacheAlert(), '', 'Only a successful write of this draft clears its quota warning')
assert.equal(JSON.parse(storage.get(draftKey('motion'))).map.mapping, '尚未落盘的配额失败草稿')
assert.equal(writes, writeCount); owner.unmount(); storage.clear(); records = []; doc.revision = 1
}

// File backups preserve the owned in-memory draft, not filtered rows or a server history view.
{
const savedGlobals = { Blob: context.Blob, document: context.document, URL: context.URL }
const downloads = [], blobs = new Map(), anchors = new Set(), writeCount = writes
let downloadFailure = false, urlSequence = 0
context.Blob = Blob
context.URL = { createObjectURL(blob) { if (downloadFailure) throw new Error('download unavailable'); const id = 'blob:test-' + ++urlSequence; blobs.set(id, blob); return id }, revokeObjectURL: id => blobs.delete(id) }
context.document = { body: { appendChild: anchor => anchors.add(anchor) }, createElement(tag) {
  assert.equal(tag, 'a'); return { style: {}, click() { downloads.push({ filename: this.download, blob: blobs.get(this.href) }) }, remove() { anchors.delete(this) } }
} }
const documentId = doc.documentId, key = (id = 'motion', rev = 1) => 'dsh-kg-target-map:' + JSON.stringify([documentId, id, rev])
const seed = () => {
  records = []; storage.clear(); doc.revision = 1; storageFailure = false
  const map = motionTargetMap()
  map.mapping = '<script>not executable</script>\n方向未知；通常；单位对象时间不同；循环不是证明；来源冲突'
  map.examples = Array.from({ length: 40 }, (_, i) => ({ ...structuredClone(map.examples[i % 2]), id: 'same-name-' + i,
    stage: i % 3 === 0 ? 'reviewed' : i % 3 === 1 ? 'prediction' : 'material',
    ...(i % 3 === 0 ? { feedback: { kind: ['personal', 'source', 'observation', 'ai'][i % 4], text: '结果未知', source: '冲突来源\n未独立验证' } } : {}) }))
  const value = { documentId, targetId: 'motion', baseRevision: 1, parentId: '', reason: '未完成理由', roundReason: '下一轮，尚未批准', map }
  tools.validate(map, { draft: true }); storage.set(key(), JSON.stringify(value)); return value
}
const backup = async expected => {
  const before = JSON.stringify([...storage]), requests = owner.requests.length, confirmed = owner.control('确认保存个人靶图').props.checked
  const previous = downloads.length
  owner.click('导出草稿 JSON')
  assert.equal(downloads.length, previous + 1)
  const file = downloads.at(-1), result = JSON.parse(await file.blob.text())
  assert.equal(file.blob.type, 'application/json;charset=utf-8'); assert.equal(file.filename, 'target-map-draft-r' + expected.baseRevision + '.json')
  assert.equal(result.format, 'dsh.target-map-draft'); assert.equal(result.version, 1); assert.equal(result.status, 'unsubmitted_draft_not_verified')
  assert(Number.isFinite(Date.parse(result.exportedAt)))
  assert.deepEqual(result.draft, { ...expected, roundReason: expected.roundReason || '' })
  assert.deepEqual(Object.keys(result).sort(), ['draft', 'exportedAt', 'format', 'status', 'version'])
  assert.equal(JSON.stringify([...storage]), before); assert.equal(owner.requests.length, requests); assert.equal(writes, writeCount)
  assert.equal(owner.control('确认保存个人靶图').props.checked, confirmed)
  assert.equal(blobs.size, 0); assert.equal(anchors.size, 0)
  assert(text(owner.tree).includes('已请求下载 JSON')); return result
}
let value = seed(); owner = mount({ focusRequest: focus }); await owner.load()
owner.change('确认保存个人靶图', undefined, true); owner.change('搜索例子文字', 'no visible examples')
const committedExport = owner.control('导出草稿 JSON').props.onClick, beforeBailout = downloads.length
owner.render(); committedExport(); owner.render()
assert.equal(downloads.length, beforeBailout + 1, 'A same-context render must not invalidate the still-visible committed download button')
await backup(value)
assert.equal(owner.control('搜索例子文字').props.value, 'no visible examples')
owner.change('靶图标题', '同名 / ../ \\ 文件名不会采纳'); value = JSON.parse(storage.get(key()))
assert(!text(owner.tree).includes('已请求下载 JSON'), 'Editing invalidates the status of the previous snapshot')
await backup(value)
for (const unavailable of ['Blob', 'URL', 'document']) {
  const original = context[unavailable], count = downloads.length, before = JSON.stringify([...storage])
  context[unavailable] = undefined; owner.click('导出草稿 JSON'); context[unavailable] = original
  assert.equal(downloads.length, count); assert(text(owner.tree).includes('导出失败')); assert.equal(JSON.stringify([...storage]), before)
  await backup(value)
}
owner.unmount()

// Damaged storage and quota failure export the current window bytes without repairing storage or approving a save.
for (const damage of ['null', '{damaged', 'quota']) {
  seed(); storage.set(key(), damage === 'quota' ? storage.get(key()) : damage)
  owner = mount({ focusRequest: focus }); await owner.load()
  const before = storage.get(key()); if (damage === 'quota') storageFailure = true
  owner.change('映射规律表述', '仅窗口\n通常、未知、冲突来源；N / m/s')
  const map = damage === 'quota' ? JSON.parse(before).map : tools.blank(doc.graph.nodes[0])
  map.mapping = owner.control('映射规律表述').props.value
  const expected = damage === 'quota' ? { ...JSON.parse(before), map: { ...JSON.parse(before).map, mapping: map.mapping } }
    : { documentId, targetId: 'motion', baseRevision: 1, parentId: '', reason: '', map }
  downloadFailure = true; const count = downloads.length; owner.click('导出草稿 JSON')
  assert.equal(downloads.length, count); assert(text(owner.tree).includes('导出失败')); assert.equal(storage.get(key()), before)
  downloadFailure = false; await backup(expected)
  assert(text(owner.tree).includes('本地草稿')); assert(!text(owner.tree).includes('导出失败'))
  doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load()
  assert(owner.control('映射规律表述').props.disabled); await backup(expected)
  assert.equal(storage.get(key()), before); owner.unmount(); storageFailure = false
}

seed(); owner = mount({ focusRequest: focus }); await owner.load()
owner.click('打开靶图 externality'); await owner.load()
owner.click('增加具体推测'); owner.change('例子 1 先记录预测', undefined, true)
owner.change('判别规律表述', '通常不能仅凭同名判断；方向未知'); owner.props.busy = true; owner.render()
await backup(JSON.parse(storage.get(key('externality'))))
owner.props.active = false; owner.render(); owner.props.active = true; owner.render()
assert(owner.control('导出草稿 JSON').props.disabled, 'Do not export during a pending detail read')
const failedRead = owner.pending().find(item => item.args.action === 'read')
failedRead.reject(new Error('export fixture 503')); failedRead.settled = true; await owner.settle()
assert(!owner.control('导出草稿 JSON').props.disabled, 'A failed detail refresh must not block backup of an owned visible draft')
await backup(JSON.parse(storage.get(key('externality')))); owner.unmount()

// Old handlers cannot export another context, even after navigating back to an identical-looking target.
for (const boundary of ['edit', 'target', 'target-return', 'hide', 'hide-return', 'revision', 'document', 'history-pending', 'history', 'history-return', 'reload', 'save-sync', 'unmount']) {
  value = seed(); records = [tools.handle(doc, { action: 'save', documentId, expectedRevision: 1, targetId: 'motion', id: 'export-history', parentId: '', reason: '', confirm: true, map: motionTargetMap() }, []).saved]
  value.parentId = 'export-history'; storage.set(key(), JSON.stringify(value))
  owner = mount({ focusRequest: focus }); await owner.load()
  owner.change('确认保存个人靶图', undefined, true)
  let oldExport = owner.control('导出草稿 JSON').props.onClick
  if (boundary === 'edit') owner.change('映射规律表述', 'new value')
  if (boundary.startsWith('target')) { owner.click('打开靶图 externality'); await owner.load(); if (boundary === 'target-return') { owner.click('打开靶图 motion'); await owner.load() } }
  if (boundary.startsWith('hide')) { owner.props.active = false; owner.render(); if (boundary === 'hide-return') { owner.props.active = true; owner.render(); await owner.load() } }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load() }
  if (boundary === 'document') { owner.props.documentId += ' '; owner.render() }
  if (boundary.startsWith('history')) {
    owner.click('查看靶图修订 export-history'); assert(owner.control('导出草稿 JSON').props.disabled)
    if (boundary !== 'history-pending') {
      await owner.load(); assert(!all(owner.tree, item => item.type === 'button' && text(item) === '导出草稿 JSON').length, 'History is not an exportable local draft')
      if (boundary === 'history-return') owner.click('返回未保存草稿')
    }
  }
  if (boundary === 'reload') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion') }
  if (boundary === 'save-sync') {
    owner.change('本次修订理由', 'explicit save'); owner.change('确认保存个人靶图', undefined, true)
    oldExport = owner.control('导出草稿 JSON').props.onClick
    owner.control('保存个人靶图').props.onClick()
    assert(owner.pending().some(item => item.args.action === 'save'))
  }
  if (boundary === 'unmount') owner.unmount()
  const count = downloads.length, before = JSON.stringify([...storage]), requests = owner.requests.length
  oldExport(); owner.render()
  assert.equal(downloads.length, count, boundary); assert.equal(JSON.stringify([...storage]), before); assert.equal(owner.requests.length, requests)
  owner.unmount()
}
storageFailure = false; records = []; storage.clear(); doc.revision = 1
Object.assign(context, savedGlobals)
assert.equal(writes, writeCount)
}

// Restoring a backup is a reviewed local replacement, never a server save or an identity migration.
{
const writeCount = writes, key = 'dsh-kg-target-map:' + JSON.stringify([doc.documentId, 'motion', 1])
const seed = (prediction = false) => {
  storage.clear(); storageFailure = false; doc.revision = 1
  const map = motionTargetMap()
  if (prediction) map.examples[0].stage = 'prediction'
  records = [tools.handle(doc, { action: 'save', documentId: doc.documentId, expectedRevision: 1, targetId: 'motion',
    id: 'import-parent', parentId: '', reason: '', confirm: true, map }, []).saved]
  assert(records[0]); return records[0]
}
const envelope = () => ({ format: 'dsh.target-map-draft', version: 1, status: 'unsubmitted_draft_not_verified', exportedAt: '2026-10-05T00:00:00.000Z',
  draft: { documentId: doc.documentId, targetId: 'motion', baseRevision: 1, parentId: 'import-parent', reason: '从备份恢复的理由', roundReason: '未批准的新一轮理由', map: motionTargetMap() } })
const file = value => ({ name: '<script>backup</script>.json', size: JSON.stringify(value).length, text: async () => JSON.stringify(value) })
const choose = async value => {
  const target = { files: [value], value: 'selected.json' }
  const pending = owner.control('选择草稿备份 JSON').props.onChange({ target }); owner.render()
  await pending; await owner.settle(); assert.equal(target.value, '')
}
const unchanged = () => JSON.stringify({ storage: [...storage], requests: owner.requests.length, confirmed: owner.control('确认保存个人靶图').props.checked })
const preview = () => all(owner.tree, item => item.props['aria-label'] === '草稿备份预览')
seed(); owner = mount({ focusRequest: focus }); await owner.load()
owner.change('映射规律表述', '不能因选文件丢失的本地草稿'); owner.change('确认保存个人靶图', undefined, true)
let before = unchanged(), value = envelope()
value.draft.map.title = '同名 ../ 文件不是路径'
value.draft.map.mapping = '<script>literal</script>\n方向未知；通常；两个必要输入；N / m/s；前后状态；循环；冲突来源'
value.draft.map.examples = Array.from({ length: 40 }, (_, i) => ({ ...structuredClone(value.draft.map.examples[i % 2]), id: 'backup-' + i }))
await choose(file(value)); assert.equal(unchanged(), before); assert.equal(preview().length, 1)
assert(text(preview()).includes('backup-39')); assert(!all(preview(), item => item.type === 'script').length)
assert(owner.control('载入备份草稿').props.disabled); owner.control('载入备份草稿').props.onClick(); owner.render(); assert.equal(unchanged(), before)
owner.click('取消导入备份'); assert.equal(unchanged(), before); assert.equal(preview().length, 0)
await choose(file(value)); owner.change('确认替换当前草稿', undefined, true)
const accepted = owner.control('载入备份草稿').props.onClick
owner.render(); accepted(); accepted(); owner.render()
assert.deepEqual(JSON.parse(storage.get(key)), value.draft); assert(!owner.control('确认保存个人靶图').props.checked)
assert.equal(owner.requests.length, JSON.parse(before).requests); assert.equal(writes, writeCount); assert.equal(preview().length, 0)
owner.unmount(); owner = mount({ focusRequest: focus }); await owner.load()
assert.deepEqual(JSON.parse(storage.get(key)), value.draft); assert.equal(owner.control('映射规律表述').props.value, value.draft.map.mapping)

const bad = [null, [], {}, ...[
  v => { v.format = 'other' }, v => { v.version = 2 }, v => { v.status = 'verified' }, v => { v.exportedAt = 'yesterday' },
  v => { v.confirm = true }, v => { v.draft.confirm = true }, v => { v.draft.documentId += ' ' }, v => { v.draft.targetId = 'externality' },
  v => { v.draft.baseRevision = 0 }, v => { v.draft.baseRevision = 2 }, v => { v.draft.baseRevision = '1' }, v => { v.draft.parentId = 'other-head' },
  v => { v.draft.map.mode = 'discrimination' }, v => { v.draft.reason = 'x'.repeat(2001) }, v => { v.draft.roundReason = false },
  v => { v.draft.map.slots[1].id = v.draft.map.slots[0].id }, v => { v.draft.map.examples[0].inputs.pop() },
  v => { v.draft.map.examples[0].stage = 'reviewed' }, v => { v.draft.map.boundary = 'x'.repeat(8001) },
].map(mutate => { const v = envelope(); mutate(v); return v })]
for (const invalid of bad) {
  before = unchanged(); await choose(file(invalid))
  assert(text(owner.tree).includes('备份未导入')); assert.equal(preview().length, 0); assert.equal(unchanged(), before)
}
for (const invalid of [
  { name: 'large.json', size: 2097153, text: () => { throw new Error('Must reject size before reading') } },
  { name: 'read.json', size: 1, text: async () => { throw new Error('File read failure') } },
  { name: 'bad.json', size: 1, text: async () => '{bad' },
]) { before = unchanged(); await choose(invalid); assert(text(owner.tree).includes('备份未导入')); assert.equal(unchanged(), before) }
owner.unmount()

seed(true); owner = mount({ focusRequest: focus }); await owner.load()
for (const mutate of [
  v => { v.draft.map.examples[0].process += '事后改写' }, v => { v.draft.map.examples.shift() },
  v => { v.draft.map.slots[1].unit = 'km/h' }, v => { v.draft.map.slots[1].scope = '另一时刻' },
  v => { v.draft.map.outcomes[0].label += '新含义' },
]) {
  value = envelope(); value.draft.map = structuredClone(records[0].map); mutate(value)
  before = unchanged(); await choose(file(value)); assert(text(owner.tree).includes('备份未导入')); assert.equal(unchanged(), before)
}
owner.unmount()

for (const damage of ['{damaged', 'quota']) {
  seed(); if (damage !== 'quota') storage.set(key, damage)
  owner = mount({ focusRequest: focus }); await owner.load()
  const raw = storage.get(key); storageFailure = damage === 'quota'
  value = envelope(); value.draft.map.examples.push(tools.example(value.draft.map, 'unfinished', 'prediction'))
  await choose(file(value)); owner.change('确认替换当前草稿', undefined, true); owner.click('载入备份草稿')
  assert.equal(storage.get(key), raw); assert(text(owner.tree).includes('本地草稿')); assert.equal(owner.control('例子 3 完整情境').props.value, '')
  assert.equal(owner.control('本次修订理由').props.value, value.draft.reason)
  assert(!owner.control('确认保存个人靶图').props.checked); owner.unmount(); storageFailure = false
}

for (const boundary of ['edit', 'target', 'target-return', 'hide', 'hide-return', 'busy', 'revision', 'document', 'history', 'history-return', 'read', 'save-sync', 'unmount', 'cancel']) {
  seed(); owner = mount({ focusRequest: focus }); await owner.load(); value = envelope()
  await choose(file(value)); owner.change('确认替换当前草稿', undefined, true)
  const apply = owner.control('载入备份草稿').props.onClick
  if (boundary === 'edit') owner.change('映射规律表述', 'new')
  if (boundary.startsWith('target')) { owner.click('打开靶图 externality'); await owner.load(); if (boundary === 'target-return') { owner.click('打开靶图 motion'); await owner.load() } }
  if (boundary.startsWith('hide')) { owner.props.active = false; owner.render(); if (boundary === 'hide-return') { owner.props.active = true; owner.render(); await owner.load() } }
  if (boundary === 'busy') { owner.props.busy = true; owner.render() }
  if (boundary === 'revision') { doc.revision = 2; owner.props.revision = 2; owner.render(); await owner.load(); assert(owner.control('选择草稿备份 JSON').props.disabled) }
  if (boundary === 'document') { owner.props.documentId += ' '; owner.render() }
  if (boundary.startsWith('history')) { owner.click('查看靶图修订 import-parent'); await owner.load(); if (boundary === 'history-return') owner.click('返回未保存草稿') }
  if (boundary === 'read') { owner.props.active = false; owner.render(); owner.props.active = true; owner.render() }
  if (boundary === 'save-sync') { owner.change('确认保存个人靶图', undefined, true); owner.control('保存个人靶图').props.onClick() }
  if (boundary === 'unmount') owner.unmount()
  if (boundary === 'cancel') owner.click('取消导入备份')
  const bytes = JSON.stringify([...storage]), requests = owner.requests.length
  apply(); owner.render(); assert.equal(JSON.stringify([...storage]), bytes, boundary); assert.equal(owner.requests.length, requests, boundary)
  owner.unmount()
}

for (const boundary of ['cancel', 'edit', 'target-return', 'new-file', 'unmount']) {
  seed(); owner = mount({ focusRequest: focus }); await owner.load()
  let finish; const pending = owner.control('选择草稿备份 JSON').props.onChange({ target: { value: 'a.json', files: [{ name: 'slow.json', size: 1, text: () => new Promise(resolve => { finish = resolve }) }] } })
  owner.render(); assert(text(owner.tree).includes('正在读取备份'))
  if (boundary === 'cancel') owner.click('取消导入备份')
  if (boundary === 'edit') owner.change('映射规律表述', 'later edit')
  if (boundary === 'target-return') { owner.click('打开靶图 externality'); await owner.load(); owner.click('打开靶图 motion'); await owner.load() }
  if (boundary === 'new-file') { value = envelope(); value.draft.map.title = 'new file wins'; await choose(file(value)) }
  if (boundary === 'unmount') owner.unmount()
  const bytes = JSON.stringify([...storage]); finish(JSON.stringify(envelope())); await pending; await owner.settle()
  assert.equal(JSON.stringify([...storage]), bytes)
  if (boundary === 'new-file') assert(text(preview()).includes('new file wins')); else assert.equal(preview().length, 0)
  owner.unmount()
}
records = []; storage.clear(); doc.revision = 1; assert.equal(writes, writeCount)
}

console.log(JSON.stringify({ ok: true, generatedComponent: true, draftNavigationAndReload: true, retryAndDoubleClick: true,
  casReview: true, versionIsolation: true, lateResponses: true, damagedStorageAndQuota: true, historyPagination: true,
  historyDraftPreserved: true, historyAppendFence: true, historyResponseFences: true, historyNoWrites: true, noAutoWrite: true,
  roundExplicitConfirmation: true, roundLostResponseRetry: true, roundHistoryAndDrafts: true, roundVersionFence: true,
  browseRestoration: true, pendingSearchPreserved: true, consumedFocus: true, browseIdentityFence: true, browseNoAuthorityCache: true,
  directoryAnchor: true, directoryReflow: true, hiddenPositionPreserved: true, directoryScopeFence: true, catalogueRetry: true,
  exactSlotFocus: true, exactExampleReturn: true, slotScopeFence: true, navigationNoWrites: true, readOnlyNavigation: true,
  exampleReadingOffset: true, exampleNestedScrollers: true, exampleLayoutAndResize: true,
  examplePositionFallback: true, examplePositionStaleActions: true, examplePositionNoWritesOrCache: true,
  recordReadCancellation: true, recordReadRetry: true, recordReadLatestOnly: true, recordReadScopeFence: true, recordReadNoWrites: true,
  snapshotReadingFocus: true, snapshotExactReturn: true, snapshotFocusOwnership: true, snapshotOriginIdentity: true, snapshotNavigationNoWrites: true,
  snapshotReadingOffset: true, snapshotNestedScrollers: true, snapshotLayoutChange: true, snapshotResizeClamp: true, snapshotReturnRetry: true,
  historyResumePage: true, historyExpansion: true, historyResumeHeadFence: true, historyResumeRetry: true, historyResumeContextFence: true,
  historyResumeNoAuthorityCache: true, historyResumeSaveReset: true, upperSnapshotComparison: true, comparisonExactIdentity: true,
  comparisonLiteralText: true, comparisonVersionFence: true, comparisonScopeFence: true, comparisonNoWritesOrApprovals: true,
  exampleSnapshotComparison: true, exampleComparisonExactBindings: true, exampleComparisonFeedbackBoundary: true,
  exampleComparisonLiteralText: true, exampleComparisonBoundedRendering: true, exampleComparisonScopeFence: true, exampleComparisonNoWrites: true,
  predictionBasisComparison: true, archiveBasisOwnership: true, predictionBasisResponseFence: true, predictionBasisScopeFence: true,
  predictionBasisRetryIntent: true, predictionBasisDraftPreserved: true, predictionBasisNoWrites: true,
  outcomeExampleBrowse: true, outcomeExactBindings: true, outcomeEmptyAndUnassigned: true, outcomeScopeFence: true,
  outcomeDraftPreserved: true, outcomeHistoryReturn: true, outcomeNoWrites: true,
  examplePairComparison: true, examplePairCompleteBindings: true, examplePairLiteralAndFeedback: true,
  examplePairDraftPreserved: true, examplePairHistoryAndRetry: true, examplePairScopeFence: true, examplePairNoWrites: true,
  filteredExampleEditVisible: true, filteredExampleExactBindings: true, filteredExampleDraftOnly: true,
  filteredExampleHistoryRetry: true, filteredExampleStaleEditsRejected: true,
  exampleStageBrowse: true, exampleStageExactPersistence: true, exampleStageFilterIntersection: true,
  exampleStageEditContinuity: true, exampleStageArchiveAndVersion: true, exampleStageScopeFence: true, exampleStageNoWrites: true,
  pageNavigationRestore: true, pageNavigationPendingSearch: true, pageNavigationExactIdentity: true, pageNavigationNoAuthority: true,
  pageNavigationDamagedStorage: true, pageNavigationHistoryFence: true, pageNavigationDraftPreserved: true, pageNavigationStaleScroll: true,
  exampleTextSearch: true, exampleTextLiteralFields: true, exampleTextFilterIntersection: true, exampleTextEditContinuity: true,
  exampleTextArchiveBoundary: true, exampleTextStaleCallbacks: true, exampleTextNoWrites: true,
  exampleFilterPageRestore: true, exampleFilterExactScope: true, exampleFilterNoAuthorityCache: true,
  exampleFilterLiteralRestore: true, exampleFilterArchiveIsolation: true, exampleFilterRestoreRetry: true, exampleFilterRestoreNoWrites: true,
  historyPairUpperAndExamples: true, historyPairExactIdentity: true, historyPairIndependentBindings: true, historyPairLiteralAndFeedback: true,
  historyPairReadFence: true, historyPairStaleCallbacks: true, historyPairNoWritesOrCache: true,
  historyBasisOwnerComparison: true, historyBasisExactPrediction: true, historyBasisFeedbackBoundary: true,
  historyBasisReadAndReturnRetry: true, historyBasisScopeFence: true, historyBasisNoWritesOrCache: true,
  exampleFeedbackSourceBrowse: true, feedbackFilterStageBoundary: true, feedbackFilterIntersection: true,
  feedbackFilterEditContinuity: true, feedbackFilterPageRestore: true, feedbackFilterStaleCallbacks: true, feedbackFilterNoWrites: true,
  exampleExpansionControlled: true, exampleExpansionExactIdentity: true, exampleExpansionHistoryIsolation: true,
  exampleExpansionRefreshAndRetry: true, exampleExpansionDraftPreserved: true, exampleExpansionStaleEvents: true, exampleExpansionNoWrites: true,
  exampleLocatorExactIdentity: true, exampleLocatorFilteredSequence: true, exampleLocatorCompleteInputs: true,
  exampleLocatorStaleCallbacks: true, exampleLocatorHistoryAndVersion: true, exampleLocatorNoWrites: true, exampleLocatorMissingDom: true,
  exampleDirectPairExactIdentity: true, exampleDirectPairCompleteBindings: true, exampleDirectPairReturn: true,
  exampleDirectPairFilterFence: true, exampleDirectPairStaleCallbacks: true, exampleDirectPairHistoryAndVersion: true, exampleDirectPairNoWrites: true,
  exampleFilterRecoveryExplicit: true, exampleFilterRecoveryExactFocus: true, exampleFilterRecoveryPairAndExpansion: true,
  exampleFilterRecoveryStaleCallbacks: true, exampleFilterRecoveryHistoryAndVersion: true, exampleFilterRecoveryReload: true,
  exampleFilterRecoveryNoWrites: true, exampleFilterRecoveryMissingDom: true,
  gapExactFieldNavigation: true, gapSequentialMissingInputs: true, gapExplicitFilterRecovery: true,
  gapStaleCallbacks: true, gapHistoryAndVersion: true, gapReadRetryAndReload: true, gapNoWrites: true, gapMissingDom: true,
  inlineSlotExactIdentity: true, inlineSlotLiteralAndUnknown: true, inlineSlotRevisionProvenance: true,
  inlineSlotPredictionBasisBoundary: true, inlineSlotDraftAndRetry: true, inlineSlotNoWrites: true,
  inlineModelRulesAndConditions: true, inlineModelLiteralAndUnknown: true, inlineModelPredictionBasisBoundary: true,
  inlineModelDraftRetryAndReload: true, inlineModelHistoryAndVersion: true, inlineModelNoWrites: true,
  draftEditAdmission: true, draftFieldLimitsAndUnicode: true, draftAggregateCapacity: true, rejectedEditNoSideEffects: true,
  draftCapacityReload: true, draftCapacityHistoryAndRetry: true, draftCapacityVersionFence: true,
  removalPreviewNoWrites: true, removalExactCascade: true, removalCancelAndDoubleClick: true, removalContextFences: true,
  removalFocusAndReload: true, removalSavedPredictionProtection: true,
  removalUndoExactRecovery: true, removalUndoReadOnlyBrowsing: true, removalUndoOneStepOnly: true,
  removalUndoContextAndSyncFences: true, removalUndoNoApprovalOrHttp: true, removalUndoQuotaAndReload: true,
  draftWarningIdentity: true, draftWarningMemoryRoundTrip: true, draftWarningHistoryAndVersion: true,
  draftWarningReadFailures: true, draftWarningQuotaRecovery: true, draftWarningRawBytesAndNoWrites: true,
  draftExportCompleteSnapshot: true, draftExportNoAuthorityOrWrites: true, draftExportFailureAndRetry: true,
  draftExportMemoryOnlyAndOldVersion: true, draftExportContextFences: true, draftExportIncompleteAndReadFailure: true, draftFalsyCachePreserved: true,
  draftImportReviewedReplacement: true, draftImportExactIdentity: true, draftImportPredictionProtection: true,
  draftImportAsyncFences: true, draftImportNoAuthorityOrWrites: true, draftImportCacheFailures: true }))
