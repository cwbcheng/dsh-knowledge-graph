import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const starts = [...client.matchAll(/        const submitQuestion = async \(draftOverride, targetOverride, reviewIssue = null\) => \{/g)]
assert.equal(starts.length, 2)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(index, { truncated = false, exported, admitted, unsaved = false } = {}) {
  const start = starts[index].index
  const end = client.indexOf(index === 0 ? '        const saveBulkReview =' : '        const handleApplyIssue =', start)
  assert(end > start)
  const graph = { revision: 1, source: unsaved ? {} : { documentId: 'doc-a', revision: 1 }, summary: 'A',
    nodes: [{ id: 'n1', type: 'fact', text: 'A', paragraph: 0 }], edges: [], view: { truncated } }
  const view = { graph, sourceText: 'Source A' }
  const currentView = { current: view }, generation = { current: 0 }, admission = { current: null }
  const events = [], calls = []
  const dependencies = {
    resultView: view, view, currentResultRef: currentView, currentViewRef: currentView,
    verifyGenRef: generation, questionAdmissionRef: admission, sessionSeq: { current: 0 },
    graphCommitQueueRef: { current: Promise.resolve() }, graphCommitEpochRef: { current: 0 }, graphRevisionRef: { current: 1 },
    questionDraft: 'Is n1 supported?', questionTarget: { kind: 'node', id: 'n1' }, questionPhase: 'idle',
    modelCatalog: { issueReview: true }, bulkRunRef: { current: false }, title: 'Fixture', fullText: 'Source A',
    reviewSaveRef: { current: null }, sessionId: 'session', mountedSessionRef: { current: 'session' },
    effectiveModelArg: { provider: 'fixture', model: 'controlled' },
    documentIdOfGraph: graph => graph?.source?.documentId || null,
    makeView: (graph, sourceText) => ({ graph, sourceText }),
    setResultView: update => { currentView.current = update(currentView.current) },
    questionNeighborhoodGraph: graph => graph, verificationSourcePayload: () => ({}),
    host: { call: async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'document-export') return exported ? exported.promise : { documentId: 'doc-a', graph, sourceText: 'Source A', revision: 1 }
      assert.equal(method, 'question-graph')
      return admitted ? admitted.promise : { taskId: 'task-a' }
    } },
  }
  for (const name of ['setError', 'setQuestionError', 'setVerifyProgress', 'setQuestionPhase', 'setQuestionResult', 'setQuestionTaskId', 'setFullText']) {
    dependencies[name] = value => events.push({ name, value })
  }
  const submit = new Function(...Object.keys(dependencies), client.slice(start, end) + '; return submitQuestion')(...Object.values(dependencies))
  const leave = ({ bumpGeneration = true, clearAdmission = true } = {}) => {
    if (bumpGeneration) generation.current++
    if (clearAdmission) admission.current = null
    currentView.current = { graph: { ...graph, source: unsaved ? {} : { documentId: 'doc-b' } }, sourceText: 'Source B' }
  }
  return { submit, leave, events, calls, currentView, generation, admission, graph, view }
}

for (const reject of [false, true]) {
  const exported = deferred()
  const test = fixture(0, { truncated: true, exported })
  const pending = test.submit()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(test.calls.filter(call => call.method === 'document-export').length, 1)
  test.leave({ bumpGeneration: reject, clearAdmission: false })
  const boundary = test.events.length
  if (reject) exported.reject(new Error('old document unavailable'))
  else exported.resolve({ documentId: 'doc-a', graph: test.graph, sourceText: 'Source A', revision: 1 })
  await pending
  assert.equal(test.calls.filter(call => call.method === 'question-graph').length, 0,
    'leaving during canonical export must stop before starting a model request')
  assert.deepEqual(test.events.slice(boundary), [], 'a late export cannot change the new document question state')
}

for (const index of [0, 1]) {
  for (const reject of [false, true]) {
    const admitted = deferred()
    const test = fixture(index, { admitted })
    const pending = test.submit()
    test.leave()
    const boundary = test.events.length
    const newerOwner = {}
    test.admission.current = newerOwner
    if (reject) admitted.reject(new Error('old request failed'))
    else admitted.resolve({ taskId: 'old-document-task' })
    await pending
    assert.deepEqual(test.events.slice(boundary), [], 'a late admission response cannot attach a task or error to the new document')
    assert.equal(test.admission.current, newerOwner, 'cleanup must not unlock a newer submission')
  }
  const admitted = deferred()
  const duplicate = fixture(index, { admitted })
  const first = duplicate.submit()
  const second = duplicate.submit()
  assert.equal(duplicate.calls.filter(call => call.method === 'question-graph').length, 1,
    'two clicks before a React rerender must submit only one model task')
  admitted.resolve({ taskId: 'one-task' })
  await Promise.all([first, second])
  assert.deepEqual(duplicate.events.filter(event => event.name === 'setQuestionTaskId').map(event => event.value), ['one-task'])
  assert.equal(duplicate.admission.current, null, 'successful admission releases the synchronous submission lock')

  for (const boundaryKind of ['document', 'generation']) {
    const admitted = deferred()
    const changed = fixture(index, { admitted })
    const pending = changed.submit()
    if (boundaryKind === 'document') changed.leave({ bumpGeneration: false, clearAdmission: false })
    else changed.generation.current++
    const boundary = changed.events.length
    admitted.resolve({ taskId: 'stale-' + boundaryKind })
    await pending
    assert.deepEqual(changed.events.slice(boundary), [], boundaryKind + ' alone must invalidate an old admission')
  }

  const unsavedResponse = deferred()
  const unsaved = fixture(index, { admitted: unsavedResponse, unsaved: true })
  const waiting = unsaved.submit()
  unsaved.leave({ bumpGeneration: false, clearAdmission: false })
  const unsavedBoundary = unsaved.events.length
  unsavedResponse.resolve({ taskId: 'unsaved-old-task' })
  await waiting
  assert.deepEqual(unsaved.events.slice(unsavedBoundary), [], 'distinct unsaved graphs cannot share null document identity')
}

const exported = deferred()
const sameDocument = fixture(0, { truncated: true, exported })
const retained = sameDocument.submit()
sameDocument.currentView.current = { ...sameDocument.view, graph: { ...sameDocument.graph, view: { truncated: false } } }
exported.resolve({ documentId: 'doc-a', graph: sameDocument.graph, sourceText: 'Source A', revision: 1 })
await retained
assert.equal(sameDocument.calls.filter(call => call.method === 'question-graph').length, 1,
  'loading a different window of the same document must not cancel its legitimate review')
console.log('question admission: late exports, late responses, duplicate clicks, unsaved identity and same-document transitions passed')
