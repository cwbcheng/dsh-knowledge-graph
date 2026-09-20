import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const sections = source.split('// ---- adaptive-backoff polling while a task runs ----').slice(1)
assert.equal(sections.length, 2)
for (const section of sections) {
  // Execute the actual effect through transport recovery, before graph handling.
  const prefix = section.slice(section.indexOf('useEffect('), section.indexOf("if (res && res.status === 'succeeded')"))
  const code = prefix + `}; tick(); return () => { disposed = true; if (stop) stop() }; }, [taskId]);`
  for (const scenario of ['recover', 'unmount', 'late-rejection']) {
    let cleanup, error = null, calls = 0, progress = null, rejectPending
    const queue = new Set()
    const sequence = { current: 1 }
    const host = { async call(endpoint, args) {
      assert(['task-status', 'trajectory-status'].includes(endpoint))
      assert.equal(args.taskId, 'original-task')
      calls++
      if (scenario === 'late-rejection') return new Promise((resolve, reject) => { rejectPending = reject })
      if (calls <= 8) throw new TypeError('Failed to fetch')
      return { status: 'running', progress: { stage: 'working' } }
    } }
    const ctx = { timeout(fn, delay) {
      assert(delay >= 3000 && delay <= 15000)
      queue.add(fn)
      return () => queue.delete(fn)
    } }
    new Function('useEffect', 'taskId', 'host', 'ctx', 'setError', 'setExtractProgress', 'sessionSeq', 'phase', code)(
      fn => { cleanup = fn() }, 'original-task', host, ctx,
      value => { error = typeof value === 'function' ? value(error) : value },
      value => { progress = value }, sequence, 'extracting',
    )
    const flush = () => new Promise(resolve => setImmediate(resolve))
    await flush()
    if (scenario === 'late-rejection') {
      cleanup()
      rejectPending(new TypeError('Failed to fetch'))
      await flush()
      assert.equal(error, null)
      assert.equal(queue.size, 0)
    } else if (scenario === 'unmount') {
      assert.equal(queue.size, 1)
      cleanup()
      assert.equal(queue.size, 0)
    } else {
      assert.equal(error.code, 'status_connection_lost')
      for (let i = 0; i < 8; i++) {
        assert.equal(queue.size, 1, 'Only one status retry may be scheduled')
        const [tick] = queue
        queue.delete(tick)
        await tick()
      }
      assert.equal(calls, 9)
      assert.equal(error, null)
      assert.deepEqual(progress, { stage: 'working' })
      cleanup()
    }
  }
}
// Execute the production restart-recovery function, not a duplicate model.
const resumeCode = source.slice(source.indexOf('const resumeLostTask = async () => {'), source.indexOf('// ---- adaptive-backoff polling while a task runs ----'))
let pending = { taskId: 'original', title: 'saved source', documentId: 'document', append: true }
let recoveredId, error, calls = 0, release
const resumeAttemptRef = { current: false }
const submittedRef = { current: null }
const resume = new Function('resumeAttemptRef', 'localStorage', 'LS_PENDING', 'effectiveModelArg', 'host',
  'submittedRef', 'rememberPendingTask', 'setTaskId', 'setPhase', 'setExtractProgress', 'setError', 'toastStore', 'loadHistoryEntry',
  resumeCode + '\nreturn resumeLostTask;')(
  resumeAttemptRef, { getItem: () => JSON.stringify(pending) }, 'pending', null,
  { async call(endpoint, args) {
    assert.equal(endpoint, 'resume-extract')
    assert.equal(args.runId, pending.taskId)
    calls++
    return new Promise(resolve => { release = resolve })
  } }, submittedRef,
  (taskId, sub) => { pending = { taskId, ...sub } }, value => { recoveredId = value }, () => {}, () => {},
  value => { error = value }, { show() {} }, async () => {},
)
for (const id of ['after-first-restart', 'after-second-restart']) {
  const recovery = resume()
  assert.equal(await resume(), false, 'an in-flight resume must not be submitted twice')
  release({ taskId: id })
  assert.equal(await recovery, true)
  assert.equal(recoveredId, id)
  assert.equal(pending.taskId, id, 'later crashes must use the recovered task identity')
  assert.equal(pending.documentId, 'document')
  assert.equal(pending.append, true)
  assert.equal(resumeAttemptRef.current, false, 'successful recovery must re-arm future recovery')
  assert.equal(error, null)
}
assert.equal(calls, 2)
const failed = resume()
release({ error: { code: 'revision_conflict', message: 'changed' } })
assert.equal(await failed, false)
assert.equal(await resume(), false, 'rejected recovery must not loop or bypass the revision fence')
assert.equal(calls, 3)
assert.equal(error.code, 'revision_conflict')
console.log(JSON.stringify({ok:true, originalTaskPreserved:true, boundedBackoff:true, recovery:true, unmountAndLateRejection:true,
  successiveRestarts:true, duplicateResumePrevented:true, rejectedRecoveryDoesNotLoop:true}))
