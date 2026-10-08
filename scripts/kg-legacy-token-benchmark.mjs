// Production makeView with legacy token fallback. Uninstrumented timings and
// tokenization counters run separately; HTTP, layout and React are excluded.
// node scripts/kg-legacy-token-benchmark.mjs [baseline-git-revision]
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
const source = book.join('\n\n'), paragraphText = new Set(book)
const graphs = {
  'legacy-token-fallback': { nodes: book.slice(-200).map((_, i) => ({ id: 'n' + (11800 + i), type: 'fact',
    text: '', quote: 'ZZZ observation ' + (11800 + i) + ' recorded QQQ' })), edges: [] },
  'direct-tail-window': { nodes: book.slice(-800).map((quote, i) => ({ id: 'n' + (11200 + i), type: 'fact',
    text: quote, quote, paragraph: 11200 + i })), edges: [] },
}
function load(bundle, count) {
  const sandbox = { window: { React: {} }, console, observe: text => { if (paragraphText.has(text)) count() } }
  runInNewContext(count ? bundle.replace('function tokenize(s) {', 'function tokenize(s) { observe(s);') : bundle, sandbox)
  return sandbox.window.KGViewer
}
const plain = value => JSON.parse(JSON.stringify(value))
const median = times => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]
const results = []
for (const [scenario, graph] of Object.entries(graphs)) {
  const expected = baseline && plain(load(baseline).makeView(graph, source)), metrics = []
  for (const [version, bundle] of [...(baseline ? [[revision, baseline]] : []), ['current', current]]) {
    const times = []
    for (let trial = 0; trial < 5; trial++) {
      const api = load(bundle), start = performance.now()
      const view = api.makeView(graph, source)
      times.push(performance.now() - start)
      assert.equal(view.paragraphs.length, book.length)
      assert.equal(view.unresolved.length, 0)
      assert.equal(view.paraNodes[11999][0], 'n11999')
      if (expected) assert.deepEqual(plain(view), expected, 'complete production view parity')
    }
    let paragraphTokenizations = 0
    load(bundle, () => paragraphTokenizations++).makeView(graph, source)
    metrics.push({ version, medianMs: Math.round(median(times) * 100) / 100, paragraphTokenizations })
  }
  results.push({ scenario, nodes: graph.nodes.length, metrics })
}
console.log(JSON.stringify({ sourceChars: source.length, paragraphs: book.length, trials: 5,
  fullViewParity: !!baseline, excludes: ['HTTP', 'layout', 'React rendering'], results }, null, 2))
