// Actual force layout and dynamic edge-node repulsion; deterministic work only.
// node scripts/kg-force-repulsion-benchmark.mjs [baseline-git-revision] [--smoke]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const smoke = process.argv.includes('--smoke'), revision = process.argv.slice(2).find(arg => arg !== '--smoke')
if (revision?.startsWith('-')) throw new Error('Expected a git revision')
const bundle = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function editFunction(source, name, edit) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n      function ', start + 1)
  assert(start >= 0 && end > start)
  return source.slice(0, start) + edit(source.slice(start, end)) + source.slice(end)
}
function engine(instrumented = false) {
  const work = { passes: 0, segments: 0, candidates: 0, pushes: 0, positionGets: 0, sizeGets: 0, segmentCalls: 0, paths: [] }
  let source = bundle
  if (instrumented) {
    source = editFunction(source, 'applyEdgeNodeRepulsion', block => {
      const skip = block.includes('if (body.id') ? 'if (body.id === e.fromNodeId || body.id === e.toNodeId) continue'
        : 'if (node.id === e.fromNodeId || node.id === e.toNodeId) continue'
      for (const key of [skip, 'for (let iter = 0; iter < 40; iter++) {', 'for (const seg of segs) {', 'moved += 1']) assert.equal(block.split(key).length, 2)
      return block.replace('for (let iter = 0; iter < 40; iter++) {', 'for (let iter = 0; iter < 40; iter++) { work.passes++;')
        .replace('for (const seg of segs) {', 'for (const seg of segs) { work.segments++;').replace(skip, skip + '; work.candidates++')
        .replace('moved += 1', 'moved += 1; work.pushes++')
        .replaceAll('pos.get(', '(work.positionGets++, pos).get(').replaceAll('sizes.get(', '(work.sizeGets++, sizes).get(')
    })
    source = editFunction(source, 'bezierSegmentsOf', block => block
      .replace('function bezierSegmentsOf(edge, sizes, pos) {', 'function bezierSegmentsOf(edge, sizes, pos) { work.segmentCalls++;')
      .replaceAll('pos.get(', '(work.positionGets++, pos).get(').replaceAll('sizes.get(', '(work.sizeGets++, sizes).get(')
      .replace('return [[geometry.x1, geometry.y1, geometry.cx, geometry.cy], [geometry.cx, geometry.cy, geometry.x2, geometry.y2]]',
        'const segments = [[geometry.x1, geometry.y1, geometry.cx, geometry.cy], [geometry.cx, geometry.cy, geometry.x2, geometry.y2]]; work.paths.push(segments); return segments'))
    source = editFunction(source, 'layoutForce', block => block.replace('applyEdgeNodeRepulsion(nodes, edges, sizes, pos, bezierSegmentsOf, true)',
      'work.references = [...pos.values()]; applyEdgeNodeRepulsion(nodes, edges, sizes, pos, bezierSegmentsOf, true); work.repulsionGeometry = digest([...pos]); work.retainedPoints = [...pos.values()].every((p, i) => p === work.references[i])'))
  }
  const context = { window: { React: {} }, console, work, digest, setTimeout, clearTimeout, setInterval, clearInterval }
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { applyEdgeNodeRepulsion,'), context)
  return { ...context.window.KGViewer, work }
}
function fixture(count, mixed, dense = false) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i }))
  const edges = dense ? nodes.map((node, i) => ({ fromNodeId: node.id, toNodeId: nodes[(i + 1) % count].id, relation: 'supports' }))
    : nodes.slice(1, 1 + Math.floor(count / 8)).map((node, i) => ({ fromNodeId: 'n' + i, toNodeId: node.id, relation: 'supports' }))
  if (dense) for (let i = 0; i < count; i += 2) edges.push({ fromNodeId: nodes[i].id, toNodeId: nodes[(i + 11) % count].id, relation: 'relates_to' })
  edges.push({ ...edges[0], relation: 'analogy' })
  if (dense) edges.push({ fromNodeId: 'n0', toNodeId: 'n0', relation: 'supports' }, { fromNodeId: 'missing', toNodeId: 'n1', relation: 'supports' })
  return { nodes, edges, sizes: new Map(nodes.map((node, i) => [node.id, { w: mixed ? [96, 150, 208, 218][i % 4] : 200, h: mixed ? [60, 100, 180, 260][i % 4] : 100 }])) }
}
// Frozen from 847e882: full repulsion coordinates, final force coordinates,
// every segment on every iteration, pushes, and map reads including preparation.
const frozen80 = {
  'standard-sparse': ['45c4d3f2a10fd4d1f7038bd76323408bc29009e6f866b73cee55846bf751887a', 'dc43240283d0d9b1c85f88a101031faca4a710819907f0d8237f355e55f890e0', 'e41e62121c78cf36080568f1fc136a1d4a7e272ac699df43df6d0d4792a3b752', 4223, 1923],
  'mixed-sparse': ['cfc029ea609a22a592d53b77ef4a164255a5e91d988c631b877c9e204be62163', '505c9202d42dc426e433dbf511306b95ae8984aac55eb4c38a0d0f8ce5bdb6e4', '0e238f07850d91c6f6242bc2aeac05c2bd885bbf2052258df18731ef4b197b66', 4947, 1923],
  'mixed-denser': ['e5038e7cfdd5e537923d48ee29d9edbba29c6cc17e0cf83fd03df75c239cb1ee', 'eff2ba07f63ca6e04a035b5a07e66d82c4dd19da19ad64316585b71eb4ccacea', 'bfd7568b4560f6594e5b91fa653db2377a79ff36556589aec5968b99c89f287c', 64854, 19895],
}
const frozenLarge = {
  'standard-sparse': ['abe7bfb1ea3e132c40e64cc8682fe54434b0534dce85820b773b83be792f1d05', '8ddac617cd10388387d17dc40557c4ac7df0c8952aaa8d0ddea241f36bce287c', 'abf30cd93e4bc03e28cbc8876195d172a3a124bace640427e4af8a4b4503c29d', 287725, 17763],
  'mixed-sparse': ['48b0c2391f78a9621af05823b132d8506572fe8519387773111e9a6f7afe762d', '887c959c837ed5716c957d565cf1e951f62255c480c82deab34c4510c4c6614f', '7b02473357b448e3fae11f56dbbc14c40750dd779ba025f9c5b0adc68e55cc7e', 275401, 17763],
  'mixed-denser': ['e4028f93d715b741e73c1fca2d047a791de59b33690a75b4cc8a7c8b162d46de', '8720530839f2f82b8f1f941cf8b1bf5dda8cd4e88ade308d8ccae352a799b3a7', 'de4a34ed72a7839f1c3cfa24c99c06d7b1d71820741e77776e3e475172745ff0', 406783, 58855],
}
const count = smoke ? 80 : 800
for (const [name, data] of [['standard-sparse', fixture(count, false)], ['mixed-sparse', fixture(count, true)], ['mixed-denser', fixture(Math.min(count, 240), true, true)]]) {
  const input = JSON.stringify({ ...data, sizes: [...data.sizes] }), run = engine(true), progress = []
  const geometry = digest([...run.layoutGraph(data.nodes, data.edges, data.sizes, 'force', p => progress.push(p)).pos])
  assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), input)
  assert(run.work.retainedPoints)
  const paths = digest(run.work.paths), totalMapGets = run.work.positionGets + run.work.sizeGets
  assert.notEqual(digest(run.work.paths.slice(0, data.edges.length)), digest(run.work.paths.slice(-data.edges.length)), 'paths use new endpoint coordinates each iteration')
  assert.equal(digest(progress), '51f913c3a7a96682ef84ba4ac28eaee14c16603adc64390e60430b9d589c346c')
  assert.equal(run.work.passes, 40)
  assert.equal(run.work.segmentCalls, data.edges.length * 40)
  const expected = (smoke ? frozen80 : frozenLarge)[name]
  assert.equal(run.work.repulsionGeometry, expected[0]); assert.equal(geometry, expected[1]); assert.equal(paths, expected[2]); assert.equal(run.work.pushes, expected[3])
  if (!revision) assert.equal(totalMapGets, expected[4])
  delete run.work.paths; delete run.work.references
  console.log(JSON.stringify({ baseline: revision || 'current', name, nodes: data.nodes.length, edges: data.edges.length, ...run.work, geometry, paths, progress: digest(progress), totalMapGets,
    scope: 'Complete repulsion phase: preparation, fan sorting, dynamic endpoint paths and point updates included. No timing claim.' }))
}
const raw = engine(), edge = { fromNodeId: 1, toNodeId: '1', relation: 'supports' }
const nodes = [{ id: 1 }, { id: '1' }, { id: 'c' }], sizes = new Map([[1, { w: 20, h: 20 }], ['1', { w: 20, h: 20 }]])
const positions = () => new Map([[1, { x: -100, y: 0 }], ['1', { x: 100, y: 0 }], ['c', { x: 0, y: 0 }]])
const input = JSON.stringify({ nodes, edge, sizes: [...sizes] }), pos = positions(), references = [...pos.values()], observations = []
const segments = (_edge, _sizes, current) => { observations.push(current.get('c').y); return [[-100, 0, 100, 0], [0, 0, 0, 0]] }
assert.equal(raw.applyEdgeNodeRepulsion(nodes, [edge], sizes, pos, segments, false), undefined)
assert.deepEqual(observations, [0, 60, 74], 'accumulate all pushes, clamp each round, then reread current point')
assert.equal(pos.get('c').y, 74, 'missing size uses half 44 plus clearance 30')
assert.equal(pos.get(1).y, 0); assert.equal(pos.get('1').y, 0, 'numeric and string endpoint IDs stay distinct')
assert([...pos.values()].every((point, i) => point === references[i]))
assert.equal(JSON.stringify({ nodes, edge, sizes: [...sizes] }), input)
sizes.set('c', { w: 120, h: 120 })
const resized = positions()
raw.applyEdgeNodeRepulsion(nodes, [edge], sizes, resized, () => [[-100, 0, 100, 0]], false)
assert.equal(resized.get('c').y, 90, 'next invocation prepares new sizes and points')
for (const callback of [() => null, () => [[0, 0, 0, 0]]]) {
  const missing = new Map([[1, { x: -100, y: 0 }], ['1', { x: 100, y: 0 }]])
  const before = JSON.stringify([...missing])
  raw.applyEdgeNodeRepulsion(nodes, [edge], sizes, missing, callback, false)
  assert.equal(JSON.stringify([...missing]), before, 'null/degenerate segments never dereference missing non-endpoints')
}
assert.throws(() => raw.applyEdgeNodeRepulsion(nodes, [edge], sizes, new Map(), () => [[-100, 0, 100, 0]], false), error => error.name === 'TypeError')
for (const [inputNodes, inputEdges] of [[[], [edge]], [nodes.slice(0, 1), [edge]], [nodes, []]]) {
  const missing = new Map()
  raw.applyEdgeNodeRepulsion(inputNodes, inputEdges, new Map(), missing, () => { throw new Error('unexpected path call') }, true)
  assert.equal(missing.size, 0)
}
console.log(JSON.stringify({ baseline: revision || 'current', controls: { liveRoundCoordinatesAndClamp: true, missingSizeFallback: true, degenerateAndNullPaths: true, exactEndpointIds: true,
  pointIdentityAndInputUnchanged: true, newInvocationAndResize: true, emptySingletonAndNoEdges: true }, scope: 'Existing force-overlap/loading regressions also exercise actual worker/fallback, cancellation and stale results.' }))
