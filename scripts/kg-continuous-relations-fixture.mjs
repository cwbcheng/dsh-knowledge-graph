import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import { apply } from '../lib/index.js'

// Full generated workbench + real HTTP routes, isolated SQLite and fake model.
const root = new URL('../', import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'kg-continuous-live-'))
process.env.DSH_KG_DB = join(dir, 'fixture.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const paragraphs = Array.from({ length: 137 }, (_, i) => '独立观察记录 ' + i + '，仅描述此项观察，不蕴含其他命题。')
store.saveGraph({ source: { id: 'fixture-source', documentId: 'fixture-document', title: '持续补全测试资料' }, summary: '独立观察记录', warnings: [],
  nodes: paragraphs.map((text, i) => ({ id: 'n' + i, type: 'claim', text, quote: text, paragraph: i, evidence: [{ paragraph: i, quote: text }] })), edges: [] },
{ sourceText: paragraphs.join('\n\n') })
if (process.env.FIXTURE_RUN_DELETE === '1') {
  for (const runId of ['delete-fixture-a', 'delete-fixture-b']) store.saveCheckpoint({
    version: 2, documentId: 'fixture-document', totalBatches: 203, nextBatchIndex: 2, graph: { nodes: [], edges: [] },
  }, { runId, status: 'failed', title: '未完成任务删除隔离测试：保留知识图与其他恢复记录', sourceText: paragraphs.join('\n\n') })
}
let handler, calls = 0
const cleanups = []
apply({ get(name) {
  if (name === 'webServer') return { register(route) { if (route.path === '/api/dsh-knowledge-graph') handler = route.handler; return () => {} } }
  return name === 'kgExtractor' ? { async weaveRelations() {
    calls++
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_WEAVE_DELAY_MS) || 2500))
    return { edges: [] }
  } } : null
}, effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); return cleanup }, interval() { return () => {} } })
const client = readFileSync(new URL('lib/client.js', root), 'utf8').replace('      // --------------------------- slot registration', '      window.FixtureWorkbench = WorkbenchBody\n      // --------------------------- slot registration')
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>持续补全隔离测试</title>
<style>body{margin:0;background:white}#app{max-width:1400px;margin:auto;padding:16px;box-sizing:border-box}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>window.__ModuleLoader__={load:entry=>{window.fixturePlugin=entry.factory(name=>{if(name==='react')return React;throw Error('Unexpected dependency '+name)})}}</script>
<script src="/client.js"></script></head><body><div id="app" class="kg-root kg-win-body"></div><script>
if(!localStorage.getItem('dsh-kg-result-v2'))localStorage.setItem('dsh-kg-result-v2',JSON.stringify({documentId:'fixture-document',title:'持续补全测试资料'}));
const ctx={get:name=>name==='slots'?{inject(){},register(){}}:undefined,timeout:(fn,ms)=>{const id=setTimeout(fn,ms);return()=>clearTimeout(id)}};
fixturePlugin.apply(ctx);ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(FixtureWorkbench,{ctx}));
</script></body></html>`
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  res.setHeader('cache-control', 'no-store')
  if (path.startsWith('/api/dsh-knowledge-graph/')) { Promise.resolve(handler(req, res)).catch(error => { console.error(error); res.writeHead(500).end() }); return }
  if (path === '/fixture-state') { const doc = store.getDocument('fixture-document'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ calls, revision: doc.revision, coverage: doc.generation?.relationDiscovery?.searchedTargets || 0 })); return }
  if (path === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    const narrow = new URL(req.url, 'http://localhost').searchParams.has('narrow')
    res.end(narrow ? html.replace('max-width:1400px', 'max-width:360px') : html)
    return
  }
  if (path === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(client); return }
  const vendor = { '/react.js': 'react.production.min.js', '/react-dom.js': 'react-dom.production.min.js' }[path]
  if (vendor) { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(new URL('extension/vendor/' + vendor, root))); return }
  res.writeHead(path === '/favicon.ico' ? 204 : 404).end()
})
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
function stop() {
  server.closeAllConnections()
  server.close(() => {
    for (const cleanup of cleanups.reverse()) cleanup()
    store.close()
    rmSync(dir, { recursive: true, force: true })
    process.exit(0)
  })
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
