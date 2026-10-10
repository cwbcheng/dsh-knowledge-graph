import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { modelSourceContextFixture } from './kg-model-source-context-fixture-data.mjs'
import { modelSourceTableFixture } from './kg-model-source-table-fixture-data.mjs'
import { modelReviewControllerSource } from './kg-model-review-controller-fixture.mjs'

const fixture = process.argv.includes('--source-table')
  ? modelSourceTableFixture({ dense: process.argv.includes('--dense'), gap: process.argv.includes('--gap'), peer: process.argv.includes('--peer') })
  : process.argv.includes('--source-context') ? modelSourceContextFixture() : modelStructureFixture()
if (process.argv.includes('--diagnostics')) {
  fixture.sourceUnits[0].text += ' 此处结果往往成立，但不保证必然成立。'
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
}
const harness = await modelLearningHarness({ fixture })
const initial = harness.store.getDocument(harness.document.documentId)
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const quoteLocator = clientSource.slice(clientSource.indexOf('function exactSourceQuoteTarget('), clientSource.indexOf('function KnowledgeConsumePanel('))
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联结模型结构核对</title><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1280px;margin:auto;padding:16px;background:white}h1{font-size:18px}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head><body><div id="root"></div><script>
const h=React.createElement;
const rpc=async(method,args,signal)=>{const response=await fetch('/api/dsh-knowledge-graph/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal});if(!response.ok)throw new Error('HTTP '+response.status);return response.json()};
const documentIdOfGraph=graph=>graph?.source?.documentId;
${quoteLocator}
${modelReviewControllerSource()}
function App(){
  const [view,setView]=React.useState(null),[reference,setReference]=React.useState(null);
  const state=React.useRef({graphCommitQueueRef:{current:Promise.resolve()},currentResultRef:{current:null},graphRevisionRef:{current:0},verifyBusyRef:{current:false}});
  const refresh=async()=>{const result=await rpc('document-export',{documentId:'connection-fixture',includeSourceText:true});if(result.error)throw new Error(result.error.message);const next={graph:result.graph,sourceText:result.sourceText};state.current.currentResultRef.current=next;state.current.graphRevisionRef.current=result.revision;setView(next)};
  React.useEffect(()=>{refresh().catch(reason=>setReference({error:reason.message}))},[]);
  if(!view)return h('main',{className:'kg-root'},h('p',{role:'status'},'正在读取隔离模型…'));
  state.current.resultView=view;state.current.onSaved=setView;
  const controller=createModelReviewController(state.current,{call:rpc});
  const locate=reference=>{const target=reference.sourceQuoteOnly?exactSourceQuoteTarget(KGViewer.makeView(view.graph,view.sourceText),reference):null;setReference(previous=>({...reference,sequence:(previous?.sequence||0)+1,readingParagraph:target?.first??reference.paragraph}))};
  return h('main',{className:'kg-root'},h('h1',null,'联结模型 · 结构核对'),h(KGViewer.ConnectionModelPanel,{documentId:'connection-fixture',revision:state.current.graphRevisionRef.current,
    load:(args,signal)=>rpc('connection-models',args,signal),learningCall:(args,signal)=>rpc('learning-mode',args,signal),onStructure:controller,onRoles:controller,onRefresh:refresh,onLocate:locate}),
    h('p',{role:'status'},reference?JSON.stringify(reference):''));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`
const assets = { '/viewer.js': 'extension/viewer.js', '/viewer.css': 'extension/viewer.css', '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js' }
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path.startsWith('/api/dsh-knowledge-graph/')) { await harness.handler(req, res); return }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (path === '/verification') {
    const graph = harness.store.getDocument(harness.document.documentId)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ revision: graph.revision, sourceUnchanged: graph.sourceText === initial.sourceText,
      edgesUnchanged: JSON.stringify(graph.edges) === JSON.stringify(initial.edges),
      nodeEvidenceUnchanged: initial.nodes.every(node => isDeepStrictEqual(graph.nodes.find(saved => saved.id === node.id)?.evidence, node.evidence)),
      models: graph.nodes.filter(node => node.modelStructure).map(node => ({ id: node.id, structure: node.modelStructure })),
      learningCount: harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n }))
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
