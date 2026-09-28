import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const fail = message => { throw new Error(message) }
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const nonnegative = value => Number.isSafeInteger(value) && value >= 0

function measuredCost(capture) {
  const usage = capture.taskStatus?.modelUsage
  const requests = usage?.finishedRequests
  const input = usage?.totals?.totalInputTokens
  const output = usage?.totals?.outputTokens
  const complete = nonnegative(requests) && requests > 0 &&
    usage.startedRequests === requests && usage.reportedRequests === requests &&
    nonnegative(input?.tokens) && input.requests === requests &&
    nonnegative(output?.tokens) && output.requests === requests
  const elapsedMs = nonnegative(capture.startedAtMs) && nonnegative(capture.finishedAtMs) &&
    capture.finishedAtMs >= capture.startedAtMs
    ? capture.finishedAtMs - capture.startedAtMs : null
  const cached = usage?.totals?.cacheReadTokens
  const cacheHit = usage?.cacheHit
  const cachedInputTokens = complete && nonnegative(cached?.tokens) && cached.requests === requests
    ? cached.tokens : complete && nonnegative(cacheHit?.readTokens) &&
      nonnegative(cacheHit.requests) && cacheHit.requests <= requests
      ? cacheHit.readTokens : null
  return { complete, requests: complete ? requests : null,
    inputTokens: complete ? input.tokens : null,
    outputTokens: complete ? output.tokens : null,
    cachedInputTokens, elapsedMs }
}

export function fingerprintDiscoveryGold(gold) {
  if (gold?.schemaVersion !== 1 || typeof gold.datasetId !== 'string' || !gold.datasetId ||
      !gold.graph || !Array.isArray(gold.graph.nodes) || !Array.isArray(gold.graph.edges) ||
      !Array.isArray(gold.sourceUnits) || !Array.isArray(gold.findings) ||
      !nonnegative(gold.revision) || gold.revision < 1) fail('invalid discovery gold')
  if (!gold.findings.length &&
      (!['codex-reviewed', 'human-reviewed'].includes(gold.negativeReview?.status) ||
        !gold.negativeReview?.reviewer || !gold.negativeReview?.rationale)) {
    fail('negative review of the full graph and source is required for zero-finding gold')
  }
  const source = new Map()
  gold.sourceUnits.forEach((unit, index) => {
    if (unit?.paragraph !== index || typeof unit.text !== 'string' || !unit.text) fail('source units must be complete and contiguous')
    source.set(index, unit.text)
  })
  const nodes = new Set(gold.graph.nodes.map(node => node.id))
  if (nodes.size !== gold.graph.nodes.length) fail('duplicate gold node id')
  const ids = new Set()
  for (const finding of gold.findings) {
    if (typeof finding?.id !== 'string' || !finding.id || ids.has(finding.id) ||
        !['node', 'edge', 'graph'].includes(finding.targetKind) ||
        typeof finding.targetId !== 'string' || !finding.targetId ||
        typeof finding.summary !== 'string' || !finding.summary ||
        finding.label?.status !== 'codex-reviewed' && finding.label?.status !== 'human-reviewed' ||
        !finding.label?.reviewer || !finding.label?.rationale ||
        !Array.isArray(finding.evidence) || !finding.evidence.length) fail('invalid discovery finding')
    ids.add(finding.id)
    if (finding.targetKind === 'node' && !nodes.has(finding.targetId)) fail('finding node is missing: ' + finding.id)
    if (finding.targetKind === 'graph' && finding.targetId !== 'graph') fail('invalid graph finding target')
    if (finding.targetKind === 'edge') {
      if (typeof finding.targetRelation !== 'string' || !finding.targetRelation) {
        fail('finding edge relation is required: ' + finding.id)
      }
      if (!gold.graph.edges.some(edge => edge.fromNodeId + '>' + edge.toNodeId === finding.targetId &&
        edge.relation === finding.targetRelation)) fail('finding edge is missing: ' + finding.id)
    }
    for (const evidence of finding.evidence) {
      if (!nonnegative(evidence?.paragraph) || typeof evidence.quote !== 'string' ||
          !evidence.quote || !source.get(evidence.paragraph)?.includes(evidence.quote)) {
        fail('finding evidence is not in source: ' + finding.id)
      }
    }
  }
  return digest(gold)
}

