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
    new Function('useEffect', 'taskId', 'host', 'ctx', 'setError', 'setExtractProgress', 'sessionSeq', code)(
      fn => { cleanup = fn() }, 'original-task', host, ctx,
      value => { error = typeof value === 'function' ? value(error) : value },
      value => { progress = value }, sequence,
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
console.log(JSON.stringify({ok:true, originalTaskPreserved:true, boundedBackoff:true, recovery:true, unmountAndLateRejection:true}))
