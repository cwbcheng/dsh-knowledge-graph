import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Compare cached and uncached execution of the SAME matcher. No matching rule,
// offset, fallback, or validation issue may change as a performance shortcut.
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const calls = []
globalThis.kgAnchorNormalization = (text, mode) => calls.push({ text, mode })
function instrument(source, name, cached) {
  assert(source.includes(`function ${name}(s, mode) {`))
  assert(source.includes('if (!sourceForms.has(mode))'))
  source = source.replace(`function ${name}(s, mode) {`, `function ${name}(s, mode) { globalThis.kgAnchorNormalization(s, mode);`)
  return cached ? source : source.replace('if (!sourceForms.has(mode))', 'if (true)')
}
function client(cached) {
  const sandbox = { window: { React: {} }, console, kgAnchorNormalization: globalThis.kgAnchorNormalization }
  runInNewContext(instrument(viewer, 'normalizeFor', cached).replace('window.KGViewer = {', 'window.KGViewer = { resolveAnchor,'), sandbox)
  return sandbox.window.KGViewer
}
async function host(cached) {
  const code = instrument(hostSource, 'normalizeForHost', cached).replace('normalizeGraph, renumberNewIds, mergeBatch,', 'resolveAnchor: resolveAnchorHost, normalizeGraph, renumberNewIds, mergeBatch,')
  return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).createGraphContract()
}
const optimizedClient = client(true), referenceClient = client(false)
const optimizedHost = await host(true), referenceHost = await host(false)
const plain = value => JSON.parse(JSON.stringify(value))
const source = '# Book\n\nalpha,beta gamma\n\nAn astral symbol: \u{1f4da} delta\n\n' + 'Unrelated contextual material.\n\n'.repeat(150) + 'omega  value\n\nalpha,beta gamma'
const quotes = [
  'alpha,beta gamma', 'alpha!beta gamma', 'omega value', 'alpha ! beta gamma',
  'An astral symbol: \u{1f4da} delta', 'delta', 'alpha,beta gamma missing suffix',
  'missing prefix alpha,beta gamma', 'alXpha,beta gamma', 'not present anywhere', '', '  ',
]
for (const [optimized, reference] of [[optimizedClient, referenceClient], [optimizedHost, referenceHost]]) {
  const shared = new Map()
  for (const quote of quotes) {
    for (const fallback of ['', 'omega value']) {
      assert.equal(optimized.resolveAnchor(quote, source, fallback, shared), reference.resolveAnchor(quote, source, fallback), quote)
    }
  }
  assert.equal(optimized.resolveAnchor('alpha!beta gamma', source), source.indexOf('alpha,beta gamma'))
  assert.equal(optimized.resolveAnchor('delta', source), source.indexOf('delta'), 'offsets remain UTF-16 source offsets')
}
const graph = { nodes: Array.from({ length: 2000 }, (_, i) => ({ id: 'n' + i, type: 'concept', text: 'alpha beta', quote: 'alpha!beta gamma' })), edges: [] }
function assertBoundedSourceWork(run, text) {
  calls.length = 0
  const result = run()
  const sourceCalls = calls.filter(call => call.text === text)
  assert(sourceCalls.length > 0, 'fixture must exercise normalization, not only exact matching')
  assert(sourceCalls.length <= 3, 'whole-source normalization must not scale with node count')
  assert.equal(new Set(sourceCalls.map(call => call.mode)).size, sourceCalls.length, 'each mode is built at most once per pass')
  return result
}
const view = assertBoundedSourceWork(() => optimizedClient.makeView(graph, source), source)
const validation = assertBoundedSourceWork(() => optimizedHost.validateGraphInvariants(graph, source), source)
assert.equal(Object.keys(view.anchors).length, 2000)
assert.equal(validation.metrics.anchorCoverage, 100)
assert.equal(validation.metrics.checkedNodes, 2000, 'every node must still be validated')
calls.length = 0
const exactGraph = { ...graph, nodes: graph.nodes.map(node => ({ ...node, quote: 'alpha,beta gamma' })) }
optimizedClient.makeView(exactGraph, source)
optimizedHost.validateGraphInvariants(exactGraph, source)
assert.equal(calls.filter(call => call.text === source).length, 0, 'exact matches should not allocate normalized source forms')
// A second document with shifted matches must not inherit source offsets.
for (const text of ['Preface changes all offsets.\n\n' + source, source]) {
  const current = assertBoundedSourceWork(() => optimizedClient.makeView(graph, text), text)
  assert.equal(current.anchors.n0, text.indexOf('alpha,beta gamma'))
  assertBoundedSourceWork(() => optimizedHost.validateGraphInvariants(graph, text), text)
}
// Include malformed declarations, unanchored nodes, counter examples, duplicate
// and dangling edges: faster matching must not weaken deterministic acceptance.
const adversarial = {
  nodes: quotes.map((quote, i) => ({ id: 'n' + i, type: i === 0 ? 'counter_example' : 'concept', text: quote || 'fallback', quote, paragraph: i % 3 === 0 ? 0 : undefined })),
  edges: [
    { fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports', evidence: [{ paragraph: 1, quote: 'alpha,beta gamma' }] },
    { fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports', evidence: [] },
    { fromNodeId: 'n2', toNodeId: 'missing', relation: 'unknown' },
  ],
}
const expectedView = referenceClient.makeView(adversarial, source)
assert(calls.filter(call => call.text === source).length > 3, 'uncached negative control must reproduce repeated source work')
assert.deepEqual(plain(optimizedClient.makeView(adversarial, source)), plain(expectedView))
for (const includeQuality of [false, true]) {
  const result = optimizedHost.validateGraphInvariants(adversarial, source, { includeQuality })
  assert.deepEqual(result, referenceHost.validateGraphInvariants(adversarial, source, { includeQuality }))
  assert(result.blockingIssues.some(issue => issue.code === 'counter_example_without_target'))
  assert(result.blockingIssues.some(issue => issue.code === 'edge_missing_node'))
}
delete globalThis.kgAnchorNormalization
console.log('Anchor cache smoke passed: bounded source work, unchanged matching and invariants, document isolation')
