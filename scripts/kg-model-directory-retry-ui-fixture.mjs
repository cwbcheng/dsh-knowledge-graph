// Browser QA for directory recovery with a retained model and direction draft.
// Production viewer/controller/Host; all graph data lives in an isolated store.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelReviewControllerSource } from './kg-model-review-controller-fixture.mjs'

const harness = await modelLearningHarness(), fixture = harness.document
const root = new URL('../', import.meta.url), baselineRef = process.argv.find(arg => arg.startsWith('--baseline-ref='))?.slice(15)
const viewer = baselineRef ? execFileSync('git', ['show', baselineRef + ':extension/viewer.js'], { cwd: root, encoding: 'utf8', maxBuffer: 8e6 })
  : readFileSync(new URL('extension/viewer.js', root), 'utf8')
const beforeGraph = JSON.stringify(harness.store.getDocument(fixture.documentId))
const beforeSources = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
const reads = [], writes = []
let failDirectoryOnce = false, refreshes = 0
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>联结模型目录恢复验收</title><link rel="stylesheet" href="/viewer.css">
<style>body{margin:0;background:#f6f7f8;font:14px system-ui}main{max-width:1320px;margin:auto;padding:16px;background:white}h1{font-size:18px}.controls{display:flex;gap:8px;flex-wrap:wrap}.kg-root [hidden]{display:none!important}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head>
<body><div id="root"></div><script>
const h=React.createElement,documentId=${JSON.stringify(fixture.documentId)};
const rpc=async(path,args={})=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});const body=await response.json();if(!response.ok||body.error)throw new Error(body.error?.message||'HTTP '+response.status);return body};
${modelReviewControllerSource()}
function App(){
  const [revision,setRevision]=React.useState(1),[active,setActive]=React.useState(true),[message,setMessage]=React.useState('隔离数据；模拟失败不改变图谱。');
  const controller=React.useRef(null);
  const loadState=async()=>{const loaded=await rpc('/api/dsh-knowledge-graph/document-export',{documentId,includeSourceText:true});const view={graph:loaded.graph,sourceText:loaded.sourceText};
    controller.current=createModelReviewController({resultView:view,currentResultRef:{current:view},graphRevisionRef:{current:loaded.revision},graphCommitQueueRef:{current:Promise.resolve()},verifyBusyRef:{current:false}},
      {call:(method,args)=>rpc('/api/dsh-knowledge-graph/'+method,args)});setRevision(loaded.revision);};
  React.useEffect(()=>{loadState().catch(error=>setMessage(error.message))},[]);
  const fail=async()=>{await rpc('/fixture/fail-directory-once');setMessage('下一次目录读取会失败一次；详情与草稿保持。')};
  return h('main',{className:'kg-root'},h('h1',null,'联结模型目录恢复验收'),
    h('div',{className:'controls'},h('button',{onClick:fail},'模拟下一次目录失败'),
      h('button',{onClick:()=>setActive(value=>!value)},active?'隐藏工作台':'显示工作台')),
    h('p',{role:'status'},message),h('div',{hidden:!active},h(KGViewer.ConnectionModelPanel,{documentId,revision,active,
      restoreState:{documentId,revision:1,modelId:'taxi',tab:'review',sourceOpen:true},
      load:(args,signal)=>fetch('/api/dsh-knowledge-graph/connection-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal}).then(response=>response.json()),
      onRefresh:async()=>{await rpc('/fixture/refresh');await loadState();return true},
      onRoles:async args=>{const result=await controller.current(args);if(args.preview)await loadState();return result}})));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));</script></body></html>`
const assets = { '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js', '/viewer.css': 'extension/viewer.css' }
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  response.setHeader('cache-control', 'no-store')
  try {
    if (path.startsWith('/api/') || path.startsWith('/fixture/')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const args = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      response.setHeader('Content-Type', 'application/json')
      if (path === '/fixture/fail-directory-once') { failDirectoryOnce = true; response.end('{}'); return }
      if (path === '/fixture/refresh') { refreshes++; response.end('{}'); return }
      if (path.startsWith('/fixture/')) { response.writeHead(404); response.end('{}'); return }
      const method = path.split('/').at(-1)
      if (method === 'connection-models') {
        reads.push(args)
        if (!args.modelId && failDirectoryOnce) {
          failDirectoryOnce = false
          response.writeHead(503); response.end(JSON.stringify({ error: { message: '隔离测试：模型目录暂时无法读取' } })); return
        }
      }
      if (method === 'graph-commit' || method === 'graph-commit-preview') writes.push(method)
      response.end(JSON.stringify(await harness.post(args, method))); return
    }
    if (path === '/verification') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ baselineRef: baselineRef || null, revision: harness.store.getDocumentRevision(fixture.documentId), reads, writes, refreshes,
        graphUnchanged: JSON.stringify(harness.store.getDocument(fixture.documentId)) === beforeGraph,
        sourceUnitsUnchanged: JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)) === beforeSources,
        learningCount: harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n })); return
    }
    if (path === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return }
    if (path === '/viewer.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(viewer); return }
    if (!assets[path]) { response.writeHead(404); response.end(); return }
    response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
    response.end(readFileSync(new URL(assets[path], root)))
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })) }
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, baselineRef, ownedDirectory: harness.directory })))
const stop = () => { server.closeAllConnections(); server.close(() => harness.stop()) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
