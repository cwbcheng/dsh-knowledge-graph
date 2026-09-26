import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
function section(start, end, from = 0) {
  const first = client.indexOf(start, from), last = client.indexOf(end, first)
  assert(first >= 0 && last > first, start)
  return client.slice(first, last)
}
const helpers = section('      function asAllNodesGraph(graph) {', '      function historyMetadata(entry) {')
const { asAllNodesGraph, graphCommitViewPatch } = new Function(helpers + '; return { asAllNodesGraph, graphCommitViewPatch }')()
const sources = {
  document: section('        const persistGraph =', '        const handleRemoveParagraphType =')
    + section('        const attachReport =', '        const startDeepVerify ='),
  trajectory: section('        const persistTrajGraph =', '        const commitTrajGraph =')
    + section('        const attachTrajReport =', '        const startDeepVerify ='),
}
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const quickReport = { reportId: 'quick-report', issues: [], metrics: { errorCount: 0, warningCount: 1 } }
function graph(documentId = 'document-a', revision = 1) {
  return { source: { documentId, revision }, revision, summary: 'Original summary',
    nodes: [{ id: 'n1', type: 'fact', text: 'Original fact', paragraph: 0 }], edges: [],
    verification: { lastReport: { reportId: 'original-' + documentId, issues: [] } } }
}

function fixture(kind, { verifyReply, commitReply, local = false } = {}) {
  const opening = { graph: graph(local ? '' : 'document-a'), sourceText: 'Original source' }
  const refs = {
    currentResultRef: { current: opening }, graphRevisionRef: { current: local ? 0 : 1 },
    graphCommitQueueRef: { current: Promise.resolve() }, graphCommitEpochRef: { current: 0 },
    verifyGenRef: { current: 0 }, verifyBusyRef: { current: false }, bulkRunRef: { current: false },
    mountedSessionRef: { current: 'session-a' },
  }
  Object.assign(refs, { currentViewRef: refs.currentResultRef, trajRevisionRef: refs.graphRevisionRef,
    trajCommitQueueRef: refs.graphCommitQueueRef, trajCommitEpochRef: refs.graphCommitEpochRef })
  const state = { report: opening.graph.verification.lastReport, phase: 'idle', progress: null,
    error: null, activeIssueId: 'old-issue', toasts: [], history: [], events: [] }
  const calls = [], operations = new WeakMap()
  const set = key => value => {
    state[key] = typeof value === 'function' ? value(state[key]) : value
    state.events.push(key)
  }
  const setView = next => {
    refs.currentResultRef.current = typeof next === 'function' ? next(refs.currentResultRef.current) : next
    state.events.push('view')
  }
  const host = { call: async (name, payload) => {
    calls.push({ name, payload })
    if (name === 'verify-graph') return verifyReply ? verifyReply(payload) : { report: quickReport }
    assert.equal(name, 'graph-commit')
    return commitReply ? commitReply(payload) : { documentId: payload.documentId,
      revision: payload.expectedRevision + 1, graph: payload.graph }
  } }
  const actions = () => {
    const view = refs.currentResultRef.current
    const deps = {
      ...refs, resultView: view, view, title: 'Quick fixture', fullText: view?.sourceText || '',
      effectiveModelArg: null, host, traceEvents: [], currentHistoryId: null,
      sessionId: refs.mountedSessionRef.current,
      documentIdOfGraph: value => value?.source?.documentId || '',
      makeView: (graph, sourceText) => ({ graph, sourceText }), setResultView: setView, setView,
      withVerification: (graph, report, stale) => ({ ...graph, verification: { lastReport: report, stale } }),
      verificationSourcePayload: () => ({}), asAllNodesGraph, graphCommitViewPatch,
      graphSemanticOperations: operations, semanticOperationsOf: value => operations.get(value) || [],
      setError: set('error'), setVerification: set('report'), setVerifyPhase: set('phase'),
      setVerifyProgress: set('progress'), setActiveIssueId: set('activeIssueId'), setFactReport() {},
      setHistory: value => state.history.push(value([])), appendHistory: (prev, value) => [...prev, value],
      localStorage: { setItem() {} }, LS_RESULT: 'result',
      writeTrajResult: (session, value) => state.history.push({ session, value }),
      toastStore: { show: text => state.toasts.push(text) }, showToast: text => state.toasts.push(text),
    }
    return new Function(...Object.keys(deps), sources[kind] + '; return { startQuickVerify }')(...Object.values(deps))
  }
  const navigate = (mode = 'document') => {
    refs.verifyGenRef.current += 1
    refs.graphCommitEpochRef.current += 1
    refs.graphCommitQueueRef.current = Promise.resolve()
    if (mode === 'unmount') {
      refs.mountedSessionRef.current = null
      refs.currentResultRef.current = null
    } else {
      if (kind === 'trajectory' && mode === 'document') refs.mountedSessionRef.current = 'session-b'
      const nextGraph = graph(mode === 'reload' ? 'document-a' : 'document-b', 4)
      setView({ graph: nextGraph, sourceText: 'New source' })
      refs.graphRevisionRef.current = 4
      state.report = nextGraph.verification.lastReport
    }
    state.phase = 'running'
    refs.verifyBusyRef.current = true
    state.error = { message: 'Current independent error' }
    state.progress = { stage: 'Current independent task' }
    state.events = []
  }
  return { opening, refs, state, calls, actions, navigate, setView }
}

