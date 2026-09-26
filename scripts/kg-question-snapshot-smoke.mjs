import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const starts = [...client.matchAll(/        const submitQuestion = async \(draftOverride, targetOverride, reviewIssue = null\) => \{/g)]
assert.equal(starts.length, 2)
const scopeStart = client.indexOf('        const questionParagraphIndicesClient =')
const scopeEnd = client.indexOf('        // End question context helpers.', scopeStart)
const helpers = new Function('splitParagraphs', 'MAX_VERIFY_SCOPE_CHARS', 'MAX_VERIFY_SCOPE_UNITS',
  client.slice(scopeStart, scopeEnd) + '; return { questionNeighborhoodGraph, verificationSourcePayload }')(
  source => source.split('\n\n').map(text => ({ text })), 240000, 2000)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const graph = (revision = 7, documentId = 'doc-a') => ({ revision,
  source: { documentId, revision }, nodes: [{ id: 'n1', type: 'fact', text: 'Current fact', paragraph: 0 }], edges: [] })
const snapshot = (sourceText = 'Canonical source', revision = 7, documentId = 'doc-a') => ({
  documentId, revision, graph: graph(revision, documentId), sourceText,
})
for (const [index, match] of starts.entries()) {
const start = match.index
const end = client.indexOf(index === 0 ? '        const saveBulkReview =' : '        const saveCanonicalIssueReview =', start)
assert.ok(end > start)
function fixture({ loaded = snapshot(), read, queue = Promise.resolve(), truncated = true } = {}) {
  const openingView = { graph: { ...graph(), view: { truncated } }, sourceText: 'Old page source' }
  const currentResultRef = { current: openingView }, graphRevisionRef = { current: 7 }
  const graphCommitQueueRef = { current: queue }, graphCommitEpochRef = { current: 0 }
  const calls = [], states = [], questionAdmissionRef = { current: null }
  const env = { ...helpers, questionDraft: 'Check n1.', resultView: openingView, questionPhase: 'idle',
    questionTarget: { kind: 'node', id: 'n1' }, modelCatalog: { issueReview: true },
    bulkRunRef: { current: false }, verifyGenRef: { current: 0 }, questionAdmissionRef,
    currentResultRef, graphRevisionRef, graphCommitQueueRef, graphCommitEpochRef,
    view: openingView, currentViewRef: currentResultRef, trajRevisionRef: graphRevisionRef,
    trajCommitQueueRef: graphCommitQueueRef, trajCommitEpochRef: graphCommitEpochRef,
    sessionId: 'session', mountedSessionRef: { current: 'session' }, reviewSaveRef: { current: null },
    title: 'Fixture', fullText: 'Old accumulated source', effectiveModelArg: { provider: 'fixture', model: 'controlled' },
    documentIdOfGraph: graph => graph?.source?.documentId || '',
    makeView: (graph, sourceText) => ({ graph, sourceText }),
    setResultView: update => { currentResultRef.current = update(currentResultRef.current) },
    setView: update => { currentResultRef.current = update(currentResultRef.current) },
    host: { call: async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'document-export') return read ? read.promise : loaded
      assert.equal(method, 'question-graph')
      return { taskId: 'question-fixture' }
    } },
  }
  for (const name of ['setError', 'setQuestionError', 'setVerifyProgress', 'setQuestionPhase', 'setQuestionResult', 'setQuestionTaskId', 'setFullText']) {
    env[name] = value => states.push({ name, value })
  }
  const submit = new Function(...Object.keys(env), client.slice(start, end) + '; return submitQuestion')(...Object.values(env))
  return { submit, calls, states, currentResultRef, graphRevisionRef, graphCommitQueueRef, graphCommitEpochRef, questionAdmissionRef,
    questions: () => calls.filter(call => call.method === 'question-graph') }
}

const paired = fixture()
await paired.submit()
assert.equal(paired.questions()[0]?.payload.text, 'Canonical source',
  'a canonical graph must be reviewed against the source from the same snapshot, never stale page text')
