// Disposable data; UI calls the production HTTP routes and the real SQLite store.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelStructureFixture() })
const { document, store, post } = harness
const graphBefore = store.getDocument(document.documentId), sourceBefore = store.getDocumentSourceUnits(document.documentId)
const plan = await post({ action: 'plan', documentId: document.documentId, modelId: 'taxi', expectedRevision: 1 })
await post({ action: 'save', documentId: document.documentId, modelId: 'taxi', expectedRevision: 1,
  taskId: plan.tasks[0].id, attemptId: 'fixture-practice', response: learnerResponse, selfRating: 'uncertain' })
await post({ action: 'reveal', documentId: document.documentId, modelId: 'taxi', attemptId: 'fixture-practice', expectedVersion: 1 })
await post({ action: 'review', documentId: document.documentId, modelId: 'taxi', attemptId: 'fixture-practice', expectedVersion: 2, review: learnerReview })
const practiceBefore = store.getLearningAttempt('fixture-practice')
let fixtureSourceChanges = 0
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的理解 · 隔离验证</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1360px;margin:auto;padding:16px;background:white;box-sizing:border-box}h1{font-size:18px}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement;
const rpc=async(method,args,signal)=>{const r=await fetch('/api/dsh-knowledge-graph/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()};
function App(){const [revision,setRevision]=React.useState(1),[reference,setReference]=React.useState(null);return h('main',{className:'kg-root'},
h('h1',null,'联结模型 · 我的理解隔离验证'),h('button',{type:'button',onClick:async()=>{const r=await fetch('/fixture/revise-source',{method:'POST'});setRevision((await r.json()).revision)}},'更新隔离来源'),
h(KGViewer.ConnectionModelPanel,{documentId:${JSON.stringify(document.documentId)},revision,load:(args,signal)=>rpc('connection-models',args,signal),
learningCall:(args,signal)=>rpc('learning-mode',args,signal),onLocate:setReference}),h('p',{role:'status'},reference?JSON.stringify(reference):''));}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`
const assets = { '/viewer.js': 'extension/viewer.js', '/viewer.css': 'extension/viewer.css',
  '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js' }
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path.startsWith('/api/dsh-knowledge-graph/')) { await harness.handler(req, res); return }
  if (req.method === 'POST' && path === '/fixture/revise-source') {
    const current = store.getDocument(document.documentId)
    current.nodes.find(node => node.id === 'taxi').text = '更新后的简化计价模型；附加费用另行核对。'
    store.saveGraph(current, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: current.revision })
    fixtureSourceChanges++
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ revision: store.getDocumentRevision(document.documentId) })); return
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (path === '/verification') {
    const current = store.getDocument(document.documentId)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ graphUnchanged: isDeepStrictEqual(current, graphBefore), revision: current.revision, fixtureSourceChanges,
      sourceUnitsUnchanged: isDeepStrictEqual(store.getDocumentSourceUnits(document.documentId), sourceBefore),
      edgesUnchanged: isDeepStrictEqual(current.edges, graphBefore.edges),
      practiceUnchanged: isDeepStrictEqual({ ...store.getLearningAttempt('fixture-practice'), stale: false }, practiceBefore),
      records: store.listLearningAttempts(document.documentId, 'taxi', 'understanding') })); return
  }
  if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return }
  if (!assets[path]) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
  res.end(readFileSync(new URL('../' + assets[path], import.meta.url)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
const stop = () => { server.closeAllConnections(); server.close(() => harness.stop()) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
