import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelRefreshFixture } from './kg-model-refresh-fixture.mjs'
import { modelCitationLocator } from './kg-model-citation-locator-fixture.mjs'
import { modelReviewReceiver } from './kg-model-review-fixture.mjs'
import { modelWorkspacePanelSource, modelWorkspaceTabsSource, modelWorkspaceNavigationSource,
  modelWorkspacePanePropsSource, modelWorkspaceQuestionPropsSource } from './kg-model-workspace-fixture.mjs'

const fixture = modelRefreshFixture(), requests = new Set(), owners = []
let current, cursor = 0, failRead = false, cases = 0, actualHttpRequests = 0
const slot = initial => current.slots[cursor++] ||= initial()
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) { const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef: initial => slot(() => ({ current: initial })),
  useMemo(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { state.value = fn(); state.deps = deps }; return state.value },
  useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps } },
}
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// build-client adapts the Host transport name; all workspace behavior is exact.
for (const extract of [modelWorkspacePanelSource, modelWorkspaceTabsSource, modelWorkspaceNavigationSource, modelWorkspaceQuestionPropsSource]) assert.equal(extract(source).replaceAll('host.call(', 'rpc('), extract(generated))
for (const tab of ['read', 'use', 'review', 'source']) assert.equal(modelWorkspacePanePropsSource(tab, source), modelWorkspacePanePropsSource(tab, generated))
const vm = { window: { React, confirm: () => true }, console, AbortController, setTimeout: () => 1, clearTimeout() {}, sessionStorage: { getItem: () => null, setItem() {} } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), vm)
const all = (node, test) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? [] : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const harness = await modelLearningHarness({ fixture })
const server = createServer((request, response) => {
  if (failRead && request.url.endsWith('/document-load')) { failRead = false; request.resume(); response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: '隔离工作区模型审阅读取失败' } })); return }
  return harness.handler(request, response)
})
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  const post = (method, args) => {
    actualHttpRequests++
    const request = fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || 'HTTP ' + response.status); return body })
    requests.add(request); request.finally(() => requests.delete(request)).catch(() => {}); return request
  }
  const mount = async (operations = {}) => {
    const owner = { slots: [], updates: [], effects: [], tree: null }, nav = { workspaceTab: 'read', holds: [], results: [], reads: [], published: [], focuses: [], questions: [], drafts: [] }
    const opened = await post('document-load', { documentId: fixture.documentId, query: 'distance', nodeLimit: 1, includeSourceText: false })
    assert.deepEqual(opened.graph.nodes.map(node => node.id), ['distance'])
    const view = vm.window.KGViewer.makeView(opened.graph, fixture.sourceText)
    const receiver = { resultView: view, fullText: fixture.sourceText, currentResultRef: { current: view }, graphRevisionRef: { current: 1 }, graphCommitQueueRef: { current: Promise.resolve() }, paragraphLocateSeqRef: { current: 0 },
      documentIdOfGraph: graph => graph?.source?.documentId, makeView: vm.window.KGViewer.makeView, exactSourceQuoteTarget: () => { throw new Error('Not source-only') },
      setResultView: value => { nav.published.push(value); nav.pendingView = value }, setGraphQueryDraft() {}, setGraphPageDraft() {}, graphViewMetadata: () => null,
      setContentScope() {}, navigateWorkspace: tab => { nav.workspaceTab = tab }, chapterSectionsOf: () => [], setChapterFilter() {}, setSelectedNodeId() {}, setSelectedEdgeId() {},
      setFocusReq: update => nav.focuses.push(update({ seq: nav.focuses.length })), setActivePara() {}, setFlashPara() {}, ctx: { timeout: fn => fn() }, document: { getElementById: () => null }, scrollElIntoCenter() {},
      setQuestionDraft: value => nav.drafts.push(value), handleQuestionNode: value => { nav.questions.push(value); nav.workspaceTab = 'review' },
      loadGraphDocument: async args => {
        nav.reads.push(args); const hold = deferred(); nav.holds.push(hold)
        let loaded, error; try { loaded = await post('document-load', args) } catch (reason) { error = reason }
        await hold.promise; if (error) throw error; return loaded
      } }
    const extras = { h: React.createElement, ConnectionModelPanel: vm.window.KGViewer.ConnectionModelPanel, readMode: 'models',
      connectionFocus: { documentId: fixture.documentId, revision: 1, nodeId: 'taxi', type: 'connection_model' }, connectionPerspectiveRef: { current: null },
      host: { call: (method, args) => post(method, args) }, changeReadMode() {}, reviewConnectionRoles() { throw new Error('No automatic role writes') }, refreshConnectionModels() { throw new Error('No automatic refresh') }, importConnectionModels() { throw new Error('No automatic import') },
      generationTaskActive: false, verifyPhase: 'idle', questionPhase: 'idle' }
    const render = () => {
      if (nav.pendingView) { receiver.resultView = nav.pendingView; receiver.currentResultRef.current = nav.pendingView; nav.pendingView = null }
      for (let count = 0; count < 30; count++) {
        current = owner; owner.updates.splice(0).forEach(fn => fn()); cursor = 0
        const { locateConsumptionReference, ...locatorEnvironment } = receiver
        receiver.locateConsumptionReference = modelCitationLocator(locatorEnvironment)
        const environment = { ...receiver, ...extras, workspaceTab: nav.workspaceTab, reviewConnectionModel: modelReviewReceiver(receiver), ...operations }
        const panel = new Function(...Object.keys(environment), 'return ' + modelWorkspacePanelSource())(...Object.values(environment))
        const review = panel.props.onReview
        panel.props.onReview = (...args) => { const job = review(...args); nav.results.push(job); job.catch(() => {}); return job }
        owner.tree = panel.type(panel.props); owner.effects.splice(0).forEach(fn => fn())
        if (!owner.updates.length) return
      }
      throw new Error('Panel update loop')
    }
    const settle = async () => { for (let count = 0; count < 12; count++) { await Promise.allSettled([...requests]); await Promise.resolve(); render() } }
    const button = label => all(owner.tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label))[0]
    const click = async label => { const action = button(label); assert(action, label); assert(!action.props.disabled); current = owner; action.props.onClick(); await settle() }
    const select = async id => {
      const row = all(owner.tree, node => node.props['data-model-catalogue-row'] === id)[0]; assert(row, id)
      current = owner; all(row, node => node.type === 'button' && node.props.className === 'kg-model-list-item')[0].props.onClick(); await settle()
    }
    const switchWorkspace = async tab => {
      const Tabs = new Function('h', modelWorkspaceTabsSource() + ';return WorkbenchTabs')(React.createElement)
      const tabs = Tabs({ value: nav.workspaceTab, onChange: value => { nav.workspaceTab = value } })
      all(tabs, node => node.props.id === 'kg-workspace-tab-' + tab)[0].props.onClick(); await settle()
    }
    const complete = async (index = 0) => { nav.holds[index].resolve(); await Promise.allSettled([nav.results[index]]); await settle() }
    owners.push(owner); render(); await settle(); await click('核对方向')
    return { owner, nav, receiver, settle, click, button, select, switchWorkspace, complete, alerts: () => all(owner.tree, node => node.props.role === 'alert').map(text) }
  }
  const untouched = ui => { assert.equal(ui.nav.published.length, 0); assert.equal(ui.nav.focuses.length, 0); assert.equal(ui.nav.questions.length, 0); assert.equal(ui.nav.drafts.length, 0); assert.deepEqual(ui.alerts(), []) }
  for (const tab of ['review', 'use', 'source']) for (const failure of [false, true]) {
    const ui = await mount(); failRead = failure; await ui.click('审阅模型与相关关系'); await ui.switchWorkspace(tab); await ui.complete(); untouched(ui); assert.equal(ui.nav.workspaceTab, tab); cases++
  }
  for (const tab of ['review', 'use', 'source']) {
    const ui = await mount(); await ui.click('审阅模型与相关关系'); await ui.switchWorkspace(tab); await ui.switchWorkspace('read'); await ui.complete(); untouched(ui); cases++
  }
  const failedReturn = await mount(); failRead = true; await failedReturn.click('审阅模型与相关关系'); await failedReturn.switchWorkspace('review'); await failedReturn.switchWorkspace('read'); await failedReturn.complete(); untouched(failedReturn); cases++
  const queued = await mount(), queue = deferred(); queued.receiver.graphCommitQueueRef.current = queue.promise
  await queued.click('审阅模型与相关关系'); assert.equal(queued.nav.reads.length, 0); await queued.switchWorkspace('source'); queue.resolve(); await queued.settle()
  assert.equal(queued.nav.reads.length, 0); untouched(queued); cases++
  const success = await mount(); await success.click('审阅模型与相关关系'); await success.complete()
  assert.equal(success.nav.questions[0].id, 'taxi'); assert.equal(success.nav.published.length, 1); assert.equal(success.nav.workspaceTab, 'review'); assert(success.nav.drafts[0].includes('保留因素材料，不把材料冒充概念')); cases++
  const retry = await mount(); failRead = true; await retry.click('审阅模型与相关关系'); await retry.complete()
  assert(retry.alerts().some(value => value.includes('隔离工作区模型审阅读取失败'))); await retry.click('审阅模型与相关关系'); await retry.complete(1)
  assert.equal(retry.nav.questions[0].id, 'taxi'); assert.equal(retry.nav.published.length, 1); assert.equal(retry.nav.workspaceTab, 'review'); cases++
  const fresh = await mount(); await fresh.click('审阅模型与相关关系'); await fresh.switchWorkspace('use'); await fresh.switchWorkspace('read'); await fresh.complete(); untouched(fresh)
  await fresh.click('审阅模型与相关关系'); await fresh.complete(1); assert.equal(fresh.nav.questions[0].id, 'taxi'); assert.equal(fresh.nav.published.length, 1); cases++
  // A successful retry may open the persistent Review pane. Returning to the
  // actual model workspace must not expose the earlier, now recovered failure.
  await retry.switchWorkspace('read'); assert.deepEqual(retry.alerts(), [], 'Recovered model review must not keep its old failure'); cases++
  const attempt = async ui => { failRead = true; await ui.click('审阅模型与相关关系'); await ui.complete(ui.nav.holds.length - 1); assert(ui.alerts().includes('隔离工作区模型审阅读取失败')) }
  const restarting = await mount(); await attempt(restarting); await restarting.click('审阅模型与相关关系')
  assert.deepEqual(restarting.alerts(), [], 'An admitted retry clears only its previous review failure before awaiting the read')
  await restarting.complete(1); await restarting.switchWorkspace('read'); assert.deepEqual(restarting.alerts(), []); cases++
  const failedRetry = await mount(); await attempt(failedRetry); await attempt(failedRetry)
  assert.equal(failedRetry.nav.questions.length, 0); assert.deepEqual(failedRetry.alerts(), ['隔离工作区模型审阅读取失败']); cases++
  // An old callback is inadmissible, even after A -> B -> A. It cannot clear a
  // newer failure while the latest, valid callback still permits retry.
  const oldClick = failedRetry.button('审阅模型与相关关系').props.onClick
  await failedRetry.switchWorkspace('use'); await failedRetry.switchWorkspace('read'); await attempt(failedRetry)
  const readCount = failedRetry.nav.reads.length; current = failedRetry.owner; oldClick(); await failedRetry.settle()
  assert.equal(failedRetry.nav.reads.length, readCount); assert.deepEqual(failedRetry.alerts(), ['隔离工作区模型审阅读取失败']); cases++
  for (const transition of ['tab', 'model', 'workspace']) {
    const scoped = await mount(); await attempt(scoped)
    if (transition === 'tab') { await scoped.click('原文依据'); await scoped.click('核对方向') }
    else if (transition === 'model') { await scoped.select('taxi-peer'); await scoped.select('taxi'); await scoped.click('核对方向') }
    else { await scoped.switchWorkspace('source'); await scoped.switchWorkspace('read') }
    assert.deepEqual(scoped.alerts(), [], transition + ' removes only the old review failure'); cases++
  }
  const refreshFailure = '隔离模型刷新失败，重新读取尚未恢复'
  const independent = await mount({ refreshConnectionModels: async () => { throw new Error(refreshFailure) } })
  await independent.click('重新读取模型'); await attempt(independent)
  assert.deepEqual(new Set(independent.alerts()), new Set([refreshFailure, '隔离工作区模型审阅读取失败']), 'Independent failures must coexist')
  await independent.click('审阅模型与相关关系'); assert.deepEqual(independent.alerts(), [refreshFailure])
  await independent.complete(1); await independent.switchWorkspace('read'); assert.deepEqual(independent.alerts(), [refreshFailure]); cases++
  let refreshJob
  const overlapping = await mount({ refreshConnectionModels: () => { refreshJob = deferred(); return refreshJob.promise } })
  await attempt(overlapping); await overlapping.click('审阅模型与相关关系'); await overlapping.click('重新读取模型')
  refreshJob.resolve(Promise.reject(new Error(refreshFailure))); await overlapping.settle()
  assert.deepEqual(overlapping.alerts(), [refreshFailure]); await overlapping.complete(1); await overlapping.switchWorkspace('read')
  assert.deepEqual(overlapping.alerts(), [refreshFailure], 'Review completion must not clear a newer refresh failure'); cases++
  const roleFailure = '隔离方向预览失败，未保存任何修改'
  const roleUi = await mount({ reviewConnectionRoles: async () => { throw new Error(roleFailure) } })
  const roleControl = all(roleUi.owner.tree, node => node.type === 'select' && node.props['aria-label'] === '端点角色 distance')[0]
  assert(roleControl); current = roleUi.owner; roleControl.props.onChange({ target: { value: 'output' } }); await roleUi.settle()
  await roleUi.click('预览方向修改'); await attempt(roleUi)
  assert.deepEqual(new Set(roleUi.alerts()), new Set([roleFailure, '隔离工作区模型审阅读取失败']))
  await roleUi.click('审阅模型与相关关系'); assert.deepEqual(roleUi.alerts(), [roleFailure])
  await roleUi.complete(1); await roleUi.switchWorkspace('read'); assert.deepEqual(roleUi.alerts(), [roleFailure]); cases++
  let failDetail = false
  const detailFailure = '隔离模型详情读取失败，需重新读取'
  const readUi = await mount({ refreshConnectionModels: async () => true, host: { call: (method, args) => args.modelId && failDetail
    ? Promise.resolve({ error: { message: detailFailure } }) : post(method, args) } })
  await attempt(readUi); const priorReview = readUi.button('审阅模型与相关关系').props.onClick
  failDetail = true; await readUi.click('重新读取模型'); current = readUi.owner; priorReview(); await readUi.settle()
  assert.deepEqual(readUi.alerts(), [detailFailure]); assert.equal(readUi.nav.reads.length, 1, 'An invalidated review cannot erase a detail read error or start another lookup'); cases++
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  console.log(JSON.stringify({ ok: true, modelWorkspaceCancellation: true, reviewErrorRecovery: true, independentOperationErrors: true, staleCallbackCannotClearNewError: true, cases, actualHttpRequests, productionModelMountAndPanel: true,
    productionWorkspaceTabActions: true, productionLocatorAndReviewReceiver: true, actualCanonicalSqliteHttp: true, canonicalGraphAndSourceUnchanged: true, sourceUnitsUnchanged: true, learningCount: 0 }))
} finally {
  for (const owner of owners) for (const state of owner.slots) state.cleanup?.()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
