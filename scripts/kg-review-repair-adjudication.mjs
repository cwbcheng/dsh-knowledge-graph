import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { evaluateReviewRun, fingerprintReviewGold } from './kg-review-benchmark.mjs'

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const statuses = new Set(['source_supported', 'source_unsafe', 'not_necessary', 'uncertain'])

export function createRepairAdjudicationTemplate(gold, run) {
  const frozen = evaluateReviewRun(gold, run)
  return { schemaVersion: 1, goldHash: fingerprintReviewGold(gold), runHash: digest(run),
    label: { status: 'draft', reviewer: '' },
    decisions: frozen.results.filter(item => item.unapprovedRepair).map(item => ({
      caseId: item.caseId, proposalHash: digest(item.proposedFix),
      status: 'uncertain', rationale: '', evidence: [],
    })) }
}

export function adjudicateUnapprovedRepairs(gold, run, adjudication) {
  const frozen = evaluateReviewRun(gold, run)
  const candidates = frozen.results.filter(item => item.unapprovedRepair)
  if (adjudication?.schemaVersion !== 1 ||
      adjudication.goldHash !== fingerprintReviewGold(gold) ||
      adjudication.runHash !== digest(run) ||
      !['codex-reviewed', 'human-reviewed'].includes(adjudication.label?.status) ||
      !adjudication.label?.reviewer || !Array.isArray(adjudication.decisions) ||
      adjudication.decisions.length !== candidates.length) {
    throw new Error('repair adjudication must cover the exact frozen gold and run')
  }
  const byCase = new Map(gold.cases.map(item => [item.id, item]))
  const byCandidate = new Map(candidates.map(item => [item.caseId, item]))
  const seen = new Set()
  const counts = { sourceSupported: 0, sourceUnsafe: 0, notNecessary: 0, uncertain: 0 }
  for (const decision of adjudication.decisions) {
    const candidate = byCandidate.get(decision?.caseId)
    const goldCase = byCase.get(decision?.caseId)
    if (!candidate || seen.has(decision.caseId) ||
        decision.proposalHash !== digest(candidate.proposedFix) ||
        !statuses.has(decision.status) || !decision.rationale ||
        !Array.isArray(decision.evidence) || !decision.evidence.length ||
        decision.evidence.some(ev => !Number.isInteger(ev?.paragraph) ||
          typeof ev.quote !== 'string' || !ev.quote ||
          !goldCase.sourceUnits.some(unit => unit.paragraph === ev.paragraph && unit.text.includes(ev.quote))) ||
        decision.status === 'source_supported' && candidate.expected !== 'confirmed') {
      throw new Error('invalid or mismatched unapproved-repair decision')
    }
    seen.add(decision.caseId)
    counts[{ source_supported: 'sourceSupported', source_unsafe: 'sourceUnsafe',
      not_necessary: 'notNecessary', uncertain: 'uncertain' }[decision.status]]++
  }
  return { schemaVersion: 1, datasetId: gold.datasetId, goldHash: adjudication.goldHash,
    runId: run.runId, runHash: adjudication.runHash,
    labelState: adjudication.label.status === 'codex-reviewed'
      ? 'codex_reviewed_not_human_confirmed' : 'human_reviewed_self_reported',
    frozenUnapprovedCount: candidates.length, posthocCounts: counts,
    decisions: adjudication.decisions, frozenApprovalUnchanged: true,
    note: 'Post-hoc source support is not pre-call approval, semantic proof, or permission to apply a patch.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? null : process.argv[i + 1] }
    const goldPath = arg('gold'), runPath = arg('run'), decisionsPath = arg('decisions'), output = arg('output')
    const template = process.argv.includes('--template')
    if (!goldPath || !runPath || !output || template === Boolean(decisionsPath)) {
      throw new Error('usage: --gold FROZEN_GOLD --run CAPTURED_RUN (--template | --decisions POSTHOC) --output NEW_FILE')
    }
    const gold = JSON.parse(readFileSync(goldPath, 'utf8'))
    const run = JSON.parse(readFileSync(runPath, 'utf8'))
    const report = template ? createRepairAdjudicationTemplate(gold, run) :
      adjudicateUnapprovedRepairs(gold, run, JSON.parse(readFileSync(decisionsPath, 'utf8')))
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
