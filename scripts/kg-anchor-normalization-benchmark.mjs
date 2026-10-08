// Production makeView, five uninstrumented trials; counters run separately.
// node scripts/kg-anchor-normalization-benchmark.mjs [baseline-git-revision]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

const revision = process.argv[2]
if (process.argv.length > 3 || revision?.startsWith('-')) throw new Error('Expected at most one baseline git revision')
const current = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const baseline = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : null
const book = Array.from({ length: 12000 }, (_, i) => 'Fixture observation ' + i + ' is recorded in the source.')
const wsBook = book.map(text => text.replace('Fixture ', 'Fixture\t\t'))
const bothBook = book.map(text => text.replace('Fixture ', 'Fixture,'))
const cjkBook = book.map((_, i) => '📚证据' + i + '：甲类　　乙类，提供记录。')
const node = (i, quote, paragraph) => ({ id: 'n' + i, type: 'fact', text: '', quote, ...(paragraph === undefined ? {} : { paragraph }) })
const tail = (count, quote, local = false) => ({ nodes: Array.from({ length: count }, (_, i) => {
  const index = 12000 - count + i
  return node(index, quote(index), local ? index : undefined)
}), edges: [] })
const scenarios = [
  ...[1, 2, 200, 800].map(count => ['legacy-' + count, book, tail(count, i => 'ZZZ observation ' + i + ' recorded QQQ')]),
  ['normalized-whitespace-200', wsBook, tail(200, i => book[i])],
  ['normalized-punctuation-200', book, tail(200, i => book[i].replace('.', '!'))],
  ['normalized-both-200', bothBook, tail(200, i => book[i].replace('.', '!'))],
  ['normalized-cjk-astral-200', cjkBook, tail(200, i => '📚证据' + i + ' 甲类 乙类 提供记录！')],
  ['local-normalized-200', wsBook, tail(200, i => book[i], true)],
  ['direct-800', book, tail(800, i => book[i], true)],
]
function load(bundle, source, counts) {
  let wholeSource = false
  const sandbox = { window: { React: {} }, console,
    beginNormalization(text) { wholeSource = text === source },
    endNormalization(text, mode, result) {
      counts.allCalls++
      if (wholeSource) {
        counts.sourceCalls++
        counts.sourceModes.push(mode)
        counts.sourceInputUnits += text.length
        counts.sourceMappedUnits += result.map.length
      }
      wholeSource = false
    },
    outputPart(out, text) { if (wholeSource) counts.sourceOutputParts++; out.push(text) },
    classifyPunctuation(set, ch) { if (wholeSource) counts.sourcePunctuationChecks++; return set.has(ch) },
  }
  if (counts) {
    const start = bundle.indexOf('      function normalizeFor(s, mode) {'), end = bundle.indexOf('      function fuzzyMatch(', start)
    assert(start > 0 && end > start)
    const wrapped = bundle.slice(start, end).replace('function normalizeFor(s, mode) {',
      'function normalizeFor(s, mode) { beginNormalization(s); const result = originalNormalizer(s, mode); endNormalization(s, mode, result); return result }\n      function originalNormalizer(s, mode) {')
      .replaceAll('out.push(', 'outputPart(out, ').replaceAll('PUNCT_CHARS.has(ch)', 'classifyPunctuation(PUNCT_CHARS, ch)')
    bundle = bundle.slice(0, start) + wrapped + bundle.slice(end)
  }
  runInNewContext(bundle, sandbox)
  return sandbox.window.KGViewer
}
const plain = value => JSON.parse(JSON.stringify(value))
const median = times => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]
const results = []
for (const [scenario, paragraphs, graph] of scenarios) {
  const source = paragraphs.join('\n\n'), expected = baseline && plain(load(baseline).makeView(graph, source)), metrics = []
  for (const [version, code] of [...(baseline ? [[revision, baseline]] : []), ['current', current]]) {
    const times = []
    for (let trial = 0; trial < 5; trial++) {
      const api = load(code), start = performance.now(), view = api.makeView(graph, source)
      times.push(performance.now() - start)
      assert.equal(view.paragraphs.length, 12000)
      assert.equal(view.unresolved.length, 0)
      assert.equal(view.paraNodes[11999][0], 'n11999')
      if (expected) assert.deepEqual(plain(view), expected, 'complete production view parity')
    }
    const counts = { allCalls: 0, sourceCalls: 0, sourceModes: [], sourceInputUnits: 0, sourceMappedUnits: 0,
      sourceOutputParts: 0, sourcePunctuationChecks: 0 }
    load(code, source, counts).makeView(graph, source)
    assert.equal(new Set(counts.sourceModes).size, counts.sourceCalls, 'each source mode is built at most once per view')
    assert(counts.sourceCalls <= 3)
    if (scenario === 'direct-800') assert.equal(counts.allCalls, 0, 'direct anchors still skip normalization')
    if (scenario === 'local-normalized-200') assert.equal(counts.sourceCalls, 0, 'local evidence never normalizes the whole book')
    metrics.push({ version, medianMs: Math.round(median(times) * 100) / 100, ...counts })
  }
  results.push({ scenario, sourceChars: source.length, nodes: graph.nodes.length, metrics })
}
console.log(JSON.stringify({ paragraphs: book.length, trials: 5, fullViewParity: !!baseline,
  excludes: ['HTTP', 'layout', 'React rendering'], results }, null, 2))
