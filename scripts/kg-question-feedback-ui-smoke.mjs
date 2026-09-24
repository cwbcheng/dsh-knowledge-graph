import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
assert(client.includes("host.call('document-export', { documentId })") && client.includes('questionGraph = questionNeighborhoodGraph(questionGraph, q, target)'),
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
assert(panel.includes("'拟议修改：' + fixLabel(qFix)") && panel.includes("'拟议修改：' + fixLabel(it.proposedFix)"),
  'question and review fixes must show the actual mutation before acceptance')
assert(panel.includes("['delete_node', 'delete_edge', 'merge_nodes'].includes(action)")
  && panel.includes('if (pendingDestructiveFix !== key) { setPendingDestructiveFix(key); return }')
  && panel.includes('再次点击确认'),
  'destructive fixes must require an accessible second click without a blocking native dialog')
assert(panel.includes('disabled: qFixConflicts.length > 0'),
  'a type fix that would invalidate an incident relation must not be clickable')
assert(panel.includes("qVerdict === 'supported' && recheckedIssue")
  && panel.includes("'标记原问题为误报'") && panel.includes("'处理说明：' + it.userNote"),
  'a recheck disproving an issue must offer a traceable dismissal rather than leaving it open')
assert(panel.includes("id: questionTarget?.sourceIssueId || 'qfix-' + Date.now()"),
  'a fix proposed by rechecking an issue must resolve that original issue')
assert(panel.includes("disabled: questionPhase === 'running', onClick: (e) => { e.stopPropagation(); onRecheckIssue(it) }"),
  'a second recheck cannot replace the target of a running question')
assert(panel.includes('shown.slice(0, issueLimit).map((it) => {') && panel.includes('显示更多问题（已显示 '),
  'a large verification report must not render every issue card on each interaction')
assert(panel.includes('shown.findIndex(issue => issue.id === activeIssueId)'),
  'jumping to a selected issue must reveal it even when it is beyond the initial page')
assert(panel.includes('统计仍基于旧版本，请重新验证'),
  'the report must identify its counts as historical after a graph edit')
assert(panel.includes('entry.ts > report.createdAt') && panel.includes('report && reportStale'),
  'a persisted legacy report must be shown as stale when a later graph mutation is in its audit log')
const staleStart = panel.indexOf('        const reportStale = ')
const staleEnd = panel.indexOf('        const questionFeedbackRef = ', staleStart)
assert(staleStart >= 0 && staleEnd > staleStart)
const reportStale = new Function('report', 'graph', panel.slice(staleStart, staleEnd) + '; return reportStale')
assert.equal(reportStale({ createdAt: 100 }, { verification: { auditLog: [{ ts: 99 }] } }), false)
assert.equal(reportStale({ createdAt: 100 }, { verification: { auditLog: [{ ts: 101 }] } }), true)
assert.equal(reportStale({ createdAt: 100, stale: true }, { verification: { auditLog: [] } }), true)
assert.equal((client.match(/\.\.\.updateIssueStatus\(report, issue\.id, 'applied'\), stale: true/g) || []).length, 2,
  'both workbenches must mark a report stale after applying an actual graph mutation')
const recheckHandlers = [...client.matchAll(/        const handleRecheckIssue = \(issue\) => \{/g)]
assert.equal(recheckHandlers.length, 2, 'document and trajectory workbenches must share focused review behavior')
for (const match of recheckHandlers) {
  const end = client.indexOf('        const handleQuestionNode = ', match.index)
  assert(end > match.index)
  const submitted = []
  const recheck = new Function('setQuestionTarget', 'setQuestionDraft', 'setQuestionResult', 'setActiveIssueId', 'submitQuestion', 'toastStore', 'showToast',
    client.slice(match.index, end) + '; return handleRecheckIssue')(
    () => {}, () => {}, () => {}, () => {}, (_, target) => submitted.push(target), { show() {} }, () => {})
  recheck({ id: 'one', targetKind: 'graph', title: 'n2076 将示例误标为 rule' })
  recheck({ id: 'two', targetKind: 'graph', title: 'n2052 与 n2087 关系错误' })
  assert.deepEqual(submitted, [
    { kind: 'node', id: 'n2076', sourceIssueId: 'one' },
    { kind: 'graph', id: null, sourceIssueId: 'two' },
  ], 'single-ID reviews must focus the node without narrowing a cross-node review to one endpoint')
}
const reviewStart = panel.indexOf('        const applyReviewedIssue =')
const reviewEnd = panel.indexOf('        // A contradicted/insufficient answer', reviewStart)
assert(reviewStart >= 0 && reviewEnd > reviewStart)
const destructiveIssue = { proposedFix: { action: 'delete_edge', edgePatch: { fromNodeId: 'n2052', toNodeId: 'n2087' } } }
const applied = [], pending = []
const reviewFix = (current) => new Function('nodeTypeFixConflicts', 'graph', 'pendingDestructiveFix', 'setPendingDestructiveFix', 'onApplyIssue',
  panel.slice(reviewStart, reviewEnd) + '; return applyReviewedIssue')(
  () => [], {}, current, value => pending.push(value), issue => applied.push(issue))
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
const starts = [...client.matchAll(/        const submitQuestion = async \(draftOverride, targetOverride\) => \{/g)].map(match => match.index)
assert.equal(starts.length, 2, 'both document and trajectory question forms need feedback')
assert.equal((client.match(/target\?\.sourceIssueId \? \{ kind: target\.kind, id: target\.id \} : target/g) || []).length, 2,
  'editing a recheck question must detach its original issue identity')

function fixture(start, response) {
  const end = client.indexOf('        const handleApplyIssue =', start)
  assert(end > start)
  const states = { phase: [], error: [], questionError: [], result: [], progress: [], taskId: [] }
  const calls = []
  const env = {
    questionDraft: 'Why?', resultView: view, view, questionPhase: 'idle',
    title: 'Fixture', fullText: 'source', questionTarget: null, effectiveModelArg: null,
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
  await recheck.submit('Check this', { kind: 'node', id: 'n2076', sourceIssueId: 'issue-1' })
  assert.deepEqual(recheck.calls[0]?.payload?.target, { kind: 'node', id: 'n2076' },
    'UI-only issue identity must not leak into the host question contract')
}

console.log('question feedback UI smoke passed')
