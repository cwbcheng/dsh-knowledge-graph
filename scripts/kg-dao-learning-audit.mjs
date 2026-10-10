import { readFileSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createGraphContract } from '../src/index.host.js'
import { createSourceRelationTools } from '../src/kg-source-relations.mjs'
import { daoEndpoints,daoClauses,daoBoundaries } from './fixtures/dao-source-relations.mjs'
import { daoAdditionalMappings,daoAuditGroups,daoAuditBoundary } from './fixtures/dao-learning-audit.mjs'
import { DAO_DOCUMENT } from './kg-dao-source-repair.mjs'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const edgeKey = e => e.fromNodeId+'>'+e.toNodeId+':'+e.relation
const prefix = 'dao-learning-20261010-'

// Dry preparation only. Reviewed source clauses, not a lexical edge generator.
export function prepareDaoLearningAudit(document,sourceUnits) {
  if(document.documentId!==DAO_DOCUMENT || document.graph?.ontology!=='aggregate-v1') throw new Error('Wrong audit target')
  if(hash(sourceUnits)!=='a55e7c4baa7829ac17d3f0fe2582bf8ba1a5a56d03f5b4b340e530b21998c72d') throw new Error('Stored edition changed; review all paragraphs again')
  const graph=structuredClone(document.graph), nodes=new Map(graph.nodes.map(n=>[n.id,n])), units=new Map(sourceUnits.map(u=>[u.paragraph,u.text]))
  if(graph.nodes.some(n=>n.id.startsWith(prefix))) throw new Error('Audit already applied; inspect current version')
  const legacy=graph.edges.filter(e=>e.relation==='source_relation')
  if(legacy.length!==71) throw new Error('Expected the 71 legacy correspondences for explicit migration')
  const models=new Map(Object.keys(daoBoundaries).map(key=>[key,nodes.get('dao-connection-20261007-m-'+key)]))
  for(const model of models.values()) if(model?.type!=='connection_model'||model.modelStructure?.examples?.length) throw new Error('Reviewed models changed; preserve and inspect existing examples')
  const oldModelIds=new Set([...models.values()].map(n=>n.id))
  const removed=graph.edges.filter(e=>e.relation==='source_relation'||e.relation==='maps_between'&&oldModelIds.has(e.fromNodeId)||['n83>n65:is_a','n212>n83:defines','n249>n248:not_is'].includes(edgeKey(e)))
  graph.edges=graph.edges.filter(e=>!removed.includes(e))
  const changedNodes=new Set(oldModelIds), changedEdges=new Set(), mappings=[], modelUsage=new Map(), materialLinks=new Set()
  const source=(paragraph,quote)=>({kind:'source',paragraph,quote,note:'存储工作文本；哲学主张与阅读模型仍待审校。'})
  const ai=text=>({text,provenance:{kind:'ai',paragraph:null,quote:'',note:'整理者记录的解释范围，不是古代原句。'}})
  function addNode(node){if(nodes.has(node.id))throw new Error('Duplicate audit identity '+node.id); nodes.set(node.id,node);graph.nodes.push(node);return node}
  function scoped(group,p,label){const id=prefix+'c-'+hash([group,p,label]).slice(0,20);if(!nodes.has(id)) addNode({id,type:'concept',text:label+'（P'+p+'语境）',paragraph:p-1,quote:units.get(p-1),evidence:[{paragraph:p-1,quote:units.get(p-1)}],state:'candidate',groundingStatus:'grounded',entailmentStatus:'unverified',contentLayer:'main'});return id}
  const oldEndpoint=key=>{const label=daoEndpoints[key],id=label.startsWith('@')?label.slice(1):'dao-source-20261010-c-'+key;if(nodes.get(id)?.type!=='concept')throw new Error('Missing reviewed concept '+id);return id}
  for(const [key,label] of Object.entries(daoAuditGroups)){
    const p=daoAdditionalMappings.find(row=>row[0]===key)[1],paragraph=p-1,quote=units.get(paragraph)
    models.set(key,addNode({id:prefix+'m-'+key,type:'connection_model',text:label,paragraph,quote,evidence:[{paragraph,quote}],state:'candidate',groundingStatus:'grounded',entailmentStatus:'unverified',contentLayer:'main',modelStructure:{version:1,identity:'hypothesis',slots:[],branches:[],examples:[]}}))
  }
  for(const model of models.values())model.modelStructure={...model.modelStructure,identity:'hypothesis',slots:[],branches:[],examples:[]}
  function mapping(group,branchId,p,from,to,statement,condition,contextP){
    const paragraph=p-1,quote=units.get(paragraph),contextParagraph=(contextP||p)-1,context=units.get(contextParagraph)
    if(!quote?.includes(statement)||!context?.includes(condition||context))throw new Error('Literal source mismatch P'+p+' '+branchId+' '+statement)
    if(from===to)throw new Error('Input and output must remain distinct states')
    const model=models.get(group),branch={id:branchId,label:statement.slice(0,180),condition:{text:condition||context,provenance:source(contextParagraph,context)},mapping:{text:statement,provenance:source(paragraph,quote)},boundary:ai((daoBoundaries[group]||daoAuditBoundary)+' 关系使用《学习观》类型；引文是关系材料，不能直接作概念间的边类型。')}
    model.modelStructure.branches.push(branch)
    const use=modelUsage.get(model.id)||new Map();modelUsage.set(model.id,use)
    for(const [id,role] of [[from,'input'],[to,'output']]){if(!use.has(id))use.set(id,{roles:new Set(),paragraph,quote});use.get(id).roles.add(role)}
    const id=prefix+'r-'+group+'-'+branchId
    const evidence=[{paragraph,quote}];if(contextParagraph!==paragraph)evidence.push({paragraph:contextParagraph,quote:context})
    addNode({id,type:'rule',text:statement,paragraph,quote,evidence,state:'candidate',groundingStatus:'grounded',entailmentStatus:'unverified',contentLayer:'main'})
    // One stored paragraph is one piece of relation material. Multiple rules
    // can refer to it; duplicating the complete quote per clause adds no meaning.
    const material=prefix+'t-p'+p+'-context'+(contextP||p)
    if(!nodes.has(material))addNode({id:material,type:'relation_material',text:quote,paragraph,quote,evidence,state:'candidate',groundingStatus:'grounded',entailmentStatus:'unverified',contentLayer:'main'})
    for(const [target,relation] of [[id,'states_mapping'],[model.id,'states_mapping'],[model.id,'builds']]){
      const edge={fromNodeId:material,toNodeId:target,relation,evidence,state:'candidate'},key=edgeKey(edge)
      if(!materialLinks.has(key)){materialLinks.add(key);graph.edges.push(edge)}
    }
    mappings.push({group,modelId:model.id,branchId,p,from,to,ruleId:id,materialId:material,statement,condition:branch.condition.text})
  }
  for(const [group,branch,p,fromKey,toKey,statement,condition,contextP] of daoClauses){
    if(group==='return'&&branch==='paired'){
      for(const [i,[pair,verb]] of [['有无','相生'],['难易','相成'],['长短','相刑'],['高下','相盈'],['意声','相和'],['先后','相隋']].entries())mapping(group,'paired-'+i,p,scoped(group,p,pair),scoped(group,p,verb),pair+'之'+verb+'也',null)
      continue
    }
    if(group==='cultivation'&&branch==='same-scale'){
      for(const [i,scale] of ['身','家','乡','邦','天下'].entries())mapping(group,'observe-'+i,p,scoped(group,p,scale+'（观察范围）'),scoped(group,p,'观'+scale+'（同级对象）'),'以'+scale+'观'+scale,null)
      continue
    }
    if(group==='treasures'&&branch==='abandon-behind')continue
    let from=oldEndpoint(fromKey),to=oldEndpoint(toKey)
    if(group==='treasures'&&branch==='abandon-care')from=scoped(group,p,'舍亓兹且勇、舍亓后且先（完整前提）')
    if(group==='softness'&&branch==='water-hard')to=scoped(group,p,'胜刚（水的比较结果）')
    if(group==='softness'&&branch==='weak-strong')to=scoped(group,p,'胜强（弱强对照结果）')
    if(group==='nonaction'&&branch.startsWith('self-'))from=scoped(group,p,{ 'self-change':'我无为','self-right':'我好静','self-rich':'我无事' }[branch])
    if(group==='balance'&&branch==='sage-success'){
      mapping(group,'sage-action',p,scoped(group,p,'圣人为'),scoped(group,p,'弗有'),'是以圣人为而弗有',null)
      mapping(group,'sage-success',p,scoped(group,p,'成功'),scoped(group,p,'不居'),'成功而不居也',null)
      continue
    }
    mapping(group,branch,p,from,to,statement,condition,contextP)
  }
  daoAdditionalMappings.forEach(([group,p,from,to,statement,condition,contextP],i)=>mapping(group,'p'+p+'-'+i,p,scoped(group,p,from),scoped(group,p,to),statement,condition,contextP))
  const tools=createSourceRelationTools()
  for(const model of models.values()){
    for(const [conceptId,item] of modelUsage.get(model.id)){
      const role=item.roles.has('input')?'input':'output'
      model.modelStructure.slots.push({id:'s'+model.modelStructure.slots.length,conceptId,label:nodes.get(conceptId).text.slice(0,200),role,unit:'',state:item.roles.size===2?'中间状态：在不同分支分别充当前项与后项，依据各分支条件解读。':'语境内的类别或状态；条件见映射分支，不作无条件结论。',provenance:source(item.paragraph,item.quote)})
      graph.edges.push({fromNodeId:model.id,toNodeId:conceptId,relation:'maps_between',role,evidence:[{paragraph:item.paragraph,quote:item.quote}],state:'candidate'})
    }
  }
  for(const m of mappings)for(const from of [m.modelId,m.from,m.to])graph.edges.push(tools.buildLearning(graph,m.modelId,m.branchId,from,m.ruleId,nodes))
  // P142 contrasts two mappings, not two concept extensions. Represent each
  // mapping as its own model, then use learning-view's relation comparison.
  const allocationModels=[]
  for(const branchId of ['heaven-balance','human-balance']){
    const m=mappings.find(m=>m.group==='balance'&&m.branchId===branchId),parent=models.get('balance')
    const id=prefix+'m-'+branchId,paragraph=141,quote=units.get(paragraph)
    const model=addNode({id,type:'connection_model',text:branchId==='heaven-balance'?'天之道：损有余而益不足（P142）':'人之道：损不足而奉有余（P142）',paragraph,quote,evidence:[{paragraph,quote}],state:'candidate',groundingStatus:'grounded',entailmentStatus:'unverified',contentLayer:'main',modelStructure:{version:1,identity:'hypothesis',slots:[m.from,m.to].map((conceptId,i)=>({id:'s'+i,conceptId,label:nodes.get(conceptId).text.slice(0,200),role:i?'output':'input',unit:'',state:'P142的分配关系，不与P115的倫理表述等同。',provenance:source(paragraph,quote)})),branches:[structuredClone(parent.modelStructure.branches.find(b=>b.id===branchId))],examples:[]}})
    for(const slot of model.modelStructure.slots)graph.edges.push({fromNodeId:id,toNodeId:slot.conceptId,relation:'maps_between',role:slot.role,evidence:[{paragraph,quote}],state:'candidate'})
    graph.edges.push(tools.buildLearning(graph,id,branchId,id,m.ruleId,nodes))
    for(const relation of ['states_mapping','builds'])graph.edges.push({fromNodeId:m.materialId,toNodeId:id,relation,evidence:[{paragraph,quote}],state:'candidate'})
    allocationModels.push(id)
  }
  graph.edges.push({fromNodeId:allocationModels[0],toNodeId:allocationModels[1],relation:'compares_relation',mode:'contrast',evidence:[{paragraph:141,quote:units.get(141)}],state:'candidate'})
  // Only explicit multi-part source sequences are composed; parallel lists and
  // a "can have a state" never become the next step's actual precondition.
  for(const [group,branches,p] of [['ethics',['loss-dao','loss-de','loss-ren','loss-yi'],37],['generation',['dao-one','one-two','two-three','three-things'],49],['accumulation',null,88],['constancy',null,195]]){
    const selected=mappings.filter(m=>m.group===group&&(!branches||branches.includes(m.branchId)))
    const paragraph=p-1,quote=units.get(paragraph),id=prefix+'r-composite-'+group
    addNode({id,type:'rule',text:quote,paragraph,quote,evidence:[{paragraph,quote}],state:'candidate',groundingStatus:'grounded',entailmentStatus:'unverified',contentLayer:'main'})
    graph.edges.push({fromNodeId:models.get(group).id,toNodeId:id,relation:'has_rule',evidence:[{paragraph,quote}],state:'candidate'})
    for(const m of selected)graph.edges.push({fromNodeId:m.ruleId,toNodeId:id,relation:'composes',evidence:[{paragraph,quote}],state:'candidate'})
  }
  // A same-name mention in a different passage is not the earlier definition.
  const scopedDe=scoped('governance-de',108,'玄德（恒知稽式语境）')
  const oldDefinition=removed.find(e=>edgeKey(e)==='n212>n83:defines')
  graph.edges.push({...oldDefinition,toNodeId:scopedDe})
  for(const [id,text] of [['n46','文本称：故必贵而以贱为本，必高矣而以下为基。'],['n236','文本称：故去被取此（沿用工作文本用字）。']]){if(!nodes.has(id))throw new Error('Missing reviewed node '+id);nodes.get(id).text=text;changedNodes.add(id)}
  // Older cross-paragraph reasoning sometimes quoted only its conclusion.
  // Complete the provenance for both endpoints without inventing a new edge.
  const evidenceCompleted=[]
  for(const edge of graph.edges){
    if(!['infers','supports','example','analogy','defines','causes','driven_by','not_is','aims_at'].includes(edge.relation))continue
    const before=JSON.stringify(edge.evidence||[])
    for(const id of [edge.fromNodeId,edge.toNodeId]){const n=nodes.get(id);if(Number.isSafeInteger(n?.paragraph)&&units.has(n.paragraph)&&!edge.evidence?.some(e=>e.paragraph===n.paragraph)){
      edge.evidence=[...(edge.evidence||[]),{paragraph:n.paragraph,quote:units.get(n.paragraph)}]
    }}
    if(before!==JSON.stringify(edge.evidence)){changedEdges.add(edgeKey(edge));evidenceCompleted.push(edgeKey(edge))}
  }
  const gate=createGraphContract().validateGraphInvariants(graph,document.sourceText,{includeQuality:false,sourceUnits})
  if(gate.blockingIssues.length)throw new Error('Audit rejected '+JSON.stringify(gate.blockingIssues.slice(0,6)))
  const originalNodes=new Set(document.graph.nodes.map(n=>n.id)),originalEdges=new Set(document.graph.edges.map(edgeKey)),removedKeys=new Set(removed.map(edgeKey))
  const request={documentId:DAO_DOCUMENT,expectedRevision:document.revision,baseNodeIds:[...changedNodes],baseEdgeKeys:[...new Set([...removedKeys,...changedEdges])],graph:{nodes:graph.nodes.filter(n=>changedNodes.has(n.id)||!originalNodes.has(n.id)),edges:graph.edges.filter(e=>!originalEdges.has(edgeKey(e))||changedEdges.has(edgeKey(e))||removedKeys.has(edgeKey(e)))}}
  const paragraphAudit=sourceUnits.map(u=>({paragraph:u.paragraph+1,sourceSha256:hash(u.text),originalNodes:document.graph.nodes.filter(n=>n.paragraph===u.paragraph).length,reviewedMappings:mappings.filter(m=>m.p===u.paragraph+1).map(m=>m.ruleId),status:u.paragraph<34||/【网页|# |【整理者|^[暂静]/.test(u.text)?'版本/编辑说明：保留出处，不作古代映射':/网站字形待核|\[[^\]]+\]/.test(u.text)?'含字形或用字疑义：保留原节点；新增映射仅取可逐字确认的完整句':'原句及既有关系已核对；清楚映射见清单，未为连通率补边'}))
  return {request,graph,audit:{version:2,documentId:DAO_DOCUMENT,parentRevision:document.revision,sourceUnitsSha256:hash(sourceUnits),reviewedParagraphs:paragraphAudit.length,reviewedOriginalRelations:document.graph.edges.length,legacyRelationsRemoved:legacy.length,mappings:mappings.length,models:models.size+allocationModels.length,beforeNodes:document.graph.nodes.length,afterNodes:graph.nodes.length,beforeEdges:document.graph.edges.length,afterEdges:graph.edges.length,evidenceCompleted,correctedNodes:[...changedNodes].filter(id=>!oldModelIds.has(id)),corrections:['不再使用自定义原文对应；关系和端点采用《学习观》定义','水胜刚、弱胜强的对照对象改为映射结果','舍葆必死的完整前提不拆成两条独立充分条件','六种相待、五种观照及为/成功的限定分开','天道人道的分配映射用关系对比，不使用概念不是','玄德同名异语境不混用定义；不从字面德建立属于','未将可以有国等可能性升级为下一步骤已经发生'],paragraphAudit,clauses:mappings}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: kg-dao-learning-audit.mjs fresh-snapshot.json prepared.json (dry run)')
 const data=JSON.parse(readFileSync(input,'utf8').replace(/^\uFEFF/,'')),result=prepareDaoLearningAudit(data.document,data.sourceUnits)
 writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...result.audit,clauses:undefined,paragraphAudit:undefined,evidenceCompleted:result.audit.evidenceCompleted.length}))
}
