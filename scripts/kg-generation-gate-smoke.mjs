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
