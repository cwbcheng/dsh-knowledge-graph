import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const section = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert(start >= 0 && end > start, 'Missing production section: ' + from)
  return source.slice(start, end)
}
const buildIssueWorkPackages = new Function(section('      function buildIssueWorkPackages(', '      function batchReviewIssueSignature(')
  + '; return buildIssueWorkPackages')()
for (const file of ['../lib/client.js', '../extension/viewer.js']) {
  const generated = readFileSync(new URL(file, import.meta.url), 'utf8')
  assert(generated.includes(section('      function buildIssueWorkPackages(', '      function batchSafeFix(')), file + ' must contain current grouping and allegation proof helpers')
}
const issue = (id, title, paragraph = 0, extra = {}) => ({ id, source: 'ai', category: 'factuality', targetKind: 'node',
  targetId: 'n' + id, title, status: 'open', severity: 'warning', evidence: [{ paragraph, quote: 'Source ' + paragraph }], ...extra })
const report = { reportId: 'report-1', issues: [
  issue('1', 'n1 Missing quotation'),
  issue('2', 'n2 Unsupported claim'),
  issue('3', 'n3 Missing quotation'),
  issue('4', 'n4 Missing quotation', 7),
  issue('5', 'n5 Missing quotation', 0, { status: 'applied' }),
  issue('6', 'n6 Missing quotation', 0, { batchReview: { verdict: 'uncertain' } }),
  issue('7', 'n7 Missing quotation', 0, { severity: 'error' }),
  issue('8', 'Local evidence warning', 0, { source: 'local', invariantCode: 'missing_quote' }),
] }
const groups = buildIssueWorkPackages(report, 'all', 'family')
const quotes = groups.find(group => group.issues.some(item => item.id === '1'))
assert.deepEqual(quotes.issues.map(item => item.id), ['1', '3', '4', '5', '6', '7'])
assert.equal(quotes.remaining, 4, 'handled and independently reviewed items stay visible but are not re-billed')
assert(!quotes.issues.some(item => item.id === '2' || item.id === '8'), 'missing quotations, unsupported claims and different producers cannot be merged by category alone')
assert.equal(buildIssueWorkPackages(report, 'error', 'family')[0].remaining, 1)
assert.equal(buildIssueWorkPackages(report, 'warning', 'family').find(group => group.key === quotes.key).remaining, 3)
const bySource = buildIssueWorkPackages(report, 'all', 'source')
assert.deepEqual(bySource.find(group => group.issues.some(item => item.id === '1')).issues.map(item => item.id), ['1', '3', '5', '6', '7'])
assert(bySource.find(group => group.issues.some(item => item.id === '1')).label.includes('P1'), 'paragraph zero is a real source anchor')
const noAnchor = { issues: [issue('1', 'Missing quote', 0, { evidence: [] }), issue('2', 'Missing quote', 0, { evidence: [] })] }
assert.equal(buildIssueWorkPackages(noAnchor, 'all', 'source').length, 2, 'unknown anchors cannot pretend to be a shared source')
const foreign = { issues: [issue('1', 'Missing quote', 0, { evidence: [{ documentId: 'a', paragraph: 0 }] }),
  issue('2', 'Missing quote', 0, { evidence: [{ documentId: 'b', paragraph: 0 }] })] }
assert.equal(buildIssueWorkPackages(foreign, 'all', 'source').length, 2, 'same paragraph numbers from different sources are not the same context')
const conditions = { issues: [issue('1', 'Claim holds above 10 only'), issue('2', 'Claim holds above 20 only'),
  issue('3', 'Claim holds below 10 only')] }
assert.equal(buildIssueWorkPackages(conditions).length, 3, 'grouping must preserve qualifiers, negation and numeric conditions')
assert.deepEqual(buildIssueWorkPackages({ issues: [...report.issues].reverse() }).map(group => group.key).sort(), groups.map(group => group.key).sort(),
  'group identity must not depend on list order')

