import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { createSourceRelationTools } from '../src/kg-source-relations.mjs'
import { getOntology,withManualModels } from '../src/kg-ontology.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'
const quote='失义而后礼。故知足不辱，知止不殆，可以长久。',sourceText=quote,units=[{paragraph:0,text:quote}]
const evidence=[{paragraph:0,quote}],provenance={kind:'source',paragraph:0,quote,note:''},field=text=>({text,provenance})
const n=(id,type,text)=>({id,type,text,paragraph:0,quote,evidence,state:'candidate',groundingStatus:'grounded',entailmentStatus:'unverified'})
const graph={ontology:'learning-view-v1',source:{documentId:'learning-mapping-test',id:'learning-mapping-source',title:'条件不丢失'},nodes:[n('yi','concept','义'),n('ritual','concept','礼'),n('rule','rule','失义而后礼'),n('material','relation_material',quote),{...n('model','connection_model','失义而后礼'),modelStructure:{version:1,identity:'hypothesis',slots:[{id:'in',conceptId:'yi',label:'义',role:'input',state:'失义语境',unit:'',provenance},{id:'out',conceptId:'ritual',label:'礼',role:'output',state:'后项',unit:'',provenance}],branches:[{id:'loss',label:'失义而后礼',mapping:field('失义而后礼'),condition:field('失义'),boundary:{text:'规范性文本的有条件映射，不从义直接推出礼，也不将阅读解释作为已获经验验证的定律。'.repeat(4),provenance:{kind:'ai',paragraph:null,quote:'',note:'解释范围'}}}],examples:[]}}],edges:[]}
const tools=createSourceRelationTools(),contract=createGraphContract()
for(const from of ['model','yi','ritual'])graph.edges.push(tools.buildLearning(graph,'model','loss',from,'rule'))
graph.edges.push({fromNodeId:'model',toNodeId:'yi',relation:'maps_between',role:'input',evidence},{fromNodeId:'model',toNodeId:'ritual',relation:'maps_between',role:'output',evidence},{fromNodeId:'material',toNodeId:'rule',relation:'states_mapping',evidence},{fromNodeId:'material',toNodeId:'model',relation:'builds',evidence})
for(const ontology of ['learning-view-v1','aggregate-v1']){
 const candidate={...graph,ontology};assert.equal(contract.validateGraphInvariants(candidate,sourceText,{sourceUnits:units}).blockingIssues.length,0)
 const profile=withManualModels(getOntology(ontology)),types=new Map(graph.nodes.map(n=>[n.id,n.type]))
 for(const edge of graph.edges){const relation=profile.relationTypes.find(r=>r.id===edge.relation);assert(relation);assert(relation.from.includes(types.get(edge.fromNodeId)));assert(relation.to.includes(types.get(edge.toNodeId)))}
}
assert(!getOntology('learning-view-v1').relationTypes.some(r=>r.id==='source_relation'))
assert.equal(graph.edges.filter(e=>e.relation==='source_relation').length,0)
for(const edit of [e=>{e.condition=''},e=>{e.toNodeId='ritual'},e=>{e.relation='causes'},e=>{e.evidence=[]},e=>{e.statement='义导致礼'},e=>{e.branchId='gone'}]){
 const bad=structuredClone(graph);edit(bad.edges[0]);assert(contract.validateGraphInvariants(bad,sourceText,{sourceUnits:units}).blockingIssues.length)
}
const directory=mkdtempSync(join(tmpdir(),'learning-mapping-')),previous=process.env.DSH_KG_DB;process.env.DSH_KG_DB=join(directory,'test.sqlite')
let store
try{
 store=await openSqliteStore(process.env.DSH_KG_DB);store.saveGraph({...graph,edges:graph.edges.slice(3)},{sourceText,sourceUnits:units})
 const routes=[],{apply}=await import('../lib/index.js');apply({get:name=>name==='webServer'?{register:route=>{routes.push(route);return()=>{}}}:null,effect:fn=>fn(),interval:()=>()=>{}})
 const route=routes.find(r=>r.path==='/api/dsh-knowledge-graph')
 const post=(endpoint,body)=>new Promise((resolve,reject)=>{const req=new EventEmitter();Object.assign(req,{method:'POST',url:'/api/dsh-knowledge-graph/'+endpoint,headers:{}});const res={setHeader(){},writeHead(){},end(text){try{resolve(JSON.parse(text))}catch(e){reject(e)}}};route.handler(req,res).catch(reject);process.nextTick(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end')})})
 const request={documentId:graph.source.documentId,expectedRevision:1,baseNodeIds:[],baseEdgeKeys:[],graph:{nodes:[],edges:graph.edges.slice(0,3)}}
 assert.equal((await post('graph-commit-preview',request)).valid,true);assert.equal(store.getDocumentRevision(request.documentId),1)
 const committed=await post('graph-commit',request);assert.equal(committed.revision,2,JSON.stringify(committed.error))
 assert.equal((await post('graph-commit',request)).error.code,'revision_conflict')
 store.close();store=await openSqliteStore(process.env.DSH_KG_DB);const saved=store.getDocument(request.documentId)
 for(const edge of saved.edges.filter(e=>e.modelId)){assert.equal(edge.condition,'失义');assert.equal(edge.statement,'失义而后礼');assert(edge.boundary.length>64);assert.equal(edge.relation,'has_rule');assert.equal(saved.nodes.find(n=>n.id===edge.toNodeId).type,'rule')}
 const invalid=structuredClone(saved);invalid.edges.find(e=>e.modelId).condition='任何时候';assert.throws(()=>store.saveGraph(invalid,{sourceText,expectedRevision:2}),{code:'invalid_source_relation'});assert.equal(store.getDocumentRevision(request.documentId),2)
}finally{store?.close();if(previous===undefined)delete process.env.DSH_KG_DB;else process.env.DSH_KG_DB=previous;rmSync(directory,{recursive:true,force:true})}
console.log(JSON.stringify({ok:true,learningTypes:true,typedEndpoints:true,conditionAndEvidencePreserved:true,versionConflict:true,invalidBindingRolledBack:true}))
