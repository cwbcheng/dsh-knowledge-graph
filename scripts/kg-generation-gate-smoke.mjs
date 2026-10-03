import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const calls = []
const extractor = async ({ title, attempt, prompt }) => {
  calls.push({ title, attempt, prompt })
  if (title === 'gate-retry-collapse') {
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      id: 'c' + (index + 1),
      type: 'fact',
      text: '候选节点 ' + (index + 1),
      quote: '候选节点 ' + (index + 1),
      paragraph: index,
    }))
    if (attempt === 1) return { summary: '错误地只返回修复片段', nodes: nodes.slice(0, 1), edges: [] }
    return {
      summary: attempt === 0 ? '包含一个关系类型错误的完整候选' : '保留完整知识后的修复候选',
      nodes,
      edges: [{
        fromNodeId: 'c1',
        toNodeId: 'c2',
        relation: attempt === 0 ? 'example' : 'supports',
        evidence: [{ paragraph: 0, quote: '候选节点 1' }],
      }],
    }
  }
  if (title === 'gate-fatal') {
    return {
      summary: '无法验收',
      nodes: [{ type: 'fact', text: '没有 id 的节点', quote: '没有 id 的节点', paragraph: 0 }],
      edges: [],
    }
  }
  if (title === 'gate-quality') {
    return {
      summary: '质量建议不阻塞',
      nodes: [{ id: 'q1', type: 'fact', text: '孤立事实', quote: '孤立事实', paragraph: 0 }],
      edges: [],
    }
  }
  if (title === 'gate-hallucinated-empty') {
    return {
      summary: '只有锚点没有证据',
      nodes: [{ id: 'h1', type: 'fact', text: '月球由奶酪组成', quote: '', paragraph: 0 }],
      edges: [],
    }
  }
  if (title === 'gate-hallucinated-fake') {
    return {
      summary: '伪造摘录不能成为证据',
      nodes: [{ id: 'h2', type: 'fact', text: '月球由奶酪组成', quote: '月球由奶酪组成', paragraph: 0 }],
      edges: [],
    }
  }
  if (title === 'gate-entailment-unverified') {
    return {
      summary: '证据真实但语义蕴含未验证',
      nodes: [{ id: 'h3', type: 'fact', text: '月球由奶酪组成', quote: '今天上海下雨', paragraph: 0, entailmentStatus: 'verified' }],
      edges: [],
    }
  }
  if (attempt === 0) {
    return {
      summary: '第一次候选',
      nodes: [
        { id: 'n1', type: 'rule', text: '规则节点', quote: '规则节点', paragraph: 0 },
        { id: 'n2', type: 'fact', text: '事实节点', quote: '事实节点', paragraph: 1 },
      ],
      // `example` requires an example source node. This is a deterministic
      // invariant violation and must be fed back instead of being published.
      edges: [{
        fromNodeId: 'n1',
        toNodeId: 'n2',
        relation: 'example',
        evidence: [{ paragraph: 0, quote: '规则节点' }],
      }],
    }
  }
  return {
    summary: '修复后的候选',
    nodes: [
      { id: 'n1', type: 'rule', text: '规则节点', quote: '规则节点', paragraph: 0 },
      { id: 'n2', type: 'fact', text: '事实节点', quote: '事实节点', paragraph: 1 },
    ],
    edges: [{
      fromNodeId: 'n1',
      toNodeId: 'n2',
      relation: 'supports',
      evidence: [{ paragraph: 0, quote: '规则节点' }],
    }],
  }
}

const reviewedPairs = []
extractor.reviewRelations = async ({ candidates }) => ({ verdicts: candidates.map(item => {
  const pair = item.edge.fromNodeId + '>' + item.edge.toNodeId
  assert(['n1>n2', 'c1>c2'].includes(pair) && item.edge.relation === 'supports', 'unexpected relation reached the fixture reviewer')
  assert(item.edge.evidence.length > 0 && item.edge.evidence.every(value => value.documentId && value.sourceId && value.chunkId),
    'independent review must receive full candidate provenance')
  reviewedPairs.push(pair)
  return { id: item.id, verdict: 'supported', reason: 'Synthetic provenance fixture acceptance', evidence: item.edge.evidence }
}) })

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? extractor : null },
  interval() { return () => {} },
})

