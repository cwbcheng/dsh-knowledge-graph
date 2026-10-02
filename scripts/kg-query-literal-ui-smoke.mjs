import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { queryLiteralFixture, literalCatalogueCases } from './kg-query-literal-fixture-data.mjs'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const extract = value => {
  const start = value.indexOf('function renderLiteralQueryText('), end = value.indexOf('function connectionModelBrowseState(', start)
  assert(start >= 0 && end > start, 'Selected model fields must expose literal query fragments, not only mark the field label')
  return value.slice(start, end)
}
assert.equal(extract(source), extract(generated)); assert.equal(extract(source), extract(viewer))
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
  : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
const marks = node => all(node, item => item.type === 'mark' && item.props.className === 'kg-query-literal-hit')
const helper = { h }
runInNewContext(extract(source) + '\nthis.render=renderLiteralQueryText', helper)
const cases = [
  ['aba ababa', 'aba', 2], ['aaaa', 'aa', 2], ['x > 3 and x < 3', 'x > 3', 1],
  ['only at t0, not at t1', 'at t0', 1], ['[a-z].* [a-z].*', '[a-z].*', 2],
  ['<img src=x onerror=attack()>', '<img', 1], ['\u4e59\u4e59', '\u4e59', 2],
  ['e\u0301 \ud83d\udc69\ud83c\udffd\u200d\ud83d\ude80', 'e', 0], ['e\u0301', 'e\u0301', 1],
  ['\ud83d\udc69\ud83c\udffd\u200d\ud83d\ude80', '\ud83d\udc69', 0], ['\ud83d\ude80', '\ud83d', 0],
  ['\uff21', 'A', 0], ['ABC', 'abc', 0], ['a\tb', 'a b', 0],
  ['needle needle', ' needle ', 2], ['plain', '', 0], ['plain', '   ', 0],
  ['a'.repeat(201), 'a'.repeat(201), 0], ['a'.repeat(2001), 'a', 0], ['x'.repeat(1000), 'x', 32],
]
for (const [value, query, expected] of cases) {
  const rendered = helper.render(value, query)
  assert.equal(text(rendered), value, 'Markup must preserve every original character')
  assert.equal(marks(rendered).length, expected)
  assert(marks(rendered).every(item => text(item) === query.trim()))
  assert.equal(all(rendered, item => Object.hasOwn(item.props, 'dangerouslySetInnerHTML')).length, 0)
}
const fallback = { h, Intl: {} }
runInNewContext(extract(source) + '\nthis.render=renderLiteralQueryText', fallback)
assert.equal(fallback.render('needle', 'needle'), 'needle', 'Missing grapheme support must preserve readable text')

