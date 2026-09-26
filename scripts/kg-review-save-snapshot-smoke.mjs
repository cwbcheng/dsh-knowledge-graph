import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const section = (from, to) => {
  const start = client.indexOf(from), end = client.indexOf(to, start)
  assert.ok(start >= 0 && end > start, from)
  return client.slice(start, end)
}
const documentIdOfGraph = graph => graph?.source?.documentId || null
const helpers = new Function('documentIdOfGraph',
  section('      function withVerification(', '      function paragraphTypeNodes(')
  + section('      function updateIssueStatus(', '      function batchSafeFix(')
  + '; return { withVerification, verificationReportStale, archivedIssueNeedsFreshReview, reviewContextSignature, reviewContextChanged, reviewIssueContextTarget, reviewIssueSignature, updateIssueStatus, recordReviewedFix }')(documentIdOfGraph)
const scope = new Function('splitParagraphs', 'MAX_VERIFY_SCOPE_CHARS', 'MAX_VERIFY_SCOPE_UNITS',
  section('        const questionParagraphIndicesClient =', '        // End question context helpers.')
  + '; return { questionNeighborhoodGraph, verificationSourcePayload }')(text => text.split('\n\n').map(text => ({ text })), 240000, 2000)
const submitSource = section('        const submitQuestion = async (draftOverride, targetOverride, reviewIssue = null) => {', '        const saveBulkReview =')
const saveStart = client.includes('        const saveCanonicalIssueReview =') ? '        const saveCanonicalIssueReview =' : '        const handleApplyIssue ='
const saveSource = section(saveStart, '        const handleApplyAll =')
const rejectSource = section('        const handleRejectIssue = async (issue, note', '        const handleRecheckIssue =')
const attachSource = section('        const attachReport =', '        const startQuickVerify =')
const hash = async value => createHash('sha256').update(value).digest('hex')
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const candidate = { id: 'issue-1', targetKind: 'node', targetId: 'n0', status: 'open', source: 'ai', severity: 'error',
  title: 'Missing quotation', detail: 'Check n0 against n801.', evidence: [{ paragraph: 0, quote: 'Source 0' }] }
const fix = { ...candidate, source: 'issue_review', detail: 'Controlled verified repair',
  proposedFix: { action: 'update_node', nodePatch: { id: 'n0', patch: { quote: 'Source 0' } } } }

