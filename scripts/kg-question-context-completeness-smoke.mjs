import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
function section(start, end) {
  const from = client.indexOf(start), to = client.indexOf(end, from)
  assert.ok(from >= 0 && to > from, start)
  return client.slice(from, to)
}
const helperSource = section('        const questionParagraphIndicesClient =', '        // End question context helpers.')
const helpers = new Function('splitParagraphs', 'MAX_VERIFY_SCOPE_CHARS', 'MAX_VERIFY_SCOPE_UNITS',
  helperSource + '; return { questionNeighborhoodGraph, verificationSourcePayload }')(
  text => text.split('\n\n').map(text => ({ text })), 240000, 2000)
const documentIdOfGraph = graph => graph?.source?.documentId || null
const signatures = new Function('documentIdOfGraph',
  section('      function verificationReportStale(', '      function paragraphTypeNodes(')
  + '; return { reviewContextSignature, buildReviewContextIndex, reviewIssueContextTarget, reviewIssueSignature }')(documentIdOfGraph)
const singleSource = section('        const submitQuestion = async (draftOverride, targetOverride, reviewIssue = null) => {',
  '        const saveBulkReview =')
const bulkSource = section('        const saveBulkReview =', '        const handleApplyIssue = async (issue, reviewedAgainstGraph) => {')
const edge = (fromNodeId, toNodeId) => ({ fromNodeId, toNodeId, relation: 'supports' })
const node = id => ({ id, type: 'fact', text: 'Source statement ' + id, quote: 'Source statement ' + id, paragraph: 0 })
const makeGraph = (nodes, edges) => ({ nodes: nodes.map(node), edges, revision: 3, source: { documentId: 'doc', revision: 3 } })
const issue = { id: 'comparison', targetKind: 'node', targetId: 'n1', status: 'open', title: 'Possible duplicate',
  detail: 'Compare n1 with n300 and inspect their relations.', evidence: [{ paragraph: 0, quote: 'Source statement' }] }
const targetFor = issue => ({ kind: issue.targetKind, id: issue.targetId })
const draftFor = issue => ('Independently verify this allegation: ' + issue.title + '. ' + issue.detail).slice(0, 600)
const digest = async text => createHash('sha256').update(text).digest('hex')
const hub = count => makeGraph(['n1', 'n2', 'n300', ...Array.from({ length: count }, (_, i) => 'n' + (400 + i))],
  [edge('n1', 'n2'), ...Array.from({ length: count }, (_, i) => edge('n300', 'n' + (400 + i)))])

async function single(graph, reviewIssue = issue, { truncated = false, question = draftFor(reviewIssue), review = true,
  sourceText: providedSource, workbench = 'document' } = {}) {
  const original = JSON.stringify(graph)
  const sourceText = providedSource ?? graph.nodes.map(item => item.text).join('. ')
  const canonical = { ...graph, verification: { lastReport: { reportId: 'report', issues: [reviewIssue] } } }
  const view = { graph: { ...canonical, ...(truncated ? { nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1),
    view: { truncated: true } } : {}) }, sourceText }
  const calls = [], states = [], questionAdmissionRef = { current: null }
  const env = { ...helpers, ...signatures, reviewSignatureHash: digest, setQuestionTarget() {},
    documentIdOfGraph, questionDraft: '', resultView: view, currentResultRef: { current: view },
    questionPhase: 'idle', questionTarget: null, bulkRunRef: { current: false }, verifyGenRef: { current: 0 },
    questionAdmissionRef, modelCatalog: { issueReview: true }, title: 'Fixture', fullText: sourceText, effectiveModelArg: null,
    graphCommitQueueRef: { current: Promise.resolve() }, graphCommitEpochRef: { current: 0 }, graphRevisionRef: { current: 3 },
    host: { call: async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'document-export') return { documentId: 'doc', revision: 3, graph: canonical, sourceText }
      assert.equal(method, 'question-graph')
      return { taskId: 'controlled-task' }
    } },
  }
  for (const name of ['setError', 'setQuestionError', 'setVerifyProgress', 'setQuestionPhase', 'setQuestionResult', 'setQuestionTaskId']) {
    env[name] = value => states.push({ name, value })
  }
  Object.assign(env, { view, currentViewRef: env.currentResultRef, trajCommitQueueRef: env.graphCommitQueueRef,
    trajCommitEpochRef: env.graphCommitEpochRef, trajRevisionRef: env.graphRevisionRef,
    sessionId: 'session', mountedSessionRef: { current: 'session' }, reviewSaveRef: { current: null } })
  const trajectoryStart = client.lastIndexOf('        const submitQuestion =')
  const code = workbench === 'trajectory'
    ? client.slice(trajectoryStart, client.indexOf('        const saveCanonicalIssueReview =', trajectoryStart)) : singleSource
  const submit = new Function(...Object.keys(env), code + '; return submitQuestion')(...Object.values(env))
  await submit(question, targetFor(reviewIssue), review ? reviewIssue : null)
  assert.equal(JSON.stringify(graph), original, 'selecting review context must never mutate canonical graph data')
  assert.equal(questionAdmissionRef.current, null, 'release the synchronous admission owner on success and failure')
  return { calls, states, requests: calls.filter(call => call.method === 'question-graph') }
}

