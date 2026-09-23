import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getOntology } from '../src/kg-ontology.mjs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
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
assert(panel.includes("['delete_node', 'delete_edge', 'merge_nodes'].includes(action)"),
  'destructive fixes must require a separate confirmation')
assert(panel.includes('disabled: qFixConflicts.length > 0'),
  'a type fix that would invalidate an incident relation must not be clickable')
assert(panel.includes("qVerdict === 'supported' && recheckedIssue")
  && panel.includes("'标记原问题为误报'") && panel.includes("'处理说明：' + it.userNote"),
  'a recheck disproving an issue must offer a traceable dismissal rather than leaving it open')
assert(panel.includes("id: questionTarget?.sourceIssueId || 'qfix-' + Date.now()"),
  'a fix proposed by rechecking an issue must resolve that original issue')
assert(panel.includes("disabled: questionPhase === 'running', onClick: (e) => { e.stopPropagation(); onRecheckIssue(it) }"),
  'a second recheck cannot replace the target of a running question')

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

const graph = { ontology: 'learning-view-v1', summary: '', nodes: [], edges: [] }
const view = { graph, sourceText: 'source' }
const starts = [...client.matchAll(/        const submitQuestion = async \(draftOverride, targetOverride\) => \{/g)].map(match => match.index)
assert.equal(starts.length, 2, 'both document and trajectory question forms need feedback')
assert.equal((client.match(/sourceIssueId: issue\.id/g) || []).length, 4,
  'both workbenches must retain issue identity when rechecking')
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
