// Actual adjacent-layer sorting, including its original tie-index preparation.
// node scripts/kg-layered-sweep-benchmark.mjs [ce6c56a] [--smoke | --large]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'
const smoke = process.argv.includes('--smoke'), large = process.argv.includes('--large'), capture = process.argv.includes('--capture')
const revision = process.argv.slice(2).find(arg => !['--smoke','--large','--capture'].includes(arg))
if (revision?.startsWith('-') || (capture && revision !== 'ce6c56a')) throw new Error('Capture requires the original ce6c56a baseline')
const bundle = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const cached = bundle.includes('const reuseMeans = list.length >= 4')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const number = value => Object.is(value, -0) ? '-0' : Number.isNaN(value) ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : value
const sweepStart = source => source.indexOf('const sortByNeighbours = (list, filter) => {')
function sweepBlock(source) {
  const start = sweepStart(source), end = source.indexOf('\n        placeVirtual()', start)
  assert(start >= 0 && end > start)
  return { start, end, text: source.slice(start, end) }
}
function instrument(text) {
  return text
    .replace('const sortByNeighbours = (list, filter) => {', 'const sortByNeighbours = (list, filter) => { work.sorts++; work.indexEntries += list.length;')
    .replace('const meanOf = (node) => {', 'const meanOf = (node) => { work.meanRequests++;')
    .replace('let weightedSum = 0', 'work.meanComputations++; let weightedSum = 0')
    .replace('for (const link of weightedAdj.get(id) || []) {', 'for (const link of weightedAdj.get(id) || []) { work.peerVisits++;')
    .replace('idx.set(id, { index: cached, mean })', '(work.meanEntries++, idx.set(id, { index: cached, mean }))')
    .replace('list.sort((a, b) => {', 'list.sort((a, b) => { work.comparisons++;')
    .replace('if (ma !== mb) return ma - mb', 'if (ma !== mb) return compare(a.id,b.id,ma-mb)')
    .replace('return reuseMeans ? idx.get(a.id).index - idx.get(b.id).index : idx.get(a.id) - idx.get(b.id)', 'return compare(a.id,b.id,reuseMeans ? idx.get(a.id).index-idx.get(b.id).index : idx.get(a.id)-idx.get(b.id))')
    .replace('return idx.get(a.id) - idx.get(b.id)', 'return compare(a.id,b.id,idx.get(a.id)-idx.get(b.id))')
    .replace(/\b(idx|weightedAdj|level|pos)\.get\(/g, 'readMap($1, "$1", ')
}
function telemetry() {
  const work = { sorts: 0, indexEntries: 0, meanRequests: 0, meanComputations: 0, meanEntries: 0, peerVisits: 0, comparisons: 0, mapReads: {}, moves: [] }
  const trace = createHash('sha256')
  return { work, trace,
    readMap: (map, label, id) => { work.mapReads[label] = (work.mapReads[label] || 0) + 1; return map.get(id) },
    compare: (a, b, value) => { trace.update(JSON.stringify([a,b,number(value)])); return value } }
}
function engine(measure = true) {
  let source = bundle
  const stats = telemetry()
  if (measure) {
    const { start, end, text } = sweepBlock(source)
    source = source.slice(0, start) + instrument(text) + source.slice(end)
    const moveStart = source.indexOf('const compactRows = () => {'), moveEnd = source.indexOf('\n        compactRows()', moveStart)
    assert(moveStart >= 0 && moveEnd > moveStart)
    const moving = source.slice(moveStart, moveEnd).replace('moved = true', 'work.moves.push([id,p.x,p.y]); moved = true')
    source = source.slice(0, moveStart) + moving + source.slice(moveEnd)
  }
  const context = { window: { React: {} }, console, setTimeout, clearTimeout, setInterval, clearInterval, ...stats }
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { layoutLayered, graphLayoutWorkerSource,'), context)
  return { ...context.window.KGViewer, ...stats }
}
function fixture(count, shape) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, text: 'Node ' + i, type: i % 3 === 0 ? 'claim' : 'fact' })), edges = []
  for (let i = 1; i < count; i++) if (shape !== 'groups' || i % 8 !== 0) edges.push({
    fromNodeId: 'n' + (shape === 'wide' ? 0 : shape === 'groups' ? i - i % 8 : shape === 'tree' ? Math.floor((i - 1) / 3) : i - 1),
    toNodeId: 'n' + i, relation: shape === 'tree' && i % 5 === 0 ? 'causes' : 'supports' })
  if (shape === 'cycle') edges.push({ fromNodeId: 'n' + (count - 1), toNodeId: 'n0', relation: 'supports' })
  edges.push({ ...edges[0], relation: 'analogy' }, { fromNodeId: 'n0', toNodeId: 'n0', relation: 'supports' }, { fromNodeId: 'missing', toNodeId: 'n1', relation: 'supports' })
  return { nodes, edges, sizes: new Map(nodes.map((node, i) => [node.id, { w: [96,150,208,218][i % 4], h: [60,100,180,260][i % 4] }])) }
}
function snapshot(layout, progress, nodes, identity = true) {
  const byId = new Map(nodes.map(node => [node.id, node])), groups = new Map(), members = new Set()
  assert.equal(layout.pos.size, nodes.length); assert.equal(layout.componentKeyById.size, nodes.length); assert.equal(layout.componentNodesById.size, nodes.length)
  for (const [id, key] of layout.componentKeyById) {
    const group = layout.componentNodesById.get(id)
    assert(byId.has(id))
    if (groups.has(key)) assert.equal(group, groups.get(key))
    else {
      groups.set(key, group)
      for (const node of group) {
        assert(!members.has(node.id)); members.add(node.id)
        if (identity) assert.equal(node, byId.get(node.id)); else assert.equal(JSON.stringify(node), JSON.stringify(byId.get(node.id)))
        assert.equal(layout.componentNodesById.get(node.id), group); assert.equal(layout.componentKeyById.get(node.id), key)
      }
    }
  }
  assert.equal(members.size, nodes.length)
  return { pos: [...layout.pos], keys: [...layout.componentKeyById], groups: [...groups].map(([key, group]) => [key, group.map(node => node.id)]), progress }
}
// Original/new Map reads and neighbour visits; new lazy mean entries, comparison
// count, full coordinates/metadata/raw progress, native comparison trace, moves.
const frozen = {
  "wide/80": [1878,1653,471,240,237,234,"7958a4163cc14cb0b79639f0c1595e752af5e3d8bf4b8436952ffc324045c64a","4b28478958c7f3c03ea922b0487efb2993fc1bd909934c32ecc5f69c3e3c6ffa","f4d446fd14b379e9d14e9415d78e809d281c686ab902e08e1cc66285d4934a56"],
  "chain/80": [0,0,0,0,0,0,"956d9079b3bb7bbf921577e9855724e03cd59fdeb729d2689c0c05736b84b3f3","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
  "cycle/80": [1893,1893,942,942,0,234,"c8d5fda8ee199fdd154d4ffbb3abaf8972c3cf3baf471b52cf6f0f1b38f8a0ec","7c1773600b2f04e1bec8164cbaa1bcea7fe62cc4221fdb682f83bcde35057799","0f0910bb54e948ddfa841901b114af011d8714a323ea0af38407ec6359881dee"],
  "groups/80": [1446,1356,363,213,210,180,"e1b81dc8abf649b06fdd94b3bf945b371e8ced66187d91bb356f31ccf4027bcb","b463d5773f104463da6d79d7b2d6ccde616ccb72fa52d08625dbcd080ac7f5b0","dd4eb8ca74f80fbb96283d00bede63eac976432b798bab4f28e246f451813ee9"],
  "tree/80": [9927,5050,4116,765,414,1199,"d382b3aa0f8598ff42c9c0d5b0d4750fe568ef70728a9199755933898dd29a46","a55634b9d2798201ba4a557e58aa18aaa79aa0b4cf2a24d80af54c8d4158087a","4880746a9c0b8d44c730352aa529cef956543509af45e3883ee3f9b9f46172a5"],
  "wide/800": [19158,16773,4791,2400,2397,2394,"9f3c903567ca1f468ade0a53aaeb53628b55f91061fcfb5c944d3f8204add128","70dc86edd83f5cdb93f3e8c6c4dd4a0ac2d56e6d609aae4a191f7c7ec81836a2","614a56c17e868750fd41402702dc96220d889c2362191308c349f3f8adede52c"],
  "chain/800": [0,0,0,0,0,0,"999fae547b23e992e64298f4351ac5778cde13150a6d22b01a679b606136d497","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
  "cycle/800": [19173,19173,9582,9582,0,2394,"2e722daf13bf3193cf6120859cf885851b25d71716752b487bc949eb54be0114","8d135c125db81e6d4a0e797ee078670659e8c3bfc68273fcab82ff260c6131f8","6fd5a9b2fcadb0223f17db7dd3dc608bbc235e35a62455119e19cde1203374f8"],
  "groups/800": [14406,13506,3603,2103,2100,1800,"ecaaa812edc40935a69172dafc4be47b2f0b56785651ccd3ed48e1823c1d4f68","7fa5fcd40e66c81968b34c8a8ca74f40804a601a6af58d7e9053933fa1c00204","2f14d63640138b71ab426c5ff9c1d3267873022243bd4806679a4a9ed265723f"],
  "tree/800": [130641,52860,59314,7677,4302,13726,"96a4d1a1f2b9b49fc015bd42ad65daf92ca5b184f5af678be5dcefae51c7bb51","50afb62379a33c374538656d43fc8555b3553ffc61a3819a2662cff51ae23171","f81b288058b3b2fb2c1d7dbf58abe170728804716deeb09533a0067571d7416c"],
  "chain/12000": [0,0,0,0,0,0,"40499080dc0e326014f7a18b443c56aab433607af494c86728f1f4f5592c2a2e","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
  "cycle/12000": [287973,287973,143982,143982,0,35994,"aa756201e4e481a4bca0c798518f8b84f1a989dfa8e6772b9d20586a80a3749e","564ccef866990b8bd04c51a6ae6da2cdd138046f34c2b3b8e28db9ecd769830f","84453d488c4af75a17dfefe15d692bb62c8300c0e22af591dfd498ed8ff035f9"],
  "groups/12000": [216006,202506,54003,31503,31500,27000,"7670ebef704f51e34dca069a1314eca1b1248b4abf14327e807106466475837e","9059e9c2a9a415097308a2c1cc67cf76c8d7836be7be254401ce47788d84a564","9603aa319c8ffed64594a785ff98b586d925f73203704c750c30df997c1eaf58"],
}
for (const shape of large && !smoke ? ['chain','cycle','groups'] : ['wide','chain','cycle','groups','tree']) {
  const count = smoke ? 80 : large ? 12000 : 800, data = fixture(count, shape), run = engine(), progress = []
  const untouched = JSON.stringify({ ...data, sizes: [...data.sizes] })
  const result = snapshot(run.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', p => progress.push(p)), progress, data.nodes)
  assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), untouched)
  const mapReads = Object.values(run.work.mapReads).reduce((a, b) => a + b, 0), trace = run.trace.copy().digest('hex'), key = shape + '/' + count
  const expected = frozen[key]
  if (!capture) {
    assert(expected, 'Missing frozen scene ' + key)
    assert.equal(mapReads, expected[cached ? 1 : 0]); assert.equal(run.work.peerVisits, expected[cached ? 3 : 2])
    assert.equal(run.work.meanEntries, cached ? expected[4] : 0); assert.equal(run.work.comparisons, expected[5])
    assert.equal(digest(result), expected[6]); assert.equal(trace, expected[7]); assert.equal(digest(run.work.moves), expected[8])
    assert(run.work.meanComputations <= run.work.meanRequests)
  }
  console.log(JSON.stringify({ baseline: revision || 'current', shape, nodes: count, ...run.work, mapReads, mapReadsByName:run.work.mapReads,
    result: digest(result), comparisonTrace: trace, moveTrace: digest(run.work.moves), moves: undefined,
    scope: 'Actual adjacent-layer sorting, including tie-index preparation. Single-sort mean entries are counted; small layers retain the original path. Native comparisons, ordering and full geometry stay frozen. No full-layout timing or memory claim.' }))
}
const directFrozen = {
  "small-0": ["5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  "small-1": ["300ba247c9c03abac430e095caed05745ce67f315392cb8ab04c1eeaace80f2e","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  "small-2": ["324970e121641b9f66a9e5210f48ccbdc8309f63f311a2271b63fb2406738463","9519cb2cfdd89edc2b65fa2479988d6e56acbbf035b629284507032f57a1e2fb"],
  "small-3": ["40722b10f19850f5076a673ab6695824f966985e5e1595e71d575d52243ff7f1","99da9d5456aa1fd0b3bdfa735a7fcf36b991a4b8e0c7f46e250b7c578fc6a5c5"],
  "small-4": ["6eb81895492808b7066cc30285f19cff35e1f57e4e45237c5770556a12d42cfc","6d59ea427e1533772913fa7166c335a456dc04444c6b7e0d7bac5b9a7462ed61"],
  "mixed-ids": ["19afbf1521e851d1cc35daeee5f1f7715cacae5079181a92cc83192e5ffe3973","39c70da876e4993f55629199dabc8cd0f151a27aae31717e711d078b0279d3d8"],
  "duplicate-ids": ["5e6d13f8b20b5c3ca889b8352193524c33d917ed082f4b9d03c60bd71fe7271c","cecd3ed601079951dc86b4ceeb0ba57691ea0a2c06e34d0e6cc4e40f9fd0d7c4"],
  "nonfinite-means": ["c9996dedc2bb849f5f486847c1fb4daa42267e0a3f6f1c6f1526b5aaf1378f3a","a8c9a98243c938c297a28fec0fd5d8de717cbb768c9624490e7ba790588ae60a"],
}
function direct(name, ids, nonfinite = false) {
  const nodes = ids.map(id => ({ id })), points = new Map([['left',{x:nonfinite ? NaN : -25}],['middle',{x:0}],['right',{x:nonfinite ? Infinity : 25}],['child',{x:40}]])
  const level = new Map([['left',-1],['middle',-1],['right',-1],['child',1]])
  const weightedAdj = new Map(ids.map((id, i) => [id, i % 4 === 0 ? [{id:'middle',weight:1},{id:'child',weight:2}]
    : i % 4 === 1 ? [{id:'left',weight:1},{id:'right',weight:1}] : i % 4 === 2 ? [{id:'child',weight:1}] : [{id:'right',weight:2}]]))
  const stats = telemetry(), helper = runInNewContext(instrument(sweepBlock(bundle).text) + '; sortByNeighbours', { weightedAdj, level, pos: points, ...stats })
  const inputs = digest({ nodes, weightedAdj:[...weightedAdj], level:[...level], pos:[...points] }), outcomes = []
  const group = nodes.slice()
  for (const filter of [l => l < 0, l => l < 0]) {
    helper(group, filter); outcomes.push(group.map(node => node.id))
    for (const node of group) assert(nodes.includes(node))
  }
  assert.equal(digest({ nodes, weightedAdj:[...weightedAdj], level:[...level], pos:[...points] }), inputs)
  points.get('child').x = -80; points.get('right').x = nonfinite ? -Infinity : -40
  helper(group, l => l > 0); outcomes.push(group.map(node => node.id))
  const state = digest(outcomes), trace = stats.trace.copy().digest('hex'), expected = directFrozen[name]
  if (!capture) { assert(expected, name); assert.equal(state, expected[0]); assert.equal(trace, expected[1]) }
  if (ids.length < 4) assert.equal(stats.work.meanEntries, 0)
  console.log(JSON.stringify({ baseline: revision || 'current', direct:name, outcomes, result:state, comparisonTrace:trace, ...stats.work, moves:undefined }))
}
for (const count of [0,1,2,3,4]) direct('small-' + count, Array.from({ length:count }, (_,i) => 'n' + i))
direct('mixed-ids', [0,'',1,'1','hub','peer',2,'2'])
direct('duplicate-ids', ['a','b','a','c','d','e'])
direct('nonfinite-means', ['a','b','c','d','e','f','g','h'], true)
const mixed = { nodes:[0,'',1,'1','hub','leaf',2].map(id => ({id,text:'Node ' + id,type:'fact'})),
  edges:[0,'',1,'1','leaf',2].map(toNodeId => ({fromNodeId:'hub',toNodeId,relation:'supports'})),
  sizes:new Map([0,'',1,'1','hub','leaf',2].map(id => [id,{w:210,h:190}])) }
const workerCases = [['wide-small',fixture(24,'wide')],['tree-small',fixture(40,'tree')],['mixed-ids',mixed]]
const workerSource = engine(false).graphLayoutWorkerSource()
for (const [name,data] of workerCases) {
  const run = engine(), progress = [], originalInputs = JSON.stringify({...data,sizes:[...data.sizes]})
  const result = snapshot(run.layoutGraph(data.nodes,data.edges,data.sizes,'layered',p=>progress.push(p)),progress,data.nodes)
  assert.equal(JSON.stringify({...data,sizes:[...data.sizes]}),originalInputs)
  const worker = new Worker('const {parentPort,workerData}=require("node:worker_threads"); require("node:vm").runInNewContext(workerData.source+"; self.onmessage({data:input})",{self:{postMessage:data=>parentPort.postMessage(data)},input:workerData.input,setTimeout,clearTimeout,setInterval,clearInterval});',
    {eval:true,workerData:{source:workerSource,input:{...data,mode:'layered'}}})
  const remoteProgress = []
  const remote = await new Promise((resolve,reject)=>{
    worker.on('error',reject); worker.on('message',message=>{
      if(message.progress)remoteProgress.push(message.progress)
      else worker.terminate().then(()=>message.error?reject(new Error(message.error)):resolve(message.layout),reject)
    })
  })
  let last = -1
  for (const event of remoteProgress) {
    const index = progress.findIndex((p,i)=>i>last&&JSON.stringify(p)===JSON.stringify(event))
    assert(index>last); last=index
  }
  assert.equal(JSON.stringify(remoteProgress.at(-1)),JSON.stringify(progress.at(-1)))
  assert.equal(digest(snapshot(remote,progress,data.nodes,false)),digest(result),name + ' actual worker')
  assert.throws(()=>run.layoutGraph(data.nodes,data.edges,data.sizes,'layered',()=>{throw new Error('cancel fixture')}),/cancel fixture/)
}
const changing = fixture(32,'tree'), reused = engine()
reused.layoutGraph(changing.nodes,changing.edges,changing.sizes,'layered')
const revisedEdges = changing.nodes.slice(1).map(node=>({fromNodeId:'n0',toNodeId:node.id,relation:'analogy'}))
const revisedSizes = new Map(changing.nodes.map(node=>[node.id,{w:320,h:270}]))
const later = reused.layoutGraph(changing.nodes,revisedEdges,revisedSizes,'layered')
const fresh = engine().layoutGraph(changing.nodes,revisedEdges,revisedSizes,'layered')
assert.equal(digest(snapshot(later,[],changing.nodes)),digest(snapshot(fresh,[],changing.nodes)))
console.log(JSON.stringify({baseline:revision||'current',controls:{fullCoordinatesAndComponentMetadata:true,canonicalSharedMemberIdentity:true,readonlyInputs:true,
  originalNativeComparisonsAndTieOrder:true,smallLayersHaveNoMeanEntries:true,mixedNumericStringAndFalseyIds:true,duplicateIdOriginalTieIndices:true,
  zeroInfinityAndNaNMeans:true,changedPositionsAndFilterReset:true,newTopologyAndMeasurements:true,actualWorkerAndThrottledProgress:true,cancellationPropagates:true}}))
