import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const sandbox = { window: { React: {} }, console }
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { neighborhoodAnchors,'), sandbox)
const api = sandbox.window.KGViewer
const source = 'Repeated observation.\n\nAn unrelated paragraph.\n\nRepeated observation.\n\nalpha,beta gamma\n\nPrefix: a precise quotation.'
const paragraphs = api.splitParagraphs(source)
const cases = [
  { id: 'repeat', quote: 'Repeated observation.', text: 'Observation', paragraph: 2, expected: paragraphs[2].start },
  { id: 'normalized', quote: 'alpha!beta gamma', text: 'Alpha', paragraph: 3, expected: paragraphs[3].start },
  { id: 'precise', quote: '  a precise quotation.  ', paragraph: 4, expected: source.indexOf('a precise quotation.') },
  { id: 'empty-quote', quote: '', paragraph: 4, expected: paragraphs[4].start },
  { id: 'paraphrase', quote: 'Repeated observation without an exact quotation.', text: 'Observation', paragraph: 1, expected: paragraphs[1].start },
  { id: 'legacy', quote: 'An unrelated paragraph.', text: 'Old node', expected: paragraphs[1].start },
  { id: 'stale-metadata', quote: 'An unrelated paragraph.', paragraph: 0, expected: paragraphs[1].start },
  { id: 'fractional', quote: 'An unrelated paragraph.', paragraph: 1.5, expected: paragraphs[1].start },
  { id: 'outside', quote: 'An unrelated paragraph.', paragraph: 100, expected: paragraphs[1].start },
  { id: 'unknown', quote: '', text: '', paragraph: -1, expected: null },
]
const nodes = cases.map(({ expected, ...node }) => ({ type: 'fact', ...node }))
const view = api.makeView({ nodes, edges: [] }, source)
const gathered = api.neighborhoodAnchors(nodes, source, {})
for (const item of cases) {
  assert.equal(view.anchors[item.id], item.expected, 'base anchor: ' + item.id)
  assert.equal(gathered[item.id], item.expected, 'cross-window anchor: ' + item.id)
}
assert(view.paraNodes[2].includes('repeat'), 'source-to-node linkage must use the same paragraph as node-to-source')
assert(!view.paraNodes[0].includes('repeat'), 'the first duplicate is not the node source')

const windowsSource = '> First line.\r\n> Second line with \u{1f600} and exact evidence.\r\n\r\nAnother paragraph.'
const windowsNode = { id: 'windows', type: 'fact', paragraph: 0, quote: 'exact evidence.' }
const windowsView = api.makeView({ nodes: [windowsNode], edges: [] }, windowsSource)
assert.equal(windowsView.anchors.windows, windowsSource.indexOf(windowsNode.quote), 'CRLF and UTF-16 offsets stay source-aligned')
assert.equal(api.neighborhoodAnchors([windowsNode], windowsSource, {}).windows, windowsView.anchors.windows)

// Exact paragraph evidence takes the local fast path. Paraphrased evidence
// may check complete quotes elsewhere, but never scans the book fuzzily.
let fullSourceSearches = 0, fullSourceFuzzySearches = 0
const measured = { window: { React: {} }, console,
  observe: value => { if (value.length > 1000) fullSourceSearches++ },
  observeFuzzy: value => { if (value.length > 1000) fullSourceFuzzySearches++ },
}
runInNewContext(viewer.replace('function resolveNeedle(needle, source,', 'function resolveNeedleMeasured(needle, source,')
  .replace('function resolveAnchor(', 'function resolveNeedle(needle, source, ...args) { observe(source); return resolveNeedleMeasured(needle, source, ...args) }\nfunction resolveAnchor(')
  .replace('const minLen = 3', 'observeFuzzy(source); const minLen = 3'), measured)
const book = Array.from({ length: 2000 }, (_, i) => 'Paragraph ' + i + ' has specific source evidence.')
measured.window.KGViewer.makeView({ nodes: [{ id: 'legacy-control', type: 'fact', quote: 'Paragraph 0 has paraphrased evidence.' }], edges: [] }, book.join('\n\n'))
assert(fullSourceSearches > 0 && fullSourceFuzzySearches > 0, 'the work counters must observe a legacy full-source fallback')
fullSourceSearches = fullSourceFuzzySearches = 0
const largeGraph = { nodes: book.map((text, i) => ({ id: 'n' + i, type: 'fact', text, quote: text, paragraph: i })), edges: [] }
const started = performance.now()
const large = measured.window.KGViewer.makeView(largeGraph, book.join('\n\n'))
assert.equal(large.unresolved.length, 0)
assert.equal(fullSourceSearches, 0, 'complete paragraph evidence must not search the entire book')
assert.equal(large.paraNodes[1999][0], 'n1999')
const exactElapsedMs = Math.round(performance.now() - started)
const paraphrased = { ...largeGraph, nodes: largeGraph.nodes.map((node, i) => ({ ...node, quote: 'Paragraph ' + i + ' contains paraphrased evidence.' })) }
const paraphrasedView = measured.window.KGViewer.makeView(paraphrased, book.join('\n\n'))
assert.equal(fullSourceFuzzySearches, 0, 'partial matches in unrelated paragraphs must not override a valid paragraph')
assert.equal(paraphrasedView.paraNodes[1999][0], 'n1999')
console.log(JSON.stringify({ paragraphAnchors: true, duplicateQuotes: true, neighborhoodParity: true, staleMetadataCorrection: true, legacyFallback: true, nodes: 2000, exactFullSourceSearches: 0, fullSourceFuzzySearches, exactElapsedMs }))
