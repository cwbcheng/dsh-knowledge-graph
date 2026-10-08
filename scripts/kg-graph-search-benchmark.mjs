// Optional wall-time diagnostic, separate from deterministic CI assertions.
// node scripts/kg-graph-search-benchmark.mjs [baseline-git-revision] [--cached]
// With no revision, compare the current synchronous and cooperative matchers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

const current = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const cached = process.argv.includes('--cached')
const revision = process.argv.slice(2).find(arg => arg !== '--cached')
if (revision?.startsWith('-')) throw new Error('Expected a git revision, not an option')
const baseline = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : current
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const round = value => Math.round(value * 100) / 100

function load(bundle) {
  let taskStart = 0
  const slices = []
  const environment = { window: { React: {} }, console, DOMException, performance, clearTimeout,
    setTimeout(fn, delay) {
      slices.push(performance.now() - taskStart)
      return setTimeout(() => { taskStart = performance.now(); fn() }, delay)
    },
  }
  runInNewContext(bundle.replace('window.KGViewer = {', 'window.KGViewer = { createGraphNodeSearch,'), environment)
  return { create: environment.window.KGViewer.createGraphNodeSearch,
    start() { taskStart = performance.now(); slices.length = 0 },
    finish() { slices.push(performance.now() - taskStart); return Math.max(...slices) } }
}

for (const repeats of [80, 320]) {
  const nodes = Array.from({ length: 12000 }, (_, i) => ({
    id: 'n' + i, type: i % 3 ? 'fact' : 'concept', text: 'Node ' + i,
    quote: '合成摘录，保留完整证据。'.repeat(repeats) + ' Unique quote ' + i,
  }))
  const before = [], after = [], maxTask = []
  for (let trial = 0; trial < 5; trial++) {
    const old = load(baseline), oldIndex = old.create(nodes)
    if (cached) {
      const fresh = load(current), index = fresh.create(nodes)
      const oldFind = query => typeof oldIndex === 'function' ? oldIndex(query, '') : oldIndex.findAsync
        ? oldIndex.findAsync(query, '', new AbortController().signal) : oldIndex.find(query, '')
      const queries = ['unique quote 11', 'unique quote 119', 'unique quote 1199', 'unique quote 11999']
      await oldFind('unique quote 1')
      await index.findAsync('unique quote 1', '', new AbortController().signal)
      const oldResults = [], results = []
      let start = performance.now(); old.start()
      for (const query of queries) oldResults.push(await oldFind(query))
      before.push(performance.now() - start)
      start = performance.now(); fresh.start()
      for (const query of queries) results.push(await index.findAsync(query, '', new AbortController().signal))
      after.push(performance.now() - start); maxTask.push(fresh.finish())
      assert.deepEqual(results.map(matches => matches.length), [1111, 111, 11, 1])
      results.forEach((matches, i) => assert.deepEqual(Array.from(matches, node => node.id), Array.from(oldResults[i], node => node.id)))
      continue
    }
    let start = performance.now()
    const oldMatches = typeof oldIndex === 'function' ? oldIndex('unique quote 11999', '') : oldIndex.find('unique quote 11999', '')
    before.push(performance.now() - start)
    const fresh = load(current), index = fresh.create(nodes)
    start = performance.now(); fresh.start()
    const matches = await index.findAsync('unique quote 11999', '', new AbortController().signal)
    after.push(performance.now() - start); maxTask.push(fresh.finish())
    assert.deepEqual(Array.from(matches, node => node.id), ['n11999'])
    assert.deepEqual(Array.from(oldMatches, node => node.id), ['n11999'])
  }
  const metadata = { graphNodes: nodes.length, trials: 5, baseline: revision || 'current matcher',
    quoteCharacters: nodes.reduce((sum, node) => sum + node.quote.length, 0), matchesIdentical: true }
  console.log(JSON.stringify(cached ? { ...metadata, mode: 'four cached refinements',
    beforeSequenceMedianMs: round(median(before)), afterSequenceMedianMs: round(median(after)),
    afterLongestTaskMedianMs: round(median(maxTask)) } : { ...metadata,
    beforeSingleTaskMedianMs: round(median(before)), afterLongestTaskMedianMs: round(median(maxTask)),
    afterTotalMedianMs: round(median(after)) }))
}