async function waitTask(taskId) {
  for (let i = 0; i < 120; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const source = '规则节点\n\n事实节点'
const started = await handlers.get('extract')({ title: 'gate-retry', text: source })
assert(started && started.taskId, 'generation-gate task was not created')
const completed = await waitTask(started.taskId)
assert(completed.status === 'succeeded' && completed.result, 'repairable invariant must succeed after retry: ' + JSON.stringify(completed))
assert(calls.filter((call) => call.title === 'gate-retry').length >= 2, 'deterministic invariant did not trigger a model retry')
const retryCall = calls.find((call) => call.title === 'gate-retry' && call.attempt === 1)
assert(retryCall && retryCall.prompt.includes('edge_source_type_mismatch'), 'typed invariant feedback was not supplied to the retry prompt')
assert(completed.result.generation && completed.result.generation.invariantErrors === 0, 'accepted graph does not declare zero invariant errors')
assert(completed.result.generation.retryCount >= 1, 'generation retry metadata is missing')
const provenanceNode = completed.result.nodes.find((node) => node.id === 'n1')
const provenanceEdge = completed.result.edges[0]
assert(provenanceNode && provenanceNode.evidence[0] && provenanceNode.evidence[0].documentId && provenanceNode.evidence[0].sourceId && provenanceNode.evidence[0].chunkId, 'node evidence does not carry full provenance')
assert(provenanceEdge && provenanceEdge.evidence[0] && provenanceEdge.evidence[0].documentId && provenanceEdge.evidence[0].sourceId && provenanceEdge.evidence[0].chunkId, 'edge evidence does not carry full provenance')
assert(reviewedPairs.includes('n1>n2'), 'a repaired cross-paragraph edge must still pass independent review')
assert(provenanceNode.groundingStatus === 'grounded' && provenanceNode.entailmentStatus === 'unverified', 'anchor/evidence/entailment states are not separated')

const collapseSource = Array.from({ length: 10 }, (_, index) => '候选节点 ' + (index + 1)).join('\n\n')
const collapseStarted = await handlers.get('extract')({ title: 'gate-retry-collapse', text: collapseSource })
const collapseCompleted = await waitTask(collapseStarted.taskId)
assert(collapseCompleted.status === 'succeeded' && collapseCompleted.result, 'complete retry after collapse must succeed: ' + JSON.stringify(collapseCompleted))
assert(collapseCompleted.result.nodes.length === 10, 'collapsed repair candidate was incorrectly published')
const collapseCalls = calls.filter((call) => call.title === 'gate-retry-collapse')
assert(collapseCalls.length === 3, 'collapse guard did not use the bounded third attempt')
assert(collapseCalls[1].prompt.includes('上一次完整候选 JSON') && collapseCalls[1].prompt.includes('候选节点 10'), 'first repair retry did not receive the full rejected candidate')
assert(collapseCalls[2].prompt.includes('repair_candidate_collapse'), 'catastrophic repair shrinkage was not fed back to the model')
assert(collapseCompleted.result.generation && collapseCompleted.result.generation.collapseRetryCount === 1, 'collapse retry audit metadata is incorrect')

const quick = await handlers.get('verify-graph')({
  text: source,
  graph: completed.result,
  mode: 'quick',
})
assert(quick && quick.report && !quick.error, 'quick check failed after accepted generation')
assert(quick.report.metrics.errorCount === 0, 'a freshly accepted graph still has deterministic quick-check errors: ' + JSON.stringify(quick.report.issues))
assert(quick.report.metrics.invariantErrorCount === 0, 'quick-check invariant metric is not zero after generation')
assert(quick.report.summary.includes('确定性错误 0'), 'quick-check summary does not distinguish invariant errors from quality findings')

const documentId = completed.result.source && completed.result.source.documentId
const rejectedCommit = await handlers.get('graph-commit')({
  documentId,
  expectedRevision: completed.result.source && completed.result.source.revision,
  graph: {
    summary: completed.result.summary,
    nodes: [{ id: 'bad-node', type: 'fact', text: '没有原文锚点的手工节点', quote: '', paragraph: null }],
    edges: [],
  },
  baseNodeIds: [],
  baseEdgeKeys: [],
})
assert(rejectedCommit && rejectedCommit.error && rejectedCommit.error.code === 'invariant_violation', 'dynamic graph-commit bypassed the canonical invariant gate')
const unchanged = await handlers.get('document-export')({ documentId })
assert(unchanged && unchanged.graph && unchanged.graph.nodes.length === 2, 'rejected graph-commit mutated the canonical graph')

// A valid evidence-backed relation repair must pass the same gate and update
// canonical state. This covers the question-panel add_edge path.
const repairedEdge = {
  fromNodeId: 'n2',
  toNodeId: 'n1',
  relation: 'supports',
  evidence: [{ paragraph: 1, quote: '事实节点' }],
}
const acceptedCommit = await handlers.get('graph-commit')({
  documentId,
  expectedRevision: completed.result.source && completed.result.source.revision,
  graph: {
    summary: completed.result.summary,
    nodes: completed.result.nodes,
    edges: [...completed.result.edges, repairedEdge],
  },
  baseNodeIds: completed.result.nodes.map((node) => node.id),
  baseEdgeKeys: completed.result.edges.map((edge) => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation),
})
assert(acceptedCommit && !acceptedCommit.error && acceptedCommit.revision === (completed.result.source.revision + 1), 'valid add_edge repair was rejected by the canonical invariant gate: ' + JSON.stringify(acceptedCommit))
const updated = await handlers.get('document-export')({ documentId })
assert(updated && updated.graph && updated.graph.edges.some((edge) => edge.fromNodeId === 'n2' && edge.toNodeId === 'n1' && edge.relation === 'supports'), 'accepted add_edge repair did not update canonical graph')
const invalidCitationPayload = (nodes, edges) => ({ documentId, expectedRevision: updated.revision,
  graph: { ...updated.graph, nodes, edges }, baseNodeIds: updated.graph.nodes.map(node => node.id),
  baseEdgeKeys: updated.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) })
const forgedNodeEvidence = invalidCitationPayload(updated.graph.nodes.map(node => node.id === 'n1'
  ? { ...node, evidence: [...node.evidence, { paragraph: 0, quote: '没有出现在原文的新增证据' }] }
  : node), updated.graph.edges)
const forgedPrimaryQuote = invalidCitationPayload(updated.graph.nodes.map(node => node.id === 'n1'
  ? { ...node, quote: '没有出现在原文的主引文' } : node), updated.graph.edges)
const forgedEdgeEvidence = invalidCitationPayload(updated.graph.nodes, updated.graph.edges.map(edge => edge.fromNodeId === 'n2'
  ? { ...edge, evidence: [...edge.evidence, { paragraph: 1, quote: '没有出现在原文的关系证据' }] }
  : edge))
const malformedEvidence = invalidCitationPayload(updated.graph.nodes.map(node => node.id === 'n1'
  ? { ...node, evidence: '被误传为字符串的引文' } : node), updated.graph.edges)
const malformedPrimary = invalidCitationPayload(updated.graph.nodes.map(node => node.id === 'n1'
  ? { ...node, quote: { text: '伪造主引文' } } : node), updated.graph.edges)
for (const payload of [forgedNodeEvidence, forgedPrimaryQuote, forgedEdgeEvidence, malformedEvidence, malformedPrimary]) {
  assert((await handlers.get('graph-commit-preview')(payload)).error?.code === 'invalid_evidence_quote',
    'dynamic preview must reject an added fabricated citation')
  assert((await handlers.get('graph-commit')(payload)).error?.code === 'invalid_evidence_quote',
    'dynamic commit must reject an added fabricated citation')
}
assert((await handlers.get('document-export')({ documentId })).revision === updated.revision,
  'rejected citations must not change the dynamic graph revision')
const groupPayload = { documentId, expectedRevision: updated.revision, commitKind: 'bulk_review',
  graph: { summary: 'reviewed group', nodes: updated.graph.nodes, edges: updated.graph.edges,
    verification: { lastReport: { reportId: 'dynamic-group', issues: [{ id: 'one', status: 'applied' }] } } },
  baseNodeIds: updated.graph.nodes.map(node => node.id),
  baseEdgeKeys: updated.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
const dynamicPreview = await handlers.get('graph-commit-preview')(groupPayload)
assert(dynamicPreview.valid === true && dynamicPreview.revision === updated.revision,
  'dynamic Host must offer read-only preflight for the same group payload')
assert((await handlers.get('document-export')({ documentId })).revision === updated.revision,
  'dynamic preflight changed canonical revision')
const grouped = await handlers.get('graph-commit')(groupPayload)
assert(grouped.revision === updated.revision + 1 && !grouped.error, 'dynamic group commit failed')
const dynamicUndo = await handlers.get('graph-undo-bulk-review')({ documentId, expectedRevision: grouped.revision,
  parentRevision: updated.revision, reportId: 'dynamic-group' })
assert(dynamicUndo.revision === grouped.revision + 1 && !dynamicUndo.error, 'dynamic group undo failed')
const undoExport = await handlers.get('document-export')({ documentId })
assert(undoExport.revision === dynamicUndo.revision && undoExport.graph.summary === updated.graph.summary
  && !undoExport.graph.verification?.lastReport, 'dynamic undo did not restore the previous graph and report')
const repeatDynamicUndo = await handlers.get('graph-undo-bulk-review')({ documentId, expectedRevision: grouped.revision,
  parentRevision: updated.revision, reportId: 'dynamic-group' })
assert(repeatDynamicUndo?.error, 'an already undone dynamic group must not be undone again')

// The merge keeps only eight relation citations. A ninth submitted citation
// must not disappear before the source-authenticity gate sees it.
const cappedEdge = undoExport.graph.edges.find(edge => edge.fromNodeId === 'n2' && edge.toNodeId === 'n1')
assert(cappedEdge, 'citation-cap fixture relation is missing')
const cappedCitationPayload = { documentId, expectedRevision: undoExport.revision,
  graph: { ...undoExport.graph, edges: [{ ...cappedEdge, evidence: [
    { paragraph: 0, quote: '规则节点' }, { paragraph: 0, quote: '规则' },
    { paragraph: 0, quote: '规' }, { paragraph: 0, quote: '则' },
    { paragraph: 1, quote: '事实' }, { paragraph: 1, quote: '事' },
    { paragraph: 1, quote: '实' }, { paragraph: 1, quote: '不存在的第九项证据' },
  ] }] }, baseNodeIds: undoExport.graph.nodes.map(node => node.id), baseEdgeKeys: [] }
assert((await handlers.get('graph-commit-preview')(cappedCitationPayload)).error?.code === 'invalid_evidence_quote',
  'a fabricated relation citation must not be hidden by the merge evidence cap')
assert((await handlers.get('graph-commit')(cappedCitationPayload)).error?.code === 'invalid_evidence_quote',
  'dynamic commit must reject a fabricated citation hidden by the cap')
const validOverflow = { ...cappedCitationPayload, graph: { ...cappedCitationPayload.graph,
  edges: cappedCitationPayload.graph.edges.map(edge => ({ ...edge, evidence: edge.evidence.map((item, index) =>
    index === 7 ? { paragraph: 0, quote: '节' } : item) })) } }
const validOverflowPreview = await handlers.get('graph-commit-preview')(validOverflow)
assert(validOverflowPreview.error?.code === 'evidence_limit',
  'a valid ninth relation citation must not be silently discarded: ' + JSON.stringify(validOverflowPreview))
assert((await handlers.get('graph-commit')(validOverflow)).error?.code === 'evidence_limit',
  'dynamic commit must reject silently discarded valid evidence')
assert((await handlers.get('document-export')({ documentId })).revision === undoExport.revision,
  'citation-cap preview mutated the graph')

const eightQuotes = word => [word, word.slice(0, 2), word.slice(2), word[0], word[1], word[2], word[3], word.slice(0, 3)]
const evidenceRichNodes = undoExport.graph.nodes.map(node => ({ ...node,
  evidence: eightQuotes(node.id === 'n1' ? '规则节点' : '事实节点')
    .map(quote => ({ paragraph: node.id === 'n1' ? 0 : 1, quote })) }))
const richCommit = await handlers.get('graph-commit')({ documentId, expectedRevision: undoExport.revision,
  graph: { ...undoExport.graph, nodes: evidenceRichNodes }, baseNodeIds: evidenceRichNodes.map(node => node.id),
  baseEdgeKeys: undoExport.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) })
assert(!richCommit.error, 'valid eight-citation node fixture could not be committed: ' + JSON.stringify(richCommit))
const richExport = await handlers.get('document-export')({ documentId })
assert(richExport.graph.nodes.every(node => node.evidence.length === 8), 'node evidence cap fixture is not full')
const intoNode = richExport.graph.nodes.find(node => node.id === 'n1')
const mergeOverflow = { documentId, expectedRevision: richExport.revision,
  operations: [{ kind: 'merge_node', fromNodeId: 'n2', intoNodeId: 'n1' }],
  graph: { ...richExport.graph, nodes: [intoNode], edges: [] },
  baseNodeIds: richExport.graph.nodes.map(node => node.id),
  baseEdgeKeys: richExport.graph.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
assert((await handlers.get('graph-commit-preview')(mergeOverflow)).error?.code === 'evidence_limit',
  'merge_node must not silently discard the source node citations')
assert((await handlers.get('graph-commit')(mergeOverflow)).error?.code === 'evidence_limit',
  'merge_node commit must not silently discard the source node citations')
assert((await handlers.get('document-export')({ documentId })).revision === richExport.revision,
  'merge-node preview mutated the canonical graph')

const qualityStarted = await handlers.get('extract')({ title: 'gate-quality', text: '孤立事实' })
const qualityCompleted = await waitTask(qualityStarted.taskId)
assert(qualityCompleted.status === 'succeeded', 'quality-only findings must not block generation')
const qualityQuick = await handlers.get('verify-graph')({ text: '孤立事实', graph: qualityCompleted.result, mode: 'quick' })
assert(qualityQuick.report.metrics.errorCount === 0, 'quality-only graph was incorrectly counted as deterministic failure')
assert(qualityQuick.report.metrics.warningCount > 0 && qualityQuick.report.issues.some((issue) => issue.invariantCode === 'node_isolated'), 'quality warning layer did not preserve isolated-node guidance')

const hallucinatedSource = '今天上海下雨'
const emptyStarted = await handlers.get('extract')({ title: 'gate-hallucinated-empty', text: hallucinatedSource })
const emptyCompleted = await waitTask(emptyStarted.taskId)
assert(emptyCompleted.status === 'succeeded', 'missing quote should remain an explicit candidate instead of crashing extraction')
assert(emptyCompleted.result.nodes[0].groundingStatus === 'candidate', 'paragraph-only hallucinated claim was incorrectly marked grounded')
assert(emptyCompleted.result.nodes[0].evidence.length === 0, 'paragraph-only claim acquired fake evidence')
assert(emptyCompleted.result.generation.status === 'succeeded_with_warnings' && emptyCompleted.result.generation.grounding.candidateClaims === 1, 'candidate claim was not surfaced in generation audit')
const emptyQuick = await handlers.get('verify-graph')({ text: hallucinatedSource, graph: emptyCompleted.result, mode: 'quick' })
assert(emptyQuick.report.issues.some((issue) => issue.invariantCode === 'claim_evidence_missing'), 'quick check does not distinguish anchor from claim evidence')

const fakeStarted = await handlers.get('extract')({ title: 'gate-hallucinated-fake', text: hallucinatedSource })
const fakeCompleted = await waitTask(fakeStarted.taskId)
assert(fakeCompleted.status === 'succeeded', 'fake quote should be retained only as unsupported state for review')
assert(fakeCompleted.result.nodes[0].groundingStatus === 'unsupported' && fakeCompleted.result.nodes[0].evidence.length === 0, 'fabricated quote was incorrectly authenticated as evidence')
const fakeQuick = await handlers.get('verify-graph')({ text: hallucinatedSource, graph: fakeCompleted.result, mode: 'quick' })
assert(fakeQuick.report.issues.some((issue) => issue.invariantCode === 'node_evidence_unsupported'), 'fabricated quote is not diagnosed as unsupported')

const entailmentStarted = await handlers.get('extract')({ title: 'gate-entailment-unverified', text: hallucinatedSource })
const entailmentCompleted = await waitTask(entailmentStarted.taskId)
assert(entailmentCompleted.status === 'succeeded', 'authentic evidence fixture failed unexpectedly')
assert(entailmentCompleted.result.nodes[0].groundingStatus === 'grounded', 'authentic quote was not evidence-backed')
assert(entailmentCompleted.result.nodes[0].entailmentStatus === 'unverified', 'generation proposer was allowed to self-certify semantic entailment')
const entailmentQuick = await handlers.get('verify-graph')({ text: hallucinatedSource, graph: entailmentCompleted.result, mode: 'quick' })
assert(entailmentQuick.report.metrics.evidenceCoverage === 100 && entailmentQuick.report.metrics.entailmentCoverage === 0, 'evidence authenticity and semantic entailment metrics are conflated')

const entailmentDocumentId = entailmentCompleted.result.source.documentId
const forgedEntailment = await handlers.get('graph-commit')({
  documentId: entailmentDocumentId,
  expectedRevision: entailmentCompleted.result.source.revision,
  graph: {
    summary: entailmentCompleted.result.summary,
    nodes: entailmentCompleted.result.nodes.map((node) => ({ ...node, entailmentStatus: 'verified' })),
    edges: entailmentCompleted.result.edges,
  },
  baseNodeIds: entailmentCompleted.result.nodes.map((node) => node.id),
  baseEdgeKeys: [],
})
assert(forgedEntailment && !forgedEntailment.error, 'ordinary graph edit was rejected while testing entailment authority')
const entailmentExport = await handlers.get('document-export')({ documentId: entailmentDocumentId })
assert(entailmentExport.graph.nodes[0].entailmentStatus === 'unverified', 'browser graph-commit was allowed to self-promote entailmentStatus=verified')

const fatalStarted = await handlers.get('extract')({ title: 'gate-fatal', text: '没有 id 的节点' })
assert(fatalStarted && fatalStarted.taskId, 'fatal invariant task was not created')
const fatal = await waitTask(fatalStarted.taskId)
assert(fatal.status === 'failed', 'unrepairable node invariant must not publish a succeeded graph')
assert(fatal.error && fatal.error.code === 'invariant_violation', 'unrepairable invariant did not fail with invariant_violation: ' + JSON.stringify(fatal))
assert(calls.filter((call) => call.title === 'gate-fatal').length === 3, 'unrepairable invariant did not use the bounded retry budget')

console.log(JSON.stringify({
  ok: true,
  retries: completed.result.generation.retryCount,
  invariantErrorsAfterGeneration: quick.report.metrics.invariantErrorCount,
  qualityWarningsAfterGeneration: quick.report.metrics.warningCount,
  qualityOnlyWarnings: qualityQuick.report.metrics.warningCount,
  fatalCode: fatal.error.code,
}))
