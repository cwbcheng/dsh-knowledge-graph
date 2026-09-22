import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      function validateGraphInvariantsHost('
assert.equal(source.split(marker).length, 2)
source = source.replace(marker, `      harness.validation = { validateGraphInvariantsHost, reset() { if (typeof invariantSourceCache !== 'undefined') invariantSourceCache = null } }
${marker}`)
source = source.replace('function splitParagraphsOffsetsHost(', `function splitParagraphsOffsetsHost(...args) {
  harness.parses++
  return countedSplitParagraphsOffsetsHost(...args)
}
function countedSplitParagraphsOffsetsHost(`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const previousHarness = globalThis.harness
const harness = { handle() {}, parses: 0 }
globalThis.harness = harness
plugin().apply({ get() { return null }, interval() {} })
const api = harness.validation
const text = 'Device A consumes five watts.\n\nDevice B consumes seven watts.'
const graph = { nodes: [{ id: 'a', type: 'fact', text: 'Device A consumes five watts.', quote: 'Device A consumes five watts.', paragraph: 0 }], edges: [], warnings: [] }
try {
  const first = api.validateGraphInvariantsHost(graph, text, { includeQuality: true })
  assert.equal(first.blockingIssues.length, 0)
  assert.deepEqual(api.validateGraphInvariantsHost(structuredClone(graph), text, { includeQuality: true }), first)
  assert.equal(harness.parses, 1, 'repeated validation must not rebuild the same immutable source index')

  for (const [candidate, input, options] of [
    [{ ...graph, nodes: [{ ...graph.nodes[0], paragraph: 1 }] }, text, {}],
    [{ ...graph, nodes: [{ ...graph.nodes[0], quote: 'Missing evidence' }] }, text, { includeQuality: true }],
    [graph, 'Changed source.\n\nDevice A consumes five watts.', {}],
    [graph, text.replaceAll('\n', '\r\n'), { includeQuality: true }],
    [graph, '# Heading\n\n' + text, { includeQuality: false }],
    [graph, '', { includeQuality: true }],
    [{ ...graph, ontology: 'learning-view-v1' }, text, { includeQuality: true }],
    [graph, text, { normalizationWarnings: ['node_dropped:fixture'] }],
    [{ ...graph, nodes: [], edges: [{ fromNodeId: 'a', toNodeId: 'b', relation: 'supports', evidence: [{ paragraph: 0, quote: graph.nodes[0].quote }] }] }, text,
      { extraNodes: new Map([['a', graph.nodes[0]], ['b', { ...graph.nodes[0], id: 'b' }]]) }],
  ]) {
    const warmed = api.validateGraphInvariantsHost(structuredClone(candidate), input, options)
    api.reset()
    const cold = api.validateGraphInvariantsHost(structuredClone(candidate), input, options)
    assert.deepEqual(warmed, cold, 'source caching cannot cache any graph verdict, ontology, or extra-node authority')
  }
  const mutable = structuredClone(graph)
  api.validateGraphInvariantsHost(mutable, text)
  mutable.nodes[0].quote = 'A missing quotation'
  mutable.nodes[0].paragraph = 999
  assert.ok(api.validateGraphInvariantsHost(mutable, text).blockingIssues.some(issue => issue.code === 'node_unanchored'), 'in-place graph edits require a fresh verdict')
  api.reset()
  const before = harness.parses
  api.validateGraphInvariantsHost(graph, text)
  api.validateGraphInvariantsHost(graph, 'Other document.')
  api.validateGraphInvariantsHost(graph, text)
  assert.equal(harness.parses - before, 3, 'the cache retains only one source, rather than every processed document')
  console.log(JSON.stringify({ ok: true, oneParseForRepeatedValidation: true, freshGraphChecks: true, sourceChangesInvalidated: true, ontologyIsolation: true, singleSourceBound: true }))
} finally {
  if (previousHarness === undefined) delete globalThis.harness
  else globalThis.harness = previousHarness
}
