import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { structureReadCallback } from './kg-model-draft-port-reuse-fixture.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json } from './kg-model-draft-diagnosis-fixture.mjs'

const smoke = process.argv.includes('--smoke'), current = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
if (!smoke) assert(process.argv[2], 'Usage: node scripts/kg-model-draft-port-reuse-benchmark.mjs <baseline-commit> or --smoke')
const baselineCommit = smoke ? null : execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim()
const sources = smoke ? [current] : [execFileSync('git', ['show', baselineCommit + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 }), current]
const sizes = smoke ? [{ slots: 40, branches: 40, examples: 100 }]
  : [{ slots: 2, branches: 3, examples: 3 }, { slots: 12, branches: 20, examples: 50 }, { slots: 40, branches: 40, examples: 100 }]
const tools = createModelStructureTools(), rows = [], stats = values => {
  values.sort((a, b) => a - b); return { medianMs: values[7], p95Ms: values[14] }
}
for (const size of sizes) {
  const fixture = modelBranchCountsFixture(size), harness = await modelLearningHarness({ fixture }), calls = sources.map(() => []), reads = sources.map(() => [])
  const views = sources.map((source, index) => draftDiagnosisView(source, harness, { observe: value => calls[index].push(value),
    transform(args, result) { if (args.structureEdit) reads[index].push(json(result)); return result },
  }))
  let timingViews = []
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    for (const view of views) { view.render(); await view.settle(); await view.flushDebounce() }
    const initial = calls.map(list => list.at(-1)), expected = json(initial[0].report), visible = json(views[0].report())
    for (const value of initial) {
      assert.deepEqual(json(value.report), expected)
      assert.deepEqual(json(value.report), tools.diagnose(json(value.spec), { ports: json(value.ports), names: json(value.names) }))
    }
    const starts = calls.map(list => list.length)
    for (let i = 0; i < 12; i++) for (const view of views) {
      view.props.active = false; view.render(); await view.settle()
      view.props.active = true; view.render(); await view.settle(); await view.flushDebounce()
      assert.deepEqual(json(view.report()), visible)
    }
    const work = calls.map((list, index) => list.length - starts[index]); assert.equal(work.at(-1), 0)
    if (!smoke) assert.equal(work[0], 12)
    for (let index = 0; index < views.length; index++) {
      assert.equal(reads[index].length, 13)
      for (const response of reads[index]) assert.deepEqual(response, reads[index][0])
      for (const value of calls[index]) assert.deepEqual(json(value.report), expected)
      assert.equal(calls[index].at(-1).spec, initial[index].spec); assert.equal(views[index].cache.size, 0)
    }
    let timing = null
    if (!smoke) {
      timingViews = sources.map(source => draftDiagnosisView(source, harness))
      for (const view of timingViews) { view.render(); await view.settle(); await view.flushDebounce() }
      const response = await harness.post({ documentId: fixture.documentId, expectedRevision: 1, modelId: 'taxi', structureEdit: true }, 'connection-models')
      const prepare = timingViews.map(structureReadCallback), samples = [[], []]
      for (let sample = -2; sample < 15; sample++) {
        const elapsed = [0, 0]
        for (let repeat = 0; repeat < 16; repeat++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
          const callback = await prepare[index](), freshResponse = json(response)
          // Match a newly parsed HTTP response, rather than sharing the same
          // ports array. Cloning and IO are outside callback/render timings.
          const start = performance.now(); callback(freshResponse); timingViews[index].render()
          elapsed[index] += performance.now() - start
        }
        if (sample >= 0) for (const index of [0, 1]) samples[index].push(elapsed[index] / 16)
      }
      assert.deepEqual(json(timingViews[0].report()), json(timingViews[1].report()))
      timing = { baseline: stats(samples[0]), current: stats(samples[1]) }
    }
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
    assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
    assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
    rows.push({ ...size, draftCharacters: JSON.stringify(initial[0].spec).length, portCharacters: JSON.stringify(initial[0].ports).length,
      actualIdenticalStructureResponses: 12, ...(smoke ? {} : { baselineDiagnoses: work[0] }), currentDiagnoses: work.at(-1), ...timing })
    console.log(JSON.stringify(rows.at(-1)))
  } finally { for (const view of [...views, ...timingViews]) view.stop(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, smoke, baselineCommit, equalFullDraftPortsReuse: true, fullDefensiveReportParity: true,
  generatedEditorActualHostReads: true, conditionsEvidenceBindingsAndCanonicalUnchanged: true,
  timing: smoke ? 'work_counts_only' : 'generated_structure_response_callback_render_alternating_15x16_counterless_fresh_parsed_host_results_prepared',
  noDomNetworkOrHeapClaim: true, rows }))
