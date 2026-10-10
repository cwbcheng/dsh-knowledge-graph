import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelRefreshFixture, modelRefreshSource } from './kg-model-refresh-fixture.mjs'
import { modelReviewControllerSource } from './kg-model-review-controller-fixture.mjs'

const fixture = modelRefreshFixture(), harness = await modelLearningHarness({ fixture })
console.log('OWNED_DIRECTORY=' + harness.directory)
const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
const unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联结模型刷新隔离验证</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1280px;margin:auto;padding:16px;background:white}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement;
const rpc=async(method,args)=>{const response=await fetch('/api/dsh-knowledge-graph/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'HTTP '+response.status);return body};
${modelReviewControllerSource()}
function App(){
  const [resultView,setView]=React.useState(null),[fullText,setFullText]=React.useState(''),[active,setActive]=React.useState(true);
  const state=React.useRef({graphCommitQueueRef:{current:Promise.resolve()},currentResultRef:{current:null},graphRevisionRef:{current:0},verifyBusyRef:{current:false}});
  const {graphCommitQueueRef,currentResultRef,graphRevisionRef}=state.current;
  const documentIdOfGraph=graph=>graph?.source?.documentId,graphViewMetadata=()=>null,makeView=KGViewer.makeView;
  const setResultView=view=>{currentResultRef.current=view;setView(view);window.__refreshPublished=(window.__refreshPublished||0)+1};
  const setVerification=()=>{},setFactReport=()=>{};
  const loadGraphDocument=async args=>{
    window.__refreshReads=(window.__refreshReads||[]).concat([args]);let loaded,error;
    try{loaded=await rpc('document-load',args)}catch(reason){error=reason}
    // A controlled adapter boundary after a real canonical HTTP read/failure.
    // Holds do not replace the production receiver or write fixture data.
    if(window.__refreshPaused)await new Promise(resolve=>(window.__refreshHolds||=[]).push({resolve}));
    if(error)throw error;return loaded;
  };
  ${modelRefreshSource()}
  React.useEffect(()=>{rpc('document-export',{documentId:${JSON.stringify(fixture.documentId)},includeSourceText:true}).then(result=>{
    if(result.error)throw new Error(result.error.message);const view=makeView(result.graph,result.sourceText);
    currentResultRef.current=view;graphRevisionRef.current=result.revision;setFullText(result.sourceText);setView(view);
  })},[]);
  if(!resultView)return h('main',{className:'kg-root'},h('p',null,'正在读取隔离模型…'));
  state.current.resultView=resultView;state.current.onSaved=setView;
  const controller=createModelReviewController(state.current,{call:rpc});
  const refresh=async isCurrent=>{try{return await refreshConnectionModels(isCurrent)}finally{window.__refreshCompleted=(window.__refreshCompleted||0)+1}};
  return h('main',{className:'kg-root'},h('h1',null,'联结模型 · 刷新验证'),
    h('button',{type:'button',onClick:()=>setActive(value=>!value)},active?'查看知识图':'返回联结模型'),
    h('div',{style:{display:active?'block':'none'}},h(KGViewer.ConnectionModelPanel,{documentId:${JSON.stringify(fixture.documentId)},revision:resultView.graph.revision||1,active,
      load:args=>rpc('connection-models',args),learningCall:args=>rpc('learning-mode',args),onRoles:controller,onStructure:controller,onRefresh:refresh})),
    h('p',{role:'status'},'隔离数据；方向修改必须预览并明确确认。'));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));</script></body></html>`
const assets = { '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js',
  '/viewer.js': 'extension/viewer.js', '/viewer.css': 'extension/viewer.css' }
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  if (path.startsWith('/api/dsh-knowledge-graph/')) { await harness.handler(request, response); return }
  if (path === '/verification') {
    response.setHeader('Content-Type', 'application/json')
    const graph = harness.store.getDocument(fixture.documentId)
    response.end(JSON.stringify({ documentId: fixture.documentId, revision: graph.revision,
      canonicalGraphAndSourceUnchanged: JSON.stringify(graph) === before,
      sourceUnitsUnchanged: JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)) === unitsBefore,
      learningCount: harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n })); return
  }
  if (path === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return }
  if (!assets[path]) { response.writeHead(404); response.end(); return }
  response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
  response.end(readFileSync(new URL('../' + assets[path], import.meta.url)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
const stop = () => { server.closeAllConnections(); server.close(() => harness.stop()) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
