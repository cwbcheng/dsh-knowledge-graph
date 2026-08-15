import { readFileSync, writeFileSync } from 'node:fs'

// ---------- HOST ----------
let host = readFileSync('/tmp/kg-host-body.js', 'utf8')

const hostHeader = `/**
 * dsh-knowledge-graph — persistent host half (Cordis composition module).
 *
 * Mirrors src/index.host.js (dynamic-package format) for the persistent
 * install: same engine, but the browser talks to it over the webServer HTTP
 * route /api/dsh-knowledge-graph instead of the package-private harness RPC.
 * Keep engine logic in sync with src/index.host.js.
 */
export const name = 'dsh-knowledge-graph'
// webServer hosts the RPC route; timer gives ctx.timeout/ctx.interval.
export const inject = ['webServer', 'timer']

export function apply(ctx) {`

// strip the dynamic wrapper: `return { inject, apply(ctx) {` -> header,
// and the trailing `    },\n  }` (comma before the closing brace) -> `    }`
host = host.replace(`  return {
    inject: ['timer'],
    apply(ctx) {`, hostHeader)
host = host.replace(`    },
  }`, '    }')

const extractBlock = `      harness.handle('extract', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
        const text = typeof a.text === 'string' ? a.text.trim() : ''
        if (!text) return { error: { code: 'invalid_input', message: '请先粘贴资料正文' } }
        if (text.length > MAX_TEXT) return { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } }
        if (busy) return { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } }
        seq += 1
        const task = { id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', title, text, createdAt: Date.now() }
        tasks.set(task.id, task)
        busy = true
        Promise.resolve().then(() => runTask(task)).catch((e) => {
          console.error('[dsh-knowledge-graph] task crashed', e)
          failTask(task, 'failed', 'AI 拆分失败：内部错误')
        }).finally(() => { busy = false })
        return { taskId: task.id }
      })

      harness.handle('task-status', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const taskId = typeof a.taskId === 'string' ? a.taskId : ''
        const t = tasks.get(taskId)
        if (!t) return { status: 'not_found' }
        if (t.status === 'succeeded') return { status: 'succeeded', result: t.result }
        if (t.status === 'failed') return { status: 'failed', error: { code: t.errorCode, message: t.errorMessage } }
        return { status: 'running' }
      })

      harness.handle('trajectory-extract', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
        const sessions = ctx.get('sessions')
        const session = sessions ? sessions.get(sessionId) : undefined
        if (!session) return { error: { code: 'no_session', message: '找不到该会话（可能尚未开始或已结束），请先在对话中发一条消息再试' } }
        const trace = serializeTrace(session.events)
        if (!trace.traceText) return { error: { code: 'empty', message: '该会话还没有可拆解的轨迹内容' } }
        if (busy) return { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } }
        seq += 1
        const task = {
          id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'trajectory',
          title: '', text: trace.traceText, traceText: trace.traceText, traceEvents: trace.traceEvents,
          createdAt: Date.now(),
        }
        tasks.set(task.id, task)
        busy = true
        Promise.resolve().then(() => runTask(task)).catch((e) => {
          console.error('[dsh-knowledge-graph] trajectory task crashed', e)
          failTask(task, 'failed', 'AI 拆分失败：内部错误')
        }).finally(() => { busy = false })
        return { taskId: task.id }
      })

      harness.handle('trajectory-status', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const taskId = typeof a.taskId === 'string' ? a.taskId : ''
        const t = tasks.get(taskId)
        if (!t) return { status: 'not_found' }
        if (t.status === 'succeeded') return { status: 'succeeded', result: t.result }
        if (t.status === 'failed') return { status: 'failed', error: { code: t.errorCode, message: t.errorMessage } }
        return { status: 'running' }
      })

      harness.handle('append-extract', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
        const text = typeof a.text === 'string' ? a.text.trim() : ''
        if (!text) return { error: { code: 'invalid_input', message: '请先粘贴要追加的资料正文' } }
        if (text.length > MAX_TEXT) return { error: { code: 'invalid_input', message: '追加正文不能超过 ' + MAX_TEXT + ' 字' } }
        const existing = a.existing && typeof a.existing === 'object' ? a.existing : null
        if (!existing || !Array.isArray(existing.nodes) || existing.nodes.length === 0) {
          return { error: { code: 'invalid_input', message: '当前没有可追加的已有图，请先完成一次拆分' } }
        }
        const paragraphOffset = Number.isInteger(a.paragraphOffset) && a.paragraphOffset > 0 ? a.paragraphOffset : 0
        if (busy) return { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } }
        seq += 1
        const task = {
          id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'append',
          title, text, existing, paragraphOffset, createdAt: Date.now(),
        }
        tasks.set(task.id, task)
        busy = true
        Promise.resolve().then(() => runTask(task)).catch((e) => {
          console.error('[dsh-knowledge-graph] append task crashed', e)
          failTask(task, 'failed', 'AI 拆分失败：内部错误')
        }).finally(() => { busy = false })
        return { taskId: task.id }
      })`

