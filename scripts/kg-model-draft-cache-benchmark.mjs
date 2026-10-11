import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { draftCacheView, reloadDraftCache } from './kg-model-draft-cache-fixture.mjs'
import { structureReadCallback } from './kg-model-draft-port-reuse-fixture.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json } from './kg-model-draft-diagnosis-fixture.mjs'

const smoke = process.argv.includes('--smoke'), current = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
if (!smoke) assert(process.argv[2], 'Usage: node scripts/kg-model-draft-cache-benchmark.mjs <baseline-commit> or --smoke')
const baselineCommit = smoke ? null : execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim()
const sources = smoke ? [current] : [execFileSync('git', ['show', baselineCommit + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 }), current]
const sizes = smoke ? [{ slots: 40, branches: 40, examples: 100 }]
  : [{ slots: 2, branches: 3, examples: 3 }, { slots: 12, branches: 20, examples: 50 }, { slots: 40, branches: 40, examples: 100 }]
const tools = createModelStructureTools(), rows = [], stats = values => {
  values.sort((a, b) => a - b); return { medianMs: values[7], p95Ms: values[14] }
}
for (const size of sizes) {
  const fixture = modelBranchCountsFixture(size), harness = await modelLearningHarness({ fixture }), calls = sources.map(() => []), reads = sources.map(() => [])
  const views = sources.map((source, index) => draftCacheView(source, harness, { observe: value => calls[index].push(value),
    transform(args, result) { if (args.structureEdit) reads[index].push(json(result)); return result },
  }))
  let timingViews = []
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    for (const view of views) {
      view.render(); await view.settle(); await view.flushDebounce(); view.change('槽位名称 slot-0', '')
      await reloadDraftCache(view)
    }
    const initial = calls.map(list => list.at(-1)), expected = json(initial[0].report), visible = json(views[0].report())
    for (const value of initial) {
      assert.deepEqual(json(value.report), expected)
      assert.deepEqual(json(value.report), tools.diagnose(json(value.spec), { ports: json(value.ports), names: json(value.names) }))
    }
    const starts = views.map(view => ({ ...view.work })), callStarts = calls.map(list => list.length), raw = [...views[0].cache.values()][0]
    for (let i = 0; i < 12; i++) for (const view of views) {
      await reloadDraftCache(view); assert.deepEqual(json(view.report()), visible); assert.equal([...view.cache.values()][0], raw)
    }
    const work = views.map((view, index) => ({ parses: view.work.parses - starts[index].parses, validations: view.work.validations - starts[index].validations }))
    assert.deepEqual(work.at(-1), { parses: 0, validations: 0 })
    if (!smoke) assert.deepEqual(work[0], { parses: 12, validations: 12 })
    for (let index = 0; index < views.length; index++) {
      assert.equal(reads[index].length, 14)
      for (const response of reads[index]) assert.deepEqual(response, reads[index][0])
      assert.equal(calls[index].length, callStarts[index]); assert.equal(calls[index].at(-1).spec, initial[index].spec)
    }
    let timing = null
    if (!smoke) {
      timingViews = sources.map(source => draftDiagnosisView(source, harness))
      for (const view of timingViews) {
        view.render(); await view.settle(); await view.flushDebounce(); view.change('槽位名称 slot-0', ''); await reloadDraftCache(view)
      }
      const response = await harness.post({ documentId: fixture.documentId, expectedRevision: 1, modelId: 'taxi', structureEdit: true }, 'connection-models')
      const prepare = timingViews.map(structureReadCallback), samples = [[], []], cacheKeys = timingViews.map(view => [...view.cache.keys()][0])
      for (let sample = -2; sample < 15; sample++) {
        const elapsed = [0, 0]
        for (let repeat = 0; repeat < 16; repeat++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
          const callback = await prepare[index](), freshResponse = json(response)
          // Prepare an independently decoded, equal storage string outside
          // timings; the actual callback still compares its complete value.
          timingViews[index].cache.set(cacheKeys[index], json(raw))
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
    rows.push({ ...size, privateCacheCharacters: raw.length, actualIdenticalStructureResponses: 12,
      ...(smoke ? {} : { baselineWork: work[0] }), currentWork: work.at(-1), extraFullDiagnoses: 0, ...timing })
    console.log(JSON.stringify(rows.at(-1)))
  } finally { for (const view of [...views, ...timingViews]) view.stop(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, smoke, baselineCommit, equalPrivateCacheParsingAndShapeReused: true,
  actualGeneratedEditorAndHost: true, privateDraftAndFullDefensiveReportParity: true, conditionsEvidenceBindingsAndCanonicalUnchanged: true,
  timing: smoke ? 'work_counts_only' : 'counterless_generated_callback_render_alternating_15x16_fresh_host_response_and_storage_string_prepared',
  noBrowserStorageNetworkDomOrHeapClaim: true, rows }))
