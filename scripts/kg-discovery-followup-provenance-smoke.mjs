import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectedRequest, fingerprintReviewGold } from './kg-review-benchmark.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-followup-gold-zh-v6.json', import.meta.url), 'utf8'))
const model = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }
const proposedFix = { action: 'update_node', nodePatch: { id: 'n1', patch: {
  text: '编辑写道，我们不能把林的经验判断当成已证实结论，也不据此建议所有课堂先展示答案。',
  quote: '我们不能把林的经验判断当成已证实结论，也不据此建议所有课堂先展示答案。', paragraph: 2 } } }
const valid = { schemaVersion: 1, datasetId: gold.datasetId, goldHash: fingerprintReviewGold(gold),
  runId: 'controlled-attribution-followup', model, promptVersion: 'controlled',
  measurementStatus: 'controlled_fixture', cases: [{ caseId: 'b1:v1',
    request: expectedRequest(gold.cases[0], model), taskId: 'fixture-task', startedAtMs: 1, finishedAtMs: 2,
    taskStatus: { status: 'succeeded', result: { mode: 'issue_review', reviewedIssueId: 'b1:v1',
      target: { kind: 'node', id: 'n1' }, model, verdict: 'confirmed', proposedFix } } }], failures: [] }
const dir = mkdtempSync(join(tmpdir(), 'kg-followup-provenance-'))
const file = join(dir, 'capture.json')
const replay = () => spawnSync(process.execPath,
  [new URL('./kg-discovery-followup-repair-smoke.mjs', import.meta.url).pathname, file], { encoding: 'utf8' })
try {
  writeFileSync(file, JSON.stringify(valid))
  const control = replay()
  assert.equal(control.status, 0, control.stderr)
  const tampered = structuredClone(valid)
  tampered.cases[0].request.question = 'A different request was sent to the model'
  writeFileSync(file, JSON.stringify(tampered))
  const rejected = replay()
  assert.notEqual(rejected.status, 0, 'a response to a different request cannot prove this frozen issue repair')
  assert.match(rejected.stderr, /captured request does not match frozen gold case/)
  console.log(JSON.stringify({ originalCaptureAccepted: true, substitutedRequestRejected: true }))
} finally { rmSync(dir, { recursive: true, force: true }) }
