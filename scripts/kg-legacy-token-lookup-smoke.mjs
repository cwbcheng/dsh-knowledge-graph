import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const bundle = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const cached = 'const tokens = paragraphTokens[i] || (paragraphTokens[i] = new Set(tokenize(paragraphs[i].text)))'
const start = bundle.indexOf('      function createParagraphTokenLookup(paragraphs) {')
const end = bundle.indexOf('      function makeView(', start)
assert(start > 0 && end > start, 'exercise the generated production lookup')
const oldLookup = `      function createParagraphTokenLookup(paragraphs) {
        const paragraphTokens = []
        return quote => {
          const qt = tokenize(quote)
          let bestPi = -1, bestScore = 0
          if (qt.length) for (let i = 0; i < paragraphs.length; i++) {
            const tokens = paragraphTokens[i] || (paragraphTokens[i] = new Set(tokenize(paragraphs[i].text)))
            let score = 0
            for (const t of qt) if (t.length >= 2 && tokens.has(t)) score += 1
            if (score > bestScore) { bestScore = score; bestPi = i }
          }
          return bestScore >= 2 ? paragraphs[bestPi].start : null
        }
      }

`
const linearReferenceCode = bundle.slice(0, start) + oldLookup + bundle.slice(end)
assert(linearReferenceCode.includes(cached))
function load(code, observe = () => {}, work = null) {
  const sandbox = { window: { React: {} }, console, observe,
    membership(tokens, t) { work.membership = (work.membership || 0) + 1; return tokens.has(t) },
    step(name) { work[name] = (work[name] || 0) + 1 },
  }
  if (work) code = code.replace('tokens.has(t)', 'membership(tokens, t)')
    .replace('postings = new Map()', 'step("indexBuilds"); postings = new Map()')
    .replace('scores = new Uint32Array(paragraphs.length)', 'step("scoreAllocations"); scores = new Uint32Array(paragraphs.length)')
    .replace('const score = scores[i] + weight', 'step("postingUpdates"); const score = scores[i] + weight')
  runInNewContext(code.replace('function tokenize(s) {', 'function tokenize(s) { observe(s);'), sandbox)
  return sandbox.window.KGViewer
}
const plain = value => JSON.parse(JSON.stringify(value))
const referenceCode = linearReferenceCode.replace(cached, 'const tokens = new Set(tokenize(paragraphs[i].text))')
const api = load(bundle), reference = load(referenceCode)
const node = (id, quote, extra = {}) => ({ id, type: 'fact', text: '', quote, ...extra })
const source = ['alpha beta', 'alpha gamma', 'beta gamma', 'alpha alpha gamma', '甲类　乙类',
  '😀 alpha', '> alpha quote\n> gamma evidence', '  code_alpha();\n  code_beta();',
  '| alpha | beta |\n| gamma | delta |', 'unique last evidence'].join('\n\n')
const quotes = ['ZZZ alpha beta QQQ', 'ZZZ alpha alpha QQQ', 'ZZZ gamma gamma alpha QQQ',
  'ZZZ alpha QQQ', 'ZZZ beta QQQ', 'ZZZ Alpha QQQ', 'ZZZ 甲类\t乙类 QQQ',
  'ZZZ 😀 😀 QQQ', 'ZZZ missing tokens QQQ', 'ZZZ a b QQQ', 'ZZZ　alpha\tbeta QQQ', '', '   ']
let views = 0
function parity(graph, text) {
  const saved = JSON.stringify(graph), view = api.makeView(graph, text)
  assert.deepEqual(plain(view), plain(reference.makeView(graph, text)), 'complete view parity with uncached scoring')
  assert.equal(JSON.stringify(graph), saved, 'fallback must not rewrite quote, graph or source identity')
  views++
  return view
}
const graph = { nodes: quotes.map((quote, i) => node('q' + i, quote)), edges: [
  { fromNodeId: 'q0', toNodeId: 'q1', relation: 'supports' },
  { fromNodeId: 'q0', toNodeId: 'missing', relation: 'supports' },
  { fromNodeId: 'q0', toNodeId: 'q0', relation: 'supports' },
] }
const first = parity(graph, source)
assert.equal(first.anchors.q0, 0, 'equal scores retain the first source paragraph')
assert.equal(first.anchors.q1, 0, 'duplicate query tokens still contribute twice, reaching the minimum score')
assert.equal(first.anchors.q2, source.indexOf('alpha gamma'), 'query multiplicity controls the winning score')
assert.equal(first.anchors.q3, null, 'one matching token alone is insufficient')
assert.equal(first.anchors.q5, null, 'fallback remains case sensitive')
assert.equal(first.anchors.q7, source.indexOf('😀 alpha'), 'UTF-16 token length preserves emoji matches')
for (const text of ['', source.replaceAll('\n', '\r\n'), 'New preface.\n\n' + source,
  source + '\n\nalpha beta gamma', 'Another document without those terms.']) parity(graph, text)
// Direct anchors, normalized evidence, stale metadata and index fallback must
// still take their original paths rather than an approximate lexical shortcut.
parity({ nodes: [node('exact', 'alpha beta', { paragraph: 0 }), node('normalized', 'alpha!beta', { text: 'alpha beta' }),
  node('stale', 'unique last evidence', { paragraph: 0 }), node('local', 'ZZZ alpha beta QQQ', { paragraph: 1 }),
  node('index', '', { paragraph: 3 }), node('empty', '')], edges: [] }, source)
