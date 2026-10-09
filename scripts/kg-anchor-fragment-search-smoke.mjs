import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const bundle = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const start = bundle.indexOf('        const minLen = 3\n'), end = bundle.indexOf('        const rawHit = fuzzyMatch', start)
assert(start > 0 && end > start && bundle.slice(start, end).includes('const partialHit = suffix =>'), 'exercise the generated production matcher')
// The prior descending scan is the semantic reference: longest fragment,
// first source occurrence, prefix before suffix, then the original fuzzy path.
const oldFragments = `        const minLen = 3
        const maxLen = Math.min(q.length, 24)
        for (let len = maxLen; len >= minLen; len--) {
          const hit = source.indexOf(q.slice(0, len))
          if (hit >= 0) return hit
        }
        for (let len = maxLen; len >= minLen; len--) {
          const hit = source.indexOf(q.slice(q.length - len))
          if (hit >= 0) return hit
        }
`
const referenceCode = bundle.slice(0, start) + oldFragments + bundle.slice(end)
function load(code, count = () => {}) {
  const first = code.indexOf('        const minLen = 3\n'), last = code.indexOf('        const rawHit = fuzzyMatch', first)
  const measured = code.slice(0, first) + code.slice(first, last).replaceAll('source.indexOf(', 'indexFragment(source, ') + code.slice(last)
  const sandbox = { window: { React: {} }, console, indexFragment(text, needle) { count(); return text.indexOf(needle) } }
  runInNewContext(measured.replace('window.KGViewer = {', 'window.KGViewer = { resolveNeedle, resolveAnchor, neighborhoodAnchors,'), sandbox)
  return sandbox.window.KGViewer
}
const current = load(bundle), reference = load(referenceCode), plain = value => JSON.parse(JSON.stringify(value))
let queries = 0, views = 0
function parity(quote, source, expected) {
  const actual = current.resolveNeedle(quote, source, new Map())
  assert.equal(actual, reference.resolveNeedle(quote, source, new Map()), 'same source offset for ' + JSON.stringify(quote))
  if (arguments.length > 2) assert.equal(actual, expected)
  assert.equal(current.resolveNeedle(quote, source, new Map(), true), reference.resolveNeedle(quote, source, new Map(), true), 'exact-only path parity')
  queries += 2
}
for (const quote of ['abcdefghijklmnopqrstuvwxyz0123456789', '😀甲乙abcdefghijklmnopqrstuv尾部😀终点123456']) {
  for (let length = 3; length <= 24; length++) {
    for (const suffix of [false, true]) {
      const fragment = size => suffix ? quote.slice(quote.length - size) : quote.slice(0, size)
      const source = 'Earlier ' + fragment(length - 1) + '~\n\nLater ' + fragment(length) + '~ repeated ' + fragment(length) + '~'
      parity(quote, source, source.indexOf(fragment(length)))
    }
  }
}
// A shorter prefix takes precedence over even a much longer suffix. The
// 24-code-unit cap, trimming and zero offsets remain part of the old contract.
const quote = 'abcdefghijklmnopqrstuvwxyz0123456789'
const both = quote.slice(-24) + '~\n\n' + quote.slice(0, 3) + '~'
parity(quote, both, both.indexOf(quote.slice(0, 3)))
parity(quote, quote.slice(0, 24) + '~\n\n' + quote.slice(0, 30), 0)
parity('  ' + quote + '\t', quote.slice(0, 12) + '~', 0)
for (const value of [null, undefined, '', ' ', 'a', 'ab', 'abc', 'abcd', '😀', '😀a']) parity(value, 'abc😀alpha,beta\r\n甲类　乙类')
parity('alpha!beta gamma', '😀 source: alpha,beta gamma', '😀 source: '.length)
parity('ABCDEFGHIJKL', 'AqBCDEFGHIJKqL', 0) // Both fragments miss; fuzzy matching must still run.
parity('ZZZ missing text QQQ', 'Entirely unrelated content.', null)

const alphabet = ['A', 'B', 'C', 'D', ' ', ',', '\t', '😀', '甲', '\r', '\n']
let seed = 66121
const random = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n }
for (let trial = 0; trial < 5000; trial++) {
  const source = Array.from({ length: 25 + random(80) }, () => alphabet[random(alphabet.length)]).join('')
  const quote = trial % 3 === 0 ? source.slice(random(12), 24 + random(20)) + 'UNKNOWNEND'
    : trial % 3 === 1 ? 'UNKNOWNSTART' + source.slice(random(12), 24 + random(20))
      : Array.from({ length: random(40) }, () => alphabet[random(alphabet.length)]).join('')
  parity(quote, source)
}
const paragraphs = ['Repeated observation.', 'alpha,beta gamma', '甲类　乙类', '> A quoted line.\r\n> Another line.',
  '  code_alpha();\n  code_beta();', '| a | b |\n| c | d |', quote.slice(0, 8) + '~', quote.slice(-15) + '~']
