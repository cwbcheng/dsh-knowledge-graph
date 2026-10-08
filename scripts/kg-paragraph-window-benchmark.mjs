// Optional before/after measurement of production makeView, without HTTP,
// graph layout, React rendering, or instrumented accessors in timed trials.
// node scripts/kg-paragraph-window-benchmark.mjs [baseline-git-revision]
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
const source = book.join('\n\n')
const scenarios = [
  { name: 'four-tail-windows', graphs: [8800, 9600, 10400, 11200].map(offset => graphAt(offset, 800)) },
  { name: 'all-nodes', graphs: [graphAt(0, book.length)] },
]
function graphAt(offset, count) {
  return { nodes: book.slice(offset, offset + count).map((text, i) => ({ id: 'n' + (offset + i), type: i % 3 ? 'fact' : 'concept',
    paragraph: offset + i, quote: text, text })), edges: [] }
}
function load(bundle, observe) {
  const marker = 'const paragraphs = splitParagraphs(sourceText)'
  assert(bundle.includes(marker), 'the measured production view must split this source')
  const sandbox = { window: { React: {} }, console, track: paragraphs => paragraphs.map(paragraph => ({ ...paragraph,
    get start() { observe(); return paragraph.start },
    get end() { observe(); return paragraph.end },
  })) }
  runInNewContext(observe ? bundle.replace(marker, 'const paragraphs = track(splitParagraphs(sourceText))') : bundle, sandbox)
  return sandbox.window.KGViewer
}
const plain = value => JSON.parse(JSON.stringify(value))
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const results = []
for (const scenario of scenarios) {
  const metrics = []
  const reference = baseline ? load(baseline) : null
  const expected = reference && scenario.graphs.map(graph => plain(reference.makeView(graph, source)))
  for (const [name, bundle] of [...(baseline ? [[revision, baseline]] : []), ['current', current]]) {
    const times = []
    for (let trial = 0; trial < 5; trial++) {
      const api = load(bundle)
      api.makeView(scenario.graphs[0], source)
      let elapsed = 0
      for (const [index, graph] of scenario.graphs.entries()) {
        const start = performance.now()
        const view = api.makeView(graph, source)
        elapsed += performance.now() - start
        assert.equal(view.paragraphs.length, book.length)
        assert.equal(view.unresolved.length, 0)
        assert.equal(view.paraNodes[graph.nodes.at(-1).paragraph][0], graph.nodes.at(-1).id)
        if (expected) assert.deepEqual(plain(view), expected[index], 'all view fields retain baseline semantics')
      }
      times.push(elapsed)
    }
    let boundaryReads = 0
    const measured = load(bundle, () => boundaryReads++)
    for (const graph of scenario.graphs) measured.makeView(graph, source)
    metrics.push({ version: name, viewMedianMs: Math.round(median(times) * 100) / 100, boundaryReads })
  }
  results.push({ scenario: scenario.name, views: scenario.graphs.length, nodesPerView: scenario.graphs[0].nodes.length, metrics })
}
console.log(JSON.stringify({ sourceChars: source.length, paragraphs: book.length, trials: 5, viewParity: !!baseline,
  excludes: ['HTTP', 'layout', 'React rendering'], results }, null, 2))
