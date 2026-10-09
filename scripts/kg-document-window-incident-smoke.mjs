import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openSqliteStore} from '../lib/kg-store.mjs'
import {incidentShapeFixture,isWindowIncidentSql,isWindowIncidentProbeSql} from './kg-document-window-incident-benchmark.mjs'
const directory=mkdtempSync(join(tmpdir(),'kg-window-incident-')),database=join(directory,'graph.sqlite')
const writer=await openSqliteStore(database);writer.db.exec('PRAGMA journal_mode = WAL')
const reader=await openSqliteStore(database),prepare=reader.db.prepare
let reads=0,probes=0,indexed=0,fallback=0,maxProbeCandidates=0,multiBatch=0,interleavings=0,measuring=false,calls=[]
reader.db.prepare=function(sql){const statement=prepare.call(this,sql)
  if(isWindowIncidentProbeSql(sql)){const get=statement.get;statement.get=function(...args){const value=get.apply(this,args)
    assert(value.count<=2*args.at(-1));assert(value.count<=130)
    const plan=prepare.call(reader.db,'EXPLAIN QUERY PLAN '+sql).all(...args)
    assert(plan.some(row=>/COVERING INDEX.*document_id=\? AND from_node_id=\?/.test(row.detail)))
    assert(plan.some(row=>/COVERING INDEX.*document_id=\? AND to_node_id=\?/.test(row.detail)))
    if(measuring){probes++;maxProbeCandidates=Math.max(maxProbeCandidates,value.count)}return value}}
  if(isWindowIncidentSql(sql)){const all=statement.all;statement.all=function(...args){
    const rows=all.apply(this,args),fast=sql.includes('UNION SELECT rowid'),length=(args.length-(fast?3:2))/2
    assert(Number.isInteger(length)&&length>0&&length<=300)
    const ids=args.slice(1,1+length),cap=args.at(-1),marks=ids.map(()=>'?').join(',')
    const old='SELECT * FROM graph_edges WHERE document_id = ? AND (from_node_id IN ('+marks+') OR to_node_id IN ('+marks+')) ORDER BY from_node_id, to_node_id, relation LIMIT ?'
    assert.deepEqual(rows,prepare.call(reader.db,old).all(args[0],...ids,...ids,cap))
    assert(rows.length<=cap);assert(rows.every(row=>row.document_id===args[0]&&!Object.hasOwn(row,'rowid')))
    if(fast){assert(rows.length<=64);assert.equal(args[1+length],args[0])
      const plan=prepare.call(reader.db,'EXPLAIN QUERY PLAN '+sql).all(...args)
      assert(plan.some(row=>/SEARCH graph_edges USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(row.detail)))
    }else{assert.equal(sql,old);assert.deepEqual(args,[args[0],...ids,...ids,cap])}
    if(measuring){calls.push({fast,ids,rows:rows.length});if(fast)indexed++;else fallback++}return rows}}
  return statement
}
const compare=(fields,a,b)=>{for(const field of fields){if(a[field]==null&&b[field]!=null)return-1;if(b[field]==null&&a[field]!=null)return 1
  const order=field==='paragraph'?(a[field]||0)-(b[field]||0):Buffer.compare(Buffer.from(a[field]||''),Buffer.from(b[field]||''));if(order)return order}return 0}
