import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fingerprintReviewGold } from './kg-review-benchmark.mjs'
import { adjudicateUnapprovedRepairs, createRepairAdjudicationTemplate } from './kg-review-repair-adjudication.mjs'

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-followup-gold-zh-v6.json', import.meta.url), 'utf8'))
const proposedFix = { action: 'update_node', nodePatch: { id: 'n1', patch: {
  text: '编辑写道，我们不能把林的经验判断当成已证实结论，也不据此建议所有课堂先展示答案。',
  quote: '我们不能把林的经验判断当成已证实结论，也不据此建议所有课堂先展示答案。',
  paragraph: 2 } } }
const run = { schemaVersion: 1, datasetId: gold.datasetId, goldHash: fingerprintReviewGold(gold),
  runId: 'controlled-unapproved-repair', model: 'fixture/controlled', promptVersion: 'controlled',
  measurementStatus: 'controlled_fixture', predictions: [{ caseId: 'b1:v1', verdict: 'confirmed', proposedFix }] }
const decision = { caseId: 'b1:v1', proposalHash: digest(proposedFix), status: 'source_supported',
  rationale: 'P2 explicitly rejects Lin\'s opinion as established; the proposed text attributes that rejection to the editor.',
  evidence: [{ paragraph: 2, quote: '我们不能把林的经验判断当成已证实结论' }] }
const adjudication = { schemaVersion: 1, goldHash: run.goldHash, runHash: digest(run),
  label: { status: 'codex-reviewed', reviewer: 'Codex controlled source pass' }, decisions: [decision] }
const template = createRepairAdjudicationTemplate(gold, run)
assert.equal(template.label.status, 'draft')
assert.equal(template.decisions[0].proposalHash, decision.proposalHash)
assert.throws(() => adjudicateUnapprovedRepairs(gold, run, template), /exact frozen/,
  'an unreviewed template cannot be reported as a Codex or human judgement')
const report = adjudicateUnapprovedRepairs(gold, run, adjudication)
assert.equal(report.frozenUnapprovedCount, 1)
assert.equal(report.posthocCounts.sourceSupported, 1)
assert.equal(report.frozenApprovalUnchanged, true)
assert.throws(() => adjudicateUnapprovedRepairs(gold, { ...run, runId: 'different' }, adjudication), /exact frozen/)
assert.throws(() => adjudicateUnapprovedRepairs(gold, run, { ...adjudication, decisions: [] }), /exact frozen/)
assert.throws(() => adjudicateUnapprovedRepairs(gold, run, { ...adjudication, decisions: [
  { ...decision, proposalHash: digest({ action: 'delete_node', nodePatch: { id: 'n1' } }) }] }), /mismatched/)
assert.throws(() => adjudicateUnapprovedRepairs(gold, run, { ...adjudication, decisions: [
  { ...decision, evidence: [{ paragraph: 0, quote: '我们不能把林的经验判断当成已证实结论' }] }] }), /mismatched/)
console.log(JSON.stringify({ frozenApprovalPreserved: true, runAndPatchHashFenced: true,
  completeDecisionsRequired: true, exactSourceEvidenceRequired: true }))
