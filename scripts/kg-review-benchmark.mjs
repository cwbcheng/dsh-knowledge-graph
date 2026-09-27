#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const VERDICTS = new Set(['confirmed', 'false_positive', 'uncertain'])

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function stableJson(value) { return JSON.stringify(canonical(value)) }
function fail(message) { throw new Error('review benchmark: ' + message) }
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 }
function existingPathOrResolved(path) {
  try { return realpathSync(path) } catch { return resolve(path) }
}

function validateGold(gold) {
  if (gold?.schemaVersion !== 1 || typeof gold.datasetId !== 'string' || !gold.datasetId ||
      !Array.isArray(gold.cases) || gold.cases.length === 0) fail('gold needs schemaVersion 1, datasetId and nonempty cases')
  const ids = new Set()
  for (const item of gold.cases) {
    if (typeof item?.id !== 'string' || !item.id || ids.has(item.id)) fail('case IDs must be unique nonempty strings')
    ids.add(item.id)
    if (typeof item.category !== 'string' || !item.category ||
        !Array.isArray(item.sourceUnits) || !item.sourceUnits.length ||
        item.sourceUnits.some(unit => !nonnegativeInteger(unit?.paragraph) || typeof unit.text !== 'string') ||
        !Array.isArray(item.graph?.nodes) || !Array.isArray(item.graph?.edges) ||
        typeof item.allegation?.issueId !== 'string' || !item.allegation.issueId ||
        typeof item.allegation?.title !== 'string' || !item.allegation.title ||
        !['node', 'edge', 'graph'].includes(item.allegation?.targetKind) ||
        typeof item.input?.text !== 'string' ||
        typeof item.input?.question !== 'string' || !item.input.question ||
        typeof item.input?.detail !== 'string' || !item.input.detail ||
        !Array.isArray(item.input?.evidence) ||
        !VERDICTS.has(item.gold?.verdict) || !Array.isArray(item.gold?.allowedFixes) ||
        item.gold.allowedFixes.length === 0 ||
        item.gold.allowedFixes.some(fix => typeof fix?.action !== 'string' || !fix.action) ||
        !['draft', 'human-reviewed'].includes(item.label?.status) ||
        typeof item.label?.rationale !== 'string' || !item.label.rationale) fail('invalid case ' + item.id)
    if (item.label.status === 'human-reviewed' &&
        (!item.label.reviewer || !item.label.reviewedAt)) fail('human-reviewed case needs reviewer and reviewedAt: ' + item.id)
    if (item.gold.verdict !== 'confirmed' &&
        item.gold.allowedFixes.some(fix => fix.action !== 'none')) fail('unconfirmed case cannot approve a repair: ' + item.id)
    const paragraphs = new Map()
    for (const unit of item.sourceUnits) {
      if (paragraphs.has(unit.paragraph)) fail('duplicate source paragraph: ' + item.id)
      paragraphs.set(unit.paragraph, unit.text)
    }
    if (item.input.evidence.some(evidence => !nonnegativeInteger(evidence?.paragraph) ||
        typeof evidence.quote !== 'string' || !evidence.quote ||
        !paragraphs.get(evidence.paragraph)?.includes(evidence.quote))) {
      fail('input evidence is not in its source unit: ' + item.id)
    }
    const nodeIds = new Set()
    for (const node of item.graph.nodes) {
      if (typeof node?.id !== 'string' || !node.id || nodeIds.has(node.id)) fail('duplicate or invalid node: ' + item.id)
      nodeIds.add(node.id)
      if (typeof node.quote === 'string' && node.quote &&
          !paragraphs.get(node.paragraph)?.includes(node.quote)) fail('graph quote is not in its source unit: ' + item.id)
    }
    if (item.graph.edges.some(edge => !nodeIds.has(edge?.fromNodeId) || !nodeIds.has(edge?.toNodeId))) {
      fail('edge endpoint is missing: ' + item.id)
    }
    if (item.allegation.targetKind === 'node' && !nodeIds.has(item.allegation.targetId)) {
      fail('allegation target node is missing: ' + item.id)
    }
    if (item.allegation.targetKind === 'edge' && !item.graph.edges.some(edge =>
      edge.fromNodeId + '>' + edge.toNodeId === item.allegation.targetId)) {
      fail('allegation target edge is missing: ' + item.id)
    }
  }
  return gold
}

