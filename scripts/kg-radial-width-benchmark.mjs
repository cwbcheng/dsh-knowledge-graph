// Actual layout engine and angular relaxation; fixed sizes, no browser timing claim.
// node scripts/kg-radial-width-benchmark.mjs [baseline-git-revision] [--smoke]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const smoke = process.argv.includes('--smoke')
const revision = process.argv.slice(2).find(arg => arg !== '--smoke')
if (revision?.startsWith('-')) throw new Error('Expected a git revision')
const bundle = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function engine(counted = false) {
  let source = bundle
  const work = { passes: 0, pairs: 0, pushes: 0 }
  if (counted) {
    const start = source.indexOf('function resolveAngleOverlaps('), end = source.indexOf('\n      function ', start + 1)
    assert(start >= 0 && end > start)
    const block = source.slice(start, end)
    const markers = ['for (let iter = 0; iter < 160; iter++) {', 'for (let j = i + 1; j < n; j++) {', 'moved += 1']
    for (const marker of markers) assert.equal(block.split(marker).length, 2)
    const instrumented = block.replace(markers[0], markers[0] + ' work.passes++;')
      .replace(markers[1], markers[1] + ' work.pairs++;').replace(markers[2], markers[2] + '; work.pushes++')
    source = source.slice(0, start) + instrumented + source.slice(end)
  }
  const context = { window: { React: {} }, console, work }
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { layoutRadial, graphLayoutWorkerSource,'), context)
  return { ...context.window.KGViewer, work }
}
function star(count, width = 200, height = 100) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i }))
  return { nodes, edges: nodes.slice(1).map(node => ({ fromNodeId: 'n0', toNodeId: node.id, relation: 'supports' })),
    sizes: new Map(nodes.map(node => [node.id, { w: width, h: height }])) }
}
const radius = (positions, id) => Math.hypot(positions.get(id).x, positions.get(id).y)
function overlappingPairs(nodes, sizes, positions) {
  let overlaps = 0
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = positions.get(nodes[i].id), b = positions.get(nodes[j].id), sa = sizes.get(nodes[i].id), sb = sizes.get(nodes[j].id)
    if (!sa || !sb) continue
    if ((sa.w + sb.w) / 2 - Math.abs(a.x - b.x) > 1e-6 && (sa.h + sb.h) / 2 - Math.abs(a.y - b.y) > 1e-6) overlaps++
  }
  return overlaps
}
function positionsOf(run, data) { return run.layoutRadial(data.nodes, data.edges, data.sizes) }
function close(actual, expected, label) { assert(Math.abs(actual - expected) < Math.max(1, expected) * 1e-10, label + ': ' + actual + ' vs ' + expected) }
const count = smoke ? 80 : 800, data = star(count), run = engine(true)
const before = JSON.stringify({ nodes: data.nodes, edges: data.edges, sizes: [...data.sizes] })
const initial = positionsOf(run, data), final = run.layoutGraph(data.nodes, data.edges, data.sizes, 'radial').pos
const initialOverlaps = overlappingPairs(data.nodes, data.sizes, initial), finalOverlaps = overlappingPairs(data.nodes, data.sizes, final)
const geometry = createHash('sha256').update(JSON.stringify([...final])).digest('hex')
assert.equal(JSON.stringify({ nodes: data.nodes, edges: data.edges, sizes: [...data.sizes] }), before, 'layout never mutates canonical data or measurements')
assert.equal(final.size, count)
for (const point of final.values()) assert(Number.isFinite(point.x) && Number.isFinite(point.y))
let controls = false
if (!revision) {
  assert.equal(initialOverlaps, 0, 'measured standard-width star must fit before relaxation')
  assert.equal(finalOverlaps, 0, 'standard-width star must remain readable after relaxation')
  assert.deepEqual(run.work, { passes: 1, pairs: count * (count - 1) / 2, pushes: 0 }, 'sufficient circumference avoids 160 futile relaxation passes')
  const raw = engine()
  assert.equal(positionsOf(raw, star(0)).size, 0)
  close(radius(positionsOf(raw, star(1)), 'n0'), 0, 'singleton remains at center')
  const narrow = star(26, 96, 60), wide = star(26, 218, 100)
  const narrowPos = positionsOf(raw, narrow), widePos = positionsOf(raw, wide)
  assert(radius(widePos, 'n1') > radius(narrowPos, 'n1') * 1.9, 'wider measured nodes enlarge the ring')
  const small = star(3, 96, 60)
  close(radius(positionsOf(raw, small), 'n1'), 240, 'small rings retain their minimum spacing')
  const partial = star(26, 150, 60)
  const complete = positionsOf(raw, partial)
  partial.sizes.delete('n4')
  assert.deepEqual(plain([...positionsOf(raw, partial)]), plain([...complete]), 'missing size retains the established 150px fallback')
  const multi = star(121, 200, 100)
  for (let i = 21; i < multi.nodes.length; i++) multi.edges[i - 1].fromNodeId = 'n' + (1 + i % 20)
  multi.sizes = new Map(multi.nodes.map((node, i) => [node.id, { w: [96, 150, 208, 218][i % 4], h: 80 }]))
  const multiBefore = JSON.stringify({ nodes: multi.nodes, edges: multi.edges, sizes: [...multi.sizes] })
  const multiPos = positionsOf(raw, multi)
  assert.equal(multiPos.size, multi.nodes.length)
  close(radius(multiPos, 'n0'), 0, 'degree-selected hub remains at center')
  assert(radius(multiPos, 'n21') >= radius(multiPos, 'n1') + 240 - 1e-8, 'BFS rings retain monotonic separation')
  const widened = new Map(multi.sizes)
  for (let i = 21; i < multi.nodes.length; i++) widened.set('n' + i, { w: 218, h: 80 })
  const widenedPos = positionsOf(raw, { ...multi, sizes: widened })
  for (let i = 0; i <= 20; i++) assert.deepEqual(plain(widenedPos.get('n' + i)), plain(multiPos.get('n' + i)), 'other ring geometry remains stable')
  assert(radius(widenedPos, 'n21') > radius(multiPos, 'n21'), 'outer ring responds to its own actual measurements')
  const disconnected = star(18, 200, 100)
  disconnected.edges = disconnected.edges.slice(0, 8)
  const disconnectedPos = positionsOf(raw, disconnected)
  for (const node of disconnected.nodes.slice(1)) close(radius(disconnectedPos, node.id), radius(disconnectedPos, 'n1'), 'unreachable nodes retain their first-ring placement')
  assert.deepEqual(plain([...positionsOf(raw, multi)]), plain([...multiPos]), 'deterministic positions')
  assert.equal(JSON.stringify({ nodes: multi.nodes, edges: multi.edges, sizes: [...multi.sizes] }), multiBefore)
  const workerSource = raw.graphLayoutWorkerSource()
  for (const input of [star(0), star(1), wide, multi, partial, disconnected]) {
    let message
    runInNewContext(workerSource + '; self.onmessage({data:input})', { self: { postMessage: data => { message = data } }, input: { ...input, mode: 'radial' }, setTimeout, clearTimeout, setInterval, clearInterval })
    assert(!message.error, message.error)
    assert.deepEqual(plain([...message.layout.pos]), plain([...raw.layoutGraph(input.nodes, input.edges, input.sizes, 'radial').pos]), 'worker and local fallback share measured-width geometry')
  }
  controls = true
}
console.log(JSON.stringify({ baseline: revision || 'current', nodes: count, size: { w: 200, h: 100 }, initialOverlaps, finalOverlaps,
  initialRadius: radius(initial, 'n1'), finalRadius: radius(final, 'n1'), angularWork: run.work, geometry, sizeAndRingControls: controls,
  scope: 'Actual generated layoutRadial/layoutGraph/resolveAngleOverlaps. Fixed measured sizes, rectangle intersections and deterministic work counts; no browser latency or paint claim.' }))
