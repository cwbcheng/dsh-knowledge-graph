// Optional: node scripts/kg-document-window-incident-benchmark.mjs [baseline-revision]
// Time identical complete Store windows and prepared incident stages separately.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {openSqliteStore,SqliteKnowledgeStore} from '../src/kg-store.mjs'
import {baselineModules} from './kg-document-window-diagnostics-benchmark.mjs'
import {literalWindowFixture,isWindowQuerySql,assertWindowQueryCallParity} from './kg-document-window-query-benchmark.mjs'

export const isWindowIncidentSql=sql=>sql.startsWith('SELECT * FROM graph_edges')&&sql.includes('from_node_id IN (')&&sql.includes('to_node_id IN (')&&!sql.includes('json_each')
export const isWindowIncidentProbeSql=sql=>sql.startsWith('SELECT COUNT(*) AS count FROM (')&&sql.includes('SELECT 1 FROM graph_edges')
export function countWindowIncidentWork(Store,database){
  const original=Store.prototype.getDocumentWindow
  const counts={probes:0,probeCandidates:0,maxProbeCandidates:0,indexedReads:0,fallbackReads:0,incidentRows:0,maxIncidentRows:0}
  Store.prototype.getDocumentWindow=function(...args){
    if(this.filename!==database)return original.apply(this,args)
    const prepare=this.db.prepare
    this.db.prepare=function(sql){const statement=prepare.call(this,sql)
      if(isWindowIncidentProbeSql(sql)){const get=statement.get;statement.get=function(...params){const value=get.apply(this,params)
        counts.probes++;counts.probeCandidates+=value.count;counts.maxProbeCandidates=Math.max(counts.maxProbeCandidates,value.count);return value}}
      if(isWindowIncidentSql(sql)){const all=statement.all;statement.all=function(...params){const rows=all.apply(this,params)
        counts[sql.includes('UNION SELECT rowid')?'indexedReads':'fallbackReads']++;counts.incidentRows+=rows.length
        counts.maxIncidentRows=Math.max(counts.maxIncidentRows,rows.length);return rows}}
      return statement
    }
    try{return original.apply(this,args)}finally{this.db.prepare=prepare}
  }
  return{counts,reset(){for(const key of Object.keys(counts))counts[key]=0},stop(){Store.prototype.getDocumentWindow=original}}
}
export function incidentShapeFixture(shape,size,documentId){
  const fixture=literalWindowFixture(size,documentId),nodes=fixture.graph.nodes
  if(shape==='outside'){
    fixture.graph.edges=[]
    for(let i=0;i<200;i++)for(let j=2000;j<3000;j++)fixture.graph.edges.push({fromNodeId:nodes[i].id,toNodeId:nodes[j].id,relation:'supports'})
  }else if(shape==='dense'){
    fixture.graph.edges=[]
    for(let i=0;i<200;i++)for(let j=0;j<200;j++)if(i!==j)for(const relation of['supports','relates_to'])
      fixture.graph.edges.push({fromNodeId:nodes[i].id,toNodeId:nodes[j].id,relation,custom:{retained:'x'.repeat(512)}})
  }else if(shape==='hub'){
    fixture.graph.edges=[]
    for(let i=1;i<size;i++)for(const relation of['supports','relates_to'])
      fixture.graph.edges.push({fromNodeId:nodes[0].id,toNodeId:nodes[i].id,relation},{fromNodeId:nodes[i].id,toNodeId:nodes[0].id,relation})
  }else if(shape==='batch')for(const node of nodes.slice(0,420))node.text+=' common_%'
  return fixture
}
function capture(store,id,options){
  const prepare=store.db.prepare,calls=[],incident=[]
  store.db.prepare=function(sql){const statement=prepare.call(this,sql)
    for(const method of['get','all']){const execute=statement[method];statement[method]=function(...params){const value=execute.apply(this,params)
      calls.push({sql,method,params});if(isWindowIncidentSql(sql))incident.push({sql,params,rows:value});return value}}
    return statement
  }
  try{return{window:store.getDocumentWindow(id,options),calls,incident}}finally{store.db.prepare=prepare}
}
const median=values=>[...values].sort((a,b)=>a-b)[4]
function timePair(runs){
  for(let i=0;i<3;i++){runs[0]();runs[1]()}
  const times=[[],[]]
  for(let i=0;i<9;i++)for(const index of i%2?[1,0]:[0,1]){const start=performance.now();runs[index]();times[index].push(performance.now()-start)}
  return{beforeMedianMs:median(times[0]),currentMedianMs:median(times[1])}
}
async function benchmark(){
  const validateOnly=process.argv.includes('--validate-only'),args=process.argv.slice(2).filter(arg=>arg!=='--validate-only')
  const revision=args[0]||'71d5102'
  if(args.length>1)throw new Error('Expected at most one baseline revision')
  const baseline=(await baselineModules(revision)).store,directory=mkdtempSync(join(tmpdir(),'kg-window-incident-benchmark-')),database=join(directory,'graph.sqlite')
  const current=await openSqliteStore(database)
  let previous,meter,oldMeter
  try{
    const fixtures=[]
    for(const size of[12000,96000])for(const quoteChars of[64,1024]){
      const fixture=incidentShapeFixture('chain',size,'incident-chain-'+size+'-'+quoteChars)
      for(const node of fixture.graph.nodes)node.quote+='x'.repeat(quoteChars)
      current.saveGraph(fixture.graph,{sourceText:fixture.sourceText,sourceUnits:fixture.sourceUnits})
      fixtures.push({shape:'chain',size,quoteChars,documentId:fixture.documentId})
    }
    for(const [shape,size]of[['outside',12000],['dense',800],['hub',12000],['small',64],['batch',12000]]){
      const fixture=incidentShapeFixture(shape,size,'incident-'+shape)
      current.saveGraph(fixture.graph,{sourceText:fixture.sourceText,sourceUnits:fixture.sourceUnits})
      fixtures.push({shape,size,quoteChars:0,documentId:fixture.documentId})
    }
    previous=await baseline.openSqliteStore(database)
    meter=countWindowIncidentWork(SqliteKnowledgeStore,database);oldMeter=countWindowIncidentWork(baseline.SqliteKnowledgeStore,database)
    const samples=[]
    for(const fixture of fixtures)for(const limit of fixture.shape==='chain'?[200,800]:[20,800,2000])for(const kind of fixture.shape==='chain'
      ?['node_17','%_','observation 11999.','100%','absent_%','first-page','last-page']
      :fixture.shape==='batch'?['common_%','node_17','first-page']:['node_17','n'+Math.floor(fixture.size/2),'first-page']){
      const options={limit,includeSourceText:false,...(kind==='first-page'?{}:kind==='last-page'?{offset:fixture.size-limit}:{query:kind})}
      meter.reset();oldMeter.reset()
      const before=capture(previous,fixture.documentId,options),after=capture(current,fixture.documentId,options)
      assert.deepEqual(after.window,before.window);assert.equal(after.incident.length,before.incident.length)
      assert.equal(meter.counts.incidentRows,oldMeter.counts.incidentRows);assert(meter.counts.maxProbeCandidates<=2049)
      assertWindowQueryCallParity(before.calls,after.calls,after.window)
      const unrelated=call=>!isWindowIncidentSql(call.sql)&&!isWindowIncidentProbeSql(call.sql)&&!isWindowQuerySql(call.sql)
      assert.deepEqual(after.calls.filter(unrelated),before.calls.filter(unrelated))
      for(let i=0;i<after.incident.length;i++)assert.deepEqual(after.incident[i].rows,before.incident[i].rows)
      samples.push({...fixture,kind,limit,options,before,after,beforeWork:{...oldMeter.counts},currentWork:{...meter.counts}})
    }
    meter.stop();meter=null;oldMeter.stop();oldMeter=null
    if(validateOnly){console.log(JSON.stringify({ok:true,baseline:revision,cases:samples.length,validationOnly:true}));return}
    const results=[]
    for(const sample of samples){
      const whole=timePair([()=>previous.getDocumentWindow(sample.documentId,sample.options),()=>current.getDocumentWindow(sample.documentId,sample.options)])
      const stages=[sample.before,sample.after].map((capture,index)=>capture.calls.filter(call=>isWindowIncidentSql(call.sql)||isWindowIncidentProbeSql(call.sql))
        .map(call=>({...call,statement:[previous,current][index].db.prepare(call.sql)})))
      const incident=stages[0].length?timePair(stages.map(calls=>()=>{for(const call of calls)call.statement[call.method](...call.params)})):null
      results.push({nodes:sample.size,shape:sample.shape,quoteChars:sample.quoteChars,kind:sample.kind,limit:sample.limit,returnedNodes:sample.after.window.nodes.length,
        beforeWork:sample.beforeWork,currentWork:sample.currentWork,whole,incident})
    }
    console.log(JSON.stringify({ok:true,baseline:revision,cases:results.length,repeats:9,samples:results,
      scope:'Identical complete production Store windows; actual prepared aggregate-probe/get plus selected incident SELECT/all measured separately; matching predicate/params parity allows later direct-first COUNT omission; all other SQL equality and Native counts outside timing; historical baselines include later Store changes, use the original measured revision to isolate incident savings; no inspector, HTTP, rendering or CI timing gate'}))
  }finally{meter?.stop();oldMeter?.stop();previous?.close();current.close();rmSync(directory,{recursive:true,force:true})}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await benchmark()