// The target itself has one relation, but a distant comparison has 94. The old
// 96-node selector hid one comparison relation from the host's completeness gate.
const overflow = hub(94)
const red = await single(overflow)
assert.equal(red.requests.length, 0, 'never submit a silently truncated comparison neighborhood to the model')
assert.ok(red.states.find(state => state.name === 'setQuestionError' && state.value))
assert.equal(red.states.filter(state => state.name === 'setQuestionPhase').at(-1)?.value, 'idle')

const boundary = hub(93)
boundary.edges.push(edge('n491', 'n492'))
for (const truncated of [false, true]) {
  const accepted = await single(boundary, issue, { truncated })
  assert.equal(accepted.requests.length, 1, 'exactly 96 context nodes remain reviewable')
  assert.deepEqual(accepted.requests[0].payload.graph.nodes, boundary.nodes)
  assert.deepEqual(accepted.requests[0].payload.graph.edges, boundary.edges, 'retain induced neighbor relations too')
  if (truncated) assert.equal(accepted.calls[0]?.method, 'document-export')
  const rejected = await single(overflow, issue, { truncated })
  assert.equal(rejected.requests.length, 0, 'check the canonical union even when the displayed window is small')
}
for (const kind of ['edge', 'graph']) {
  const candidate = { ...issue, targetKind: kind, targetId: kind === 'edge' ? 'n1>n2' : null }
  assert.deepEqual((await single(boundary, candidate)).requests[0]?.payload.graph, {
    summary: '', nodes: boundary.nodes, edges: boundary.edges, ontology: undefined,
  }, kind + ': use the complete union at the supported boundary')
  assert.equal((await single(overflow, candidate)).requests.length, 0, kind + ': enforce the union budget, not only node-target degree')
}
assert.equal((await single({ ...overflow, edges: overflow.edges.slice().reverse() })).requests.length, 0,
  'edge ordering cannot decide which comparison evidence is silently dropped')

const small = hub(1)
const longIssue = { ...issue, title: 'Potential duplicate n1: ' + 'a'.repeat(150),
  detail: 'b'.repeat(430) + ' Compare with n300 before deciding.' }
assert.ok(!draftFor(longIssue).includes('n300') && longIssue.detail.length < 600)
const long = await single(small, longIssue)
assert.deepEqual(long.requests[0]?.payload.graph.nodes, small.nodes,
  'IDs beyond the shortened question still belong to the separately transmitted allegation')
const graphIssue = { ...longIssue, title: 'Potential duplicate: ' + 'a'.repeat(160),
  targetKind: 'graph', targetId: null, detail: 'b'.repeat(430) + ' Compare n1 with n300.' }
assert.ok(!/\b(?:n|m)\d+\b/.test(draftFor(graphIssue)))
const graphReview = await single(small, graphIssue, { truncated: true })
assert.equal(graphReview.calls[0]?.method, 'document-export', 'allegation-only node references must trigger canonical expansion')
assert.deepEqual(graphReview.requests[0]?.payload.graph.nodes, small.nodes)
const wholeGraphIssue = { ...issue, targetKind: 'graph', targetId: null,
  title: 'Summary may omit a qualification', detail: 'Check the entire summary.' }
const disconnected = { ...small, nodes: [...small.nodes, node('n9999')] }
for (const workbench of ['document', 'trajectory']) {
  for (const truncated of [false, true]) {
    const complete = await single(disconnected, wholeGraphIssue, { truncated, workbench })
    assert.equal(complete.calls[0]?.method, 'document-export', 'graph-wide allegations without named IDs load the canonical snapshot')
    assert.deepEqual(complete.requests[0]?.payload.graph.nodes, disconnected.nodes,
      workbench + ': an unconnected node may qualify the summary and must remain in the full graph')
  }
  const noIdOverflow = await single(overflow, wholeGraphIssue, { workbench, truncated: true })
  assert.equal(noIdOverflow.requests.length, 0, workbench + ': no named IDs does not bypass full-graph limits')
  assert.ok(noIdOverflow.states.some(state => state.name === 'setQuestionError' && /整图/.test(state.value)))
  for (const sourceText of ['Source statement\n\n' + 'x'.repeat(240001),
    Array.from({ length: 2001 }, (_, index) => 'Source ' + index).join('\n\n')]) {
    const overSource = await single(small, wholeGraphIssue, { sourceText, workbench })
    assert.equal(overSource.requests.length, 0, workbench + ': do not reduce complete source to anchored or lexical hits')
    assert.ok(overSource.states.some(state => state.name === 'setQuestionError' && /完整原文/.test(state.value)))
  }
}
assert.throws(() => helpers.questionNeighborhoodGraph({ ...small, view: { truncated: true } }, '',
  targetFor(wholeGraphIssue), wholeGraphIssue), /完整知识图/, 'known partial graph without canonical expansion must fail closed')
