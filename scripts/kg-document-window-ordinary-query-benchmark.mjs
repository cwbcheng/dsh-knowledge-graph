// Optional: node scripts/kg-document-window-ordinary-query-benchmark.mjs [baseline-revision]
// Identical complete Store windows; prepared matching SQL is a separate scope.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {openSqliteStore,SqliteKnowledgeStore} from '../src/kg-store.mjs'
import {baselineModules} from './kg-document-window-diagnostics-benchmark.mjs'
import {literalWindowFixture,countWindowQueryWork,isWindowQuerySql,isWindowQueryFoldSql,assertWindowQueryCallParity} from './kg-document-window-query-benchmark.mjs'
import {isWindowIncidentSql,isWindowIncidentProbeSql} from './kg-document-window-incident-benchmark.mjs'
import {isWindowEdgeSql,isWindowEdgeProbeSql,assertWindowEdgeCallParity} from './kg-document-window-edge-reads.mjs'

export function ordinaryWindowFixture(size,documentId){
  const fixture=literalWindowFixture(size,documentId)
  for(const node of fixture.graph.nodes.slice(0,200))node.text+=' windowexact'
  for(const node of fixture.graph.nodes.slice(400,599))node.text+=' windowunder'
  return fixture
}
function capture(store,id,options){
  const prepare=store.db.prepare,calls=[]
  store.db.prepare=function(sql){const statement=prepare.call(this,sql)
    for(const method of['get','all']){const execute=statement[method];statement[method]=function(...params){
      const value=execute.apply(this,params);calls.push({sql,method,params,value});return value}}
    return statement}
  try{return{window:store.getDocumentWindow(id,options),calls}}finally{store.db.prepare=prepare}
}
const median=values=>[...values].sort((a,b)=>a-b)[4]
function timePair(runs){for(let i=0;i<3;i++){runs[0]();runs[1]()}const times=[[],[]]
  for(let i=0;i<9;i++)for(const index of i%2?[1,0]:[0,1]){const start=performance.now();runs[index]();times[index].push(performance.now()-start)}
  return{beforeMedianMs:median(times[0]),currentMedianMs:median(times[1])}}
