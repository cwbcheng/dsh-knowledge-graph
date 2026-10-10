import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelRefreshFixture } from './kg-model-refresh-fixture.mjs'
import { modelCitationLocatorSource } from './kg-model-citation-locator-fixture.mjs'
import { modelReviewSource, modelQuestionNodeSource } from './kg-model-review-fixture.mjs'

const fixture = modelRefreshFixture(), harness = await modelLearningHarness({ fixture })
console.log('OWNED_DIRECTORY=' + harness.directory)
const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
const unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联结模型审阅隔离验证</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1280px;margin:auto;padding:16px;background:white}textarea{width:100%;min-height:90px}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement;
const focusRequest={documentId:${JSON.stringify(fixture.documentId)},revision:1,nodeId:'taxi',type:'connection_model'};
const rpc=async(method,args)=>{const response=await fetch('/api/dsh-knowledge-graph/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'HTTP '+response.status);return body};
function App(){
  const [resultView,setView]=React.useState(null),[fullText,setFullText]=React.useState(''),[active,setActive]=React.useState(true),[workspace,setWorkspace]=React.useState('read');
  const [selectedNodeId,setSelectedNodeId]=React.useState(''),[questionDraft,setQuestionDraft]=React.useState(''),[questionTarget,setQuestionTarget]=React.useState(null);
  const state=React.useRef({currentResultRef:{current:null},graphRevisionRef:{current:0},graphCommitQueueRef:{current:Promise.resolve()},paragraphLocateSeqRef:{current:0}});
  const {currentResultRef,graphRevisionRef,graphCommitQueueRef,paragraphLocateSeqRef}=state.current;
  // Match Workbench: the current view ref is published by render, not the setter.
  currentResultRef.current=resultView;
  const setResultView=view=>{setView(view);window.__reviewPublished=(window.__reviewPublished||0)+1};
  const documentIdOfGraph=graph=>graph?.source?.documentId,makeView=KGViewer.makeView;
  const graphViewMetadata=()=>null,chapterSectionsOf=graph=>graph?.source?.sections||[],exactSourceQuoteTarget=()=>{throw new Error('Not a source-only action')};
  const setGraphQueryDraft=()=>{},setGraphPageDraft=()=>{},setContentScope=()=>{},setChapterFilter=()=>{},setSelectedEdgeId=()=>{};
  const setFocusReq=update=>{const value=update({seq:window.__reviewFocuses?.length||0});(window.__reviewFocuses||=[]).push(value)};
  const setActivePara=()=>{},setFlashPara=()=>{},ctx={timeout:fn=>setTimeout(fn,0)},scrollElIntoCenter=()=>{};
  const navigateWorkspace=value=>setWorkspace(value),setQuestionResult=()=>{};
  const loadGraphDocument=async args=>{
    (window.__reviewReads||=[]).push(args);let loaded,error;
    try{loaded=await rpc('document-load',args)}catch(reason){error=reason}
    // Delay only after a real canonical HTTP read or explicit test HTTP503.
    if(window.__reviewPaused)await new Promise(resolve=>(window.__reviewHolds||=[]).push({resolve}));
    if(error)throw error;return loaded;
  };
  ${modelCitationLocatorSource()}
  ${modelQuestionNodeSource()}
  ${modelReviewSource()}
  React.useEffect(()=>{Promise.all([
    rpc('document-export',{documentId:${JSON.stringify(fixture.documentId)},includeSourceText:true}),
    rpc('document-load',{documentId:${JSON.stringify(fixture.documentId)},query:'distance',nodeLimit:1,includeSourceText:false})
  ]).then(([full,windowed])=>{graphRevisionRef.current=windowed.revision;setFullText(full.sourceText);setView(makeView(windowed.graph,full.sourceText))})},[]);
  if(!resultView)return h('main',{className:'kg-root'},h('p',null,'正在读取隔离模型…'));
  window.__reviewState={workspace,selectedNodeId,questionDraft,questionTarget,windowNodes:resultView.graph.nodes.map(node=>node.id),sourceText:resultView.sourceText};
  const review=async(...args)=>{try{return await reviewConnectionModel(...args)}finally{window.__reviewCompleted=(window.__reviewCompleted||0)+1}};
  return h('main',{className:'kg-root'},h('h1',null,'联结模型 · 审阅验证'),
    h('button',{type:'button',onClick:()=>setActive(value=>!value)},active?'查看知识图':'返回联结模型'),
    h('div',{style:{display:active&&workspace==='read'?'block':'none'}},h(KGViewer.ConnectionModelPanel,{key:${JSON.stringify(fixture.documentId)},
      documentId:${JSON.stringify(fixture.documentId)},revision:graphRevisionRef.current,active,
      focusRequest,
      load:args=>rpc('connection-models',args),onReview:review})),
    h('section',{'aria-label':'模型审阅问题'},h('p',{'data-question-target':true},'审阅对象：'+(questionTarget?.id||'未选择')),
      h('textarea',{'aria-label':'审阅问题',value:questionDraft,onChange:event=>setQuestionDraft(event.target.value)})),
    h('p',{role:'status'},'隔离数据；仅填写审阅问题，不提交 AI 或写入知识图。'));
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