const repeated = { ...issue, title: 'n1 '.repeat(24), detail: 'Compare with n300.' }
assert.deepEqual((await single(small, repeated)).requests[0]?.payload.graph.nodes, small.nodes,
  'repeated mentions must not spend the unique comparison-ID budget')

const dense = makeGraph(['n1', ...Array.from({ length: 32 }, (_, i) => 'n' + (100 + i))], [])
const relations = dense.nodes.slice(1).flatMap(from => dense.nodes.slice(1)
  .filter(to => from !== to).map(to => edge(from.id, to.id)))
dense.edges = [...dense.nodes.slice(1).map(item => edge('n1', item.id)), ...relations.slice(0, 480)]
const plainIssue = { ...issue, detail: 'Verify the target and its complete neighborhood.' }
assert.equal((await single(dense, plainIssue)).requests[0]?.payload.graph.edges.length, 512)
const references = makeGraph(Array.from({ length: 25 }, (_, i) => 'n' + (i + 1)), [])
assert.equal((await single(references, { ...issue, detail: references.nodes.slice(0, 24).map(item => item.id).join(' ') }))
  .requests[0]?.payload.graph.nodes.length, 24)

for (const [label, graph, candidate] of [
  ['dense induced edges', { ...dense, edges: [...dense.edges, relations[480]] }, plainIssue],
  ['missing comparison', small, { ...issue, detail: 'Compare with n9999.' }],
  ['dangling comparison relation', { ...small, edges: [...small.edges, edge('n300', 'n9999')] }, issue],
  ['too many named comparisons', references, { ...issue, detail: references.nodes.map(item => item.id).join(' ') }],
  ['edge endpoint neighborhood', makeGraph([...overflow.nodes.map(item => item.id), 'n9999'],
    [...overflow.edges.map(item => item.fromNodeId === 'n300' ? { ...item, fromNodeId: 'n2' } : item), edge('n2', 'n9999')]),
    { ...plainIssue, targetKind: 'edge', targetId: 'n1>n2' }],
]) {
  assert.equal((await single(graph, candidate)).requests.length, 0, label + ': fail before model admission')
}
assert.ok((await single(overflow, issue, { review: false })).requests[0]?.payload.graph.nodes.length <= 96,
  'ordinary exploratory questions keep their bounded retrieval behavior')