export function fingerprintReviewGold(gold) {
  validateGold(gold)
  return createHash('sha256').update(stableJson(gold)).digest('hex')
}

function validateRun(gold, run) {
  const goldHash = fingerprintReviewGold(gold)
  if (run?.schemaVersion !== 1 || run.datasetId !== gold.datasetId || run.goldHash !== goldHash ||
      typeof run.runId !== 'string' || !run.runId || typeof run.model !== 'string' || !run.model ||
      typeof run.promptVersion !== 'string' || !run.promptVersion ||
      !['controlled_fixture', 'reported_real_run'].includes(run.measurementStatus) ||
      !Array.isArray(run.predictions)) {
    fail('run schema, datasetId or goldHash mismatch')
  }
  const ids = new Set(gold.cases.map(item => item.id))
  const seen = new Set()
  for (const item of run.predictions) {
    if (typeof item?.caseId !== 'string' || !ids.has(item.caseId)) fail('unknown case in run: ' + item?.caseId)
    if (seen.has(item.caseId)) fail('duplicate prediction: ' + item.caseId)
    seen.add(item.caseId)
    if (!VERDICTS.has(item.verdict) || typeof item.proposedFix?.action !== 'string') fail('invalid prediction: ' + item.caseId)
    if ([item.requestHash, item.traceHash].some(hash => hash != null &&
        (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)))) fail('invalid trace hash: ' + item.caseId)
    if (item.usage != null && (!nonnegativeInteger(item.usage.inputTokens) ||
        !nonnegativeInteger(item.usage.outputTokens) || !nonnegativeInteger(item.usage.elapsedMs) ||
        item.usage.cachedInputTokens != null && !nonnegativeInteger(item.usage.cachedInputTokens))) {
      fail('invalid usage for ' + item.caseId)
    }
  }
  if (seen.size !== ids.size) fail('run must be complete; missing predictions: ' +
    [...ids].filter(id => !seen.has(id)).join(', '))
  return run
}

function rate(numerator, denominator) { return denominator ? numerator / denominator : null }

function expectedRequest(item, model) {
  return { graph: item.graph, text: item.input.text, sourceUnits: item.sourceUnits,
    question: item.input.question,
    target: { kind: item.allegation.targetKind, id: item.allegation.targetId },
    reviewIssue: { id: item.allegation.issueId, title: item.allegation.title,
      detail: item.input.detail, targetKind: item.allegation.targetKind,
      targetId: item.allegation.targetId, evidence: item.input.evidence }, model }
}

