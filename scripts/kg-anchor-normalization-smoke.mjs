import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const bundle = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const start = bundle.indexOf('      function normalizeFor(s, mode) {')
const end = bundle.indexOf('      function fuzzyMatch(', start)
assert(start > 0 && end > start, 'exercise the generated production normalizer')
// Freeze the former character-by-character behavior, including its precise
// whitespace/punctuation membership and first-separator source offset.
const former = `      function normalizeFor(s, mode) {
        const punctuation = new Set('，。！？、；：…—（）,.!?;:()·～“”‘’「」『』')
        const out = [], map = []
        let pendingWS = false
        for (let i = 0; i < s.length; i++) {
          const ch = s[i], ws = ch === ' ' || ch === '\\n' || ch === '\\u3000' || ch.charCodeAt(0) === 9
          const punct = punctuation.has(ch)
          if (mode === 'ws' && ws) {
            if (out.length > 0 && !pendingWS) { out.push(' '); map.push(i); pendingWS = true }
          } else if (mode === 'punct' && punct) pendingWS = false
          else if (mode === 'both' && (ws || punct)) {
            if (out.length > 0 && !pendingWS) { out.push(' '); map.push(i); pendingWS = true }
          } else { out.push(ch); map.push(i); pendingWS = false }
        }
        return { text: out.join(''), map }
      }
`
const referenceCode = bundle.slice(0, start) + former + bundle.slice(end)
const load = code => {
  const sandbox = { window: { React: {} }, console }
  runInNewContext(code.replace('window.KGViewer = {', 'window.KGViewer = { normalizeFor, resolveNeedle, resolveAnchor, neighborhoodAnchors,'), sandbox)
  return sandbox.window.KGViewer
}
const api = load(bundle), reference = load(referenceCode), plain = value => JSON.parse(JSON.stringify(value))
const modes = ['ws', 'punct', 'both', 'unknown'], punctuation = '，。！？、；：…—（）,.!?;:()·～“”‘’「」『』'
let normalizations = 0, queries = 0, views = 0
function normalization(text) {
  for (const mode of modes) {
    const actual = api.normalizeFor(text, mode), expected = reference.normalizeFor(text, mode)
    assert.deepEqual(plain(actual), plain(expected), 'normalized text and every UTF-16 source offset: ' + mode)
    assert.equal(actual.map.length, actual.text.length)
    normalizations++
  }
}
// Every UTF-16 code unit, in a retained run and next to retained letters.
const exhaustive = Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i))
normalization(exhaustive.join(''))
normalization(exhaustive.map(ch => 'a' + ch + 'b').join(''))
for (const text of ['', ' ', '\n\t\u3000', punctuation, ' \n' + punctuation + '\t',
  ' ,\nalpha\t，。　beta！ \n', 'a\r\nb\v\fc\u00a0d\u2003e\u2028f\ufeffg',
  '😀甲类　乙类 📚\ud800,\udfff \n', 'alpha,beta alpha!beta']) normalization(text)
const collapsed = api.normalizeFor(' \talpha, \n。beta？！\t', 'both')
assert.equal(collapsed.text, 'alpha beta ')
assert.equal(collapsed.map[5], 7, 'collapsed punctuation/whitespace maps to its first source unit')
assert.equal(collapsed.map.at(-1), 15, 'trailing separators remain one mapped space')
assert.equal(api.normalizeFor(' ,alpha!', 'punct').text, ' alpha', 'punctuation mode preserves leading whitespace')
assert.equal(api.normalizeFor('alpha\r\nbeta', 'ws').text, 'alpha\r beta', 'CR is not one of the four normalized whitespace characters')

const alphabet = ['A', 'B', '甲', '乙', ' ', '\t', '\n', '\r', '\u3000', '\u00a0', '\u2003', '\u2028', '\ufeff',
  ...punctuation, '😀', '📚', '\ud800', '\udfff']
let seed = 72419
const random = limit => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % limit }
function query(quote, source) {
  for (const exactOnly of [false, true]) {
    assert.equal(api.resolveNeedle(quote, source, new Map(), exactOnly), reference.resolveNeedle(quote, source, new Map(), exactOnly),
      'first anchor, mode order and fallback precedence')
    queries++
  }
}
for (let trial = 0; trial < 1000; trial++) {
  const source = Array.from({ length: random(120) }, () => alphabet[random(alphabet.length)]).join('')
  normalization(source)
  const quote = trial % 2 ? api.normalizeFor(source.slice(0, random(source.length + 1)), modes[random(3)]).text
    : Array.from({ length: random(40) }, () => alphabet[random(alphabet.length)]).join('')
  query(quote, source)
}
// Full matching precedence, local repeated-quote disambiguation, stale paragraph
// correction, code/table source units, neighborhood navigation and fresh views.
const paragraphs = ['alpha\t\t beta', 'alpha,beta', 'alpha,　beta！', '😀 alpha beta', 'alpha,beta',
  '> A quoted line.\n> Another line.', '  code_alpha();\n  code_beta();', '| alpha | beta |\n| gamma | delta |',
  'AqBCDEFGHIJKqL', 'zz unique terminal evidence']
const nodes = [
  { id: 'ws', quote: 'alpha beta' }, { id: 'punct', quote: 'alpha!beta' }, { id: 'both', quote: 'alpha beta！' },
  { id: 'repeated', quote: 'alpha!beta', paragraph: 4 }, { id: 'stale', quote: 'unique terminal evidence', paragraph: 0 },
  { id: 'fuzzy', quote: 'ABCDEFGHIJKL' }, { id: 'missing', quote: 'ZZZ absent text QQQ' },
  { id: 'index', quote: '', paragraph: 7 }, { id: 'fallback', quote: '', text: 'alpha beta' },
].map(node => ({ type: 'fact', text: '', ...node }))
const graph = { nodes, edges: [{ fromNodeId: 'ws', toNodeId: 'punct', relation: 'supports' },
  { fromNodeId: 'ws', toNodeId: 'absent', relation: 'supports' }] }, saved = JSON.stringify(graph)
for (const source of [paragraphs.join('\n\n'), paragraphs.join('\r\n\r\n'), '',
  '📚 Preface.\n\n' + paragraphs.join('\n\n'), paragraphs.join('\n\n') + '\n\nAppendix.', 'Another document.']) {
  assert.deepEqual(plain(api.makeView(graph, source)), plain(reference.makeView(graph, source)), 'complete view parity')
  assert.deepEqual(plain(api.neighborhoodAnchors(nodes, source, {})), plain(reference.neighborhoodAnchors(nodes, source, {})), 'neighborhood parity')
  assert.equal(JSON.stringify(graph), saved, 'graph, quote, source and metadata remain unchanged')
  for (const node of nodes) query(node.quote, source)
  views++
}
const text = paragraphs.join('\n\n'), view = api.makeView(graph, text)
assert.equal(view.anchors.repeated, view.paragraphs[4].start, 'local normalized quote retains its declared repeated paragraph')
assert.equal(view.anchors.stale, text.indexOf('unique terminal evidence'))
assert.equal(view.anchors.fuzzy, text.indexOf('AqBCDEFGHIJKqL'))
console.log(JSON.stringify({ normalizations, utf16CodeUnits: 65536, queries, views, allOffsetsPreserved: true,
  fourWhitespaceCharacters: true, punctuationMembership: true, firstAndTrailingSeparatorOffsets: true,
  matchingPrecedence: true, localAndStaleMetadata: true, neighborhoodParity: true, unchangedInputs: true }))
