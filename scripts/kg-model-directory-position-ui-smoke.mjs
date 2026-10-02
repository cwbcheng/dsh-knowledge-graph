import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelExamplesFixture } from './kg-consumption-model-examples-fixture-data.mjs'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const sliceState = value => value.slice(value.indexOf('function connectionModelBrowseState('), value.indexOf('function ConnectionModelPanel('))
const stateContext = {}
runInNewContext(sliceState(source) + '\nglobalThis.normalize = connectionModelBrowseState', stateContext)
const scope = (documentId = 'doc', revision = 1, query = '', section = '', offset = 0, needsReview = false, conceptId = '', role = '') =>
  JSON.stringify([documentId, revision, query, section, offset, needsReview, conceptId, role])
const saved = { documentId: 'doc', revision: 1, query: '', search: '', modelId: 'different selected model',
  directoryPosition: { scope: scope(), nodeId: ' 模型:同名/甲 ', fraction: 0.4 } }
const normalized = stateContext.normalize(saved, 'doc', 1)
assert.deepEqual(JSON.parse(JSON.stringify(normalized.directoryPosition ?? null)), saved.directoryPosition,
  'History remount must preserve the directory reading anchor, not only the selected model')

const helperSlice = value => value.slice(value.indexOf('function readConnectionDirectoryAnchor('), value.indexOf('function ConnectionModelPanel('))
assert(helperSlice(source).startsWith('function readConnectionDirectoryAnchor('))
assert.equal(helperSlice(source), helperSlice(generated))
const helperContext = {}
runInNewContext(helperSlice(source) + '\nglobalThis.read = readConnectionDirectoryAnchor; globalThis.restore = restoreConnectionDirectoryAnchor', helperContext)
const plain = value => JSON.parse(JSON.stringify(value))
const assertAnchor = (actual, expected) => {
  assert.equal(actual.nodeId, expected.nodeId)
  assert(Math.abs(actual.fraction - expected.fraction) < 1e-9, 'Reading fraction differs beyond floating-point arithmetic')
}
let negatives = 0
for (const change of [{ documentId: 'doc ' }, { revision: 2 }, { query: 'pending' }, { search: 'different' },
  { section: 'another' }, { offset: 20 }, { needsReview: true }, { concept: { nodeId: 'concept' } }, { role: 'input' },
  { directoryPosition: { ...saved.directoryPosition, scope: scope() + ' ' } },
  { directoryPosition: { ...saved.directoryPosition, nodeId: '' } },
  { directoryPosition: { ...saved.directoryPosition, nodeId: 1 } },
  ...[-1, 1.1, NaN, Infinity, '0.4'].map(fraction => ({ directoryPosition: { ...saved.directoryPosition, fraction } }))]) {
  assert.equal(stateContext.normalize({ ...saved, ...change }, 'doc', 1).directoryPosition, null)
  negatives++
}
const opaque = ' 模型:namespace/同名甲' + 'unbroken'.repeat(500) + ' '
assert.equal(stateContext.normalize({ ...saved, directoryPosition: { ...saved.directoryPosition, nodeId: opaque } }, 'doc', 1).directoryPosition.nodeId, opaque)
const dom = () => {
  const element = { clientTop: 2, clientHeight: 220, visible: true, top: 35, rows: [], writes: 0,
    getBoundingClientRect() { return { top: this.top, height: this.visible ? this.clientHeight + 4 : 0 } },
    querySelectorAll(selector) { assert.equal(selector, '[data-model-catalogue-row]'); return this.rows },
    get scrollHeight() { return this.rows.reduce((sum, row) => sum + row.height, 0) },
    get scrollTop() { return this.value || 0 },
    set scrollTop(value) { this.writes++; this.value = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight))) },
    populate(ids, height = 100) {
      this.rows = ids.map((id, index) => ({ dataset: { modelCatalogueRow: id }, height: height + index % 3 * 10,
        getBoundingClientRect: () => ({ top: this.top + this.clientTop + this.rows.slice(0, index).reduce((sum, row) => sum + row.height, 0) - this.scrollTop,
          bottom: this.top + this.clientTop + this.rows.slice(0, index + 1).reduce((sum, row) => sum + row.height, 0) - this.scrollTop,
          height: this.rows[index].height }) }))
    } }
  return element
}
const geometry = dom()
geometry.populate(['same-name', 'same-name ', opaque, 'tail', 'last'])
geometry.scrollTop = 250
const anchor = plain(helperContext.read(geometry))
assert.equal(anchor.nodeId, opaque)
assert.equal(anchor.fraction, 1 / 3)
geometry.scrollTop = 0
assert.equal(helperContext.restore(geometry, anchor), true)
assert.equal(geometry.scrollTop, 250)
geometry.populate(['same-name', 'same-name ', opaque, 'tail', 'last'], 180)
assert.equal(helperContext.restore(geometry, anchor), true)
assertAnchor(helperContext.read(geometry), anchor)
geometry.visible = false
const writesBeforeHidden = geometry.writes
assert.equal(helperContext.read(geometry), null)
assert.equal(helperContext.restore(geometry, anchor), false)
assert.equal(geometry.writes, writesBeforeHidden, 'A hidden workbench must not erase or move the visible reading point')
geometry.visible = true
assert.equal(helperContext.restore(geometry, { nodeId: 'same-name  ', fraction: 0 }), false)
assert.equal(helperContext.restore(geometry, { nodeId: opaque, fraction: NaN }), false)
assert.equal(helperContext.restore(geometry, { nodeId: opaque, fraction: 2 }), false)
assert.equal(helperContext.restore(geometry, { nodeId: opaque, fraction: '0.2' }), false)
geometry.populate([opaque, opaque, 'tail', 'last'])
assert.equal(helperContext.restore(geometry, anchor), false, 'Duplicate canonical identity cannot select an arbitrary row')

