import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getOntology } from '../src/kg-ontology.mjs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const neighborhoodStart = client.indexOf('        const questionNeighborhoodGraph = ')
const neighborhoodEnd = client.indexOf('        const startQuickVerify = ', neighborhoodStart)
assert(neighborhoodStart >= 0 && neighborhoodEnd > neighborhoodStart)
const questionNeighborhoodGraph = new Function(client.slice(neighborhoodStart, neighborhoodEnd) + '; return questionNeighborhoodGraph')()
const focused = questionNeighborhoodGraph({ nodes: [
  { id: 'n2052', type: 'concept' }, { id: 'n2087', type: 'feature_description' }, { id: 'n2080', type: 'rule' },
  { id: 'n9999', type: 'rule' },
], edges: [
  { fromNodeId: 'n2052', toNodeId: 'n2087', relation: 'maps_between' },
  { fromNodeId: 'n2080', toNodeId: 'n2087', relation: 'composes' },
] }, 'n2052 与旧报告中不存在的 n2082', { kind: 'graph' })
assert.deepEqual(focused.nodes.map(node => node.id), ['n2052', 'n2087'])
assert.equal(focused.edges.length, 1, 'the canonical neighborhood must retain the actual disputed edge')
assert.equal(questionNeighborhoodGraph({ nodes: [{ id: 'n1' }], edges: [] }, '复核 n9999', { kind: 'graph' }).nodes.length, 0,
  'hallucinated node IDs must not fall back to sending the whole canonical graph')
const largeGraph = { nodes: Array.from({ length: 5000 }, (_, index) => ({ id: 'n' + (index + 1) })),
  edges: Array.from({ length: 4999 }, (_, index) => ({ fromNodeId: 'n1', toNodeId: 'n' + (index + 2), relation: 'supports' })) }
const bounded = questionNeighborhoodGraph(largeGraph, '复核 n1', { kind: 'graph' })
assert(bounded.nodes.length <= 96 && bounded.edges.length <= 95, 'a hub node cannot reintroduce body-too-large requests')
assert.equal(largeGraph.nodes.length, 5000, 'building a question neighborhood must not mutate canonical data')
assert(client.includes("host.call('document-export', { documentId })") && client.includes('questionGraph = questionNeighborhoodGraph(questionGraph, retrievalQuery, target)'),
  'questioning an off-window issue must load canonical context before making a bounded model request')
const host = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const contextStart = host.indexOf('      function buildQuestionContext(')
const contextEnd = host.indexOf('      function normalizeQuestionResult(', contextStart)
assert(contextStart >= 0 && contextEnd > contextStart)
const buildQuestionContext = new Function('splitParagraphsOffsetsHost', 'resolveAnchorHost', 'paragraphIndexOfOffset',
  host.slice(contextStart, contextEnd) + '; return buildQuestionContext')(
  () => Array.from({ length: 8 }, (_, index) => ({ text: '原文段落 ' + index })), () => null, () => null)
const contextGraph = { ...focused, nodes: focused.nodes.map((node, index) => ({ ...node, paragraph: index ? 6 : 2 })) }
const questionContext = buildQuestionContext(contextGraph,
  '原文', { kind: 'graph' }, '核对 n2052 的错误映射', null)
assert.deepEqual(questionContext.sub.nodes.map(node => node.id), ['n2052', 'n2087'],
  'explicit node references must bring their incident neighbors into the model subgraph')
assert.equal(questionContext.sub.edges.length, 1)
assert.equal(buildQuestionContext(contextGraph, '原文', { kind: 'node', id: 'n2052' }, '节点是否误标？').sub.edges.length, 1,
  'a node challenge must see incident edges even when their other endpoint is several paragraphs away')

const panelStart = client.indexOf('      function VerificationPanel(')
const panelEnd = client.indexOf('      function ', panelStart + 10)
assert(panelStart >= 0 && panelEnd > panelStart)
const panel = client.slice(panelStart, panelEnd)
assert(panel.indexOf('questionContent,') < panel.indexOf("className: 'kg-verify-filters'"),
  'question and its feedback must appear before a potentially long issue list')
assert.equal((panel.match(/className: 'kg-question-bar'/g) || []).length, 1)
assert(panel.includes("className: 'kg-question-progress', role: 'status'"))
assert(panel.includes("className: 'kg-question-error', role: 'alert'"))
assert(panel.includes("className: 'kg-question-result', role: 'status'"))
assert(panel.includes('questionFeedbackRef.current?.scrollIntoView'),
  'completed feedback must be brought into the visible scroll region')
assert(panel.includes("'拟议修改：' + fixLabel(qFix)") && panel.includes("+ fixLabel(it.proposedFix)"),
  'question and review fixes must show the actual mutation before acceptance')
assert(panel.includes("['delete_node', 'delete_edge', 'merge_nodes'].includes(action)")
  && panel.includes('if (pendingDestructiveFix !== key) { setPendingDestructiveFix(key); return }')
  && panel.includes('再次点击确认'),
  'destructive fixes must require an accessible second click without a blocking native dialog')
assert(panel.includes('disabled: bulkRunning || reviewGraphChanged || qFixConflicts.length > 0'),
  'a type fix that would invalidate an incident relation must not be clickable')
assert(panel.includes("qVerdict === 'false_positive' && recheckedIssue")
  && panel.includes("'标记原问题为误报'") && panel.includes("'处理说明：' + it.userNote"),
  'a recheck disproving an issue must offer a traceable dismissal rather than leaving it open')
assert(panel.includes("'AI 核实：问题成立'") && panel.includes("'确认修复并保存'")
  && panel.includes("'AI 核实问题'") && panel.includes('questionResult.reviewedIssueId === questionTarget?.sourceIssueId'),
  'issue review must distinguish the AI verdict from a user-confirmed graph repair')
assert(panel.includes("id: questionTarget?.sourceIssueId || 'qfix-' + Date.now()"),
  'a fix proposed by rechecking an issue must resolve that original issue')
assert(panel.includes("disabled: questionPhase === 'running' || bulkRunning, onClick: (e) => { e.stopPropagation(); onRecheckIssue(it) }"),
  'a second recheck cannot replace the target of a running question')
assert(panel.includes('shown.slice(0, issueLimit).map((it) => {') && panel.includes('显示更多问题（已显示 '),
  'a large verification report must not render every issue card on each interaction')
assert(panel.includes('shown.findIndex(issue => issue.id === activeIssueId)'),
  'jumping to a selected issue must reveal it even when it is beyond the initial page')