const routeBlock = `      // ---- HTTP RPC over the host webServer (persistent mode) ----
      const webServer = ctx.get('webServer')
      if (!webServer) return
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/dsh-knowledge-graph',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.local')
            const pathname = url.pathname
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/extract') {
              const raw = await readBody(req, 524288)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先粘贴资料正文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              seq += 1
              const task = { id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', title, text, createdAt: Date.now() }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (pathname === '/api/dsh-knowledge-graph/task-status' || pathname === '/api/dsh-knowledge-graph/trajectory-status') {
              const taskId = url.searchParams.get('taskId') ?? ''
              const t = tasks.get(taskId)
              if (!t) return writeJson(res, 200, { status: 'not_found' })
              if (t.status === 'succeeded') return writeJson(res, 200, { status: 'succeeded', result: t.result })
              if (t.status === 'failed') return writeJson(res, 200, { status: 'failed', error: { code: t.errorCode, message: t.errorMessage } })
              return writeJson(res, 200, { status: 'running' })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/append-extract') {
              const raw = await readBody(req, 524288)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先粘贴要追加的资料正文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '追加正文不能超过 ' + MAX_TEXT + ' 字' } })
              const existing = a.existing && typeof a.existing === 'object' ? a.existing : null
              if (!existing || !Array.isArray(existing.nodes) || existing.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可追加的已有图，请先完成一次拆分' } })
              }
              const paragraphOffset = Number.isInteger(a.paragraphOffset) && a.paragraphOffset > 0 ? a.paragraphOffset : 0
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'append',
                title, text, existing, paragraphOffset, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] append task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/trajectory-extract') {
              const raw = await readBody(req, 524288)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
              const sessions = ctx.get('sessions')
              const session = sessions ? sessions.get(sessionId) : undefined
              if (!session) return writeJson(res, 200, { error: { code: 'no_session', message: '找不到该会话（可能尚未开始或已结束），请先在对话中发一条消息再试' } })
              const trace = serializeTrace(session.events)
              if (!trace.traceText) return writeJson(res, 200, { error: { code: 'empty', message: '该会话还没有可拆解的轨迹内容' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'trajectory',
                title: '', text: trace.traceText, traceText: trace.traceText, traceEvents: trace.traceEvents,
                createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] trajectory task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            return writeJson(res, 404, { error: { code: 'not_found', message: 'unknown endpoint' } })
          } catch (error) {
            writeJson(res, 500, { error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
          }
        },
      }), 'dsh-knowledge-graph: extract route')`

if (!host.includes(extractBlock)) throw new Error('host extract block not found')
host = host.replace(extractBlock, routeBlock)

const helpers = `
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''
    let done = false
    const onData = (chunk) => {
      data += chunk
      if (data.length > limit) finish(new Error('body too large'))
    }
    const onEnd = () => finish()
    const onError = (err) => finish(err)
    const finish = (err) => {
      if (done) return
      done = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      if (err) reject(err)
      else resolve(data)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}
`

// insert helpers before the purge interval comment
host = host.replace('      // Periodically purge finished tasks (kept for 2h after completion).', helpers + '\n      // Periodically purge finished tasks (kept for 2h after completion).')

writeFileSync('/mnt/d/github/dsh-knowledge-graph/lib/index.js', host)
console.log('host written, lines:', host.split('\n').length)
