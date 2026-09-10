import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function reviewHighRiskRelationsHost('
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `      harness.reviewTest = { reviewHighRiskRelationsHost, attach(task) { activeTask = task } }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const contract = createGraphContract()
let mode = 'supported', calls = [], task
const harness = { handle() {} }
globalThis.harness = harness
plugin().apply({ get(name) { return name === 'kgExtractor' ? {
  async reviewRelations({ candidates, units }) {
    calls.push(candidates.map(item => item.edge.fromNodeId))
    assert.ok(candidates.length <= 16, 'request size must stay bounded')
    if (mode === 'cancel') task.cancelled = true
    return { verdicts: candidates.map((item, index) => ({
      id: (mode === 'invalid-tail' && calls.length > 4) || (mode === 'one-invalid' && item.edge.fromNodeId === 'ce20') ? 'unknown' : item.id,
      verdict: mode === 'reject-tail' && item.edge.fromNodeId === 'ce128' ? 'insufficient' : 'supported',
      evidence: [{ paragraph: units[0].num, quote: units[0].text }],
      reason: 'Synthetic verdict for traversal regression, not a semantic quality claim',
    })) }
  },
} : null }, interval() {} })

const paragraphs = ['一般命题存在适用边界，反例表明该命题并非总是成立。']
function fixture(count) {
  const nodes = [{ id: 'target', type: 'claim', text: paragraphs[0], quote: paragraphs[0], paragraph: 0 }]
  const edges = []
  for (let i = 0; i < count; i++) {
    nodes.push({ id: 'ce' + i, type: 'counter_example', text: paragraphs[0], quote: paragraphs[0], paragraph: 0 })
    edges.push({ fromNodeId: 'ce' + i, toNodeId: 'target', relation: 'counter_example', evidence: [{ paragraph: 0, quote: paragraphs[0] }] })
  }
  return { nodes, edges, warnings: [] }
}
async function review(graph, units = paragraphs, protectedKeys = new Set()) {
  calls = []
  task = { progress: {}, cancelled: false }
  harness.reviewTest.attach(task)
  return harness.reviewTest.reviewHighRiskRelationsHost(task, null, graph, units, protectedKeys)
}
for (const count of [64, 65, 129, 2500]) {
  const graph = fixture(count)
  const result = await review(graph)
  assert.equal(result.reviewed, count)
  assert.equal(result.pending, 0)
  assert.equal(graph.edges.length, count)
  assert.equal(calls.length, Math.ceil(count / 16))
  assert.equal(new Set(calls.flat()).size, count, 'each candidate must be visited exactly once')
  assert.ok(!contract.validateGraphInvariants(graph, paragraphs[0], { includeQuality: false }).blockingIssues.some(issue => issue.code === 'counter_example_without_target'))
}
mode = 'reject-tail'
const rejected = fixture(129)
const rejectedResult = await review(rejected)
assert.equal(rejectedResult.pending, 0)
assert.equal(rejectedResult.withheld.length, 1)
assert.equal(rejectedResult.withheld[0].verdict, 'insufficient')
assert.ok(contract.validateGraphInvariants(rejected, paragraphs[0], { includeQuality: false }).blockingIssues.some(issue => issue.code === 'counter_example_without_target' && issue.targetId === 'ce128'), 'real rejection must still fail the invariant; never downgrade or invent a target')
mode = 'invalid-tail'
const invalid = fixture(65)
const invalidResult = await review(invalid)
assert.equal(invalidResult.reviewed, 64)
assert.equal(invalidResult.pending, 1)
assert.equal(invalidResult.withheld[0].verdict, 'pending', 'unreviewed is not a semantic rejection')
mode = 'cancel'
const cancelled = fixture(65)
await assert.rejects(review(cancelled), error => error.code === 'cancelled')
assert.equal(calls.length, 1, 'cancellation must stop scheduling further batches')
assert.equal(cancelled.edges.length, 65, 'cancelled review must not partially delete candidates')
mode = 'one-invalid'
const mixed = fixture(33)
const mixedResult = await review(mixed)
assert.equal(mixedResult.reviewed, 32, 'one malformed decision must not leave its entire batch unreviewed')
assert.equal(mixedResult.pending, 1)
assert.deepEqual(mixedResult.withheld.map(item => item.edge.fromNodeId), ['ce20'])
assert.equal(mixedResult.failures.length, 1)
assert.deepEqual(mixedResult.failures[0].edges, ['ce20>target:counter_example'])
mode = 'supported'
const wide = fixture(16)
const wideUnits = Array.from({ length: 16 }, (_, i) => '资料' + i + '。' + '上下文'.repeat(1000))
wide.nodes.slice(1).forEach((node, i) => { node.paragraph = i; node.quote = wideUnits[i] })
wide.edges.forEach((edge, i) => { edge.evidence = [{ paragraph: i, quote: wideUnits[i] }] })
const wideResult = await review(wide, wideUnits)
assert.equal(wideResult.reviewed, 16)
assert.ok(calls.length > 1, 'oversized contexts must be split instead of skipped')

// Optional read-only replay of a local failed checkpoint. The reviewer remains
// synthetic: this proves traversal/structural preservation, not AI correctness.
if (process.argv[2]) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(process.argv[2], { readOnly: true })
  try {
    const row = db.prepare('SELECT checkpoint_json,source_text FROM extraction_runs WHERE run_id=?').get(process.argv[3])
    assert.ok(row, 'checkpoint not found')
    const graph = JSON.parse(row.checkpoint_json).graph
    const units = contract.splitParagraphs(row.source_text)
    const originalEdges = graph.edges.length
    mode = 'supported'
    const result = await review(graph, units)
    assert.equal(result.reviewed, result.eligible, JSON.stringify(result.errors))
    assert.equal(result.pending, 0)
    assert.equal(graph.edges.length, originalEdges)
    assert.ok(!contract.validateGraphInvariants(graph, row.source_text, { includeQuality: false }).blockingIssues.some(issue => issue.code === 'counter_example_without_target'))
    console.log(JSON.stringify({ readOnlyCheckpointReplay: true, nodes: graph.nodes.length, edges: graph.edges.length, reviewed: result.reviewed, batches: calls.length, pending: result.pending, syntheticReviewer: true }))
  } finally { db.close() }
}
console.log(JSON.stringify({ fullTraversal: true, boundedRequests: true, tailRejectionStillBlocks: true, malformedTailPending: true, cancellation: true }))