async function bulk(graph, candidates, checkpoint = {}, sourceText = 'Source statement') {
  const report = { reportId: 'report', issues: candidates }
  const canonical = { ...graph, verification: { lastReport: report } }
  const view = { graph: canonical, sourceText }, calls = [], states = []
  const env = { ...helpers, ...signatures, documentIdOfGraph, resultView: view, currentResultRef: { current: view },
    verificationRef: { current: report }, bulkRunRef: { current: false }, bulkStopRef: { current: false },
    bulkActiveTaskRef: { current: null }, asAllNodesGraph: graph => graph, reviewSignatureHash: digest,
    title: 'Fixture', MAX_VERIFY_NODES: 800, setBulkReview: state => states.push(state),
    localStorage: { setItem() {} }, toastStore: { show() {} }, bulkReviewStorageKey: documentId => documentId,
    host: { call: async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'document-export') return { documentId: 'doc', revision: 3, graph: canonical, sourceText }
      if (method === 'question-graph') return { taskId: payload.reviewIssue.id }
      assert.equal(method, 'task-status')
      return { status: 'succeeded', result: { mode: 'issue_review', reviewedIssueId: payload.taskId,
        verdict: 'uncertain', answer: 'Controlled result', proposedFix: { action: 'none' } } }
    } },
  }
  const run = new Function(...Object.keys(env), bulkSource + '; return runBulkReview')(...Object.values(env))
  await run({ documentId: 'doc', reportId: 'report', issueIds: candidates.map(item => item.id), rows: [], ...checkpoint })
  return { calls, state: states.at(-1) }
}
const batch = await bulk(overflow, [issue, { ...plainIssue, id: 'next' }])
assert.equal(batch.state.phase, 'ready', 'an over-budget issue must not strand unrelated batch issues')
assert.equal(batch.state.rows.length, 2)
assert.ok(batch.state.rows[0].error)
assert.equal(batch.state.rows[0].verdict, undefined, 'no AI verdict exists for context rejected before admission')
assert.equal(batch.state.rows[1].verdict, 'uncertain')
assert.deepEqual(batch.calls.filter(call => call.method === 'question-graph').map(call => call.payload.reviewIssue.id), ['next'])
assert.equal(batch.calls.filter(call => call.method === 'graph-commit').length, 0)
const longBatch = await bulk(small, [longIssue])
assert.equal(longBatch.state.phase, 'ready')
assert.deepEqual(longBatch.calls.find(call => call.method === 'question-graph')?.payload.graph.nodes, small.nodes)
const inFlight = await bulk(overflow, [issue, { ...plainIssue, id: 'next' }], {
  sourceHash: await digest('Source statement'), activeTaskId: 'previous-task', activeContextHash: 'previous-context',
})
assert.equal(inFlight.state.phase, 'paused', 'do not lose an existing task when stronger context checks reject its old scope')
assert.equal(inFlight.state.activeTaskId, 'previous-task')
assert.equal(inFlight.state.activeContextHash, 'previous-context')
assert.equal(inFlight.state.rows.length, 0)
assert.deepEqual(inFlight.calls.map(call => call.method), ['document-export'], 'never automatically replace or cancel the original task')
const sourceOverflow = hub(1)
sourceOverflow.nodes.find(node => node.id === 'n300').paragraph = 1
const largeSource = 'Source statement\n\n' + 'x'.repeat(240001)
for (const workbench of ['document', 'trajectory']) {
  const blocked = await single(sourceOverflow, issue, { sourceText: largeSource, workbench })
  assert.equal(blocked.requests.length, 0, workbench + ': reject incomplete source before model admission')
  assert.ok(blocked.states.some(state => state.name === 'setQuestionError' && /原文/.test(state.value)))
}
const sourceBatch = await bulk(sourceOverflow, [issue, { ...plainIssue, id: 'source-next', targetId: 'n2' }], {}, largeSource)
assert.equal(sourceBatch.state.phase, 'ready', 'an oversized source issue must not pause all independent batch issues')
assert.equal(sourceBatch.state.rows.length, 2)
assert.match(sourceBatch.state.rows[0].error, /原文/)
assert.equal(sourceBatch.state.rows[0].verdict, undefined)
assert.equal(sourceBatch.state.rows[1].verdict, 'uncertain')
assert.deepEqual(sourceBatch.calls.filter(call => call.method === 'question-graph').map(call => call.payload.reviewIssue.id), ['source-next'])
const sourceInFlight = await bulk(sourceOverflow, [issue], {
  sourceHash: await digest(largeSource), activeTaskId: 'old-source-task', activeContextHash: 'old-source-context',
}, largeSource)
assert.equal(sourceInFlight.state.phase, 'paused')
assert.equal(sourceInFlight.state.activeTaskId, 'old-source-task')
assert.equal(sourceInFlight.state.activeContextHash, 'old-source-context')
assert.deepEqual(sourceInFlight.calls.map(call => call.method), ['document-export'])
const graphBatch = await bulk(overflow, [wholeGraphIssue, { ...plainIssue, id: 'graph-next' }])
assert.equal(graphBatch.state.phase, 'ready')
assert.match(graphBatch.state.rows[0].error, /整图/)
assert.equal(graphBatch.state.rows[0].verdict, undefined)
assert.equal(graphBatch.state.rows[1].verdict, 'uncertain')
assert.deepEqual(graphBatch.calls.filter(call => call.method === 'question-graph').map(call => call.payload.reviewIssue.id), ['graph-next'])
const graphSourceBatch = await bulk(small, [wholeGraphIssue, { ...plainIssue, id: 'graph-source-next' }], {}, largeSource)
assert.equal(graphSourceBatch.state.phase, 'ready')
assert.match(graphSourceBatch.state.rows[0].error, /完整原文/)
assert.equal(graphSourceBatch.state.rows[1].verdict, 'uncertain', 'a graph-wide source failure must not stop narrower independent issues')
assert.equal(graphSourceBatch.calls.filter(call => call.method === 'graph-commit').length, 0)
const graphInFlight = await bulk(overflow, [wholeGraphIssue], {
  sourceHash: await digest('Source statement'), activeTaskId: 'graph-task', activeContextHash: 'graph-context',
})
assert.equal(graphInFlight.state.phase, 'paused')
assert.equal(graphInFlight.state.activeTaskId, 'graph-task')
assert.equal(graphInFlight.state.activeContextHash, 'graph-context')
assert.deepEqual(graphInFlight.calls.map(call => call.method), ['document-export'], 'do not replace an in-flight task rejected by full-context requirements')
console.log('question context completeness: single/bulk canonical unions, long allegations, missing endpoints and exact budgets passed')
