import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const helperStart = client.indexOf('      function asAllNodesGraph(graph) {')
const helperEnd = client.indexOf('      function historyMetadata(entry) {', helperStart)
const commitStart = client.indexOf('        const persistGraph = (g, baseGraph, pinnedRevision) => {')
const commitEnd = client.indexOf('        const handleRemoveParagraphType = ', commitStart)
assert(helperStart >= 0 && helperEnd > helperStart && commitStart >= 0 && commitEnd > commitStart)
const { asAllNodesGraph, graphCommitViewPatch } = new Function(
  `${client.slice(helperStart, helperEnd)}; return { asAllNodesGraph, graphCommitViewPatch }`,
)()
const commitSource = client.slice(commitStart, commitEnd)
const trajectoryStart = client.indexOf('        const persistTrajGraph = (g, baseGraph, pinnedRevision) => {')
const trajectoryEnd = client.indexOf('        const commitTrajGraph =', trajectoryStart)
assert(trajectoryStart >= 0 && trajectoryEnd > trajectoryStart)
const trajectorySource = client.slice(trajectoryStart, trajectoryEnd)
const navigationStart = client.indexOf('        const cancelVerifyTasks = () => {')
const navigationEnd = client.indexOf('        // ---- restore pending task', navigationStart)
assert(navigationStart >= 0 && navigationEnd > navigationStart)
const navigationSource = client.slice(navigationStart, navigationEnd)
const resetStart = client.indexOf('        const resetGraphCommitQueue = () => {')
const resetEnd = client.indexOf('        // ---- 追加拆分', resetStart)
const loadStart = client.indexOf('        const loadHistoryEntry = async (entry) => {')
const loadEnd = client.indexOf('        const removeHistory =', loadStart)
assert(resetStart >= 0 && resetEnd > resetStart && loadStart >= 0 && loadEnd > loadStart)
const resetSource = client.slice(resetStart, resetEnd)
const loadSource = client.slice(loadStart, loadEnd)

function makeFixture(kind, replyForCall) {
  const documentId = 'queue-fixture'
  const base = asAllNodesGraph({
    source: { documentId, revision: 1 }, revision: 1,
    nodes: [{ id: 'n1', type: 'fact', text: 'original' }], edges: [],
  })
  const refs = {
    graphRevisionRef: { current: 1 },
    graphCommitQueueRef: { current: Promise.resolve() },
    graphCommitEpochRef: { current: 0 },
    currentResultRef: { current: { graph: base, sourceText: 'source' } },
    mountedSessionRef: { current: 'session' },
    verifyGenRef: { current: 0 }, factGenRef: { current: 0 }, questionAdmissionRef: { current: null },
    verifyBusyRef: { current: false },
  }
  Object.assign(refs, { trajRevisionRef: refs.graphRevisionRef, trajCommitQueueRef: refs.graphCommitQueueRef,
    trajCommitEpochRef: refs.graphCommitEpochRef, currentViewRef: refs.currentResultRef })
  const calls = []
  const errors = []
  const history = []
  const operations = new WeakMap()
  const host = { call: async (name, payload) => {
    assert.equal(name, 'graph-commit')
    calls.push(payload)
    return replyForCall(calls.length, payload)
  } }
  const makeView = (graph, sourceText) => ({ graph, sourceText })
  const setResultView = (next) => {
    refs.currentResultRef.current = typeof next === 'function' ? next(refs.currentResultRef.current) : next
  }
  const makeCommit = (view) => {
    const deps = {
      resultView: view, view, fullText: 'source', title: 'fixture', currentHistoryId: null,
      sessionId: refs.mountedSessionRef.current, traceEvents: [],
      ...refs, host, makeView, setResultView, asAllNodesGraph, graphCommitViewPatch,
      documentIdOfGraph: (graph) => graph?.source?.documentId || '',
      semanticOperationsOf: graph => operations.get(graph) || [], graphSemanticOperations: operations,
      localStorage: { setItem() {} }, LS_RESULT: 'result',
      setHistory: (update) => history.push(update([])),
      appendHistory: (previous, entry) => [...previous, entry],
      setError: error => errors.push(typeof error === 'function' ? error(errors.at(-1)) : error),
      setVerification() {}, setFactReport() {},
      toastStore: { show() {} },
      setView: setResultView, showToast() {},
      writeTrajResult: (sessionId, result) => history.push({ sessionId, result }),
    }
    return new Function(...Object.keys(deps), kind === 'trajectory'
      ? `${trajectorySource}; return persistTrajGraph` : `${commitSource}; return persistGraph`)(...Object.values(deps))
  }
  const navigate = async (graph, failed = false) => {
    const deps = { ...refs, makeView, setResultView, toastStore: { clear() {} }, localStorage: { setItem() {} }, LS_RESULT: 'result',
      loadGraphDocument: async () => failed ? { error: { message: 'Fixture document load failed' } }
        : { graph, revision: graph.revision, sourceText: 'navigated source' },
      setError: error => { if (error) errors.push(error) } }
    for (const name of ['setVerifyTaskId', 'setQuestionTaskId', 'setFactTaskId', 'setVerifyPhase', 'setQuestionPhase',
      'setFactPhase', 'setQuestionResult', 'setVerifyProgress', 'setFactProgress', 'setExtractProgress',
      'setTitle', 'setText', 'setFullText', 'setCurrentHistoryId', 'setAppendCount', 'setMarkdownBundle', 'setChapterFilter',
      'setPhase', 'setSelectedNodeId', 'setSelectedEdgeId', 'setActivePara', 'setShowDiag', 'setHistoryOpen', 'setInputCollapsed',
      'setVerification', 'setFactReport', 'setActiveIssueId', 'setIssueFilter', 'setFactActiveId', 'setQuestionTarget', 'setQuestionDraft']) deps[name] = () => {}
    const load = new Function(...Object.keys(deps), resetSource + navigationSource + loadSource
      + '; return loadHistoryEntry')(...Object.values(deps))
    return load({ documentId: graph.source.documentId, title: 'Navigation fixture' })
  }
  return { base, refs, calls, errors, history, operations, makeView, setResultView, makeCommit, navigate }
}

