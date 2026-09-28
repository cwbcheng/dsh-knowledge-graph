import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fingerprintReviewGold } from './kg-review-benchmark.mjs'
import { evaluateDiscoveryRun, inspectDiscoveryCapture } from './kg-discovery-benchmark.mjs'

function fixTargetsIssue(fix, issue) {
  if (fix.action === 'none' || issue.targetKind === 'graph') return true
  if (issue.targetKind === 'node') {
    if (['update_node', 'delete_node', 'merge_nodes'].includes(fix.action)) {
      return fix.nodePatch?.id === issue.targetId
    }
    if (['add_edge', 'update_edge', 'delete_edge'].includes(fix.action)) {
      const edge = fix.edgePatch || {}
      return [edge.fromNodeId, edge.toNodeId, edge.newFromNodeId, edge.newToNodeId].includes(issue.targetId)
    }
    return false
  }
  const [from, to] = issue.targetId.split('>')
  return ['update_edge', 'delete_edge'].includes(fix.action) &&
    fix.edgePatch?.fromNodeId === from && fix.edgePatch?.toNodeId === to
}

export function buildDiscoveryFollowupGold(discoveryGold, capture, review) {
  const inspected = inspectDiscoveryCapture(discoveryGold, capture)
  if (review?.schemaVersion !== 1 || review.discoveryGoldHash !== inspected.goldHash ||
      review.reportHash !== inspected.reportHash || !review.issueId ||
      !Array.isArray(review.approvedFixes) || !review.approvedFixes.length) {
    throw new Error('follow-up approval does not match the frozen discovery report')
  }
  const issue = inspected.issues.find(candidate => candidate.id === review.issueId)
  if (!issue) throw new Error('follow-up issue is absent from the frozen AI report')
  if (review.approvedFixes.some(fix => !fixTargetsIssue(fix, issue))) {
    throw new Error('approved repair does not target the discovered issue')
  }
  const gold = { schemaVersion: 1, datasetId: review.datasetId,
    description: 'Targeted review of one frozen AI discovery issue; approval remains a separate Codex source judgement.',
    discoveryGoldHash: inspected.goldHash, discoveryReportHash: inspected.reportHash,
    cases: [{ id: review.issueId, category: review.category, label: review.label,
      sourceUnits: discoveryGold.sourceUnits, graph: discoveryGold.graph,
      allegation: { issueId: issue.id, targetKind: issue.targetKind,
        targetId: issue.targetId, title: issue.title },
      input: { text: '', question: review.question, detail: issue.detail, evidence: issue.evidence },
      gold: { verdict: 'confirmed', allowedFixes: review.approvedFixes } }] }
  fingerprintReviewGold(gold)
  return gold
}

export function buildMissedDiscoveryFollowupGold(discoveryGold, capture, adjudication, review) {
  const score = evaluateDiscoveryRun(discoveryGold, capture, adjudication)
  if (review?.schemaVersion !== 1 || review.discoveryGoldHash !== score.goldHash ||
      review.reportHash !== score.reportHash || !review.findingId ||
      !Array.isArray(review.approvedFixes) || !review.approvedFixes.length) {
    throw new Error('missed-finding approval does not match the adjudicated discovery report')
  }
  if (!score.metrics.missedFindingIds.includes(review.findingId)) {
    throw new Error('follow-up finding was not missed by the adjudicated discovery report')
  }
  const finding = discoveryGold.findings.find(item => item.id === review.findingId)
  if (review.approvedFixes.some(fix => !fixTargetsIssue(fix, finding))) {
    throw new Error('approved repair does not target the missed finding')
  }
  const gold = { schemaVersion: 1, datasetId: review.datasetId,
    description: 'Targeted review of one frozen, adjudicated discovery miss; the allegation is known and is not a second full-graph discovery run.',
    discoveryGoldHash: score.goldHash, discoveryReportHash: score.reportHash,
    cases: [{ id: finding.id, category: review.category, label: review.label,
      sourceUnits: discoveryGold.sourceUnits, graph: discoveryGold.graph,
      allegation: { issueId: finding.id, targetKind: finding.targetKind,
        targetId: finding.targetId, title: finding.summary },
      input: { text: '', question: review.question, detail: finding.summary,
        evidence: finding.evidence },
      gold: { verdict: 'confirmed', allowedFixes: review.approvedFixes } }] }
  fingerprintReviewGold(gold)
  return gold
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? null : process.argv[i + 1] }
    const goldPath = arg('gold'), capturePath = arg('capture'), reviewPath = arg('review'), output = arg('output')
    if (!goldPath || !capturePath || !reviewPath || !output) {
      throw new Error('usage: --gold DISCOVERY_GOLD --capture RAW --review APPROVAL --output NEW_REVIEW_GOLD')
    }
    const discoveryGold = JSON.parse(readFileSync(goldPath, 'utf8'))
    const capture = JSON.parse(readFileSync(capturePath, 'utf8'))
    const review = JSON.parse(readFileSync(reviewPath, 'utf8'))
    const result = arg('adjudication')
      ? buildMissedDiscoveryFollowupGold(discoveryGold, capture,
        JSON.parse(readFileSync(arg('adjudication'), 'utf8')), review)
      : buildDiscoveryFollowupGold(discoveryGold, capture, review)
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    process.stdout.write(JSON.stringify({ output, datasetId: result.datasetId,
      caseId: result.cases[0].id, goldHash: fingerprintReviewGold(result) }) + '\n')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