assert(panel.includes('无需重新跑完整审校') && panel.includes('可批量或逐项 AI 核实')
  && panel.includes('旧补丁不能直接采纳'),
  'a stale full-graph report must remain an actionable issue queue without implying a full rerun')
assert(panel.includes('const reportStale = verificationReportStale(report, graph)')
  && panel.includes('disabled: bulkRunning || reportStale || nodeTypeFixConflicts(graph, it.proposedFix).length > 0')
  && panel.includes("disabled: bulkRunning || reportStale, title: reportStale ? '旧报告的修复需先对当前图重新核实'"),
  'archived AI and deterministic proposals must not be directly applied to a changed graph')
const staleStart = client.indexOf('      function verificationReportStale(')
const staleEnd = client.indexOf('      function paragraphTypeNodes(', staleStart)
assert(staleStart >= 0 && staleEnd > staleStart)
const { verificationReportStale, archivedIssueNeedsFreshReview, reviewContextChanged, reviewContextSignature, buildReviewContextIndex, reviewIssueContextTarget } =
  new Function('documentIdOfGraph', client.slice(staleStart, staleEnd)
    + '; return { verificationReportStale, archivedIssueNeedsFreshReview, reviewContextChanged, reviewContextSignature, buildReviewContextIndex, reviewIssueContextTarget }')(
    graph => graph?.source?.documentId || null)
assert.equal(verificationReportStale({ createdAt: 100 }, { verification: { auditLog: [{ ts: 99 }] } }), false)
assert.equal(verificationReportStale({ createdAt: 100 }, { verification: { auditLog: [{ ts: 101 }] } }), true)
const afterFirstRepair = { createdAt: 100, stale: true, issues: [
  { id: 'issue-1', status: 'applied', source: 'ai' },
  { id: 'issue-2', status: 'open', source: 'ai' },
] }
const currentGraph = { verification: { auditLog: [{ ts: 101 }] } }
assert.equal(verificationReportStale(afterFirstRepair, currentGraph), true)
assert.equal(afterFirstRepair.issues.filter(issue => issue.status === 'open').length, 1,
  'repairing one issue must preserve the remaining issue queue')
assert.equal(archivedIssueNeedsFreshReview(afterFirstRepair, currentGraph, afterFirstRepair.issues[1]), true,
  'the next issue cannot apply an old proposed patch directly')
assert.equal(archivedIssueNeedsFreshReview(afterFirstRepair, currentGraph,
  { ...afterFirstRepair.issues[1], source: 'issue_review' }), false,
  'a newly reviewed repair for the same issue remains available after the first edit')
assert.equal(archivedIssueNeedsFreshReview(afterFirstRepair, currentGraph,
  { id: 'fresh-question', source: 'question' }), false,
  'fresh questions must not be mistaken for old report proposals')
const reviewBase = { source: { documentId: 'doc', sourceId: 'source' }, summary: '总结',
  nodes: [{ id: 'n1', type: 'concept', text: 'A', quote: '原文 A', paragraph: 0 },
    { id: 'n2', type: 'concept', text: 'B', paragraph: 1 },
    { id: 'n3', type: 'concept', text: 'C', paragraph: 2 }],
  edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports' }] }
const reviewRefreshed = { ...reviewBase, revision: 9, nodes: reviewBase.nodes.map(node => ({ ...node })),
  edges: reviewBase.edges.map(edge => ({ ...edge })), verification: { stale: true } }
assert.equal(reviewContextChanged(reviewBase, reviewRefreshed, { kind: 'node', id: 'n1' }), false,
  'saving a report or reloading identical graph content must not invalidate an AI review')
assert.equal(reviewContextChanged(reviewContextSignature(reviewBase, { kind: 'node', id: 'n1' }),
  reviewRefreshed, { kind: 'node', id: 'n1' }), false,
  'the review must retain an immutable semantic snapshot rather than only a mutable graph object')
assert.equal(reviewContextChanged(reviewBase, { ...reviewRefreshed, nodes: reviewRefreshed.nodes.map(node =>
  node.id === 'n3' ? { ...node, text: 'unrelated edit' } : node) }, { kind: 'node', id: 'n1' }), false,
  'an unrelated edit must not force a local issue to spend model tokens again')
assert.equal(reviewContextChanged(reviewBase, { ...reviewRefreshed, nodes: reviewRefreshed.nodes.map(node =>
  node.id === 'n1' ? { ...node, quote: 'changed' } : node) }, { kind: 'node', id: 'n1' }), true,
  'a changed target must invalidate its review')
assert.equal(reviewContextChanged(reviewBase, { ...reviewRefreshed, edges: [] }, { kind: 'node', id: 'n1' }), true,
  'a changed incident relation must invalidate its node review')
assert.equal(reviewContextChanged(reviewBase, { ...reviewRefreshed, nodes: reviewRefreshed.nodes.map(node =>
  node.id === 'n3' ? { ...node, text: 'unrelated edit' } : node) }, { kind: 'graph' }), true,
  'a whole-graph allegation requires unchanged whole-graph semantics')
assert.equal(reviewContextChanged(reviewBase, { ...reviewBase, ontology: 'changed-ontology' },
  { kind: 'node', id: 'n1' }), true, 'an ontology change must invalidate the meaning of a prior review')
assert.equal(reviewContextChanged(reviewBase, { ...reviewBase, summary: 'a different summary' },
  { kind: 'node', id: 'n1' }), true, 'the summary is part of the model input even for a local review')
const triangle = { ...reviewBase, edges: [...reviewBase.edges,
  { fromNodeId: 'n1', toNodeId: 'n3', relation: 'supports' }] }
assert.equal(reviewContextChanged(triangle, { ...triangle, edges: [...triangle.edges,
  { fromNodeId: 'n2', toNodeId: 'n3', relation: 'contradicts' }] }, { kind: 'node', id: 'n1' }), true,
  'a newly added relation between two reviewed neighbors must invalidate the review')
assert.equal(reviewContextChanged(triangle, { ...triangle, nodes: triangle.nodes.map(node =>
  node.id === 'n3' ? { ...node, text: 'changed edge neighbor' } : node) }, { kind: 'edge', id: 'n1>n2' }), true,
  'edge reviews also depend on their endpoints neighboring nodes')
assert.equal(reviewContextSignature(triangle, { kind: 'edge', id: 'n1>n2' }, buildReviewContextIndex(triangle)),
  reviewContextSignature(triangle, { kind: 'edge', id: 'n1>n2' }))
let endpointReads = 0
const indexedGraph = { nodes: Array.from({ length: 5000 }, (_, i) => ({ id: 'n' + i, text: 'node ' + i })),
  edges: Array.from({ length: 10000 }, (_, i) => ({
    get fromNodeId() { endpointReads++; return 'n' + (i % 5000) },
    get toNodeId() { endpointReads++; return 'n' + ((i + 1) % 5000) }, relation: 'supports',
  })) }
const scopes = Array.from({ length: 100 }, (_, i) => ({ kind: 'node', id: 'n' + i }))
const originalSignatures = scopes.map(scope => reviewContextSignature(indexedGraph, scope))
const originalReads = endpointReads
endpointReads = 0
const reviewIndex = buildReviewContextIndex(indexedGraph)
assert.deepEqual(scopes.map(scope => reviewContextSignature(indexedGraph, scope, reviewIndex)), originalSignatures,
  'indexed review snapshots must preserve the exact unindexed safety boundary')
const indexedReads = endpointReads
assert(indexedReads < originalReads / 10,
  'one batch index must remove repeated full-edge scans, including its construction cost')
for (const scope of [{ kind: 'edge', id: 'n1>n2' }, { kind: 'graph' }]) {
  assert.equal(reviewContextSignature(indexedGraph, scope, reviewIndex), reviewContextSignature(indexedGraph, scope))
}
console.log(JSON.stringify({ reviewContextIndex: { nodes: 5000, edges: 10000, issues: 100, originalReads, indexedReads } }))
assert.equal((client.match(/if \(archivedIssueNeedsFreshReview\(verification, (?:resultView|view)\.graph, issue\)\)/g) || []).length, 2,
  'both workbenches must reject stale report proposals even if UI controls are bypassed')
const statusStart = client.indexOf('      function updateIssueStatus(')
const statusEnd = client.indexOf('      function recordReviewedFix(', statusStart)
const updateIssueStatus = new Function(client.slice(statusStart, statusEnd) + '; return updateIssueStatus')()
const batchStart = client.indexOf('      function batchSafeFix(')
const batchEnd = client.indexOf('      function bulkFixEligible(', batchStart)
assert(batchStart > statusEnd && batchEnd > batchStart)
const { batchSafeFix, batchReviewCounts, planBulkReviewedFixes } = new Function('reviewContextChanged', 'reviewIssueContextTarget', 'updateIssueStatus',
  'nodeTypeFixConflicts', 'applyPatch', 'patchAlreadySatisfied', client.slice(batchStart, batchEnd)
  + '; return { batchSafeFix, batchReviewCounts, planBulkReviewedFixes }')(
  reviewContextChanged, reviewIssueContextTarget, updateIssueStatus, () => [], (graph, issue) => ({ ...graph,
    nodes: graph.nodes.map(node => node.id === issue.proposedFix.nodePatch?.id
      ? { ...node, text: issue.proposedFix.nodePatch.patch.text } : node) }), () => false)
const reportIssues = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, source: 'ai', targetKind: 'node',
  targetId: index === 0 ? 'n1' : index === 1 ? 'n2' : 'n3', severity: 'warning', status: 'open' }))