const starts = []
const env = { resultView: { graph: { source: { documentId: 'doc' } } }, verification: report,
  bulkReview: null, bulkRunRef: { current: false }, questionPhase: 'idle', verifyPhase: 'idle',
  modelCatalog: { issueReview: true }, documentIdOfGraph: graph => graph.source?.documentId,
  effectiveModelArg: { provider: 'fixture', model: 'selected-model' }, toastStore: { show() {} },
  runBulkReview: state => starts.push(state), buildIssueWorkPackages }
const startCode = section('        const handleStartBulkReview =', '        const handleStopBulkReview =')
const start = new Function(...Object.keys(env), startCode + '; return handleStartBulkReview')(...Object.values(env))
start(2, 'warning', quotes.key, 'family')
assert.deepEqual(starts[0].issueIds, ['1', '3'], 'the requested group must not pick unrelated intervening rows')
assert.equal(starts[0].workPackage.key, quotes.key)
assert.equal(starts[0].model.model, 'selected-model')
assert.equal(starts[0].rows.length, 0)
start(100, 'all', 'unknown-group', 'family')
assert.equal(starts.length, 1, 'stale selection cannot silently fall back to a different group')
start(100, 'error', quotes.key, 'family')
assert.deepEqual(starts[1].issueIds, ['7'])
const original = JSON.stringify(report)
buildIssueWorkPackages(report)
assert.equal(JSON.stringify(report), original, 'grouping is a derived view, not a graph or report edit')
const revealStart = source.indexOf('        useEffect(() => {\n          const index = shown.findIndex(issue => issue.id === activeIssueId)')
assert(revealStart >= 0, 'Missing production selected-issue pagination effect')
const revealCode = source.slice(revealStart, source.indexOf('\n        const qNode', revealStart))
const reveal = new Function('useEffect', 'shown', 'activeIssueId', 'report', 'issueFilter', 'workPackage', 'workPackageMode', 'setIssueLimit', revealCode)
let priorDependencies, issueLimit = 40
const useEffect = (callback, dependencies) => {
  if (!priorDependencies || dependencies.some((value, index) => value !== priorDependencies[index])) callback()
  priorDependencies = dependencies
}
const setIssueLimit = update => { issueLimit = update(issueLimit) }
const selectedGroup = Array.from({ length: 75 }, (_, index) => ({ id: 'selected-' + index }))
reveal(useEffect, [{ id: 'other' }], 'selected-74', report, 'all', { key: 'old-group' }, 'family', setIssueLimit)
assert.equal(issueLimit, 40)
reveal(useEffect, selectedGroup, 'selected-74', report, 'all', { key: 'selected-group' }, 'family', setIssueLimit)
assert.equal(issueLimit, 80, 'switching groups must reveal an active issue beyond the first page, even when the issue ID did not change')
assert(source.includes("const [workPackageKey, setWorkPackageKey] = useState('all')")
  && source.includes("setWorkPackageKey('all')"), 'opening or regrouping a report must show all issues instead of silently choosing the first group')
assert(source.includes('扫描完成不代表逐条问题已经核实')
  && source.includes('当前显示 '), 'the report must distinguish completed scanning from pending issue decisions and scoped list counts')
const large = { issues: Array.from({ length: 5000 }, (_, index) => issue(String(index), 'Missing quote', index)) }
const then = performance.now()
assert.equal(buildIssueWorkPackages(large).length, 1)
assert.equal(buildIssueWorkPackages(large, 'all', 'source').length, 5000)
const elapsedMs = performance.now() - then
assert(elapsedMs < 2000, 'grouping must remain usable for a large report: ' + elapsedMs)
console.log(JSON.stringify({ familySelection: true, sharedSourceSelection: true, independentIssues: true, missingQuoteNotUnsupported: true,
  handledItemsNotRepeated: true, staleSelectionRejected: true, conditionsPreserved: true, readOnlyReport: true, selectedIssuePagination: true, generatedParity: true, items: 5000, elapsedMs }))
