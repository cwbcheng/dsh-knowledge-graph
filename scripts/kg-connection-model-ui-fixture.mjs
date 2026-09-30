// Synthetic, in-memory browser fixture. No live DSH credentials or graph data.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'
import { connectionFixture } from './kg-connection-model-fixture-data.mjs'

const fixture = connectionFixture()
const query = createGraphContract().connectionModels
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联结模型浏览验证</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1250px;margin:auto;padding:16px;background:white}h1{font-size:18px}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement;
function App(){ const [reference,setReference]=React.useState(null); return h('main',{className:'kg-root'},h('h1',null,'联结模型 · 隔离浏览验证'),
h(KGViewer.ConnectionModelPanel,{documentId:'connection-fixture',revision:1,
load:async(args,signal)=>{const r=await fetch('/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal});return r.json()},
onLocate:ref=>setReference(ref),onReview:ref=>setReference(ref)}),h('p',{role:'status',id:'located'},reference?JSON.stringify(reference):'未定位原文')); }
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`
const assets = { '/viewer.js': 'extension/viewer.js', '/viewer.css': 'extension/viewer.css',
  '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js' }
const server = createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store')
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path === '/models' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk
    res.setHeader('content-type', 'application/json; charset=utf-8')
    try { res.end(JSON.stringify(query(fixture, JSON.parse(body)))) } catch { res.writeHead(400); res.end('{}') }
    return
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (path === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
  if (!assets[path]) { res.writeHead(404); res.end(); return }
  res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
  res.end(readFileSync(new URL('../' + assets[path], import.meta.url)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
const stop = () => { server.closeAllConnections(); server.close() }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
