// Actual angular relaxation. Map reads include preparation; timings are not measured.
// node scripts/kg-angle-lookup-benchmark.mjs [baseline-git-revision] [--smoke]
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
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
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
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { resolveAngleOverlaps, layoutRadial, layoutCircular, graphLayoutWorkerSource,'), context)
  return { ...context.window.KGViewer, work }
}
function star(count, mixed = false, multi = false) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i }))
  return { nodes, edges: nodes.slice(1).map((node, i) => ({ fromNodeId: multi && i >= 20 ? 'n' + (1 + i % 20) : 'n0', toNodeId: node.id, relation: 'supports' })),
    sizes: new Map(nodes.map((node, i) => [node.id, { w: mixed ? [96, 150, 208, 218][i % 4] : 200, h: mixed ? [60, 100, 180, 260][i % 4] : 100 }])) }
}
const count = smoke ? 80 : 800
// Frozen from the pre-cache generated engine (4e6c12c), including every coordinate.
const frozen = smoke ? {
  standard: '7a179abd6363ea85d2c0bb2400dc4c17c43ddb10672694dd1141758f10e5721b',
  'mixed-image-height': '86450c62a974037be62115385a2cd2026295b4d5168ffe69136e716116501a67',
  'multiple-rings': '80b6ce8cc261c01cc2b9bdb3ea18971943a0980792886a23912575dbbfe766db',
  'circular-mixed': '64f0809321771463d74e380f80df9c5ef2e66fbac034bf1f03c3195eda1d3711',
} : {
  standard: '1c0bceea8f632f3853ea3463cd46cf5c06cca0858e1a4d963034923369f7b45a',
  'mixed-image-height': '6e742280cec22c3ec053bd1265f6fe1c08b1867bfec9600bd6e414686a281234',
  'multiple-rings': '6e2d4c121f539eb93cc1872965ce069f8cf1fd4d99166b554c19ebe3cded20f8',
  'circular-mixed': 'd0514cd9b46793272aaee2a1836a3cf26c8b6b84242a1a1c79590de96f35173d',
}
const raw = engine()
for (const [name, data, mode] of [['standard', star(count), 'radial'], ['mixed-image-height', star(count, true), 'radial'],
  ['multiple-rings', star(count, true, true), 'radial'], ['circular-mixed', star(count, true), 'circular']]) {
  const before = JSON.stringify({ nodes: data.nodes, edges: data.edges, sizes: [...data.sizes] })
  const seed = mode === 'radial' ? raw.layoutRadial(data.nodes, data.edges, data.sizes) : raw.layoutCircular(data.nodes, data.edges, data.sizes)
  let positionGets = 0, sizeGets = 0
  class Positions extends Map { get(key) { positionGets++; return super.get(key) } }
  class Sizes extends Map { get(key) { sizeGets++; return super.get(key) } }
  const positions = new Positions([...seed].map(([id, point]) => [id, { ...point }]))
  const references = [...positions.values()]
  const sizes = new Sizes(data.sizes), run = engine(true)
  assert.equal(run.resolveAngleOverlaps(data.nodes, sizes, positions, mode === 'radial' ? 18 : 14), positions)
  const geometry = digest([...positions])
  assert.equal(JSON.stringify({ nodes: data.nodes, edges: data.edges, sizes: [...data.sizes] }), before)
  assert([...positions.values()].every((point, i) => point === references[i]), 'position objects retain their identity')
  assert.equal(geometry, frozen[name], 'every coordinate matches the pre-cache engine, including floating point changes')
  if (!revision) {
    assert.equal(positionGets, count, 'one position lookup per node, including preparation')
    assert.equal(sizeGets, count, 'one measurement lookup per node, including preparation')
    assert.equal(run.work.passes, name === 'standard' ? 1 : 160, 'overlap iteration behavior is preserved')
    assert.equal(run.work.pairs, run.work.passes * count * (count - 1) / 2)
    assert.equal(run.work.pushes, (smoke ? { standard: 0, 'mixed-image-height': 7464, 'multiple-rings': 4311, 'circular-mixed': 2450 }
      : { standard: 0, 'mixed-image-height': 194699, 'multiple-rings': 173456, 'circular-mixed': 158541 })[name])
  }
  console.log(JSON.stringify({ baseline: revision || 'current', name, nodes: count, angularWork: run.work, positionGets, sizeGets, totalMapGets: positionGets + sizeGets, geometry }))
}

// Refresh inputs between calls, and exercise the actual worker source/local fallback.
const workerSource = raw.graphLayoutWorkerSource()
const partial = star(26, true)
partial.sizes.delete('n4')
const disconnected = star(26, true)
disconnected.edges = disconnected.edges.slice(0, 8)
for (const input of [star(0), star(1), star(26, true), star(41, true, true), partial, disconnected]) {
  const before = JSON.stringify({ nodes: input.nodes, edges: input.edges, sizes: [...input.sizes] })
  for (const mode of ['radial', 'circular']) {
    let message
    runInNewContext(workerSource + '; self.onmessage({data:input})', { self: { postMessage: data => { message = data } },
      input: { ...input, mode }, setTimeout, clearTimeout, setInterval, clearInterval })
    assert(!message.error, message.error)
    const first = plain([...raw.layoutGraph(input.nodes, input.edges, input.sizes, mode).pos])
    assert.deepEqual(plain([...message.layout.pos]), first, 'actual worker and local fallback have identical full geometry')
    assert.deepEqual(plain([...raw.layoutGraph(input.nodes, input.edges, input.sizes, mode).pos]), first, 'no cache survives a layout invocation')
  }
  assert.equal(JSON.stringify({ nodes: input.nodes, edges: input.edges, sizes: [...input.sizes] }), before)
}
const zeroWork = engine(true), singleton = star(1)
assert.equal(zeroWork.resolveAngleOverlaps(singleton.nodes, singleton.sizes, new Map(), 18).size, 0)
assert.deepEqual(zeroWork.work, { passes: 0, pairs: 0, pushes: 0 }, 'singleton does not read missing positions')
const missingNodes = [{ id: 'a' }, { id: 'b' }], missingPositions = new Map([['a', { x: 0, y: 0 }]])
assert.equal(raw.resolveAngleOverlaps(missingNodes, new Map([['a', { w: 200, h: 100 }]]), missingPositions, 18), missingPositions, 'missing size still skips pairs')
assert.throws(() => raw.resolveAngleOverlaps(missingNodes, new Map(missingNodes.map(node => [node.id, { w: 200, h: 100 }])), missingPositions, 18),
  error => error.name === 'TypeError', 'missing position with measured size retains the established error behavior')
const resized = star(26, true), original = plain([...raw.layoutGraph(resized.nodes, resized.edges, resized.sizes, 'radial').pos])
resized.sizes = new Map(resized.nodes.map(node => [node.id, { w: 218, h: 80 }]))
assert.notDeepEqual(plain([...raw.layoutGraph(resized.nodes, resized.edges, resized.sizes, 'radial').pos]), original, 'new sizes refresh layout data')
console.log(JSON.stringify({ baseline: revision || 'current', controls: { workerAndFallback: true, emptySingleton: true, missingSizesAndPositions: true, inputUnchanged: true, invocationLifetime: true },
  scope: 'Actual generated angular relaxation; deterministic passes/pairs/pushes and Map reads including preparation, with frozen full geometry. No browser latency or paint claim.' }))