const nodeOrder=(a,b)=>compare(['paragraph','id'],a,b),edgeOrder=(a,b)=>compare(['fromNodeId','toNodeId','relation'],a,b)
const lower=value=>String(value||'').replace(/[A-Z]/g,c=>c.toLowerCase())
function reference(full,options){
  const limit=options.limit,cap=Math.max(limit,Math.min(12000,options.edgeLimit??limit*6)),query=options.query.toLowerCase()
  const nodes=[...full.nodes].sort(nodeOrder),edges=[...full.edges].sort(edgeOrder)
  const matches=nodes.filter(node=>[node.id,node.type,node.text,node.quote,node.sectionId,node.sectionTitle].some(value=>lower(value).includes(query)))
  const selected=new Map(matches.slice(0,limit).map(node=>[node.id,node])),direct=[...selected.keys()]
  if(direct.length&&direct.length<limit){const incident=new Map()
    for(let start=0;start<direct.length&&incident.size<cap;start+=300){const batch=new Set(direct.slice(start,start+300))
      for(const edge of edges.filter(edge=>batch.has(edge.fromNodeId)||batch.has(edge.toNodeId)).slice(0,cap-incident.size))
        incident.set(JSON.stringify([edge.fromNodeId,edge.toNodeId,edge.relation]),edge)
    }
    const ids=[...new Set([...incident.values()].flatMap(edge=>[edge.fromNodeId,edge.toNodeId]).filter(id=>!selected.has(id)))]
    for(let start=0;start<ids.length&&selected.size<limit;start+=400){const batch=new Set(ids.slice(start,start+400))
      for(const node of nodes.filter(node=>batch.has(node.id))){if(selected.size>=limit)break;selected.set(node.id,node)}
    }
  }
  return{nodes:[...selected.values()],edges:edges.filter(edge=>selected.has(edge.fromNodeId)&&selected.has(edge.toNodeId)).slice(0,cap),matched:matches.length}
}
function check(id,options,full=writer.getDocument(id)){
  const expected=reference(full,options),beforeProbes=probes;calls=[];measuring=true
  let actual;try{actual=reader.getDocumentWindow(id,options)}finally{measuring=false}
  assert.deepEqual(actual.nodes,expected.nodes);assert.deepEqual(actual.edges,expected.edges)
  assert.deepEqual(actual.source,full.source);assert.deepEqual(actual.staging,full.staging);assert.deepEqual(actual.custom,full.custom)
  assert.equal(actual.view.matchedNodes,expected.matched);assert.equal(actual.view.totalNodes,full.nodes.length);assert.equal(actual.view.totalEdges,full.edges.length)
  assert.equal(actual.revision,full.revision);assert.equal(actual.sourceText,options.includeSourceText===false?'':full.sourceText)
  assert(actual.nodes.length<=options.limit)
  if(full.edges.length<4096||expected.matched===0||expected.matched>=options.limit)assert.equal(probes,beforeProbes)
  if(calls.length>1)multiBatch++
  reads++;return actual
}
const fixtures=[]
const inspect=full=>({revision:full.revision,nodes:full.nodes.length,edges:full.edges.length,source:full.sourceText})
try{
  for(const [shape,size,id]of[['chain',5200,'incident-sparse'],['hub',1200,'incident-hub'],['batch',5200,'incident-batch'],['small',64,'incident-small'],['chain',5200,'incident-other']]){
    const fixture=incidentShapeFixture(shape,size,id)
    if(id==='incident-sparse'){
      const nodes=fixture.graph.nodes
      nodes[40].text+=' self_rare_%'
      for(const [index,count]of[[5180,64],[5181,65]]){
        nodes[index].text+=' threshold'+count+'_%'
        for(let i=0;i<count;i++)fixture.graph.edges.push({fromNodeId:i%2?nodes[i].id:nodes[index].id,
          toNodeId:i%2?nodes[index].id:nodes[i].id,relation:'relates_to',evidence:[{paragraph:0,quote:'Complete boundary evidence '+i}],custom:{ordinal:i}})
      }
    }
    writer.saveGraph(fixture.graph,{sourceText:fixture.sourceText,sourceUnits:fixture.sourceUnits});fixtures.push(fixture)
    if(id==='incident-sparse'){
      for(const [from,to,rowid]of[['n5180','node_17',-11n],['node17','n5180',0n],['n5180','n2',9223372036854775807n]])
        writer.db.prepare('UPDATE graph_edges SET rowid = ? WHERE document_id = ? AND from_node_id = ? AND to_node_id = ? AND relation = ?').run(rowid,id,from,to,'relates_to')
      writer.db.prepare('INSERT INTO graph_edges SELECT ?,document_id,source_id,?,?,relation,evidence_json,attributes_json,chunk_id,state,created_at,updated_at FROM graph_edges WHERE document_id = ? AND from_node_id = ? AND to_node_id = ? AND relation = ?')
        .run(id+'-self-edge','n40','n40',id,'n40','n41','supports')
    }
    const full=writer.getDocument(id),untouched=JSON.stringify(full)
    for(const query of['node_17','%_','absent_%','fact','n'+Math.floor(size/2),...(shape==='batch'?['common_%']:[])])
      for(const limit of[4,20,200,800,2000])for(const includeSourceText of[false,true])check(id,{query,limit,includeSourceText},full)
    assert.equal(JSON.stringify(writer.getDocument(id)),untouched)
  }
  const id='incident-sparse',options={query:'node_17',limit:800,includeSourceText:false}
  for(const [query,fast]of[['threshold64_%',true],['threshold65_%',false],['self_rare_%',true]]){
    check(id,{...options,query});assert.equal(calls[0].fast,fast)
  }
  const mixed=structuredClone(fixtures.find(f=>f.documentId==='incident-batch'))
  for(const node of mixed.graph.nodes.slice(340,420))node.text=node.text.replace(' common_%','')
  const directIds=new Set(mixed.graph.nodes.slice(0,420).map(node=>node.id))
  mixed.graph.edges=mixed.graph.edges.filter(edge=>!directIds.has(edge.fromNodeId)&&!directIds.has(edge.toNodeId))
  mixed.graph.edges.push({fromNodeId:'node_17',toNodeId:'n350',relation:'relates_to'},
    {fromNodeId:'n310',toNodeId:'n450',relation:'relates_to'})
  writer.saveGraph(mixed.graph,{sourceText:mixed.sourceText,sourceUnits:mixed.sourceUnits})
  check(mixed.documentId,{query:'common_%',limit:800,includeSourceText:false})
  assert(calls.some(call=>call.fast)&&calls.some(call=>!call.fast));assert(calls.length>1)
  for(const command of['ANALYZE','PRAGMA automatic_index = OFF','VACUUM']){const full=writer.getDocument(id)
    writer.db.exec(command);assert.deepEqual(writer.getDocument(id),full);check(id,options,full)}
  // Independent writes cross both bounded selectivity and incident hydration.
  // The next revision deliberately moves from the indexed to fallback branch.
  for(const boundary of[isWindowIncidentProbeSql,isWindowIncidentSql])for(const afterRead of[false,true]){
    const fixture=fixtures.find(f=>f.documentId===id);writer.saveGraph(fixture.graph,{sourceText:fixture.sourceText,sourceUnits:fixture.sourceUnits})
    const before=reader.getDocumentWindow(id,options,inspect),full=writer.getDocument(id),changed=structuredClone(full)
    for(let i=4800;i<4870;i++)changed.edges.push({fromNodeId:'node_17',toNodeId:'n'+i,relation:'relates_to',evidence:[{paragraph:0,quote:'New independent relation '+i}]})
    changed.staging.chunks[0].summary+=' new';let fired=false
    const observed=reader.db.prepare
    reader.db.prepare=function(sql){const statement=observed.call(this,sql)
      if(boundary(sql))for(const method of['get','all']){const execute=statement[method];statement[method]=function(...args){
        const commit=()=>{fired=true;assert.throws(()=>reader.db.exec('BEGIN'),/within a transaction/)
          writer.saveGraph(changed,{expectedRevision:full.revision,sourceText:full.sourceText+'\n\nNew independent source.'});interleavings++}
        if(!fired&&!afterRead)commit();const value=execute.apply(this,args);if(!fired&&afterRead)commit();return value}}
      return statement}
    try{assert.deepEqual(reader.getDocumentWindow(id,options,inspect),before);assert(fired)}finally{reader.db.prepare=observed}
    const next=check(id,options);assert.equal(next.revision,before.revision+1);assert(calls.every(call=>!call.fast))
    assert.equal(reader.getDocumentWindow(id,options,inspect).graphStructureQuality.source,writer.getDocument(id).sourceText)
  }
  const savedPrepare=reader.db.prepare
  reader.db.prepare=function(sql){if(isWindowIncidentProbeSql(sql))throw new Error('Synthetic bounded probe failure');return savedPrepare.call(this,sql)}
  try{assert.throws(()=>reader.getDocumentWindow(id,options,inspect),/Synthetic bounded probe failure/)}finally{reader.db.prepare=savedPrepare}
  reader.db.exec('BEGIN; ROLLBACK');check(id,options)
  console.log(JSON.stringify({ok:true,documents:5,reads,probes,indexed,fallback,maxProbeCandidates,multiBatch,interleavings,
    frozenNativeRecordsAndOrder:true,independentPublicWindowReference:true,threshold64And65:true,parallelAndSelfRelations:true,
    internal64BitRowIds:true,smallGraphAndLargeBatchControls:true,independentWalSnapshotAndBranchChange:true,probeFailureRecovery:true}))
}finally{reader.close();writer.close();rmSync(directory,{recursive:true,force:true})}
