// Full production workbench/trajectory client and persistent HTTP host, backed
// by an owned temporary SQLite database and a manually controlled model.
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as plugin from '../lib/index.js'

const directory = mkdtempSync(join(tmpdir(), 'kg-verification-ui-'))
process.env.DSH_KG_DB = join(directory, 'fixture.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const documentId = 'verification-fixture'
const paragraphs = Array.from({ length: 37 }, (_, i) => 'Fixture observation ' + i + ' is recorded in the source.')
const sourceText = paragraphs.join('\n\n')
const graph = {
  source: { id: documentId, documentId, title: 'Verification fixture' },
  nodes: paragraphs.map((text, i) => ({ id: 'n' + i, type: 'fact', text, quote: text, paragraph: i,
    evidence: [{ documentId, sourceId: documentId, paragraph: i, quote: text }], groundingStatus: 'grounded' })),
  edges: [],
  traceText: sourceText,
  traceEvents: paragraphs.map((line, index) => ({ line, index, type: 'user/message', title: 'Fixture event ' + index })),
}
store.saveGraph(graph, { sourceText })
const routes = new Map(), ctx = new Context(), pending = new Set()
const stats = { submissions: 0, statusCalls: 0, commits: 0, modelCalls: 0 }
let dropStatus = 0, rejectSave = false, finishAutomatically = false
class Timer extends Service {
  constructor(context) { super(context, 'timer'); context.mixin('timer', ['interval']) }
  interval(fn, ms) { return this.ctx.effect(() => { const id = setInterval(fn, ms); return () => clearInterval(id) }) }
}
await ctx.plugin(Timer)
ctx.provide('llm', { stream() {
  stats.modelCalls++
  let closed = false
  const values = [{ done: false, value: { type: 'reasoning-delta', index: 0, text: 'fixture' } }], readers = []
  const stream = {
    [Symbol.asyncIterator]() { return this },
    next() { return values.length ? Promise.resolve(values.shift()) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => readers.push(resolve)) },
    return() { closed = true; pending.delete(stream); while (readers.length) readers.shift()({ done: true }); return Promise.resolve({ done: true }) },
    finish() {
      if (closed) return
      const item = { done: false, value: { type: 'text-delta', index: 0, text: '{"issues":[]}' } }
      if (readers.length) readers.shift()(item); else values.push(item)
      this.return()
    },
  }
  pending.add(stream)
  if (finishAutomatically) setTimeout(() => stream.finish(), 100)
  return stream
} })
ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
await ctx.plugin(plugin).await()
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Isolated verification fixture</title><style>body{margin:0;font:14px system-ui}main{max-width:1280px;margin:auto;padding:12px;box-sizing:border-box}nav{display:flex;gap:8px;padding:8px;flex-wrap:wrap;background:#e5e7eb;color:#111}#fixture-state{overflow-wrap:anywhere}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script></head><body>
<nav aria-label="Fixture controls"><a href="/">Workbench fixture</a><a href="/?trajectory=1">Trajectory fixture</a>
<button onclick="control('next')">Finish one batch</button><button onclick="control('complete')">Complete fixture task</button>
<button onclick="control('offline')">Drop two status requests</button><button onclick="control('reject-save')">Reject next report save</button></nav>
<main class="kg-root" id="root"></main><pre id="fixture-state"></pre>
<script>
window.fixtureErrors=[];window.addEventListener('error',event=>fixtureErrors.push(event.message));
async function control(action){await fetch('/fixture/'+action,{method:'POST'})}
localStorage.setItem('dsh-kg-result-v2',JSON.stringify({documentId:'verification-fixture',title:'Verification fixture'}));
localStorage.setItem('dsh-kg-traj-result-v2:fixture',JSON.stringify({documentId:'verification-fixture'}));
window.__ModuleLoader__={load({factory}){
 const client=factory(name=>{if(name==='react')return React;throw new Error('Unexpected module '+name)});
 const slots={inject(){},register(){}};
 const ctx={get:name=>name==='slots'?slots:null,timeout(fn,ms){const id=setTimeout(fn,ms);return ()=>clearTimeout(id)}};
 client.apply(ctx);
 const trajectory=new URLSearchParams(location.search).has('trajectory');
 ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(trajectory?fixtureComponents.TrajectoryTab:fixtureComponents.WorkbenchBody,trajectory?{sessionId:'fixture'}:{ctx}));
}};
setInterval(async()=>{document.getElementById('fixture-state').textContent=JSON.stringify(await fetch('/fixture/stats').then(r=>r.json()))},1000);
</script><script src="/client.js"></script></body></html>`
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('cache-control', 'no-store')
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
    if (url.pathname === '/fixture/stats') { json({ ...stats, pending: pending.size, revision: store.getDocumentRevision(documentId) }); return }
    if (url.pathname.startsWith('/fixture/') && req.method === 'POST') {
      if (url.pathname.endsWith('/offline')) dropStatus = 2
      if (url.pathname.endsWith('/reject-save')) rejectSave = true
      if (url.pathname.endsWith('/complete')) { finishAutomatically = true; for (const stream of pending) stream.finish() }
      if (url.pathname.endsWith('/next')) pending.values().next().value?.finish()
      json({ ok: true }); return
    }
    if (url.pathname.endsWith('/list-models')) { json({ providers: [], current: { provider: 'fixture', model: 'controlled-model-with-long-name-for-wrapping-check' } }); return }
    if (url.pathname.endsWith('/verify-graph')) {
      stats.submissions++; finishAutomatically = false
      // Delay only response delivery: the real route must still consume the body.
      const end = res.end.bind(res)
      res.end = (...args) => { setTimeout(() => { if (!res.destroyed) end(...args) }, 2000); return res }
    }
    if (url.pathname.endsWith('/task-status')) {
      stats.statusCalls++
      if (dropStatus > 0) { dropStatus--; res.statusCode = 503; res.end('fixture offline'); return }
    }
    if (url.pathname.endsWith('/graph-commit')) {
      stats.commits++
      if (rejectSave) { rejectSave = false; json({ error: { code: 'fixture_save_failed', message: 'Fixture report save rejected' } }); return }
    }
    if (url.pathname.startsWith('/api/')) { await routes.get('/api/dsh-knowledge-graph').handler(req, res); return }
    if (url.pathname === '/client.js') {
      const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
      const marker = '      // --------------------------- slot registration'
      if (!source.includes(marker)) throw new Error('client exposure marker not found')
      res.setHeader('content-type', 'text/javascript')
      res.end(source.replace(marker, '      window.fixtureComponents = { WorkbenchBody, TrajectoryTab };\n' + marker))
      return
    }
    const asset = { '/react.js': 'react.production.min.js', '/react-dom.js': 'react-dom.production.min.js' }[url.pathname]
    if (asset) { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(new URL('../extension/vendor/' + asset, import.meta.url))); return }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
    res.statusCode = 404; res.end()
  } catch (error) { res.statusCode = 500; res.end(String(error.stack)) }
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
async function stop() {
  for (const stream of pending) stream.return()
  await ctx.fiber.dispose(); store.close(); server.closeAllConnections(); server.close()
  rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}
process.once('SIGTERM', stop); process.once('SIGINT', stop)