let current, cursor = 0, nextTimer = 0
const timers = new Map(), observers = []
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
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
  } }
const context = { window: { React, confirm: () => true }, AbortController, console,
  ResizeObserver: class {
    constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this) }
    observe(element) { this.element = element }
    disconnect() { this.disconnected = true }
  },
  setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer }, clearTimeout: id => timers.delete(id) }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const Component = context.window.KGViewer.ConnectionModelPanel
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
  : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
let writes = 0, httpQueries = 0, modelCalls = 0
const fixture = modelExamplesFixture()
const harness = await modelLearningHarness({ fixture, llm: { call() { modelCalls++; throw new Error('No real model calls') } } })
const server = createServer((req, res) => harness.handler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models'
const read = async args => { httpQueries++; return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json() }
const canonicalBefore = JSON.stringify(harness.store.getDocument(fixture.documentId, { includeSource: true }))
const mount = options => {
  const owner = { slots: [], effects: [], updates: [], requests: [], snapshots: [], element: dom() }
  const props = { documentId: fixture.documentId, revision: 1, ...options,
    load: (args, signal) => new Promise(resolve => {
      const request = { args, signal, settled: false, resolve: value => { request.settled = true; resolve(value) } }
      owner.requests.push(request)
    }),
    onStateChange: state => owner.snapshots.push(plain(state)),
    onRoles: () => { writes++; throw new Error('No browsing writes') } }
  owner.props = props
  owner.render = () => {
    for (let index = 0; index < 20; index++) {
      owner.updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
      owner.tree = Component(props)
      const directory = all(owner.tree, node => node.props?.className === 'kg-model-directory')[0]
      const ids = all(directory, node => node.props?.['data-model-catalogue-row'] != null).map(node => node.props['data-model-catalogue-row'])
      owner.element.populate(ids, owner.rowHeight || 100)
      if (directory.props.ref) directory.props.ref.current = owner.element
      owner.effects.splice(0).forEach(fn => fn())
      if (!owner.updates.length) return
    }
    throw new Error('Component update loop')
  }
  owner.control = label => {
    const item = all(owner.tree, node => node.props['aria-label'] === label || node.type === 'button' && text(node) === label)[0]
    assert(item, label); return item
  }
  owner.scroll = top => {
    owner.element.scrollTop = top
    all(owner.tree, node => node.props.className === 'kg-model-directory')[0].props.onScroll({ currentTarget: owner.element })
  }
  owner.settle = async () => { for (let index = 0; index < 6; index++) { await Promise.resolve(); owner.render() } }
  owner.resolve = async request => { request.resolve(await read(request.args)); await owner.settle() }
  owner.unmount = () => { for (const state of owner.slots) state.cleanup?.() }
  owner.render()
  return owner
}
try {
  let owner = mount()
  await owner.resolve(owner.requests[0])
  const directoryIds = owner.element.rows.map(row => row.dataset.modelCatalogueRow)
  assert(directoryIds.length >= 10)
  owner.scroll(780)
  const position = owner.snapshots.at(-1).directoryPosition
  assert(position?.nodeId === directoryIds[7], 'The visible row, not the selected first model, is cached')
  assert(!Object.hasOwn(owner.snapshots.at(-1), 'page') && !Object.hasOwn(owner.snapshots.at(-1), 'detail'))
  const cached = owner.snapshots.at(-1)
  owner.unmount()
  assert(observers.every(item => item.disconnected), 'Unmount releases the resize observer')
  owner = mount({ restoreState: cached })
  assert.equal(owner.element.scrollTop, 0, 'A cached anchor cannot restore old rows before the actual canonical response')
  await owner.resolve(owner.requests[0])
  assert.equal(owner.element.scrollTop, 780)
  const newlySelected = directoryIds[9]
  const row = all(owner.tree, node => node.props['data-model-catalogue-row'] === newlySelected)[0]
  all(row, node => node.type === 'button')[0].props.onClick(); owner.render()
  await owner.resolve(owner.requests.filter(item => item.args.modelId === newlySelected).at(-1))
  owner.control('原文依据').props.onClick(); owner.render()
  owner.rowHeight = 190; owner.render()
  observers.filter(item => !item.disconnected).forEach(item => item.fn())
  assertAnchor(helperContext.read(owner.element), position)
  assert.equal(owner.snapshots.at(-1).modelId, newlySelected, 'Resize observer cannot publish an older selected model')
  assert.equal(owner.snapshots.at(-1).tab, 'source', 'Resize observer cannot publish an older detail tab')
  const beforeHidden = owner.snapshots.at(-1).directoryPosition
  owner.element.visible = false
  observers.filter(item => !item.disconnected).forEach(item => item.fn())
  assert.deepEqual(owner.snapshots.at(-1).directoryPosition, beforeHidden)
  owner.element.visible = true
  observers.filter(item => !item.disconnected).forEach(item => item.fn())
  const beforeError = owner.snapshots.at(-1)
  owner.control('重新读取模型').props.onClick(); owner.render(); await owner.settle()
  const request = owner.requests.filter(item => !item.args.modelId).at(-1)
  const failedCatalogue = await read({ ...request.args, documentId: 'missing-owned-document' })
  assert.equal(failedCatalogue.error.code, 'not_found')
  request.resolve(failedCatalogue); await owner.settle()
  assert(text(owner.tree).includes(failedCatalogue.error.message))
  assert.deepEqual(owner.snapshots.at(-1).directoryPosition, beforeError.directoryPosition)
  owner.control('重新读取模型').props.onClick(); owner.render(); await owner.settle()
  await owner.resolve(owner.requests.filter(item => !item.args.modelId).at(-1))
  assertAnchor(helperContext.read(owner.element), position)
  owner.control('搜索联结模型').props.onChange({ target: { value: 'unknown-role' } }); owner.render()
  assert.equal(owner.snapshots.at(-1).directoryPosition, null, 'Unsettled edited query cannot inherit the old reading scope')
  const editedSnapshots = owner.snapshots.length
  observers.forEach(item => item.fn())
  assert.equal(owner.snapshots.length, editedSnapshots, 'Queued/disconnected observers cannot overwrite new pending input')
  for (const fn of [...timers.values()]) fn()
  timers.clear(); owner.render()
  await owner.resolve(owner.requests.filter(item => !item.args.modelId).at(-1))
  assert.equal(owner.element.scrollTop, 0, 'A new query starts at its first current result')
  owner.control('重新读取模型').props.onClick(); owner.render(); await owner.settle()
  const stale = owner.requests.filter(item => !item.args.modelId).at(-1)
  assert.equal(stale.settled, false, 'This is a pending old response, not a second resolution of a completed Promise')
  assert.equal(stale.signal.aborted, false, 'The old response must still be pending when its owner unmounts')
  owner.unmount()
  assert.equal(stale.signal.aborted, true)
  const missingAnchor = mount({ restoreState: { ...cached, directoryPosition: { ...cached.directoryPosition, nodeId: directoryIds[7] + ' ' } } })
  await missingAnchor.resolve(missingAnchor.requests[0])
  assert.equal(missingAnchor.element.scrollTop, 0, 'Absent or differently spaced identity cannot restore a similar row')
  missingAnchor.unmount()
  const different = mount({ revision: 2, restoreState: cached })
  assert.equal(different.snapshots[0].directoryPosition, null)
  const snapshotCount = different.snapshots.length
  const lateResponse = await read(stale.args)
  assert.equal(lateResponse.revision, 1)
  stale.resolve(lateResponse); await different.settle()
  assert.equal(owner.updates.length, 0, 'An aborted old request cannot publish to its unmounted owner')
  assert.equal(different.element.rows.length, 0, 'A new revision cannot mount the old owner\'s canonical rows')
  assert.equal(different.snapshots.length, snapshotCount, 'Late old responses cannot move the new document/version position')
  different.unmount()
  assert(observers.every(item => item.disconnected))
  const finalSnapshots = different.snapshots.length
  observers.forEach(item => item.fn())
  assert.equal(different.snapshots.length, finalSnapshots, 'Unmounted resize callbacks cannot change the next owner')
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId, { includeSource: true })), canonicalBefore)
  assert.equal(harness.store.listLearningAttempts(fixture.documentId).length, 0)
  assert.equal(writes, 0); assert.equal(modelCalls, 0)
  console.log(JSON.stringify({ ok: true, actualHostHttp: true, httpQueries, negativeScopes: negatives,
    rowIdentityAndFraction: true, opaqueIdentityPreserved: true, canonicalResponseRequired: true,
    resizeAndHiddenProtected: true, observerReleased: true, errorsRetryAndLateResponses: true,
    noEvidenceCache: true, graphAndLearningUnchanged: true, modelCalls, browserAcceptanceRequired: true }))
} finally { await new Promise(resolve => server.close(resolve)); harness.stop() }
