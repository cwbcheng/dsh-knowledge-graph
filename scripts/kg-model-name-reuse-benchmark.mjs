import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { conceptReadCallback } from './kg-model-name-reuse-fixture.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json } from './kg-model-draft-diagnosis-fixture.mjs'
const smoke = process.argv.includes('--smoke'), current = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
if (!smoke) assert(process.argv[2], 'Usage: node scripts/kg-model-name-reuse-benchmark.mjs <baseline-commit> or --smoke')
const baselineCommit = smoke ? null : execFileSync('git', ['rev-parse','--verify',process.argv[2] + '^{commit}'], { encoding:'utf8' }).trim()
const sources = smoke ? [current] : [execFileSync('git',['show',baselineCommit + ':extension/viewer.js'], { encoding:'utf8',maxBuffer:8e6 }), current]
const sizes = smoke ? [{ slots:40,branches:40,examples:100 }] : [{ slots:2,branches:3,examples:3 },{ slots:12,branches:20,examples:50 },{ slots:40,branches:40,examples:100 }]
const tools = createModelStructureTools(), rows = [], stats = values => { values.sort((a,b) => a-b); return { medianMs:values[7],p95Ms:values[14] } }
for (const size of sizes) {
  const fixture = modelBranchCountsFixture(size), harness = await modelLearningHarness({ fixture }), calls = sources.map(() => []), counts = sources.map(() => 0)
  const views = sources.map((source,index) => draftDiagnosisView(source,harness,{ observe:value => calls[index].push(value), transform(args,result) { if (args.concepts) counts[index]++; return result } }))
  let timingViews = []
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
    for (const view of views) { view.render(); await view.settle(); await view.flushDebounce() }
    const expected = json(calls[0].at(-1).report), visible = json(views[0].report()), readStart = [...counts]
    for (const list of calls) { const last = list.at(-1); assert.deepEqual(json(last.report),expected); assert.deepEqual(json(last.report),tools.diagnose(json(last.spec),{ ports:json(last.ports),names:json(last.names) })); list.splice(0) }
    for (let i = 0; i < 24; i++) for (const view of views) { view.change('搜索槽位概念',i % 2 ? '行驶' + ' '.repeat(i + 1) : 'absent-concept-' + i); await view.flushDebounce(); assert.deepEqual(json(view.report()),visible) }
    const work = calls.map(list => list.length); assert.equal(work.at(-1),0)
    if (!smoke) { assert.equal(work[0],24); for (const value of calls[0]) assert.deepEqual(json(value.report),expected) }
    for (let i = 0; i < counts.length; i++) assert.equal(counts[i] - readStart[i],24)
    for (const view of views) assert.equal(view.cache.size,0)
    if (!smoke) {
      timingViews = sources.map(source => draftDiagnosisView(source,harness))
      for (const view of timingViews) { view.render(); await view.settle(); await view.flushDebounce() }
      const responses = await Promise.all(['absent-concept','行驶'].map(query => harness.post({ documentId:fixture.documentId,expectedRevision:1,concepts:true,query,offset:0 },'connection-models')))
      assert.equal(responses[0].items.length,0); assert(responses[1].items.some(item => item.nodeId === 'distance'))
      const prepare = timingViews.map(conceptReadCallback), samples = [[],[]]
      for (let sample = -2; sample < 15; sample++) {
        const elapsed = [0,0]
        for (let repeat = 0; repeat < 16; repeat++) for (const index of sample % 2 ? [1,0] : [0,1]) {
          const callback = await prepare[index](repeat % 2 ? '行驶' + ' '.repeat(repeat + 1) : 'absent-concept-' + repeat), response = responses[repeat % 2]
          const start = performance.now(); callback(response); timingViews[index].render(); elapsed[index] += performance.now() - start
        }
        if (sample >= 0) for (const index of [0,1]) samples[index].push(elapsed[index] / 16)
      }
      assert.deepEqual(json(timingViews[0].report()),json(timingViews[1].report()))
      rows.push({ ...size,draftCharacters:JSON.stringify(fixture.graph.nodes.find(node => node.id === 'taxi').modelStructure).length,actualNameResponses:24,baselineDiagnoses:work[0],currentDiagnoses:work[1],baseline:stats(samples[0]),current:stats(samples[1]) })
    } else rows.push({ ...size,actualNameResponses:24,currentDiagnoses:work[0] })
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)),before); assert.equal(harness.store.getDocumentRevision(fixture.documentId),1)
    assert.deepEqual((await harness.post({ action:'attempts',documentId:fixture.documentId,modelId:'taxi' })).attempts,[])
    console.log(JSON.stringify(rows.at(-1)))
  } finally { for (const view of [...views,...timingViews]) view.stop(); harness.stop() }
}
console.log(JSON.stringify({ ok:true,smoke,baselineCommit,equalAndEmptyNameReadReuse:true,fullReportParity:true,generatedEditorActualHostReads:true,
  conditionsEvidenceBindingsAndCanonicalUnchanged:true,timing:smoke ? 'work_counts_only' : 'generated_concept_response_callback_render_alternating_15x16_counterless_host_results_prepared',noDomNetworkOrHeapClaim:true,rows }))
