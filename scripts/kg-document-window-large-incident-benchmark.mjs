// Optional: node scripts/kg-document-window-large-incident-benchmark.mjs [baseline-revision] [--validate-only]
// Compare identical complete Store windows; probe/incident SQL is a separate scope.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {openSqliteStore,SqliteKnowledgeStore} from '../src/kg-store.mjs'
import {baselineModules} from './kg-document-window-diagnostics-benchmark.mjs'
import {ordinaryWindowFixture} from './kg-document-window-ordinary-query-benchmark.mjs'
import {incidentShapeFixture,isWindowIncidentSql,isWindowIncidentProbeSql,countWindowIncidentWork} from './kg-document-window-incident-benchmark.mjs'
import {isWindowEdgeSql,isWindowEdgeProbeSql,assertWindowEdgeCallParity} from './kg-document-window-edge-reads.mjs'

function capture(store,id,options){
  const prepare=store.db.prepare,calls=[],incident=[]
  store.db.prepare=function(sql){const statement=prepare.call(this,sql)
    for(const method of['get','all']){const execute=statement[method];statement[method]=function(...params){
      const value=execute.apply(this,params);calls.push({sql,method,params,value})
      if(isWindowIncidentSql(sql)){
        const length=(params.length-(sql.includes('UNION SELECT rowid')?3:2))/2
        incident.push({ids:params.slice(1,length+1),remaining:params.at(-1),rows:value})
      }
      return value}}
    return statement}
  try{return{window:store.getDocumentWindow(id,options),calls,incident}}finally{store.db.prepare=prepare}
}
const median=values=>[...values].sort((a,b)=>a-b)[4]
function timePair(runs){for(let i=0;i<3;i++){runs[0]();runs[1]()}const times=[[],[]]
  for(let i=0;i<9;i++)for(const index of i%2?[1,0]:[0,1]){const start=performance.now();runs[index]();times[index].push(performance.now()-start)}
  return{beforeMedianMs:median(times[0]),currentMedianMs:median(times[1])}}
async function benchmark(){
  const validateOnly=process.argv.includes('--validate-only'),args=process.argv.slice(2).filter(arg=>arg!=='--validate-only'),revision=args[0]||'d7bcc43'
  if(args.length>1)throw new Error('Expected at most one baseline revision')
  const baseline=(await baselineModules(revision)).store,directory=mkdtempSync(join(tmpdir(),'kg-window-large-incident-')),database=join(directory,'graph.sqlite')
  const current=await openSqliteStore(database)
  let previous,meter,oldMeter
  try{
    const fixtures=[]
    for(const [shape,size,quoteChars]of[
      ...[12000,96000].flatMap(size=>[64,1024].map(quoteChars=>['chain',size,quoteChars])),
      ['outside',12000,0],['dense',800,0],['hub',12000,0],['small',64,0]]){
      const id='large-incident-'+shape+'-'+size+'-'+quoteChars
      const fixture=shape==='chain'?ordinaryWindowFixture(size,id):incidentShapeFixture(shape,size,id)
      for(const node of fixture.graph.nodes.slice(0,65))node.text+=' batchfirst65'
      for(const node of fixture.graph.nodes.slice(600,665))node.text+=' batchmiddle65'
      if(shape!=='chain')for(const node of fixture.graph.nodes.slice(0,200))node.text+=' windowexact'
      for(const node of fixture.graph.nodes)node.quote+='x'.repeat(quoteChars)
      current.saveGraph(fixture.graph,{sourceText:fixture.sourceText,sourceUnits:fixture.sourceUnits})
      fixtures.push({shape,size,quoteChars,id})
    }
    previous=await baseline.openSqliteStore(database)
    meter=countWindowIncidentWork(SqliteKnowledgeStore,database);oldMeter=countWindowIncidentWork(baseline.SqliteKnowledgeStore,database)
    const samples=[]
    for(const fixture of fixtures)for(const [kind,limit]of fixture.shape==='chain'?[
      ['batchfirst65',800],['batchmiddle65',800],['windowunder',200],['windowunder',800],['windowexact',200],['windowexact',800],
      ['observation 11',2000],['node_17',800],['%_',800],['absent_%',800],['first-page',800],['last-page',800]]:[
      ['batchfirst65',800],['batchfirst65',2000],['batchmiddle65',800],['windowexact',800],['windowexact',2000],['node_17',20],['first-page',800]]){
      const options={limit,includeSourceText:false,...(kind==='first-page'?{}:kind==='last-page'?{offset:fixture.size-limit}:{query:kind})}
      meter.reset();oldMeter.reset()
      const before=capture(previous,fixture.id,options),after=capture(current,fixture.id,options)
      assert.deepEqual(after.window,before.window);assert.deepEqual(after.incident,before.incident)
      assertWindowEdgeCallParity(before.calls,after.calls)
      const unrelated=call=>!isWindowIncidentSql(call.sql)&&!isWindowIncidentProbeSql(call.sql)&&!isWindowEdgeSql(call.sql)&&!isWindowEdgeProbeSql(call.sql)
      assert.deepEqual(after.calls.filter(unrelated),before.calls.filter(unrelated))
      assert.equal(meter.counts.incidentRows,oldMeter.counts.incidentRows);assert(meter.counts.maxProbeCandidates<=2049)
      if(fixture.shape==='small')assert.equal(meter.counts.probes,0)
      for(const call of after.calls.filter(call=>isWindowIncidentProbeSql(call.sql)))assert(call.value.count<=call.params.at(-1))
      samples.push({...fixture,kind,limit,options,before,after,beforeWork:{...oldMeter.counts},currentWork:{...meter.counts}})
    }
    meter.stop();meter=null;oldMeter.stop();oldMeter=null
    if(validateOnly){console.log(JSON.stringify({ok:true,baseline:revision,cases:samples.length,validationOnly:true}));return}
    const results=[]
    for(const sample of samples){
      const whole=timePair([()=>previous.getDocumentWindow(sample.id,sample.options),()=>current.getDocumentWindow(sample.id,sample.options)])
      const stages=[sample.before,sample.after].map((capture,index)=>capture.calls.filter(call=>isWindowIncidentSql(call.sql)||isWindowIncidentProbeSql(call.sql))
        .map(call=>({...call,statement:[previous,current][index].db.prepare(call.sql)})))
      const incident=stages[0].length?timePair(stages.map(calls=>()=>{for(const call of calls)call.statement[call.method](...call.params)})):null
      results.push({nodes:sample.size,shape:sample.shape,quoteChars:sample.quoteChars,kind:sample.kind,limit:sample.limit,
        matched:sample.after.window.view.matchedNodes,returnedNodes:sample.after.window.nodes.length,
        beforeWork:sample.beforeWork,currentWork:sample.currentWork,whole,incident})
    }
    console.log(JSON.stringify({ok:true,baseline:revision,cases:results.length,repeats:9,samples:results,
      scope:'Identical complete production Store windows, complete Native incident batches, remaining budgets, deduplication and ordering; later window boolean/direct-IN membership verified separately with identical SQL bytes otherwise, selected-ID/budget params and complete Native edges; all remaining SQL, parameters, Native values and sequence identical; actual prepared aggregate probe plus selected incident reads timed separately; historical baselines include later window changes, use the original measured revision to isolate incident savings; counters and equivalence checks outside timing; excludes inspector, HTTP, rendering and CI timing gates'}))
  }finally{meter?.stop();oldMeter?.stop();previous?.close();current.close();rmSync(directory,{recursive:true,force:true})}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await benchmark()