const batchBase = { ...reviewBase, edges: [], verification: { lastReport: { reportId: 'report-1' } } }
const linkedBatchBase = { ...batchBase, edges: reviewBase.edges }
const batchReport = { reportId: 'report-1', issues: reportIssues, metrics: {} }
const patchFor = (id, text) => ({ action: 'update_node', nodePatch: { id, patch: { text } } })
const batchRows = [
  { issueId: 'a', verdict: 'confirmed', proposedFix: patchFor('n1', 'A fixed'), answer: 'A is wrong', evidence: [] },
  { issueId: 'b', verdict: 'confirmed', proposedFix: patchFor('n2', 'B fixed'), answer: 'B is wrong', evidence: [] },
  { issueId: 'c', verdict: 'false_positive', proposedFix: { action: 'none' }, answer: 'supported', evidence: [] },
  { issueId: 'd', verdict: 'uncertain', proposedFix: { action: 'none' }, answer: 'insufficient', evidence: [] },
]
const batchPlan = planBulkReviewedFixes(batchBase, batchReport, batchRows, { a: true, b: true, c: true, d: true })
assert.deepEqual(batchPlan.counts, { applied: 2, falsePositive: 1, manual: 1, conflicts: 0, failed: 0 },
  'one confirmation must apply distinct repairs whose review contexts remain independent')
assert.deepEqual(batchPlan.report.issues.map(issue => issue.status), ['applied', 'applied', 'rejected', 'open'])
assert.equal(batchPlan.report.issues[3].batchReview.verdict, 'uncertain',
  'unresolved decisions must remain visible but not be repeatedly selected as new work')
assert.equal(batchReviewCounts(batchRows, batchReport).safe, 2)
assert.equal(batchSafeFix(reportIssues[0], { action: 'delete_node', nodePatch: { id: 'n1' } }), false,
  'destructive fixes must never enter the bulk apply set')
assert.equal(batchSafeFix(reportIssues[0], { action: 'update_node', nodePatch: { id: 'n1', patch: { quote: 'invented' } } },
  [{ paragraph: 0, quote: 'actual' }]), false,
  'a bulk quote replacement must exactly match verified source evidence')
const collidingRows = [batchRows[0], { ...batchRows[0], issueId: 'b', proposedFix: patchFor('n1', 'another change') }]
const collisionReport = { ...batchReport, issues: reportIssues.map(issue => issue.id === 'b' ? { ...issue, targetId: 'n1' } : issue) }
const collision = planBulkReviewedFixes(batchBase, collisionReport, collidingRows, { a: true, b: true })
assert.equal(collision.counts.applied, 1)
assert.equal(collision.counts.conflicts, 1, 'a later fix touching an already edited context must be held for review')
const changedNeighbor = planBulkReviewedFixes(linkedBatchBase, batchReport, batchRows, { a: true, b: true, c: true, d: true })
assert.equal(changedNeighbor.counts.applied, 1,
  'a text-only repair is not independent when its AI review read a neighbor changed earlier in the batch')
assert.equal(changedNeighbor.counts.conflicts, 1)
assert.equal(changedNeighbor.report.issues[1].status, 'open')
assert.equal(changedNeighbor.report.issues[1].batchReview, undefined,
  'a dependency conflict must stay eligible for a fresh review, not disappear from the next batch')