export function captureReviewRun(gold, capture) {
  const hash = fingerprintReviewGold(gold)
  if (capture?.schemaVersion !== 1 || capture.datasetId !== gold.datasetId || capture.goldHash !== hash ||
      typeof capture.runId !== 'string' || !capture.runId ||
      typeof capture.promptVersion !== 'string' || !capture.promptVersion ||
      typeof capture.model?.provider !== 'string' || !capture.model.provider ||
      typeof capture.model?.model !== 'string' || !capture.model.model ||
      !['controlled_fixture', 'reported_real_run'].includes(capture.measurementStatus) ||
      !Array.isArray(capture.cases)) fail('invalid captured run identity or goldHash')
  const expected = new Map(gold.cases.map(item => [item.id, item]))
  const seen = new Set()
  const predictions = capture.cases.map(entry => {
    const item = expected.get(entry?.caseId)
    if (!item || seen.has(entry.caseId)) fail('unknown or duplicate captured case: ' + entry?.caseId)
    seen.add(entry.caseId)
    const request = expectedRequest(item, capture.model)
    if (stableJson(entry.request) !== stableJson(request)) {
      fail('captured request does not match frozen gold case: ' + entry.caseId)
    }
    if (!nonnegativeInteger(entry.startedAtMs) || !nonnegativeInteger(entry.finishedAtMs) ||
        entry.finishedAtMs < entry.startedAtMs) fail('invalid capture time for ' + entry.caseId)
    const status = entry.taskStatus
    const result = status?.result
    if (status?.status !== 'succeeded' || result?.mode !== 'issue_review' ||
        !VERDICTS.has(result.verdict) || typeof result.proposedFix?.action !== 'string') {
      fail('captured task is not a successful issue review: ' + entry.caseId)
    }
    if (result.model?.provider !== capture.model.provider || result.model?.model !== capture.model.model) {
      fail('captured model does not match run identity: ' + entry.caseId)
    }
    const target = result.target
    if (result.reviewedIssueId !== item.allegation.issueId) {
      fail('captured review issue does not match gold case: ' + entry.caseId)
    }
    if (item.allegation.targetKind !== 'graph' &&
        (target?.kind !== item.allegation.targetKind || target?.id !== item.allegation.targetId)) {
      fail('captured review target does not match gold case: ' + entry.caseId)
    }
    const requestCount = status.modelUsage?.finishedRequests
    const input = status.modelUsage?.totals?.totalInputTokens
    const output = status.modelUsage?.totals?.outputTokens
    const complete = nonnegativeInteger(requestCount) && requestCount > 0 &&
      status.modelUsage.startedRequests === requestCount &&
      status.modelUsage.reportedRequests === requestCount &&
      nonnegativeInteger(input?.tokens) && input.requests === requestCount &&
      nonnegativeInteger(output?.tokens) && output.requests === requestCount
    const cached = status.modelUsage?.totals?.cacheReadTokens
    const usage = complete ? { inputTokens: input.tokens, outputTokens: output.tokens,
      elapsedMs: entry.finishedAtMs - entry.startedAtMs,
      ...(nonnegativeInteger(cached?.tokens) && cached.requests === requestCount ?
        { cachedInputTokens: cached.tokens } : {}) } : null
    return { caseId: entry.caseId, verdict: result.verdict, proposedFix: result.proposedFix, usage,
      requestHash: createHash('sha256').update(stableJson(entry.request)).digest('hex'),
      traceHash: createHash('sha256').update(stableJson(status)).digest('hex') }
  })
  if (seen.size !== expected.size) fail('captured run must be complete; missing cases: ' +
    [...expected.keys()].filter(id => !seen.has(id)).join(', '))
  const run = { schemaVersion: 1, datasetId: gold.datasetId, goldHash: hash,
    runId: capture.runId, model: capture.model.provider + '/' + capture.model.model,
    promptVersion: capture.promptVersion, measurementStatus: capture.measurementStatus, predictions }
  validateRun(gold, run)
  return run
}

