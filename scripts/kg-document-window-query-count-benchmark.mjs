// Optional: node scripts/kg-document-window-query-count-benchmark.mjs [baseline-revision]
// Same-result store comparisons; no inspector, HTTP, rendering or CI timing gate.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSqliteStore, SqliteKnowledgeStore } from '../src/kg-store.mjs'
import { baselineModules } from './kg-document-window-diagnostics-benchmark.mjs'
import { literalWindowFixture, countWindowQueryWork, isWindowQuerySql, assertWindowQueryCallParity } from './kg-document-window-query-benchmark.mjs'

function capture(store, id, options) {
  const prepare = store.db.prepare, calls = []
  store.db.prepare = function(sql) {
    const statement = prepare.call(this, sql)
    if (isWindowQuerySql(sql)) for (const method of ['get','all']) {
      const execute = statement[method]
      statement[method] = function(...params) {
        calls.push({sql,method,params}); return execute.apply(this,params)
      }
    }
    return statement
  }
  try { return {window:store.getDocumentWindow(id,options),calls} }
  finally {store.db.prepare=prepare}
}
const median = values => [...values].sort((a,b) => a-b)[4]
async function benchmark() {
  const validateOnly=process.argv.includes('--validate-only'),args=process.argv.slice(2).filter(arg=>arg!=='--validate-only')
  const revision = args[0] || '9bfe9f1'
  if(args.length>1) throw new Error('Expected at most one baseline revision')
  const baseline = (await baselineModules(revision)).store
  const directory=mkdtempSync(join(tmpdir(),'kg-window-query-count-')),database=join(directory,'graph.sqlite')
  const current=await openSqliteStore(database)
  let previous,meter,oldMeter
  try {
    const fixtures=[]
    for (const size of [12000,96000]) for (const shape of ['sparse-short','broad-long']) {
      const fixture=literalWindowFixture(size,'count-'+size+'-'+shape)
      if(shape==='broad-long') for (const node of fixture.graph.nodes) node.text += ' Broad bulk_% token. '+'x'.repeat(1024)
      fixtures.push({...fixture,shape})
      current.saveGraph(fixture.graph,{sourceText:fixture.sourceText,sourceUnits:fixture.sourceUnits})
    }
    previous=await baseline.openSqliteStore(database)
    oldMeter=countWindowQueryWork(baseline.SqliteKnowledgeStore,database)
    meter=countWindowQueryWork(SqliteKnowledgeStore,database)
    const samples=[]
    for (const fixture of fixtures) for (const query of ['%','%_','absent_%','node_17','observation 11999.']) for (const limit of [200,800]) {
      const options={query,limit,includeSourceText:false}
      oldMeter.reset();meter.reset()
      const before=capture(previous,fixture.documentId,options),after=capture(current,fixture.documentId,options)
      assert.deepEqual(after.window,before.window,'Complete returned windows must remain identical')
      const matched=fixture.graph.nodes.filter(node=>[node.id,node.type,node.text,node.quote,node.sectionId,node.sectionTitle]
        .some(value=>String(value||'').replace(/[A-Z]/g,letter=>letter.toLowerCase()).includes(query.toLowerCase()))).length
      assert.equal(after.window.view.matchedNodes,matched)
      const counted=matched>=limit
      assert.equal(meter.counts.matchCountReads,counted?1:0)
      assert.equal(meter.counts.matchingStatements,counted?2:1)
      assert.equal(meter.counts.matched,matched)
      assert.equal(meter.counts.directRows,Math.min(matched,limit))
      assert.equal(oldMeter.counts.matchingStatements,before.calls.length)
      // Actual SQL and parameter bytes remain unchanged. Ordinary/literal
      // queries now share direct-first reads and underfilled COUNT omission.
      assertWindowQueryCallParity(before.calls,after.calls,after.window)
      samples.push({nodes:fixture.graph.nodes.length,shape:fixture.shape,documentId:fixture.documentId,query,limit,matched,
        returned:after.window.nodes.length,before:{...oldMeter.counts},current:{...meter.counts}})
    }
    oldMeter.stop();oldMeter=null;meter.stop();meter=null
    if(validateOnly){console.log(JSON.stringify({ok:true,baseline:revision,cases:samples.length,validationOnly:true}));return}
    for (const sample of samples) {
      const options={query:sample.query,limit:sample.limit,includeSourceText:false},times=[[],[]]
      const runs=[()=>previous.getDocumentWindow(sample.documentId,options),()=>current.getDocumentWindow(sample.documentId,options)]
      for (let i=0;i<3;i++){runs[0]();runs[1]()}
      for (let i=0;i<9;i++) for (const index of i%2?[1,0]:[0,1]) {
        const start=performance.now();runs[index]();times[index].push(performance.now()-start)
      }
      sample.beforeMedianMs=median(times[0]);sample.currentMedianMs=median(times[1])
    }
    console.log(JSON.stringify({ok:true,baseline:revision,repeats:9,samples,
      scope:'Complete production store windows with identical results; Native COUNT/direct counters outside timing; excludes inspector, HTTP and rendering; broad full-page and ordinary queries are controls'}))
  } finally {meter?.stop();oldMeter?.stop();previous?.close();current.close();rmSync(directory,{recursive:true,force:true})}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await benchmark()
