import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('        const recoverSavedRun = async (run) => {')
const end = client.indexOf('        const deleteSavedRun = async (run) => {', start)
assert(start >= 0 && end > start)
const source = client.slice(start, end) + '; return recoverSavedRun'
const documentId = 'recovery-document'
const report = { reportId: 'vd-recovered', issues: [], metrics: {} }
const run = { runId: 'verify-recovery', taskKind: 'verify', documentId, title: 'Recovery fixture', status: 'succeeded' }

function fixture(response, revision = 4, attached = false, commitResult = { revision: revision + 1 }) {
  const graph = { source: { documentId }, nodes: [], edges: [],
    ...(attached ? { verification: { lastReport: report } } : {}) }
  const view = { graph, sourceText: 'fixture text' }
  const calls = [], errors = [], commits = [], states = [], refreshes = []
  const env = {
    runActionRef: { current: false }, taskId: null, verifyTaskId: null,
    setRecoveringRun: value => states.push(['recovering', value]),
    loadHistoryEntry: async () => ({ view, revision }), history: [],
    host: { async call(method, payload) { calls.push([method, payload]); return typeof response === 'function' ? response(method) : response } },
    setError: value => errors.push(value),
    verifySnapshotRef: { current: null }, verifyBusyRef: { current: false },
    setVerifyPhase: value => states.push(['phase', value]),
    setVerifyProgress: value => states.push(['progress', value]),
    setVerifyTaskId: value => states.push(['taskId', value]),
    setRunsRefresh: value => refreshes.push(value),
    withVerification: (base, result, stale) => ({ ...base, verification: { lastReport: result, stale } }),
    persistGraph: async (...args) => { commits.push(args); return commitResult },
    graphRevisionRef: { current: revision },
    setVerification: value => states.push(['verification', value]),
    setResultView: value => states.push(['view', value]),
    makeView: (nextGraph, sourceText) => ({ graph: nextGraph, sourceText }),
    toastStore: { show(value) { states.push(['toast', value]) } },
  }
  return { action: new Function(...Object.keys(env), source)(...Object.values(env)), calls, errors, commits, states,
    refreshes, env }
}

const complete = fixture({ status: 'succeeded', result: report, documentId, baseRevision: 4 })
await complete.action(run)
assert.deepEqual(complete.calls.map(call => call[0]), ['task-status'], 'completed report must not rerun the model')
assert.equal(complete.commits.length, 1)
assert.equal(complete.commits[0][2], 4)
assert.equal(complete.env.graphRevisionRef.current, 5)
assert(complete.states.some(([name, value]) => name === 'verification' && value === report))
assert.equal(complete.errors.length, 0)

const alreadyAttached = fixture({ status: 'succeeded', result: report, documentId, baseRevision: 4 }, 5, true)
await alreadyAttached.action(run)
assert.equal(alreadyAttached.commits.length, 0, 'a lost response after commit must not create a second revision')
assert.equal(alreadyAttached.errors.length, 0)

const stale = fixture({ status: 'succeeded', result: report, documentId, baseRevision: 4 }, 5)
await stale.action(run)
assert.equal(stale.commits.length, 0, 'a report based on an old graph must not overwrite new work')
assert.equal(stale.errors[0]?.code, 'revision_conflict')

const failedCommit = fixture({ status: 'succeeded', result: report, documentId, baseRevision: 4 }, 4, false, null)
await failedCommit.action(run)
assert.equal(failedCommit.commits.length, 1)
assert.equal(failedCommit.errors.length, 1, 'a failed save must remain recoverable rather than advertise success')
assert(!failedCommit.states.some(([name]) => name === 'verification'))

for (const status of ['running', 'paused']) {
  const live = fixture({ status, progress: { canPause: status === 'running' } })
  await live.action({ ...run, status })
  assert.deepEqual(live.calls.map(call => call[0]), ['task-status'])
  assert(live.states.some(([name, value]) => name === 'taskId' && value === run.runId))
  assert.equal(live.env.verifySnapshotRef.current.revision, 4)
}

const interrupted = fixture(method => method === 'task-status' ? { status: 'not_found' } : { taskId: run.runId })
await interrupted.action({ ...run, status: 'running' })
assert.deepEqual(interrupted.calls.map(call => call[0]), ['task-status', 'resume-verify'])
assert.equal(interrupted.calls[1][1].resumeInterrupted, true)

console.log('verification recovery UI smoke passed')
