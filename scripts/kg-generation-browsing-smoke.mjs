import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

for (const file of ['../src/index.client.js', '../lib/client.js']) {
  const client = readFileSync(new URL(file, import.meta.url), 'utf8')
  const start = client.indexOf('      function canBrowseSavedTaskGraph(')
  const end = client.indexOf('      function WorkbenchTabs(', start)
  assert(start >= 0 && end > start, file + ': saved task browsing policy missing')
  const canBrowse = new Function('documentIdOfGraph', client.slice(start, end) + '; return canBrowseSavedTaskGraph')(
    graph => graph?.source?.documentId)
  const graph = { source: { documentId: 'saved-book' }, nodes: [] }
  for (const kind of ['append', 'imageAppend', 'relationRetry']) {
    assert.equal(canBrowse({ [kind]: true, documentId: 'saved-book' }, graph), true, kind)
    assert.equal(canBrowse({ [kind]: true, documentId: 'other-book' }, graph), false, 'Never show an unrelated saved book')
    assert.equal(canBrowse({ [kind]: true }, graph), false, 'Unknown task identity cannot reuse the last book')
    assert.equal(canBrowse({ [kind]: true, documentId: 'saved-book' }, null), false, 'First extraction still needs a progress-only view')
  }
  assert.equal(canBrowse({ append: false, documentId: 'saved-book' }, graph), false)
  assert.equal(canBrowse(null, graph), false)
  assert.equal(canBrowse({ append: true }, { nodes: [] }), true, 'Legacy in-memory appends retain their existing graph')

  const viewStart = client.indexOf('      function makeView(')
  const registryStart = client.indexOf('        const ontology = applyGraphOntology(', viewStart)
  const registryEnd = client.indexOf('        const paragraphs = ', registryStart)
  const displayTypes = new Function('graph', 'applyGraphOntology',
    "let TYPE_ORDER = ['fact'], TYPE_META = { fact: { label: 'Fact' } }, REL_LABEL = {};\n"
    + client.slice(registryStart, registryEnd) + '; return TYPE_ORDER')
  const source = { visualSource: { images: [{ id: 'figure-1' }] } }
  assert.deepEqual(displayTypes({ nodes: [{ type: 'fact' }], source }, () => ({})), ['fact', 'image'],
    'Full-document image search must remain available in a window containing only text nodes')
  assert.deepEqual(displayTypes({ nodes: [{ type: 'fact' }] }, () => ({})), ['fact'])

  const activeStart = client.indexOf('        const generationTaskActive =')
  const activeEnd = client.indexOf('\n', activeStart)
  const active = new Function('taskId', 'phase', client.slice(activeStart, activeEnd) + '; return generationTaskActive')
  assert.equal(active(null, 'extracting'), true, 'Lock before task submission returns an ID')
  assert.equal(active(null, 'paused'), true, 'Pause does not release the append base revision')
  assert.equal(active('still-tracked', 'idle'), true, 'Tracked tasks stay locked through state transitions')
  assert.equal(active(null, 'done'), false)
  assert.equal(active(null, 'idle'), false)

  const guardStart = client.indexOf('        const guardGenerationAction =')
  const guardEnd = client.indexOf('        const bulkFixBusyRef', guardStart)
  const activeRef = { current: false }, submittingRef = { current: false }, notices = [], calls = []
  const guard = new Function('generationTaskActiveRef', 'submissionBusyRef', 'toastStore',
    client.slice(guardStart, guardEnd) + '; return guardGenerationAction')(activeRef, submittingRef, { show: value => notices.push(value) })
  const action = guard(value => { calls.push(value); return value })
  assert.equal(action('idle'), 'idle')
  submittingRef.current = true
  action('double-click-before-render')
  submittingRef.current = false
  activeRef.current = true
  action('stale-callback-after-start')
  assert.deepEqual(calls, ['idle'], 'Old callbacks must consult live task state rather than an idle render closure')
  assert.equal(notices.length, 2)
  activeRef.current = false
  assert.equal(action('completed'), 'completed')

  assert(client.includes('generationTaskActive && !generationTaskViewing ? null : historyOpen'),
    'The workspace must remain in one stable render slot during saved-graph generation')
  assert(client.includes('pending.append === true || pending.relationRetry === true || pending.imageAppend === true'),
    'All saved-document generation kinds must hydrate the graph after reload')
  assert(client.includes("if (!sub.append && !sub.relationRetry) navigateWorkspace('read', 'kg-workspace-read')"),
    'Background completion must not switch the current workspace tab')
  for (const name of ['handleApplyIssue', 'handleRejectIssue', 'handleRecheckIssue', 'handleApplyAll', 'submitQuestion',
    'handleDeleteQuestionTarget', 'handleStartBulkReview', 'handlePreviewBulkReview', 'handleApplyBulkReview',
    'handleUndoBulkReview', 'handleCandidateReview', 'startFactCheck', 'handleRejectFactClaim']) {
    assert(client.includes('guardGenerationAction(' + name + ')'), name + ' must not act on a busy graph')
  }
  const askStart = client.indexOf('        const startAsk = async (overrideQuestion) => {')
  assert(askStart >= 0)
  const askBody = client.slice(askStart, client.indexOf('        const cancelAsk', askStart))
  let spent = false
  const ask = new Function('readOnly', 'askState', 'host', askBody + '; return startAsk')(
    true, { phase: 'idle' }, { call() { spent = true } })
  await ask('Must not spend while image append is active')
  assert.equal(spent, false, 'Keyboard and follow-up answer paths must stop before any model request')
}
console.log(JSON.stringify({ savedGraphDuringGeneration: true, identityFence: true, pausedReadOnly: true,
  liveCallbackGuard: true, completionKeepsTab: true, generatedParity: true }))
