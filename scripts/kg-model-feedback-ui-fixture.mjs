// Disposable book and learner records; no real service, source or model calls.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { modelLearningHarness, learnerResponse } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { feedbackResponse } from './kg-model-feedback-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelStructureFixture() })
const { document, store, post } = harness
const graphBefore = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
const base = { documentId: document.documentId, modelId: 'taxi' }
const plan = await post({ ...base, action: 'plan', expectedRevision: 1 })
await post({ ...base, action: 'save', expectedRevision: 1, taskId: plan.tasks[0].id,
  attemptId: 'fixture-prediction', response: learnerResponse, selfRating: 'uncertain' })
const predictionBefore = store.getLearningAttempt('fixture-prediction')
if (process.argv.includes('--history')) {
  for (const attemptId of ['fixture-boundary', 'fixture-unchecked']) await post({ ...base, action: 'save', expectedRevision: 1,
    taskId: plan.tasks[0].id, attemptId, response: { ...learnerResponse, scenario: attemptId === 'fixture-boundary' ? '新行程恰为 3 km，尚未核对附加收费。' : '一次待观察的新行程。',
      prediction: attemptId === 'fixture-boundary' ? '我预测基础费用为 10 元，总价尚不确定。' : learnerResponse.prediction }, selfRating: 'uncertain' })
  store.saveModelFeedback({ ...base, predictionId: 'fixture-prediction', attemptId: 'fixture-observation', expectedRevision: 1, expectedVersion: 1,
    response: { ...feedbackResponse(), content: '实际账单包含额外收费，不能直接与基础费用比较。', comparison: 'different', diagnosis: 'condition' } })
  store.saveModelFeedback({ ...base, predictionId: 'fixture-prediction', attemptId: 'fixture-ai', expectedRevision: 1, expectedVersion: 1,
    response: { ...feedbackResponse('ai_suggestion'), content: 'AI 建议复核超出里程的计算；未取得独立观察。', comparison: 'different', diagnosis: 'calculation' } })
  store.saveModelFeedback({ ...base, predictionId: 'fixture-boundary', attemptId: 'fixture-derivation', expectedRevision: 1, expectedVersion: 1,
    response: { ...feedbackResponse('derivation'), content: '按简化规则推导 3 km 基础费用为 10 元；不是实际账单。', comparison: 'consistent', diagnosis: 'no_change' } })
}
let fixtureSourceChanges = 0
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联结模型 · 隔离验证</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1360px;margin:auto;padding:16px;background:white;box-sizing:border-box}h1{font-size:18px}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement;
const rpc=async(method,args,signal)=>{const r=await fetch('/api/dsh-knowledge-graph/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()};
function App({initialRevision}){const [revision,setRevision]=React.useState(initialRevision),[reference,setReference]=React.useState(null);return h('main',{className:'kg-root'},
h('h1',null,'联结模型 · 隔离验收'),h('button',{type:'button',onClick:async()=>{const r=await fetch('/fixture/revise-source',{method:'POST'});setRevision((await r.json()).revision)}},'更新隔离来源'),
h(KGViewer.ConnectionModelPanel,{documentId:${JSON.stringify(document.documentId)},revision,load:(args,signal)=>rpc('connection-models',args,signal),
learningCall:(args,signal)=>rpc('learning-mode',args,signal),onLocate:setReference}),h('p',{role:'status'},reference?JSON.stringify(reference):''));}
fetch('/fixture/state').then(r=>r.json()).then(state=>ReactDOM.createRoot(document.getElementById('root')).render(h(App,{initialRevision:state.revision})));
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
  if (path === '/fixture/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ revision: store.getDocumentRevision(document.documentId) })); return }
  if (path === '/verification') {
    const current = store.getDocument(document.documentId), prediction = store.getLearningAttempt('fixture-prediction')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ graphUnchanged: isDeepStrictEqual(current, graphBefore), revision: current.revision, fixtureSourceChanges,
      sourceUnitsUnchanged: isDeepStrictEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore),
      edgesUnchanged: isDeepStrictEqual(current.edges, graphBefore.edges),
      predictionUnchanged: isDeepStrictEqual(prediction.response, predictionBefore.response) && isDeepStrictEqual(prediction.task, predictionBefore.task),
      prediction, results: store.listModelFeedback(document.documentId, 'taxi', 'fixture-prediction'),
      history: store.listModelLearningHistory(document.documentId, 'taxi', { expectedRevision: current.revision }),
      understandings: store.listLearningAttempts(document.documentId, 'taxi', 'understanding') })); return
  }
  if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return }
  if (!assets[path]) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
  res.end(readFileSync(new URL('../' + assets[path], import.meta.url)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
const stop = () => { server.closeAllConnections(); server.close(() => harness.stop()) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
