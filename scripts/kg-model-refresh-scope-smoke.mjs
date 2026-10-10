import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelRefreshFixture, modelRefreshReceiver } from './kg-model-refresh-fixture.mjs'
import { createModelReviewController } from './kg-model-review-controller-fixture.mjs'

const fixture = modelRefreshFixture(), harness = await modelLearningHarness({ fixture })
const requests = new Set(), owners = []
let current, cursor = 0, cases = 0, actualHttpRequests = 0, failRead = false, failPreview = false, confirm = true
const server = createServer((request, response) => {
  if (failPreview && request.url.endsWith('/graph-commit-preview')) {
    failPreview = false; request.resume(); response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: '隔离方向预览校验失败' } })); return
  }
  if (failRead && request.url.endsWith('/document-load')) {
    failRead = false; request.resume(); response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: '隔离模型刷新读取失败' } })); return
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
for (const file of ['../lib/client.js', '../extension/viewer.js']) assert.equal(block(source), block(readFileSync(new URL(file, import.meta.url), 'utf8')))
const env = { window: { React, confirm: () => confirm }, console, AbortController, setTimeout: () => 1, clearTimeout() {},
  sessionStorage: { getItem: () => null, setItem() {} } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), env)
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const alerts = ui => all(ui.owner.tree, node => node.props.role === 'alert').map(text)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  const post = (method, args) => {
    actualHttpRequests++
    const request = fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    }).then(async response => {
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message || 'HTTP ' + response.status)
      return body
    })
    requests.add(request); request.finally(() => requests.delete(request)).catch(() => {})
    return request
  }
  const mount = async (directionPreview = false) => {
    const owner = { slots: [], effects: [], updates: [], tree: null }, props = { documentId: fixture.documentId, revision: 1, active: true,
      focusRequest: { documentId: fixture.documentId, revision: 1, nodeId: 'taxi', type: 'connection_model' },
      load: args => post('connection-models', args), onRoles: () => { throw new Error('No automatic role writes') } }
    let mounted = true
    const nav = { holds: [], results: [], published: [], readCalls: [], paused: true }
    const view = env.window.KGViewer.makeView(harness.store.getDocument(fixture.documentId), fixture.sourceText)
    const receiverEnv = { resultView: view, currentResultRef: { current: view }, graphRevisionRef: { current: 1 },
      graphCommitQueueRef: { current: Promise.resolve() }, documentIdOfGraph: graph => graph.source.documentId,
      graphViewMetadata: () => ({ nodeOffset: 0, nodeLimit: 800 }), makeView: env.window.KGViewer.makeView,
      setFullText: value => { assert.equal(value, fixture.sourceText) }, setVerification() {}, setFactReport() {},
      setResultView: value => { nav.published.push(value); receiverEnv.currentResultRef.current = value; receiverEnv.resultView = value },
      loadGraphDocument: async args => {
        nav.readCalls.push(args)
        const hold = nav.paused ? deferred() : null
        if (hold) nav.holds.push(hold)
        let loaded, error
        try { loaded = await post('document-load', args) } catch (reason) { error = reason }
        if (hold) await hold.promise
        if (error) throw error
        return loaded
      } }
    nav.environment = receiverEnv
    if (directionPreview) props.onRoles = args => {
      assert(!args.preview, 'This read-only regression does not confirm a canonical write')
      return createModelReviewController({ ...receiverEnv, verifyBusyRef: { current: false } }, { call: post })(args)
    }
    props.onRefresh = (...args) => {
      const response = modelRefreshReceiver(receiverEnv)(...args)
      nav.results.push(response); response.catch(() => {})
      return response
    }
    const render = () => {
      for (let count = 0; count < 30; count++) {
        current = owner; owner.updates.splice(0).forEach(fn => fn()); cursor = 0
        owner.tree = env.window.KGViewer.ConnectionModelPanel(props); owner.effects.splice(0).forEach(fn => fn())
        if (!owner.updates.length) return
      }
      throw new Error('Panel update loop')
    }
    const settle = async () => {
      for (let count = 0; count < 12; count++) { await Promise.allSettled([...requests]); await Promise.resolve(); if (mounted) render() }
    }
    const button = label => {
      const node = all(owner.tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label))[0]
      assert(node, 'Missing ' + label); assert(!node.props.disabled); return node
    }
    const click = async label => { current = owner; button(label).props.onClick(); await settle() }
    const select = async id => {
      const row = all(owner.tree, node => node.props['data-model-catalogue-row'] === id)[0]
      assert(row, 'Missing model ' + id); current = owner
      all(row, node => node.type === 'button' && node.props.className === 'kg-model-list-item')[0].props.onClick(); await settle()
    }
    const role = () => all(owner.tree, node => node.type === 'select' && node.props['aria-label'] === '端点角色 distance')[0]
    const edit = async () => {
      const node = role(); assert(node && !node.props.disabled, 'Actual editable legacy direction')
      current = owner; node.props.onChange({ target: { value: 'output' } }); await settle()
      assert.equal(role().props.value, 'output'); assert(!button('预览方向修改').props.disabled)
    }
    const complete = async (index = 0) => { nav.holds[index]?.resolve(); await Promise.allSettled([nav.results[index]]); await settle() }
    const unmount = () => { mounted = false; for (const state of owner.slots) state.cleanup?.() }
    owners.push(owner); render(); await settle()
    return { owner, props, nav, render, settle, button, click, select, role, edit, complete, unmount }
  }
  // A real HTTP failure belongs to the model where refresh was requested.
  const oldFailure = await mount(); failRead = true
  await oldFailure.click('重新读取模型'); await oldFailure.select('taxi-peer'); await oldFailure.complete()
  assert.deepEqual(alerts(oldFailure), [], 'A late failed refresh must not contaminate the newly selected model'); cases++
  const newDraft = await mount()
  await newDraft.click('重新读取模型'); await newDraft.select('taxi-peer'); await newDraft.click('核对方向'); await newDraft.edit(); await newDraft.complete()
  assert.equal(newDraft.role().props.value, 'output', 'An old successful refresh must preserve a new model direction draft')
  assert.equal(newDraft.nav.published.length, 0, 'An obsolete caller must not publish a canonical view'); cases++
  const sameDraft = await mount(); await sameDraft.click('核对方向'); await sameDraft.click('重新读取模型'); await sameDraft.edit(); await sameDraft.complete()
  assert.equal(sameDraft.role().props.value, 'output', 'A new draft in the same model survives a pending refresh'); cases++
  for (const change of ['model-aba', 'active-aba', 'revision-aba', 'document-aba', 'tab-aba', 'unmount']) {
    const ui = await mount(); await ui.click('重新读取模型')
    if (change === 'model-aba') { await ui.select('taxi-peer'); await ui.select('taxi') }
    else if (change === 'tab-aba') { await ui.click('核对方向'); await ui.click('下上对照') }
    else if (change === 'unmount') ui.unmount()
    else {
      const key = change === 'active-aba' ? 'active' : change === 'revision-aba' ? 'revision' : 'documentId', original = ui.props[key]
      ui.props[key] = key === 'active' ? false : key === 'revision' ? 2 : fixture.documentId + '-other'; ui.render(); await ui.settle()
      ui.props[key] = original; ui.render(); await ui.settle()
    }
    await ui.complete(); assert.equal(ui.nav.published.length, 0, change + ' cancels the old receiver'); cases++
  }
  const latest = await mount(); await latest.click('重新读取模型'); await latest.click('重新读取模型')
  await latest.complete(1); await latest.complete(0)
  assert.equal(latest.nav.published.length, 1, 'Only the latest refresh publishes'); assert.deepEqual(alerts(latest), []); cases++
  const currentFailure = await mount(); failRead = true; await currentFailure.click('重新读取模型'); await currentFailure.complete()
  assert(alerts(currentFailure).some(value => value.includes('隔离模型刷新读取失败')), 'Current read failure remains visible'); cases++
  currentFailure.nav.paused = false; await currentFailure.click('重新读取模型')
  assert.deepEqual(alerts(currentFailure), []); assert.equal(currentFailure.nav.published.length, 1, 'Current retry really reloads'); cases++
  const declined = await mount(); await declined.click('核对方向'); await declined.edit(); confirm = false
  await declined.click('重新读取模型'); confirm = true
  assert.equal(declined.nav.results.length, 0); assert.equal(declined.role().props.value, 'output', 'Declining discard preserves the draft'); cases++
  const accepted = await mount(); await accepted.click('核对方向'); await accepted.edit(); await accepted.click('重新读取模型'); await accepted.complete()
  assert.equal(accepted.role().props.value, 'input'); assert.equal(accepted.nav.published.length, 1, 'Confirmed current refresh discards only its original draft'); cases++
  const queued = await mount(), gate = deferred()
  queued.nav.paused = false
  // Wait behind an actual production receiver's commit fence before issuing a read.
  // This is a controlled queue boundary; no canonical write is performed.
  const view = env.window.KGViewer.makeView(harness.store.getDocument(fixture.documentId), fixture.sourceText)
  let queuedReads = 0, published = 0
  const queuedReceiver = modelRefreshReceiver({ resultView: view, currentResultRef: { current: view }, graphRevisionRef: { current: 1 },
    graphCommitQueueRef: { current: gate.promise }, documentIdOfGraph: graph => graph.source.documentId,
    graphViewMetadata: () => null, makeView: env.window.KGViewer.makeView, setFullText() {}, setVerification() {}, setFactReport() {},
    setResultView: () => published++, loadGraphDocument: args => { queuedReads++; return post('document-load', args) } })
  queued.props.onRefresh = queuedReceiver; queued.render(); await queued.click('重新读取模型'); await queued.select('taxi-peer')
  gate.resolve(); await queued.settle(); assert.equal(queuedReads, 0); assert.equal(published, 0); cases++
  const staleCallback = await mount(), oldClick = staleCallback.button('重新读取模型').props.onClick
  await staleCallback.select('taxi-peer'); current = staleCallback.owner; await oldClick(); await staleCallback.settle()
  assert.equal(staleCallback.nav.results.length, 0, 'A callback from the old model cannot start a refresh'); cases++
  const changedView = await mount(); await changedView.click('重新读取模型')
  changedView.nav.environment.currentResultRef.current = { graph: { source: { documentId: fixture.documentId + '-other' } } }
  await changedView.complete()
  assert.equal(changedView.nav.published.length, 0)
  assert(alerts(changedView).some(value => value.includes('文档已切换')), 'The original canonical-view fence remains enforced'); cases++
  const compatible = await mount(); compatible.nav.paused = false
  await modelRefreshReceiver(compatible.nav.environment)()
  assert.equal(compatible.nav.published.length, 1, 'Existing refresh callers without a selection predicate still work'); cases++
  const standalone = await mount(); standalone.props.onRefresh = undefined; standalone.render()
  const beforeLocalReload = actualHttpRequests
  current = standalone.owner; const refreshing = standalone.button('重新读取模型').props.onClick(); standalone.render()
  assert.equal(actualHttpRequests, beforeLocalReload + 2, 'A standalone local retry issues the directory/detail reads synchronously')
  await refreshing; await standalone.settle(); assert.deepEqual(alerts(standalone), []); cases++

  // A validated direction preview does not recover a failed canonical refresh.
  // Both operations use their actual production receivers and isolated HTTP.
  const previewSuccess = await mount(true); await previewSuccess.click('核对方向')
  failRead = true; await previewSuccess.click('重新读取模型'); await previewSuccess.complete()
  assert.deepEqual(alerts(previewSuccess), ['隔离模型刷新读取失败'])
  await previewSuccess.edit(); await previewSuccess.click('预览方向修改')
  assert.deepEqual(alerts(previewSuccess), ['隔离模型刷新读取失败'], 'Successful direction preview must preserve the unrecovered refresh failure')
  assert(previewSuccess.button('确认保存方向')); assert.equal(previewSuccess.role().props.value, 'output')
  assert.equal(previewSuccess.nav.published.length, 0); cases++
  const declinePreview = text(previewSuccess.owner.tree).split('待确认的方向修改')[1]
  confirm = false; const declinedCalls = previewSuccess.nav.results.length
  await previewSuccess.click('重新读取模型'); confirm = true
  assert.equal(previewSuccess.nav.results.length, declinedCalls)
  assert(previewSuccess.button('确认保存方向'))
  assert.equal(text(previewSuccess.owner.tree).split('待确认的方向修改')[1], declinePreview, 'Declining a discard preserves the pending direction diff')
  assert.deepEqual(alerts(previewSuccess), ['隔离模型刷新读取失败']); cases++
  await previewSuccess.click('取消预览'); assert.deepEqual(alerts(previewSuccess), ['隔离模型刷新读取失败']); cases++

  for (const first of ['refresh', 'preview']) {
    const ui = await mount(true); await ui.click('核对方向'); await ui.edit()
    const failRefresh = async () => { failRead = true; await ui.click('重新读取模型'); await ui.complete() }
    const failDirection = async () => { failPreview = true; await ui.click('预览方向修改') }
    if (first === 'refresh') { await failRefresh(); await failDirection() }
    else { await failDirection(); await failRefresh() }
    assert.deepEqual(new Set(alerts(ui)), new Set(['隔离模型刷新读取失败', '隔离方向预览校验失败']), 'Independent failures must not replace each other')
    assert.equal(ui.role().props.value, 'output'); assert.equal(ui.nav.published.length, 0); cases++
  }
  const retryOwn = await mount(true); await retryOwn.click('核对方向'); await retryOwn.edit()
  failPreview = true; await retryOwn.click('预览方向修改'); failRead = true
  await retryOwn.click('重新读取模型'); await retryOwn.complete()
  failRead = true; await retryOwn.click('重新读取模型')
  assert.deepEqual(alerts(retryOwn), ['隔离方向预览校验失败'], 'An admitted refresh retry clears only its own failure')
  await retryOwn.complete(1)
  assert.deepEqual(new Set(alerts(retryOwn)), new Set(['隔离模型刷新读取失败', '隔离方向预览校验失败']))
  assert.equal(retryOwn.role().props.value, 'output'); assert.equal(retryOwn.nav.published.length, 0); cases++
  retryOwn.nav.paused = false; await retryOwn.click('预览方向修改')
  assert.deepEqual(alerts(retryOwn), ['隔离模型刷新读取失败']); assert(retryOwn.button('确认保存方向')); cases++
  await retryOwn.click('重新读取模型')
  assert.deepEqual(alerts(retryOwn), []); assert.equal(retryOwn.role().props.value, 'input'); assert.equal(retryOwn.nav.published.length, 1); cases++

  const staleError = await mount(); failRead = true; await staleError.click('重新读取模型'); await staleError.complete()
  const oldRefresh = staleError.button('重新读取模型').props.onClick
  await staleError.select('taxi-peer'); assert.deepEqual(alerts(staleError), [])
  failRead = true; await staleError.click('重新读取模型'); await staleError.complete(1)
  const callsBeforeStale = staleError.nav.results.length
  current = staleError.owner; await oldRefresh(); await staleError.settle()
  assert.equal(staleError.nav.results.length, callsBeforeStale)
  assert.deepEqual(alerts(staleError), ['隔离模型刷新读取失败'], 'An obsolete callback cannot erase the current model failure'); cases++
  const blocked = staleError.button('重新读取模型').props.onClick
  staleError.props.busy = true; staleError.render(); current = staleError.owner; await blocked(); await staleError.settle()
  assert.equal(staleError.nav.results.length, callsBeforeStale); assert.deepEqual(alerts(staleError), ['隔离模型刷新读取失败']); cases++

  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  console.log(JSON.stringify({ ok: true, cases, actualHttpRequests, productionPanelAndRefreshReceiver: true,
    directionPreviewErrorOwnership: true, canonicalGraphAndSourceUnchanged: true, automaticWrites: 0, learningRecords: 0 }))
} finally {
  for (const owner of owners) for (const state of owner.slots) state.cleanup?.()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
