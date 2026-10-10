import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelRefreshFixture } from './kg-model-refresh-fixture.mjs'
import { modelCitationLocator } from './kg-model-citation-locator-fixture.mjs'
import { modelReviewReceiver, modelReviewSource } from './kg-model-review-fixture.mjs'

const fixture = modelRefreshFixture()
const requests = new Set(), owners = []
let current, cursor = 0, cases = 0, actualHttpRequests = 0, failRead = false
const server = createServer((request, response) => {
  if (failRead && request.url.endsWith('/document-load')) {
    failRead = false; request.resume(); response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: '隔离模型审阅读取失败' } })); return
  }
  return harness.handler(request, response)
})
const slot = initial => current.slots[cursor++] ||= initial()
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) {
    const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useMemo(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { state.value = fn(); state.deps = deps }
    return state.value
  },
  useEffect(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const block = value => value.slice(value.indexOf('function useConnectionModelLocation('), value.indexOf('const MODEL_FEEDBACK_TYPES'))
for (const file of ['../lib/client.js', '../extension/viewer.js']) {
  const generated = readFileSync(new URL(file, import.meta.url), 'utf8')
  assert.equal(block(source), block(generated))
  if (file === '../lib/client.js') assert.equal(modelReviewSource(source), modelReviewSource(generated))
}
const env = { window: { React, confirm: () => true }, console, AbortController, setTimeout: () => 1, clearTimeout() {},
  sessionStorage: { getItem: () => null, setItem() {} } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), env)
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const alerts = ui => all(ui.owner.tree, node => node.props.role === 'alert').map(text)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const harness = await modelLearningHarness({ fixture })
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  const post = (method, args) => {
    actualHttpRequests++
    const request = fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    }).then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || 'HTTP ' + response.status); return body })
    requests.add(request); request.finally(() => requests.delete(request)).catch(() => {})
    return request
  }
  const mount = async () => {
    const owner = { slots: [], effects: [], updates: [], tree: null }, props = { documentId: fixture.documentId, revision: 1, active: true,
      focusRequest: { documentId: fixture.documentId, revision: 1, nodeId: 'taxi', type: 'connection_model' },
      load: args => post('connection-models', args), onRoles: () => { throw new Error('No automatic role writes') } }
    let mounted = true
    const nav = { holds: [], results: [], outcomes: [], published: [], readCalls: [], questions: [], drafts: [], focuses: [], paused: true }
    const opened = await post('document-load', { documentId: fixture.documentId, query: 'distance', nodeLimit: 1, includeSourceText: false })
    assert.deepEqual(opened.graph.nodes.map(node => node.id), ['distance'])
    const view = env.window.KGViewer.makeView(opened.graph, fixture.sourceText)
    const receiver = { resultView: view, fullText: fixture.sourceText, currentResultRef: { current: view }, graphRevisionRef: { current: 1 },
      graphCommitQueueRef: { current: Promise.resolve() }, paragraphLocateSeqRef: { current: 0 }, documentIdOfGraph: graph => graph.source.documentId,
      exactSourceQuoteTarget: () => { throw new Error('Not a source-only action') }, makeView: env.window.KGViewer.makeView,
      setResultView: next => { nav.published.push(next); nav.pendingView = next }, setGraphQueryDraft() {}, setGraphPageDraft() {}, graphViewMetadata: () => null,
      setContentScope() {}, navigateWorkspace() {}, chapterSectionsOf: () => [], setChapterFilter() {}, setSelectedNodeId() {}, setSelectedEdgeId() {},
      setFocusReq: update => nav.focuses.push(update({ seq: nav.focuses.length })), setActivePara() {}, setFlashPara() {},
      ctx: { timeout: fn => fn() }, document: { getElementById: () => null }, scrollElIntoCenter() {},
      setQuestionDraft: value => nav.drafts.push(value), handleQuestionNode: value => nav.questions.push(value),
      loadGraphDocument: async args => {
        nav.readCalls.push(args); const hold = nav.paused ? deferred() : null
        if (hold) nav.holds.push(hold)
        let loaded, error; try { loaded = await post('document-load', args) } catch (reason) { error = reason }
        if (hold) await hold.promise
        if (error) throw error
        return loaded
      } }
    nav.environment = receiver
    props.onReview = (...args) => {
      const { locateConsumptionReference, ...locatorEnvironment } = receiver
      receiver.locateConsumptionReference = modelCitationLocator(locatorEnvironment)
      const result = modelReviewReceiver(receiver)(...args); nav.results.push(result)
      result.then(value => nav.outcomes.push({ value }), reason => nav.outcomes.push({ error: reason.message })); return result
    }
    const render = () => {
      if (nav.pendingView) { receiver.currentResultRef.current = nav.pendingView; receiver.resultView = nav.pendingView; nav.pendingView = null }
      for (let count = 0; count < 30; count++) {
        current = owner; owner.updates.splice(0).forEach(fn => fn()); cursor = 0
        owner.tree = env.window.KGViewer.ConnectionModelPanel(props); owner.effects.splice(0).forEach(fn => fn())
        if (!owner.updates.length) return
      }
      throw new Error('Panel update loop')
    }
    const settle = async () => { for (let count = 0; count < 12; count++) { await Promise.allSettled([...requests]); await Promise.resolve(); if (mounted) render() } }
    const button = label => {
      const node = all(owner.tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label))[0]
      assert(node, 'Missing ' + label); assert(!node.props.disabled); return node
    }
    const click = async label => { current = owner; button(label).props.onClick(); await settle() }
    const select = async id => {
      const row = all(owner.tree, node => node.props['data-model-catalogue-row'] === id)[0]; assert(row, 'Missing model ' + id); current = owner
      all(row, node => node.type === 'button' && node.props.className === 'kg-model-list-item')[0].props.onClick(); await settle()
    }
    const complete = async (index = 0) => { nav.holds[index]?.resolve(); await Promise.allSettled([nav.results[index]]); await settle() }
    const unmount = () => { mounted = false; for (const state of owner.slots) state.cleanup?.() }
    owners.push(owner); render(); await settle(); await click('核对方向')
    return { owner, props, nav, render, settle, button, click, select, complete, unmount }
  }
  const untouched = ui => { assert.equal(ui.nav.published.length, 0); assert.equal(ui.nav.focuses.length, 0); assert.equal(ui.nav.questions.length, 0); assert.equal(ui.nav.drafts.length, 0) }

  // Real HTTP503 after the old review starts must not become a new model error.
  const failed = await mount(); failRead = true; await failed.click('审阅模型与相关关系'); await failed.select('taxi-peer'); await failed.complete()
  assert.deepEqual(alerts(failed), []); untouched(failed); cases++
  for (const change of [async ui => ui.select('taxi-peer'), async ui => { await ui.select('taxi-peer'); await ui.select('taxi') },
    async ui => { await ui.click('下上对照'); await ui.click('核对方向') },
    async ui => { ui.props.active = false; ui.render(); ui.props.active = true; ui.render() },
    async ui => { ui.props.busy = true; ui.render(); ui.props.busy = false; ui.render() },
    async ui => { ui.props.revision = 2; ui.render(); await ui.settle() },
    async ui => { ui.props.documentId = 'not-this-document'; ui.render(); await ui.settle() }, async ui => ui.unmount()]) {
    const ui = await mount(); await ui.click('审阅模型与相关关系'); await change(ui); await ui.complete(); untouched(ui); cases++
  }
  for (const latestFails of [false, true]) {
    const ui = await mount(); failRead = !latestFails; await ui.click('审阅模型与相关关系')
    failRead = latestFails; await ui.click('审阅模型与相关关系'); await ui.complete(1); await ui.complete(0)
    assert.equal(ui.nav.questions.length, latestFails ? 0 : 1, JSON.stringify({ latestFails, outcomes: ui.nav.outcomes, alerts: alerts(ui) }))
    assert.equal(ui.nav.published.length, latestFails ? 0 : 1)
    assert.equal(alerts(ui).some(value => value.includes('隔离模型审阅读取失败')), latestFails); cases++
  }
  const retry = await mount(); failRead = true; await retry.click('审阅模型与相关关系'); await retry.complete()
  assert(alerts(retry).some(value => value.includes('隔离模型审阅读取失败'))); untouched(retry)
  await retry.click('审阅模型与相关关系'); await retry.complete(1)
  assert.equal(retry.nav.questions[0].id, 'taxi'); assert(retry.nav.drafts[0].includes('保留因素材料，不把材料冒充概念')); cases++
  const direct = await mount(); direct.nav.environment.resultView = env.window.KGViewer.makeView(harness.store.getDocument(fixture.documentId), fixture.sourceText)
  direct.nav.environment.currentResultRef.current = direct.nav.environment.resultView
  await direct.click('审阅模型与相关关系'); assert.equal(direct.nav.readCalls.length, 0); assert.equal(direct.nav.questions[0].id, 'taxi'); cases++
  const old = await mount(), stale = old.button('审阅模型与相关关系').props.onClick
  await old.select('taxi-peer'); current = old.owner; stale(); await old.settle(); assert.equal(old.nav.results.length, 0); untouched(old); cases++
  const queued = await mount(), queue = deferred(); queued.nav.environment.graphCommitQueueRef.current = queue.promise
  await queued.click('审阅模型与相关关系'); assert.equal(queued.nav.readCalls.length, 0); await queued.select('taxi-peer')
  queue.resolve(); await queued.complete(); assert.equal(queued.nav.readCalls.length, 0); untouched(queued); cases++
  const changedView = await mount(); await changedView.click('审阅模型与相关关系')
  changedView.nav.environment.currentResultRef.current = { graph: { source: { documentId: 'another-document' } } }
  await changedView.complete(); untouched(changedView); assert(alerts(changedView).some(value => value.includes('旧定位已取消'))); cases++
  const empty = await mount(); empty.nav.environment.resultView = null; empty.nav.environment.currentResultRef.current = null
  await empty.click('审阅模型与相关关系'); untouched(empty); cases++
  // Receiver also rejects expired direct callers, and never fills a problem when
  // the locator cannot act. The locator keeps its existing view fence/errors.
  const external = await mount(), model = { nodeId: 'taxi' }
  external.nav.environment.locateConsumptionReference = modelCitationLocator(external.nav.environment)
  assert.equal(await modelReviewReceiver(external.nav.environment)(model, () => false), false); untouched(external); cases++
  const completedLocation = await mount(); completedLocation.nav.paused = false
  let selectionCurrent = true
  const realLocator = modelCitationLocator(completedLocation.nav.environment)
  completedLocation.nav.environment.locateConsumptionReference = async (...args) => {
    const located = await realLocator(...args); selectionCurrent = false; return located
  }
  assert.equal(await modelReviewReceiver(completedLocation.nav.environment)(model, () => selectionCurrent), false)
  assert.equal(completedLocation.nav.focuses.length, 1); assert.equal(completedLocation.nav.questions.length, 0)
  assert.equal(completedLocation.nav.drafts.length, 0); cases++

  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  console.log(JSON.stringify({ ok: true, modelReviewScope: true, cases, actualHttpRequests,
    productionPanelAndReviewReceiver: true, actualCanonicalSqliteHttp: true, canonicalGraphAndSourceUnchanged: true, learningCount: 0 }))
} finally {
  for (const owner of owners) for (const state of owner.slots) state.cleanup?.()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
