import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

// Isolated browser fixture: synthetic graph only, no model or production DB.
const root = new URL('../', import.meta.url)
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Knowledge graph loading test</title>
<link rel="stylesheet" href="/extension/viewer.css">
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}.controls{display:flex;gap:8px;flex-wrap:wrap;padding:12px}.test-surface{width:min(1200px,100%);margin:auto}.metrics{padding:8px;overflow-wrap:anywhere;font-size:12px}button{min-height:32px}body.mobile .test-surface{width:360px;max-width:100%}</style>
<script src="/extension/vendor/react.production.min.js"></script><script src="/extension/vendor/react-dom.production.min.js"></script>
<script src="/extension/d3/d3-timer.js"></script><script src="/extension/d3/d3-dispatch.js"></script><script src="/extension/d3/d3-quadtree.js"></script><script src="/extension/d3/d3-force.js"></script>
<script src="/extension/viewer.js"></script></head><body><div id="app" class="test-surface kg-root"></div><script>
const h=React.createElement;
let previous=performance.now(), frames=0, longest=0, stages=new Set(), elapsed=0, started=0, workers=0;
const NativeWorker=Worker;window.Worker=class extends NativeWorker {constructor(...args){super(...args);workers++}};
requestAnimationFrame(function tick(now){frames++;longest=Math.max(longest,now-previous);previous=now;requestAnimationFrame(tick)});
const monitor=setInterval(()=>{const status=document.querySelector('.kg-load-heading');if(status)stages.add(status.textContent);const busy=document.querySelector('.kg-graph-stage')?.getAttribute('aria-busy')==='true';if(busy)elapsed=Math.round(performance.now()-started);const out=document.getElementById('metrics');if(out)out.textContent=JSON.stringify({frames,longest:Math.round(longest),elapsed,workers,stages:[...stages],nodes:document.querySelectorAll('.kg-node').length,busy})},50);
function makeGraph(count){const nodes=Array.from({length:count},(_,i)=>({id:'n'+i,type:i%3?'claim':'example',text:'Knowledge node '+i+' - evidence and relationships',paragraph:i}));const edges=nodes.slice(1).flatMap((n,i)=>i%7?[{fromNodeId:'n'+i,toNodeId:n.id,relation:i%3?'causes':'example'}]:[]);return{nodes,edges,anchors:Object.fromEntries(nodes.map(n=>[n.id,n.paragraph]))}}
function App(){const[data,setData]=React.useState(makeGraph(0));const[visible,setVisible]=React.useState(true);const[mode,setMode]=React.useState('layered');const[selected,onSelectNode]=React.useState(null);const[edge,onSelectEdge]=React.useState(null);const[height,setHeight]=React.useState(600);
const reload=(count,nextMode='layered')=>{stages=new Set();frames=0;longest=0;started=performance.now();setData(makeGraph(count));setMode(nextMode);setVisible(true)};
return h(React.Fragment,null,h('div',{className:'controls'},
h('button',{onClick:()=>reload(800)},'Load 800'),h('button',{onClick:()=>reload(2000)},'Load 2000'),h('button',{onClick:()=>reload(2000,'force')},'Force 2000'),h('button',{onClick:()=>setVisible(false)},'Close graph'),h('button',{onClick:()=>{document.body.classList.toggle('mobile');setHeight(document.body.classList.contains('mobile')?480:600)}},'Mobile width')),
visible?h(KGViewer.GraphViewer,{...data,ctx:{timeout:(fn,ms)=>{const id=setTimeout(fn,ms);return()=>clearTimeout(id)}},height,layoutMode:mode,onLayoutModeChange:setMode,selectedNodeId:selected,selectedEdgeId:edge,onSelectNode,onSelectEdge,focusReq:{seq:0}}):null,h('output',{id:'metrics',className:'metrics'}))}
ReactDOM.createRoot(document.getElementById('app')).render(h(App));
</script></body></html>`
const files = new Set(['extension/viewer.css', 'extension/viewer.js', 'extension/vendor/react.production.min.js', 'extension/vendor/react-dom.production.min.js', 'extension/d3/d3-timer.js', 'extension/d3/d3-dispatch.js', 'extension/d3/d3-quadtree.js', 'extension/d3/d3-force.js'])
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname.slice(1)
  response.setHeader('cache-control', 'no-store')
  if (!path) { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return }
  if (path === 'favicon.ico') { response.writeHead(204).end(); return }
  if (!files.has(path)) { response.writeHead(404).end(); return }
  response.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
  response.end(readFileSync(new URL(path, root)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())
