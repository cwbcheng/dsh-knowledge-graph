// Real production HTTP routes and SQLite, but synthetic data in a disposable database.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { comparisonFixture } from './kg-model-comparison-fixture-data.mjs'

const harness = await modelLearningHarness(process.argv.includes('--comparison') ? { fixture: comparisonFixture() } : {})
const graphBefore = JSON.stringify(harness.store.getDocument(harness.document.documentId))
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联结模型情境预测验证</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1250px;margin:auto;padding:16px;background:white}h1{font-size:18px}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement;
const rpc=async(method,args,signal)=>{const r=await fetch('/api/dsh-knowledge-graph/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()};
function App(){const [reference,setReference]=React.useState(null);return h('main',{className:'kg-root'},h('h1',null,'联结模型 · 隔离练习验证'),
h(KGViewer.ConnectionModelPanel,{documentId:'connection-fixture',revision:1,load:(args,signal)=>rpc('connection-models',args,signal),
learningCall:(args,signal)=>rpc('learning-mode',args,signal),onLocate:setReference}),h('p',{role:'status'},reference?JSON.stringify(reference):''));}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`
const assets = { '/viewer.js': 'extension/viewer.js', '/viewer.css': 'extension/viewer.css',
  '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js' }
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path.startsWith('/api/dsh-knowledge-graph/')) { await harness.handler(req, res); return }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (path === '/verification') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ graphUnchanged: graphBefore === JSON.stringify(harness.store.getDocument(harness.document.documentId)),
      attempts: harness.store.listLearningAttempts(harness.document.documentId, 'night', 'counterexample') }))
    return
  }
  if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return }
  if (!assets[path]) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
  res.end(readFileSync(new URL('../' + assets[path], import.meta.url)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
const stop = () => { server.closeAllConnections(); server.close(() => harness.stop()) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
