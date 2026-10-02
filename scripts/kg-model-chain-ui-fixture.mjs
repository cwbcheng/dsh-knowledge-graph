// Browser acceptance uses disposable data and the production HTTP route and components.
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelChainFixture } from './kg-model-chain-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelChainFixture() })
const { document, store } = harness
const graphBefore = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
let sourceChanges = 0
const html = () => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>两步推测 · 隔离验证</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1360px;margin:auto;padding:16px;background:white;box-sizing:border-box}h1{font-size:18px}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement;
const rpc=async(args,signal)=>{const r=await fetch('/api/dsh-knowledge-graph/connection-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()};
function App(){const [revision,setRevision]=React.useState(${store.getDocumentRevision(document.documentId)}),[reference,setReference]=React.useState(null);return h('main',{className:'kg-root'},
h('h1',null,'联结模型 · 两步推测隔离验证'),h('button',{type:'button',onClick:async()=>{const r=await fetch('/fixture/revise',{method:'POST'});setRevision((await r.json()).revision)}},'更新隔离模型版本'),
h(KGViewer.ConnectionModelPanel,{documentId:${JSON.stringify(document.documentId)},revision,load:rpc,focusRequest:{documentId:${JSON.stringify(document.documentId)},revision,type:'connection_model',nodeId:'taxi'},onLocate:setReference}),
h('p',{role:'status'},reference?JSON.stringify(reference):''));}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`
const assets = { '/viewer.js': 'extension/viewer.js', '/viewer.css': 'extension/viewer.css',
  '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js' }
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path.startsWith('/api/dsh-knowledge-graph/')) { await harness.handler(req, res); return }
  if (req.method === 'POST' && path === '/fixture/revise') {
    const current = store.getDocument(document.documentId)
    current.nodes.find(node => node.id === 'taxi').text = '更新后的简化计价模型；附加费用另行核对。'
    store.saveGraph(current, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: current.revision })
    sourceChanges++
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ revision: store.getDocumentRevision(document.documentId) })); return
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (path === '/verification') {
    const current = store.getDocument(document.documentId)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ graphUnchanged: isDeepStrictEqual(current, graphBefore), revision: current.revision, sourceChanges,
      unitsUnchanged: isDeepStrictEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore),
      edgesUnchanged: isDeepStrictEqual(current.edges, graphBefore.edges), learnerRecords: store.listLearningAttempts(document.documentId).length })); return
  }
  if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html()); return }
  if (!assets[path]) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
  res.end(readFileSync(new URL('../' + assets[path], import.meta.url)))
})
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port
  if (!process.argv.includes('--smoke')) { console.log('FIXTURE_URL=' + base + ' PID=' + process.pid); return }
  try {
    assert((await (await fetch(base)).text()).includes('React.useState(1)'))
    assert.equal((await (await fetch(base + '/fixture/revise', { method: 'POST' })).json()).revision, 2)
    assert((await (await fetch(base)).text()).includes('React.useState(2)'), 'browser reload must start from the canonical revision, not a hard-coded original version')
    const data = await (await fetch(base + '/verification')).json()
    assert(data.unitsUnchanged && data.edgesUnchanged && data.sourceChanges === 1 && data.learnerRecords === 0)
    console.log('model chain browser fixture: current canonical revision survives reload; source units, edges and learner records preserved')
  } catch (reason) { console.error(reason); process.exitCode = 1 }
  finally { stop() }
})
const stop = () => { server.closeAllConnections(); server.close(() => harness.stop()) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