assert.equal(paired.calls[0].payload.includeSourceText, true, 'canonical export must explicitly request the paired source')
assert.equal(paired.currentResultRef.current.sourceText, 'Canonical source', 'visible source anchors must match what the model reviewed')
if (index === 0) assert.equal(paired.states.filter(state => state.name === 'setFullText').at(-1)?.value, 'Canonical source')

const largeSource = Array.from({ length: 600 }, (_, i) => 'Canonical paragraph ' + i + ': ' + 'word '.repeat(100)).join('\n\n')
const scoped = fixture({ loaded: snapshot(largeSource) })
await scoped.submit()
const scopedPayload = scoped.questions()[0]?.payload
assert.equal(scopedPayload.text, '')
assert.ok(scopedPayload.sourceUnits.length > 0)
assert.ok(scopedPayload.sourceUnits.every(unit => unit.text.startsWith('Canonical paragraph ')),
  'bounded source units must also come from the canonical snapshot')

for (const [label, loaded] of [
  ['missing source', { ...snapshot(), sourceText: undefined }],
  ['empty source', snapshot('')],
  ['malformed source', snapshot({ text: 'not a source string' })],
  ['foreign document', snapshot('Other source', 7, 'doc-b')],
  ['foreign graph', { ...snapshot(), graph: graph(7, 'doc-b') }],
  ['newer canonical revision', snapshot('New revision source', 8)],
  ['graph revision mismatch', { ...snapshot(), graph: graph(6) }],
  ['missing revision', { ...snapshot(), revision: undefined }],
]) {
  const failed = fixture({ loaded })
  await failed.submit()
  assert.equal(failed.questions().length, 0, label + ': never start a model on an unbound snapshot')
  assert.equal(failed.states.filter(state => state.name === 'setQuestionPhase').at(-1)?.value, 'idle')
  assert.ok(failed.states.filter(state => state.name === 'setQuestionError').at(-1)?.value)
  assert.equal(failed.questionAdmissionRef.current, null, label + ': release admission so the user can retry')
  assert.equal(failed.currentResultRef.current.sourceText, 'Old page source', label + ': a rejected snapshot cannot overwrite the visible source')
}

const queue = deferred()
const queued = fixture({ queue: queue.promise, loaded: snapshot('Source after pending commit', 8) })
const queuedTask = queued.submit()
await tick()
assert.equal(queued.calls.length, 0, 'do not read canonical state before preceding edits have settled')
queued.graphRevisionRef.current = 8
queue.resolve()
await queuedTask
assert.equal(queued.questions()[0]?.payload.text, 'Source after pending commit')

for (const change of ['revision', 'queue', 'failed-commit']) {
  const read = deferred()
  const changed = fixture({ read })
  const pending = changed.submit()
  await tick()
  assert.equal(changed.calls[0]?.method, 'document-export')
  if (change === 'revision') changed.graphRevisionRef.current++
  if (change === 'queue') changed.graphCommitQueueRef.current = Promise.resolve()
  if (change === 'failed-commit') changed.graphCommitEpochRef.current++
  read.resolve(snapshot())
  await pending
  assert.equal(changed.questions().length, 0, change + ': a changed write boundary must invalidate the pending read')
}

const pendingCommit = deferred()
const left = fixture({ queue: pendingCommit.promise })
const leaving = left.submit()
await tick()
left.currentResultRef.current = { graph: graph(1, 'doc-b'), sourceText: 'Different document' }
pendingCommit.resolve()
await leaving
assert.equal(left.calls.length, 0, 'navigation while waiting for writes must not even read the old document')

const local = fixture({ truncated: false })
await local.submit()
assert.equal(local.calls.length, 1, 'an already complete view must not introduce an unnecessary canonical round trip')
assert.equal(local.questions()[0]?.payload.text, 'Old page source',
  'complete views must keep their paired source instead of a different accumulated-input cache')
}
console.log('document/trajectory question snapshots: paired full/scoped source, identity/revision guards, pending writes, races and navigation passed')
