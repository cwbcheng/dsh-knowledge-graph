// Real workbench, synthetic in-memory transport: no model or production writes.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  .replace('export default function clientPlugin()', 'function clientPlugin()')
  .replace('      // --------------------------- slot registration', '      window.fixtureWorkbench = WorkbenchBody;\n      // --------------------------- slot registration')
  + '\nwindow.fixturePlugin = clientPlugin();'
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>多知识图并行 · 隔离界面验证</title><style>body{margin:0;background:#f5f7fb;color:#1f2937;font:14px system-ui}main{max-width:1140px;margin:auto;padding:20px}.fixture-notice{padding:12px;background:#e8f0ff;border:1px solid #a8c5ff;border-radius:8px;margin-bottom:16px}.fixture-notice p{margin:5px 0}#fixture-activity{display:block;font-size:12px}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script>
</head><body><main><aside class="fixture-notice"><strong>多知识图并行 · 隔离界面验证</strong><p>以下资料和任务均为合成示例。使用真实工作台代码，不连接模型或正式服务。</p><output id="fixture-activity"></output></aside><div id="root" class="kg-root"></div></main>
<script>
window.styles={insert(css){const element=document.createElement('style');element.textContent=css;document.head.append(element)}};
const started=Date.now(), tasks=new Map(), actions=[];
function progress(task){return {stage:'分块生成 '+(task.taskId==='fixture-a'?'3/8':'2/6'),canPause:task.status==='running',paused:task.status==='paused',requests:[],completedBatches:2,elapsedMs:Date.now()-started,sampledAt:Date.now()}}
for(const [suffix,title] of [['a','示例资料甲：学习方法'],['b','示例资料乙：阅读策略']])tasks.set('fixture-'+suffix,{taskId:'fixture-'+suffix,documentId:'doc-'+suffix,kind:'extract',label:'资料拆分',title,status:'running',createdAt:started});
const documents=[{documentId:'saved-example',title:'已保存示例：设备记录',nodeCount:1,edgeCount:0,updatedAt:started}];
function activity(){document.getElementById('fixture-activity').textContent='模拟生成提交：'+actions.filter(x=>x==='extract').length+' · 模拟取消：'+actions.filter(x=>x==='task-cancel').length+' · 任务总数：'+tasks.size}
window.host={async call(name,args={}){
 if(name==='task-active'){const active=[...tasks.values()].filter(t=>t.status==='running');return {busy:active.length>0,activeCount:active.length,maxConcurrentTasks:4,preparingCount:0,tasks:[...tasks.values()].map(t=>({...t,progress:progress(t)})),task:active[0]||null}}
 if(name==='task-status'){const task=tasks.get(args.taskId);return task?{status:task.status,progress:progress(task)}:{status:'not_found'}}
 if(name==='list-models')return {providers:[{id:'fixture',name:'模拟模型',models:[{id:'fixture',name:'模拟模型'}]}],current:{provider:'fixture',model:'fixture'}};
 if(name==='ontology-list')return {ontologies:[]};
 if(name==='extraction-run-list')return {runs:[]};
 if(name==='document-list')return {documents};
 if(name==='candidate-list')return {candidates:[]};
 if(name==='document-load'){const node={id:'n1',type:'fact',text:'示例设备功率为一瓦。',quote:'示例设备功率为一瓦。',paragraph:0};return {documentId:args.documentId,revision:1,sourceText:node.text,graph:{nodes:[node],edges:[],summary:'合成设备记录',source:{documentId:args.documentId,title:documents[0].title,revision:1}}}}
 if(name==='extract'){actions.push(name);const active=[...tasks.values()].filter(t=>t.status==='running');if(active.length>=4)return {error:{code:'busy',message:'同时执行任务已达上限（4）'}};const taskId='fixture-'+(tasks.size+1),documentId='doc-'+(tasks.size+1);tasks.set(taskId,{taskId,documentId,kind:'extract',label:'资料拆分',title:args.title||'合成新资料',status:'running',createdAt:Date.now()});activity();return {taskId,documentId}}
 if(name==='task-pause'||name==='task-cancel'){actions.push(name);const task=tasks.get(args.taskId);if(task)task.status=name==='task-pause'?'paused':'cancelled';activity();return {status:task?.status||'not_found'}}
 if(name==='resume-extract'){const task=tasks.get(args.runId);if(task)task.status='running';return {taskId:args.runId,resumed:true}}
 return {error:{code:'fixture_unsupported',message:'此隔离场景未提供该接口：'+name}};
}};
localStorage.setItem('dsh-kg-pending-v2',JSON.stringify({taskId:'fixture-a',documentId:'doc-a',title:tasks.get('fixture-a').title}));
activity();
</script><script src="/client.js"></script><script>
const ctx={get(name){if(name==='slots')return {inject(){},register(){return ()=>{}}};return null},timeout(fn,ms){const timer=setTimeout(fn,Math.min(ms,300));return ()=>clearTimeout(timer)}};
fixturePlugin.apply(ctx).then(()=>ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(fixtureWorkbench,{ctx})));
</script></body></html>`
const server = createServer((req, res) => {
  res.setHeader('cache-control', 'no-store')
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (path === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
  res.setHeader('content-type', 'text/javascript; charset=utf-8')
  if (path === '/client.js') { res.end(client); return }
  const assets = { '/react.js': 'extension/vendor/react.production.min.js', '/react-dom.js': 'extension/vendor/react-dom.production.min.js' }
  if (!assets[path]) { res.writeHead(404); res.end(); return }
  res.end(readFileSync(new URL('../' + assets[path], import.meta.url)))
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
const stop = () => { server.closeAllConnections(); server.close() }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
