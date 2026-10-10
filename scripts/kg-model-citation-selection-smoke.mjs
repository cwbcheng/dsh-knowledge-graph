import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelCitationFixture, modelCitationLocator, modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'

// Real generated components and the workbench receiver; delay an actual node
// window response while changing a model, comparison, or two-step selection.
const fixture = modelCitationFixture({ third: true }), contract = createGraphContract()
const harness = await modelLearningHarness({ fixture })
const canonical = harness.store.getDocument(fixture.documentId), before = JSON.stringify(canonical)
const unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
let current, cursor = 0
const slot = initial => { const index = cursor++; return current.slots[index] ||= initial() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) { const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef: initial => slot(() => ({ current: initial })),
  useMemo(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { state.value = fn(); state.deps = deps }; return state.value },
  useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
    current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
  } },
}
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
for (const file of ['../lib/client.js', '../extension/viewer.js']) {
  const generated = readFileSync(new URL(file, import.meta.url), 'utf8')
  const start = value => value.indexOf('function useConnectionModelLocation('), end = value => value.indexOf('const MODEL_FEEDBACK_TYPES')
  assert.equal(source.slice(start(source), end(source)), generated.slice(start(generated), end(generated)))
}
assert.equal(modelCitationPanelLocationSource(source), modelCitationPanelLocationSource(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')))
let confirmed = true
const environment = { window: { React, confirm: () => confirmed }, console, AbortController, setTimeout: () => 1, clearTimeout() {},
  sessionStorage: { getItem: key => current.storage.get(key), setItem: (key, value) => current.storage.set(key, value) },
  documentIdOfGraph: graph => graph?.source?.documentId }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), environment)