const quotes = [quote, 'ZZZ alpha beta QQQ', 'alpha!beta gamma', 'alpha,beta gamma UNKNOWNEND',
  'UNKNOWNSTART alpha,beta gamma', 'ZZZ 甲类 乙类 QQQ', 'Repeated observation.', '', '😀alpha', 'ABCDEFGHIJKL']
const graph = { nodes: quotes.map((text, i) => ({ id: 'n' + i, type: i % 2 ? 'concept' : 'fact', text: i % 3 ? '' : 'Repeated observation.', quote: text,
  ...(i % 4 === 0 ? { paragraph: 0 } : i % 4 === 1 ? { paragraph: 999 } : {}) })),
  edges: [{ fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports' }, { fromNodeId: 'n0', toNodeId: 'missing', relation: 'supports' }] }
const saved = JSON.stringify(graph)
for (const source of [paragraphs.join('\n\n'), paragraphs.join('\r\n\r\n'), '', 'Preface.\n\n' + paragraphs.join('\n\n'),
  paragraphs.join('\n\n') + '\n\nMore evidence.', 'Different document.']) {
  assert.deepEqual(plain(current.makeView(graph, source)), plain(reference.makeView(graph, source)), 'complete view parity')
  assert.deepEqual(plain(current.neighborhoodAnchors(graph.nodes, source, {})), plain(reference.neighborhoodAnchors(graph.nodes, source, {})), 'shared neighborhood matcher parity')
  assert.equal(JSON.stringify(graph), saved, 'inputs remain unchanged')
  views++
}
// Work counters run separately from timings and exclude exact/normalized and
// fuzzy searches. They detect the repeated descending fragment scans directly.
let currentSearches = 0, referenceSearches = 0
const measured = load(bundle, () => currentSearches++), measuredReference = load(referenceCode, () => referenceSearches++)
const book = 'Fixture observation recorded in the source.\n\n'.repeat(2000)
for (let i = 0; i < 64; i++) assert.equal(measured.resolveNeedle('ZZZ observation ' + i + ' recorded QQQ', book, new Map()),
  measuredReference.resolveNeedle('ZZZ observation ' + i + ' recorded QQQ', book, new Map()))
assert.equal(currentSearches, 64 * 4)
assert.equal(referenceSearches, 64 * 44, 'negative control must reproduce repeated full-source fragment searches')
const missCounts = { current: currentSearches, reference: referenceSearches }
for (let length = 3; length < 24; length++) {
  for (const suffix of [false, true]) {
    currentSearches = referenceSearches = 0
    const fragment = suffix ? quote.slice(-length) : quote.slice(0, length)
    const source = '--' + fragment + '~'
    assert.equal(measured.resolveNeedle(quote, source, new Map()), measuredReference.resolveNeedle(quote, source, new Map()))
    assert(currentSearches <= (suffix ? 9 : 7), 'partial-hit work remains bounded as the winning length varies')
    assert.equal(referenceSearches, (suffix ? 22 : 0) + 25 - length)
  }
}
currentSearches = referenceSearches = 0
const longPrefix = 'Fixture observation recorded in the source. UNKNOWNEND'
assert.equal(measured.resolveNeedle(longPrefix, book, new Map()), measuredReference.resolveNeedle(longPrefix, book, new Map()))
assert.equal(currentSearches, 1, 'a longest-prefix hit keeps its one-search fast path')
assert.equal(referenceSearches, 1)
currentSearches = 0
measured.resolveNeedle('Fixture observation recorded in the source.', book, new Map())
measured.resolveNeedle('alpha!beta gamma', 'alpha,beta gamma', new Map())
measured.resolveNeedle(longPrefix, book, new Map(), true)
assert.equal(currentSearches, 0, 'direct, normalized and exact-only matches never search partial fragments')
console.log(JSON.stringify({ queries, views, missFragmentSearches: missCounts, longestFirstOffset: true,
  prefixPrecedence: true, utf16AndCap: true, fuzzyFallback: true, boundedPartialHits: true, unchangedInputs: true, directPath: true }))