export function inspectDiscoveryCapture(gold, capture) {
  const goldHash = fingerprintDiscoveryGold(gold)
  if (capture?.schemaVersion !== 1 || capture.datasetId !== gold.datasetId ||
      capture.goldHash !== goldHash || !capture.runId || !capture.model || !capture.promptVersion ||
      !capture.snapshot?.graph || !Array.isArray(capture.snapshot.sourceUnits) ||
      digest(capture.snapshot.graph) !== digest(gold.graph) ||
      digest(capture.snapshot.sourceUnits) !== digest(gold.sourceUnits) ||
      capture.snapshot.revision !== gold.revision) fail('capture snapshot does not match frozen graph/source/revision')
  const status = capture.taskStatus
  const report = status?.result
  const coverage = report?.coverage
  if (status?.status !== 'succeeded' || !report || !Array.isArray(report.issues) ||
      coverage?.status !== 'complete' || coverage.revision !== gold.revision ||
      coverage.completedNodes !== gold.graph.nodes.length ||
      coverage.completedEdges !== gold.graph.edges.length ||
      coverage.completedSourceUnits !== gold.sourceUnits.length) {
    fail('partial or mismatched full-graph coverage cannot be scored')
  }
  const model = capture.model
  if (typeof model?.provider !== 'string' || !model.provider ||
      typeof model?.model !== 'string' || !model.model ||
      !report.model || digest(report.model) !== digest(model) ||
      !Array.isArray(report.modelsUsed) || !report.modelsUsed.length ||
      report.modelsUsed.some(item => item?.provider !== model.provider ||
        item?.model !== model.model || !Number.isSafeInteger(item.batches) || item.batches < 1) ||
      !Number.isSafeInteger(coverage.batchCount) || coverage.batchCount < 1 ||
      report.modelsUsed.reduce((sum, item) => sum + item.batches, 0) !== coverage.batchCount) {
    fail('capture model identity does not match completed Host report')
  }
  if (report.issues.some(issue => issue?.source !== 'ai' && issue?.source !== 'local')) {
    fail('unknown discovery issue source cannot be excluded as a local rule')
  }
  const issues = report.issues.filter(issue => issue?.source === 'ai').map(issue =>
    issue.targetKind === 'graph' && issue.targetId == null ? { ...issue, targetId: 'graph' } : issue)
  const ids = new Set()
  const fixActions = new Set(['none', 'update_node', 'delete_node', 'add_node',
    'update_edge', 'delete_edge', 'add_edge', 'merge_nodes', 'update_summary'])
  for (const issue of issues) {
    if (typeof issue.id !== 'string' || !issue.id || ids.has(issue.id) ||
        !['node', 'edge', 'graph'].includes(issue.targetKind) ||
        (issue.targetKind === 'graph' ? issue.targetId !== 'graph' :
          typeof issue.targetId !== 'string' || !issue.targetId) ||
        (issue.proposedFix != null && !fixActions.has(issue.proposedFix.action))) {
      fail('invalid or duplicate AI discovery issue')
    }
    ids.add(issue.id)
  }
  return { goldHash, reportHash: digest(report), issues, localIssueCount: report.issues.length - issues.length,
    expectedFindingCount: gold.findings.length }
}

