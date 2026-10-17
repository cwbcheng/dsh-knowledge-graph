import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
for (const file of ['../src/index.client.js', '../lib/client.js']) {
  const client = readFileSync(new URL(file, import.meta.url), 'utf8')
  const data = new Map(), writes = []
  const localStorage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
  const helpers = client.slice(client.indexOf('      function rememberPendingTask('), client.indexOf('      // --------------------------- constants'))
  const storage = new Function('localStorage', 'LS_PENDING', helpers + '; return { rememberPendingTask, pendingTaskReferences, forgetPendingTask }')(localStorage, 'pending')
  storage.rememberPendingTask('a', { documentId: 'doc-a', title: 'Book A' })
  storage.rememberPendingTask('b', { documentId: 'doc-b', title: 'Book B' })
  const refs = { taskSelectionRef: { current: 0 }, historyLoadSeqRef: { current: 0 }, paragraphLocateSeqRef: { current: 0 },
    submittedRef: { current: { documentId: 'doc-a', title: 'Book A' } }, generationTaskActiveRef: { current: true } }
  const values = { ...refs, ...storage, localStorage, LS_PENDING: 'pending', taskId: 'a', resultView: null,
    setTaskId: value => writes.push(['taskId', value]), setExtractProgress: value => writes.push(['progress', value]), setPhase: value => writes.push(['phase', value]) }
  const detachStart = client.indexOf('        const detachGenerationTask =')
  const detachEnd = client.indexOf('        const resetAll =', detachStart)
  const detach = new Function(...Object.keys(values), client.slice(detachStart, detachEnd) + '; return detachGenerationTask')(...Object.values(values))
  detach()
  assert.equal(refs.taskSelectionRef.current, 1)
  assert.equal(refs.generationTaskActiveRef.current, false)
  assert.equal(storage.pendingTaskReferences().a.documentId, 'doc-a')
  assert.equal(JSON.parse(data.get('pending')).taskId, 'b', 'detaching A cannot erase B in another tab')

  // Execute the production navigation handlers. They reconnect to an accepted
  // task, never start or cancel a model call, and reject double clicks.
  const navStart = client.indexOf('        const attachBackgroundTask =')
  const navEnd = client.indexOf('        const dossierNavigationBlockedRef', navStart)
  const loading = deferred(), status = deferred(), navCalls = []
  const navValues = { ...values, workbenchNavigationBusy: false, submissionBusyRef: { current: false }, resumeAttemptRef: { current: false },
    history: [], graphCommitQueueRef: { current: Promise.resolve() }, detachGenerationTask: detach,
    resetAll: () => { detach(); return true }, setTaskNavigating: value => writes.push(['navigating', value]),
    setTitle: value => writes.push(['title', value]), setHistoryOpen: value => writes.push(['historyOpen', value]),
    setVisualPanelOpen() {}, setVisualSelection() {}, setError: value => writes.push(['error', value]),
    loadHistoryEntry: async entry => { navCalls.push(['load', entry.documentId]); return loading.promise },
    host: { call: (name, args) => { assert.equal(name, 'task-active'); navCalls.push([name, args]); return status.promise } } }
  navValues.rpc = navValues.host.call
  const nav = new Function(...Object.keys(navValues), client.slice(navStart, navEnd) + '; return { openBackgroundTask, navigateHistoryEntry }')(...Object.values(navValues))
  const navigation = nav.navigateHistoryEntry({ documentId: 'doc-b' })
  await tick()
  await nav.navigateHistoryEntry({ documentId: 'doc-c' })
  assert.deepEqual(navCalls, [['load', 'doc-b']], 'a second click must not race the document load')
  loading.resolve({ view: { sourceText: 'B source' } })
  await tick()
  status.resolve({ tasks: [{ taskId: 'b', documentId: 'doc-b', kind: 'append', append: true, status: 'running', title: 'Book B' }] })
  await navigation
  assert(refs.submittedRef.current, JSON.stringify(writes))
  assert.equal(refs.submittedRef.current.documentId, 'doc-b')
  assert.equal(refs.submittedRef.current.append, true)
  assert(writes.some(([name, value]) => name === 'taskId' && value === 'b'))
  assert.equal(navValues.submissionBusyRef.current, false)

  // A late status reply is fenced immediately by the selection epoch, even
  // before React gets around to cleaning up the previous polling effect.
  const pollStart = client.indexOf('        // ---- adaptive-backoff polling while a task runs ----')
  const pollEnd = client.indexOf('        // ---- verification task polling ----', pollStart)
  let cleanup
  const reply = deferred(), pollWrites = [], timeouts = []
  const pollValues = { useEffect: fn => { cleanup = fn() }, taskId: 'old-task', phase: 'extracting',
    taskSelectionRef: refs.taskSelectionRef, host: { call: name => { assert.equal(name, 'task-status'); return reply.promise } },
    ctx: { timeout: fn => { timeouts.push(fn); return () => {} } }, setError: value => pollWrites.push(value),
    setPhase: value => pollWrites.push(value), setExtractProgress: value => pollWrites.push(value) }
  pollValues.rpc = pollValues.host.call
  new Function(...Object.keys(pollValues), client.slice(pollStart, pollEnd))(...Object.values(pollValues))
  refs.taskSelectionRef.current++
  reply.resolve({ status: 'running', progress: { stage: 'Old progress' } })
  await tick()
  assert.deepEqual(pollWrites, [])
  assert.deepEqual(timeouts, [])
  cleanup()

  const graphLoad = deferred(), graphStarted = deferred()
  const completedValues = { ...pollValues, submittedRef: { current: { documentId: 'doc-a' } },
    documentIdOfGraph: graph => graph?.source?.documentId,
    host: { call: async name => { assert.equal(name, 'task-status'); return { status: 'succeeded', result: { source: { documentId: 'doc-a' }, nodes: [] } } } },
    loadGraphDocument: () => { graphStarted.resolve(); return graphLoad.promise } }
  completedValues.rpc = completedValues.host.call
  new Function(...Object.keys(completedValues), client.slice(pollStart, pollEnd))(...Object.values(completedValues))
  await graphStarted.promise
  const before = pollWrites.length
  refs.taskSelectionRef.current++
  graphLoad.resolve({ graph: { nodes: [], source: { documentId: 'doc-a' } }, sourceText: 'Old source' })
  await tick()
  assert.equal(pollWrites.length, before, 'a graph loaded for old A cannot overwrite the newly selected B')
  cleanup()
}
console.log('multitask UI smoke passed: independent references, background detach, navigation without model calls, double-click fence, late status and graph replies, source/build parity')