const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'missing', '甲类', '😀']
let seed = 9871
const random = limit => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % limit }
for (let trial = 0; trial < 24; trial++) {
  const text = Array.from({ length: 24 }, () => Array.from({ length: 6 }, () => words[random(words.length)]).join(' ')).join('\n\n')
  parity({ nodes: Array.from({ length: 20 }, (_, i) => node('r' + i,
    'ZZZ ' + Array.from({ length: 5 }, () => words[random(words.length)]).join(' ') + ' QQQ')), edges: [] }, text)
}
const tied = parity({ nodes: [node('warm', 'ZZZ missing QQQ'), node('tie', 'ZZZ gamma gamma alpha alpha QQQ'),
  node('gamma', 'ZZZ gamma gamma QQQ')], edges: [] }, 'alpha\n\ngamma')
assert.equal(tied.anchors.tie, 0, 'query-word order must not choose a later equal-score paragraph')
assert.equal(tied.anchors.gamma, 7, 'scores are reset between queries')
const largeWeights = parity({ nodes: [node('warm', 'ZZZ missing QQQ'),
  node('weighted', 'ZZZ ' + 'alpha '.repeat(65535) + 'beta beta QQQ'), node('beta', 'ZZZ beta beta QQQ'),
  node('alpha', 'ZZZ alpha alpha QQQ')], edges: [] }, 'alpha\n\nbeta\n\nalpha beta')
assert.equal(largeWeights.anchors.weighted, 13, 'scores above 65535 must not wrap')
assert.equal(largeWeights.anchors.beta, 7, 'a prior large score must not leak into the next query')
assert.equal(largeWeights.anchors.alpha, 0)
parity({ nodes: [node('duplicate', 'ZZZ absent QQQ'), node('other', 'ZZZ constructor constructor QQQ'),
  node('duplicate', 'alpha beta', { paragraph: 0 }), node('last', 'ZZZ __proto__ __proto__ QQQ')], edges: [] },
  'alpha beta\n\nconstructor\n\n__proto__ toString')
// Counters, separate from timings, detect the original repeated tokenization.
const book = Array.from({ length: 12000 }, (_, i) => 'Fixture observation ' + i + ' is recorded in the source.')
const text = book.join('\n\n'), paragraphText = new Set(book)
const oldGraph = { nodes: Array.from({ length: 64 }, (_, i) => node('legacy-' + i, 'ZZZ observation ' + (11936 + i) + ' recorded QQQ')), edges: [] }
let tokenizations = 0
const work = {}
const measured = load(bundle, value => { if (paragraphText.has(value)) tokenizations++ }, work)
const result = measured.makeView(oldGraph, text)
assert.equal(tokenizations, book.length, 'each source paragraph must be tokenized once per view')
assert.equal(result.paraNodes[11999][0], 'legacy-63')
const cachedTokenizations = tokenizations
assert.equal(work.membership, book.length * 5, 'only the first fallback scans every paragraph')
assert.equal(work.postingUpdates, (oldGraph.nodes.length - 1) * (book.length * 2 + 1))
assert.equal(work.indexBuilds, 1)
assert.equal(work.scoreAllocations, 1, 'reuse one score buffer within this view')
const indexedWork = { ...work }
tokenizations = 0
const original = load(referenceCode, value => { if (paragraphText.has(value)) tokenizations++ }).makeView(oldGraph, text)
assert.equal(tokenizations, book.length * oldGraph.nodes.length, 'negative control must detect repeated paragraph tokenization')
assert.deepEqual(plain(result), plain(original))
const uncachedTokenizations = tokenizations
tokenizations = 0
measured.makeView({ nodes: book.slice(-200).map((quote, i) => node('direct-' + i, quote, { paragraph: 11800 + i })), edges: [] }, text)
assert.equal(tokenizations, 0, 'ordinary direct anchors must not build token sets')
assert.deepEqual(work, indexedWork, 'direct anchors must not build the index or score buffer')
const singleWork = {}
const single = load(bundle, () => {}, singleWork).makeView({ nodes: [oldGraph.nodes[0]], edges: [] }, text)
assert.equal(single.paraNodes[11936][0], 'legacy-0')
assert.equal(singleWork.membership, book.length * 5)
assert.equal(singleWork.indexBuilds, undefined, 'single fallback keeps the original cold path')
assert.equal(singleWork.scoreAllocations, undefined)
// Token sets live only during makeView. Mutating an old view, editing graph
// quotes and returning to the same source cannot carry old token associations.
result.paragraphs[11999].text = 'Caller changed an old display row.'
oldGraph.nodes[0].quote = 'ZZZ observation 11777 recorded QQQ'
tokenizations = 0
const fresh = measured.makeView(oldGraph, text)
assert.equal(tokenizations, book.length, 'later views construct fresh source tokens')
assert.equal(fresh.paraNodes[11777][0], 'legacy-0')
assert.equal(fresh.paragraphs[11999].text, book[11999])
assert.equal(work.indexBuilds, 2, 'later views build a fresh index')
assert.equal(work.scoreAllocations, 2)
parity(oldGraph, 'Preface changes offsets.\n\n' + text)
console.log(JSON.stringify({ views, sourceParagraphs: book.length, legacyNodes: oldGraph.nodes.length,
  cachedTokenizations, uncachedTokenizations, lazyDirectPath: true, firstScoreTies: true,
  indexedWork, singleColdPath: true, wideScoresAndReset: true, duplicateQueryScoring: true,
  thresholdAndCasePreserved: true, freshViews: true, unchangedInputs: true }))
