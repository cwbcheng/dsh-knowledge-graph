// Actual layered layout: reuse its partition when packing, including ID-copy cost.
// node scripts/kg-layered-component-reuse-benchmark.mjs [baseline-revision] [--smoke | --large-connected]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'

const smoke = process.argv.includes('--smoke'), largeConnected = process.argv.includes('--large-connected')
const revision = process.argv.slice(2).find(arg => arg !== '--smoke' && arg !== '--large-connected')
if (revision?.startsWith('-')) throw new Error('Expected a git revision')
const bundle = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
// Accept both the original discovery path and the first partition-reuse revision.
const reusesPartition = bundle.includes('let components = knownComponents')
const skipsSinglePacking = bundle.includes('const pos = components.length > 1')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function editFunction(source, name, edit) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n      function ', start + 1)
  assert(start >= 0 && end > start)
  return source.slice(0, start) + edit(source.slice(start, end)) + source.slice(end)
}
function engine(instrument = false) {
  let source = bundle
  const work = { componentEdges: 0, componentNodes: 0, componentDequeues: 0, componentAdjacencySets: 0,
    packEdges: 0, packNodes: 0, packDequeues: 0, packAdjacencySets: 0, preparedIds: 0, packCalls: 0, orderEntries: 0 }
  if (instrument) for (const [name, prefix] of [['layoutLayeredComponents', 'component'], ['packDisconnectedComponents', 'pack']]) {
    source = editFunction(source, name, block => {
      const edgeLoop = prefix === 'pack' ? 'for (const edge of edges || []) {' : 'for (const edge of safeEdges) {'
      assert(block.includes(edgeLoop) && block.includes('const id = queue.shift()'))
      return block.replaceAll(edgeLoop, edgeLoop + ' work.' + prefix + 'Edges++;')
        .replace('if (!Array.isArray(nodes)', prefix === 'pack' ? 'work.packCalls++; if (!Array.isArray(nodes)' : '$&')
        .replace('[node.id, index]', '[(work.orderEntries++, node.id), index]')
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
  const prepared = reusesPartition ? count : 0, repeated = reusesPartition ? 0 : count
  assert.equal(run.work.preparedIds, prepared)
  assert.equal(run.work.packEdges, reusesPartition ? 0 : data.edges.length)
  assert.equal(run.work.packNodes, repeated); assert.equal(run.work.packDequeues, repeated); assert.equal(run.work.packAdjacencySets, repeated)
  assert.equal(run.work.packCalls, 1); assert.equal(run.work.orderEntries, count)
  console.log(JSON.stringify({ baseline: revision || 'current', shape, nodes: count, edges: data.edges.length, ...run.work,
    topologyEdgeVisits: run.work.componentEdges + run.work.packEdges, topologyDequeues: run.work.componentDequeues + run.work.packDequeues,
    result: digest(result), geometry: digest(result.pos), progress: digest(progress),
    scope: 'Actual complete layered layout. Counts cover input-edge records in partition discovery/assignment/packing, dequeues, adjacency sets and new ID copying. Per-component layout and other packing work remain; no browser timing claim.' }))
}
function connectedFixture(count, shape) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, text: 'Node ' + i, type: i % 3 === 0 ? 'claim' : 'fact' }))
  const edges = nodes.slice(1).map((node, i) => ({ fromNodeId: shape === 'wide' ? 'n0' : 'n' + i, toNodeId: node.id, relation: 'supports' }))
  if (shape === 'cycle') edges.push({ fromNodeId: 'n' + (count - 1), toNodeId: 'n0', relation: 'supports' })
  edges.push({ ...edges[0], relation: 'analogy' }, { fromNodeId: 'n0', toNodeId: 'n0', relation: 'supports' }, { fromNodeId: 'missing', toNodeId: 'n1', relation: 'supports' })
  return { nodes, edges, sizes: new Map(nodes.map((node, i) => [node.id, { w: [96, 150, 208, 218][i % 4], h: [60, 100, 180, 260][i % 4] }])) }
}
// Shared membership identity proves every node's complete membership without
// materializing the same 12,000-element array 12,000 times in the benchmark.
function compactSnapshot(layout, progress, nodes) {
  const byId = new Map(nodes.map(node => [node.id, node])), groups = new Map(), members = new Set()
  assert.equal(layout.pos.size, nodes.length); assert.equal(layout.componentNodesById.size, nodes.length); assert.equal(layout.componentKeyById.size, nodes.length)
  for (const [id, key] of layout.componentKeyById) {
    assert(byId.has(id))
    const group = layout.componentNodesById.get(id)
    if (groups.has(key)) assert.equal(group, groups.get(key))
    else {
      groups.set(key, group)
      for (const node of group) {
        assert(!members.has(node.id)); members.add(node.id)
        assert.equal(node, byId.get(node.id))
        assert.equal(layout.componentNodesById.get(node.id), group)
        assert.equal(layout.componentKeyById.get(node.id), key)
      }
    }
  }
  assert.equal(members.size, nodes.length)
  return { pos: [...layout.pos], keys: [...layout.componentKeyById], groups: [...groups].map(([key, group]) => [key, group.map(node => node.id)]), progress }
}
// Actual 63f90d8 complete layout, before skipping single-component preparation.
const connectedFrozen = {
  'wide/80': '7958a4163cc14cb0b79639f0c1595e752af5e3d8bf4b8436952ffc324045c64a',
  'chain/80': '956d9079b3bb7bbf921577e9855724e03cd59fdeb729d2689c0c05736b84b3f3',
  'cycle/80': 'c8d5fda8ee199fdd154d4ffbb3abaf8972c3cf3baf471b52cf6f0f1b38f8a0ec',
  'wide/800': '9f3c903567ca1f468ade0a53aaeb53628b55f91061fcfb5c944d3f8204add128',
  'chain/800': '999fae547b23e992e64298f4351ac5778cde13150a6d22b01a679b606136d497',
  'cycle/800': '2e722daf13bf3193cf6120859cf885851b25d71716752b487bc949eb54be0114',
  'chain/12000': '40499080dc0e326014f7a18b443c56aab433607af494c86728f1f4f5592c2a2e',
  'cycle/12000': 'aa756201e4e481a4bca0c798518f8b84f1a989dfa8e6772b9d20586a80a3749e',
}
for (const shape of largeConnected && !smoke ? ['chain', 'cycle'] : ['wide', 'chain', 'cycle']) {
  const count = smoke ? 80 : largeConnected ? 12000 : 800, data = connectedFixture(count, shape)
  const input = JSON.stringify({ ...data, sizes: [...data.sizes] }), run = engine(true), progress = []
  const result = compactSnapshot(run.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', p => progress.push(p)), progress, data.nodes)
  assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), input)
  assert.equal(digest(result), connectedFrozen[shape + '/' + count])
  assert.equal(result.groups.length, 1)
  assert.equal(run.work.packCalls, skipsSinglePacking ? 0 : 1)
  assert.equal(run.work.orderEntries, skipsSinglePacking ? 0 : count)
  assert.equal(run.work.preparedIds, reusesPartition && !skipsSinglePacking ? count : 0)
  assert.equal(run.work.componentEdges, data.edges.length * 2)
  assert.equal(run.work.componentDequeues, count); assert.equal(run.work.componentAdjacencySets, count)
  assert.equal(run.work.packEdges, reusesPartition ? 0 : data.edges.length)
  assert.equal(run.work.packDequeues, reusesPartition ? 0 : count); assert.equal(run.work.packAdjacencySets, reusesPartition ? 0 : count)
  console.log(JSON.stringify({ baseline: revision || 'current', shape: 'connected-' + shape, nodes: count, edges: data.edges.length, ...run.work,
    result: digest(result), geometry: digest(result.pos), progress: digest(progress), scope: 'Actual full layered layout of one component. Preparation counts include ID copying and packing order entries; complete geometry, every shared membership and order, raw progress and readonly inputs are frozen. No browser timing claim.' }))
}
const raw = engine(), data = fixture(24, 'groups')
for (const sample of [data, ...['wide', 'chain', 'cycle'].map(shape => connectedFixture(24, shape))]) {
  const before = JSON.stringify({ ...sample, sizes: [...sample.sizes] }), progress = []
  const local = snapshot(raw.layoutGraph(sample.nodes, sample.edges, sample.sizes, 'layered', p => progress.push(p)), progress, sample.nodes)
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); require('node:vm').runInNewContext(workerData.source + '; self.onmessage({data:input})', {self: {postMessage: data => parentPort.postMessage(data)}, input: workerData.input, setTimeout, clearTimeout, setInterval, clearInterval});`,
    { eval: true, workerData: { source: raw.graphLayoutWorkerSource(), input: { ...sample, mode: 'layered' } } })
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
  assert.equal(digest(snapshot(remote, progress, sample.nodes, false)), digest(local))
  assert.equal(JSON.stringify({ ...sample, sizes: [...sample.sizes] }), before)
  assert.throws(() => raw.layoutLayeredComponents(sample.nodes, sample.edges, sample.sizes, () => { throw new Error('cancel fixture') }), /cancel fixture/)
}
for (const inputNodes of [null, [], data.nodes.slice(0, 1)]) {
  const layout = raw.layoutLayeredComponents(inputNodes, null, new Map())
  assert.equal(layout.pos.size, inputNodes?.length || 0)
}
assert.throws(() => raw.layoutLayeredComponents(data.nodes, data.edges, data.sizes, () => { throw new Error('cancel fixture') }), /cancel fixture/)
const changed = raw.layoutLayeredComponents(data.nodes, [], new Map(data.nodes.map(node => [node.id, { w: 250, h: 170 }])))
assert.equal(new Set(changed.componentKeyById.values()).size, data.nodes.length, 'new topology and measurements recompute partition and packing')
const dynamic = connectedFixture(24, 'wide'), sameEngine = engine(true)
const first = sameEngine.layoutLayeredComponents(dynamic.nodes, dynamic.edges, dynamic.sizes)
const disconnected = sameEngine.layoutLayeredComponents(dynamic.nodes, [], dynamic.sizes)
const resized = sameEngine.layoutLayeredComponents(dynamic.nodes, dynamic.edges, new Map(dynamic.nodes.map(node => [node.id, { w: 330, h: 280 }])))
assert.equal(new Set(first.componentKeyById.values()).size, 1)
assert.equal(new Set(disconnected.componentKeyById.values()).size, dynamic.nodes.length)
assert.equal(new Set(resized.componentKeyById.values()).size, 1)
assert.notEqual(resized.componentNodesById.get('n0'), first.componentNodesById.get('n0'))
assert.notEqual(digest([...resized.pos]), digest([...first.pos]))
assert.equal(sameEngine.work.packCalls, skipsSinglePacking ? 1 : 3)
assert.equal(sameEngine.work.orderEntries, skipsSinglePacking ? 24 : 72)
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
  cancellationPropagates: true, forcePackingFallbackPreserved: true, connectedWorkerMetadataAndProgress: true,
  connectedPartitionTransitions: true }, scope: 'Existing viewer-loading regression covers worker fallback, stale results and cancellation in the UI.' }))