export function evaluateDiscoveryRun(gold, capture, adjudication) {
  const inspected = inspectDiscoveryCapture(gold, capture)
  if (adjudication?.schemaVersion !== 2 || adjudication.goldHash !== inspected.goldHash ||
      adjudication.reportHash !== inspected.reportHash ||
      !Array.isArray(adjudication.decisions) || adjudication.decisions.length !== inspected.issues.length ||
      !['codex-reviewed', 'human-reviewed'].includes(adjudication.label?.status) ||
      !adjudication.label?.reviewer) fail('adjudication must cover this exact completed report')
  const issueById = new Map(inspected.issues.map(issue => [issue.id, issue]))
  const findingById = new Map(gold.findings.map(finding => [finding.id, finding]))
  const decided = new Set(), matched = new Set()
  let falseAlarms = 0, uncertainCandidates = 0, duplicates = 0
  const repairReviews = { proposed: 0, sourceSupported: 0, notJustified: 0,
    sourceUnsafe: 0, uncertain: 0, notProposed: 0 }
  for (const decision of adjudication.decisions) {
    const issue = issueById.get(decision?.issueId)
    if (!issue || decided.has(decision.issueId) || !decision.rationale ||
        !['match', 'false_alarm', 'uncertain'].includes(decision.outcome)) fail('invalid or duplicate discovery decision')
    decided.add(decision.issueId)
    const proposed = issue.proposedFix && issue.proposedFix.action !== 'none'
    const repairStatus = decision.repairReview?.status
    if (!decision.repairReview?.rationale ||
        !['source_supported', 'not_justified', 'source_unsafe', 'uncertain', 'not_proposed'].includes(repairStatus) ||
        (proposed ? repairStatus === 'not_proposed' : repairStatus !== 'not_proposed') ||
        (decision.outcome !== 'match' && repairStatus === 'source_supported')) {
      fail('repair review must independently assess each proposed fix in this report')
    }
    if (proposed) repairReviews.proposed++
    repairReviews[{
      source_supported: 'sourceSupported', not_justified: 'notJustified',
      source_unsafe: 'sourceUnsafe', uncertain: 'uncertain', not_proposed: 'notProposed',
    }[repairStatus]]++
    if (decision.outcome === 'false_alarm') { falseAlarms++; continue }
    if (decision.outcome === 'uncertain') { uncertainCandidates++; continue }
    const finding = findingById.get(decision.findingId)
    if (!finding || issue.targetKind !== finding.targetKind || issue.targetId !== finding.targetId ||
        finding.targetRelation && issue.targetRelation !== finding.targetRelation) {
      fail('candidate cannot be matched to a different target or unknown finding')
    }
    if (matched.has(finding.id)) duplicates++
    matched.add(finding.id)
  }
  const missed = gold.findings.filter(finding => !matched.has(finding.id)).map(finding => finding.id)
  const precisionDenominator = matched.size + falseAlarms + duplicates
  return { datasetId: gold.datasetId, goldHash: inspected.goldHash, reportHash: inspected.reportHash,
    runId: capture.runId, model: capture.model,
    labelState: adjudication.label.status === 'codex-reviewed' ? 'codex_reviewed_not_human_confirmed' : 'human_reviewed_self_reported',
    cost: measuredCost(capture),
    coverage: capture.taskStatus.result.coverage,
    metrics: { discovered: matched.size, missed: missed.length, missedFindingIds: missed,
      falseAlarms, duplicates, uncertainCandidates, localIssuesExcluded: inspected.localIssueCount,
      repairReviews,
      discoveryRecall: gold.findings.length ? matched.size / gold.findings.length : null,
      adjudicatedPrecision: precisionDenominator ? matched.size / precisionDenominator : null } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const value = name => { const index = process.argv.indexOf('--' + name); return index < 0 ? null : process.argv[index + 1] }
    const goldPath = value('gold'), capturePath = value('capture')
    if (!goldPath || !capturePath) fail('usage: --gold GOLD --capture FULL_REPORT [--adjudication DECISIONS] [--output RESULT]')
    const gold = JSON.parse(readFileSync(goldPath, 'utf8'))
    const capture = JSON.parse(readFileSync(capturePath, 'utf8'))
    const result = value('adjudication') ? evaluateDiscoveryRun(gold, capture,
      JSON.parse(readFileSync(value('adjudication'), 'utf8'))) : inspectDiscoveryCapture(gold, capture)
    if (value('output')) writeFileSync(value('output'), JSON.stringify(result, null, 2) + '\n')
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
