import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

// ---------- HOST ----------
// Extract the plugin body directly from the source file (previously the
// build depended on an externally prepared /tmp/kg-host-body.js; keeping
// that undocumented step breaks `npm run build:lib` on a fresh clone).
const srcHostPath = new URL('../src/index.host.js', import.meta.url)
const srcHost = readFileSync(srcHostPath, 'utf8')
const hostOpen = `  return {
    inject: ['timer'],
    apply(ctx) {`
const hostTail = `    },
  }`
const hostOpenIdx = srcHost.indexOf(hostOpen)
const hostTailIdx = srcHost.lastIndexOf(hostTail)
if (hostOpenIdx < 0 || hostTailIdx <= hostOpenIdx) throw new Error('host source wrapper not found')
let host = srcHost.slice(hostOpenIdx, hostTailIdx + hostTail.length)

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
import { openSqliteStore, defaultStorePath } from './kg-store.mjs'

export function apply(ctx) {
  let sqliteStorePromise = null
  const getSqliteStore = () => {
    if (!sqliteStorePromise) sqliteStorePromise = openSqliteStore(defaultStorePath())
    return sqliteStorePromise
  }
  const persistGraph = async (graph, task) => {
    const store = await getSqliteStore()
    return store.saveGraph(graph, { runId: task && task.id ? task.id : undefined })
  }
  const persistCheckpoint = async (checkpoint, task, status) => {
    const store = await getSqliteStore()
    return store.saveCheckpoint(checkpoint, { runId: task && task.id ? task.id : undefined, status })
  }`

// strip the dynamic wrapper: `return { inject, apply(ctx) {` -> header,
// and the trailing `    },\n  }` (comma before the closing brace) -> `    }`
host = host.replace(`  return {
    inject: ['timer'],
    apply(ctx) {`, hostHeader)
host = host.replace(`    },
  }`, '    }')

const routeBlock = `      // ---- HTTP RPC over the host webServer (persistent mode) ----
      const webServer = ctx.get('webServer')
      if (!webServer) return
      const kgHandle = async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.local')
            const pathname = url.pathname
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/extract') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先粘贴资料正文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              const skills = Array.isArray(a.skills) ? a.skills.filter((s) => typeof s === 'string' && s).slice(0, 4) : []
              seq += 1
              const checkpoint = a.checkpoint && typeof a.checkpoint === 'object' ? a.checkpoint : null
               const task = {
                 id: 'kg-' + Date.now().toString(36) + '-' + seq,
                 status: 'running',
                 kind: checkpoint ? 'resume' : undefined,
                 title,
                 text,
                 documentId: typeof a.documentId === 'string' && a.documentId.trim()
                   ? a.documentId.trim().slice(0, 160)
                   : (checkpoint && typeof checkpoint.documentId === 'string' ? checkpoint.documentId.slice(0, 160) : ''),
                 checkpoint,
                 existing: checkpoint && checkpoint.graph && typeof checkpoint.graph === 'object' ? checkpoint.graph : null,
                 paragraphOffset: checkpoint && Number.isInteger(checkpoint.paragraphOffset) ? checkpoint.paragraphOffset : 0,
                 model,
                 skills,
                 createdAt: Date.now(),
               }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/document-import') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
              const pendingProvided = Object.prototype.hasOwnProperty.call(a, 'pending')
              const pendingText = pendingProvided && typeof a.pending === 'string' ? a.pending : ''
              if (!sessionId) return writeJson(res, 200, { error: { code: 'no_session', message: '缺少会话 id，无法读取附件' } })
              const sessions = ctx.get('sessions')
              const session = sessions ? sessions.get(sessionId) : undefined
              if (!session) return writeJson(res, 200, { error: { code: 'no_session', message: '找不到该会话，无法读取当前输入框附件' } })
              const collected = await collectDocumentAttachmentsHost(sessionId, session, pendingProvided ? pendingText : undefined)
              if (collected.found.length === 0) {
                return writeJson(res, 200, {
                  error: { code: 'no_attachment', message: pendingProvided ? '当前输入框没有检测到可读取的未发送附件文档，请先添加文档附件。' : '当前会话没有检测到附件文档。支持 dsh-paste-input 附件与 dsh-at-file 的 @文件引用。' },
                  warnings: collected.warnings,
                })
              }
              let text = ''
              let remaining = MAX_TEXT
              let truncated = false
              const files = []
              for (const f of collected.found) {
                const prefix = '==== 文件：' + f.name + ' ====' + NL
                const body = f.text || ''
                let part = prefix + body
                if (part.length > remaining) {
                  part = part.slice(0, remaining)
                  truncated = true
                }
                text += part + NL + NL
                remaining -= part.length + 2
                files.push({ name: f.name, path: f.path, format: f.format || 'text', bytes: f.bytes || 0, chars: body.length, warning: f.warning || null })
                if (remaining <= 0) break
              }
              const names = files.map((f) => f.name).join('、')
              const baseTitle = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : (files.length + ' 份附件')
              const title = (baseTitle || '附件文档').slice(0, 60)
              const importManifest = buildSourceManifestHost(title, text, splitParagraphsHost(text))
              return writeJson(res, 200, {
                title,
                text,
                files,
                names,
                truncated,
                manifest: {
                  documentId: importManifest.documentId,
                  sourceId: importManifest.sourceId,
                  chars: importManifest.chars,
                  paragraphCount: importManifest.paragraphCount,
                  chunkCount: importManifest.chunkCount,
                  sectionCount: importManifest.sectionCount,
                  sections: importManifest.sections.map((section) => ({
                    id: section.id,
                    title: section.title,
                    startParagraph: section.startParagraph,
                    endParagraph: section.endParagraph,
                  })),
                },
                warnings: collected.warnings,
              })
            }
            if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/dsh-knowledge-graph/list-models') {
              const llm = ctx.get('llm')
              const providers = []
              if (llm) {
                try {
                  const list = llm.listProviders()
                  const results = await Promise.all(list.map(async (p) => {
                    try {
                      const models = await listModelsSoft(llm, p.id, 8000)
                      return { p, models: Array.isArray(models) ? models : [] }
                    } catch (e) { return null }
                  }))
                  for (const r of results) {
                    if (!r) continue
                    providers.push({
                      id: r.p.id,
                      name: r.p.name || r.p.id,
                      models: r.models.filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name || m.id })),
                    })
                  }
                } catch (e) { /* no providers */ }
              }
              let current = null
              const adm = ctx.get('agentDefaultModel')
              if (adm) {
                try {
                  const sel = await softRace(() => adm.currentSelection(), 8000)
                  if (sel && sel.provider && sel.model) current = { provider: sel.provider, model: sel.model }
                } catch (e) { /* ignore */ }
              }
              return writeJson(res, 200, { providers, current })
            }
            if (pathname === '/api/dsh-knowledge-graph/task-status' || pathname === '/api/dsh-knowledge-graph/trajectory-status') {
              const taskId = url.searchParams.get('taskId') ?? ''
               const includeCheckpoint = url.searchParams.get('includeCheckpoint') === '1'
              const t = tasks.get(taskId)
              if (!t) return writeJson(res, 200, { status: 'not_found' })
              if (t.status === 'succeeded') return writeJson(res, 200, { status: 'succeeded', result: t.result })
              if (t.status === 'cancelled') return writeJson(res, 200, { status: 'cancelled', error: { code: t.errorCode, message: t.errorMessage }, ...(includeCheckpoint && t.checkpoint ? { checkpoint: t.checkpoint } : {}) })
              if (t.status === 'failed') return writeJson(res, 200, { status: 'failed', error: { code: t.errorCode, message: t.errorMessage }, ...(includeCheckpoint && t.checkpoint ? { checkpoint: t.checkpoint } : {}) })
              return writeJson(res, 200, {
                status: 'running',
                progress: {
                  stage: t.progress && t.progress.stage ? t.progress.stage : '运行中',
                  charsReceived: t.progress ? (t.progress.charsReceived || 0) : 0,
                  elapsedMs: t.createdAt ? Date.now() - t.createdAt : 0,
                  warning: t.progress && t.progress.warning ? t.progress.warning : null,
                  model: t.progress && t.progress.model ? t.progress.model : null,
                   batch: t.progress && t.progress.batch ? t.progress.batch : null,
                   checkpoint: includeCheckpoint && t.checkpoint ? t.checkpoint : null,
                },
              })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/task-cancel') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const taskId = typeof a.taskId === 'string' ? a.taskId : ''
              const t = tasks.get(taskId)
              if (!t) return writeJson(res, 200, { status: 'not_found' })
              if (t.status !== 'running') return writeJson(res, 200, { status: t.status })
              t.cancelled = true
              if (Array.isArray(t.cancelHooks)) {
                for (const hook of t.cancelHooks) { try { hook() } catch (e) {} }
              }
              if (typeof t.abortStream === 'function') { try { t.abortStream() } catch (e) {} }
              return writeJson(res, 200, { status: 'cancelling' })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/verify-graph') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先提供图对应的原文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              const graph = a.graph && typeof a.graph === 'object' ? a.graph : null
              if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可验证的知识图' } })
              }
              if (graph.nodes.length > MAX_VERIFY_NODES) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '知识图节点过多（' + graph.nodes.length + ' 个），请缩短内容后重试' } })
              }
              const mode = a.mode === 'standard' ? 'standard' : 'quick'
              if (mode === 'quick') return writeJson(res, 200, { report: buildLocalReport(graph, text) })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有 AI 任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              const skills = Array.isArray(a.skills) ? a.skills.filter((s) => typeof s === 'string' && s).slice(0, 4) : []
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'verify',
                text, graph, mode, model, skills, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runVerifyTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] verify task crashed', e)
                failTask(task, 'failed', 'AI 审校失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/question-graph') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              const question = typeof a.question === 'string' ? a.question.trim() : ''
              if (!question) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先输入要质疑的问题' } })
              if (question.length > 600) return writeJson(res, 200, { error: { code: 'invalid_input', message: '质疑问题不能超过 600 字' } })
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先提供图对应的原文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              const graph = a.graph && typeof a.graph === 'object' ? a.graph : null
              if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可质疑的知识图' } })
              }
              if (graph.nodes.length > MAX_VERIFY_NODES) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '知识图节点过多（' + graph.nodes.length + ' 个），请缩短内容后重试' } })
              }
              const target = a.target && typeof a.target === 'object'
                ? { kind: a.target.kind === 'edge' ? 'edge' : a.target.kind === 'node' ? 'node' : 'graph', id: typeof a.target.id === 'string' ? a.target.id.trim() : null }
                : { kind: 'graph', id: null }
              if (target.kind !== 'graph' && !target.id) return writeJson(res, 200, { error: { code: 'invalid_input', message: '质疑目标缺少 id' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有 AI 任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              const skills = Array.isArray(a.skills) ? a.skills.filter((s) => typeof s === 'string' && s).slice(0, 4) : []
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'question',
                text, graph, target, question, model, skills, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runQuestionTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] question task crashed', e)
                failTask(task, 'failed', 'AI 质疑回答失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/fact-check') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先提供要核查的原文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              const graph = a.graph && typeof a.graph === 'object' ? a.graph : null
              if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可核查的知识图' } })
              }
              if (graph.nodes.length > MAX_VERIFY_NODES) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '知识图节点过多（' + graph.nodes.length + ' 个），请缩短内容后重试' } })
              }
              const mode = a.mode === 'quick' ? 'quick' : 'deep'
              const requested = Array.isArray(a.sources) ? a.sources : ['wikipedia']
              const sources = requested.filter((s) => s === 'wikipedia' || s === 'rules')
              if (mode === 'deep' && sources.length === 0) return writeJson(res, 200, { error: { code: 'invalid_input', message: '深度核查至少需要一个证据来源（wikipedia 或 rules）' } })
              const rules = typeof a.rules === 'string' ? a.rules.slice(0, 10000) : ''
              if (sources.includes('rules') && !rules.trim()) return writeJson(res, 200, { error: { code: 'invalid_input', message: '选择了规则来源，请粘贴领域规则/法条/教材内容' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有 AI 任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              const skills = Array.isArray(a.skills) ? a.skills.filter((s) => typeof s === 'string' && s).slice(0, 4) : []
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'fact-check',
                text, graph, mode, sources, rules, model, skills, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runFactCheckTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] fact-check task crashed', e)
                failTask(task, 'failed', 'AI 外部事实核查失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/trajectory-append-extract') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
              const sessions = ctx.get('sessions')
              const session = sessions ? sessions.get(sessionId) : undefined
              if (!session) return writeJson(res, 200, { error: { code: 'no_session', message: '找不到该会话（可能尚未开始或已结束），请先在对话中发一条消息再试' } })
              const existing = a.existing && typeof a.existing === 'object' ? a.existing : null
              if (!existing || !Array.isArray(existing.nodes) || existing.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可追加的轨迹图，请先完成一次拆解' } })
              }
              const baseTraceText = typeof existing.traceText === 'string' ? existing.traceText : ''
              const baseTraceEvents = Array.isArray(existing.traceEvents) ? existing.traceEvents.filter((e) => e && typeof e.seq === 'number') : []
              let fromSeq = -1
              for (const ev of baseTraceEvents) if (ev.seq > fromSeq) fromSeq = ev.seq
              const newEvents = []
              for (const ev of session.events || []) {
                if (typeof ev.seq === 'number' && ev.seq > fromSeq) newEvents.push(ev)
              }
              if (newEvents.length === 0) return writeJson(res, 200, { error: { code: 'empty', message: '该会话在上次拆解后没有新事件，无需追加' } })
              const trace = serializeTrace(newEvents)
              if (!trace.traceText) return writeJson(res, 200, { error: { code: 'empty', message: '该会话还没有可拆解的轨迹内容' } })
              const paragraphOffset = baseTraceText ? splitParagraphsHost(baseTraceText).length : 0
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              const skills = Array.isArray(a.skills) ? a.skills.filter((s) => typeof s === 'string' && s).slice(0, 4) : []
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'trajectory-append',
                title: '', text: trace.traceText, traceText: trace.traceText, traceEvents: trace.traceEvents,
                baseTraceText, baseTraceEvents, existing, paragraphOffset, model, skills,
                createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] trajectory append task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/append-extract') {
              const raw = await readBody(req, 4 * 1024 * 1024)
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
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              const skills = Array.isArray(a.skills) ? a.skills.filter((s) => typeof s === 'string' && s).slice(0, 4) : []
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'append',
                title, text, existing, documentId: typeof a.documentId === 'string' ? a.documentId.trim().slice(0, 160) : '', paragraphOffset, model, skills, createdAt: Date.now(),
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
              const raw = await readBody(req, 4 * 1024 * 1024)
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
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              const skills = Array.isArray(a.skills) ? a.skills.filter((s) => typeof s === 'string' && s).slice(0, 4) : []
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'trajectory',
                title: '', text: trace.traceText, traceText: trace.traceText, traceEvents: trace.traceEvents, model, skills,
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
        }
      // Extension endpoint (/dsh-kg): NOT under /api, so the browser-trust
      // fence does not gate it (chrome-extension origins would be rejected as
      // cross-site). The Origin check below is the no-token abuse guard.
      const kgExtHandle = async (req, res) => {
        const origin = (req.headers && req.headers.origin) || ''
        if (origin) {
          const ok = /^chrome-extension:\\/\\//.test(origin)
            || /^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/i.test(origin)
          if (!ok) return writeJson(res, 403, { error: { code: 'forbidden', message: 'origin not allowed' } })
          res.setHeader('Access-Control-Allow-Origin', origin)
          res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
          // Chrome 142+ Private Network Access: a public/extension context
          // calling a local server needs this preflight acknowledgement.
          res.setHeader('Access-Control-Allow-Private-Network', 'true')
        }
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
        // Rewrite the URL so the shared kgHandle router sees its native
        // /api/dsh-knowledge-graph/... paths (/dsh-kg/extract -> .../extract).
        const u = new URL(req.url ?? '/', 'http://dsh.local')
        let rewritten = u.pathname
        if (rewritten.startsWith('/dsh-kg')) {
          const rest = rewritten.replace(/^\\/dsh-kg\\/?/, '')
          rewritten = '/api/dsh-knowledge-graph' + (rest ? '/' + rest : '')
        }
        req.url = rewritten + u.search
        return kgHandle(req, res)
      }
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/dsh-knowledge-graph',
        handler: kgHandle,
      }), 'dsh-knowledge-graph: extract route')
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/dsh-kg',
        handler: kgExtHandle,
      }), 'dsh-knowledge-graph: extension route')`

// Replace the whole harness-RPC region (extract .. append-extract) with the
// HTTP router. Range replacement by markers keeps this script robust when new
// RPC methods (e.g. verify-graph / question-graph) are inserted in the source.
const rpcStartMarker = `      harness.handle('fact-check', async (args) => {`
const rpcEndMarker = `      // Periodically purge finished tasks`
const rpcStartIdx = host.indexOf(rpcStartMarker)
const rpcEndIdx = host.indexOf(rpcEndMarker)
if (rpcStartIdx < 0 || rpcEndIdx <= rpcStartIdx) throw new Error('host RPC region not found')
host = host.slice(0, rpcStartIdx) + routeBlock + host.slice(rpcEndIdx)

const helpers = `
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''
    let done = false
    const onData = (chunk) => {
      data += chunk
      if (Buffer.byteLength(data, 'utf8') > limit) finish(new Error('body too large'))
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

writeFileSync(new URL('../lib/index.js', import.meta.url), host)
copyFileSync(new URL('../src/kg-store.mjs', import.meta.url), new URL('../lib/kg-store.mjs', import.meta.url))
console.log('host written, lines:', host.split('\n').length)