const fixture = queryLiteralFixture()
let modelCalls = 0, queries = 0, current, cursor = 0, timerId = 0
const timers = new Map(), owners = []
const harness = await modelLearningHarness({ fixture, llm: { async createMessage() { modelCalls++; throw new Error('No real model calls') } } })
const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
const server = createServer(harness.handler)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = { createElement: h, useRef: initial => slot(() => ({ current: initial })),
  useState(initial) { const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useEffect(fn, deps) { const owner = current, state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    } },
}
const environment = { window: { React, confirm: () => true }, AbortController, console,
  setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
runInNewContext(viewer, environment)
const read = async args => {
  queries++
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
  assert.equal(response.status, 200); return response.json()
}
const mount = restoreState => {
  const owner = { slots: [], effects: [], updates: [], requests: [], snapshots: [] }
  owner.props = { documentId: fixture.documentId, revision: 1, restoreState,
    load: (args, signal) => new Promise(resolve => owner.requests.push({ args, signal, resolve })),
    onStateChange: state => owner.snapshots.push(state) }
  owner.render = () => { for (let index = 0; index < 20; index++) {
    owner.updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
    owner.tree = environment.window.KGViewer.ConnectionModelPanel(owner.props)
    owner.effects.splice(0).forEach(fn => fn()); if (!owner.updates.length) return
  } throw new Error('Update loop') }
  owner.settle = async () => { for (let index = 0; index < 6; index++) { await Promise.resolve(); owner.render() } }
  owner.resolve = async (request, result) => { request.resolve(result || await read(request.args)); await owner.settle() }
  owner.click = control => { assert(control && !control.props.disabled); control.props.onClick(); owner.render() }
  owner.unmount = () => { for (const state of owner.slots) state.cleanup?.() }
  owners.push(owner); owner.render(); return owner
}
try {
  for (const item of literalCatalogueCases) {
    const owner = mount({ documentId: fixture.documentId, revision: 1, query: item.query, search: item.query })
    const page = await read(owner.requests[0].args); assert(!page.error)
    await owner.resolve(owner.requests[0], page)
    const model = page.items.find(model => model.nodeId === item.modelId)
    assert(model, JSON.stringify(item))
    const location = model.modelFieldMatches.items[0]
    const control = all(owner.tree, node => node.type === 'button' && node.props.className === 'kg-model-field-link')
      .find(node => node.props['aria-label'].endsWith(item.modelId + ' / ' + location.branchId))
    owner.click(control)
    const request = owner.requests.at(-1), detail = await read(request.args)
    assert(!detail.error); await owner.resolve(request, detail)
    const field = all(owner.tree, node => node.props['data-model-field-hit'])[0]
    const raw = detail.structure.branches.find(branch => branch.id === location.branchId)[location.field].text
    assert(field && text(field).endsWith(raw))
    assert.equal(marks(field).length, item.marks, JSON.stringify(item))
    assert(marks(field).every(mark => text(mark) === item.query))
    assert.equal(all(owner.tree, node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML')).length, 0)
    if (item.modelId.startsWith('literal-')) assert(text(owner.tree).includes('unsupported'))
    const restored = mount(owner.snapshots.at(-1))
    assert.equal(marks(restored.tree).length, 0, 'Cached intent is not current field evidence')
    await restored.resolve(restored.requests.find(request => !request.args.modelId))
    await restored.resolve(restored.requests.find(request => request.args.modelId))
    assert.equal(marks(restored.tree).length, item.marks)
    restored.unmount()
    const search = all(owner.tree, node => node.props['aria-label'] === '搜索联结模型')[0]
    search.props.onChange({ target: { value: 'pending new query' } }); owner.render()
    assert.equal(marks(owner.tree).length, 0, 'Unsubmitted input must not relabel old field matches')
    owner.unmount()
  }
  const owner = mount({ documentId: fixture.documentId, revision: 1, query: 'OPERATORLITERAL x > 3', search: 'OPERATORLITERAL x > 3' })
  const page = await read(owner.requests[0].args); await owner.resolve(owner.requests[0], page)
  assert.deepEqual(page.items.map(item => item.nodeId), ['literal-operator-a'])
  const composed = await read({ documentId: fixture.documentId, expectedRevision: 1, query: 'GRAPHEMELITERAL e' })
  assert(!composed.error); assert.deepEqual(composed.items, [], 'Catalogue NFKC composition is not literal substring matching')
  owner.click(all(owner.tree, node => node.props.className === 'kg-model-field-link')[0])
  const pending = owner.requests.at(-1), old = await read(pending.args)
  owner.props.revision = 2; owner.render(); pending.resolve(old); await owner.settle()
  assert.equal(marks(owner.tree).length, 0)
  for (const request of owner.requests.filter(request => request.args.expectedRevision === 2)) await owner.resolve(request)
  assert.equal(marks(owner.tree).length, 0); assert(text(owner.tree).includes('版本'))
  owner.unmount()
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM image_reviews').get().n, 0)
  assert.equal(modelCalls, 0)
  console.log(JSON.stringify({ ok: true, actualHttpQueries: queries, literalCases: cases.length, catalogueCases: literalCatalogueCases.length,
    exactCharactersRetained: true, graphemesNotSplit: true, oppositeOperatorNotHighlighted: true, normalizedNotLiteral: true,
    boundedMarks: 32, unsubmittedQueryWithdrawsMarks: true, historyRequiresCanonicalRead: true, staleVersionRejected: true,
    noRawHtml: true, nonMutating: true, noTruthPromotion: true, modelCalls }))
} finally {
  for (const owner of owners) owner.unmount()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
