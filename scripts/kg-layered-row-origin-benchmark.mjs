// Count the actual row repack, including preparation and origin guards.
// node scripts/kg-layered-row-origin-benchmark.mjs [--smoke]
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'
import { rowRepackReference } from './fixtures/kg-layered-row-repack-reference.mjs'
const smoke=process.argv.includes('--smoke'),viewer=readFileSync(new URL('../extension/viewer.js',import.meta.url),'utf8')
const start=viewer.indexOf('        const rowIds = new Map()'),end=viewer.indexOf('        // Strong local semantic relations',start)
assert(start>=0&&end>start)
const current=viewer.slice(start,end),reference=rowRepackReference.toString().slice(rowRepackReference.toString().indexOf('{')+1,rowRepackReference.toString().lastIndexOf('return rowIds')).replace('if (onChoice) onChoice(id, chosen)','')
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function counted(block){
 return block.replace('for (const ids of rowIds.values()) {','for (const ids of rowIds.values()) { work.rows++;')
  .replace('for (const id of anchors) {','for (const id of anchors) { work.anchors++;')
  .replace('for (const id of others) {','for (const id of others) { work.others++;')
  .replaceAll('occupied.push({','work.slotObjects++; occupied.push({')
  .replaceAll('occupied.sort((a, b) => a.left - b.left)','work.slotSorts++; occupied.sort((a,b)=>{work.slotComparisons++;return a.left-b.left})')
  .replace('const candidates = [preferred]','work.candidateArrays++;work.candidateValues++;const candidates=[preferred]')
  .replaceAll('candidates.push(','work.candidateValues++;candidates.push(')
  .replace('candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b)','work.candidateSorts++;candidates.sort((a,b)=>{work.candidateComparisons++;return Math.abs(a-preferred)-Math.abs(b-preferred)||a-b})')
  .replace('const fits = (x) => occupied.every((slot) => x + half + rowGap <= slot.left || x - half - rowGap >= slot.right)','const fits=x=>{work.fitsCalls++;return occupied.every(slot=>{work.fitVisits++;return x+half+rowGap<=slot.left||x-half-rowGap>=slot.right})}')
  .replace('const probeOrigin = Number.isFinite(preferred) && Number.isFinite(half)','work.originGuards++;const probeOrigin=(work.finiteChecks++,Number.isFinite(preferred))&&(work.finiteChecks++,Number.isFinite(half))')
  .replace('candidates.find((x) => fits(x))','candidates.find(x=>{work.candidateTests++;return fits(x)})')
  .replace('candidates.find((x) => probeOrigin && x === preferred ? false : fits(x))','candidates.find(x=>{work.candidateTests++;if(probeOrigin){work.originEqualityChecks++;if(x===preferred)return false}return fits(x)})')
  .replace('occupied.reduce((max, slot) => Math.max(max, slot.right), preferred)','occupied.reduce((max,slot)=>{work.reduceVisits++;return Math.max(max,slot.right)},preferred)')
  .replace('p.x = chosen','work.choices++;if(chosen===preferred)work.originWins++;trace.push([id,chosen]);p.x=chosen')
  .replace(/\b(placed|sizes|rowIds|backboneLane)\.get\(/g,'readMap($1, ')
}
function telemetry() {
 const keys = ['rows', 'anchors', 'others', 'slotObjects', 'slotSorts', 'slotComparisons',
  'candidateArrays', 'candidateValues', 'candidateSorts', 'candidateComparisons',
  'fitsCalls', 'fitVisits', 'originGuards', 'finiteChecks', 'candidateTests',
  'originEqualityChecks', 'reduceVisits', 'mapReads', 'choices', 'originWins']
 const work = Object.fromEntries(keys.map(key => [key, 0]))
 return { work, trace: [], readMap: (map, id) => { work.mapReads++; return map.get(id) } }
}
function direct(block,measure=false){const stats=telemetry(),fn=new Function('nodes','placed','sizes','backboneLane','work','trace','readMap',(measure?counted(block):block)+';return rowIds');return{...stats,run:data=>fn(data.nodes,data.placed,data.sizes,data.backboneLane,stats.work,stats.trace,stats.readMap)}}
const clone=data=>({...data,placed:new Map([...data.placed].map(([id,p])=>[id,{...p}]))})
let directCases=0,seed=824358
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32}
function compare(data) {
 const expected = clone(data), actual = clone(data), old = direct(reference, true), next = direct(current, true)
 const input = digest({ nodes: data.nodes, sizes: [...data.sizes], lanes: [...data.backboneLane] })
 assert.deepEqual(next.run(actual), old.run(expected))
 assert.deepEqual([...actual.placed], [...expected.placed])
 assert.deepEqual(next.trace, old.trace, 'Every chosen x, including signed zero and non-finite values')
 assert.equal(next.work.originGuards, next.work.others, 'Count every new guard, including failed guards')
 assert.equal(digest({ nodes: data.nodes, sizes: [...data.sizes], lanes: [...data.backboneLane] }), input)
 directCases++
 return { old: old.work, next: next.work, positions: digest([...actual.placed]) }
}
for(let trial=0;trial<160;trial++){
 const ids=trial<40?[0,'',1,'1',null,undefined,NaN,'雪','a','a']:Array.from({length:3+Math.floor(random()*40)},(_,i)=>'n'+i),nodes=ids.map(id=>({id})),placed=new Map(ids.map(id=>[id,{x:Math.round(random()*2000)-1000,y:(Math.floor(random()*4)-1)*240}])),sizes=new Map(ids.map(id=>[id,{w:Math.round(random()*350),h:100}])),backboneLane=new Map(ids.filter(()=>random()<.3).map(id=>[id,Math.round(random()*1000)-500]))
 if(trial%4===0)for(const [i,id] of ids.entries()){placed.get(id).x=[-0,0,NaN,Infinity,-Infinity,0,22,240][i%8];placed.get(id).y=[-0,0,NaN,Infinity,-Infinity][i%5];sizes.get(id).w=[0,-0,-170,NaN,Infinity,-Infinity,'170','bad'][i%8]}
 if(trial%5===0)sizes.delete(ids.at(-1));if(trial%7===0)placed.delete(ids.at(-1));compare({nodes,placed,sizes,backboneLane})
}
// Exact gap, tied alternatives and duplicate preferred coordinates; later
// choices must see earlier moves. Rerun with changed live measurements.
for(const width of [0,96,170,218])for(const gap of [17.9999,18,18.0001]){
 const ids=['anchor','left','right','same','missing'],data={nodes:ids.map(id=>({id})),placed:new Map(ids.map((id,i)=>[id,{x:i===1?-width-gap:i===2?width+gap:0,y:0}])),sizes:new Map(ids.map(id=>[id,{w:width,h:100}])),backboneLane:new Map([['anchor',0]])};compare(data);for(const s of data.sizes.values())s.w+=30;for(const p of data.placed.values())p.x-=40;compare(data)
}
const count=smoke?128:800,ids=Array.from({length:count},(_,i)=>'r'+i),free={nodes:ids.map(id=>({id})),placed:new Map(ids.map((id,i)=>[id,{x:i*240,y:0}])),sizes:new Map(ids.map(id=>[id,{w:170,h:100}])),backboneLane:new Map([['r0',0]])},clear=compare(free)
assert.equal(clear.old.candidateSorts,count-1);assert.equal(clear.next.candidateSorts,0);assert.equal(clear.next.candidateArrays,0);assert.equal(clear.next.candidateValues,0);assert.equal(clear.old.fitVisits,clear.next.fitVisits);assert.equal(clear.old.mapReads,clear.next.mapReads)
for(const width of [340,1000]){const busy={...clone(free),sizes:new Map(ids.map(id=>[id,{w:width,h:100}]))};const r=compare(busy);assert(r.next.fitVisits<=r.old.fitVisits);assert.equal(r.next.slotSorts,r.old.slotSorts)}
function engine(block,measure=true){const stats=telemetry(),environment={window:{React:{}},console,setTimeout,clearTimeout,setInterval,clearInterval,...stats};runInNewContext((viewer.slice(0,start)+(measure?counted(block):block)+viewer.slice(end)).replace('window.KGViewer = {','window.KGViewer = {layoutLayered,graphLayoutWorkerSource,'),environment);return{...environment.window.KGViewer,...stats}}
function fixture(n,shape){const nodes=Array.from({length:n},(_,i)=>({id:'n'+i,text:'Node '+i,type:i%3?'fact':'claim'})),edges=[];for(let i=1;i<n;i++){if(shape==='groups'&&i%8===0)continue;edges.push({fromNodeId:'n'+(shape==='wide'?0:shape==='groups'?i-i%8:shape==='chain'?i-1:Math.floor((i-1)/3)),toNodeId:'n'+i,relation:i%5===0?'causes':'supports'})}for(let i=1;i<Math.min(n,shape==='long-lanes'?Math.floor(n*.3):5);i++)edges.push({fromNodeId:'n'+(i-1),toNodeId:'n'+i,relation:'infers'});return{nodes,edges,sizes:new Map(nodes.map((n,i)=>[n.id,{w:[96,150,208,218][i%4],h:[60,100,180,260][i%4]}]))}}
function snapshot(layout,progress){return{pos:[...layout.pos],keys:[...layout.componentKeyById],members:[...layout.componentNodesById].map(([id,group])=>[id,group.map(n=>n.id)]),progress}}
const full=[]
for(const shape of ['wide','tree','chain','groups','long-lanes']){
 const data=fixture(smoke?80:800,shape),old=engine(reference),next=engine(current),a=[],b=[],before=digest({...data,sizes:[...data.sizes]})
 const expected=old.layoutGraph(data.nodes,data.edges,data.sizes,'layered',p=>a.push(p)),actual=next.layoutGraph(data.nodes,data.edges,data.sizes,'layered',p=>b.push(p));assert.equal(digest(snapshot(actual,b)),digest(snapshot(expected,a)));assert.deepEqual(Array.from(next.trace,x=>Array.from(x)),Array.from(old.trace,x=>Array.from(x)));assert.equal(digest({...data,sizes:[...data.sizes]}),before)
 for(const id of actual.pos.keys())assert.equal(actual.componentNodesById.get(id).find(n=>n.id===id),data.nodes.find(n=>n.id===id),'Canonical node identity')
 assert.equal(next.work.mapReads,old.work.mapReads);assert.equal(next.work.slotObjects,old.work.slotObjects);assert.equal(next.work.slotSorts,old.work.slotSorts);assert.equal(next.work.originGuards,next.work.others);assert(next.work.fitVisits<=old.work.fitVisits)
 full.push({shape,nodes:data.nodes.length,old:old.work,next:next.work,result:digest(snapshot(actual,b)),movementTrace:digest(next.trace)})
}
const data=fixture(40,'tree'),old=engine(reference,false),next=engine(current,false),progress=[],expected=next.layoutGraph(data.nodes,data.edges,data.sizes,'layered',p=>progress.push(p)),worker=new Worker('const {parentPort,workerData}=require("node:worker_threads");require("node:vm").runInNewContext(workerData.source+";self.onmessage({data:input})",{self:{postMessage:data=>parentPort.postMessage(data)},input:workerData.input,setTimeout,clearTimeout,setInterval,clearInterval});',{eval:true,workerData:{source:next.graphLayoutWorkerSource(),input:{...data,mode:'layered'}}}),remoteProgress=[]
const remote=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',m=>{if(m.progress)remoteProgress.push(m.progress);else worker.terminate().then(()=>m.error?reject(new Error(m.error)):resolve(m.layout),reject)})})
assert.equal(digest(snapshot(remote,[])),digest(snapshot(expected,[])))
assert.equal(JSON.stringify(remoteProgress.at(-1)),JSON.stringify(progress.at(-1)))
// Worker progress is throttled; every emitted update must occur in native order.
let cursor = 0
for (const update of remoteProgress) {
 while (cursor < progress.length && JSON.stringify(update) !== JSON.stringify(progress[cursor])) cursor++
 assert(cursor < progress.length, 'Worker progress must be a subsequence of native progress')
 cursor++
}
assert.throws(()=>next.layoutGraph(data.nodes,data.edges,data.sizes,'layered',()=>{throw Error('cancel fixture')}),/cancel fixture/)
for(const mode of ['overview','radial','circular','force','neighborhood']){const a=old.layoutGraph(data.nodes,data.edges,data.sizes,mode),b=next.layoutGraph(data.nodes,data.edges,data.sizes,mode);assert.equal(JSON.stringify([...a.pos]),JSON.stringify([...b.pos]))}
for(const path of ['src/index.client.js','lib/client.js'])assert(readFileSync(new URL('../'+path,import.meta.url),'utf8').includes(current),'Generated row repack parity: '+path)
console.log(JSON.stringify({ok:true,directCases,clearRow:{nodes:count,...clear},full,actualWorker:true,cancellation:true,otherModesUnchanged:true,readonlyInputs:true,allChosenPositionsAndMetadataEqual:true,strictGapAndNonfiniteParity:true,scope:'Actual row repack only; includes origin guards and preparation. Counts do not imply full-layout timing or memory savings.'}))
