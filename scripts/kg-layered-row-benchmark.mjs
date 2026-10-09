// Count Map reads and collision scratch allocations in actual compactRows,
// including preparation; freeze every raw and merged candidate interval.
// node scripts/kg-layered-row-benchmark.mjs [ce6c56a] [--smoke | --large]
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
const usesEntries = bundle.includes('for (const peerEntry of rows.get(r) || [])')
const usesPool = bundle.includes('intervalPool.push(interval)')
const distantRowGuard = 'if (Math.abs(r * LAYER_Y_GAP - y) >= (size.h + maxHeight) / 2 + 18) continue'
const skipsDistantRows = bundle.includes(distantRowGuard)
assert(usesEntries || bundle.includes('const peer = placed.get(peerId), ps = sizes.get(peerId)'))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const phaseFields = ['calls','passes','nodeVisits','rowCandidates','rowRequests','linkRowChecks','blockedSamples','blockedEntries','peerVisits','moves']
function engine(instrument = true) {
  let source = bundle
  const intervalHashes = { raw: createHash('sha256'), merged: createHash('sha256') }
  const work = { calls: 0, passes: 0, nodeVisits: 0, rowCandidates: 0, rowRequests: 0, linkRowChecks: 0,
    blockedSamples: 0, blockedEntries: 0, peerVisits: 0, moves: [], mapReads: {},
    intervalObjects: 0, mergedCopies: 0, scratchArrays: 0, poolReuses: 0, poolPeak: 0,
    neighbourRows: 0, prunedRows: 0, rowGridChecks: 0 }
  if (instrument) {
    const start = source.indexOf('const compactRows = () => {'), end = source.indexOf('\n        compactRows()', start)
    assert(start >= 0 && end > start)
    let block = source.slice(start, end)
      .replace('const compactRows = () => {', 'const compactRows = () => { work.calls++; for (const point of placed.values()) assertGrid(point.y, Math.round(point.y / LAYER_Y_GAP) * LAYER_Y_GAP);')
      .replace('let moved = false', 'work.passes++; let moved = false')
      .replace('for (const node of ordered) {', 'for (const node of ordered) { work.nodeVisits++;')
      .replace('const y = row * LAYER_Y_GAP', 'work.rowCandidates++; const y = row * LAYER_Y_GAP')
      .replace('// Preserve inter-row channels:', 'work.rowRequests++; // Preserve inter-row channels:')
      .replace('links.some((link) => row === rowOf(link.id) && before.get(id).y !== before.get(link.id).y)',
        'links.some((link) => (work.linkRowChecks++, row === rowOf(link.id) && before.get(id).y !== before.get(link.id).y))')
      .replace('for (const peerId of rows.get(r) || []) {', 'for (const peerId of rows.get(r) || []) { work.peerVisits++;')
      .replace('for (const peerEntry of rows.get(r) || []) {', 'for (const peerEntry of rows.get(r) || []) { work.peerVisits++;')
      .replace('for (let r = row - reach; r <= row + reach; r++) {', 'for (let r = row - reach; r <= row + reach; r++) { work.neighbourRows++;')
      .replace(distantRowGuard, 'if (Math.abs(r * LAYER_Y_GAP - y) >= (size.h + maxHeight) / 2 + 18) { work.prunedRows++; continue }')
      .replace('moved = true', 'assertGrid(p.y, Math.round(p.y / LAYER_Y_GAP) * LAYER_Y_GAP); work.moves.push([id,p.x,p.y]); moved = true')
      .replace('blocked.sort(', 'work.blockedSamples++; work.blockedEntries += blocked.length; recordIntervals("raw", blocked); blocked.sort(')
      .replace('const preferred = backboneLane.has(id)', 'recordIntervals("merged", merged); const preferred = backboneLane.has(id)')
      .replace(/\b(placed|sizes|weightedAdj|lower|upper|rows|backboneLane|before|compact)\.get\(/g, 'readMap($1, "$1", ')
    if (usesPool) block = block
      .replace('if (!blocked) { blocked = []; merged = []; intervalPool = [] }', 'if (!blocked) { work.scratchArrays += 3; blocked = []; merged = []; intervalPool = [] }')
      .replace('intervalPool.push(interval)', 'work.intervalObjects++; intervalPool.push(interval); work.poolPeak = Math.max(work.poolPeak, intervalPool.length)')
      .replace('interval.left = peer.x - half;', 'work.poolReuses++; interval.left = peer.x - half;')
    else block = block
      .replace('const blocked = []', 'work.scratchArrays++; const blocked = []')
      .replace('const merged = []', 'work.scratchArrays++; const merged = []')
      .replace('blocked.push({', 'work.intervalObjects++; blocked.push({')
      .replace('else merged.push({ ...interval })', 'else { work.mergedCopies++; merged.push({ ...interval }) }')
    source = source.slice(0, start) + block + source.slice(end)
  }
  const context = { window: { React: {} }, console, work, setTimeout, clearTimeout, setInterval, clearInterval,
    assertGrid: (y, expected) => { assert.equal(y, expected); work.rowGridChecks++ },
    recordIntervals: (label, values) => intervalHashes[label].update(JSON.stringify(values)),
    readMap: (map, label, id) => { work.mapReads[label] = (work.mapReads[label] || 0) + 1; return map.get(id) } }
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { layoutLayered, graphLayoutWorkerSource,'), context)
  return { ...context.window.KGViewer, work, intervalHashes }
}
function fixture(count, shape) {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, text: 'Node ' + i, type: i % 3 === 0 ? 'claim' : 'fact' }))
  const edges = []
  for (let i = 1; i < count; i++) if (shape !== 'groups' || i % 8 !== 0) edges.push({
    fromNodeId: 'n' + (shape === 'wide' ? 0 : shape === 'groups' ? i - i % 8 : shape === 'tree' ? Math.floor((i - 1) / 3) : i - 1),
    toNodeId: 'n' + i, relation: shape === 'tree' && i % 5 === 0 ? 'causes' : 'supports' })
  if (shape === 'cycle') edges.push({ fromNodeId: 'n' + (count - 1), toNodeId: 'n0', relation: 'supports' })
  edges.push({ ...edges[0], relation: 'analogy' }, { fromNodeId: 'n0', toNodeId: 'n0', relation: 'supports' }, { fromNodeId: 'missing', toNodeId: 'n1', relation: 'supports' })
  return { nodes, edges, sizes: new Map(nodes.map((node, i) => [node.id, { w: [96,150,208,218][i % 4], h: [60,100,180,260][i % 4] }])) }
}
// One ordered group per component proves full membership without repeating a
// large shared array once per node. In-process members retain canonical identity.
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
        if (identity) assert.equal(node, byId.get(node.id))
        else assert.equal(JSON.stringify(node), JSON.stringify(byId.get(node.id)))
        assert.equal(layout.componentNodesById.get(node.id), group); assert.equal(layout.componentKeyById.get(node.id), key)
      }
    }
  }
  assert.equal(members.size, nodes.length)
  return { pos: [...layout.pos], keys: [...layout.componentKeyById], groups: [...groups].map(([key, group]) => [key, group.map(node => node.id)]), progress }
}
// ce6c56a: original/current phase Map totals, full layout/metadata/progress,
// every relocation's ID/x/y, and all remaining phase work (including peer scans).
const frozen = {
  "wide/80": [143809,12083,"7958a4163cc14cb0b79639f0c1595e752af5e3d8bf4b8436952ffc324045c64a","f4d446fd14b379e9d14e9415d78e809d281c686ab902e08e1cc66285d4934a56","02f526bd1cb9006c6cf13e09ee932066234134226db790e48337d729797ac4a6"],
  "chain/80": [1371,1211,"956d9079b3bb7bbf921577e9855724e03cd59fdeb729d2689c0c05736b84b3f3","4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","d893031be5495f014d658d9793993ddf47ac6f4e9d0b7d9f52b9f4451a7ad953"],
  "cycle/80": [19546,10847,"c8d5fda8ee199fdd154d4ffbb3abaf8972c3cf3baf471b52cf6f0f1b38f8a0ec","0f0910bb54e948ddfa841901b114af011d8714a323ea0af38407ec6359881dee","16ef2fb9c8d60becd4de4e5c5034e83916bdf979c04fff345330ae5ba9f5fa0b"],
  "groups/80": [14888,7458,"e1b81dc8abf649b06fdd94b3bf945b371e8ced66187d91bb356f31ccf4027bcb","dd4eb8ca74f80fbb96283d00bede63eac976432b798bab4f28e246f451813ee9","bfd717f35c899c3333c3e70b9beaf5ca8d1058e45b536df8f889978510f79565"],
  "tree/80": [104986,18413,"d382b3aa0f8598ff42c9c0d5b0d4750fe568ef70728a9199755933898dd29a46","4880746a9c0b8d44c730352aa529cef956543509af45e3883ee3f9b9f46172a5","72c61270b1c6018723640e562db042a6fd7395721e099160e27429acc8afd9d9"],
  "wide/800": [29044927,502003,"9f3c903567ca1f468ade0a53aaeb53628b55f91061fcfb5c944d3f8204add128","614a56c17e868750fd41402702dc96220d889c2362191308c349f3f8adede52c","7b73244e635f52dd9410a81ee4deb65d8bd4430074a7cfdc9e72df6fb40ed90c"],
  "chain/800": [13611,12011,"999fae547b23e992e64298f4351ac5778cde13150a6d22b01a679b606136d497","4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","f4f63165a215cce925fa27f416ebd2cc4d7cde5ef49afaae5dabc95f9d7976e7"],
  "cycle/800": [194956,107327,"2e722daf13bf3193cf6120859cf885851b25d71716752b487bc949eb54be0114","6fd5a9b2fcadb0223f17db7dd3dc608bbc235e35a62455119e19cde1203374f8","c92227c01b2c59a50dac35d9f5e05ae55ae8d5e86ec58925ee9be49579ccb82e"],
  "groups/800": [146468,73338,"ecaaa812edc40935a69172dafc4be47b2f0b56785651ccd3ed48e1823c1d4f68","2f14d63640138b71ab426c5ff9c1d3267873022243bd4806679a4a9ed265723f","684d85ea34c636d2096fe9e097125f8e6ac308cfee917b3695b14abab7f8aa09"],
  "tree/800": [1802966,207672,"96a4d1a1f2b9b49fc015bd42ad65daf92ca5b184f5af678be5dcefae51c7bb51","f81b288058b3b2fb2c1d7dbf58abe170728804716deeb09533a0067571d7416c","34fa8b76e3b83098f83bb07d28c48448c4c87178c80c307b78c8ff1a0ca9b44c"],
  "chain/12000": [204011,180011,"40499080dc0e326014f7a18b443c56aab433607af494c86728f1f4f5592c2a2e","4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","de7a4bb95a0e9ee424382122e4fa3fd8a69e4bc1a3d02363fcc319df55c034af"],
  "cycle/12000": [2923556,1608127,"aa756201e4e481a4bca0c798518f8b84f1a989dfa8e6772b9d20586a80a3749e","84453d488c4af75a17dfefe15d692bb62c8300c0e22af591dfd498ed8ff035f9","65b93dce8baabc76af9f0d5bde3a72fb2dac34df3054d43e6cc982f47303c6b6"],
  "groups/12000": [2193268,1098138,"7670ebef704f51e34dca069a1314eca1b1248b4abf14327e807106466475837e","9603aa319c8ffed64594a785ff98b586d925f73203704c750c30df997c1eaf58","9f343697314bc9e9b47f18ef2b40ddc85598e43aed924206ddb8c01ebc65a95b"],
}
// 60642a3: old objects/copies/arrays, pooled objects/arrays/reuses/peak,
// and every candidate's complete raw/merged bounds before scratch is reused.
const frozenIntervals = {
  "wide/80": [23958,1865,3228,27,3,23931,27,"fc9c00e10e6d2bd04975b2ac2643d30352b21757b39d0c371f419c70ad006984","ac081e8784918a92b49802fd0d5eb996afc53bf18c0d8a6c2e5f99b6c41b8be0"],
  "chain/80": [0,0,0,0,0,0,0,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  "cycle/80": [653,652,1318,2,3,651,2,"7080dff0e81b2abc852780baa72b0e8a87202a5fd99ca158eea6145f67898b58","9d634b65d0b11c574fa461fcbb0fb5ad05792f66ce89c9327766c1db57796b84"],
  "groups/80": [1730,569,1018,50,30,1680,5,"a7fb21c4ee56b288524289443f34cc87d0b0e0ad34e17416972fa2c30aea4d01","6f2d4c912a7c8b5c62fbf7399628991b419b8c7b1a1a6a16895f1c71c6abdd1a"],
  "tree/80": [13942,2634,3118,18,3,13924,18,"273907aaaaa276fe67316c41e75e5eb784d75716adfbd7baf1743bee6676b8be","2178390e37163eae57b8a8f028a419ae14eba53ef4656bcaa7f04af1152e19b1"],
  "wide/800": [4729161,100207,188206,94,3,4729067,94,"175aba3fff2a149d1d790b52bca77bcb5fb267be6fb2dd56175884d542568212","0ad6741d64d49c0c1c7e6d35712dd800f1517f5d91648cb6bf3430291b149522"],
  "chain/800": [0,0,0,0,0,0,0,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  "cycle/800": [6503,6502,13018,2,3,6501,2,"85abbdbc818be07dabcbda9e914525aac50e5b3821b9ffebacba402c0c30ad88","a1dd5a6e4c82ec610db5c56638c99fbae44b5a743c3d41b19b8f9275a6dd9d0f"],
  "groups/800": [17030,5609,10018,500,300,16530,5,"2876a6a8bbf9d7afd9a2a5438b399010356e70f58d4b3b31b3a83c97f12efeb1","f6f14d7727d9fa4fb6dc9a6d00c917d41e972e246045fc39468e5fe9c61291af"],
  "tree/800": [249746,38430,37858,34,3,249712,34,"2b1663ffae5e60cd4e45fa8ade2afdeedf0702d847cce46100b5397900feb712","647ab650d1bdbc5470db5b0834458bf5b379de107890417bd3a76b57db597a83"],
  "chain/12000": [0,0,0,0,0,0,0,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  "cycle/12000": [97503,97502,195018,2,3,97501,2,"c018a3a9ce409b9752f684d203770bcbd7efb6ba50bf4f8392720623455a21e9","bb70ab2fda028d85d72ee5ae5a5ec2c8ec2126c631549357f7246e350006dc89"],
  "groups/12000": [255030,84009,150018,7500,4500,247530,5,"e729cd8c56255edec3303da51ad0fd0995cfe2b34d94cc898d5f38b06be315bb","8f4f357f5ab5459b0d16e4735ac0d6b42e1c9319f974ef593b91c0dfed0b5f8e"],
}
// 2582f32/current: pruned Map total, old/new peer visits, neighbour rows,
// skipped rows and the complete new phase digest. All other work stays frozen.
const frozenRowScans = {
  "wide/80": [8855,66399,31837,5690,3228,"89d7e9d14908450ebfbb4235aaf9de9a5b570477b6fff036deb6f2bc3e0f169a"],
  "chain/80": [1211,0,0,0,0,"d893031be5495f014d658d9793993ddf47ac6f4e9d0b7d9f52b9f4451a7ad953"],
  "cycle/80": [9529,4329,1773,2219,1318,"fc5cc077d8e90d852524c7abd2691e92d1adae834e66710ec964bcdf9d91a994"],
  "groups/80": [6440,3929,2587,1833,1018,"6cb2e9616a8fdacb330a6b7f111eb2aa3ee0f36f960059cf69e7b7cdb0ff0678"],
  "tree/80": [15295,43620,20207,5615,3118,"bc465e3995f6611bbc0164d901ce0acbc54786db50927ae4836c081b103c5d5a"],
  "wide/800": [313797,14286594,6312458,329905,188206,"0c6b00fb7a64ac1033d62c7143037c91b08fbe47156133a4e5ce7bb6b8300c01"],
  "chain/800": [12011,0,0,0,0,"f4f63165a215cce925fa27f416ebd2cc4d7cde5ef49afaae5dabc95f9d7976e7"],
  "cycle/800": [94309,43389,17433,21749,13018,"38be12a08fec87d57015c4e119eb00cc7709c67e98597915f056597cb9b366d6"],
  "groups/800": [63320,38669,25447,18033,10018,"781e4c64ebbe18ea7a4def14b3d4a7414e693fe7603c2afec8dd150dd3e8eec3"],
  "tree/800": [169814,798640,363583,68957,37858,"929d5e5d0782efa7e0538e1dd98e9250825f6257ea6c74271de2c9f25d90f020"],
  "chain/12000": [180011,0,0,0,0,"de7a4bb95a0e9ee424382122e4fa3fd8a69e4bc1a3d02363fcc319df55c034af"],
  "cycle/12000": [1413109,650989,261033,325549,195018,"1ee7e16461bc0a1e90db05e116dc12d016cd4d5ab181fda743ab1231015e3f7c"],
  "groups/12000": [948120,579069,381047,270033,150018,"77c1700ffd95ed9ffd40e9c5882899344b5da81333e3339b6466af7463bd474d"],
}
for (const shape of large && !smoke ? ['chain','cycle','groups'] : ['wide','chain','cycle','groups','tree']) {
  const count = smoke ? 80 : large ? 12000 : 800, data = fixture(count, shape), run = engine(), progress = []
  const readonly = JSON.stringify({ ...data, sizes: [...data.sizes] })
  const result = snapshot(run.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', p => progress.push(p)), progress, data.nodes)
  const expected = frozen[shape + '/' + count], mapReads = Object.values(run.work.mapReads).reduce((a, b) => a + b, 0)
  const scans = frozenRowScans[shape + '/' + count]
  const phase = phaseFields.map(field => [field, field === 'moves' ? run.work.moves.length : run.work[field]])
  assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), readonly)
  assert.equal(mapReads, skipsDistantRows ? scans[0] : expected[usesEntries ? 1 : 0])
  assert.equal(digest(result), expected[2]); assert.equal(digest(run.work.moves), expected[3]); assert.equal(digest(phase), skipsDistantRows ? scans[5] : expected[4])
  assert.equal(run.work.peerVisits, scans[skipsDistantRows ? 2 : 1])
  assert.equal(run.work.neighbourRows, scans[3]); assert.equal(run.work.prunedRows, skipsDistantRows ? scans[4] : 0)
  assert(run.work.rowGridChecks >= count)
  const intervals = frozenIntervals[shape + '/' + count]
  const allocations = [run.work.intervalObjects, run.work.mergedCopies, run.work.scratchArrays, run.work.poolReuses, run.work.poolPeak]
  assert.deepEqual(allocations, usesPool ? [intervals[3],0,intervals[4],intervals[5],intervals[6]] : [intervals[0],intervals[1],intervals[2],0,0])
  const rawIntervals = run.intervalHashes.raw.digest('hex'), mergedIntervals = run.intervalHashes.merged.digest('hex')
  assert.equal(rawIntervals, intervals[7]); assert.equal(mergedIntervals, intervals[8])
  assert.equal(run.work.intervalObjects + run.work.poolReuses, run.work.blockedEntries)
  console.log(JSON.stringify({ baseline: revision || 'current', shape, nodes: count, mapReads, mapReadsByName: run.work.mapReads,
    result: digest(result), moveTrace: digest(run.work.moves), phase: digest(phase), peerVisits: run.work.peerVisits, blockedEntries: run.work.blockedEntries,
    neighbourRows: run.work.neighbourRows, prunedRows: run.work.prunedRows, rowGridChecks: run.work.rowGridChecks,
    allocations: { intervalObjects: allocations[0], mergedCopies: allocations[1], scratchArrays: allocations[2], poolReuses: allocations[3], poolPeak: allocations[4] }, rawIntervals, mergedIntervals,
    scope: 'All Map reads, row member visits and collision scratch allocations in actual compactRows, including preparation. Only impossible distant rows are skipped; candidate order, colliding intervals and every live-coordinate update remain. No full-layout or browser timing claim.' }))
}
const sample = (ids, links) => ({ nodes: ids.map(id => ({ id, text: 'Node ' + id, type: 'fact' })),
  edges: links.map(([fromNodeId, toNodeId, relation = 'supports']) => ({ fromNodeId, toNodeId, relation })),
  sizes: new Map(ids.map((id, i) => [id, { w: 130 + i * 10, h: 80 + i * 20 }])) })
const cases = [
  ['ties-and-rows', sample(['n0','n2','n1','n3'], [['n0','n1'],['n1','n2'],['n1','n3'],['n2','n3'],['n2','n3','analogy']]), 'd53a15f1708035190869b62b3803d2b2fd436730455d30748ab986ba249fd7cb'],
  ['cycle', sample(['n2','n0','n1','n3'], [['n0','n1'],['n1','n2'],['n2','n3'],['n3','n0']]), 'c54c8f53be6652653b85ceabdd850e50f1a766bf31a8253fcc4e139da82f5a71'],
  ['reversed', sample(['n3','n1','n0','n2'], [['n0','n1'],['n1','n2'],['n2','n3'],['n3','n0']]), '3e4ebd1e89a2587e7ab7268f54dfa6f02072fb9b84eff1a4bb44ffe25ef6e540'],
  ['numeric-string', sample([1,'1','hub'], [['hub',1],['hub','1']]), 'c21c0f2c7e8b819e7ee3c3789f909059633bb2a9ac5b3024bc70c856a2913f0a'],
  ['falsey', sample([0,'','hub'], [['hub',0],['hub','']]), '89b666188820fb85adb7d9ede9d8d20c4a6fbbd9079a6cdb654f14e6867d9b93'],
  ['reasoning-dag', sample(['n0','n1','n2','n3','n4'], [['n0','n1','causes'],['n1','n2','infers'],['n2','n3'],['n3','n4','analogy']]), '8b87a95ef2a1f90b27811eecad81f3d837f2800e20d4768bb787091c5e6e22d3'],
  ['reasoning-cycle', sample(['n0','n1','n2','n3'], [['n0','n1','causes'],['n1','n2','infers'],['n2','n0','causes'],['n2','n3','relates_to']]), 'b64c66ddc02dfcfd911fdecb50dafcea197b24071e6b417f2fe5ad58a3da9653'],
  ['isolated', sample(['n0','n1','n2','n3'], []), 'fcf8a1b5310a6c42dcca130209e6edcd7726355c48de648ec1a7a3bdf0ce5149'],
]
const missing = sample(['n0','n1','n2'], [['n0','n1'],['n0','n2']]); missing.sizes = new Map([['n0',{w:210,h:190}]])
cases.push(['missing-sizes', missing, 'c31ca29421c7f790d7509a941e6326a0ed784489573731de3eb50f488efa60f2'])
// Strict collision boundaries at one and two row gaps, including tall peers.
const boundaryCases = [
  [222-1e-9,'aaf09593da5c14bc72eaf6a1a01e254d32ab7aa026cc15c3f7d75ac7fd61b0ff','415167b74b1874ad8024c246b9280e31b0640b13a32e4d383710c42f4c3e09f6','0e828e12d18a42d6ce3222f4864713d664152f96ba0b1169a4f36bff390c1a37','e997e5fe55ba5030363ef0b991b9cb90b8589963c5a553d6e1621a9823de3885'],
  [222,'9c108454fe1516076f2316d65f3b6b69e277834fed385da1c1df5018d5eb49fd','415167b74b1874ad8024c246b9280e31b0640b13a32e4d383710c42f4c3e09f6','0e828e12d18a42d6ce3222f4864713d664152f96ba0b1169a4f36bff390c1a37','e997e5fe55ba5030363ef0b991b9cb90b8589963c5a553d6e1621a9823de3885'],
  [222+1e-9,'d408b67f40902537a78adb828cd7e0619df4854f0129b9f2c380b75aa18debcc','64e10d693ddc496d7014afaf4e51ba2e35592136846bcf4da3d023fac2a11a9c','344505fc5f2439f590bdc345839add150d1b5f7831a4c940829fae78d44db66a','a5a9d40c030fbafc3d9e5a0ce63868be4e8df2d489bd683bc12a7ec0e349eca7'],
  [462-1e-9,'d408b67f40902537a78adb828cd7e0619df4854f0129b9f2c380b75aa18debcc','64e10d693ddc496d7014afaf4e51ba2e35592136846bcf4da3d023fac2a11a9c','344505fc5f2439f590bdc345839add150d1b5f7831a4c940829fae78d44db66a','a5a9d40c030fbafc3d9e5a0ce63868be4e8df2d489bd683bc12a7ec0e349eca7'],
  [462,'59348f19c2cf5a43c1bd75a8c8829d5627ffabfa5e826db3a473a4065b3e1d9b','64e10d693ddc496d7014afaf4e51ba2e35592136846bcf4da3d023fac2a11a9c','344505fc5f2439f590bdc345839add150d1b5f7831a4c940829fae78d44db66a','a5a9d40c030fbafc3d9e5a0ce63868be4e8df2d489bd683bc12a7ec0e349eca7'],
  [462+1e-9,'f2f08331f5c84b0fa95bdc114050e931edfbb4326b2041f131aad5028db3918a','c50a9db6593e8aabbb6d921a8c155013042443df5750c15cd19e9a5eee53924a','1b5f1db1c3389b110e9ce48637affe60e797cca5efb780ac745ad38bb3aa6989','d7f3b67cb3d602ae29ad9b9c262ec810213c3cc58949e5042f7479f6f1bcdab7'],
]
for (const [height, result, moves, raw, merged] of boundaryCases) {
  const data = fixture(80, 'wide')
  for (const size of data.sizes.values()) size.h = height
  cases.push(['strict-row-distance-' + height, data, result, { moves, raw, merged }])
}
const workerSource = engine(false).graphLayoutWorkerSource()
for (const [name, data, expected, intervals] of cases) {
  const run = engine(), progress = [], readonly = JSON.stringify({ ...data, sizes: [...data.sizes] })
  const result = snapshot(run.layoutGraph(data.nodes, data.edges, data.sizes, 'layered', p => progress.push(p)), progress, data.nodes)
  assert.equal(digest(result), expected, name); assert.equal(JSON.stringify({ ...data, sizes: [...data.sizes] }), readonly)
  if (intervals) {
    assert.equal(digest(run.work.moves), intervals.moves)
    assert.equal(run.intervalHashes.raw.copy().digest('hex'), intervals.raw)
    assert.equal(run.intervalHashes.merged.copy().digest('hex'), intervals.merged)
  }
  const worker = new Worker('const {parentPort,workerData}=require("node:worker_threads"); require("node:vm").runInNewContext(workerData.source+"; self.onmessage({data:input})",{self:{postMessage:data=>parentPort.postMessage(data)},input:workerData.input,setTimeout,clearTimeout,setInterval,clearInterval});',
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
const edges = dynamic.nodes.filter(node => node.id !== 'n2').map(node => ({ fromNodeId: 'n2', toNodeId: node.id, relation: 'supports' }))
const sizes = new Map(dynamic.nodes.map(node => [node.id, { w: 320, h: 270 }]))
const reconnected = sameEngine.layoutGraph(dynamic.nodes, edges, sizes, 'layered')
const fresh = engine().layoutGraph(dynamic.nodes, edges, sizes, 'layered')
assert.equal(new Set(disconnected.componentKeyById.values()).size, dynamic.nodes.length)
assert.notEqual(reconnected.componentNodesById.get('n0'), first.componentNodesById.get('n0'))
assert.notEqual(digest([...reconnected.pos]), digest([...first.pos]))
assert.equal(digest(snapshot(reconnected, [], dynamic.nodes)), digest(snapshot(fresh, [], dynamic.nodes)))
console.log(JSON.stringify({ baseline: revision || 'current', controls: { originalRankConstraintsAndRowOrder: true, allLiveRelocationsFrozen: true,
  numericStringAndFalseyIds: true, reasoningDagAndCycleFallback: true, duplicateIdRowMembership: true, emptySingletonAndMissingSizes: true,
  readonlyInputsAndSharedCanonicalMembers: true, actualWorkerMetadataAndThrottledCompletion: true, cancellationPropagates: true,
  newTopologyAndMeasurements: true, rawAndMergedIntervalsFrozenBeforeReuse: true, lazyScratchAndComponentScope: true,
  initialAndMovedCoordinatesStayOnRowGrid: true, strictRowDistanceAndTallPeerBounds: true },
  scope: 'Row geometry and collision scratch are scoped to one compactRows invocation. Existing viewer-loading regressions also cover UI worker fallback and stale results.' }))