runInNewContext(source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel(')) + '\nthis.target=exactSourceQuoteTarget', environment)
const makeView = environment.window.KGViewer.makeView, outside = makeView({ ...canonical, nodes: [], edges: [] }, fixture.sourceText)
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const owners = []
const mount = (name, extra = {}) => {
  const owner = { slots: [], effects: [], updates: [], tree: null, storage: new Map() }, Component = environment.window.KGViewer[name]
  let mounted = true
  const props = { documentId: fixture.documentId, revision: 1, modelId: 'taxi', active: true,
    focusRequest: { documentId: fixture.documentId, revision: 1, nodeId: 'taxi', type: 'connection_model' },
    load: args => Promise.resolve(contract.connectionModels(fixture, args)), ...extra }
  const render = () => {
    for (let count = 0; count < 30; count++) {
      current = owner; owner.updates.splice(0).forEach(fn => fn()); cursor = 0
      owner.tree = Component(props); owner.effects.splice(0).forEach(fn => fn()); if (!owner.updates.length) return
    }
    throw new Error('Component update loop')
  }
  const settle = async () => { for (let count = 0; count < 16; count++) { current = owner; await Promise.resolve(); if (mounted) render() } }
  const click = async (label, includes = false, root = owner.tree) => {
    current = owner
    const button = all(root, item => item.type === 'button' && (includes ? text(item).includes(label) : text(item) === label))[0]
    assert(button, 'Missing ' + label); assert(!button.props.disabled); button.props.onClick(); await settle()
  }
  const unmount = () => { mounted = false; for (const state of owner.slots) state.cleanup?.() }
  const selectModel = async id => {
    const row = all(owner.tree, item => item.props['data-model-catalogue-row'] === id)[0]
    assert(row, 'Missing catalogue model ' + id)
    const button = all(row, item => item.type === 'button' && item.props.className === 'kg-model-list-item')[0]
    current = owner; button.props.onClick(); await settle()
  }
  const fill = async (label, value) => {
    current = owner
    const field = all(owner.tree, item => item.props['aria-label'] === label && ['textarea', 'select'].includes(item.type))[0]
    assert(field, 'Missing ' + label); field.props.onChange({ target: { value } }); await settle()
  }
  owners.push(owner); render(); return { owner, props, render, settle, click, fill, selectModel, unmount }
}
const navigation = () => {
  const loads = [], changes = [], nodes = [], paragraphs = [], pending = [], references = [], completed = []
  const env = { resultView: outside, fullText: fixture.sourceText, currentResultRef: { current: outside },
    paragraphLocateSeqRef: { current: 0 }, graphRevisionRef: { current: 1 }, graphCommitQueueRef: { current: Promise.resolve() },
    documentIdOfGraph: environment.documentIdOfGraph, exactSourceQuoteTarget: environment.target, makeView,
    loadGraphDocument: async args => { const wait = deferred(); loads.push(args); pending.push(wait); await wait.promise;
      return wait.failure ? { error: { message: wait.failure } } : harness.post(args, 'document-load') },
    setResultView: value => changes.push(value), setContentScope: value => changes.push(value), navigateWorkspace: value => changes.push(value),
    setChapterFilter: value => changes.push(value), chapterSectionsOf: graph => graph.source.sections || [], graphViewMetadata: () => null,
    setGraphQueryDraft() {}, setGraphPageDraft() {}, setSelectedNodeId: value => nodes.push(value), setSelectedEdgeId() {}, setFocusReq: update => update({ seq: 0 }),
    setActivePara: value => paragraphs.push(value), setFlashPara() {}, ctx: { timeout: fn => fn() },
    document: { getElementById: id => ({ id }) }, scrollElIntoCenter() {} }
  env.locateConsumptionReference = modelCitationLocator(env)
  env.changeReadMode = value => changes.push('read-mode:' + value)
  const receiver = new Function(...Object.keys(env), 'return ' + modelCitationPanelLocationSource())(...Object.values(env))
  return { env, loads, changes, nodes, paragraphs, pending, references, completed,
    locate: (reference, stillCurrent = () => true) => {
      references.push(reference)
      const result = receiver(reference, stillCurrent)
      completed.push(result.then(() => true, () => false)); return result
    } }
}
const open = async (name, nav) => {
  const ui = mount(name, { onLocate: nav.locate }); await ui.settle()
  if (name === 'ConnectionModelPanel') await ui.click('原文依据')
  else {
    if (name === 'ConnectionModelChain') await ui.click('查看全部第 2 步模型')
    await ui.click('taxi-peer · ', true)
  }
  return ui
}
const clickCitation = async ui => {
  current = ui.owner
  const root = all(ui.owner.tree, item => item.props.className === 'kg-model-source'
    || item.props['aria-label'] === '模型 A · 联结表述与适用条件' || item.props['aria-label'] === '第 2 步')[0] || ui.owner.tree
  const button = all(root, item => item.type === 'button' && text(item) === '原文 P8')[0]
  assert(button); button.props.onClick(); await ui.settle()
}
let cancelledCases = 0
try {
  for (const name of ['ConnectionModelChain', 'ConnectionModelPanel', 'ConnectionModelComparison']) {
    const transitions = ['selection', 'back-to-same', 'inactive', 'revision', 'document', 'unmount', 'tab-or-reload', 'external-focus']
    if (name === 'ConnectionModelChain') transitions.push('first-branch', 'second-branch', 'branch-back-to-same')
    for (const transition of transitions) {
      for (const failure of [false, true]) {
        const nav = navigation(), ui = await open(name, nav)
        await clickCitation(ui); assert.equal(nav.pending.length, 1)
        const reference = nav.references[0]
        assert.equal(reference.documentId, fixture.documentId); assert.equal(reference.revision, 1)
        assert.equal(reference.paragraph, 7); assert.equal(reference.quote, fixture.sourceUnits[1].text)
        assert.equal(reference.sourceId, 'sparse-model-source'); assert.equal(reference.nodeId, name === 'ConnectionModelChain' ? 'taxi-peer' : 'taxi')
        assert.equal(reference.sourceQuoteOnly, true); assert.equal(reference.sourceCitation, true)
        if (['selection', 'back-to-same'].includes(transition)) {
          if (name === 'ConnectionModelPanel') await ui.selectModel('taxi-peer')
          else await ui.click('taxi-third · ', true)
          if (transition === 'back-to-same') {
            if (name === 'ConnectionModelPanel') await ui.selectModel('taxi')
            else await ui.click('taxi-peer · ', true)
          }
        } else if (transition === 'inactive') { ui.props.active = false; await ui.settle(); ui.props.active = true; await ui.settle() }
        else if (transition === 'revision') { ui.props.revision = 2; await ui.settle() }
        else if (transition === 'document') { ui.props.documentId = 'another-document'; await ui.settle() }
        else if (transition === 'unmount') ui.unmount()
        else if (transition === 'external-focus') {
          if (name === 'ConnectionModelPanel') ui.props.focusRequest = { documentId: fixture.documentId, revision: 1, nodeId: 'taxi-third', type: 'connection_model' }
          else ui.props.modelId = 'taxi-third'
          await ui.settle()
        }
        else if (transition.includes('branch')) {
          const label = transition === 'first-branch' ? '第 1 步分支' : '第 2 步分支'
          await ui.fill(label, 'base')
          if (transition === 'branch-back-to-same') await ui.fill(label, '')
        }
        else if (name === 'ConnectionModelPanel') await ui.click('下上对照')
        else await ui.click('↻')
        if (failure) nav.pending[0].failure = '旧请求的窗口读取失败'
        nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
        assert.deepEqual(nav.nodes, [], name + ' ' + transition + ' must not focus an old node')
        assert.deepEqual(nav.paragraphs, []); assert.deepEqual(nav.changes, [])
        assert(!text(ui.owner.tree).includes('旧请求的窗口读取失败'), 'Old failures do not leak into the new selection')
        assert(!text(ui.owner.tree).includes('旧定位已取消'), 'Switching intentionally is quiet')
        cancelledCases++
      }
    }
  }
  // Keep a child callback alive while its real parent changes. The
  // parent and child predicates must compose, without leaking a child error.
  for (const name of ['ConnectionModelComparison', 'ConnectionModelChain']) for (const failure of [false, true]) {
    const nav = navigation(), parent = await open('ConnectionModelPanel', nav)
    await parent.click(name === 'ConnectionModelChain' ? '两步推测' : '模型比较')
    const childProps = all(parent.owner.tree, item => item.type === environment.window.KGViewer[name])[0]?.props
    assert(childProps)
    const child = mount(name, childProps); await child.settle()
    if (name === 'ConnectionModelChain') await child.click('查看全部第 2 步模型')
    await child.click('taxi-peer · ', true)
    await clickCitation(child); assert.equal(nav.pending.length, 1)
    await parent.selectModel('taxi-third')
    if (failure) nav.pending[0].failure = '旧比较请求的窗口读取失败'
    nav.pending[0].resolve(); await nav.completed[0]; await child.settle(); await parent.settle()
    assert.deepEqual(nav.nodes, []); assert.deepEqual(nav.changes, [])
    assert(!text(child.owner.tree).includes('旧比较请求')); assert(!text(parent.owner.tree).includes('旧比较请求'))
    cancelledCases++
  }
  // A newer click wins; its canonical identity and full quote stay intact.
  const nav = navigation(), ui = await open('ConnectionModelPanel', nav)
  await clickCitation(ui); await clickCitation(ui); assert.equal(nav.pending.length, 2)
  nav.pending[1].resolve(); await nav.completed[1]; await ui.settle()
  nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
  assert.deepEqual(nav.nodes, ['taxi']); assert.deepEqual(nav.paragraphs, [1])
  assert.equal(nav.changes.filter(value => value === 'read-mode:graph').length, 1)
  for (const name of ['ConnectionModelPanel', 'ConnectionModelComparison', 'ConnectionModelChain']) {
    const nav = navigation(), ui = await open(name, nav)
    await clickCitation(ui); nav.pending[0].failure = '当前窗口读取失败，请重试'; nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
    assert(text(ui.owner.tree).includes('当前窗口读取失败，请重试'), 'A current failure remains visible')
    assert(text(ui.owner.tree).includes(fixture.sourceUnits[1].text), 'A failed lookup keeps the full evidence')
    assert.deepEqual(nav.changes, []); assert.deepEqual(nav.nodes, [])
  }
  // Declining the existing replacement confirmation keeps the selection,
  // both steps and scenario; accepting clears only step two and cancels it.
  const chainNav = navigation(), chain = await open('ConnectionModelChain', chainNav)
  await chain.fill('具体情境', '白天、同一次行程；无附加收费，未独立验证')
  await chain.fill('第 1 步适用条件与边界依据', '不能外推到夜间')
  await chain.fill('第 2 步应用过程', '我的推测文字仍须核对')
  const key = 'dsh-kg-model-chain:' + JSON.stringify([fixture.documentId, 'taxi'])
  const cached = chain.owner.storage.get(key)
  await clickCitation(chain); confirmed = false; await chain.click('taxi-third · ', true)
  assert.equal(chain.owner.storage.get(key), cached)
  chainNav.pending[0].resolve(); await chainNav.completed[0]; await chain.settle()
  assert.deepEqual(chainNav.nodes, ['taxi-peer']); assert.deepEqual(chainNav.paragraphs, [1])
  await clickCitation(chain); confirmed = true; await chain.click('taxi-third · ', true)
  chainNav.pending[1].resolve(); await chainNav.completed[1]; await chain.settle()
  assert.deepEqual(chainNav.nodes, ['taxi-peer'], 'Accepted replacement discards the old navigation')
  const replaced = JSON.parse(chain.owner.storage.get(key)), original = JSON.parse(cached)
  assert.deepEqual(replaced.draft.steps[0], original.draft.steps[0]); assert.equal(replaced.draft.scenario, original.draft.scenario)
  assert.equal(replaced.draft.steps[1].modelId, 'taxi-third'); assert.equal(replaced.draft.steps[1].reasoning, '')
  // The same latest-click fence applies inside the two-step panel.
  const latest = navigation(), latestChain = await open('ConnectionModelChain', latest)
  await clickCitation(latestChain); await clickCitation(latestChain)
  latest.pending[1].resolve(); await latest.completed[1]; await latestChain.settle()
  latest.pending[0].resolve(); await latest.completed[0]; await latestChain.settle()
  assert.deepEqual(latest.nodes, ['taxi-peer']); assert.deepEqual(latest.paragraphs, [1])
  assert.equal(latest.changes.filter(value => value === 'read-mode:graph').length, 1)
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  console.log(JSON.stringify({ ok: true, cancelledCases, newerClickWins: true, currentFailuresVisible: true,
    productionComponents: true, productionWorkbenchReceiver: true, actualNodeWindowRoute: true,
    originalIdentityAndFullQuote: true, lateFailuresQuiet: true, readOnly: true }))
} finally { for (const owner of owners) for (const state of owner.slots) state.cleanup?.(); harness.stop() }