export function evaluateReviewRun(gold, run) {
  validateRun(gold, run)
  const byId = new Map(run.predictions.map(item => [item.caseId, item]))
  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0, positiveAbstain: 0, negativeAbstain: 0 }
  let goldUncertain = 0, unsafeRepairProposals = 0, unmatchedConfirmedRepairs = 0, missedApprovedRepairs = 0
  const cost = { complete: true, observedCases: 0, totalCases: gold.cases.length,
    inputTokens: 0, outputTokens: 0, elapsedMs: 0, cachedInputTokens: 0, cachedComplete: true }
  const results = gold.cases.map(item => {
    const predicted = byId.get(item.id)
    const expected = item.gold.verdict
    if (expected === 'confirmed') {
      if (predicted.verdict === 'confirmed') confusion.tp++
      else if (predicted.verdict === 'false_positive') confusion.fn++
      else confusion.positiveAbstain++
    } else if (expected === 'false_positive') {
      if (predicted.verdict === 'confirmed') confusion.fp++
      else if (predicted.verdict === 'false_positive') confusion.tn++
      else confusion.negativeAbstain++
    } else goldUncertain++
    const hasFix = predicted.proposedFix.action !== 'none'
    const approved = item.gold.allowedFixes.some(fix => stableJson(fix) === stableJson(predicted.proposedFix))
    const unsafe = expected !== 'confirmed' && hasFix
    const unmatched = expected === 'confirmed' && hasFix && !approved
    const missedRepair = expected === 'confirmed' && !hasFix &&
      item.gold.allowedFixes.some(fix => fix.action !== 'none')
    if (unsafe) unsafeRepairProposals++
    if (unmatched) unmatchedConfirmedRepairs++
    if (missedRepair) missedApprovedRepairs++
    if (predicted.usage == null) cost.complete = false
    else {
      cost.observedCases++
      cost.inputTokens += predicted.usage.inputTokens
      cost.outputTokens += predicted.usage.outputTokens
      cost.elapsedMs += predicted.usage.elapsedMs
      if (predicted.usage.cachedInputTokens == null) cost.cachedComplete = false
      else cost.cachedInputTokens += predicted.usage.cachedInputTokens
    }
    return { caseId: item.id, category: item.category, expected, predicted: predicted.verdict,
      proposedFix: predicted.proposedFix, approvedFix: approved, unsafeRepair: unsafe,
      unmatchedConfirmedRepair: unmatched, missedApprovedRepair: missedRepair,
      requestHash: predicted.requestHash ?? null, traceHash: predicted.traceHash ?? null,
      usage: predicted.usage ?? null }
  })
  if (!cost.cachedComplete) cost.cachedInputTokens = null
  const positives = confusion.tp + confusion.fn + confusion.positiveAbstain
  const negatives = confusion.tn + confusion.fp + confusion.negativeAbstain
  const metrics = { confusion, goldUncertain, precision: rate(confusion.tp, confusion.tp + confusion.fp),
    recall: rate(confusion.tp, positives), falsePositiveRate: rate(confusion.fp, negatives),
    unsafeRepairProposals, unmatchedConfirmedRepairs, missedApprovedRepairs, cost }
  return { datasetId: gold.datasetId, goldHash: run.goldHash, runId: run.runId,
    model: run.model, promptVersion: run.promptVersion, measurementStatus: run.measurementStatus,
    labelState: gold.cases.every(item => item.label.status === 'human-reviewed') ?
      'human_reviewed_self_reported' : 'draft_not_human_confirmed', metrics, results }
}

export function compareReviewRuns(gold, baseline, candidate) {
  const before = evaluateReviewRun(gold, baseline)
  const after = evaluateReviewRun(gold, candidate)
  if (before.runId === after.runId) fail('baseline and candidate need distinct runId values')
  const b = before.metrics, a = after.metrics
  const costComparable = b.cost.complete && a.cost.complete &&
    before.measurementStatus === 'reported_real_run' && after.measurementStatus === 'reported_real_run'
  return { datasetId: gold.datasetId, goldHash: before.goldHash, baseline: before, candidate: after,
    costComparable,
    delta: { falsePositives: a.confusion.fp - b.confusion.fp,
      falseNegatives: a.confusion.fn - b.confusion.fn,
      positiveAbstentions: a.confusion.positiveAbstain - b.confusion.positiveAbstain,
      missedPositiveCases: a.confusion.fn + a.confusion.positiveAbstain - b.confusion.fn - b.confusion.positiveAbstain,
      unsafeRepairProposals: a.unsafeRepairProposals - b.unsafeRepairProposals,
      unmatchedConfirmedRepairs: a.unmatchedConfirmedRepairs - b.unmatchedConfirmedRepairs,
      missedApprovedRepairs: a.missedApprovedRepairs - b.missedApprovedRepairs,
      inputTokens: costComparable ? a.cost.inputTokens - b.cost.inputTokens : null,
      outputTokens: costComparable ? a.cost.outputTokens - b.cost.outputTokens : null,
      elapsedMs: costComparable ? a.cost.elapsedMs - b.cost.elapsedMs : null } }
}