async function benchmark(){
  const validateOnly=process.argv.includes('--validate-only'),args=process.argv.slice(2).filter(arg=>arg!=='--validate-only'),revision=args[0]||'942ca9a'
  if(args.length>1)throw new Error('Expected at most one baseline revision')
  const baseline=(await baselineModules(revision)).store,directory=mkdtempSync(join(tmpdir(),'kg-window-ordinary-query-')),database=join(directory,'graph.sqlite')
  const current=await openSqliteStore(database)
  let previous,meter,oldMeter
  try{
    const fixtures=[]
    for(const size of[12000,96000])for(const quoteChars of[64,1024]){
      const fixture=ordinaryWindowFixture(size,'ordinary-benchmark-'+size+'-'+quoteChars)
      for(const node of fixture.graph.nodes)node.quote+='x'.repeat(quoteChars)
      current.saveGraph(fixture.graph,{sourceText:fixture.sourceText,sourceUnits:fixture.sourceUnits})
      fixtures.push({size,quoteChars,id:fixture.documentId})
    }
    previous=await baseline.openSqliteStore(database)
    meter=countWindowQueryWork(SqliteKnowledgeStore,database);oldMeter=countWindowQueryWork(baseline.SqliteKnowledgeStore,database)
    const samples=[]
    for(const fixture of fixtures)for(const [query,limit]of[
      ...[200,800].flatMap(limit=>['node17','observation 11999.','not-in-this-source','windowexact','windowunder','fact','source','%_','first-page'].map(query=>[query,limit])),
      ['observation 11',2000]]){
      const options={limit,includeSourceText:false,...(query==='first-page'?{}:{query})}
      meter.reset();oldMeter.reset()
      const before=capture(previous,fixture.id,options),after=capture(current,fixture.id,options)
      assert.deepEqual(after.window,before.window)
      assertWindowEdgeCallParity(before.calls,after.calls)
      const unrelated=call=>!isWindowQuerySql(call.sql)&&!isWindowQueryFoldSql(call.sql)&&!isWindowIncidentSql(call.sql)&&!isWindowIncidentProbeSql(call.sql)&&!isWindowEdgeSql(call.sql)&&!isWindowEdgeProbeSql(call.sql)
      assert.deepEqual(after.calls.filter(unrelated),before.calls.filter(unrelated))
      const incidents=capture=>capture.calls.filter(call=>isWindowIncidentSql(call.sql)).map(call=>{
        const length=(call.params.length-(call.sql.includes('UNION SELECT rowid')?3:2))/2
        return{ids:call.params.slice(1,length+1),remaining:call.params.at(-1),rows:call.value}})
      assert.deepEqual(incidents(after),incidents(before))
      const oldCalls=before.calls.filter(call=>isWindowQuerySql(call.sql)),nextCalls=after.calls.filter(call=>isWindowQuerySql(call.sql))
      const direct=oldCalls.find(call=>call.method==='all'),count=oldCalls.find(call=>call.method==='get')
      if(direct){
        assert(direct.value.length<=limit)
        const matched=after.window.view.matchedNodes,counted=matched>=limit
        assert.equal(direct.value.length,Math.min(matched,limit))
        assertWindowQueryCallParity(before.calls,after.calls,after.window)
        assert.equal(meter.counts.matchCountReads,counted?1:0)
        assert.equal(meter.counts.directRows,direct.value.length)
        assert.equal(meter.counts.matched,matched)
        if(!/[%_]/.test(query))assert.equal(oldMeter.counts.matchCountReads,1)
        else assertWindowQueryCallParity(before.calls,after.calls,after.window)
      }else{assert.deepEqual(nextCalls,[]);assert.equal(meter.counts.queries,0)}
      samples.push({...fixture,query,limit,options,before,after,beforeWork:{...oldMeter.counts},currentWork:{...meter.counts}})
    }
    meter.stop();meter=null;oldMeter.stop();oldMeter=null
    if(validateOnly){console.log(JSON.stringify({ok:true,baseline:revision,cases:samples.length,validationOnly:true}));return}
    const results=[]
    for(const sample of samples){
      const whole=timePair([()=>previous.getDocumentWindow(sample.id,sample.options),()=>current.getDocumentWindow(sample.id,sample.options)])
      const stages=[sample.before,sample.after].map((capture,index)=>capture.calls.filter(call=>isWindowQuerySql(call.sql)||isWindowQueryFoldSql(call.sql))
        .map(call=>({...call,statement:[previous,current][index].db.prepare(call.sql)})))
      const matching=stages[0].length?timePair(stages.map(calls=>()=>{for(const call of calls)call.statement[call.method](...call.params)})):null
      results.push({nodes:sample.size,quoteChars:sample.quoteChars,query:sample.query,limit:sample.limit,matched:sample.after.window.view.matchedNodes,
        returnedNodes:sample.after.window.nodes.length,beforeWork:sample.beforeWork,currentWork:sample.currentWork,whole,matching})
    }
    console.log(JSON.stringify({ok:true,baseline:revision,cases:results.length,repeats:9,samples:results,
      scope:'Identical complete production Store windows and complete Native incident batches; only six connection-guarded LOWER/CAST LIKE coercions may differ, with identical params/complete Native direct records and counts; ordinary COUNT omitted only on underfilled direct rows; literal query sequence unchanged; later window boolean/direct-IN membership verified separately with identical SQL bytes otherwise, selected-ID/budget params and complete Native edges; all remaining SQL, parameters, Native values and order identical; prepared matching guard/get plus COUNT/get and direct SELECT/all measured separately; historical baselines include later incident/window changes, use the original measured revision to isolate matching savings; Native instrumentation outside timing; excludes inspector, HTTP, rendering and CI timing gates'}))
  }finally{meter?.stop();oldMeter?.stop();previous?.close();current.close();rmSync(directory,{recursive:true,force:true})}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await benchmark()