function makeFixture(decision, workbench = 'document') {
  const trajectory = workbench === 'trajectory'
  const trajectorySource = client.slice(client.indexOf('      function TrajectoryTab('))
  const trajSection = (from, to) => {
    const start = trajectorySource.indexOf(from), end = trajectorySource.indexOf(to, start)
    assert.ok(start >= 0 && end > start)
    return trajectorySource.slice(start, end)
  }
  const submitCode = trajectory ? trajSection('        const submitQuestion =', '        const saveCanonicalIssueReview =') : submitSource
  const saveCode = trajectory ? trajSection('        const saveCanonicalIssueReview =', '        const handleApplyAll =') : saveSource
  const rejectCode = trajectory ? trajSection('        const handleRejectIssue =', '        const handleRecheckIssue =') : rejectSource
  const attachCode = trajectory ? trajSection('        const attachTrajReport =', '        const startQuickVerify =') : attachSource
  let canonical = { revision: 1, source: { documentId: 'doc', revision: 1 },
    nodes: Array.from({ length: 803 }, (_, i) => ({ id: 'n' + i, type: 'fact', text: 'Source ' + i, quote: i ? 'Source ' + i : '', paragraph: i })),
    edges: [{ fromNodeId: 'n0', toNodeId: 'n801', relation: 'supports' }],
    verification: { lastReport: { reportId: 'report', issues: [structuredClone(candidate),
      { ...structuredClone(candidate), id: 'issue-2', targetId: 'n700' }], stale: true } } }
  let sourceText = canonical.nodes.map(node => node.text).join('\n\n')
  const calls = [], states = [], writes = []
  const projection = () => ({ ...structuredClone(canonical), nodes: structuredClone(canonical.nodes.slice(0, 800)), edges: [],
    view: { kind: 'window', truncated: true, nodeOffset: 0, nodeLimit: 800 } })
  const env = { ...helpers, ...scope, documentIdOfGraph, reviewSignatureHash: hash,
    questionDraft: '', questionPhase: 'idle', questionTarget: null, fullText: sourceText, title: 'Fixture', effectiveModelArg: null,
    modelCatalog: { issueReview: true }, bulkRunRef: { current: false }, questionAdmissionRef: { current: null },
    verifyGenRef: { current: 0 }, verifyBusyRef: { current: false }, graphRevisionRef: { current: 1 }, graphCommitQueueRef: { current: Promise.resolve() },
    graphCommitEpochRef: { current: 0 }, currentResultRef: { current: null }, verificationRef: { current: canonical.verification.lastReport },
    setQuestionTarget: update => { env.questionTarget = typeof update === 'function' ? update(env.questionTarget) : update },
    toastStore: { show: message => states.push(['toast', message]) },
    applyPatch: (graph, issue) => ({ ...graph, nodes: graph.nodes.map(node => node.id === issue.targetId
      ? { ...node, ...issue.proposedFix.nodePatch.patch } : node) }),
    patchAlreadySatisfied: () => false,
    asAllNodesGraph: graph => ({ ...graph, view: { kind: 'all', truncated: false } }),
    graphViewMetadata: graph => graph.view,
    makeView: (graph, sourceText) => ({ graph, sourceText }),
  }
  for (const name of ['setError', 'setQuestionError', 'setVerifyProgress', 'setQuestionPhase', 'setQuestionResult', 'setQuestionTaskId',
    'setVerification', 'setActiveIssueId', 'setSelectedNodeId', 'setSelectedEdgeId', 'setFullText', 'setReviewSaving']) {
    env[name] = value => states.push([name, value])
  }
  const refresh = () => {
    env.resultView = { graph: projection(), sourceText }
    env.currentResultRef.current = env.resultView
    env.graphRevisionRef.current = canonical.revision
    env.verification = canonical.verification.lastReport
    env.verificationRef.current = env.verification
  }
  refresh()
  env.setResultView = update => {
    env.currentResultRef.current = typeof update === 'function' ? update(env.currentResultRef.current) : update
    states.push(['view', env.currentResultRef.current])
  }
  let readBarrier = null, onWrite = null, failRefresh = false
  env.host = { call: async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'document-export') {
      if (readBarrier) await readBarrier.promise
      return { documentId: 'doc', revision: canonical.revision, graph: structuredClone(canonical), sourceText }
    }
    assert.equal(method, 'question-graph')
    return { taskId: 'controlled-task' }
  } }
  env.loadGraphDocument = async () => failRefresh ? { error: { message: 'Fixture refresh failed' } }
    : { documentId: 'doc', revision: canonical.revision, graph: projection(), sourceText }
  env.persistGraph = async (graph, baseline, revision) => {
    if (revision == null) revision = env.graphRevisionRef.current
    writes.push({ graph, baseline, revision })
    if (onWrite) await onWrite()
    if (revision !== canonical.revision) return null
    canonical = { ...graph, revision: revision + 1, source: { ...graph.source, revision: revision + 1 } }
    return { documentId: 'doc', revision: canonical.revision, graph: projection() }
  }
  env.commitGraph = async graph => { writes.push({ legacy: true, graph }); return { revision: canonical.revision + 1 } }
  env.sessionId = 'session'
  env.mountedSessionRef = { current: 'session' }
  env.traceEvents = []
  env.writeTrajResult = (...args) => states.push(['trajectoryCache', args])
  for (const [name, source] of Object.entries({ view: 'resultView', currentViewRef: 'currentResultRef',
    trajRevisionRef: 'graphRevisionRef', trajCommitQueueRef: 'graphCommitQueueRef', trajCommitEpochRef: 'graphCommitEpochRef',
    reviewSaveRef: 'bulkRunRef', setView: 'setResultView', persistTrajGraph: 'persistGraph', commitTrajGraph: 'commitGraph' })) {
    Object.defineProperty(env, name, { enumerable: true, get: () => env[source] })
  }
  env.showToast = env.toastStore.show
  const compile = (source, name) => {
    const keys = Object.keys(env).filter(key => key !== name)
    return new Function(...keys, source + '; return ' + name)(...keys.map(key => env[key]))
  }
  env.attachReport = (...args) => compile(attachCode, trajectory ? 'attachTrajReport' : 'attachReport')(...args)
  env.attachTrajReport = env.attachReport
  const review = async () => {
    const target = { ...helpers.reviewIssueContextTarget(candidate), sourceIssueId: candidate.id }
    target.reviewSignature = helpers.reviewContextSignature(env.resultView.graph, target)
    env.questionTarget = target
    await compile(submitCode, 'submitQuestion')('Check n0 against n801.', target, candidate)
  }
  const apply = () => decision === 'false_positive'
    ? compile(saveCode + rejectCode, 'handleRejectIssue')(candidate, 'Controlled false positive decision',
        env.questionTarget?.reviewSnapshot || env.questionTarget?.reviewSignature)
    : compile(saveCode, 'handleApplyIssue')(fix, env.questionTarget?.reviewSnapshot || env.questionTarget?.reviewSignature)
  const change = mutate => {
    mutate(canonical)
    canonical.revision++; canonical.source.revision = canonical.revision
    refresh()
  }
  const ignore = () => compile(saveCode + rejectCode, 'handleRejectIssue')(candidate)
  return { env, calls, states, writes, review, apply, ignore, change, refresh, graph: () => canonical,
    setSource: text => { sourceText = text }, setReadBarrier: value => { readBarrier = value },
    setOnWrite: value => { onWrite = value }, setFailRefresh: value => { failRefresh = value } }
}

