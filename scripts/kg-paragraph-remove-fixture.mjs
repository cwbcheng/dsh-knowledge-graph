import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as persistentHost from '../lib/index.js'

// Real client and API, but an isolated synthetic book: no production data or models.
const root = new URL('../', import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'kg-paragraph-browser-'))
process.env.DSH_KG_DB = join(dir, 'test.sqlite')
const documentId = 'document-paragraph-browser-test'
const extraNodes = process.env.KG_FIXTURE_LARGE === '1'
  ? Array.from({ length: 4695 }, (_, i) => ({ id: 'extra-' + i, type: 'concept', paragraph: i + 4,
    text: 'Material ' + i + ' explains a distinct learning idea.', quote: 'Material ' + i + ' explains a distinct learning idea!' })) : []
const sourceText = ['# Test book', '# Contents and learning', 'Test Author', 'Learning concept', ...extraNodes.map(node => node.text)].join('\n\n')
const store = await openSqliteStore(process.env.DSH_KG_DB)
store.saveGraph({
  ontology: 'learning-view-v1',
  source: { id: 'source-paragraph-browser-test', documentId, title: 'Paragraph deletion fixture', sections: [] },
  nodes: [
    { id: 'toc-a', type: 'memory_material', text: 'Contents', paragraph: 1, quote: 'Contents' },
    { id: 'toc-b', type: 'memory_material', text: 'learning', paragraph: 1, quote: 'learning' },
    { id: 'other-type', type: 'concept', text: 'Contents and learning', paragraph: 1, quote: 'Contents and learning' },
    { id: 'author', type: 'memory_material', text: 'Test Author', paragraph: 2, quote: 'Test Author' },
    { id: 'concept', type: 'concept', text: 'Learning concept', paragraph: 3, quote: 'Learning concept' },
    ...extraNodes,
  ], edges: [],
}, { sourceText })
store.close()
const routes = []
persistentHost.apply({ get: name => name === 'webServer' ? { register(spec) { routes.push(spec); return () => {} } } : null, effect: fn => fn(), interval: () => () => {} })
const api = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paragraph deletion fixture</title>
<style>body{font-family:system-ui;margin:16px}*{box-sizing:border-box}</style>
<script src="/extension/vendor/react.production.min.js"></script><script src="/extension/vendor/react-dom.production.min.js"></script></head>
<body><div id="app"></div><script>
localStorage.setItem('dsh-kg-result-v2', JSON.stringify({documentId:'${documentId}',title:'Paragraph deletion fixture'}));
const slots=new Map();
const ctx={get(name){return name==='slots'?{inject(name,fn){fn()},register(spec,render){slots.set(spec.id,render);return()=>{}}}:null},timeout(fn,ms){const id=setTimeout(fn,ms);return()=>clearTimeout(id)}};
window.__ModuleLoader__={load:async({factory})=>{const plugin=factory(name=>{if(name==='react')return React;throw new Error(name)});await plugin.apply(ctx);ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(React.Fragment,null,slots.get('kg-workbench-launcher')(),slots.get('kg-workbench-window')()))}};
</script><script src="/lib/client.js"></script></body></html>`
const files = new Set(['lib/client.js', 'extension/vendor/react.production.min.js', 'extension/vendor/react-dom.production.min.js'])
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname.slice(1)
  response.setHeader('cache-control', 'no-store')
  if (path.startsWith('api/dsh-knowledge-graph/')) {
    api(request, response).catch(error => { console.error(error); response.writeHead(500).end('{}') })
    return
  }
  if (!path) { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return }
  if (path === 'favicon.ico') { response.writeHead(204).end(); return }
  if (!files.has(path)) { response.writeHead(404).end(); return }
  response.setHeader('content-type', 'text/javascript; charset=utf-8')
  response.end(readFileSync(new URL(path, root)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
function stop() { server.close(() => { rmSync(dir, { recursive: true, force: true }); process.exit(0) }); server.closeAllConnections() }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
