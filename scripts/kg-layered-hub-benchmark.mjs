// Actual full layered engine; count only fallback hub searches, not layout time.
// node scripts/kg-layered-hub-benchmark.mjs [ce6c56a] [--smoke | --large]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'
const smoke = process.argv.includes('--smoke'), large = process.argv.includes('--large')
const revision = process.argv.slice(2).find(arg => arg !== '--smoke' && arg !== '--large')
if (revision?.startsWith('-')) throw new Error('Expected a git revision')
const bundle = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const usesIds = bundle.includes('let hubId = component[0]')
assert(usesIds || bundle.includes('let hub = nodes.find((node) => node.id === component[0])'))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function engine(instrument = true) {
  let source = bundle
  const work = { findVisits: 0, hubCandidates: 0, hubs: [] }
  if (instrument) {
    const start = source.indexOf('function layoutLayered('), end = source.indexOf('\n      function ', start + 1)
    assert(start >= 0 && end > start)
    const block = source.slice(start, end)
      .replace('nodes.find((node) => node.id === component[0])', 'nodes.find((node) => (work.findVisits++, node.id === component[0]))')
      .replace('nodes.find((candidate) => candidate.id === id)', 'nodes.find((candidate) => (work.findVisits++, candidate.id === id))')
      .replace('for (const id of component) {\n              const node', 'for (const id of component) { work.hubCandidates++;\n              const node')
      .replace('for (const id of component) {\n              if (deg.get', 'for (const id of component) { work.hubCandidates++;\n              if (deg.get')
      .replace('const bfs = [hub.id]', 'work.hubs.push(hub.id); const bfs = [hub.id]')
      .replace('const bfs = [hubId]', 'work.hubs.push(hubId); const bfs = [hubId]')
    source = source.slice(0, start) + block + source.slice(end)
  }
  const context = { window: { React: {} }, console, work, setTimeout, clearTimeout, setInterval, clearInterval }
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { layoutLayered, graphLayoutWorkerSource,'), context)
  return { ...context.window.KGViewer, work }
}
function fixture(count, shape) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, text: 'Node ' + i, type: i % 3 === 0 ? 'claim' : 'fact' }))
  const edges = []
  for (let i = 1; i < count; i++) if (shape !== 'groups' || i % 8 !== 0) edges.push({ fromNodeId: 'n' + (shape === 'wide' ? 0 : shape === 'groups' ? i - i % 8 : i - 1), toNodeId: 'n' + i, relation: 'supports' })
  if (shape === 'cycle') edges.push({ fromNodeId: 'n' + (count - 1), toNodeId: 'n0', relation: 'supports' })
  edges.push({ ...edges[0], relation: 'analogy' }, { fromNodeId: 'n0', toNodeId: 'n0', relation: 'supports' }, { fromNodeId: 'missing', toNodeId: 'n1', relation: 'supports' })
  return { nodes, edges, sizes: new Map(nodes.map((node, i) => [node.id, { w: [96, 150, 208, 218][i % 4], h: [60, 100, 180, 260][i % 4] }])) }
}
// Store one ordered group per component, proving every node's full membership
// through its shared array instead of repeating a large group n times.
function snapshot(layout, progress, nodes, identity = true) {
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
        if (identity) assert.equal(node, byId.get(node.id))
        else assert.equal(JSON.stringify(node), JSON.stringify(byId.get(node.id)))
        assert.equal(layout.componentNodesById.get(node.id), group); assert.equal(layout.componentKeyById.get(node.id), key)
      }
    }
  }
  assert.equal(members.size, nodes.length)
  return { pos: [...layout.pos], keys: [...layout.componentKeyById], groups: [...groups].map(([key, group]) => [key, group.map(node => node.id)]), progress }
}
// Complete geometry, component metadata/member order and raw progress from ce6c56a.
const frozen = {
  'wide/80': '7958a4163cc14cb0b79639f0c1595e752af5e3d8bf4b8436952ffc324045c64a',
  'chain/80': '956d9079b3bb7bbf921577e9855724e03cd59fdeb729d2689c0c05736b84b3f3',
  'cycle/80': 'c8d5fda8ee199fdd154d4ffbb3abaf8972c3cf3baf471b52cf6f0f1b38f8a0ec',
  'groups/80': 'e1b81dc8abf649b06fdd94b3bf945b371e8ced66187d91bb356f31ccf4027bcb',
  'wide/800': '9f3c903567ca1f468ade0a53aaeb53628b55f91061fcfb5c944d3f8204add128',
  'chain/800': '999fae547b23e992e64298f4351ac5778cde13150a6d22b01a679b606136d497',
  'cycle/800': '2e722daf13bf3193cf6120859cf885851b25d71716752b487bc949eb54be0114',
  'groups/800': 'ecaaa812edc40935a69172dafc4be47b2f0b56785651ccd3ed48e1823c1d4f68',
  'chain/12000': '40499080dc0e326014f7a18b443c56aab433607af494c86728f1f4f5592c2a2e',
  'cycle/12000': 'aa756201e4e481a4bca0c798518f8b84f1a989dfa8e6772b9d20586a80a3749e',
  'groups/12000': '7670ebef704f51e34dca069a1314eca1b1248b4abf14327e807106466475837e',
}
for (const shape of large && !smoke ? ['chain', 'cycle', 'groups'] : ['wide', 'chain', 'cycle', 'groups']) {
  const count = smoke ? 80 : large ? 12000 : 800, data = fixture(count, shape)
  const before = JSON.stringify({ ...data, sizes: [...data.sizes] }), run = engine(), progress = []
  const result = snapshot(run.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', p => progress.push(p)), progress, data.nodes)
  assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), before)
  assert.equal(digest(result), frozen[shape + '/' + count])
  const components = shape === 'groups' ? count / 8 : 1, componentCount = shape === 'groups' ? 8 : count
  assert.equal(run.work.findVisits, usesIds ? 0 : components * (componentCount * (componentCount + 1) / 2 + 1))
  assert.equal(run.work.hubCandidates, count)
  assert.equal(JSON.stringify(run.work.hubs), JSON.stringify(Array.from({ length: components }, (_, i) => 'n' + i * componentCount)))
  console.log(JSON.stringify({ baseline: revision || 'current', shape, nodes: count, edges: data.edges.length, findVisits: run.work.findVisits,
    hubCandidates: run.work.hubCandidates, hubs: digest(run.work.hubs), result: digest(result), geometry: digest(result.pos), progress: digest(progress),
    scope: 'Actual complete layered engine. Only array-search predicate evaluations for fallback hubs are eliminated; the same degree candidates/order and all other layout work remain. No full-layout or browser timing claim.' }))
}
const sample = (ids, links) => ({ nodes: ids.map(id => ({ id, text: 'Node ' + id, type: 'fact' })),
  edges: links.map(([fromNodeId, toNodeId, relation = 'supports']) => ({ fromNodeId, toNodeId, relation })),
  sizes: new Map(ids.map((id, i) => [id, { w: 130 + i * 10, h: 80 + i * 20 }])) })
