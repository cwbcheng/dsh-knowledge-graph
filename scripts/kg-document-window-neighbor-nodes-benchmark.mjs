// Optional: node scripts/kg-document-window-neighbor-nodes-benchmark.mjs [baseline-revision]
// Complete store windows and prepared neighbor lookups are timed separately.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {openSqliteStore,SqliteKnowledgeStore} from '../src/kg-store.mjs'
import {baselineModules} from './kg-document-window-diagnostics-benchmark.mjs'
import {literalWindowFixture} from './kg-document-window-query-benchmark.mjs'

export const isNeighborNodeSql=sql=>sql.startsWith('SELECT * FROM graph_nodes')&&sql.includes('node_id IN (')&&!sql.includes('OFFSET')
export function countWindowNeighborNodes(Store,database){
  const original=Store.prototype.getDocumentWindow
  const counts={lookups:0,candidateIds:0,rows:0,maxRows:0}
  Store.prototype.getDocumentWindow=function(...args){
    if(this.filename!==database)return original.apply(this,args)
    const prepare=this.db.prepare
    this.db.prepare=function(sql){const statement=prepare.call(this,sql)
      if(isNeighborNodeSql(sql)){const all=statement.all;statement.all=function(...params){const rows=all.apply(this,params)
        counts.lookups++;counts.candidateIds+=params.length-1;counts.rows+=rows.length;counts.maxRows=Math.max(counts.maxRows,rows.length)
        return rows}}
      return statement
    }
    try{return original.apply(this,args)}finally{this.db.prepare=prepare}
  }
  return{counts,reset(){for(const key of Object.keys(counts))counts[key]=0},stop(){Store.prototype.getDocumentWindow=original}}
}
function capture(store,id,options){
  const prepare=store.db.prepare,calls=[],neighbors=[]
  store.db.prepare=function(sql){const statement=prepare.call(this,sql)
    for(const method of['get','all']){const execute=statement[method];statement[method]=function(...params){
      const rows=execute.apply(this,params);calls.push({sql,method,params})
      if(isNeighborNodeSql(sql))neighbors.push({sql,params,rows})
      return rows
    }}return statement
  }
  try{return{window:store.getDocumentWindow(id,options),calls,neighbors}}finally{store.db.prepare=prepare}
}
const median=values=>[...values].sort((a,b)=>a-b)[4]
function timePair(runs){
  for(let i=0;i<3;i++){runs[0]();runs[1]()}
  const times=[[],[]]
  for(let i=0;i<9;i++)for(const index of i%2?[1,0]:[0,1]){const start=performance.now();runs[index]();times[index].push(performance.now()-start)}
  return{beforeMedianMs:median(times[0]),currentMedianMs:median(times[1])}
}
async function benchmark(){
  const revision=process.argv[2]||'567f1b0'
  if(process.argv.length>3)throw new Error('Expected at most one baseline revision')
  const baseline=(await baselineModules(revision)).store
  const directory=mkdtempSync(join(tmpdir(),'kg-window-neighbor-benchmark-')),database=join(directory,'graph.sqlite')
  const current=await openSqliteStore(database)
  let previous,meter,oldMeter
  try{
    const fixtures=[]
    for(const size of[12000,96000])for(const quoteChars of[64,1024])for(const shape of['chain','star']){
      const fixture=literalWindowFixture(size,'neighbor-benchmark-'+size+'-'+quoteChars+'-'+shape)
      if(shape==='star')for(const node of fixture.graph.nodes.slice(200,1100))fixture.graph.edges.push({
        fromNodeId:'node_17',toNodeId:node.id,relation:'relates_to',evidence:[{paragraph:node.paragraph,quote:node.quote}]})
      for(const node of fixture.graph.nodes)node.quote+='x'.repeat(quoteChars)
      current.saveGraph(fixture.graph,{sourceText:fixture.sourceText,sourceUnits:fixture.sourceUnits})
      fixtures.push({size,quoteChars,shape,documentId:fixture.documentId})
    }
    previous=await baseline.openSqliteStore(database)
    meter=countWindowNeighborNodes(SqliteKnowledgeStore,database);oldMeter=countWindowNeighborNodes(baseline.SqliteKnowledgeStore,database)
    const samples=[]
    for(const fixture of fixtures)for(const limit of fixture.shape==='star'?[200,800,2000]:[200,800])for(const kind of fixture.shape==='star'?['node_17']:['node_17','%_','observation 11999.','100%','absent_%','first-page','last-page']){
      const options={limit,includeSourceText:false,...(kind==='first-page'?{}:kind==='last-page'?{offset:fixture.size-limit}:{query:kind})}
      oldMeter.reset();meter.reset()
      const before=capture(previous,fixture.documentId,options),after=capture(current,fixture.documentId,options)
      assert.deepEqual(after.window,before.window)
      assert.deepEqual(meter.counts,oldMeter.counts)
      assert(meter.counts.maxRows<=400)
      assert.equal(before.neighbors.length,after.neighbors.length)
      assert.deepEqual(after.calls.filter(call=>!isNeighborNodeSql(call.sql)),before.calls.filter(call=>!isNeighborNodeSql(call.sql)))
      for(let i=0;i<after.neighbors.length;i++){
        assert.deepEqual(after.neighbors[i].params,before.neighbors[i].params)
        assert.deepEqual(after.neighbors[i].rows,before.neighbors[i].rows)
      }
      samples.push({nodes:fixture.size,quoteChars:fixture.quoteChars,shape:fixture.shape,kind,limit,returnedNodes:after.window.nodes.length,
        work:{...meter.counts},documentId:fixture.documentId,options,before,after})
    }
    meter.stop();meter=null;oldMeter.stop();oldMeter=null
    const results=[]
    for(const sample of samples){
      const whole=timePair([()=>previous.getDocumentWindow(sample.documentId,sample.options),()=>current.getDocumentWindow(sample.documentId,sample.options)])
      const lookup=[]
      for(let i=0;i<sample.after.neighbors.length;i++){
        const old=sample.before.neighbors[i],next=sample.after.neighbors[i],a=previous.db.prepare(old.sql),b=current.db.prepare(next.sql)
        lookup.push({rows:next.rows.length,candidateIds:next.params.length-1,...timePair([()=>a.all(...old.params),()=>b.all(...next.params)]),
          ...(sample.limit===800?{beforePlan:previous.db.prepare('EXPLAIN QUERY PLAN '+old.sql).all(...old.params).map(row=>row.detail),
            currentPlan:current.db.prepare('EXPLAIN QUERY PLAN '+next.sql).all(...next.params).map(row=>row.detail)}:{})})
      }
      results.push({nodes:sample.nodes,quoteChars:sample.quoteChars,shape:sample.shape,kind:sample.kind,limit:sample.limit,returnedNodes:sample.returnedNodes,work:sample.work,whole,lookup})
    }
    console.log(JSON.stringify({ok:true,baseline:revision,repeats:9,cases:results.length,samples:results,
      scope:'Identical complete production store windows; prepared neighbor SELECT/all separately excludes other SQL and JSON; Native counters and SQL comparisons outside timings; all exclude inspector, HTTP, rendering and CI timing gates'}))
  }finally{meter?.stop();oldMeter?.stop();previous?.close();current.close();rmSync(directory,{recursive:true,force:true})}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await benchmark()
