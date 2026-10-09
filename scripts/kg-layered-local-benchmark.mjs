// Actual local semantic placement, reusing the row membership already prepared.
// node scripts/kg-layered-local-benchmark.mjs [ce6c56a] [--smoke | --large]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'
const smoke = process.argv.includes('--smoke'), large = process.argv.includes('--large'), capture = process.argv.includes('--capture')
const revision = process.argv.slice(2).find(arg => !['--smoke','--large','--capture'].includes(arg))
if (revision?.startsWith('-') || (capture && revision !== 'ce6c56a')) throw new Error('Capture requires the original ce6c56a baseline')
const bundle = revision ? execFileSync('git',['show',revision+':extension/viewer.js'],{encoding:'utf8',maxBuffer:8*1024*1024})
  : readFileSync(new URL('../extension/viewer.js',import.meta.url),'utf8')
const reuseRows = bundle.includes('return (rowIds.get(p.y) || []).every((peerId) => {')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const number = value => Object.is(value,-0)?'-0':Number.isNaN(value)?'NaN':value===Infinity?'Infinity':value===-Infinity?'-Infinity':value
function localBlock(source) {
  const start = source.indexOf('        const rowPeers = (id) => {') >= 0 ? source.indexOf('        const rowPeers = (id) => {') : source.indexOf('        const slotFree = (id, x) => {')
  const end = source.indexOf('\n        for (const edge of edges)',start)
  assert(start>=0 && end>start)
  return {start,end,text:source.slice(start,end)}
}
function instrument(text) {
  return text.replace('const slotFree = (id, x) => {','const slotFree = (id, x) => { work.slotChecks++;')
    .replace('return nodes.filter((node) => node.id !== id && placed.has(node.id) && placed.get(node.id).y === p.y)',
      'work.filteredArrays++; return nodes.filter((node) => (work.componentVisits++, node.id !== id && placed.has(node.id) && placed.get(node.id).y === p.y))')
    .replace('.every((peerId) => {','.every((peerId) => { work.rowVisits++;')
    .replace('return x + half + localGap <= pp.x - peerHalf || x - half - localGap >= pp.x + peerHalf',
      'return compare(id,x,'+(reuseRows?'peerId':'peer.id')+',x + half + localGap <= pp.x - peerHalf || x - half - localGap >= pp.x + peerHalf)')
    .replace(/\b(placed|sizes|rowIds)\.get\(/g,'readMap($1, ').replace('placed.has(','hasMap(placed, ')
}
function telemetry() {
  const work = {componentVisits:0,rowVisits:0,slotChecks:0,peerComparisons:0,filteredArrays:0,rowEntries:0,preparationReads:0,preparationWrites:0,mapReads:0,mapHas:0,localMoves:0,compactMoves:0}
  const trace=createHash('sha256'), movement=createHash('sha256')
  return {work,trace,movement,
    compare:(id,x,peer,value)=>{work.peerComparisons++;trace.update(JSON.stringify([number(id),number(x),number(peer),value]));return value},
    readMap:(map,id)=>{work.mapReads++;return map.get(id)},hasMap:(map,id)=>{work.mapHas++;return map.has(id)},
    prepareRead:(map,id)=>{work.preparationReads++;return map.get(id)},prepareWrite:(map,id,value)=>{work.preparationWrites++;return map.set(id,value)}}
}
function engine(measure=true) {
  let source=bundle
  const stats=telemetry()
  if(measure) {
    const {start,end,text}=localBlock(source), passEnd=source.indexOf('\n        if (pinnedXOut',end)
    assert(passEnd>end)
    const moving=source.slice(end,passEnd).replace('mover.x = chosen','mover.x = chosen; work.localMoves++; movement.update(JSON.stringify([moverId,mover.x,mover.y]));')
      .replace(/\b(placed|sizes)\.get\(/g,'readMap($1, ')
    source=source.slice(0,start)+instrument(text)+moving+source.slice(passEnd)
    const prepStart=source.indexOf('        const rowIds = new Map()'),prepEnd=source.indexOf('\n        const rowGap =',prepStart)
    assert(prepStart>=0 && prepEnd>prepStart)
    const prep=source.slice(prepStart,prepEnd).replace('list.push(node.id)','work.rowEntries++; list.push(node.id)')
      .replace(/\b(placed|rowIds)\.get\(/g,'prepareRead($1, ').replace('rowIds.set(','prepareWrite(rowIds, ')
    source=source.slice(0,prepStart)+prep+source.slice(prepEnd)
    const compactStart=source.indexOf('const compactRows = () => {'),compactEnd=source.indexOf('\n        compactRows()',compactStart)
    assert(compactStart>=0 && compactEnd>compactStart)
    source=source.slice(0,compactStart)+source.slice(compactStart,compactEnd)
      .replace('moved = true','work.compactMoves++; movement.update(JSON.stringify([id,p.x,p.y])); moved = true')+source.slice(compactEnd)
  }
  const context={window:{React:{}},console,setTimeout,clearTimeout,setInterval,clearInterval,...stats}
  runInNewContext(source.replace('window.KGViewer = {','window.KGViewer = { layoutLayered, graphLayoutWorkerSource,'),context)
  return {...context.window.KGViewer,...stats}
}
function fixture(count,shape) {
  const nodes=Array.from({length:count},(_,i)=>({id:'n'+i,text:'Node '+i,type:i%8===0?'concept':i%3===0?'definition':'example'})),edges=[]
  const relations=['example','defines','analogy','contains','counter_example']
  for(let i=1;i<count;i++) {
    const from=shape==='wide'?0:shape==='groups'?i-i%8:shape==='chain'?i-1:Math.floor((i-1)/3)
    if(shape==='groups'&&i%8===0)continue
    const relation=shape==='plain'?'supports':shape==='mixed'&&i%3===0?'supports':relations[i%relations.length]
    edges.push({fromNodeId:'n'+(relation==='contains'?from:i),toNodeId:'n'+(relation==='contains'?i:from),relation})
    if(shape==='multi'&&i>5)edges.push({fromNodeId:'n'+i,toNodeId:'n'+Math.floor((i-1)/5),relation:relations[(i+1)%relations.length]})
    if(shape==='backbone'&&i%5===0)edges.push({fromNodeId:'n'+from,toNodeId:'n'+i,relation:'causes'})
  }
  edges.push({...edges[0],relation:'supports'},{fromNodeId:'n0',toNodeId:'n0',relation:'contains'},{fromNodeId:'missing',toNodeId:'n1',relation:'defines'})
  return {nodes,edges,sizes:new Map(nodes.map((node,i)=>[node.id,{w:[96,150,208,218][i%4],h:[60,100,180,260][i%4]}]))}
}
function snapshot(layout,progress,nodes,identity=true) {
  const byId=new Map(nodes.map(node=>[node.id,node])),groups=new Map(),members=new Set()
  assert.equal(layout.pos.size,nodes.length);assert.equal(layout.componentKeyById.size,nodes.length);assert.equal(layout.componentNodesById.size,nodes.length)
  for(const [id,key] of layout.componentKeyById) {
    const list=layout.componentNodesById.get(id)
    assert(byId.has(id))
    if(groups.has(key))assert.equal(list,groups.get(key))
    else {
      groups.set(key,list)
      for(const node of list) {
        assert(!members.has(node.id));members.add(node.id)
        if(identity)assert.equal(node,byId.get(node.id));else assert.equal(JSON.stringify(node),JSON.stringify(byId.get(node.id)))
        assert.equal(layout.componentNodesById.get(node.id),list);assert.equal(layout.componentKeyById.get(node.id),key)
      }
    }
  }
  assert.equal(members.size,nodes.length)
  return {pos:[...layout.pos],keys:[...layout.componentKeyById],groups:[...groups].map(([key,list])=>[key,list.map(node=>node.id)]),progress}
}
// Before component visits / after row visits / before-after local Map reads /
// slot checks / live peer comparisons / local-compact moves / full geometry,
// metadata and raw progress / every comparison / every immediate move.
const frozen = {
  "wide/80":[105840,1968,111215,8021,1323,1946,0,89,"7a2ee696d8c9b34a930c5f1228caa386a3f93274d49e42c7468578212232c948","c53974f6400484fbb1b3f7a04ff1499ae3c09db9ca2da00ef6bb32c9f2984b74","eb1925dd52002c986947face07b64e150c1d02f74b032aa34176a545ff40bbe3"],
  "chain/80":[0,0,160,160,0,0,0,0,"956d9079b3bb7bbf921577e9855724e03cd59fdeb729d2689c0c05736b84b3f3","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  "groups/80":[3360,786,5494,2974,420,786,0,102,"ae8343b9f6d63d7db3b946982445557db394f0f0f0d816b1ffc7753632c55bb6","f23f7e0df8b0b6189297cde00585e3ecef571e6a8fadb219c24df138c13eab73","c0aec1bab3d3b65810f5454d877e59b18626f6fa2f358c9000bb6354f8aee433"],
  "tree/80":[39040,1411,42206,4142,488,1259,2,203,"7de38c4e76586d3bef6db60c60931e2d7365a9d09d4a3e9d40563f2bef6db891","84fd439bbdca10dd2922abf095865c25dde299d4a94b43e5497dafff16cf4503","d5e0ba32844ad75231fa40678a8dae0733fffc837591dff0e526fa4892f0517c"],
  "mixed/80":[32960,1328,35804,3668,412,1162,10,212,"135641b2f27ef08d8c89f3c49eea0d72b84604edfacde2ee3678715ee5a610d6","b07a97f3d21278342fea7eeb44da6a42d987b86b6a1d51c4b41631dafa650710","f9436f9147b224ad7dd5985373aec185c79a41a26971efdbe7494c2df4e8e9b0"],
  "multi/80":[120720,6768,134697,16995,1509,6086,11,260,"fbaadd54e442ae168b3beb9668a9980443370eba75229068233959a33281b76a","eb4caeffc1beeee75cfad9e4d7d133383e3af37cb1016eedc2f574aaf4fc6cbe","6dabf0047c35a8f93a5011585a38ace98ba86fc564fe1ffa98e9d4a7c0db53be"],
  "backbone/80":[62080,3456,69540,9012,776,3262,3,177,"1bece8d038b27ad99e6c8296ec0349bcdda01d062e2b25b2c1ed7cd6aaf322ef","10bc3322e98241e4ffbd20a77f66c4da8b76343996b0e2bd5e382225dd70d76f","ae10e60d73f07a915d2dd64418c79a3c824a0fb301817e5a9b0a83610c7aa015"],
  "plain/80":[0,0,2,2,0,0,0,256,"67ef08ffc815231244aa317f2d0d484ac1edc49fc9a238be4271efeb4eac0c43","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","5aa8081db37e5fac922fdaa456f92ffe3623796d890b68d23572e49de2316864"],
  "wide/800":[12448800,21141,12508197,90519,15561,21118,0,824,"4d907f0d11edb3bbd39dd1606378b3e96eee3b2d2d9ee85cbd3163f0af7c1c76","7b4590edd38757d9a231db6b4e88fa50eb242598a29df9cb624ffeb48165d555","bb3dc0034bad3df551cec2d06f42392cf16e369fdec848ebb22ff353b7cceade"],
  "chain/800":[0,0,1600,1600,0,0,0,0,"999fae547b23e992e64298f4351ac5778cde13150a6d22b01a679b606136d497","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  "groups/800":[33600,7896,54994,29794,4200,7896,0,1002,"0b99356cbdd5942d21a7a976053b0403f34d97a5a4b3836f20d62044da5772e4","e8ad74b90b967fbd6eef78dea47a38a7be3a952c5841bd9f2a5cfa5e145a7e6f","ef6bdb0006213d36dc8200e728e14041c6bc8c33da98dd1c2b695288a7365e12"],
  "tree/800":[4537600,21587,4584392,58136,5672,19760,104,4292,"7c98759c1b1d114eae979ce2d75d6f61b41436ab6813b341982fe37ee640a337","ecd43fcd4dd845c34a968daf85e770ed7a6e92cdf8df626c8184d363a8133a27","1fb75e7749bf38706099557e6b6b768daa9a374a7aa580c7af7c6cac2de06d44"],
  "mixed/800":[2204800,12792,2231346,32058,2756,11361,59,4811,"cf8edac4252269f47c195c030ae37e630110cf6fbfe11cbcd3d33b0b1ace78e5","5b46e6c8cf6a0eae8a53e3c37bf6bf699718938d94b1cd47d71042bb750ae374","34cd1c84a245e130806494617f7ca208f3334b1bed05808b89b184b04467544c"],
  "multi/800":[12969600,89463,13153956,216780,16212,82657,322,4670,"4f6548a0fa4fe0a29ee45481d3903b8e79926f8b95f09b3207e7b9e6f9dfb55a","ce54eec5a12d71ce1e5b4e8034b5c34b4cb55b4e3060d9969ed8f085a8b357b1","a5d6763a986f286c8155a88caa7e5f3e3be0f8e4f1174a91dd16bf4fe65921a3"],
  "backbone/800":[6652000,43989,6745577,110207,8315,41831,51,2329,"d92ff9a73e2a0f1735faaa9bc13747e1e9facd09c391702a387f3eb5f29ad111","f58a9df277ba25fa7722a1cd3ff6e3ae217daa4c80c42baffaf53d473df6a2ec","c3eabdb4d0a2d69bf13aa1814438c2717a84da358aabdb6d578a952cd67c1b4c"],
  "plain/800":[0,0,2,2,0,0,0,4651,"725ff983d942e1ca630b163948533afedd1253329b595e2504f5accc371f1a88","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","e9b03de262091eab432e1ceaaa82d0c980b09712978c3e684f9e03c357a25f94"],
  "chain/12000":[0,0,24000,24000,0,0,0,0,"40499080dc0e326014f7a18b443c56aab433607af494c86728f1f4f5592c2a2e","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  "groups/12000":[504000,118496,824994,446994,63000,118496,0,15002,"ca1f78eddc45bfe04b246f5e8852ebe10c8e05241ea2df1e6800f121867a8ec3","4afd6da45cbf0723dd877f35df48921d3f45957776e9399eda4abd2ba9fb5557","95cab30ecad7623e39c6336d23da1c6fe021b54a9bbc75a5a972a0b79b76b810"],
}
const count=smoke?80:large?12000:800
for(const shape of large&&!smoke?['chain','groups']:['wide','chain','groups','tree','mixed','multi','backbone','plain']) {
  const data=fixture(count,shape),run=engine(),progress=[],untouched=JSON.stringify({...data,sizes:[...data.sizes]})
  const result=snapshot(run.layoutGraph(data.nodes,data.edges,data.sizes,'layered',p=>progress.push(p)),progress,data.nodes)
  assert.equal(JSON.stringify({...data,sizes:[...data.sizes]}),untouched)
  const state=digest(result),trace=run.trace.digest('hex'),moves=run.movement.digest('hex'),expected=frozen[shape+'/'+count],w=run.work
  if(!capture) {
    assert(expected);assert.equal(w.componentVisits,reuseRows?0:expected[0]);assert.equal(w.rowVisits,reuseRows?expected[1]:0)
    assert.equal(w.mapReads,expected[reuseRows?3:2]);assert.equal(w.slotChecks,expected[4]);assert.equal(w.peerComparisons,expected[5])
    assert.equal(w.filteredArrays,reuseRows?0:expected[4]);assert.equal(w.mapHas,reuseRows?0:expected[0]-expected[4])
    assert.equal(w.localMoves,expected[6]);assert.equal(w.compactMoves,expected[7]);assert.equal(state,expected[8]);assert.equal(trace,expected[9]);assert.equal(moves,expected[10])
    assert.equal(w.rowEntries,count);assert.equal(w.preparationReads,2*count);assert.equal(w.preparationWrites,count)
  }
  console.log(JSON.stringify({baseline:revision||'current',shape,nodes:count,...w,nodeVisits:w.componentVisits+w.rowVisits+(reuseRows?0:w.peerComparisons),result:state,comparisonTrace:trace,movementTrace:moves,
    scope:'Actual local semantic placement. Existing row preparation and all Map/has reads are counted; no new row index or cross-call cache. Original peer order, comparisons, immediate moves and full geometry stay frozen. No full-layout timing or memory claim.'}))
}
const directFrozen = {
  'strict-gap-and-live-x':['e85865d144a38bdf174822bacb7d56bd6a5f9b8c7026d97249ed1d48f43a76ea','a0bbedcf7c9efbf228ebaf6c475c64c8f137d54027977de81f8fb6581c3de84b'],
  'mixed-falsey-and-nan-ids':['d44ed6b582d84b0588bd845d9bfd3724bfc46b06356e90ee28b3d41c28163508','b01dbb6c03fb1840ab345c0aabf5d153bde13222fdbbd8ab9c654c4fc7a77f8f'],
  'duplicate-ids':['407bb18db72b218ceb0cae85b17b761af4c404e8b96ec40cd0c00f0ee03831ab','3f0459bdc25e9b6af23d17d6a9f6753031431f7ed5d7d11abaf4d575348b665b'],
  'nonfinite-rows-and-missing':['10a19141643427412dffc31e56aef3031583a09d8231554976da685b7945f262','f0478cd0ddf543d24ccc0149316524be081b0943c5ea55d673fe251d778cad27'],
}
function direct(name,ids,unusual=false) {
  const nodes=ids.map(id=>({id})),placed=new Map(ids.map((id,i)=>[id,{x:i*240,y:unusual?[0,-0,NaN,NaN,Infinity,Infinity,-Infinity,-Infinity,0,1][i]:0}])),sizes=new Map(ids.map((id,i)=>[id,{w:i%2?218:170,h:100}]))
  if(unusual){placed.delete('absent');sizes.delete('zero')}
  const rowIds=new Map()
  for(const node of nodes){const p=placed.get(node.id);if(!p)continue;const list=rowIds.get(p.y)||[];list.push(node.id);rowIds.set(p.y,list)}
  const stats=telemetry(),helper=runInNewContext(instrument(localBlock(bundle).text)+'; slotFree',{nodes,placed,sizes,rowIds,localGap:22,...stats}),outcomes=[]
  const untouched=JSON.stringify({nodes,placed:[...placed],sizes:[...sizes],rowIds:[...rowIds]})
  for(const id of ids)for(const x of [-Infinity,-240,-22,0,22,23.9999,24,24.0001,240,480,Infinity,NaN])outcomes.push([number(id),number(x),helper(id,x)])
  assert.equal(JSON.stringify({nodes,placed:[...placed],sizes:[...sizes],rowIds:[...rowIds]}),untouched)
  // A previous local move or measurement must be visible to every later test.
  for(const p of placed.values())p.x-=480
  for(const size of sizes.values())size.w+=100
  for(const id of ids)for(const x of [-240,0,240])outcomes.push([number(id),x,helper(id,x)])
  const state=digest(outcomes),trace=stats.trace.digest('hex')
  if(!capture){assert(directFrozen[name],name);assert.equal(state,directFrozen[name][0]);assert.equal(trace,directFrozen[name][1])}
  console.log(JSON.stringify({baseline:revision||'current',direct:name,result:state,comparisonTrace:trace,...stats.work}))
}
direct('strict-gap-and-live-x',['a','b','c','d'])
direct('mixed-falsey-and-nan-ids',[0,'',1,'1',null,undefined,NaN])
direct('duplicate-ids',['a','b','a','c'])
direct('nonfinite-rows-and-missing',['zero','negative-zero','nan','nan-peer','positive','positive-peer','negative','negative-peer','absent','off'],true)
const mixed={nodes:[0,'',1,'1','hub','leaf',2].map(id=>({id,text:'Node '+id,type:'fact'})),
  edges:[0,'',1,'1','leaf',2].map(fromNodeId=>({fromNodeId,toNodeId:'hub',relation:'analogy'})),sizes:new Map([0,'',1,'1','hub','leaf',2].map(id=>[id,{w:210,h:190}]))}
const workerSource=engine(false).graphLayoutWorkerSource()
for(const [name,data] of [['tree-small',fixture(40,'tree')],['mixed-local',fixture(32,'multi')],['mixed-ids',mixed]]) {
  const run=engine(),progress=[],untouched=JSON.stringify({...data,sizes:[...data.sizes]})
  const result=snapshot(run.layoutGraph(data.nodes,data.edges,data.sizes,'layered',p=>progress.push(p)),progress,data.nodes)
  if(name!=='mixed-ids')assert(run.work.slotChecks>0,name+' must exercise local placement')
  assert.equal(JSON.stringify({...data,sizes:[...data.sizes]}),untouched)
  const worker=new Worker('const {parentPort,workerData}=require("node:worker_threads"); require("node:vm").runInNewContext(workerData.source+"; self.onmessage({data:input})",{self:{postMessage:data=>parentPort.postMessage(data)},input:workerData.input,setTimeout,clearTimeout,setInterval,clearInterval});',
    {eval:true,workerData:{source:workerSource,input:{...data,mode:'layered'}}})
  const remoteProgress=[]
  const remote=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',message=>{
    if(message.progress)remoteProgress.push(message.progress)
    else worker.terminate().then(()=>message.error?reject(new Error(message.error)):resolve(message.layout),reject)
  })})
  let last=-1
  for(const event of remoteProgress){const index=progress.findIndex((p,i)=>i>last&&JSON.stringify(p)===JSON.stringify(event));assert(index>last);last=index}
  assert.equal(JSON.stringify(remoteProgress.at(-1)),JSON.stringify(progress.at(-1)))
  assert.equal(digest(snapshot(remote,progress,data.nodes,false)),digest(result),name+' actual worker')
  assert.throws(()=>run.layoutGraph(data.nodes,data.edges,data.sizes,'layered',()=>{throw new Error('cancel fixture')}),/cancel fixture/)
}
const changing=fixture(32,'tree'),reused=engine()
reused.layoutGraph(changing.nodes,changing.edges,changing.sizes,'layered')
const revisedEdges=changing.nodes.slice(1).map(node=>({fromNodeId:node.id,toNodeId:'n0',relation:'defines'})),revisedSizes=new Map(changing.nodes.map(node=>[node.id,{w:320,h:270}]))
const later=reused.layoutGraph(changing.nodes,revisedEdges,revisedSizes,'layered'),fresh=engine().layoutGraph(changing.nodes,revisedEdges,revisedSizes,'layered')
assert.equal(digest(snapshot(later,[],changing.nodes)),digest(snapshot(fresh,[],changing.nodes)))
console.log(JSON.stringify({baseline:revision||'current',controls:{fullCoordinatesAndComponentMetadata:true,canonicalSharedMemberIdentity:true,readonlyInputs:true,
  originalPeerOrderAndShortCircuit:true,everyImmediateMove:true,existingRowPreparationCounted:true,mixedNumericStringAndFalseyIds:true,duplicateIds:true,
  strictRowEqualityAndNonfiniteFallback:true,livePositionsAndMeasurements:true,newTopologyAndMeasurements:true,actualWorkerAndThrottledProgress:true,cancellationPropagates:true}}))
