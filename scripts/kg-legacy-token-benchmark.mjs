// Production makeView with legacy token fallback. Uninstrumented timings and
// work counters run separately; HTTP, layout and React are excluded.
// node scripts/kg-legacy-token-benchmark.mjs [baseline-git-revision]
// node --expose-gc scripts/kg-legacy-token-benchmark.mjs [baseline-git-revision] --memory-only
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

const args = process.argv.slice(2), memoryOnly = args.includes('--memory-only')
const revisions = args.filter(arg => arg !== '--memory-only'), revision = revisions[0]
if (revisions.length > 1 || revision?.startsWith('-')) throw new Error('Expected at most one baseline git revision')
if (memoryOnly && !global.gc) throw new Error('Memory diagnostics require node --expose-gc')
const current = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const baseline = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : null
const book = Array.from({ length: 12000 }, (_, i) => 'Fixture observation ' + i + ' is recorded in the source.')
const sparse = Array.from({ length: 12000 }, (_, i) => 'ITEM_' + i + ' shows TOKEN_' + i + ' near marker_' + i + ' in the archive.')
const graphs = {
  'legacy-token-fallback': { nodes: book.slice(-200).map((_, i) => ({ id: 'n' + (11800 + i), type: 'fact',
    text: '', quote: 'ZZZ observation ' + (11800 + i) + ' recorded QQQ' })), edges: [] },
  'legacy-token-800': { nodes: book.slice(-800).map((_, i) => ({ id: 'n' + (11200 + i), type: 'fact',
    text: '', quote: 'ZZZ observation ' + (11200 + i) + ' recorded QQQ' })), edges: [] },
  'single-cold': { nodes: [{ id: 'n11999', type: 'fact', text: '', quote: 'ZZZ observation 11999 recorded QQQ' }], edges: [] },
  'sparse-token-200': { nodes: sparse.slice(-200).map((_, i) => ({ id: 'n' + (11800 + i), type: 'fact',
    text: '', quote: 'ZZZ ITEM_' + (11800 + i) + ' TOKEN_' + (11800 + i) + ' QQQ' })), edges: [] },
  'sparse-single-cold': { nodes: [{ id: 'n11999', type: 'fact', text: '', quote: 'ZZZ ITEM_11999 TOKEN_11999 QQQ' }], edges: [] },
  'direct-tail-window': { nodes: book.slice(-800).map((quote, i) => ({ id: 'n' + (11200 + i), type: 'fact',
    text: quote, quote, paragraph: 11200 + i })), edges: [] },
  'legacy-prefix-fragment': { nodes: book.slice(-200).map((quote, i) => ({ id: 'n' + (11800 + i), type: 'fact',
    text: '', quote: quote + ' INVALIDEND' })), edges: [] },
  'legacy-suffix-fragment': { nodes: book.slice(-200).map((quote, i) => ({ id: 'n' + (11800 + i), type: 'fact',
    text: '', quote: 'INVALIDSTART ' + quote })), edges: [] },
}
function load(bundle, paragraphText, counts) {
  const sandbox = { window: { React: {} }, console,
    observe: text => { if (paragraphText.has(text)) counts.paragraphTokenizations++ },
    indexFragment(text, needle) { counts.partialFragmentSearches++; return text.indexOf(needle) },
    membership(tokens, t) { counts.membershipChecks++; return tokens.has(t) },
    step(name) { counts[name]++ },
  }
  if (counts) {
    bundle = bundle.replace('function tokenize(s) {', 'function tokenize(s) { observe(s);')
      .replace('tokens.has(t)', 'membership(tokens, t)')
      .replace('postings = new Map()', 'step("tokenIndexBuilds"); postings = new Map()')
      .replace('scores = new Uint32Array(paragraphs.length)', 'step("scoreBufferAllocations"); scores = new Uint32Array(paragraphs.length)')
      .replace('const score = scores[i] + weight', 'step("postingScoreUpdates"); const score = scores[i] + weight')
    const start = bundle.indexOf('        const minLen = 3\n'), end = bundle.indexOf('        const rawHit = fuzzyMatch', start)
    assert(start > 0 && end > start, 'measure only partial-fragment searches in the production matcher')
    bundle = bundle.slice(0, start) + bundle.slice(start, end).replaceAll('source.indexOf(', 'indexFragment(source, ') + bundle.slice(end)
  }
  runInNewContext(bundle, sandbox)
  return sandbox.window.KGViewer
}
const plain = value => JSON.parse(JSON.stringify(value))
const median = times => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]
const results = []
for (const [scenario, graph] of memoryOnly ? [] : Object.entries(graphs)) {
  const paragraphs = scenario.startsWith('sparse-') ? sparse : book
  const source = paragraphs.join('\n\n'), paragraphText = new Set(paragraphs)
  const expected = baseline && plain(load(baseline, paragraphText).makeView(graph, source)), metrics = []
  for (const [version, bundle] of [...(baseline ? [[revision, baseline]] : []), ['current', current]]) {
    const times = []
    for (let trial = 0; trial < 5; trial++) {
      const api = load(bundle, paragraphText), start = performance.now()
      const view = api.makeView(graph, source)
      times.push(performance.now() - start)
      assert.equal(view.paragraphs.length, book.length)
      assert.equal(view.unresolved.length, 0)
      if (scenario !== 'legacy-prefix-fragment' && scenario !== 'legacy-suffix-fragment') assert.equal(view.paraNodes[11999][0], 'n11999')
      else {
        const quote = graph.nodes.at(-1).quote
        const fragment = scenario === 'legacy-prefix-fragment' ? quote.slice(0, 24) : quote.slice(-24)
        assert.equal(view.anchors.n11999, source.indexOf(fragment), 'longest fragment retains its first source offset')
      }
      if (expected) assert.deepEqual(plain(view), expected, 'complete production view parity')
    }
    const counts = { paragraphTokenizations: 0, partialFragmentSearches: 0, membershipChecks: 0,
      postingScoreUpdates: 0, tokenIndexBuilds: 0, scoreBufferAllocations: 0 }
    load(bundle, paragraphText, counts).makeView(graph, source)
    metrics.push({ version, medianMs: Math.round(median(times) * 100) / 100, ...counts })
  }
  results.push({ scenario, sourceChars: source.length, nodes: graph.nodes.length, metrics })
}
if (!memoryOnly) console.log(JSON.stringify({ paragraphs: book.length, trials: 5,
  fullViewParity: !!baseline, excludes: ['HTTP', 'layout', 'React rendering'], results }, null, 2))