assert.equal(changedNeighbor.graph.nodes.find(node => node.id === 'n2').text, 'B',
  'a dependent repair must not be silently applied using stale context')
const crossReferencedReport = { ...batchReport, issues: batchReport.issues.map(issue => issue.id === 'b'
  ? { ...issue, detail: 'Compare this claim with n1 even though they are not linked.' } : issue) }
const crossReferenced = planBulkReviewedFixes(batchBase, crossReferencedReport, batchRows,
  { a: true, b: true, c: true, d: true })
assert.equal(crossReferenced.counts.applied, 1,
  'explicitly referenced non-neighbor nodes are model inputs and must participate in dependency checks')
assert.equal(crossReferenced.counts.conflicts, 1)
const changedVerdict = planBulkReviewedFixes(linkedBatchBase, batchReport,
  [batchRows[0], { ...batchRows[1], verdict: 'false_positive', proposedFix: { action: 'none' } }],
  { a: true, b: true })
assert.equal(changedVerdict.counts.applied, 1)
assert.equal(changedVerdict.counts.conflicts, 1,
  'a neighbor edit must not silently turn an older false-positive verdict into a final rejection')
const outdated = planBulkReviewedFixes(batchBase, batchReport, batchRows, { a: false, b: true, c: true, d: true })
assert.equal(outdated.counts.applied, 1)
assert.equal(outdated.counts.conflicts, 1, 'a changed review context cannot be batch-applied')
assert(panel.includes('批量 AI 核实下一组') && panel.includes('查看逐项核实结果')
  && panel.includes('确认保存核实结果') && client.includes('activeContextHash')
  && client.includes('persistGraph(next, baseline, loaded.revision)')
  && client.includes('localStorage.getItem(bulkReviewStorageKey(documentId))'),
  'batch review needs bounded progress, a reviewable preview, resumable task identity, and one CAS save')
const pauseStart = client.indexOf('        const handleStopBulkReview = () => {')
const pauseEnd = client.indexOf('        const handleDiscardBulkReview = () => {', pauseStart)
assert(pauseStart > 0 && pauseEnd > pauseStart
  && !client.slice(pauseStart, pauseEnd).includes('task-cancel'),
  'pausing a batch must not cancel and re-bill the in-flight model task')
const bulkRunStart = client.indexOf('        const saveBulkReview = (state) => {')
const bulkRunEnd = client.indexOf('        const handleApplyIssue = async (issue, reviewedAgainstGraph) => {', bulkRunStart)
assert(bulkRunStart > 0 && bulkRunEnd > bulkRunStart)
const digest = value => createHash('sha256').update(value).digest('hex')
async function runBulkFixture(initial, options = {}) {
  const calls = []
  let lastState = null
  const canonical = { ...batchBase, verification: { lastReport: batchReport } }
  const view = { graph: canonical, sourceText: 'stale page text' }
  const host = { call: async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'document-export') return { graph: canonical, revision: 2, sourceText: options.sourceText ?? 'source text' }
    if (method === 'question-graph') return { taskId: 'task-' + payload.reviewIssue.id }
    if (method === 'task-status' && payload.taskId === 'missing') return { status: 'not_found' }
    if (method === 'task-status') return { status: 'succeeded', result: {
      mode: 'issue_review', reviewedIssueId: payload.taskId.slice(5), verdict: 'confirmed',
      answer: '原文支持修正', evidence: [{ paragraph: 0, quote: 'source text' }],
      proposedFix: patchFor(payload.taskId === 'task-a' ? 'n1' : 'n2', 'fixed'), model: { provider: 'fake', model: 'fake' },
    } }
    throw new Error('unexpected method ' + method)
  } }
  const names = ['setBulkReview', 'localStorage', 'toastStore', 'bulkReviewStorageKey', 'resultView', 'bulkRunRef', 'bulkStopRef',
    'bulkActiveTaskRef', 'host', 'fullText', 'asAllNodesGraph', 'documentIdOfGraph', 'currentResultRef',
    'verificationRef', 'questionNeighborhoodGraph', 'reviewContextSignature', 'reviewSignatureHash', 'buildReviewContextIndex', 'reviewIssueContextTarget',
    'verificationSourcePayload', 'MAX_VERIFY_NODES', 'title', 'effectiveModelArg', 'modelCatalog',
    'questionPhase', 'verifyPhase', 'verification']
  const args = [state => { lastState = state }, { setItem() {}, removeItem() {} }, { show() {} },
    documentId => 'review:' + documentId, view,
    { current: false }, { current: false }, { current: null }, host, 'stale page text', graph => graph,
    graph => graph?.source?.documentId, { current: view }, { current: batchReport }, graph => graph,
    reviewContextSignature, async signature => digest(signature), buildReviewContextIndex, reviewIssueContextTarget,
    () => ({}), 2000, 'Fixture', { provider: 'fake', model: 'fake' }, { issueReview: true }, 'idle', 'idle', batchReport]
  const run = new Function(...names, client.slice(bulkRunStart, bulkRunEnd) + '; return runBulkReview')(...args)
  await run(initial)
  return { calls, lastState }
}
const newBatch = await runBulkFixture({ documentId: 'doc', reportId: 'report-1', issueIds: ['a', 'b'], rows: [],
  model: { provider: 'fake', model: 'fake' }, activeTaskId: null, activeContextHash: null })
assert.equal(newBatch.lastState.phase, 'ready')
assert.equal(newBatch.lastState.rows.length, 2)
assert.equal(newBatch.calls.filter(call => call.method === 'question-graph').length, 2)
assert.deepEqual(newBatch.calls.filter(call => call.method === 'question-graph').map(call => call.payload.model?.model),
  ['fake', 'fake'], 'each batched issue must use the model selected when the batch started')
assert.equal(newBatch.calls.filter(call => call.method === 'graph-commit').length, 0,
  'bulk review must not mutate canonical data before the one confirmation step')
assert(newBatch.calls.filter(call => call.method === 'question-graph').every(call => call.payload.text === 'source text'),
  'batch evidence must use the canonical source, not stale page text')
const resumedBatch = await runBulkFixture({ documentId: 'doc', reportId: 'report-1', issueIds: ['a', 'b'],
  rows: [newBatch.lastState.rows[0]], model: { provider: 'fake', model: 'fake' },
  sourceHash: newBatch.lastState.sourceHash, activeTaskId: 'task-b', activeContextHash: 'saved-hash' })
