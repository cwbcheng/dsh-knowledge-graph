// Isolated browser fixture: production HTTP handler + SQLite + viewer, no AI
// and no connection to a running DSH profile or its database.
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as plugin from '../lib/index.js'

const directory = mkdtempSync(join(tmpdir(), 'kg-neighborhood-ui-'))
process.env.DSH_KG_DB = join(directory, 'fixture.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const nodes = Array.from({ length: 4800 }, (_, i) => ({ id: 'n' + i, type: i % 3 ? 'fact' : 'concept', text: 'Knowledge ' + i, quote: 'Source paragraph ' + i + '.', paragraph: i }))
const edges = Array.from({ length: 501 }, (_, i) => ({ fromNodeId: 'n0', toNodeId: 'n' + (4299 + i), relation: i % 2 ? 'supports' : 'analogy' }))
edges.push({ fromNodeId: 'n4299', toNodeId: 'n4799', relation: 'supports' }, { fromNodeId: 'n4799', toNodeId: 'n0', relation: 'contradicts' },
  { fromNodeId: 'n4799', toNodeId: 'n100', relation: 'supports' }, { fromNodeId: 'n100', toNodeId: 'n101', relation: 'supports' })
const graph = { source: { documentId: 'ui-fixture', id: 'ui-fixture', title: 'Neighborhood fixture' }, nodes, edges }
const sourceText = nodes.map(n => n.quote).join('\n\n')
store.saveGraph(graph, { sourceText })
store.saveGraph({ source: { documentId: 'hop-fixture', id: 'hop-fixture' },
  nodes: ['a', 'b', 'c', 'd'].map((id, paragraph) => ({ id, type: 'fact', text: id, paragraph })),
  edges: [['a', 'b'], ['b', 'c'], ['c', 'd']].map(([fromNodeId, toNodeId]) => ({ fromNodeId, toNodeId, relation: 'supports' })) },
{ sourceText: 'hop fixture' })
const routes = new Map(), ctx = new Context()
class Timer extends Service {
  constructor(context) { super(context, 'timer'); context.mixin('timer', ['interval']) }
  interval(fn, ms) { return this.ctx.effect(() => { const id = setInterval(fn, ms); return () => clearInterval(id) }) }
}
await ctx.plugin(Timer)
ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
await ctx.plugin(plugin).await()
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relationship gathering fixture</title><link rel="stylesheet" href="/viewer.css">
<style>body{margin:0;font:14px system-ui}.kg-root{padding:12px}.kg-cols{height:740px;grid-template-columns:minmax(180px,32%) minmax(0,1fr)}.kg-original{overflow:auto;max-height:740px}.fixture-header{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}#metrics{white-space:pre-wrap;font-size:12px}@media(max-width:600px){.kg-cols{height:auto;grid-template-columns:1fr}.kg-original{max-height:120px}}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/viewer.js"></script></head>
<body><div id="root"></div><pre id="metrics"></pre><script>
const h=React.createElement, stats={requests:0,workers:0,commits:0,located:null,longTasks:[]}; window.fixtureStats=stats;
const OriginalWorker=Worker; window.Worker=class extends OriginalWorker{constructor(...args){super(...args);stats.workers++}};
new PerformanceObserver(list=>stats.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
const timer={timeout(fn,ms){const id=setTimeout(fn,ms);return ()=>clearTimeout(id)}};
fetch('/base?limit='+new URLSearchParams(location.search).get('limit')).then(r=>r.json()).then(base=>{
const v=KGViewer.makeView(base,base.sourceText), paragraphs=v.paragraphs;
function App(){
const [id,setId]=React.useState('n0'),[edge,setEdge]=React.useState(null),[focus,setFocus]=React.useState({seq:0}),[projection,setProjection]=React.useState(null),[active,setActive]=React.useState(-1),[delay,setDelay]=React.useState(0),[revision,setRevision]=React.useState(base.revision),[mounted,setMounted]=React.useState(true);
const original=React.useRef(null);
function locate(id,anchor){if(anchor===undefined){setId(id);setEdge(null);anchor=v.anchors[id]}stats.located={id,anchor};const pi=paragraphs.findIndex(p=>anchor>=p.start&&anchor<p.end);setActive(pi);document.getElementById('p'+pi)?.scrollIntoView({block:'center'})}
return h('main',{className:'kg-root'},h('div',{className:'fixture-header'},
h('label',null,'Response delay ',h('select',{'aria-label':'Response delay',value:delay,onChange:e=>setDelay(Number(e.target.value))},[0,1500].map(x=>h('option',{key:x,value:x},x)))),
h('button',{onClick:()=>{setId('n1');setFocus(v=>({nodeId:'n1',seq:v.seq+1}))}},'Select isolated node'),
h('button',{onClick:()=>{setId('n0');setFocus(v=>({nodeId:'n0',seq:v.seq+1}))}},'Select hub'),
h('button',{onClick:()=>fetch('/bump',{method:'POST'}).then(r=>r.json()).then(data=>setRevision(data.revision))},'Change revision'),
h('button',{onClick:()=>setMounted(!mounted)},mounted?'Unmount':'Mount')),
h('div',{className:'kg-cols'},h('div',{className:'kg-original',ref:original},paragraphs.map((p,i)=>h('div',{key:i,id:'p'+i,className:'kg-para'+(active===i?' kg-active':''),onClick:()=>{
const source=projection||v.graph,anchors=projection?.anchors||v.anchors; const node=source.nodes.find(n=>anchors[n.id]>=p.start&&anchors[n.id]<p.end);if(node){setId(node.id);setFocus(f=>({nodeId:node.id,seq:f.seq+1}))}
}},p.text))),h('div',{className:'kg-graph-col'},mounted?h(KGViewer.GraphViewer,{
nodes:v.graph.nodes,edges:v.graph.edges,anchors:v.anchors,sourceText:base.sourceText,documentId:'ui-fixture',revision,
selectedNodeId:id,selectedEdgeId:edge,focusReq:focus,onSelectNode:locate,onSelectEdge:i=>{setEdge(i);setId(null)},ctx:timer,height:740,layoutMode:'layered',onLayoutModeChange:()=>{},
onGatherProjection:setProjection,onGatherEnd:()=>{setActive(active);setId(id);setEdge(edge);setFocus(focus)},
loadNeighborhood:async(args,signal)=>{stats.requests++;const res=await fetch('/api/dsh-knowledge-graph/graph-neighborhood?delay='+delay,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal});return res.json()},
onDeleteEdge:()=>{stats.commits++}
}):null)))
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
});
setInterval(()=>document.getElementById('metrics').textContent=JSON.stringify(stats),500);
</script></body></html>`
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
    if (url.pathname === '/base') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(store.getDocumentWindow('ui-fixture', { limit: Number(url.searchParams.get('limit')) || 800 }))); return }
    if (url.pathname === '/bump' && req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(store.saveGraph(graph, { sourceText }))); return }
    if (url.pathname.startsWith('/api/')) {
      // Delay the response, not request consumption, so the real readBody
      // retains its streaming semantics and receives every request byte.
      const delay = Number(url.searchParams.get('delay')) || 0, end = res.end.bind(res)
      if (delay) res.end = (...args) => { setTimeout(() => { if (!res.destroyed) end(...args) }, delay); return res }
      await routes.get('/api/dsh-knowledge-graph').handler(req, res)
      return
    }
    const asset = { '/viewer.js': 'extension/viewer.js', '/viewer.css': 'extension/viewer.css', '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js' }[url.pathname]
    if (asset) { res.setHeader('content-type', asset.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(readFileSync(new URL('../' + asset, import.meta.url))); return }
    res.statusCode = 404; res.end()
  } catch (error) { res.statusCode = 500; res.end(String(error.stack)) }
})
server.listen(0, '127.0.0.1', async () => {
  const url = 'http://127.0.0.1:' + server.address().port
  if (!process.argv.includes('--smoke')) { console.log('FIXTURE_URL=' + url); return }
  let code = 0
  try {
    const revision = store.getDocumentRevision('ui-fixture'), ids = new Set(), keys = new Set()
    let offset = 0, requests = 0
    const call = async body => {
      const response = await fetch(url + '/api/dsh-knowledge-graph/graph-neighborhood', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 200)
      return response.json()
    }
    while (offset < 501) {
      const page = await call({ documentId: 'ui-fixture', expectedRevision: revision, centerId: 'n0', offset, limit: 80 })
      assert.equal(page.neighborsTotal, 501); assert.equal(page.offset, offset)
      assert(page.nextOffset > offset)
      page.nodes.forEach(n => ids.add(n.id)); page.edges.forEach(e => keys.add(JSON.stringify([e.fromNodeId, e.toNodeId, e.relation])))
      offset = page.nextOffset; requests++
    }
    assert.equal(ids.size, 502); assert.equal(keys.size, 503)
    const expanded = await call({ documentId: 'ui-fixture', expectedRevision: revision, centerId: 'n0', hops: 3, offset: 500, limit: 80 })
    assert.equal(expanded.neighborsTotal, 503)
    assert.deepEqual(expanded.nodes.slice(-2).map(node => [node.id, node.gatherDepth]), [['n100', 2], ['n101', 3]])
    const hopRevision = store.getDocumentRevision('hop-fixture')
    const threeHops = await call({ documentId: 'hop-fixture', expectedRevision: hopRevision, centerId: 'a', direction: 'out', hops: 3 })
    assert.deepEqual(threeHops.nodes.map(node => [node.id, node.gatherDepth]), [['a', 0], ['b', 1], ['c', 2], ['d', 3]])
    assert.equal(threeHops.edges.length, 3)
    assert.equal((await call({ documentId: 'hop-fixture', expectedRevision: hopRevision, centerId: 'a', hops: 6 })).error.code, 'invalid_input')
    assert.equal((await call({ documentId: 'ui-fixture', expectedRevision: revision - 1, centerId: 'n0' })).error.code, 'revision_conflict')
    assert.equal((await call({ documentId: 'ui-fixture', centerId: 'n0' })).error.code, 'invalid_input')
    assert.equal((await call({ documentId: 'ui-fixture', expectedRevision: revision, centerId: 'missing' })).error.code, 'not_found')
    assert.equal(store.getDocumentRevision('ui-fixture'), revision)
    console.log(JSON.stringify({ persistentHttpNeighborhood: true, requests, nodes: ids.size, edges: keys.size, readOnly: true }))
  } catch (error) { console.error(error); code = 1 }
  await stop(code)
})
async function stop(code = 0) { await ctx.fiber.dispose(); store.close(); server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); process.exit(Number.isInteger(code) ? code : 0) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
