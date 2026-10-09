// Actual layered layout: reuse its partition when packing, including ID-copy cost.
// node scripts/kg-layered-component-reuse-benchmark.mjs [baseline-revision] [--smoke]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'

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
function engine(instrument = false) {
  let source = bundle
  const work = { componentEdges: 0, componentNodes: 0, componentDequeues: 0, componentAdjacencySets: 0,
    packEdges: 0, packNodes: 0, packDequeues: 0, packAdjacencySets: 0, preparedIds: 0 }
  if (instrument) for (const [name, prefix] of [['layoutLayeredComponents', 'component'], ['packDisconnectedComponents', 'pack']]) {
    source = editFunction(source, name, block => {
      const edgeLoop = prefix === 'pack' ? 'for (const edge of edges || []) {' : 'for (const edge of safeEdges) {'
      assert(block.includes(edgeLoop) && block.includes('const id = queue.shift()'))
      return block.replaceAll(edgeLoop, edgeLoop + ' work.' + prefix + 'Edges++;')
        .replace('for (const node of nodes) {', '$& work.' + prefix + 'Nodes++;')
        .replace('const id = queue.shift()', 'const id = queue.shift(); work.' + prefix + 'Dequeues++')
        .replace('[node.id, new Set()]', '[node.id, (work.' + prefix + 'AdjacencySets++, new Set())]')
        .replace('component.map(node => node.id)', 'component.map(node => (work.preparedIds++, node.id))')
    })
  }
  const context = { window: { React: {} }, console, work, setTimeout, clearTimeout, setInterval, clearInterval }
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { packDisconnectedComponents, layoutLayeredComponents, graphLayoutWorkerSource,'), context)
  return { ...context.window.KGViewer, work }
}
function fixture(count, shape) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, content: 'Node ' + i, type: i % 3 === 0 ? 'claim' : 'fact' }))
  const edges = []
  for (let i = 1; i < count; i++) {
    if (shape === 'star' && i < count - 1) edges.push({ fromNodeId: 'n0', toNodeId: 'n' + i, relation: 'supports' })
    if (shape === 'groups' && i % 8 !== 0) edges.push({ fromNodeId: 'n' + (i - i % 8), toNodeId: 'n' + i, relation: 'supports' })
  }
  if (shape !== 'isolated') edges.push({ ...edges[0], relation: 'analogy' }, { fromNodeId: 'n0', toNodeId: 'n0', relation: 'supports' }, { fromNodeId: 'missing', toNodeId: 'n1', relation: 'supports' })
  return { nodes, edges, sizes: new Map(nodes.map((node, i) => [node.id, { w: [96, 150, 208, 218][i % 4], h: [60, 100, 180, 260][i % 4] }])) }
}
function snapshot(layout, progress, nodes, identity = true) {
  const nodeById = new Map(nodes.map(node => [node.id, node])), groups = new Map()
  assert.equal(layout.pos.size, nodeById.size)
  assert.equal(layout.componentNodesById.size, nodeById.size)
  assert.equal(layout.componentKeyById.size, nodeById.size)
  for (const [id, key] of layout.componentKeyById) {
    const group = layout.componentNodesById.get(id)
    assert(group.some(node => node.id === id))
    if (groups.has(key)) assert.equal(group, groups.get(key), 'one shared membership array per component')
    else groups.set(key, group)
    for (const node of group) {
      if (identity) assert.equal(node, nodeById.get(node.id), 'membership preserves input node identities')
      else assert.equal(JSON.stringify(node), JSON.stringify(nodeById.get(node.id)))
    }
  }
  return { pos: [...layout.pos], componentKeys: [...layout.componentKeyById],
    componentNodes: [...layout.componentNodesById].map(([id, group]) => [id, group.map(node => node.id)]), progress }
}
// Frozen from the actual ce6c56a bundle, including complete geometry,
// every component membership and order, and the full progress sequence.
const frozen = {
  'star/80': '30a7f8025c441b829f8d39efe4e3183bda6e4a9fc4620b9e12d8e9666aa30606',
  'groups/80': '76a58f5918c01695f74725172562aaaa9caa9b59bf4f01a617ffce8435e6d339',
  'isolated/80': 'b68fac2046dfe44db29903c3e0dfa193d87f45b1885054303303425612cadb5a',
  'star/800': 'edf8f9983effede56cc7296971746ec94fe4f1f88ead1fb0e986a879db0cca48',
  'groups/12000': '5e9488a2e72b4869c528278c141df7b4c4cdd9f67ab0588718e2b37468bc23ec',
  'isolated/12000': '2a5d80a58b184a420523fb566850b844797488882c71386baef8f0c5ef0fbab1',
}
for (const shape of ['star', 'groups', 'isolated']) {
  const count = smoke ? 80 : shape === 'star' ? 800 : 12000, data = fixture(count, shape)
  const input = JSON.stringify({ ...data, sizes: [...data.sizes] }), run = engine(true), progress = []
  const result = snapshot(run.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', p => progress.push(p)), progress, data.nodes)
  assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), input)
  const expected = frozen[shape + '/' + count]
  assert.equal(digest(result), expected)
  assert.equal(run.work.componentEdges, data.edges.length * 2, 'includes adjacency discovery and edge assignment')
  assert.equal(run.work.componentNodes, count); assert.equal(run.work.componentDequeues, count); assert.equal(run.work.componentAdjacencySets, count)
  const prepared = revision ? 0 : count, repeated = revision ? count : 0
  assert.equal(run.work.preparedIds, prepared)
  assert.equal(run.work.packEdges, revision ? data.edges.length : 0)
  assert.equal(run.work.packNodes, repeated); assert.equal(run.work.packDequeues, repeated); assert.equal(run.work.packAdjacencySets, repeated)
  console.log(JSON.stringify({ baseline: revision || 'current', shape, nodes: count, edges: data.edges.length, ...run.work,
    topologyEdgeVisits: run.work.componentEdges + run.work.packEdges, topologyDequeues: run.work.componentDequeues + run.work.packDequeues,
    result: digest(result), geometry: digest(result.pos), progress: digest(progress),
    scope: 'Actual complete layered layout. Counts cover input-edge records in partition discovery/assignment/packing, dequeues, adjacency sets and new ID copying. Per-component layout and other packing work remain; no browser timing claim.' }))
}
const raw = engine(), data = fixture(24, 'groups'), before = JSON.stringify({ ...data, sizes: [...data.sizes] }), progress = []
const local = snapshot(raw.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', p => progress.push(p)), progress, data.nodes)
const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); require('node:vm').runInNewContext(workerData.source + '; self.onmessage({data:input})', {self: {postMessage: data => parentPort.postMessage(data)}, input: workerData.input, setTimeout, clearTimeout, setInterval, clearInterval});`,
  { eval: true, workerData: { source: raw.graphLayoutWorkerSource(), input: { ...data, mode: 'layered' } } })
const workerProgress = []
const remote = await new Promise((resolve, reject) => {
  worker.on('error', reject)
  worker.on('message', message => {
    if (message.progress) workerProgress.push(message.progress)
    else worker.terminate().then(() => message.error ? reject(new Error(message.error)) : resolve(message.layout), reject)
  })
})
// The actual worker intentionally throttles intermediate progress at 50 ms.
// It must preserve order, valid events and the final completion message.
assert(workerProgress.length > 0)
let lastProgressIndex = -1
for (const event of workerProgress) {
  const index = progress.findIndex(expected => JSON.stringify(expected) === JSON.stringify(event))
  assert(index > lastProgressIndex); lastProgressIndex = index
}
assert.equal(JSON.stringify(workerProgress.at(-1)), JSON.stringify(progress.at(-1)))
assert.equal(digest(snapshot(remote, progress, data.nodes, false)), digest(local))
assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), before)
for (const inputNodes of [null, [], data.nodes.slice(0, 1)]) {
  const layout = raw.layoutLayeredComponents(inputNodes, null, new Map())
  assert.equal(layout.pos.size, inputNodes?.length || 0)
}
assert.throws(() => raw.layoutLayeredComponents(data.nodes, data.edges, data.sizes, () => { throw new Error('cancel fixture') }), /cancel fixture/)
const changed = raw.layoutLayeredComponents(data.nodes, [], new Map(data.nodes.map(node => [node.id, { w: 250, h: 170 }])))
assert.equal(new Set(changed.componentKeyById.values()).size, data.nodes.length, 'new topology and measurements recompute partition and packing')
const ids = [{ id: 1 }, { id: '1' }, { id: 'z' }], groups = [[1, '1'], ['z']], sizes = new Map([[1, { w: 50, h: 30 }], ['1', { w: 80, h: 100 }]])
const edges = [{ fromNodeId: 1, toNodeId: '1' }, null, { fromNodeId: 1, toNodeId: 1 }, { fromNodeId: 'missing', toNodeId: 'z' }]
const positions = () => new Map([[1, { x: 0, y: 0 }], ['1', { x: 100, y: 200 }], ['z', { x: 700, y: -600 }]])
const untouched = JSON.stringify({ ids, groups, edges, sizes: [...sizes] }), discovered = positions(), provided = positions(), references = [...provided.values()]
assert.equal(raw.packDisconnectedComponents(ids, edges, sizes, discovered, 38), discovered)
assert.equal(raw.packDisconnectedComponents(ids, edges, sizes, provided, 38, groups), provided)
assert.equal(digest([...discovered]), digest([...provided]))
assert([...provided.values()].every((point, i) => point === references[i]))
assert.equal(JSON.stringify({ ids, groups, edges, sizes: [...sizes] }), untouched)
for (const supplied of [undefined, groups]) {
  const missing = new Map()
  assert.equal(raw.packDisconnectedComponents(ids, edges, sizes, missing, 38, supplied), missing)
  assert.equal(missing.size, 0)
}
console.log(JSON.stringify({ baseline: revision || 'current', controls: { actualWorkerMetadataAndProgress: true, originalNodeAndPointIdentities: true,
  emptySingletonAndMissingInputs: true, numericAndStringIds: true, readonlyPartitionAndCanonicalInput: true, newTopologyAndMeasurements: true,
  cancellationPropagates: true, forcePackingFallbackPreserved: true }, scope: 'Existing viewer-loading regression covers worker fallback, stale results and cancellation in the UI.' }))
