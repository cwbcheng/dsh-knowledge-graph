import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelRefreshFixture } from './kg-model-refresh-fixture.mjs'
import { modelCitationLocatorSource } from './kg-model-citation-locator-fixture.mjs'
import { modelReviewSource, modelQuestionNodeSource } from './kg-model-review-fixture.mjs'
import { modelWorkspaceTabsSource, modelWorkspaceNavigationSource, modelWorkspacePanelSource,
  modelWorkspacePanePropsSource, modelWorkspaceQuestionPropsSource } from './kg-model-workspace-fixture.mjs'

const fixture = modelRefreshFixture(), harness = await modelLearningHarness({ fixture })
console.log('OWNED_DIRECTORY=' + harness.directory)
const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
const unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联结模型工作区切换验证</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1280px;margin:auto;padding:16px;background:white}.kg-workbench [hidden]{display:none!important}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement,{useEffect}=React,ConnectionModelPanel=KGViewer.ConnectionModelPanel;
const connectionFocus={documentId:${JSON.stringify(fixture.documentId)},revision:1,nodeId:'taxi',type:'connection_model'};
const rpc=async(method,args)=>{const response=await fetch('/api/dsh-knowledge-graph/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'HTTP '+response.status);return body};
${modelWorkspaceTabsSource()}
function App(){
  const [resultView,setView]=React.useState(null),[fullText,setFullText]=React.useState(''),[readMode,setReadMode]=React.useState('models');
  const [workspaceTab,setWorkspaceTab]=React.useState('read'),[workspaceFocus,setWorkspaceFocus]=React.useState(null);
  const [selectedNodeId,setSelectedNodeId]=React.useState(''),[questionDraft,setQuestionDraft]=React.useState(''),[questionTarget,setQuestionTarget]=React.useState(null);
  const [questionResult,setQuestionResult]=React.useState(null),[questionError,setQuestionError]=React.useState('');
  const connectionPerspectiveRef=React.useRef(null),setInputCollapsed=()=>{};
  const state=React.useRef({currentResultRef:{current:null},graphRevisionRef:{current:0},graphCommitQueueRef:{current:Promise.resolve()},paragraphLocateSeqRef:{current:0}});
  const {currentResultRef,graphRevisionRef,graphCommitQueueRef,paragraphLocateSeqRef}=state.current;
  currentResultRef.current=resultView;
  const setResultView=view=>{setView(view);window.__workspacePublished=(window.__workspacePublished||0)+1};
  const documentIdOfGraph=graph=>graph?.source?.documentId,makeView=KGViewer.makeView;
  const graphViewMetadata=()=>null,chapterSectionsOf=graph=>graph?.source?.sections||[],exactSourceQuoteTarget=()=>{throw new Error('Not a source-only action')};
  const setGraphQueryDraft=()=>{},setGraphPageDraft=()=>{},setContentScope=()=>{},setChapterFilter=()=>{},setSelectedEdgeId=()=>{};
  const setFocusReq=update=>{const value=update({seq:window.__workspaceFocuses?.length||0});(window.__workspaceFocuses||=[]).push(value)};
  const setActivePara=()=>{},setFlashPara=()=>{},ctx={timeout:fn=>setTimeout(fn,0)},scrollElIntoCenter=()=>{};
  ${modelWorkspaceNavigationSource()}
  const loadGraphDocument=async args=>{
    (window.__workspaceReads||=[]).push(args);let loaded,error;
    try{loaded=await rpc('document-load',args)}catch(reason){error=reason}
    if(window.__workspacePaused)await new Promise(resolve=>(window.__workspaceHolds||=[]).push({resolve}));
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
  window.__workspaceState={workspaceTab,readMode,selectedNodeId,questionDraft,questionTarget,questionResult,questionError,
    windowNodes:resultView.graph.nodes.map(node=>node.id),sourceText:resultView.sourceText};
  const host={call:(method,args)=>rpc(method,args)},changeReadMode=setReadMode;
  const reviewConnectionRoles=()=>{throw new Error('No automatic role writes')},refreshConnectionModels=()=>{throw new Error('Refresh is outside this fixture')};
  const importConnectionModels=()=>{throw new Error('No automatic imports')},generationTaskActive=false,verifyPhase='idle',questionPhase='idle';
  const panel=${modelWorkspacePanelSource()};
  const track=(callback,...args)=>Promise.resolve(callback(...args)).finally(()=>{window.__workspaceCompleted=(window.__workspaceCompleted||0)+1});
  const resultPanel=h(panel.type,{...panel.props,onReview:(...args)=>track(panel.props.onReview,...args),onLocate:(...args)=>track(panel.props.onLocate,...args)});
  return h('main',{className:'kg-root kg-workbench'},h('h1',null,'联结模型 · 工作区切换验证'),
    h(WorkbenchTabs,{value:workspaceTab,onChange:tab=>navigateWorkspace(tab)}),
    h('div',${modelWorkspacePanePropsSource('read')},resultPanel),
    h('div',${modelWorkspacePanePropsSource('use')},h('p',null,'查找与学习工作区（保持挂载）')),
    h('div',${modelWorkspacePanePropsSource('source')},h('p',null,'导入资料工作区（保持挂载）')),
    h('div',${modelWorkspacePanePropsSource('review')},
      h('button',{type:'button',onClick:()=>handleQuestionNode({id:'distance'})},'选择当前窗口的里程节点提问'),
      h(KGViewer.VerificationPanel,{graph:resultView.graph,report:null,issueFilter:'all',questionPhase:'idle',
        ${modelWorkspaceQuestionPropsSource()}
        questionResult,questionError,onSubmitQuestion:()=>{throw new Error('No automatic AI submission')},panelId:'kg-verify-panel-workbench'})),
    h('p',{role:'status'},'隔离数据；仅编辑审阅问题，不提交 AI 或写入知识图。'));
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