function code(value) { return '```json\n' + JSON.stringify(value, null, 2) + '\n```\n' }
export function renderReviewSheet(gold, report) {
  validateGold(gold)
  const candidate = report.candidate || report
  const baseline = report.baseline || null
  const lines = [
    '# Knowledge Graph Review Benchmark', '',
    `Dataset: ${gold.datasetId}  `, `Gold SHA-256: ${fingerprintReviewGold(gold)}  `,
    `Label state: ${candidate.labelState}  `,
    'Draft labels and self-reported reviewer metadata are not independent human confirmation.', '',
    `Candidate measurement: ${candidate.measurementStatus}; baseline measurement: ${baseline?.measurementStatus || 'none'}.`,
    'Controlled fixture usage is synthetic and must not be reported as actual model cost.', '',
    '## Summary', '', code({ baseline: baseline?.metrics || null, candidate: candidate.metrics,
      delta: report.delta || null, costComparable: report.costComparable ??
        (candidate.metrics.cost.complete && candidate.measurementStatus === 'reported_real_run') }),
    'Token counts and elapsed milliseconds are reported by the run; elapsedMs is a sum of case latencies, not wall-clock time.',
    'Incomplete usage is not zero cost, and token/time savings do not excuse unsafe repairs.', '',
  ]
  const current = new Map(candidate.results.map(item => [item.caseId, item]))
  const prior = new Map((baseline?.results || []).map(item => [item.caseId, item]))
  for (const item of gold.cases) {
    lines.push(`## ${item.id} (${item.category})`, '',
      `Label: ${item.label.status}; rationale: ${item.label.rationale}`, '',
      '- [ ] Independently check every source paragraph and complete graph context.',
      '- [ ] Confirm the verdict and each allowed repair, including whether no safe single edit exists.',
      '- [ ] Record reviewer, review date, and any corrected rationale in the gold JSON before using --require-reviewed.', '',
      'Source units:', '', code(item.sourceUnits), 'Graph:', '', code(item.graph),
      'Allegation:', '', code(item.allegation), 'Frozen review input:', '', code(item.input),
      'Gold verdict and allowed repairs:', '', code(item.gold),
      'Baseline result:', '', code(prior.get(item.id) || null),
      'Candidate result:', '', code(current.get(item.id) || null))
  }
  return lines.join('\n') + '\n'
}

function argsOf(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value.startsWith('--')) fail('unexpected argument: ' + value)
    const key = value.slice(2)
    if (key === 'require-reviewed' || key === 'fingerprint') { args[key] = true; continue }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('missing value for ' + value)
    args[key] = argv[++i]
  }
  return args
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = argsOf(process.argv.slice(2))
    if (!args.gold) fail('usage: --gold GOLD.json [--fingerprint | --capture RAW.json --run OUT.json | --candidate RUN.json [--baseline RUN.json] [--json OUT.json] [--markdown OUT.md] [--require-reviewed]]')
    const gold = JSON.parse(readFileSync(args.gold, 'utf8'))
    const fingerprint = fingerprintReviewGold(gold)
    if (args.fingerprint && (args.capture || args.run || args.candidate || args.baseline || args.json || args.markdown)) {
      fail('fingerprint mode cannot be combined with capture or comparison arguments')
    }
    if (args['require-reviewed'] && gold.cases.some(item => item.label.status !== 'human-reviewed')) {
      fail('draft labels cannot be used with --require-reviewed')
    }
    if (args.fingerprint) process.stdout.write(fingerprint + '\n')
    else if (args.capture) {
      if (!args.run || args.candidate || args.baseline || args.json || args.markdown) {
        fail('capture mode requires --run and cannot be combined with comparison arguments')
      }
      if ([args.gold, args.capture].some(path => existingPathOrResolved(path) === existingPathOrResolved(args.run))) {
        fail('run output must not overwrite gold or raw capture')
      }
      const run = captureReviewRun(gold, JSON.parse(readFileSync(args.capture, 'utf8')))
      writeFileSync(args.run, JSON.stringify(run, null, 2) + '\n')
      process.stdout.write(JSON.stringify({ runId: run.runId, predictions: run.predictions.length,
        goldHash: run.goldHash, runFile: args.run }) + '\n')
    }
    else {
      if (!args.candidate) fail('--candidate is required for evaluation')
      const candidate = JSON.parse(readFileSync(args.candidate, 'utf8'))
      const report = args.baseline ? compareReviewRuns(gold,
        JSON.parse(readFileSync(args.baseline, 'utf8')), candidate) : evaluateReviewRun(gold, candidate)
      if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2) + '\n')
      if (args.markdown) writeFileSync(args.markdown, renderReviewSheet(gold, report))
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    }
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