else {
  const memory = []
  for (const [scenario, paragraphs, graph] of [['common', book, graphs['legacy-token-fallback']], ['sparse', sparse, graphs['sparse-token-200']]]) {
    const source = paragraphs.join('\n\n'), metrics = []
    for (const [version, rawCode] of [...(baseline ? [[revision, baseline]] : []), ['current', current]]) {
      const heapDeltas = [], bufferDeltas = []
      for (let trial = 0; trial < 5; trial++) {
        let before, after, scores = 0
        const sandbox = { window: { React: {} }, console,
          memoryBefore() { if (!before) { global.gc(); before = process.memoryUsage() } },
          memoryAfter() { if (++scores === 2) { global.gc(); after = process.memoryUsage() } },
        }
        const indexed = rawCode.includes('function createParagraphTokenLookup(paragraphs)')
        const first = indexed ? 'const qt = tokenize(quote)' : 'const qt = tokenize(n.quote)'
        const last = indexed ? 'return bestScore >= 2 ? paragraphs[bestPi].start : null' : 'if (bestScore >= 2) off = paragraphs[bestPi].start'
        assert(rawCode.includes(first) && rawCode.includes(last), 'measure the live production token state')
        const code = rawCode.replace(first, 'memoryBefore(); ' + first).replace(last, 'memoryAfter(); ' + last)
        runInNewContext(code, sandbox)
        const view = sandbox.window.KGViewer.makeView(graph, source)
        assert.equal(view.paraNodes[11999][0], 'n11999')
        heapDeltas.push(after.heapUsed - before.heapUsed)
        bufferDeltas.push(after.arrayBuffers - before.arrayBuffers)
      }
      metrics.push({ version, liveHeapDeltaMedianBytes: median(heapDeltas), liveBufferDeltaMedianBytes: median(bufferDeltas) })
    }
    memory.push({ scenario, sourceChars: source.length, metrics })
  }
  console.log(JSON.stringify({ diagnosticOnly: true, gcControlled: true, sample: 'after second fallback minus before first fallback',
    excludes: ['whole-page memory', 'HTTP', 'React/DOM', 'uncollected transient peak'], trials: 5, memory }, null, 2))
}
