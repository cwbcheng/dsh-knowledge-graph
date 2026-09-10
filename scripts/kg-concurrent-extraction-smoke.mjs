import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as host from '../lib/index.js'

const dir = mkdtempSync('/tmp/kg-concurrency-')
const previousDb = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(dir, 'test.sqlite')
const cleanups = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function createHost(extractor, llm = null) {
  let api
  host.apply({get(name) {
    if (name === 'webServer') return {register(route) { if (route.path === '/api/dsh-knowledge-graph') api = route.handler; return () => {} }}
    if (name === 'kgExtractor') return extractor
    if (name === 'llm') return llm
    return null
  }, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} }})
  return api
}
function request(api, endpoint, body = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.headers = {}
    req.url = '/api/dsh-knowledge-graph/' + endpoint + (method === 'GET' ? '?' + new URLSearchParams(body) : '')
    const res = {setHeader() {}, writeHead() {}, end(data) { resolve(JSON.parse(data || '{}')) }}
    Promise.resolve(api(req,res)).catch(reject)
    process.nextTick(() => { if (method === 'POST') req.emit('data',Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
}
async function wait(api, started) {
  assert(started.taskId, JSON.stringify(started))
  for (let i=0;i<1000;i++) {
    const result = await request(api,'task-status',{taskId:started.taskId},'GET')
    if (result.status !== 'running') { await sleep(10); return result }
    await sleep(5)
  }
  throw new Error('Task never settled')
}
const source = ['甲','乙','丙','丁'].map((name,i)=>'# '+name+'\n\n'+name+'设备功率为'+(i+1)+'瓦。').join('\n\n')
const calls = [], digests = [], finishes = []
let active = 0, peak = 0, failFirst = true, reverse = true
let failureIndex = 0
async function extractor({chunk, existingDigest}) {
  const index = Number(chunk.chunkId.slice(-4)) - 1
  calls.push(index); digests.push({index, existingDigest})
  active++; peak = Math.max(peak,active)
  try {
    await sleep(reverse ? (index % 2 === 0 ? 60 : 10) : (index % 2 === 0 ? 10 : 60))
    if (failFirst && index === failureIndex) throw Object.assign(new Error('synthetic timeout'),{code:'timeout'})
    const unit = chunk.units.find(unit=>unit.text.includes('设备功率'))
    finishes.push(index)
    return {summary:'设备记录',nodes:[{id:'n1',type:'fact',text:unit.text,quote:unit.text,paragraph:unit.num}],edges:[]}
  } finally { active-- }
}
let store
try {
  const api1 = createHost(extractor)
  const started = await request(api1,'extract',{text:source,concurrency:2})
  const failed = await wait(api1,started)
  assert.equal(failed.status,'failed')
  assert.equal(failed.error.code,'timeout')
  assert.equal(peak,2)
  assert.deepEqual(calls,[0,1], 'Failure must stop new waves, but not discard the sibling')
  assert(digests.every(item=>item.existingDigest === ''), 'Workers must share the committed prefix')
  store = await openSqliteStore(process.env.DSH_KG_DB)
  const saved = store.loadCheckpoint(started.taskId)
  assert.equal(saved.checkpoint.nextBatchIndex,0)
  assert.deepEqual(Object.keys(saved.checkpoint.pendingWave.results),['1'])
  assert.equal(saved.checkpoint.pendingWave.results[1].norm.nodes.length,1)
  // Pre-stage-checkpoint releases stored complete results without a stage tag.
  delete saved.checkpoint.pendingWave.results[1].stage
  assert.equal(store.listDocuments().length,0, 'Partial wave must not publish a canonical document')
  const bad = structuredClone(saved.checkpoint)
  bad.pendingWave.contextHash = 'corrupted'
  store.saveCheckpoint(bad,{runId:started.taskId,status:'failed',sourceText:source})
  const api2 = createHost(extractor)
  const rejected = await wait(api2,await request(api2,'resume-extract',{runId:started.taskId,retryFailed:true}))
  assert.equal(rejected.error.code,'checkpoint_invalid')
  assert.deepEqual(calls,[0,1], 'Corrupted checkpoint must not dispatch calls')
  store.saveCheckpoint(saved.checkpoint,{runId:started.taskId,status:'failed',sourceText:source})
  failFirst = false
  const recovered = await wait(api2,await request(api2,'resume-extract',{runId:started.taskId,retryFailed:true}))
  assert.equal(recovered.status,'succeeded',JSON.stringify(recovered))
  assert.equal(calls.filter(i=>i===1).length,1, 'Saved out-of-order success must not be regenerated after restart')
  assert.equal(recovered.result.nodes.length,4)
  assert.deepEqual(recovered.result.nodes.map(n=>n.id),['n1','n2','n3','n4'])
  assert.equal(store.loadCheckpoint(started.taskId).checkpoint.pendingWave,undefined)
  const shape = graph => graph.nodes.map(({id,text,paragraph})=>({id,text,paragraph}))
  calls.length=0; peak=0; reverse=false
  const ordered = await wait(api2,await request(api2,'extract',{text:source,concurrency:2}))
  assert.equal(ordered.status,'succeeded',JSON.stringify(ordered))
  assert.deepEqual(shape(ordered.result),shape(recovered.result), 'Return order must not change canonical numbering')
  peak=0
  const four = await wait(api2,await request(api2,'extract',{text:source,concurrency:4}))
  assert.equal(four.status,'succeeded')
  assert.equal(peak,4)
  assert.deepEqual(shape(four.result),shape(recovered.result))
  peak=0
  const serial = await wait(api2,await request(api2,'extract',{text:source,concurrency:1}))
  assert.equal(serial.status,'succeeded')
  assert.equal(peak,1, 'Serial control must actually dispatch one request at a time')
  assert.deepEqual(shape(serial.result),shape(recovered.result))
  calls.length=0; failFirst=true; failureIndex=2
  const laterStart = await request(api2,'extract',{text:source,concurrency:2})
  const laterFailed = await wait(api2,laterStart)
  assert.equal(laterFailed.status,'failed')
  const laterSaved = store.loadCheckpoint(laterStart.taskId)
  assert.equal(laterSaved.checkpoint.nextBatchIndex,2)
  assert.deepEqual(Object.keys(laterSaved.checkpoint.pendingWave.results),['3'])
  failFirst=false
  const api3 = createHost(extractor)
  const laterResumed = await wait(api3,await request(api3,'resume-extract',{runId:laterStart.taskId,retryFailed:true}))
  assert.equal(laterResumed.status,'succeeded',JSON.stringify(laterResumed))
  assert.equal(calls.filter(i=>i===3).length,1)
  assert.deepEqual(shape(laterResumed.result),shape(recovered.result),'Restored nonempty prefix must preserve the wave fingerprint and ids')
  let streams=0, aborted=0
  const cancelApi = createHost(null,{async *stream(options) {
    assert(!Object.hasOwn(options,'maxTokens'))
    streams++
    await new Promise(resolve=>options.signal.addEventListener('abort',()=>{aborted++;resolve()},{once:true}))
  }})
  const cancelling = await request(cancelApi,'extract',{text:source,concurrency:2,model:{provider:'fake',model:'fake'}})
  for (let i=0;i<100 && streams<2;i++) await sleep(5)
  assert.equal(streams,2)
  await request(cancelApi,'task-cancel',{taskId:cancelling.taskId})
  const cancelled = await wait(cancelApi,cancelling)
  assert.equal(cancelled.status,'cancelled')
  assert.equal(aborted,2,'Cancellation must abort every concurrent stream, not only the last one')
  assert.equal(store.loadCheckpoint(cancelling.taskId).checkpoint.nextBatchIndex,0)
  const realSetTimeout = globalThis.setTimeout
  let rateCalls=0, laterActive=0, laterPeak=0, backoffs=0
  const rateApi = createHost(async args => {
    const index=Number(args.chunk.chunkId.slice(-4))-1
    if (index===0 && rateCalls++===0) throw Object.assign(new Error('quota exhausted'),{code:'RATE_LIMIT'})
    if (index>=2) { laterActive++;laterPeak=Math.max(laterPeak,laterActive) }
    try { return await extractor(args) } finally { if (index>=2) laterActive-- }
  })
  try {
    globalThis.setTimeout=(fn,ms,...args)=>{
      if (ms>=30000 && ms<31000) { backoffs++; return realSetTimeout(fn,5,...args) }
      return realSetTimeout(fn,ms,...args)
    }
    const limited=await wait(rateApi,await request(rateApi,'extract',{text:source,concurrency:2}))
    assert.equal(limited.status,'succeeded',JSON.stringify(limited))
    assert.equal(backoffs,1)
    assert.equal(laterPeak,1,'Rate limiting must reduce subsequent waves to serial execution')
  } finally { globalThis.setTimeout=realSetTimeout }
  const coverageText = [
    '以感觉懂了驱动学习时，人无法根据明确目标判断学习是否完成。',
    '因为无法判断是否完成，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束。',
    '这样又容易把记住讲解误认为学会知识。',
    '学习者因此无法根据已经完成的程度接着学习。',
    '于是复习实质上变成重新学习。',
    '最终学得越多，负担越重，形成高消耗、低回报。',
  ].join('\n\n')
  let primaryCalls=0, coverageCalls=0, coverageFails=true
  const coverageExtractor = {
    async extractChunk() {
      primaryCalls++
      return {summary:'学习记录',nodes:[{id:'n1',type:'claim',text:'最终学得越多，负担越重，形成高消耗、低回报。',quote:'最终学得越多，负担越重，形成高消耗、低回报。',paragraph:5}],edges:[]}
    },
    async reviewCoverage(args) {
      coverageCalls++
      if (coverageFails) {
        args.graph.nodes[0].text='mutated failed candidate'
        throw Object.assign(new Error('synthetic coverage timeout'),{code:'timeout'})
      }
      return {nodes:[],edges:[]}
    },
  }
  const coverageApi = createHost(coverageExtractor)
  const coverageStart = await request(coverageApi,'extract',{text:coverageText})
  const coverageFailed = await wait(coverageApi,coverageStart)
  assert.equal(coverageFailed.error.code,'timeout')
  const prepared = store.loadCheckpoint(coverageStart.taskId).checkpoint.pendingWave.results[0]
  assert.equal(prepared.stage,'coverage_pending')
  assert.equal(prepared.norm.nodes[0].text,'最终学得越多，负担越重，形成高消耗、低回报。')
  const coverageList=await request(coverageApi,'extraction-run-list')
  const row=coverageList.runs.find(run=>run.runId===coverageStart.taskId)
  assert.equal(row.preparedBatches,1)
  assert.equal(row.bufferedBatches,0,'Prepared extraction is not a fully accepted batch')
  const coverageRestart=createHost(coverageExtractor)
  const failedAgain=await wait(coverageRestart,await request(coverageRestart,'resume-extract',{runId:coverageStart.taskId,retryFailed:true}))
  assert.equal(failedAgain.error.code,'timeout')
  assert.equal(primaryCalls,1,'Repeated coverage failures must not regenerate the accepted extraction')
  coverageFails=false
  const coverageRecovered=await wait(coverageRestart,await request(coverageRestart,'resume-extract',{runId:coverageStart.taskId,retryFailed:true}))
  assert.equal(coverageRecovered.status,'succeeded',JSON.stringify(coverageRecovered))
  assert.equal(primaryCalls,1)
  assert.equal(coverageCalls,3)
  assert.equal(coverageRecovered.result.generation.initial.nodes,1)
  assert.equal(coverageRecovered.result.generation.coverage.attemptedBatches,1)
  console.log(JSON.stringify({ok:true,peak:2,orderedMerge:true,durableOutOfOrderResult:true,restartOnlyRetriesFailedBatch:true,corruptCheckpointRejected:true,serialOption:true,coverageStageRecovery:true}))
} finally {
  store?.close()
  for (const cleanup of cleanups.reverse()) await cleanup()
  if (previousDb === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDb
  rmSync(dir,{recursive:true,force:true})
}