for (const kind of ['document', 'trajectory']) {
  const fixture = reply => makeFixture(kind, reply)
  let releaseFirst
  const firstReply = new Promise((resolve) => { releaseFirst = resolve })
  const failed = fixture((number) => number === 1
    ? firstReply
    : { documentId: 'queue-fixture', revision: 2, graph: { nodes: [], edges: [] } })
  const firstGraph = { ...failed.base, nodes: [{ ...failed.base.nodes[0], text: 'rejected change' }] }
  const secondGraph = { ...firstGraph, nodes: [...firstGraph.nodes, { id: 'n2', type: 'fact', text: 'later edit' }] }
  failed.operations.set(firstGraph, [{ action: 'first' }])
  failed.operations.set(secondGraph, [{ action: 'dependent' }])
  const first = failed.makeCommit(failed.refs.currentResultRef.current)(firstGraph, failed.base)
  failed.setResultView(failed.makeView(firstGraph, 'source'))
  const second = failed.makeCommit(failed.refs.currentResultRef.current)(secondGraph, firstGraph)
  failed.setResultView(failed.makeView(secondGraph, 'source'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(failed.calls.length, 1)
  releaseFirst({ error: { code: 'invariant_violation', message: 'rejected by host' } })
  assert.equal(await first, null)
  assert.equal(await second, null, kind + ': a failed baseline must abandon its queued dependent edit')
  assert.equal(failed.calls.length, 1, 'a dependent edit must not be sent after its baseline was rejected')
  assert.equal(failed.refs.currentResultRef.current.graph.nodes[0].text, 'original', 'the optimistic chain must roll back')
  assert.equal(failed.refs.graphCommitEpochRef.current, 1)
  assert.match(failed.errors.at(-1).message, /后续排队的编辑不会提交/)
  assert.equal(failed.history.length, 0, 'an abandoned optimistic graph must not enter local history')
  assert.equal(failed.operations.has(firstGraph), false)
  assert.equal(failed.operations.has(secondGraph), false, 'abandoned operations must not be reused by later writes')

  const freshGraph = { ...failed.base, nodes: [...failed.base.nodes, { id: 'n3', type: 'fact', text: 'fresh edit' }] }
  const fresh = failed.makeCommit(failed.refs.currentResultRef.current)(freshGraph, failed.base)
  failed.setResultView(failed.makeView(freshGraph, 'source'))
  assert.equal((await fresh)?.revision, 2, 'a new edit after rollback may use the restored baseline')
  assert.equal(failed.calls.length, 2)
  assert.deepEqual(failed.calls[1].graph.nodes.map((node) => node.id), kind === 'document' ? ['n3'] : ['n1', 'n3'])
  if (kind === 'trajectory') assert.equal(failed.errors.at(-1), null, 'a confirmed fresh trajectory edit clears the prior failed-chain banner')

  let releaseSuccess
  const slowSuccess = new Promise((resolve) => { releaseSuccess = resolve })
  const passed = fixture((number) => number === 1
    ? slowSuccess
    : { documentId: 'queue-fixture', revision: 3, graph: { nodes: [], edges: [] } })
  const unrelatedError = { message: 'An independent task failed' }
  passed.errors.push(unrelatedError)
  const passFirst = { ...passed.base, nodes: [{ ...passed.base.nodes[0], text: 'accepted change' }] }
  const passSecond = { ...passFirst, nodes: [...passFirst.nodes, { id: 'n2', type: 'fact', text: 'second edit' }] }
  const savedFirst = passed.makeCommit(passed.refs.currentResultRef.current)(passFirst, passed.base)
  passed.setResultView(passed.makeView(passFirst, 'source'))
  const savedSecond = passed.makeCommit(passed.refs.currentResultRef.current)(passSecond, passFirst)
  passed.setResultView(passed.makeView(passSecond, 'source'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(passed.calls.length, 1, 'the second commit must wait for the first')
  releaseSuccess({ documentId: 'queue-fixture', revision: 2, graph: { nodes: [], edges: [] } })
  assert.equal((await savedFirst)?.revision, 2)
  assert.equal((await savedSecond)?.revision, 3)
  assert.deepEqual(passed.calls.map((call) => call.expectedRevision), [1, 2])
  assert.deepEqual(passed.calls[1].graph.nodes.map((node) => node.id), kind === 'document' ? ['n2'] : ['n1', 'n2'])
  assert.equal(passed.errors.at(-1), unrelatedError, 'saving must not clear an unrelated task error')
}

for (const failure of ['network', 'missing-receipt', 'foreign-receipt']) {
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const test = makeFixture('trajectory', async () => {
    await barrier
    if (failure === 'network') throw new Error('fixture transport lost')
    return failure === 'missing-receipt' ? null : { documentId: 'foreign', revision: 2, graph: {} }
  })
  const graph = { ...test.base, nodes: [{ ...test.base.nodes[0], text: 'unconfirmed' }] }
  const dependent = { ...graph, summary: 'Depends on the unconfirmed edit' }
  const first = test.makeCommit(test.refs.currentResultRef.current)(graph, test.base)
  test.setResultView(test.makeView(graph, 'source'))
  const second = test.makeCommit(test.refs.currentResultRef.current)(dependent, graph)
  test.setResultView(test.makeView(dependent, 'source'))
  await new Promise(resolve => setImmediate(resolve))
  release()
  assert.deepEqual(await Promise.all([first, second]), [null, null])
  assert.equal(test.calls.length, 1, failure + ': an unconfirmed write cannot be the baseline of another write')
  assert.equal(test.refs.trajRevisionRef.current, 1)
  assert.equal(test.refs.currentViewRef.current.graph, test.base)
  assert.equal(test.history.length, 0)
}

const pinned = makeFixture('trajectory', async () => ({ error: { message: 'fixture rejected pinned repair' } }))
const openingView = pinned.refs.currentViewRef.current
const canonicalBaseline = { ...pinned.base, nodes: [...pinned.base.nodes, { id: 'n801', type: 'fact', text: 'Hidden dependency' }] }
const canonicalFix = { ...canonicalBaseline, summary: 'Reviewed repair' }
assert.equal(await pinned.makeCommit(openingView)(canonicalFix, canonicalBaseline, 1), null)
assert.equal(pinned.refs.currentViewRef.current, openingView,
  'a rejected non-optimistic canonical repair must keep its renderer window, not replace it with the full graph')
assert.equal(pinned.history.length, 0)

for (const documentId of ['second-document', 'queue-fixture']) {
for (const outcome of ['failure', 'success', 'missing-receipt']) {
  let releaseDeparted
  const departedBarrier = new Promise(resolve => { releaseDeparted = resolve })
  const departed = makeFixture('document', (number, payload) => number === 1 ? departedBarrier
    : { documentId: payload.documentId, revision: payload.expectedRevision + 1, graph: payload.graph })
  const oldChange = { ...departed.base, summary: 'Ignored an issue in the old view' }
  const dependentChange = { ...oldChange, summary: 'Depends on the old save' }
  const oldSave = departed.makeCommit(departed.refs.currentResultRef.current)(oldChange, departed.base)
  departed.setResultView(departed.makeView(oldChange, 'source'))
  const dependentSave = departed.makeCommit(departed.refs.currentResultRef.current)(dependentChange, oldChange)
  departed.operations.set(oldChange, [{ action: 'old-change' }])
  departed.operations.set(dependentChange, [{ action: 'old-dependent' }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(departed.calls.length, 1)
  const newBase = { ...departed.base, source: { documentId, revision: 7 }, revision: 7 }
  assert.ok(await departed.navigate(newBase), 'actual history loading must replace the view successfully')
  const newChange = { ...newBase, summary: 'Ignored a different issue in the current view' }
  const newSave = departed.makeCommit(departed.refs.currentResultRef.current)(newChange, newBase)
  departed.setResultView(departed.makeView(newChange, 'navigated source'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(departed.calls.length, 2, 'current-view saves must not wait for an old receipt that may never arrive')
  assert.equal((await newSave)?.revision, 8)
  const epoch = departed.refs.graphCommitEpochRef.current
  releaseDeparted(outcome === 'success' ? { documentId: 'queue-fixture', revision: 2, graph: oldChange }
    : outcome === 'missing-receipt' ? null : { error: { code: 'revision_conflict', message: 'The old document changed in another session' } })
  assert.deepEqual(await Promise.all([oldSave, dependentSave]), [null, null],
    'departed callbacks cannot report success in the current view or dispatch their old dependent edits')
  assert.equal(departed.calls.length, 2)
  assert.equal(departed.refs.graphCommitEpochRef.current, epoch, 'an old failure must not invalidate the current queue')
  assert.equal(departed.refs.graphRevisionRef.current, 8, 'a same-document reload must not inherit an old receipt revision')
  assert.equal(departed.refs.currentResultRef.current.graph.summary, newChange.summary)
  assert.equal(departed.errors.length, 0, 'a departed save must not show its error in the current document')
  assert.equal(departed.history.length, 1, 'only the confirmed current-view edit may enter history')
  assert.equal(departed.operations.has(oldChange), false)
  assert.equal(departed.operations.has(dependentChange), false)
}
}

let releaseFailedNavigation
const navigationBarrier = new Promise(resolve => { releaseFailedNavigation = resolve })
const stayed = makeFixture('document', () => navigationBarrier)
const stayedChange = { ...stayed.base, summary: 'Unconfirmed old view edit' }
const stayedSave = stayed.makeCommit(stayed.refs.currentResultRef.current)(stayedChange, stayed.base)
stayed.setResultView(stayed.makeView(stayedChange, 'source'))
await new Promise(resolve => setImmediate(resolve))
assert.equal(await stayed.navigate({ ...stayed.base, source: { documentId: 'unavailable' } }, true), undefined)
assert.equal(stayed.refs.graphCommitEpochRef.current, 0, 'verification cancellation or a failed history load does not leave the current graph')
releaseFailedNavigation({ error: { code: 'revision_conflict', message: 'Current view save rejected' } })
await stayedSave
assert.equal(stayed.refs.currentResultRef.current.graph.summary, stayed.base.summary,
  'a failed navigation must retain current-save ownership so an optimistic edit still rolls back on failure')
assert.match(stayed.errors.at(-1).message, /Current view save rejected/)

console.log(JSON.stringify({ ok: true, workbenches: ['document', 'trajectory'], rejectedChainStopped: true,
  freshEditAllowed: true, successfulChainSerialized: true, unconfirmedWritesStopQueue: true,
  navigationQueueIsolation: true, sameDocumentReloadFenced: true, failedNavigationPreservesOwnership: true }))
