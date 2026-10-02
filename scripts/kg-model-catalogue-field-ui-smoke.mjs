import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelCatalogueSearchFixture } from './kg-model-catalogue-search-fixture-data.mjs'

const fixture = modelCatalogueSearchFixture()
const dense = fixture.graph.nodes.find(node => node.id === 'catalogue-dense')
dense.modelStructure.branches.forEach((branch, index) => {
  branch.id = 'branch_' + 'x'.repeat(70) + '_' + index
  branch.label = 'Same branch label'
  branch.condition.text += '\n\tOnly for object-A at t0. <img src=x onerror=attack()>'
})
let modelCalls = 0
const harness = await modelLearningHarness({ fixture, llm: { async createMessage() { modelCalls++; throw new Error('No model calls') } } })
const server = createServer(harness.handler)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models'
const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
let queries = 0, current, cursor = 0, timerId = 0
const timers = new Map(), owners = []
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
const context = { window: { React, confirm: () => true }, AbortController, console,
  setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const Component = context.window.KGViewer.ConnectionModelPanel
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
  : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
const read = async args => {
  queries++
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
  assert.equal(response.status, 200)
  return response.json()
}
const mount = options => {
  const owner = { slots: [], effects: [], updates: [], requests: [], snapshots: [], fieldNavigation: [], refs: new Set() }
  owner.props = { documentId: fixture.documentId, revision: 1, ...options,
    load: (args, signal) => new Promise(resolve => owner.requests.push({ args, signal, resolve })),
    onStateChange: state => owner.snapshots.push(state),
    onRoles: () => { throw new Error('Field navigation cannot write roles') } }
  owner.render = () => {
    for (let index = 0; index < 20; index++) {
      owner.updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
      owner.tree = Component(owner.props)
      for (const ref of owner.refs) ref.current = null
      owner.refs.clear()
      for (const target of all(owner.tree, node => node.props['data-model-field-hit'])) {
        const ref = target.props.ref
        owner.refs.add(ref)
        ref.current = {
          scrollIntoView: options => owner.fieldNavigation.push({ field: target.props['data-model-field-hit'], scroll: options }),
          focus: options => owner.fieldNavigation.push({ field: target.props['data-model-field-hit'], focus: options }),
        }
      }
      owner.effects.splice(0).forEach(fn => fn())
      if (!owner.updates.length) return
    }
    throw new Error('Component update loop')
  }
  owner.settle = async () => { for (let index = 0; index < 6; index++) { await Promise.resolve(); owner.render() } }
  owner.resolve = async (request, result) => { request.resolve(result || await read(request.args)); await owner.settle() }
  owner.click = control => { assert(control && !control.props.disabled, 'Missing or disabled field control'); control.props.onClick(); owner.render() }
  owner.unmount = () => { for (const state of owner.slots) state.cleanup?.() }
  owners.push(owner); owner.render(); return owner
}
const hits = owner => all(owner.tree, node => node.type === 'button' && node.props.className === 'kg-model-field-link')
const marked = owner => all(owner.tree, node => node.props['data-model-field-hit'])
const cached = query => ({ documentId: fixture.documentId, revision: 1, query, search: query })
try {
  for (const query of ['ONLYAFTERMIDNIGHT', 'FAREBRANCHONLY', 'NOTOBSERVATION', 'UNRESOLVEDCATALOGUE',
    'FULLWIDTHCONDITION', 'UNICODEPHRASE NORMALIZEDWORD', 'DENSECATALOGUERECORD', 'BRANCHTAILCATALOGUE', 'OPERATORCATALOGUE x > 3',
    'CONFLICTBRANCHCASE', 'ROLEBRANCHCASE']) {
    const owner = mount({ restoreState: cached(query) })
    const catalogue = await read(owner.requests[0].args)
    assert(!catalogue.error && catalogue.items.length)
    await owner.resolve(owner.requests[0], catalogue)
    const expected = catalogue.items.reduce((n, model) => n + (model.modelFieldMatches?.items.length || 0), 0)
    console.log(JSON.stringify({ query, recordedLocations: expected, renderedLocations: hits(owner).length }))
    assert.equal(hits(owner).length, expected, 'Catalogue must expose recorded branch field locations, not only model titles')
    assert(expected > 0)
    const location = catalogue.items[0].modelFieldMatches.items[0]
    let selectedLocation = location
    owner.click(hits(owner)[0])
    const request = owner.requests.at(-1)
    assert.equal(request.args.modelId, catalogue.items[0].nodeId)
    assert.equal(request.args.branchId, location.branchId, 'Opaque branch identity must reach the actual canonical detail route')
    assert.equal(request.args.expectedRevision, 1)
    await owner.resolve(request)
    const detail = await read(request.args)
    const branch = detail.structure.branches.find(branch => branch.id === location.branchId)
    assert.equal(marked(owner).length, 1)
    assert.equal(marked(owner)[0].props['data-model-field-hit'], location.field)
    assert(text(marked(owner)[0]).includes(branch[location.field].text), 'Navigation cannot clip or normalize the recorded field')
    const navigationCount = owner.fieldNavigation.length, requestCount = owner.requests.length
    for (let repeat = 0; repeat < 2; repeat++) owner.click(hits(owner)[0])
    assert.equal(owner.fieldNavigation.length, navigationCount + 4, 'Every repeated activation must focus and scroll the same recorded field')
    assert.equal(owner.requests.length, requestCount, 'Repeated focus does not need to refetch unchanged canonical detail')
    assert.equal(owner.fieldNavigation.at(-1).field, location.field)
    assert.equal(owner.fieldNavigation.at(-1).focus.preventScroll, true)
    assert(text(owner.tree).includes('记录文字命中，非适用性验证'))
    assert(!text(owner.tree).includes('条件已满足') && !text(owner.tree).includes('已掌握'))
    assert.equal(all(owner.tree, node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML')).length, 0)
    for (const button of all(owner.tree, node => node.type === 'button')) {
      assert.equal(all(button.props.children, node => node.type === 'button').length, 0, 'Hit controls cannot nest inside model buttons')
    }
    for (const model of catalogue.items) if (model.modelFieldMatches.omitted) {
      assert(text(owner.tree).includes('另有 ' + model.modelFieldMatches.omitted + ' 处命中未显示'))
    }
    if (query === 'OPERATORCATALOGUE x > 3') {
      assert.deepEqual(catalogue.items.map(model => model.nodeId), ['catalogue-split'])
      assert(text(marked(owner)[0]).includes('x > 3') && !text(marked(owner)[0]).includes('x < 3'))
    }
    for (const model of catalogue.items.slice(1)) {
      selectedLocation = model.modelFieldMatches.items[0]
      const label = '查看条件命中：' + model.nodeId + ' / ' + selectedLocation.branchId
      owner.click(hits(owner).find(node => node.props['aria-label'] === label))
      const next = owner.requests.at(-1)
      assert.equal(next.args.modelId, model.nodeId)
      assert.equal(next.args.branchId, selectedLocation.branchId)
      const response = await read(next.args)
      await owner.resolve(next, response)
      assert.equal(marked(owner).length, 1)
      assert(text(marked(owner)[0]).includes(response.structure.branches.find(branch => branch.id === selectedLocation.branchId).condition.text))
      const status = response.model.entailmentStatus === 'unverified' ? '语义未独立核验' : response.model.entailmentStatus
      assert(text(owner.tree).includes('图谱抽取表述 · ' + status), 'Field navigation cannot promote a semantic counterexample')
    }
    const state = owner.snapshots.at(-1)
    assert.equal(state.focusField, selectedLocation.field)
    owner.unmount()
    const returned = mount({ restoreState: state })
    assert.equal(returned.requests.find(item => item.args.modelId).args.branchId, selectedLocation.branchId)
    assert.equal(marked(returned).length, 0, 'History cannot restore old field evidence before canonical rereads')
    await returned.resolve(returned.requests.find(item => !item.args.modelId))
    await returned.resolve(returned.requests.find(item => item.args.modelId))
    assert.equal(marked(returned).length, 1)
    returned.unmount()
  }
  const owner = mount({ restoreState: cached('ONLYAFTERMIDNIGHT') })
  const request = owner.requests[0], result = await read(request.args)
  const invalid = structuredClone(result)
  invalid.items[0].modelFieldMatches.basis = 'verified_applicability'
  await owner.resolve(request, invalid)
  assert.equal(hits(owner).length, 0)
  owner.unmount()

  const mismatched = mount({ restoreState: cached('ONLYAFTERMIDNIGHT') })
  const altered = structuredClone(result)
  altered.items[0].modelFieldMatches.items[0].provenanceKind = 'source'
  await mismatched.resolve(mismatched.requests[0], altered)
  mismatched.click(hits(mismatched)[0]); await mismatched.resolve(mismatched.requests.at(-1))
  assert.equal(marked(mismatched).length, 0)
  assert(text(mismatched.tree).includes('命中字段未能与本次模型详情对应，请重新读取。'))
  mismatched.unmount()

  const redirected = mount({ restoreState: cached('CONFLICTBRANCHCASE') })
  await redirected.resolve(redirected.requests[0])
  redirected.click(hits(redirected)[0]); await redirected.resolve(redirected.requests.at(-1))
  assert.equal(marked(redirected).length, 1)
  redirected.props.focusRequest = { documentId: fixture.documentId, revision: 1, type: 'connection_model', nodeId: 'search-conflict-b' }
  redirected.render(); await redirected.resolve(redirected.requests.at(-1))
  assert.equal(marked(redirected).length, 0, 'A new model focus cannot inherit another model\'s field navigation intent')
  redirected.unmount()

  const raced = mount({ restoreState: cached('ONLYAFTERMIDNIGHT') })
  await raced.resolve(raced.requests[0])
  raced.click(hits(raced)[0])
  const pending = raced.requests.at(-1), oldDetail = await read(pending.args)
  raced.props.revision = 2; raced.render()
  pending.resolve(oldDetail); await raced.settle()
  assert.equal(marked(raced).length, 0)
  for (const request of raced.requests.filter(item => item.args.expectedRevision === 2)) await raced.resolve(request)
  assert.equal(marked(raced).length, 0)
  assert(text(raced.tree).includes('版本'))
  assert.equal(all(raced.tree, node => node.props['aria-label'] === '搜索联结模型')[0].props.value, 'ONLYAFTERMIDNIGHT')
  raced.unmount()

  const failed = mount({ restoreState: cached('ONLYAFTERMIDNIGHT') })
  await failed.resolve(failed.requests[0]); failed.click(hits(failed)[0])
  const detailRequest = failed.requests.at(-1), wrong = await read(detailRequest.args)
  wrong.documentId += ' '
  await failed.resolve(detailRequest, wrong)
  assert.equal(marked(failed).length, 0)
  assert(text(failed.tree).includes('模型详情版本不一致'))
  failed.unmount()
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM image_reviews').get().n, 0)
  assert.equal(modelCalls, 0)
  const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const slice = value => value.slice(value.indexOf('function connectionModelBrowseState('), value.indexOf('function ConnectionSourceUnits('))
  assert.equal(slice(source).replaceAll('host.call(', 'rpc('), slice(generated))
  assert(source.includes('padding-left: 8px; white-space: break-spaces;'), 'Preserved wrapped spaces cannot hang outside the field')
  console.log(JSON.stringify({ ok: true, actualHttpQueries: queries, canonicalNonMutating: true,
    exactBranchNavigation: true, fieldIntentRestoredNotEvidence: true, staleVersionRejected: true, modelCalls }))
} finally {
  for (const owner of owners) owner.unmount()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  harness.stop()
}