for (const workbench of ['document', 'trajectory']) {
for (const decision of ['repair', 'false_positive']) {
  const fixture = () => makeFixture(decision, workbench)
  const resolvedStatus = decision === 'repair' ? 'applied' : 'rejected'
  const resolvedQuote = decision === 'repair' ? 'Source 0' : ''
  // Refreshing the same 800-node window advances the revision without exposing a
  // changed dependency at n801. A visible-window signature cannot authorize it.
  const stale = fixture()
  await stale.review()
  stale.change(graph => { graph.nodes[801].text = 'Changed comparison outside the window' })
  await stale.apply()
  assert.equal(stale.writes.length, 0, decision + ': an off-window dependency change must reject the old decision even after the page learns the latest revision')
  assert.ok(stale.states.some(([name, value]) => name === 'setQuestionError' && value))

  const unchanged = fixture()
  await unchanged.review()
  unchanged.states.length = 0
  assert.ok(unchanged.env.questionTarget.reviewSnapshot, 'bind the actual canonical review context, not just the renderer projection')
  unchanged.change(graph => {
    graph.nodes[700].text = 'An unrelated edit'
    graph.verification.lastReport.issues[1].status = 'applied'
  })
  await unchanged.apply()
  assert.equal(unchanged.writes.length, 1, 'an unrelated edit must not require spending another model request')
  assert.equal(unchanged.writes[0].revision, 2, 'pin the checked canonical revision for compare-and-swap')
  assert.equal(unchanged.graph().nodes[0].quote, resolvedQuote)
  assert.equal(unchanged.graph().nodes[700].text, 'An unrelated edit')
  assert.equal(unchanged.graph().verification.lastReport.issues[0].status, resolvedStatus)
  assert.equal(unchanged.graph().verification.lastReport.issues[1].status, 'applied', 'preserve other resolved issues in the canonical report')
  if (decision === 'false_positive') {
    assert.deepEqual(unchanged.writes[0].graph.nodes, unchanged.writes[0].baseline.nodes, 'a dismissal cannot apply any node patch')
    assert.deepEqual(unchanged.writes[0].graph.edges, unchanged.writes[0].baseline.edges, 'a dismissal cannot change relationships')
    assert.equal(unchanged.graph().verification.lastReport.issues[0].userNote, 'Controlled false positive decision')
  }
  assert.equal(unchanged.env.currentResultRef.current.graph.view.kind, 'window')
  assert.equal(unchanged.env.currentResultRef.current.graph.nodes.length, 800)
  assert.equal(unchanged.calls.filter(call => call.method === 'question-graph').length, 1)
  assert.ok(unchanged.states.some(([name, value]) => name === 'setError' && value === null),
    'a confirmed save and readback must clear the previous failed-write banner')

  const freshReport = fixture()
  freshReport.graph().verification.lastReport.stale = false
  await freshReport.review()
  await freshReport.apply()
  assert.equal(freshReport.graph().verification.lastReport.stale, decision === 'repair',
    'only a graph mutation makes a fresh report stale; dismissal preserves its coverage state')
  assert.equal(freshReport.graph().verification.stale, decision === 'repair')

  for (const change of ['source', 'issue', 'report', 'resolved', 'relation']) {
    const changed = fixture()
    await changed.review()
    changed.change(graph => {
      if (change === 'source') changed.setSource('Different source with a new meaning')
      if (change === 'issue') graph.verification.lastReport.issues[0].detail = 'A different allegation'
      if (change === 'report') graph.verification.lastReport.reportId = 'replacement-report'
      if (change === 'resolved') graph.verification.lastReport.issues[0].status = 'rejected'
      if (change === 'relation') graph.edges[0].relation = 'contradicts'
    })
    await changed.apply()
    assert.equal(changed.writes.length, 0, change + ': an old review cannot authorize changed evidence, allegation, or relations')
  }
  const legacy = fixture()
  await legacy.review()
  delete legacy.env.questionTarget.reviewSnapshot
  await legacy.apply()
  assert.equal(legacy.writes.length, 0, 'do not silently trust pre-upgrade window-only review signatures')

  const delayed = fixture()
  await delayed.review()
  const barrier = deferred()
  delayed.setReadBarrier(barrier)
  const first = delayed.apply(), duplicate = delayed.apply()
  await tick()
  assert.equal(delayed.calls.filter(call => call.method === 'document-export').length, 2, 'deduplicate confirmation before React rerenders')
  delayed.env.currentResultRef.current = { graph: { source: { documentId: 'other' } } }
  barrier.resolve()
  await Promise.all([first, duplicate])
  assert.equal(delayed.writes.length, 0, 'navigation during canonical validation must not submit a repair for the old page')
  assert.ok(!delayed.env.bulkRunRef.current)

  if (workbench === 'trajectory') {
    const departed = fixture()
    await departed.review()
    const barrier = deferred()
    departed.setReadBarrier(barrier)
    const saving = departed.apply()
    await tick()
    departed.env.mountedSessionRef.current = 'new-session'
    departed.env.verifyGenRef.current++
    const newOwner = {}
    departed.env.reviewSaveRef.current = newOwner
    const eventCount = departed.states.length
    barrier.resolve()
    await saving
    assert.equal(departed.writes.length, 0, 'leaving the session must stop before a repair is dispatched')
    assert.equal(departed.env.reviewSaveRef.current, newOwner, 'old cleanup cannot release a newer session save lock')
    assert.equal(departed.states.length, eventCount, 'late validation cannot alter the new session state')
  }

  for (const change of ['queue', 'failed-write']) {
    const changed = fixture()
    await changed.review()
    const barrier = deferred()
    changed.setReadBarrier(barrier)
    const saving = changed.apply()
    await tick()
    if (change === 'queue') changed.env.graphCommitQueueRef.current = Promise.resolve()
    else changed.env.graphCommitEpochRef.current++
    barrier.resolve()
    await saving
    assert.equal(changed.writes.length, 0, change + ': stop when the accepted write boundary changes during the read')
  }
  for (const [label, damage] of [
    ['foreign document', loaded => { loaded.documentId = 'other' }],
    ['partial export', loaded => { loaded.graph.view = { truncated: true } }],
    ['missing revision', loaded => { delete loaded.revision }],
    ['source revision mismatch', loaded => { loaded.graph.source.revision++ }],
  ]) {
    const malformed = fixture()
    await malformed.review()
    const originalCall = malformed.env.host.call
    malformed.env.host.call = async (...args) => { const loaded = await originalCall(...args); damage(loaded); return loaded }
    await malformed.apply()
    assert.equal(malformed.writes.length, 0, label + ': malformed snapshots never authorize a commit')
  }

  const leftAfterWrite = fixture()
  await leftAfterWrite.review()
  const writeBarrier = deferred()
  leftAfterWrite.setOnWrite(() => writeBarrier.promise)
  const saving = leftAfterWrite.apply()
  await tick()
  assert.equal(leftAfterWrite.writes.length, 1)
  assert.equal(leftAfterWrite.states.filter(([name]) => name === 'setVerification').length, 0,
    'do not mark an issue resolved before the store confirms the write')
  const foreignView = { graph: { source: { documentId: 'other' } } }
  leftAfterWrite.env.currentResultRef.current = foreignView
  writeBarrier.resolve()
  await saving
  assert.equal(leftAfterWrite.graph().nodes[0].quote, resolvedQuote, 'a dispatched authorized commit may complete after navigation')
  assert.equal(leftAfterWrite.graph().verification.lastReport.issues[0].status, resolvedStatus)
  assert.equal(leftAfterWrite.env.currentResultRef.current, foreignView, 'its completion must not replace the new document')

  const raced = fixture()
  await raced.review()
  raced.states.length = 0
  raced.setOnWrite(() => raced.change(graph => { graph.nodes[801].text = 'Concurrent change after the validation read' }))
  await raced.apply()
  assert.equal(raced.writes.length, 1)
  assert.equal(raced.writes[0].revision, 1)
  assert.equal(raced.graph().nodes[0].quote, '', 'CAS rejection must not be presented or stored as an applied repair')
  assert.equal(raced.graph().verification.lastReport.issues[0].status, 'open')
  assert.ok(raced.states.some(([name, value]) => name === 'setQuestionError' && value))
  assert.equal(raced.states.some(([name, value]) => name === 'setError' && value === null), false,
    'a rejected commit must keep its failure banner')

  const refreshFailed = fixture()
  await refreshFailed.review()
  refreshFailed.setFailRefresh(true)
  await refreshFailed.apply()
  assert.equal(refreshFailed.graph().verification.lastReport.issues[0].status, resolvedStatus)
  assert.ok(refreshFailed.states.some(([name, value]) => name === 'setQuestionError' && /已保存/.test(value)),
    'a successful commit followed by failed refresh must not be reported as an uncommitted repair')
  assert.ok(!refreshFailed.env.bulkRunRef.current)
}
const ignored = makeFixture('false_positive', workbench)
await ignored.ignore()
assert.equal(ignored.writes.length, 1, 'manual ignore does not claim an AI verdict and remains independent of review snapshots')
assert.equal(ignored.calls.length, 0, 'manual ignore must not start a model or canonical review')
}
console.log('document/trajectory review repair/dismissal snapshots: hidden dependencies, unrelated edits, source/report identity, CAS and navigation passed')