assert.equal(resumedBatch.lastState.phase, 'ready')
assert.equal(resumedBatch.lastState.rows[1].contextHash, 'saved-hash')
assert.equal(resumedBatch.calls.filter(call => call.method === 'question-graph').length, 0,
  'a refreshed page must recover the in-flight review result instead of paying for it again')
const lostBatch = await runBulkFixture({ ...newBatch.lastState, rows: [],
  activeTaskId: 'missing', activeContextHash: 'saved-hash' })
assert.equal(lostBatch.lastState.phase, 'paused')
assert.equal(lostBatch.lastState.activeTaskId, null)
assert.equal(lostBatch.calls.filter(call => call.method === 'question-graph').length, 0,
  'a lost server task must require explicit confirmation before spending model tokens again')
const sourceChangedBatch = await runBulkFixture({ ...newBatch.lastState, rows: [newBatch.lastState.rows[0]] },
  { sourceText: 'changed txt' })
assert.equal(sourceChangedBatch.lastState.phase, 'paused')
assert.equal(sourceChangedBatch.calls.filter(call => call.method === 'question-graph').length, 0,
  'source changes, including equal-length edits, invalidate resumed review evidence before any model call')
const bulkApplyStart = client.indexOf('        const handleApplyBulkReview = async () => {')
const bulkApplyEnd = client.indexOf('        const handleApplyIssue = async (issue, reviewedAgainstGraph) => {', bulkApplyStart)
assert(bulkApplyStart > 0 && bulkApplyEnd > bulkApplyStart)
async function applyBulkFixture(rows, saveRevision = 247, options = {}) {
  const canonical = { ...batchBase, verification: { lastReport: batchReport } }
  const view = { graph: canonical, sourceText: 'source text' }
  const session = { documentId: 'doc', reportId: 'report-1', phase: 'ready', sourceHash: digest('source text'),
    issueIds: rows.map(row => row.issueId), rows: rows.map(row => ({ ...row, contextHash: row.contextHash === 'ok'
      ? digest(reviewContextSignature(canonical, reviewIssueContextTarget(batchReport.issues.find(issue => issue.id === row.issueId))))
      : row.contextHash })) }
  const saves = [], states = [], refreshed = [], messages = []
  const currentResultRef = { current: view }, busy = { current: false }
  const names = ['bulkReview', 'resultView', 'bulkRunRef', 'documentIdOfGraph', 'verification',
    'toastStore', 'saveBulkReview', 'host', 'asAllNodesGraph', 'reviewContextSignature',
    'reviewSignatureHash', 'buildReviewContextIndex', 'reviewIssueContextTarget', 'planBulkReviewedFixes', 'withVerification', 'persistGraph',
    'clearBulkReview', 'graphViewMetadata', 'loadGraphDocument', 'currentResultRef',
    'setResultView', 'makeView', 'setVerification', 'setQuestionResult', 'setError', 'graphCommitQueueRef',
    'verifyBusyRef', 'questionPhase', 'graphRevisionRef', 'setFullText']
  const args = [session, view, busy, graph => graph.source?.documentId, batchReport,
    { show: message => messages.push(message) }, state => states.push(state),
    { call: async method => {
      assert.equal(method, 'document-export')
      if (options.navigate) currentResultRef.current = { graph: { source: { documentId: 'different-document' } } }
      if (saves.length && options.refreshFailure) return { error: { message: 'fixture readback failed' } }
      return { graph: saves.length ? { ...saves[0].next, normalizedByHost: true } : canonical,
        revision: saves.length ? saveRevision : 246, sourceText: options.sourceText ?? 'source text' }
    } }, graph => graph, reviewContextSignature, async value => digest(value), buildReviewContextIndex, reviewIssueContextTarget, planBulkReviewedFixes,
    (graph, report, stale) => ({ ...graph, verification: { lastReport: report, stale } }),
    async (next, baseline, revision) => {
      saves.push({ next, baseline, revision })
      return saveRevision == null ? null : { revision: saveRevision }
    }, () => messages.push('discarded'), () => ({ kind: 'all' }),
    async () => { throw new Error('whole-graph save must not load a window') }, currentResultRef,
    value => refreshed.push(value), (graph, sourceText) => ({ graph, sourceText }),
    () => {}, () => {}, error => messages.push(error.message), { current: Promise.resolve() },
    { current: false }, 'idle', { current: 246 }, () => {}]
  const apply = new Function(...names, client.slice(bulkApplyStart, bulkApplyEnd)
    + '; return handleApplyBulkReview')(...args)
  await Promise.all(options.doubleClick ? [apply(), apply()] : [apply()])
  assert.equal(busy.current, false, 'all terminal paths must release the synchronous save lock')
  return { saves, states, refreshed, messages }
}
const committedBulk = await applyBulkFixture(batchRows.map(row => ({ ...row, contextHash: 'ok' })), 247, { doubleClick: true })
assert.equal(committedBulk.saves.length, 1, 'one confirmation must make exactly one canonical graph commit')
assert.equal(committedBulk.saves[0].revision, 246, 'the commit must be fenced to the exported revision')
assert.deepEqual(committedBulk.saves[0].next.verification.lastReport.issues.map(issue => issue.status),
  ['applied', 'applied', 'rejected', 'open'])
assert.equal(committedBulk.refreshed.length, 1)
assert.equal(committedBulk.refreshed[0].graph.normalizedByHost, true,
  'the saved view must come from canonical readback, not the unvalidated optimistic patch')
const staleBulk = await applyBulkFixture([{ ...batchRows[0], contextHash: 'stale' }])
assert.equal(staleBulk.saves.length, 0, 'a changed target cannot reach the persistence layer')
assert.equal(staleBulk.states.at(-1).phase, 'ready', 'stale results remain reviewable rather than silently disappearing')
const failedCommit = await applyBulkFixture([{ ...batchRows[0], contextHash: 'ok' }], null)
assert.equal(failedCommit.saves.length, 1)
assert.equal(failedCommit.refreshed.length, 0, 'a failed commit must not be presented as a saved repair')
assert.equal(failedCommit.states.at(-1).phase, 'ready')
const staleSourceSave = await applyBulkFixture([{ ...batchRows[0], contextHash: 'ok' }], 247,
  { sourceText: 'changed txt' })
