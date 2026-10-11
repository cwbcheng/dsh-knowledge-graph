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
  // A failed comparison citation is retried through the real workbench
  // receiver and canonical node-window route, without changing its evidence.
  const retryNav = navigation(), retryComparison = await open('ConnectionModelComparison', retryNav)
  await clickCitation(retryComparison)
  retryNav.pending[0].failure = '比较原文首次读取失败'
  retryNav.pending[0].resolve(); await retryNav.completed[0]; await retryComparison.settle()
  assert(text(retryComparison.owner.tree).includes('比较原文首次读取失败'))
  await clickCitation(retryComparison)
  assert.equal(retryNav.pending.length, 2)
  assert(!text(retryComparison.owner.tree).includes('比较原文首次读取失败'), 'An admitted citation retry clears only its own prior failure')
  assert(text(retryComparison.owner.tree).includes(fixture.sourceUnits[1].text))
  assert.deepEqual(retryNav.nodes, [], 'Retry waits for the actual canonical response')
  retryNav.pending[1].resolve(); await retryNav.completed[1]; await retryComparison.settle()
  assert(!text(retryComparison.owner.tree).includes('比较原文首次读取失败'))
  assert.deepEqual(retryNav.nodes, ['taxi']); assert.deepEqual(retryNav.paragraphs, [1])
  assert.deepEqual(retryNav.references[1], retryNav.references[0], 'Retry preserves complete identity, condition and quote')
  const orderedNav = navigation(), orderedComparison = await open('ConnectionModelComparison', orderedNav)
  await clickCitation(orderedComparison); await clickCitation(orderedComparison)
  orderedNav.pending[1].failure = '当前比较引文读取失败'
  orderedNav.pending[1].resolve(); await orderedNav.completed[1]; await orderedComparison.settle()
  assert(text(orderedComparison.owner.tree).includes('当前比较引文读取失败'))
  orderedNav.pending[0].resolve(); await orderedNav.completed[0]; await orderedComparison.settle()
  assert(text(orderedComparison.owner.tree).includes('当前比较引文读取失败'), 'A superseded success cannot clear the latest failure')
  assert.deepEqual(orderedNav.nodes, []); assert.deepEqual(orderedNav.changes, [])
  for (const transition of ['selection', 'inactive', 'reload']) {
    const nav = navigation(), comparison = await open('ConnectionModelComparison', nav)
    await clickCitation(comparison); nav.pending[0].failure = '上一比较范围的原文错误'
    nav.pending[0].resolve(); await nav.completed[0]; await comparison.settle()
    assert(text(comparison.owner.tree).includes('上一比较范围的原文错误'))
    if (transition === 'selection') await comparison.click('taxi-third · ', true)
    else if (transition === 'inactive') { comparison.props.active = false; await comparison.settle(); comparison.props.active = true; await comparison.settle() }
    else await comparison.click('↻')
    assert(!text(comparison.owner.tree).includes('上一比较范围的原文错误'), 'Completed source failures belong only to their active selection')
    assert(text(comparison.owner.tree).includes(fixture.sourceUnits[1].text), 'Switching error scope preserves the canonical condition and full quote')
  }
  const isolatedNav = navigation(), isolatedComparison = await open('ConnectionModelComparison', isolatedNav)
  const oldCitation = all(isolatedComparison.owner.tree, item => item.type === 'button' && text(item) === '原文 P8')[0]
  isolatedComparison.props.load = args => args.compareModelId ? Promise.resolve({ error: { message: '当前比较模型读取失败' } }) : Promise.resolve(contract.connectionModels(fixture, args))
  await isolatedComparison.click('↻')
  assert(text(isolatedComparison.owner.tree).includes('当前比较模型读取失败'))
  current = isolatedComparison.owner; oldCitation.props.onClick(); await isolatedComparison.settle()
  assert(text(isolatedComparison.owner.tree).includes('当前比较模型读取失败'), 'An obsolete source action cannot erase an independent model-read failure')
  assert.deepEqual(isolatedNav.loads, []); assert.deepEqual(isolatedNav.nodes, []); assert.deepEqual(isolatedNav.changes, [])
  // Two-step source retries preserve personal drafts and independent check
  // errors; they still use the real receiver and canonical node-window route.
  const chainRetryNav = navigation(), retryChain = await open('ConnectionModelChain', chainRetryNav)
  await retryChain.fill('具体情境', '白天、同一次行程；只是我的预测，未核验')
  await retryChain.fill('第 1 步适用条件与边界依据', '不能外推到夜间；保留原文条件')
  await retryChain.fill('第 2 步应用过程', '我的第二步推测仍须核对')
  const retryKey = 'dsh-kg-model-chain:' + JSON.stringify([fixture.documentId, 'taxi'])
  const retryDraft = retryChain.owner.storage.get(retryKey)
  await clickCitation(retryChain); chainRetryNav.pending[0].failure = '两步原文首次读取失败'
  chainRetryNav.pending[0].resolve(); await chainRetryNav.completed[0]; await retryChain.settle()
  assert(text(retryChain.owner.tree).includes('两步原文首次读取失败'))
  await clickCitation(retryChain)
  assert(!text(retryChain.owner.tree).includes('两步原文首次读取失败'), 'An admitted chain retry clears its own prior source failure')
  assert.deepEqual(chainRetryNav.nodes, [], 'Source retry waits for the actual canonical response')
  assert.equal(retryChain.owner.storage.get(retryKey), retryDraft)
  chainRetryNav.pending[1].resolve(); await chainRetryNav.completed[1]; await retryChain.settle()
  assert(!text(retryChain.owner.tree).includes('两步原文首次读取失败'))
  assert.deepEqual(chainRetryNav.nodes, ['taxi-peer']); assert.deepEqual(chainRetryNav.paragraphs, [1])
  assert.deepEqual(chainRetryNav.references[1], chainRetryNav.references[0])
  assert.equal(chainRetryNav.references[1].quote, fixture.sourceUnits[1].text)
  assert.equal(retryChain.owner.storage.get(retryKey), retryDraft, 'Full source identity and evidence do not mutate a personal draft')
  const checkNav = navigation(), checkChain = await open('ConnectionModelChain', checkNav)
  checkChain.props.load = args => args.chainDraft ? Promise.resolve({ error: { message: '当前推测检查失败' } }) : Promise.resolve(contract.connectionModels(fixture, args))
  await checkChain.settle()
  await checkChain.click('检查推测缺口'); assert(text(checkChain.owner.tree).includes('当前推测检查失败'))
  await clickCitation(checkChain); checkNav.pending[0].failure = '当前两步原文读取失败'
  checkNav.pending[0].resolve(); await checkNav.completed[0]; await checkChain.settle()
  assert(text(checkChain.owner.tree).includes('当前推测检查失败'), 'A source failure cannot overwrite a check failure')
  assert(text(checkChain.owner.tree).includes('当前两步原文读取失败'))
  await clickCitation(checkChain)
  assert(text(checkChain.owner.tree).includes('当前推测检查失败'), 'Source retry clears only its own error')
  assert(!text(checkChain.owner.tree).includes('当前两步原文读取失败'))
  checkNav.pending[1].resolve(); await checkNav.completed[1]; await checkChain.settle()
  assert(text(checkChain.owner.tree).includes('当前推测检查失败'), 'Source success is not successful draft checking')
  const sourceNav = navigation(), sourceChain = await open('ConnectionModelChain', sourceNav)
  await clickCitation(sourceChain); sourceNav.pending[0].failure = '尚未恢复的两步来源错误'
  sourceNav.pending[0].resolve(); await sourceNav.completed[0]; await sourceChain.settle()
  await sourceChain.click('检查推测缺口')
  assert(text(sourceChain.owner.tree).includes('尚未恢复的两步来源错误'), 'Draft checking does not erase an unresolved source error')
  const orderedChainNav = navigation(), orderedChain = await open('ConnectionModelChain', orderedChainNav)
  await clickCitation(orderedChain); await clickCitation(orderedChain)
  orderedChainNav.pending[1].failure = '最新两步引文读取失败'
  orderedChainNav.pending[1].resolve(); await orderedChainNav.completed[1]; await orderedChain.settle()
  orderedChainNav.pending[0].resolve(); await orderedChainNav.completed[0]; await orderedChain.settle()
  assert(text(orderedChain.owner.tree).includes('最新两步引文读取失败'), 'An older successful source load cannot clear a newer failure')
  assert.deepEqual(orderedChainNav.nodes, []); assert.deepEqual(orderedChainNav.changes, [])
  for (const transition of ['selection', 'inactive', 'reload', 'first-branch', 'second-branch', 'branch-back-to-same']) {
    const nav = navigation(), chain = await open('ConnectionModelChain', nav)
    await clickCitation(chain); nav.pending[0].failure = '上一两步来源范围的错误'
    nav.pending[0].resolve(); await nav.completed[0]; await chain.settle()
    assert(text(chain.owner.tree).includes('上一两步来源范围的错误'))
    if (transition === 'selection') await chain.click('taxi-third · ', true)
    else if (transition === 'inactive') { chain.props.active = false; await chain.settle(); chain.props.active = true; await chain.settle() }
    else if (transition === 'reload') await chain.click('↻')
    else { const label = transition === 'first-branch' ? '第 1 步分支' : '第 2 步分支'; await chain.fill(label, 'base'); if (transition === 'branch-back-to-same') await chain.fill(label, '') }
    assert(!text(chain.owner.tree).includes('上一两步来源范围的错误'), 'Completed source errors belong only to the current two-step selection')
    assert(text(chain.owner.tree).includes(fixture.sourceUnits[1].text))
  }
  const callbackNav = navigation(), callbackChain = await open('ConnectionModelChain', callbackNav)
  const oldChainCitation = all(callbackChain.owner.tree, item => item.type === 'button' && text(item) === '原文 P8')[0]
  await callbackChain.fill('第 1 步分支', 'base')
  await clickCitation(callbackChain); callbackNav.pending[0].failure = '当前分支引文读取失败'
  callbackNav.pending[0].resolve(); await callbackNav.completed[0]; await callbackChain.settle()
  current = callbackChain.owner; oldChainCitation.props.onClick(); await callbackChain.settle()
  assert(text(callbackChain.owner.tree).includes('当前分支引文读取失败'), 'An obsolete source callback cannot erase a current source error')
  assert.equal(callbackNav.loads.length, 1); assert.deepEqual(callbackNav.changes, [])
  const pairNav = navigation(), pairChain = await open('ConnectionModelChain', pairNav)
  const oldPairCitation = all(pairChain.owner.tree, item => item.type === 'button' && text(item) === '原文 P8')[0]
  pairChain.props.load = args => args.compareModelId ? Promise.resolve({ error: { message: '当前两步模型读取失败' } }) : Promise.resolve(contract.connectionModels(fixture, args))
  await pairChain.click('↻'); assert(text(pairChain.owner.tree).includes('当前两步模型读取失败'))
  current = pairChain.owner; oldPairCitation.props.onClick(); await pairChain.settle()
  assert(text(pairChain.owner.tree).includes('当前两步模型读取失败'))
  assert.deepEqual(pairNav.loads, []); assert.deepEqual(pairNav.changes, [])
  // Personal draft edits cannot recover a missing model pair. Keep the read
  // failure separate from validation, export and obsolete checking results.
  const readChain = await open('ConnectionModelChain', navigation())
  await readChain.fill('具体情境', '白天、同一次行程；只是我的预测，未核验')
  await readChain.fill('推测目标', '核对条件后推测，不表示已经成立')
  await readChain.fill('第 1 步适用条件与边界依据', '不能外推到夜间；保留原文条件')
  await readChain.fill('第 2 步应用过程', '我的第二步推测仍须核对')
  const readKey = 'dsh-kg-model-chain:' + JSON.stringify([fixture.documentId, 'taxi'])
  const readBefore = JSON.parse(readChain.owner.storage.get(readKey))
  readChain.props.load = args => Promise.resolve(args.compareModelId
    ? { error: { message: '尚未恢复的两步模型读取错误' } } : contract.connectionModels(fixture, args))
  await readChain.click('↻')
  assert(text(readChain.owner.tree).includes('尚未恢复的两步模型读取错误'))
  const checkingDisabled = ui => all(ui.owner.tree, item => item.type === 'button' && text(item) === '检查推测缺口')[0].props.disabled
  assert(checkingDisabled(readChain)); assert(!text(readChain.owner.tree).includes('第 2 步 · taxi-peer'))
  for (const [label, value] of [['具体情境', '白天、同一次行程；补充个人文字，未核验'], ['推测目标', '我的推测目标仍须核对']]) {
    await readChain.fill(label, value)
    assert(text(readChain.owner.tree).includes('尚未恢复的两步模型读取错误'), 'Personal text is not recovery of the model read')
    assert(checkingDisabled(readChain))
    const after = JSON.parse(readChain.owner.storage.get(readKey))
    assert.deepEqual(after.draft.steps, readBefore.draft.steps); assert.equal(after.peerId, readBefore.peerId); assert.equal(after.revision, readBefore.revision)
  }
  const edited = readChain.owner.storage.get(readKey)
  await readChain.fill('具体情境', 'x'.repeat(2100))
  assert(text(readChain.owner.tree).includes('本次输入未覆盖原草稿'))
  assert(text(readChain.owner.tree).includes('尚未恢复的两步模型读取错误'), 'Validation failure cannot overwrite a model-read failure')
  assert.equal(readChain.owner.storage.get(readKey), edited)
  await readChain.fill('具体情境', '合法补充，但模型仍未读取')
  assert(!text(readChain.owner.tree).includes('本次输入未覆盖原草稿')); assert(text(readChain.owner.tree).includes('尚未恢复的两步模型读取错误'))
  await readChain.click('导出推测草稿')
  assert(text(readChain.owner.tree).includes('页面文字仍保留')); assert(text(readChain.owner.tree).includes('尚未恢复的两步模型读取错误'))
  await readChain.fill('推测目标', '导出未恢复模型；继续保留自己的目标')
  assert(!text(readChain.owner.tree).includes('页面文字仍保留')); assert(text(readChain.owner.tree).includes('尚未恢复的两步模型读取错误'))
  const recovery = deferred(), recoveryDraft = readChain.owner.storage.get(readKey)
  readChain.props.load = args => args.compareModelId ? recovery.promise : Promise.resolve(contract.connectionModels(fixture, args))
  await readChain.click('↻')
  assert(!text(readChain.owner.tree).includes('尚未恢复的两步模型读取错误'), 'An admitted model reload clears its own previous error')
  assert(text(readChain.owner.tree).includes('正在读取两步模型')); assert(checkingDisabled(readChain)); assert.equal(readChain.owner.storage.get(readKey), recoveryDraft)
  recovery.resolve(contract.connectionModels(fixture, { documentId: fixture.documentId, expectedRevision: 1, modelId: 'taxi', compareModelId: 'taxi-peer' }))
  await readChain.settle(); assert(!checkingDisabled(readChain)); assert(text(readChain.owner.tree).includes('第 2 步 · taxi-peer'))
  assert.equal(readChain.owner.storage.get(readKey), recoveryDraft, 'Recovery does not overwrite conditions, evidence or personal steps')
  readChain.props.load = args => Promise.resolve(args.chainDraft ? { error: { message: '当前检查失败，须随文字编辑失效' } } : contract.connectionModels(fixture, args))
  await readChain.settle(); await readChain.click('检查推测缺口'); assert(text(readChain.owner.tree).includes('当前检查失败，须随文字编辑失效'))
  await readChain.fill('具体情境', '新文字使旧检查失效，不能当作验证成功')
  assert(!text(readChain.owner.tree).includes('当前检查失败，须随文字编辑失效')); assert(!checkingDisabled(readChain))
  let chainPairRaceCases = 0
  for (const transition of ['reload', 'selection', 'back-to-same', 'inactive', 'revision']) for (const failure of [false, true]) {
    const ui = await open('ConnectionModelChain', navigation()), pending = deferred(); let first = true
    ui.props.load = args => {
      if (!args.compareModelId) return Promise.resolve(contract.connectionModels(fixture, args))
      if (first) { first = false; return pending.promise }
      return Promise.resolve({ error: { message: '当前选择的模型读取失败' } })
    }
    await ui.click('↻')
    if (transition === 'reload') await ui.click('↻')
    else if (transition === 'selection' || transition === 'back-to-same') { await ui.click('taxi-third · ', true); if (transition === 'back-to-same') await ui.click('taxi-peer · ', true) }
    else if (transition === 'inactive') { ui.props.active = false; await ui.settle(); assert(!text(ui.owner.tree).includes('当前选择的模型读取失败')); ui.props.active = true; await ui.settle() }
    else { ui.props.revision = 2; await ui.settle() }
    assert(text(ui.owner.tree).includes('当前选择的模型读取失败'))
    pending.resolve(failure ? { error: { message: '过期模型读取失败' } }
      : contract.connectionModels(fixture, { documentId: fixture.documentId, expectedRevision: 1, modelId: 'taxi', compareModelId: 'taxi-peer' }))
    await ui.settle()
    assert(text(ui.owner.tree).includes('当前选择的模型读取失败'), 'An obsolete success or failure cannot clear or replace the current pair-read error')
    assert(!text(ui.owner.tree).includes('过期模型读取失败')); assert(checkingDisabled(ui)); assert(!text(ui.owner.tree).includes('第 2 步 · taxi-peer'))
    chainPairRaceCases++
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
  console.log(JSON.stringify({ ok: true, cancelledCases, newerClickWins: true, currentFailuresVisible: true, comparisonSourceRetry: true, comparisonErrorOwnership: true,
    chainSourceRetry: true, chainErrorOwnership: true, chainPersonalDraftPreserved: true,
    chainPairReadErrorOwnership: true, chainPairDraftPreserved: true, chainPairRaceCases,
    productionComponents: true, productionWorkbenchReceiver: true, actualNodeWindowRoute: true,
    originalIdentityAndFullQuote: true, lateFailuresQuiet: true, readOnly: true }))
} finally { for (const owner of owners) for (const state of owner.slots) state.cleanup?.(); harness.stop() }
