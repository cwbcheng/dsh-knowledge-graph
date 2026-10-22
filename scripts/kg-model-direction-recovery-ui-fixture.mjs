// Browser QA for an unsaved direction draft after an external model update.
// Uses the production viewer/controller and an isolated canonical SQLite store.
// Optional comparison: --baseline-ref=ffb655c loads that revision's viewer.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { directionIdentityFixture } from './kg-model-direction-identity-fixture.mjs'
import { modelReviewControllerSource } from './kg-model-review-controller-fixture.mjs'

const fixture = directionIdentityFixture({ extraMaterials: 21 }), harness = await modelLearningHarness({ fixture })
const root = new URL('../', import.meta.url), baselineRef = process.argv.find(arg => arg.startsWith('--baseline-ref='))?.slice(15)
const baseline = !!baselineRef
const viewer = baseline ? execFileSync('git', ['show', baselineRef + ':extension/viewer.js'], { cwd: root, encoding: 'utf8', maxBuffer: 8e6 })
  : readFileSync(new URL('extension/viewer.js', root), 'utf8')
let failDetail = false, failDetailOnce = false, expected = JSON.stringify(harness.store.getDocument(fixture.documentId)), roleWrites = 0
const detailReads = [], directoryReads = []
const sourceUnits = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>方向草稿恢复验收</title><link rel="stylesheet" href="/viewer.css">
<style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1320px;margin:auto;padding:16px;background:white}.controls{display:flex;gap:8px;flex-wrap:wrap}.kg-root [hidden]{display:none!important}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head>
<body><div id="root"></div><script>
const h=React.createElement,documentId=${JSON.stringify(fixture.documentId)};
const rpc=async(path,args={})=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});const body=await response.json();if(!response.ok||body.error)throw new Error(body.error?.message||'HTTP '+response.status);return body};
${modelReviewControllerSource()}
function App(){
  const [revision,setRevision]=React.useState(1),[active,setActive]=React.useState(true),[message,setMessage]=React.useState('隔离数据；模拟按钮只修改临时测试图谱。');
  const state=React.useRef(null),controller=React.useRef(null);
  const loadState=async()=>{const loaded=await rpc('/api/dsh-knowledge-graph/document-export',{documentId,includeSourceText:true});const view={graph:loaded.graph,sourceText:loaded.sourceText};
    state.current={resultView:view,currentResultRef:{current:view},graphRevisionRef:{current:loaded.revision},graphCommitQueueRef:{current:Promise.resolve()},verifyBusyRef:{current:false}};
    controller.current=createModelReviewController(state.current,{call:(method,args)=>rpc('/api/dsh-knowledge-graph/'+method,args)});setRevision(loaded.revision);};
  React.useEffect(()=>{loadState().catch(error=>setMessage(error.message))},[]);
  const simulate=async kind=>{try{await rpc('/fixture/'+kind);await loadState();setMessage(kind==='remove'?'已在临时图谱移除当前模型。':kind==='fail'?'新版详情请求将返回隔离测试错误。':kind==='fail-once'?'下一次详情读取会失败一次，图谱版本不变。':'已允许详情读取；隐藏再显示工作台可重试。')}catch(error){setMessage(error.message)}};
  return h('main',{className:'kg-root'},h('h1',null,'方向草稿恢复验收'),
    h('div',{className:'controls'},h('button',{onClick:()=>simulate('fail')},'模拟外部更新并中断详情'),
      h('button',{onClick:()=>simulate('fail-once')},'模拟下一次详情失败'),
      h('button',{onClick:()=>simulate('recover')},'恢复详情读取'),h('button',{onClick:()=>simulate('remove')},'模拟移除当前模型'),
      h('button',{onClick:()=>setActive(value=>!value)},active?'隐藏工作台':'显示工作台')),
    h('p',{role:'status'},message),
    h('div',{hidden:!active},h(KGViewer.ConnectionModelPanel,{documentId,revision,active,
      restoreState:{documentId,revision:1,modelId:'mass-quality',tab:'review'},
      load:(args,signal)=>fetch('/api/dsh-knowledge-graph/connection-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal}).then(response=>response.json()),
      onRoles:async args=>{const result=await controller.current(args);if(args.preview)await loadState();return result}})));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));</script></body></html>`
const assets = { '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js', '/viewer.css': 'extension/viewer.css' }
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  try {
    if (path.startsWith('/api/') || path.startsWith('/fixture/')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const args = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      response.setHeader('Content-Type', 'application/json')
      if (path.startsWith('/fixture/')) {
        if (path === '/fixture/fail' || path === '/fixture/remove') {
          const current = harness.store.getDocument(fixture.documentId)
          const graph = structuredClone(current)
          if (path === '/fixture/remove') {
            graph.nodes = graph.nodes.filter(node => node.id !== 'mass-quality')
            graph.edges = graph.edges.filter(edge => edge.fromNodeId !== 'mass-quality' && edge.toNodeId !== 'mass-quality')
          } else graph.summary = '隔离测试：外部更新，待核对方向'
          harness.store.saveGraph(graph, { expectedRevision: current.revision, sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
          expected = JSON.stringify(harness.store.getDocument(fixture.documentId))
          failDetail = path === '/fixture/fail'
        } else if (path === '/fixture/recover') failDetail = false
        else if (path === '/fixture/fail-once') failDetailOnce = true
        else { response.writeHead(404); response.end('{}'); return }
        response.end('{}'); return
      }
      const method = path.split('/').at(-1)
      if (method === 'connection-models') (args.modelId ? detailReads : directoryReads).push(args)
      if (method === 'connection-models' && args.modelId && (failDetail || failDetailOnce)) {
        failDetailOnce = false
        response.writeHead(503); response.end(JSON.stringify({ error: { message: '隔离测试：新版详情暂时无法读取' } })); return
      }
      if (method === 'graph-commit' || method === 'graph-commit-preview') roleWrites++
      response.end(JSON.stringify(await harness.post(args, method))); return
    }
    if (path === '/verification') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ baseline, revision: harness.store.getDocumentRevision(fixture.documentId), roleWrites, detailReads, directoryReads,
        graphUnchangedAfterExplicitFixtureChange: JSON.stringify(harness.store.getDocument(fixture.documentId)) === expected,
        sourceUnitsUnchanged: JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)) === sourceUnits,
        learningCount: harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n })); return
    }
    if (path === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return }
    if (path === '/viewer.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(viewer); return }
    if (!assets[path]) { response.writeHead(404); response.end(); return }
    response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
    response.end(readFileSync(new URL(assets[path], root)))
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })) }
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, baseline, ownedDirectory: harness.directory })))
const stop = () => { server.closeAllConnections(); server.close(() => harness.stop()) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