for (const kind of ['document', 'trajectory']) {
  for (const navigation of ['document', 'reload', 'unmount']) {
    for (const reply of ['report', 'error', 'throw', 'missing']) {
      const pending = deferred()
      const f = fixture(kind, { verifyReply: () => pending.promise })
      const run = f.actions().startQuickVerify()
      await tick()
      assert.equal(f.calls.length, 1)
      f.navigate(navigation)
      const current = f.refs.currentResultRef.current
      const state = structuredClone(f.state)
      if (reply === 'throw') pending.reject(new Error('Old request failed'))
      else pending.resolve(reply === 'report' ? { report: quickReport }
        : reply === 'error' ? { error: { message: 'Old host failure' } } : {})
      await run
      await tick()
      assert.equal(f.refs.currentResultRef.current, current, kind + ': departed quick report must not replace the current graph')
      assert.deepEqual(f.state, state, kind + ': departed result/error/finally must not mutate new task state')
      assert.equal(f.refs.verifyBusyRef.current, true, 'old finally must not release the new task lock')
      assert.equal(f.calls.filter(call => call.name === 'graph-commit').length, 0)
    }
  }

  for (const change of ['edit', 'source', 'revision', 'queue', 'failed-queue']) {
    const pending = deferred()
    const f = fixture(kind, { verifyReply: () => pending.promise })
    const run = f.actions().startQuickVerify()
    await tick()
    if (change === 'edit') f.setView({ ...f.opening, graph: { ...f.opening.graph,
      nodes: [{ ...f.opening.graph.nodes[0], text: 'User edited fact' }] } })
    if (change === 'source') f.setView({ ...f.opening, sourceText: 'Replaced source' })
    if (change === 'revision') f.refs.graphRevisionRef.current = 2
    if (change === 'queue') f.refs.graphCommitQueueRef.current = Promise.resolve()
    if (change === 'failed-queue') f.refs.graphCommitEpochRef.current += 1
    const current = f.refs.currentResultRef.current
    pending.resolve({ report: quickReport })
    await run
    assert.equal(f.refs.currentResultRef.current, current, change + ': keep current data')
    assert.equal(f.state.report, f.opening.graph.verification.lastReport)
    assert.equal(f.calls.filter(call => call.name === 'graph-commit').length, 0, change + ': cannot commit a stale report')
    assert.match(f.state.error?.message || '', /变化|修改|保存/)
    assert.equal(f.state.toasts.length, 0)
    assert.equal(f.state.phase, 'idle')
    assert.equal(f.refs.verifyBusyRef.current, false)
  }

  const queued = deferred()
  const waiting = fixture(kind)
  waiting.refs.graphCommitQueueRef.current = queued.promise
  const waitingRun = waiting.actions().startQuickVerify()
  await tick()
  assert.equal(waiting.calls.length, 0, 'quick verification waits for previous writes before choosing its revision')
  waiting.refs.graphRevisionRef.current = 2
  queued.resolve()
  await waitingRun
  assert.equal(waiting.calls[1].payload.expectedRevision, 2)
  assert.equal(waiting.refs.graphRevisionRef.current, 3)

  const abandonedQueue = deferred()
  const abandoned = fixture(kind)
  abandoned.refs.graphCommitQueueRef.current = abandonedQueue.promise
  const abandonedRun = abandoned.actions().startQuickVerify()
  await tick()
  abandoned.navigate()
  const abandonedState = structuredClone(abandoned.state)
  abandonedQueue.resolve()
  await abandonedRun
  assert.equal(abandoned.calls.length, 0, 'navigation while waiting must not dispatch the old request')
  assert.deepEqual(abandoned.state, abandonedState)

  const held = deferred()
  const success = fixture(kind, { commitReply: payload => held.promise.then(() => ({
    documentId: payload.documentId, revision: 2, graph: payload.graph,
  })) })
  const successRun = success.actions().startQuickVerify()
  await tick()
  assert.equal(success.calls.length, 2)
  assert.equal(success.refs.currentResultRef.current, success.opening, 'do not replace the graph before persistence')
  assert.equal(success.state.report, success.opening.graph.verification.lastReport)
  assert.equal(success.state.toasts.length, 0, 'success is not reported before acknowledgement')
  assert.equal(success.state.phase, 'running')
  assert.equal(success.refs.verifyBusyRef.current, true)
  held.resolve()
  await successRun
  assert.equal(success.state.report, quickReport)
  assert.equal(success.refs.currentResultRef.current.graph.verification.lastReport, quickReport)
  assert.equal(success.refs.currentResultRef.current.graph.source.revision, 2)
  assert.equal(success.refs.currentResultRef.current.graph.revision, 2)
  assert.equal(success.state.toasts.length, 1)
  assert.equal(success.state.phase, 'idle')
  assert.equal(success.refs.verifyBusyRef.current, false)
  assert.deepEqual(success.refs.currentResultRef.current.graph.nodes, success.opening.graph.nodes)

  for (const failure of ['transport', 'conflict', 'missing']) {
    const failed = fixture(kind, { commitReply: () => {
      if (failure === 'transport') throw new Error('Fixture transport failed')
      return failure === 'conflict' ? { error: { code: 'revision_conflict', message: 'Fixture revision conflict' } } : null
    } })
    await failed.actions().startQuickVerify()
    assert.deepEqual(failed.refs.currentResultRef.current, failed.opening, failure + ': an existing rollback may recreate the view, but must preserve all original data')
    assert.equal(failed.state.report, failed.opening.graph.verification.lastReport)
    assert.equal(failed.refs.graphRevisionRef.current, 1)
    assert(!failed.state.toasts.some(text => text.startsWith('快速体检完成')))
    assert(failed.state.error?.message)
    if (failure === 'conflict') assert.equal(failed.state.error.code, 'revision_conflict')
    assert.equal(failed.state.phase, 'idle')
  }

  for (const reply of ['success', 'error']) {
    const save = deferred()
    const departed = fixture(kind, { commitReply: payload => save.promise.then(() => reply === 'success'
      ? { documentId: payload.documentId, revision: 2, graph: payload.graph }
      : { error: { message: 'Old save failed' } }) })
    const run = departed.actions().startQuickVerify()
    await tick()
    assert.equal(departed.calls.length, 2)
    departed.navigate('reload')
    const current = departed.refs.currentResultRef.current, state = structuredClone(departed.state)
    save.resolve()
    await run
    assert.equal(departed.refs.currentResultRef.current, current)
    assert.deepEqual(departed.state, state, 'late save receipt must not update the reloaded report or task state')
    assert.equal(departed.refs.graphRevisionRef.current, 4)
  }

  const saving = deferred()
  const edited = fixture(kind, { commitReply: payload => saving.promise.then(() => ({
    documentId: payload.documentId, revision: 2, graph: payload.graph,
  })) })
  const editedRun = edited.actions().startQuickVerify()
  await tick()
  edited.setView({ ...edited.opening, graph: { ...edited.opening.graph, summary: 'An intervening edit' } })
  const editedView = edited.refs.currentResultRef.current
  saving.resolve()
  await editedRun
  assert.equal(edited.refs.currentResultRef.current, editedView, 'a save receipt cannot overwrite an intervening edit')
  assert.equal(edited.state.report, edited.opening.graph.verification.lastReport)
  assert.equal(edited.state.toasts.length, 0)
  assert.match(edited.state.error.message, /已保存.*已变化/)

  for (const failure of ['error', 'throw', 'missing']) {
    const failed = fixture(kind, { verifyReply: () => {
      if (failure === 'throw') throw new Error('Fixture quick request failed')
      return failure === 'error' ? { error: { message: 'Fixture quick host failed' } } : {}
    } })
    await failed.actions().startQuickVerify()
    assert.equal(failed.calls.length, 1)
    assert.equal(failed.refs.currentResultRef.current, failed.opening)
    assert.equal(failed.state.report, failed.opening.graph.verification.lastReport)
    assert.equal(failed.state.toasts.length, 0)
    assert(failed.state.error?.message)
    assert.equal(failed.state.phase, 'idle')
    assert.equal(failed.refs.verifyBusyRef.current, false)
  }

  const local = fixture(kind, { local: true })
  await local.actions().startQuickVerify()
  assert.equal(local.calls.length, 1, 'an unsaved local graph may still be checked without a canonical write')
  assert.equal(local.state.report, quickReport)
  assert.equal(local.refs.currentResultRef.current.graph.nodes, local.opening.graph.nodes)
  assert.equal(local.refs.graphRevisionRef.current, 0)
  assert.equal(local.state.toasts.length, 1)
}
console.log('Quick verification lifecycle: both views passed navigation, snapshot, queue and persistence checks')
