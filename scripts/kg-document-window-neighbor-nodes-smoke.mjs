import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openSqliteStore} from '../lib/kg-store.mjs'

const directory=mkdtempSync(join(tmpdir(),'kg-window-neighbor-nodes-')),database=join(directory,'graph.sqlite')
const writer=await openSqliteStore(database)
writer.db.exec('PRAGMA journal_mode = WAL')
const reader=await openSqliteStore(database),prepare=reader.db.prepare
let reads=0,lookups=0,maxRows=0,multiBatchReads=0,interleavings=0,measuring=false,calls=[]
const isNeighborNodeSql=sql=>sql.startsWith('SELECT * FROM graph_nodes')&&sql.includes('node_id IN (')&&!sql.includes('OFFSET')
reader.db.prepare=function(sql){
  const statement=prepare.call(this,sql)
  if(isNeighborNodeSql(sql)) {
    const all=statement.all
    statement.all=function(...args){
      const rows=all.apply(this,args)
      // Frozen pre-optimization lookup: compare every Native record, including
      // NULL-first/BINARY order and complete JSON, inside the same snapshot.
      const old='SELECT * FROM graph_nodes WHERE document_id = ? AND node_id IN ('+args.slice(1).map(()=>'?').join(',')+') ORDER BY paragraph, node_id'
      assert.deepEqual(rows,prepare.call(reader.db,old).all(...args))
      assert(rows.length<=400);assert(args.length<=401)
      assert(!rows.some(row=>Object.hasOwn(row,'rowid')))
      assert(rows.every(row=>row.document_id===args[0]))
      const plan=prepare.call(reader.db,'EXPLAIN QUERY PLAN '+sql).all(...args)
      assert(plan.some(row=>/SEARCH graph_nodes USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(row.detail)))
      assert(plan.some(row=>/document_id=\? AND node_id=\?/.test(row.detail)))
      if(measuring){calls.push({sql,args,rows:rows.length});lookups++;maxRows=Math.max(maxRows,rows.length)}
      return rows
    }
  }return statement
}
const ids=['0','00','01','1','1.0','1e0','a%_',"n') OR 1=1 --",'A','a','Ω','中','😀','\uE000','\u{10000}']
function fixture(size,id){
  const nodes=Array.from({length:size},(_,i)=>({id:i<3?'seed_'+i:i<ids.length+3?ids[i-3]:'neighbor-'+i,
    type:i<3?'concept':'fact',text:i<3?'Seed marker seed_% '+i:'Observation '+i,
    quote:'Original quote '+i+' 😀',...(i%9?{paragraph:[-3,0,7,1000000000][i%4]}:{}),
    sectionId:i%3?'section-b':'section-a',evidence:[{sourceId:id,paragraph:0,quote:'Full evidence '+i}],
    custom:{index:i,nested:{labels:['中','😀'],nullable:null}}}))
  const edges=nodes.slice(3,Math.min(size,903)).flatMap((node,i)=>['supports','relates_to'].map(relation=>({
    fromNodeId:'seed_'+i%3,toNodeId:node.id,relation,evidence:[{paragraph:0,quote:'Edge evidence '+i}],custom:{index:i}})))
  return {source:{documentId:id,title:id},nodes:nodes.reverse(),edges,custom:{retained:'联结模型 / 内涵 / 陪域 / 槽位'},
    staging:{chunks:[{chunkId:'retained',startParagraph:0,endParagraph:9,summary:'Complete chunk',nodeIds:['seed_0','seed_1','seed_2']}]}}
}
function check(id,options){
  const full=writer.getDocument(id),byId=new Map(full.nodes.map(node=>[node.id,node]))
  calls=[];measuring=true
  let window
  try{window=reader.getDocumentWindow(id,options)}finally{measuring=false}
  assert(window.nodes.length<=options.limit)
  assert.deepEqual(window.source,full.source);assert.deepEqual(window.custom,full.custom);assert.deepEqual(window.staging,full.staging)
  assert.equal(window.revision,full.revision);assert.equal(window.view.totalNodes,full.nodes.length);assert.equal(window.view.totalEdges,full.edges.length)
  assert.equal(window.sourceText,options.includeSourceText===false?'':full.sourceText)
  for(const node of window.nodes)assert.deepEqual(node,byId.get(node.id))
  const selected=new Set(window.nodes.map(node=>node.id))
  const expectedEdges=full.edges.filter(edge=>selected.has(edge.fromNodeId)&&selected.has(edge.toNodeId)).slice(0,options.limit*6)
  assert.deepEqual(window.edges,expectedEdges)
  if(options.query==='seed_%') {
    assert.equal(window.view.matchedNodes,3)
    const seeds=new Set(['seed_0','seed_1','seed_2'])
    const neighborhood=new Set([...seeds,...full.edges.flatMap(edge=>seeds.has(edge.fromNodeId)?[edge.toNodeId]:seeds.has(edge.toNodeId)?[edge.fromNodeId]:[])])
    assert.equal(window.nodes.length,Math.min(options.limit,neighborhood.size))
    if(options.limit>3)assert(calls.length>0)
  }
  if(options.query==='absent_%'||(options.query==='fact'&&options.limit<=800&&full.nodes.length>800))assert.equal(calls.length,0)
  if(calls.length>1)multiBatchReads++
  reads++;return window
}
const inspect=graph=>({nodes:graph.nodes.length,revision:graph.revision,source:graph.sourceText})
try {
  for(const [size,id]of[[64,'neighbors-small'],[1200,'neighbors-medium'],[5200,'neighbors-large'],[1200,'neighbors-other']]) {
    writer.saveGraph(fixture(size,id),{sourceText:'Unchanged source '+id})
    if(id==='neighbors-large')for(const [nodeId,rowid]of[[ids[0],-11n],[ids[1],0n],[ids[2],9223372036854775807n]])
      writer.db.prepare('UPDATE graph_nodes SET rowid = ? WHERE document_id = ? AND node_id = ?').run(rowid,id,nodeId)
    const original=JSON.stringify(writer.getDocument(id))
    for(const query of['seed_%','absent_%','fact'])for(const limit of[1,4,20,200,800,2000])for(const includeSourceText of[false,true])
      check(id,{query,limit,includeSourceText})
    assert.equal(JSON.stringify(writer.getDocument(id)),original)
  }
  const id='neighbors-large',options={query:'seed_%',limit:2000,includeSourceText:false}
  for(const command of['ANALYZE','PRAGMA automatic_index = OFF','VACUUM']) {
    const before=writer.getDocument(id);writer.db.exec(command);assert.deepEqual(writer.getDocument(id),before);check(id,options)
  }
  // Writer changes before/after the actual bounded lookup cannot mix candidate
  // identities, node contents, relations, source or canonical diagnostics.
  for(const afterRead of[false,true]) {
    const before=reader.getDocumentWindow(id,options,inspect),full=writer.getDocument(id),changed=structuredClone(full)
    const remove=changed.nodes.find(node=>node.id==='0'||node.id==='00')?.id
    changed.nodes=changed.nodes.filter(node=>node.id!==remove)
    const remaining=new Set(changed.nodes.map(node=>node.id))
    changed.edges=changed.edges.filter(edge=>remaining.has(edge.fromNodeId)&&remaining.has(edge.toNodeId))
    changed.nodes.find(node=>node.id==='seed_0').quote+=' new independent quote'
    changed.staging.chunks[0].summary+=' new'
    let fired=false
    const observedPrepare=reader.db.prepare
    reader.db.prepare=function(sql){const statement=observedPrepare.call(this,sql)
      if(isNeighborNodeSql(sql)){const all=statement.all;statement.all=function(...args){
        const commit=()=>{fired=true;assert.throws(()=>reader.db.exec('BEGIN'),/within a transaction/)
          writer.saveGraph(changed,{expectedRevision:full.revision,sourceText:full.sourceText+'\n\nNew independent source.'});interleavings++}
        if(!fired&&!afterRead)commit()
        const result=all.apply(this,args)
        if(!fired&&afterRead)commit()
        return result
      }}return statement}
    try{assert.deepEqual(reader.getDocumentWindow(id,options,inspect),before);assert(fired)}finally{reader.db.prepare=observedPrepare}
    const next=check(id,options)
    assert.equal(next.revision,before.revision+1);assert.equal(next.view.totalNodes,before.view.totalNodes-1)
    assert.equal(reader.getDocumentWindow(id,options,inspect).graphStructureQuality.source,writer.getDocument(id).sourceText)
  }
  console.log(JSON.stringify({ok:true,documents:4,reads,lookups,maxRows,multiBatchReads,interleavings,
    frozenNativeRecordsAndOrder:true,boundedIndexedNeighborLookup:true,completeEvidenceAndMetadata:true,
    crossDocumentIsolation:true,internal64BitRowIds:true,analyzeAutomaticIndexAndVacuum:true,independentWalSnapshot:true}))
}finally{reader.close();writer.close();rmSync(directory,{recursive:true,force:true})}
