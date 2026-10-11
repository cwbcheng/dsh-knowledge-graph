import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json } from './kg-model-draft-diagnosis-fixture.mjs'

const smoke = process.argv.includes('--smoke'), current = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
if (!smoke) assert(process.argv[2], 'Usage: node scripts/kg-model-draft-diagnosis-benchmark.mjs <baseline-commit> or --smoke')
const baselineCommit = smoke ? null : execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim()
const sources = smoke ? [current] : [execFileSync('git', ['show', baselineCommit + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 }), current]
const sizes = smoke ? [{ slots: 40, branches: 40, examples: 100 }]
  : [{ slots: 2, branches: 3, examples: 3 }, { slots: 12, branches: 20, examples: 50 }, { slots: 40, branches: 40, examples: 100 }]
const tools = createModelStructureTools(), rows = []
const stats = values => { values.sort((a,b) => a-b); return { medianMs: values[7], p95Ms: values[14] } }
for (const size of sizes) {
  const fixture = modelBranchCountsFixture(size), harness = await modelLearningHarness({ fixture })
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), calls = sources.map(() => [])
  const views = sources.map((source, index) => draftDiagnosisView(source, harness, { observe: value => calls[index].push(value) }))
  let timingViews = []
  try {
    for (const view of views) { view.render(); await view.settle(); await view.flushDebounce() }
    const expected = json(calls[0].at(-1).report)
    for (const list of calls) {
      const last = list.at(-1)
      assert.deepEqual(json(last.report), expected)
      assert.deepEqual(json(last.report), tools.diagnose(json(last.spec), { ports: json(last.ports), names: json(last.names) }))
      list.splice(0)
    }
    for (let i = 0; i < 24; i++) for (const view of views) view.change('搜索槽位概念', 'query-' + i)
    const work = calls.map(list => list.length)
    assert.equal(work.at(-1), 0, 'unchanged query typing must not rescan the entire draft')
    if (!smoke) { assert.equal(work[0], 24); assert.deepEqual(json(calls[0].at(-1).report), expected) }
    for (const view of views) assert.equal(view.cache.size, 0)
    // All counters, parity assertions, database reads and UI lookup are
    // outside the alternating public-event/generated-render timing samples.
    if (!smoke) {
      timingViews = sources.map(source => draftDiagnosisView(source, harness))
      for (const view of timingViews) { view.render(); await view.settle(); await view.flushDebounce(); for (let i = 0; i < 10; i++) view.change('搜索槽位概念', 'warm-' + i) }
      const operations = timingViews.map(view => view.field('搜索槽位概念').props.onChange), samples = [[], []]
      for (let sample = 0; sample < 15; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now()
        for (let repeat = 0; repeat < 16; repeat++) { operations[index]({ target: { value: 'timing-' + sample + '-' + repeat } }); timingViews[index].render() }
        samples[index].push((performance.now() - start) / 16)
      }
      assert.deepEqual(json(timingViews[1].report()), json(timingViews[0].report()))
      rows.push({ ...size, draftCharacters: JSON.stringify(fixture.graph.nodes.find(n => n.id === 'taxi').modelStructure).length,
        baselineDiagnoses: work[0], currentDiagnoses: work[1], baseline: stats(samples[0]), current: stats(samples[1]) })
    } else rows.push({ ...size, unchangedRenderControls: 24, currentDiagnoses: work[0] })
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
    assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
    console.log(JSON.stringify(rows.at(-1)))
  } finally { for (const view of [...views, ...timingViews]) view.stop(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, smoke, baselineCommit, fullReportParity: true, unchangedDraftSearchReuse: true,
  generatedEditorActualHostReads: true, canonicalConditionsEvidenceAndLearningUnchanged: true,
  timing: smoke ? 'work_counts_only' : 'generated_editor_search_event_render_alternating_15x16_no_counters_no_io', noDomNetworkOrHeapClaim: true, rows }))
