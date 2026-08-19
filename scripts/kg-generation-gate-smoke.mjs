import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const calls = []
const extractor = async ({ title, attempt, prompt }) => {
  calls.push({ title, attempt, prompt })
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

const qualityStarted = await handlers.get('extract')({ title: 'gate-quality', text: '孤立事实' })
const qualityCompleted = await waitTask(qualityStarted.taskId)
assert(qualityCompleted.status === 'succeeded', 'quality-only findings must not block generation')
const qualityQuick = await handlers.get('verify-graph')({ text: '孤立事实', graph: qualityCompleted.result, mode: 'quick' })
assert(qualityQuick.report.metrics.errorCount === 0, 'quality-only graph was incorrectly counted as deterministic failure')
assert(qualityQuick.report.metrics.warningCount > 0 && qualityQuick.report.issues.some((issue) => issue.invariantCode === 'node_isolated'), 'quality warning layer did not preserve isolated-node guidance')

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
