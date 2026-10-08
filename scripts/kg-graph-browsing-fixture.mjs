// Read-only UI fixture. All graph/source content is synthetic and in memory;
// there is no model, DSH profile, database, or graph-writing endpoint.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Optional baseline bundle for identical before/after browser measurements:
// node scripts/kg-graph-browsing-fixture.mjs [baseline-git-revision]
const revision = process.argv[2]
if (revision?.startsWith('-')) throw new Error('Expected a git revision, not an option')
const baselineViewer = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { maxBuffer: 8 * 1024 * 1024 }) : null

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Graph browsing fixture</title>
<link rel="stylesheet" href="/viewer.css"><style>
body{margin:0;font:14px system-ui;background:#f4f5f6;color:#24272b}
.kg-root{max-width:1320px;margin:auto;padding:16px;box-sizing:border-box}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
h1{font-size:18px;margin:0}header label{display:flex;align-items:center;gap:6px}
.kg-cols{grid-template-columns:minmax(180px,28%) minmax(0,1fr);height:650px}
.kg-original{overflow:auto;padding:12px}.fixture-source{padding:10px 0;border-bottom:1px solid #d8dde3}
.fixture-source p{margin:4px 0}#status{font-size:12px;margin-top:12px;overflow-wrap:anywhere}
@media(max-width:600px){.kg-root{padding:8px}.kg-cols{grid-template-columns:1fr;height:auto;gap:8px}.kg-original{max-height:110px}.kg-graph-col{min-width:0}}
</style><script src="/react.js"></script><script src="/react-dom.js"></script><script>
// Optional synthetic-data counter, installed before the viewer captures h().
if(new URLSearchParams(location.search).has('selectionTelemetry')){
 const createElement=React.createElement;let total=0,before=0,output=null;
 React.createElement=function(type,props,...children){if(props?.className==='kg-node')total++;return createElement(type,props,...children)};
 document.addEventListener('click',()=>{before=total},true);
 document.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){before=total}},true);
 addEventListener('DOMContentLoaded',()=>{
  output=document.createElement('output');output.id='selection-telemetry';output.style.cssText='display:block;max-width:1288px;margin:8px auto;font:12px system-ui';document.body.append(output);
  const observer=new MutationObserver(()=>{output.textContent='本次操作：重建节点外框 '+(total-before)+' 个'});
  observer.observe(document.getElementById('root'),{subtree:true,childList:true,attributes:true});
 });
}
</script><script src="/viewer.js"></script>
</head><body><div id="root"></div><script>
const h=React.createElement, timers={timeout(fn,ms){const id=setTimeout(fn,ms);return ()=>clearTimeout(id)}};
const names=['学习目标','检索练习','间隔复习','迁移能力','先验知识','概念边界','反例检验','反馈质量'];
const count=Math.max(65,Math.min(12000,Math.floor(Number(new URLSearchParams(location.search).get('nodes'))||65)));
const nodes=Array.from({length:count},(_,i)=>({id:'n'+i,type:i%3?'fact':'concept',
 text:names[i%names.length]+' · 合成示例 '+i,quote:'示例段落 '+i+'：'+names[i%names.length]+'的对照材料。',paragraph:i}));
nodes[count-1].text='跨章节检索目标 · 末尾节点';
const edges=nodes.slice(1).map((node,i)=>({fromNodeId:'n'+i,toNodeId:node.id,relation:i%2?'supports':'explains'}));
edges.push({fromNodeId:'n0',toNodeId:'n'+(count-1),relation:'supports'},{fromNodeId:'n0',toNodeId:'n'+(count-1),relation:'contradicts'});
const graph={nodes,edges},original=JSON.stringify(graph),source=nodes.map(n=>n.quote).join('\\n\\n'),v=KGViewer.makeView(graph,source);
function App(){
 const [mode,setMode]=React.useState(count>65?'overview':'layered'),[node,setNode]=React.useState(null),[edge,setEdge]=React.useState(null),[focus,setFocus]=React.useState({seq:0}),[windowed,setWindowed]=React.useState(false);
 const visible=React.useMemo(()=>windowed?nodes.slice(0,20):nodes,[windowed]);
 const relations=React.useMemo(()=>windowed?edges.filter(e=>visible.some(n=>n.id===e.fromNodeId)&&visible.some(n=>n.id===e.toNodeId)):edges,[visible,windowed]);
 const locate=id=>{setNode(id);setEdge(null);document.getElementById('source-'+id)?.scrollIntoView({block:'nearest'})};
 return h('main',{className:'kg-root'},h('header',null,h('h1',null,'知识图浏览 · 隔离测试'),
 h('label',null,'视图',h('select',{'aria-label':'测试视图',value:windowed?'window':'all',onChange:e=>{setWindowed(e.target.value==='window');setNode(null);setEdge(null)}},h('option',{value:'all'},'全部 '+count+' 个节点'),h('option',{value:'window'},'前 20 个节点'))),
 h('label',null,'布局',h('select',{'aria-label':'测试布局',value:mode,onChange:e=>setMode(e.target.value)},['layered','overview','radial','circular'].map(x=>h('option',{key:x,value:x},x))))),
 h('div',{className:'kg-cols'},h('section',{className:'kg-original','aria-label':'合成原文'},(count>65?[...nodes.slice(0,20),nodes[count-1]]:nodes).map(n=>h('div',{key:n.id,id:'source-'+n.id,className:'fixture-source'},
 h('button',{'aria-label':'定位示例 '+n.id,onClick:()=>{locate(n.id);setFocus(f=>({nodeId:n.id,seq:f.seq+1}))}},'P'+(n.paragraph+1)),h('p',null,n.quote)))),
 h('div',{className:'kg-graph-col'},h(KGViewer.GraphViewer,{nodes:visible,edges:relations,anchors:v.anchors,sourceText:source,
 selectedNodeId:node,selectedEdgeId:edge,focusReq:focus,onSelectNode:locate,onSelectEdge:i=>{setEdge(i);setNode(null)},ctx:timers,
 height:650,layoutMode:mode,onLayoutModeChange:setMode}))),
 h('div',{id:'status',role:'status'},'选中节点：'+(node||'无')+' · 选中关系：'+(edge??'无')+' · 原始数据：'+(JSON.stringify(graph)===original?'未修改':'发生变更')));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`
const assets = { '/viewer.js': 'extension/viewer.js', '/viewer.css': 'extension/viewer.css',
  '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js' }
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (path === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
  if (!assets[path]) { res.writeHead(404); res.end(); return }
  res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
  if (path === '/viewer.js' && baselineViewer) { res.end(baselineViewer); return }
  res.end(readFileSync(new URL('../' + assets[path], import.meta.url)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
const stop = () => { server.closeAllConnections(); server.close() }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
