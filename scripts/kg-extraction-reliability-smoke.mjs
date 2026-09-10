import assert from 'node:assert/strict'
import hostPlugin, { createGraphContract } from '../src/index.host.js'

const handlers = new Map()
let response, finish = 'stop'
let incompleteResponses = 0
let reasoningOnly = false
let supportedEfforts = []
let respond = null
const requests = []
globalThis.harness = { handle(name, fn) { handlers.set(name, fn) } }
hostPlugin().apply({
  get(name) { return name === 'llm' ? { async resolveModelInfo() { return {reasoning:{efforts:supportedEfforts.map(id=>({id}))}} }, async *stream(request) {
    requests.push(request)
    assert(!Object.hasOwn(request,'maxTokens'),'Plugin must leave output limits to the model service on every call')
    const incomplete = incompleteResponses > 0
    if (incomplete) incompleteResponses--
    if (reasoningOnly && incomplete) {
      yield {type:'reasoning-delta',index:0,text:'Still reasoning'}
      yield {type:'finish',reason:{kind:'stop'}}
      return
    }
    yield { type: 'text-delta', index: 0, text: respond ? respond(request) : response }
    yield { type: 'finish', reason: { kind: incomplete ? 'max-tokens' : finish } }
  } } : null },
  interval() { return () => {} },
})
const model = { provider: 'offline', model: 'reliability-fixture' }
async function completed(started) {
  assert(started.taskId, JSON.stringify(started))
  for (let i = 0; i < 2000; i++) {
    const status = await handlers.get('task-status')({ taskId: started.taskId })
    if (status.status !== 'running') { await new Promise(r => setTimeout(r, 0)); return status }
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('Fixture did not finish')
}
const text = '甲设备：其功率为10瓦。\n\n乙设备：其功率为10瓦。\n\n值为1.5；值为1，5。\n\n目标对象。'
const graph = { summary: 'Independent assertions', nodes: [
  { id: 'a', type: 'claim', text: '其功率为10瓦', quote: '其功率为10瓦', paragraph: 0 },
  { id: 'b', type: 'claim', text: '其功率为10瓦', quote: '其功率为10瓦', paragraph: 1 },
  { id: 'c', type: 'fact', text: '值为1.5', quote: '值为1.5', paragraph: 2 },
  { id: 'd', type: 'fact', text: '值为1，5', quote: '值为1，5', paragraph: 2 },
  { id: 'e', type: 'concept', text: '目标对象', quote: '目标对象', paragraph: 3 },
  { id: 'f', type: 'definition', text: '目标对象', quote: '目标对象', paragraph: 3 },
], edges: [] }
for (const mode of ['max-tokens', 'malformed', 'aborted']) {
  finish = mode === 'malformed' ? 'stop' : mode
  response = mode === 'malformed' ? JSON.stringify(graph).slice(0, -2) : JSON.stringify(graph)
  const result = await completed(await handlers.get('extract')({ title: mode, text, model }))
  assert.notEqual(result.status, 'succeeded', mode + ' must not publish incomplete knowledge')
  if (mode === 'max-tokens') assert.equal(result.error.code, 'output_truncated')
}
finish = 'stop'
response = JSON.stringify(graph)
const success = await completed(await handlers.get('extract')({ title: 'dedupe safety', text, model }))
assert.equal(success.status, 'succeeded', JSON.stringify(success.error))
assert.equal(success.result.nodes.length, 6, 'Context, numeric punctuation and different node roles must not merge')
for (const [efforts,expected] of [[['max','high'],'high'],[['high','low','medium'],'low'],[['vendor-auto'],undefined]]) {
  supportedEfforts=efforts
  requests.length=0
  const selected=await completed(await handlers.get('extract')({title:'bounded reasoning selection',text,model}))
  assert.equal(selected.status,'succeeded',JSON.stringify(selected.error))
  assert.equal(requests[0].reasoningEffort,expected,'Only choose a declared effort, never invent off/low support')
}
supportedEfforts=[]
requests.length = 0
incompleteResponses = 1
const recoveredOutput = await completed(await handlers.get('extract')({title:'complete response recovery',text,model}))
incompleteResponses = 0
assert.equal(recoveredOutput.status,'succeeded',JSON.stringify(recoveredOutput.error))
assert.equal(requests.filter(r=>r.system === requests[0].system).length,2,'Extraction retry must use a fresh complete response without imposing a token budget')
assert.equal(recoveredOutput.result.nodes.length,6,'Truncated candidate must not leak or replace the complete candidate')
requests.length = 0
reasoningOnly = true
incompleteResponses = 2
const recoveredReasoning = await completed(await handlers.get('extract')({title:'reasoning-only recovery',text,model}))
reasoningOnly = false
incompleteResponses = 0
assert.equal(recoveredReasoning.status,'succeeded',JSON.stringify(recoveredReasoning.error))
assert.equal(requests.filter(r=>r.system === requests[0].system).length,3)
assert.equal(recoveredReasoning.result.nodes.length,6)
requests.length = 0
reasoningOnly = true
incompleteResponses = Infinity
const missingCandidate = await completed(await handlers.get('extract')({title:'reasoning-only bounded failure',text,model}))
reasoningOnly = false
incompleteResponses = 0
assert.equal(missingCandidate.status,'failed')
assert.equal(missingCandidate.error.code,'reasoning_only')
assert.equal(requests.length,3,'Permanent failure must not cause unbounded retries')

// Long evidence cannot use the short verbatim fallback: recovery must actually
// repair the proposition, and persistent drift must remain a blocking failure.
const strengthSource = '学习者可能遗忘材料。' + '此处记录材料的使用背景。'.repeat(30)
const strengthCandidate = value => JSON.stringify({summary:'记忆',nodes:[{id:'n6',type:'claim',text:value,quote:strengthSource,paragraph:0}],edges:[]})
let strengthCalls = 0
respond = request => {
  strengthCalls++
  if (strengthCalls > 1) {
    const prompt = JSON.stringify(request.messages)
    assert(prompt.includes('可能'), 'Repair feedback must name the lost qualifier')
    assert(prompt.includes('semantic') || prompt.includes('node_semantic_strength_drift'))
    assert(prompt.includes('待修复数据=') && prompt.includes('学习者遗忘材料'), 'Repair must receive the rejected proposition and source context')
    assert(prompt.includes('不得仅机械添加限定词'), 'Repair must preserve meaning, not merely satisfy keyword checks')
  }
  return strengthCandidate(strengthCalls === 1 ? '学习者遗忘材料' : '学习者可能遗忘材料')
}
const strengthRecovered = await completed(await handlers.get('extract')({title:'semantic repair feedback',text:strengthSource,model}))
assert.equal(strengthRecovered.status,'succeeded',JSON.stringify(strengthRecovered.error))
assert.equal(strengthCalls,2)
assert.equal(strengthRecovered.result.nodes[0].text,'学习者可能遗忘材料')
respond = () => strengthCandidate('学习者遗忘材料')
const strengthRejected = await completed(await handlers.get('extract')({title:'persistent semantic drift',text:strengthSource,model}))
assert.equal(strengthRejected.status,'failed')
assert.equal(strengthRejected.error.code,'invariant_violation')
assert(strengthRejected.error.message.includes('待修复数据=') && strengthRejected.error.message.includes('可能'), 'Final failure must retain enough evidence to diagnose drift')
respond = null

const large = { summary: 'Dense report', nodes: Array.from({ length: 2000 }, (_, i) => ({ id: 'n' + i, type: 'fact', text: '相同记录', quote: '相同记录', paragraph: 0 })), edges: [] }
let ticks = 0
const interval = setInterval(() => { ticks++ }, 1)
const startedAt = performance.now()
let quick
try { quick = await handlers.get('verify-graph')({ text: '相同记录', graph: large, mode: 'quick' }) }
finally { clearInterval(interval) }
assert(quick.report, JSON.stringify(quick))
assert.equal(quick.report.metrics.checkedNodes, 2000)
assert.equal(quick.report.metrics.checkedPairs, 1999000, 'Cross-batch pairs must not be skipped')
assert.equal(quick.report.metrics.omittedPairIssues, 1998000, 'Bound report memory without concealing omitted findings')
assert(ticks > 1, 'Pair review must yield to timers/HTTP between batches')

response = JSON.stringify({ issues: [] })
requests.length = 0
const reviewGraph = {summary:'Cross-batch relation',nodes:Array.from({length:24},(_,i)=>({id:'v'+i,type:'claim',text:'记录'+i,quote:'相同记录',paragraph:0})),edges:[{fromNodeId:'v0',toNodeId:'v23',relation:'supports',evidence:[{paragraph:0,quote:'相同记录'}]}]}
const review = await completed(await handlers.get('verify-graph')({ text:'相同记录',graph:reviewGraph,mode:'standard',model }))
assert.equal(review.status, 'succeeded', JSON.stringify(review.error))
assert.equal(requests.length, 3, 'Two node batches and one cross-batch relation review are required')
for (const request of requests) assert(request.messages[0].content[0].text.includes('[P0] 相同记录'), 'Every batch must retain source evidence')
const relationPrompt = requests.at(-1).messages[0].content[0].text
assert(relationPrompt.includes('v23') && relationPrompt.includes('"evidence"'), 'Cross-batch review needs both endpoints and relation evidence')
const contract = createGraphContract()
const denseUnits = Array.from({length:100},(_,i)=>'独立记录 '+i+'。')
const denseText = denseUnits.join('\n\n')
const structured = contract.buildSourceManifest('density',denseText,denseUnits,'density-doc','density-source')
const legacy = contract.buildSourceManifest('density',denseText,denseUnits,'density-doc','density-source','legacy')
assert.equal(structured.batches.length,4)
assert.equal(legacy.batches.length,1,'Old checkpoints must keep their original partition')
assert.deepEqual(structured.batches.flatMap(batch=>batch.units.map(unit=>unit.num)),denseUnits.map((_,i)=>i),'Density partition must neither drop nor duplicate source units')
assert(structured.batches.every(batch=>batch.units.length<=32))
const headingUnits=['# 第一章','第一章正文。','# 第二章','第二章正文。']
const chapters=contract.buildSourceManifest('chapters',headingUnits.join('\n\n'),headingUnits)
assert.equal(chapters.batches.length,2,'Explicit chapters should not be merged into one prompt')
const minorUnits=Array.from({length:100},(_,i)=>['## 小节'+i,'这是小节'+i+'的正文。']).flat()
const minorText=minorUnits.join('\n\n')
const minorPacked=contract.buildSourceManifest('minor headings',minorText,minorUnits,'minor-doc','minor-source')
const minorOld=contract.buildSourceManifest('minor headings',minorText,minorUnits,'minor-doc','minor-source','structure-v1')
assert.equal(minorOld.batches.length,100,'Old checkpoint policy must retain its partition and chunk identities')
assert(minorPacked.batches.length < 10,'Short Markdown subheadings must not force a new model call each')
assert(minorPacked.batches.every(b=>b.units.length<=32),'Packing must retain the density ceiling')
assert.deepEqual(minorPacked.batches.flatMap(b=>b.units.map(u=>u.num)),minorUnits.map((_,i)=>i),'Packing must preserve every paragraph exactly once')
const absentSource = '本资料没有说明温度和颜色存在因果关系。'
const absentGate = contract.validateGraphInvariants({nodes:[{id:'a',type:'claim',text:'温度和颜色不存在因果关系。',quote:absentSource,paragraph:0}],edges:[]},absentSource)
assert(absentGate.blockingIssues.some(issue=>issue.code==='node_semantic_strength_drift'), 'Lack of evidence must not become evidence of absence')

let reviewMode = 'withhold'
const reviewPrompts = []
const relationSource = '温度升高。门是蓝色的。窗户关闭。'
hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? {
    weaveRelations: async () => ({edges:[{fromNodeId:'a',toNodeId:'b',relation:'causes',evidence:[{paragraph:0,quote:relationSource}]}]}),
    extractChunk: async () => ({summary:'relation review',nodes:[{id:'a',type:'fact',text:'温度升高',quote:'温度升高',paragraph:0},{id:'b',type:'fact',text:'门是蓝色的',quote:'门是蓝色的',paragraph:0},{id:'c',type:'fact',text:'窗户关闭',quote:'窗户关闭',paragraph:0}],edges:[{fromNodeId:'a',toNodeId:'b',relation:'causes',evidence:[{paragraph:0,quote:relationSource}]}]}),
    reviewRelations: async ({candidates,prompt,attempt}) => {
      reviewPrompts.push(prompt)
      return {verdicts:candidates.map((item,index)=>({
        id:reviewMode==='unknown-id' || (reviewMode==='recover' && attempt===0 && index===1)?'injected-id':item.id,
        verdict:reviewMode==='recover' && attempt===0 && index===0?'supported':'insufficient',
        reason:'Co-occurrence does not prove causality',
        evidence:reviewMode==='recover' && attempt===0 && index===0?[{paragraph:0,quote:relationSource}]:[],
      }))}
    },
  } : null }, interval() { return () => {} },
})
const withheld = await completed(await handlers.get('extract')({title:'review rejects false cause',text:relationSource}))
assert.equal(withheld.status,'succeeded',JSON.stringify(withheld.error))
assert.equal(withheld.result.edges.length,0)
assert.equal(withheld.result.generation.semanticReview.withheld.length,1)
assert.equal(withheld.result.generation.semanticReview.withheld[0].edge.relation,'causes','Rejected evidence/candidate must remain inspectable')
assert.equal(withheld.result.generation.coverage.semanticCoverage,'unverified','Anchors cannot certify proposition recall')
reviewMode='unknown-id'
const invalidReview = await completed(await handlers.get('extract')({title:'invalid reviewer response',text:relationSource}))
assert.equal(invalidReview.status,'succeeded',JSON.stringify(invalidReview.error))
assert.equal(invalidReview.result.generation.semanticReview.reviewed,0)
assert.equal(invalidReview.result.generation.semanticReview.pending,1)
assert.equal(invalidReview.result.generation.semanticReview.withheld.length,1,'Failed review must quarantine the complete candidate batch')
assert.equal(invalidReview.result.edges.length,0,'Invalid model response must not admit high-risk edges')
assert.equal(invalidReview.result.generation.semanticReview.withheld[0].verdict,'pending')
const retryReview = await completed(await handlers.get('relation-retry')({
  documentId: invalidReview.result.source.documentId,
  expectedRevision: invalidReview.result.revision,
}))
assert.equal(retryReview.status,'succeeded',JSON.stringify(retryReview.error))
assert.equal(retryReview.result.edges.length,0,'Relation retry must not bypass the high-risk review gate')
assert.equal(retryReview.result.generation.relationRetrySemanticReview.pending,1)
assert.equal(retryReview.result.generation.connectivity.addedEdges,0,'Withheld candidates are not accepted additions')
reviewMode='withhold'
const pendingOnly = await completed(await handlers.get('relation-retry')({
  documentId: retryReview.result.source.documentId,
  expectedRevision: retryReview.result.revision,
  reviewPendingOnly: true,
}))
assert.equal(pendingOnly.status,'succeeded',JSON.stringify(pendingOnly.error))
assert.equal(pendingOnly.result.edges.length,0)
assert.equal(pendingOnly.result.generation.relationRetrySemanticReview.reviewed,1,'Retry must recheck the persisted candidate without regenerating it')
assert.equal(pendingOnly.result.generation.relationRetrySemanticReview.pending,0)
assert.equal(pendingOnly.result.generation.relationReviewDecisions.length,1,'Keep the resolved rejection for inspection')
const resolvedAgain = await completed(await handlers.get('relation-retry')({
  documentId: pendingOnly.result.source.documentId,
  expectedRevision: pendingOnly.result.revision,
  reviewPendingOnly: true,
}))
assert.equal(resolvedAgain.status,'succeeded',JSON.stringify(resolvedAgain.error))
assert.equal(resolvedAgain.result.generation.relationRetrySemanticReview.eligible,0,'Resolved rejected candidates must not re-enter the pending queue')
assert.equal(resolvedAgain.result.generation.relationReviewDecisions.length,1,'Later retries must not erase past decisions')
const invalidMode = await handlers.get('relation-retry')({reviewPendingOnly:'false'})
assert.equal(invalidMode.error.code,'invalid_input')
const movedCandidate = structuredClone(resolvedAgain.result)
movedCandidate.generation.relationRetrySemanticReview = {
  withheld:[{verdict:'pending',edge:{fromNodeId:'a',toNodeId:'b',relation:'supports',evidence:[{paragraph:0,quote:relationSource}]}}],
}
const movedCommit = await handlers.get('graph-commit')({
  documentId: movedCandidate.source.documentId,
  expectedRevision: movedCandidate.revision,
  graph: movedCandidate,
  baseNodeIds: movedCandidate.nodes.map(node=>node.id),
  baseEdgeKeys: [],
})
assert(movedCommit.graph,JSON.stringify(movedCommit))
reviewMode='unknown-id'
const movedReview = await completed(await handlers.get('relation-retry')({
  documentId: movedCandidate.source.documentId,
  expectedRevision: movedCommit.revision,
  reviewPendingOnly: true,
}))
assert.equal(movedReview.status,'succeeded',JSON.stringify(movedReview.error))
assert.equal(movedReview.result.edges.length,0,'Pending status must require review even if current endpoints share a paragraph and relation is low-risk')
assert.equal(movedReview.result.generation.relationRetrySemanticReview.eligible,1)
assert.equal(movedReview.result.generation.relationRetrySemanticReview.pending,1)
assert.equal(movedReview.result.generation.relationRetrySemanticReview.retries.length,1,'An invalid response gets at most one corrective attempt')
const repairFixture = structuredClone(movedReview.result)
repairFixture.generation.relationRetrySemanticReview.withheld.push({verdict:'pending',edge:{fromNodeId:'a',toNodeId:'c',relation:'supports',evidence:[{paragraph:0,quote:relationSource}]}})
const repairCommit = await handlers.get('graph-commit')({
  documentId: repairFixture.source.documentId, expectedRevision: repairFixture.revision,
  graph: repairFixture, baseNodeIds: repairFixture.nodes.map(node=>node.id), baseEdgeKeys: [],
})
assert(repairCommit.graph,JSON.stringify(repairCommit))
reviewMode='recover'
reviewPrompts.length=0
const recovered = await completed(await handlers.get('relation-retry')({documentId:repairFixture.source.documentId,expectedRevision:repairCommit.revision,reviewPendingOnly:true}))
assert.equal(recovered.status,'succeeded',JSON.stringify(recovered.error))
assert.equal(reviewPrompts.length,2)
assert(reviewPrompts[1].includes('review_unknown_candidate_id'))
assert(!reviewPrompts[1].includes('injected-id'),'Untrusted response content must not become retry instructions')
assert.equal(recovered.result.generation.relationRetrySemanticReview.reviewed,2,'Only the complete valid response is applied')
assert.equal(recovered.result.generation.relationRetrySemanticReview.accepted.length,0,'A valid first verdict from an invalid batch must not leak into acceptance')
assert.equal(recovered.result.generation.relationRetrySemanticReview.errors.length,0)
assert.equal(recovered.result.edges.length,0)
console.log(JSON.stringify({ok:true,truncationRejected:true,dedupeScopeAndNumbers:true,reviewedNodes:2000,checkedPairs:1999000,timerTicks:ticks,reviewMs:Math.round(performance.now()-startedAt),crossBatchEvidence:true}))
