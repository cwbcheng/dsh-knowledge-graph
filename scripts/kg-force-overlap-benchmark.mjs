// Actual d3-force plus both center-line overlap phases; no timing claim.
// node scripts/kg-force-overlap-benchmark.mjs [baseline-git-revision] [--smoke]
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
function blockOf(source, name) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n      function ', start + 1)
  assert(start >= 0 && end > start)
  return { start, end, block: source.slice(start, end) }
}
function counted(block, stage) {
  const keys = ['for (let iter = 0; iter < 120; iter++) {', 'for (let j = i + 1; j < n; j++) {', 'moved += 1']
  for (const key of keys) assert.equal(block.split(key).length, 2)
  return block.replace(keys[0], keys[0] + ` work.${stage}.passes++;`).replace(keys[1], keys[1] + ` work.${stage}.pairs++;`)
    .replace(keys[2], keys[2] + `; work.${stage}.pushes++`)
    .replaceAll('pos.get(', `(work.${stage}.positionGets++, pos).get(`)
    .replaceAll('sizes.get(', `(work.${stage}.sizeGets++, sizes).get(`)
}
function engine(instrumented = false) {
  let source = bundle
  const work = { first: { passes: 0, pairs: 0, pushes: 0, positionGets: 0, sizeGets: 0 }, second: { passes: 0, pairs: 0, pushes: 0, positionGets: 0, sizeGets: 0 } }
  if (instrumented) {
    const first = blockOf(source, 'resolveNodeOverlaps')
    source = source.slice(0, first.start) + counted(first.block, 'first') + source.slice(first.end)
    const force = blockOf(source, 'layoutForce')
    const start = force.block.indexOf('// Post-pass B'), end = force.block.indexOf('// Force simulation has no attractive', start)
    assert(start >= 0 && end > start)
    const body = (force.block.slice(0, start) + counted(force.block.slice(start, end), 'second') + force.block.slice(end))
      .replace('resolveNodeOverlaps(nodes, sizes, pos, 14)',
        'work.references = [...pos.values()]; resolveNodeOverlaps(nodes, sizes, pos, 14); work.firstGeometry = digest([...pos])')
      .replace('applyEdgeNodeRepulsion(nodes, edges, sizes, pos, bezierSegmentsOf, true)',
        'applyEdgeNodeRepulsion(nodes, edges, sizes, pos, bezierSegmentsOf, true); work.repulsionRetainsPoints = [...pos.values()].every((p, i) => p === work.references[i])')
    source = source.slice(0, force.start) + body + source.slice(force.end)
  }
  const context = { window: { React: {} }, console, work, digest, setTimeout, clearTimeout, setInterval, clearInterval }
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { resolveNodeOverlaps, graphLayoutWorkerSource,'), context)
  return { ...context.window.KGViewer, work }
}
function fixture(count, mixed = false, connected = false) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i }))
  const edges = connected ? nodes.slice(1).flatMap((node, i) => i < Math.floor(count / 8)
    ? [{ fromNodeId: 'n' + i, toNodeId: node.id, relation: 'supports' }] : []) : []
  if (edges.length) edges.push({ ...edges[0], relation: 'analogy' })
  return { nodes, edges, sizes: new Map(nodes.map((node, i) => [node.id, { w: mixed ? [96, 150, 208, 218][i % 4] : 200, h: mixed ? [60, 100, 180, 260][i % 4] : 100 }])) }
}
const count = smoke ? 80 : 800
// Frozen from ce6c56a, including every coordinate after d3, both phases and packing.
const frozen80 = {
  'isolated-standard': ['7c03c6d48860bbb423849a1dbda30da3ca0599426c06f36ced7939666719e473', '8fa694b0bdae19f20b5f442ef02532000584ca6e944612b8c9285edcc2a27100', 9748, 9120],
  'mixed-sparse': ['e2f1ecc3590d5caaa87ef32ce8fa0669c36a4678f4af0f72ba5a1c69d59cf599', '505c9202d42dc426e433dbf511306b95ae8984aac55eb4c38a0d0f8ce5bdb6e4', 12718, 7385],
}
const frozen800 = {
  'isolated-standard': ['db1aa7e8edd0d09fd8e9a7c4169cab3f56f9b7e2795959a464e79abcf07a90ea', '2413caf14f09f97291a601e0e2d405f61cbdc2542a6b8d6b9deeb8bbd13e8204', 193348, 167158],
  'mixed-sparse': ['351fc950876e75bc5392faa07d245c019a5d20a17addf8336dab0180bc05dc8b', '887c959c837ed5716c957d565cf1e951f62255c480c82deab34c4510c4c6614f', 191667, 106799],
}
const progressDigest = '51f913c3a7a96682ef84ba4ac28eaee14c16603adc64390e60430b9d589c346c'
for (const [name, data] of [['isolated-standard', fixture(count)], ['mixed-sparse', fixture(count, true, true)]]) {
  const before = JSON.stringify({ ...data, sizes: [...data.sizes] }), run = engine(true), progress = []
  const positions = run.layoutGraph(data.nodes, data.edges, data.sizes, 'force', data => progress.push(data)).pos
  const geometry = digest([...positions])
  assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), before)
  assert(run.work.repulsionRetainsPoints, 'edge repulsion retains the point objects between phases')
  assert.equal(digest(progress), progressDigest, 'every progress message and residual phase cadence is preserved')
  const expected = (smoke ? frozen80 : frozen800)[name]
  assert.equal(run.work.firstGeometry, expected[0], 'first overlap phase full geometry is preserved')
  assert.equal(geometry, expected[1], 'final full force geometry is preserved')
  assert.equal(run.work.first.pushes, expected[2])
  assert.equal(run.work.second.pushes, expected[3])
  if (!revision) for (const stage of ['first', 'second']) {
    assert.equal(run.work[stage].positionGets, count, 'one position lookup per node per phase, including preparation')
    assert.equal(run.work[stage].sizeGets, count, 'one size lookup per node per phase, including preparation')
    assert.equal(run.work[stage].passes, 120)
    assert.equal(run.work[stage].pairs, count * (count - 1) / 2 * 120)
  }
  delete run.work.references
  console.log(JSON.stringify({ baseline: revision || 'current', name, nodes: count, edges: data.edges.length, ...run.work, geometry, progressDigest: digest(progress),
    totalOverlapMapGets: run.work.first.positionGets + run.work.first.sizeGets + run.work.second.positionGets + run.work.second.sizeGets }))
}
const raw = engine(), workerSource = raw.graphLayoutWorkerSource()
const partial = fixture(12, true)
partial.sizes.delete('n4')
for (const input of [fixture(0), fixture(1), fixture(12, true, true), fixture(19, true, true), partial]) {
  const before = JSON.stringify({ ...input, sizes: [...input.sizes] }), messages = []
  runInNewContext(workerSource + '; self.onmessage({data:input})', { self: { postMessage: data => messages.push(data) }, input: { ...input, mode: 'force' }, setTimeout, clearTimeout, setInterval, clearInterval })
  const message = messages.at(-1)
  assert(!message.error, message.error)
  const first = plain([...raw.layoutGraph(input.nodes, input.edges, input.sizes, 'force').pos])
  assert.deepEqual(plain([...message.layout.pos]), first, 'actual worker and local fallback share complete force geometry')
  assert.deepEqual(plain([...raw.layoutGraph(input.nodes, input.edges, input.sizes, 'force').pos]), first, 'each invocation prepares fresh references')
  assert.equal(JSON.stringify({ ...input, sizes: [...input.sizes] }), before)
}
const direct = engine(true), positions = new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 0 }]])
const nodes = [{ id: 'a' }, { id: 'b' }], references = [...positions.values()]
assert.equal(direct.resolveNodeOverlaps(nodes, new Map(nodes.map(node => [node.id, { w: 200, h: 100 }])), positions, 14), positions)
assert([...positions.values()].every((point, i) => point === references[i]))
assert([...positions.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), 'coincident points retain deterministic finite separation')
assert(direct.work.first.pushes > 0)
const missingPositions = new Map([['a', { x: 0, y: 0 }]])
assert.equal(raw.resolveNodeOverlaps(nodes, new Map([['a', { w: 200, h: 100 }]]), missingPositions, 14), missingPositions, 'missing size retains pair skip')
assert.throws(() => raw.resolveNodeOverlaps(nodes, new Map(nodes.map(node => [node.id, { w: 200, h: 100 }])), missingPositions, 14), error => error.name === 'TypeError')
assert.equal(raw.resolveNodeOverlaps(nodes.slice(0, 1), new Map(), new Map(), 14).size, 0, 'singleton preserves early return')
const changed = fixture(12, true, true), original = plain([...raw.layoutGraph(changed.nodes, changed.edges, changed.sizes, 'force').pos])
changed.sizes = new Map(changed.nodes.map(node => [node.id, { w: 218, h: 80 }]))
assert.notDeepEqual(plain([...raw.layoutGraph(changed.nodes, changed.edges, changed.sizes, 'force').pos]), original)
const cancelled = fixture(12, true, true), cancelledInput = JSON.stringify({ ...cancelled, sizes: [...cancelled.sizes] }), messages = []
assert.throws(() => raw.layoutGraph(cancelled.nodes, cancelled.edges, cancelled.sizes, 'force', progress => {
  messages.push(progress.detail)
  if (progress.detail.startsWith('消除残余重叠')) throw Object.assign(new Error('fixture cancellation'), { name: 'AbortError' })
}), error => error.name === 'AbortError')
assert.equal(messages.at(-1), '消除残余重叠，第 1 轮')
assert(!messages.includes('整理连通分量'))
assert.equal(JSON.stringify({ ...cancelled, sizes: [...cancelled.sizes] }), cancelledInput)
console.log(JSON.stringify({ baseline: revision || 'current', controls: { workerAndFallback: true, emptySingleton: true, missingSizesAndPositions: true, coincidentAndRetainedPoints: true,
  inputUnchanged: true, invocationLifetimeAndResize: true, progressCancellation: true }, scope: 'Actual generated d3 force and both overlap phases. Map reads include preparation; no browser latency or paint claim.' }))