assert.equal(staleSourceSave.saves.length, 0, 'source edits must prevent applying an old evidence-backed result')
const navigatedSave = await applyBulkFixture([{ ...batchRows[0], contextHash: 'ok' }], 247, { navigate: true })
assert.equal(navigatedSave.saves.length, 0, 'leaving the view before commit must not submit stale edits')
const failedReadback = await applyBulkFixture([{ ...batchRows[0], contextHash: 'ok' }], 247, { refreshFailure: true })
assert.equal(failedReadback.saves.length, 1)
assert(failedReadback.messages.includes('discarded') && failedReadback.messages.some(message => message.includes('刷新失败')),
  'a committed save with failed readback must not expose an automatic resubmit path')
const fixStart = client.indexOf('      function recordReviewedFix(')
const fixEnd = client.indexOf('      function bulkFixEligible(', fixStart)
assert(fixStart >= 0 && fixEnd > fixStart)
const recordReviewedFix = new Function(client.slice(fixStart, fixEnd) + '; return recordReviewedFix')()
const confirmedFix = { action: 'update_node', nodePatch: { id: 'n1', patch: { text: '修正' } } }
assert.deepEqual(recordReviewedFix({ issues: [{ id: 'issue-1', proposedFix: { action: 'delete_node' } }] },
  { id: 'issue-1', source: 'issue_review', proposedFix: confirmedFix }).issues[0].proposedFix, confirmedFix,
  'the persisted report must show the repair actually confirmed by AI, not its earlier candidate')