const cases = [
  ['tie-bfs', sample(['n0','n2','n1','n3'], [['n0','n1'],['n1','n2'],['n1','n3'],['n2','n3'],['n2','n3','analogy']]), ['n1'], 'd53a15f1708035190869b62b3803d2b2fd436730455d30748ab986ba249fd7cb'],
  ['tie-cycle', sample(['n2','n0','n1','n3'], [['n0','n1'],['n1','n2'],['n2','n3'],['n3','n0']]), ['n2'], 'c54c8f53be6652653b85ceabdd850e50f1a766bf31a8253fcc4e139da82f5a71'],
  ['reversed-cycle', sample(['n3','n1','n0','n2'], [['n0','n1'],['n1','n2'],['n2','n3'],['n3','n0']]), ['n3'], '3e4ebd1e89a2587e7ab7268f54dfa6f02072fb9b84eff1a4bb44ffe25ef6e540'],
  ['numeric-string', sample([1,'1','hub'], [['hub',1],['hub','1']]), ['hub'], 'c21c0f2c7e8b819e7ee3c3789f909059633bb2a9ac5b3024bc70c856a2913f0a'],
  ['falsey-ids', sample([0,'','hub'], [['hub',0],['hub','']]), ['hub'], '89b666188820fb85adb7d9ede9d8d20c4a6fbbd9079a6cdb654f14e6867d9b93'],
  ['reasoning-dag', sample(['n0','n1','n2','n3','n4'], [['n0','n1','causes'],['n1','n2','infers'],['n2','n3'],['n3','n4','analogy']]), [], '8b87a95ef2a1f90b27811eecad81f3d837f2800e20d4768bb787091c5e6e22d3'],
  ['reasoning-cycle', sample(['n0','n1','n2','n3'], [['n0','n1','causes'],['n1','n2','infers'],['n2','n0','causes'],['n2','n3','relates_to']]), ['n2'], 'b64c66ddc02dfcfd911fdecb50dafcea197b24071e6b417f2fe5ad58a3da9653'],
  ['isolated', sample(['n0','n1','n2','n3'], []), [], 'fcf8a1b5310a6c42dcca130209e6edcd7726355c48de648ec1a7a3bdf0ce5149'],
]
const missing = sample(['n0','n1','n2'], [['n0','n1'],['n0','n2']]); missing.sizes = new Map([['n0',{w:210,h:190}]])
cases.push(['missing-sizes', missing, ['n0'], 'c31ca29421c7f790d7509a941e6326a0ed784489573731de3eb50f488efa60f2'])
const workerSource = engine(false).graphLayoutWorkerSource()
for (const [name, data, hubs, expected] of cases) {
  const run = engine(), progress = [], readonly = JSON.stringify({ ...data, sizes: [...data.sizes] })
  const result = snapshot(run.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', p => progress.push(p)), progress, data.nodes)
  assert.equal(digest(result), expected, name)
  assert.equal(JSON.stringify(run.work.hubs), JSON.stringify(hubs), name + ' keeps first maximum in BFS component order')
  assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), readonly)
  if (usesIds) assert.equal(run.work.findVisits, 0)
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); require('node:vm').runInNewContext(workerData.source + '; self.onmessage({data:input})', {self: {postMessage: data => parentPort.postMessage(data)}, input: workerData.input, setTimeout, clearTimeout, setInterval, clearInterval});`,
    { eval: true, workerData: { source: workerSource, input: { ...data, mode: 'layered' } } })
  const workerProgress = []
  const remote = await new Promise((resolve, reject) => {
    worker.on('error', reject)
    worker.on('message', message => {
      if (message.progress) workerProgress.push(message.progress)
      else worker.terminate().then(() => message.error ? reject(new Error(message.error)) : resolve(message.layout), reject)
    })
  })
  let last = -1
  for (const event of workerProgress) {
    const index = progress.findIndex((expectedEvent, i) => i > last && JSON.stringify(event) === JSON.stringify(expectedEvent))
    assert(index > last); last = index
  }
  assert.equal(JSON.stringify(workerProgress.at(-1)), JSON.stringify(progress.at(-1)))
  assert.equal(digest(snapshot(remote, progress, data.nodes, false)), expected, name + ' actual worker')
  assert.throws(() => run.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', () => { throw new Error('cancel fixture') }), /cancel fixture/)
}
const duplicate = sample(['a','b','a'], [['a','b']]); duplicate.nodes[2].text = 'Duplicate A'
const raw = engine(), untouched = JSON.stringify({ ...duplicate, sizes: [...duplicate.sizes] })
assert.equal(digest([...raw.layoutLayered(duplicate.nodes, duplicate.edges, duplicate.sizes)]), '152f3d53fcdbd7ee7df01d6e7700f207a9e0c5814b7dd07436f68cff7b919f49')
assert.equal(JSON.stringify({ ...duplicate, sizes: [...duplicate.sizes] }), untouched)
for (const nodes of [[], [{ id: 'single' }]]) assert.equal(raw.layoutLayered(nodes, [], new Map()).size, nodes.length)
const dynamic = cases[0][1], sameEngine = engine()
const first = sameEngine.layoutGraph(dynamic.nodes, dynamic.edges, dynamic.sizes, 'layered')
const disconnected = sameEngine.layoutGraph(dynamic.nodes, [], dynamic.sizes, 'layered')
const reconnectedEdges = dynamic.nodes.filter(node => node.id !== 'n2').map(node => ({ fromNodeId:'n2', toNodeId:node.id, relation:'supports' }))
const reconnected = sameEngine.layoutGraph(dynamic.nodes, reconnectedEdges, new Map(dynamic.nodes.map(node => [node.id,{w:320,h:270}])), 'layered')
assert.equal(JSON.stringify(sameEngine.work.hubs), JSON.stringify(['n1','n2']))
assert.equal(new Set(disconnected.componentKeyById.values()).size, dynamic.nodes.length)
assert.notEqual(reconnected.componentNodesById.get('n0'), first.componentNodesById.get('n0'))
assert.notEqual(digest([...reconnected.pos]), digest([...first.pos]))
console.log(JSON.stringify({ baseline: revision || 'current', controls: { frozenHubTiesAndBfsOrder: true, numericStringAndFalseyIds: true,
  reasoningDagAndCycleFallback: true, duplicateIdsDirectHelper: true, emptySingletonAndMissingSizes: true,
  readonlyInputsAndSharedCanonicalMembers: true, actualWorkerMetadataAndThrottledCompletion: true,
  cancellationPropagates: true, newTopologyAndMeasurements: true }, scope: 'Existing viewer-loading regressions cover UI worker fallback and stale results; all other layout modes remain unchanged.' }))