assert.equal((client.match(/\.\.\.updateIssueStatus\(recordReviewedFix\(report, issue\), issue\.id, 'applied'/g) || []).length, 2,
  'both workbenches must mark a report stale after applying an actual graph mutation')
const recheckHandlers = [...client.matchAll(/        const handleRecheckIssue = async \(issue\) => \{/g)]
assert.equal(recheckHandlers.length, 2, 'document and trajectory workbenches must share focused review behavior')
for (const match of recheckHandlers) {
  const end = client.indexOf('        const handleQuestionNode = ', match.index)
  assert(end > match.index)
  const submitted = []
  const currentGraph = { nodes: [{ id: 'n2076' }] }
  const openingView = { graph: currentGraph }
  const recheck = new Function('setQuestionTarget', 'setQuestionDraft', 'setQuestionResult', 'setActiveIssueId', 'submitQuestion', 'toastStore', 'showToast', 'resultView', 'view', 'reviewContextSignature',
    'bulkRunRef', 'questionPhase', 'setQuestionPhase', 'setQuestionError', 'graphCommitQueueRef', 'trajCommitQueueRef',
    'documentIdOfGraph', 'loadGraphDocument', 'graphRevisionRef', 'trajRevisionRef', 'setResultView', 'setView',
    'makeView', 'fullText', 'setGraphQueryDraft', 'verifyGenRef', 'currentResultRef', 'currentViewRef', 'reviewIssueContextTarget',
    client.slice(match.index, end) + '; return handleRecheckIssue')(
    () => {}, () => {}, () => {}, () => {}, (_, target, issue) => submitted.push({ target, issue }), { show() {} }, () => {},
    openingView, openingView, (_, scope) => 'sig-' + (scope.reviewScopeKind || scope.kind)
      + '-' + (scope.reviewScopeKind === 'graph' ? 'all' : scope.id || 'all'),
    { current: false }, 'idle', () => {}, () => {}, { current: Promise.resolve() }, { current: Promise.resolve() },
    () => 'doc', async () => { throw new Error('must not load the current graph') }, { current: 1 }, { current: 1 },
    () => {}, () => {}, graph => ({ graph }), '', () => {}, { current: 0 }, { current: openingView }, { current: openingView }, reviewIssueContextTarget)
  await recheck({ id: 'one', targetKind: 'graph', title: 'n2076 将示例误标为 rule' })
  await recheck({ id: 'two', targetKind: 'graph', title: 'n2052 与 n2087 关系错误' })
  assert.deepEqual(submitted.map(item => item.target), [
    { kind: 'node', id: 'n2076', sourceIssueId: 'one', reviewScopeKind: 'graph', contextNodeIds: ['n2076'], reviewSignature: 'sig-graph-all' },
    { kind: 'graph', id: null, sourceIssueId: 'two', reviewScopeKind: 'graph', contextNodeIds: ['n2052', 'n2087'], reviewSignature: 'sig-graph-all' },
  ], 'single-ID reviews must focus the node without narrowing a cross-node review to one endpoint')
  assert.deepEqual(submitted.map(item => item.issue.id), ['one', 'two'], 'review must send the structured candidate issue')
}
for (const match of recheckHandlers) {
  const end = client.indexOf('        const handleQuestionNode = ', match.index)
  const partial = { source: { documentId: 'doc' }, view: { truncated: true },
    nodes: [{ id: 'n1', text: 'visible' }], edges: [] }
  const focused = { ...partial, nodes: [{ id: 'n8018', text: 'off-window' }] }
  const loadedViews = [], submitted = []
  const openingView = { graph: partial, sourceText: 'source' }
  const activeView = { current: openingView }
  let navigate = false
  const recheck = new Function('setQuestionTarget', 'setQuestionDraft', 'setQuestionResult', 'setActiveIssueId',
    'submitQuestion', 'toastStore', 'showToast', 'resultView', 'view', 'reviewContextSignature',
    'bulkRunRef', 'questionPhase', 'setQuestionPhase', 'setQuestionError', 'graphCommitQueueRef', 'trajCommitQueueRef',
    'documentIdOfGraph', 'loadGraphDocument', 'graphRevisionRef', 'trajRevisionRef', 'setResultView', 'setView',
    'makeView', 'fullText', 'setGraphQueryDraft', 'verifyGenRef', 'currentResultRef', 'currentViewRef', 'reviewIssueContextTarget',
    client.slice(match.index, end) + '; return handleRecheckIssue')(
    () => {}, () => {}, () => {}, () => {}, (_, target) => submitted.push(target), { show() {} }, () => {},
    openingView, openingView,
    (graph, target) => graph.nodes.some(node => node.id === target.id) ? 'focused-signature' : null,
    { current: false }, 'idle', () => {}, () => {}, { current: Promise.resolve() }, { current: Promise.resolve() },
    graph => graph.source?.documentId, async request => {
      assert.equal(request.query, 'n8018')
      if (navigate) activeView.current = { graph: { source: { documentId: 'another-document' } } }
      return { graph: focused, revision: 9 }
    }, { current: 1 }, { current: 1 }, graph => loadedViews.push(graph), graph => loadedViews.push(graph),
    graph => graph, '', () => {}, { current: 0 }, activeView, activeView, reviewIssueContextTarget)
  await recheck({ id: 'off-window', targetKind: 'node', targetId: 'n8018', title: '缺失原文证据' })
  assert.equal(loadedViews.length, 1, 'a reviewed node outside the current window must be loaded into the editable view')
  assert.equal(submitted[0].reviewSignature, 'focused-signature',
    'the review snapshot must come from the target subgraph, not the old window')
  navigate = true
  await recheck({ id: 'off-window', targetKind: 'node', targetId: 'n8018', title: '缺失原文证据' })
  assert.equal(loadedViews.length, 1, 'a late target-window response cannot restore a document the user has left')
  assert.equal(submitted.length, 1, 'a superseded review must stop before spending model tokens')
}
const reviewStart = panel.indexOf('        const applyReviewedIssue =')
const reviewEnd = panel.indexOf('        // A contradicted/insufficient answer', reviewStart)
assert(reviewStart >= 0 && reviewEnd > reviewStart)
const destructiveIssue = { proposedFix: { action: 'delete_edge', edgePatch: { fromNodeId: 'n2052', toNodeId: 'n2087' } } }
const applied = [], pending = []
const reviewFix = (current) => new Function('nodeTypeFixConflicts', 'archivedIssueNeedsFreshReview', 'report', 'graph', 'pendingDestructiveFix', 'setPendingDestructiveFix', 'onApplyIssue', 'bulkRunning',
  panel.slice(reviewStart, reviewEnd) + '; return applyReviewedIssue')(
  () => [], () => false, null, {}, current, value => pending.push(value), issue => applied.push(issue), false)
reviewFix(null)(destructiveIssue)
assert.equal(applied.length, 0, 'the first destructive click must not mutate the graph')
assert.equal(pending.at(-1), JSON.stringify(destructiveIssue.proposedFix))
reviewFix(pending.at(-1))(destructiveIssue)
assert.deepEqual(applied, [destructiveIssue], 'the matching second click must apply exactly that reviewed fix')

const labelStart = panel.indexOf('        const fixLabel = (fix) => {')
const labelEnd = panel.indexOf('        const applyReviewedIssue =', labelStart)
assert(labelStart >= 0 && labelEnd > labelStart)
const fixLabel = new Function('graph', 'TYPE_META', 'REL_LABEL', panel.slice(labelStart, labelEnd) + '; return fixLabel')(
  { nodes: [{ id: 'n2076', type: 'rule', text: '例子' }] },
  { rule: { label: '规律' }, positive_example: { label: '正例' } },
  { exemplifies: '例证' },
)
assert.equal(fixLabel({ action: 'update_node', nodePatch: { id: 'n2076', patch: { type: 'positive_example' } } }),
  '更新节点 n2076：类型 规律 → 正例')
assert(fixLabel({ action: 'delete_node', nodePatch: { id: 'n2076' } }).includes('全部关系'))

const conflictStart = client.indexOf('      function introducedOntologyConflicts(')
const conflictEnd = client.indexOf('       // graph (original untouched)', conflictStart)
assert(conflictStart >= 0 && conflictEnd > conflictStart)
const { introducedOntologyConflicts, nodeTypeFixConflicts } = new Function(
  client.slice(conflictStart, conflictEnd) + '; return { introducedOntologyConflicts, nodeTypeFixConflicts }',
)()
const ontology = getOntology('learning-view-v1')
const graphWithExistingBadEdge = {
  ontology: 'learning-view-v1', graphOntology: ontology,
  nodes: [{ id: 'n2049', type: 'rule' }, { id: 'n2050', type: 'data_or_experience' }],
  edges: [
    { fromNodeId: 'n2050', toNodeId: 'n2049', relation: 'exemplifies' },
    { fromNodeId: 'n2050', toNodeId: 'n2049', relation: 'aligns_upper_lower' },
  ],
}
assert.deepEqual(nodeTypeFixConflicts(graphWithExistingBadEdge, {
  action: 'update_node', nodePatch: { id: 'n2049', patch: { type: 'data_or_experience' } },
}), ['n2050>n2049:exemplifies'],
'the pre-existing bad alignment must not mask the new exemplar violation')
assert.deepEqual(nodeTypeFixConflicts({ ...graphWithExistingBadEdge, graphOntology: null }, {
  action: 'update_node', nodePatch: { id: 'n2049', patch: { type: 'data_or_experience' } },
}), ['本体关系规则尚未加载'], 'missing learning ontology must fail closed')
assert.deepEqual(introducedOntologyConflicts(graphWithExistingBadEdge, graphWithExistingBadEdge.nodes,
  graphWithExistingBadEdge.edges, 'delete_edge'), [], 'unchanged historical violations remain repairable')
assert(client.includes('if (introducedOntologyConflicts(originalGraph, nodes, edges, fix.action).length > 0) return originalGraph'),
  'all patch paths must enforce ontology constraints before mutation')
const applyStart = client.indexOf('      function applyPatch(')
const applyEnd = client.indexOf('      // A patch may be a no-op', applyStart)
const applyEnv = {
  cloneNodes: nodes => nodes.map(node => ({ ...node })),
  cloneEdges: edges => edges.map(edge => ({ ...edge })),
  TYPE_META: { rule: {}, positive_example: {}, data_or_experience: {} },
  REL_LABEL: { exemplifies: '例证', has_rule: '规律' },
  mergeEvidenceRecords: (_primary, evidence) => evidence,
  edgeKeyOf: edge => edge.fromNodeId + '>' + edge.toNodeId,
  compactAuditSnapshots: () => ({}), appendAudit: graph => graph,
  carrySemanticOperations: (_old, next) => next,
  introducedOntologyConflicts, newNodeId: () => 'new-1',
}
const applyPatch = new Function(...Object.keys(applyEnv),
  client.slice(applyStart, applyEnd) + '; return applyPatch')(...Object.values(applyEnv))
const relationGraph = { ontology: 'learning-view-v1', graphOntology: ontology,
  nodes: [{ id: 'n2035', type: 'positive_example' }, { id: 'n2025', type: 'rule' },
    { id: 'n2027', type: 'rule' }, { id: 'n2052', type: 'data_or_experience' }],
  edges: [{ fromNodeId: 'n2035', toNodeId: 'n2025', relation: 'exemplifies' }],
}
const textOnlyFix = { targetKind: 'node', targetId: 'n2025', proposedFix: {
  action: 'update_node', nodePatch: { id: 'n2025', patch: { text: '只保留原文支持的表述' } },
} }
const trimmed = applyPatch(relationGraph, textOnlyFix)
assert.notEqual(trimmed, relationGraph, 'removing an unsupported tail must produce a graph patch')
assert.equal(trimmed.nodes.find(node => node.id === 'n2025').text, '只保留原文支持的表述')
assert.equal(trimmed.nodes.find(node => node.id === 'n2025').type, 'rule')
assert.deepEqual(trimmed.edges, relationGraph.edges,
  'a text-only repair must preserve the supported node and all incident relations')
const retargetFix = { targetKind: 'graph', proposedFix: { action: 'update_edge', edgePatch: {
  fromNodeId: 'n2035', toNodeId: 'n2025', newToNodeId: 'n2027', relation: 'exemplifies',
  evidence: [{ paragraph: 0, quote: '例子说明这一结论' }],
} } }
const retargeted = applyPatch(relationGraph, retargetFix)
assert.notEqual(retargeted, relationGraph)
assert.equal(retargeted.edges[0].toNodeId, 'n2027', 'update_edge must really retarget the edge')
assert.deepEqual(relationGraph.edges[0], { fromNodeId: 'n2035', toNodeId: 'n2025', relation: 'exemplifies' },
  'applying a patch must not mutate the original graph')
assert.equal(applyPatch(relationGraph, { ...retargetFix, proposedFix: { action: 'update_edge', edgePatch: {
  ...retargetFix.proposedFix.edgePatch, newToNodeId: 'n2052',
} } }), relationGraph, 'retargeting to an invalid ontology type must fail closed')
assert.equal(applyPatch(relationGraph, { ...retargetFix, proposedFix: { action: 'update_edge', edgePatch: {
  ...retargetFix.proposedFix.edgePatch, toNodeId: 'n2027',
} } }), relationGraph, 'a nonexistent old edge must not be silently updated')
const ambiguousPair = { ...relationGraph, edges: [...relationGraph.edges,
  { fromNodeId: 'n2035', toNodeId: 'n2025', relation: 'has_rule' }] }
assert.equal(applyPatch(ambiguousPair, retargetFix), ambiguousPair,
  'an update without oldRelation must not choose an arbitrary edge between the same nodes')

const graph = { ontology: 'learning-view-v1', summary: '', nodes: [{ id: 'n2076', type: 'rule', paragraph: 0 }], edges: [] }
const view = { graph, sourceText: 'source' }
const starts = [...client.matchAll(/        const submitQuestion = async \(draftOverride, targetOverride, reviewIssue = null\) => \{/g)].map(match => match.index)
assert.equal(starts.length, 2, 'both document and trajectory question forms need feedback')
assert.equal((client.match(/target\?\.sourceIssueId \? \{ kind: target\.kind, id: target\.id \} : target/g) || []).length, 2,
  'editing a recheck question must detach its original issue identity')

function fixture(start, response, modelCatalog = { issueReview: true }) {
  const end = client.indexOf('        const handleApplyIssue =', start)
  assert(end > start)
  const states = { phase: [], error: [], questionError: [], result: [], progress: [], taskId: [] }
  const calls = []
  const env = {
    questionDraft: 'Why?', resultView: view, view, questionPhase: 'idle',
    title: 'Fixture', fullText: 'source', questionTarget: null, effectiveModelArg: null,
    modelCatalog, bulkRunRef: { current: false },
    setError: value => states.error.push(value),
    setQuestionError: value => states.questionError.push(value),
    setVerifyProgress: value => states.progress.push(value),
    setQuestionPhase: value => states.phase.push(value),
    setQuestionResult: value => states.result.push(value),
    setQuestionTaskId: value => states.taskId.push(value),
    verificationSourcePayload: () => ({}),
    questionNeighborhoodGraph,
    documentIdOfGraph: () => '',
    host: { call: async (method, payload) => {
      calls.push({ method, payload })
      if (response instanceof Error) throw response
      return response
    } },
  }
  const source = client.slice(start, end) + '; return submitQuestion'
  const submit = new Function(...Object.keys(env), source)(...Object.values(env))
  return { submit, states, calls }
}

for (const start of starts) {
  for (const [response, expected] of [
    [{ error: { message: 'upstream unavailable' } }, 'upstream unavailable'],
    [{}, '无法提交质疑任务，请重试'],
    [new Error('network down'), '无法提交质疑任务：network down'],
  ]) {
    const { submit, states } = fixture(start, response)
    await submit()
    assert.equal(states.questionError.at(-1), expected)
    assert.equal(states.phase.at(-1), 'idle')
    assert.deepEqual(states.error, [null], 'question failures must not be hidden in a remote global banner')
  }
  const { submit, states, calls } = fixture(start, { taskId: 'question-1' })
  await submit()
  assert.deepEqual(states.taskId, ['question-1'])
  assert.equal(states.phase.at(-1), 'running')
  assert.equal(states.questionError.at(-1), '')
  assert.equal(calls[0]?.payload?.graph?.ontology, 'learning-view-v1',
    'question transport must preserve the graph ontology for prompt and fix validation')
  const recheck = fixture(start, { taskId: 'question-2' })
  await recheck.submit('Check this', { kind: 'node', id: 'n2076', sourceIssueId: 'issue-1' },
    { id: 'issue-1', targetKind: 'node', targetId: 'n2076', title: 'wrong type', evidence: [] })
  assert.deepEqual(recheck.calls[0]?.payload?.target, { kind: 'node', id: 'n2076' },
    'UI-only issue identity must not leak into the host question contract')
  assert.equal(recheck.calls[0]?.payload?.reviewIssue?.id, 'issue-1',
    'issue review must preserve the structured candidate for an independent verdict')
  const oldHost = fixture(start, { taskId: 'should-not-start' }, { issueReview: false })
  await oldHost.submit('Check this', { kind: 'node', id: 'n2076', sourceIssueId: 'issue-1' },
    { id: 'issue-1', targetKind: 'node', targetId: 'n2076', title: 'wrong type' })
  assert.equal(oldHost.calls.length, 0, 'old Host must not silently turn an issue review into a generic question')
  assert.match(oldHost.states.questionError.at(-1), /服务端尚未加载/)
}

console.log('question feedback UI smoke passed')
