import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { modelLearningHarness, learnerResponse } from './kg-model-learning-fixture-data.mjs'
import { feedbackResponse } from './kg-model-feedback-fixture-data.mjs'
import { counterexampleResponse } from './kg-model-comparison-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { modelSourceContextFixture } from './kg-model-source-context-fixture-data.mjs'
import { modelSourceTableFixture } from './kg-model-source-table-fixture-data.mjs'
import { modelReviewControllerSource } from './kg-model-review-controller-fixture.mjs'
import { modelCitationFixture, modelCitationBrowserNavigatorSource } from './kg-model-citation-locator-fixture.mjs'

const citationNavigation = process.argv.includes('--citation-navigation'), citationWindow = process.argv.includes('--citation-window')
const fixture = citationNavigation ? modelCitationFixture({ dense: process.argv.includes('--dense'), anchor: process.argv.includes('--second-fragment') ? 2 : 1,
  long: process.argv.includes('--long-citation'), third: process.argv.includes('--citation-third') }) : process.argv.includes('--source-table')
  ? modelSourceTableFixture({ dense: process.argv.includes('--dense'), gap: process.argv.includes('--gap'), peer: process.argv.includes('--peer') })
  : process.argv.includes('--source-context') ? modelSourceContextFixture() : modelStructureFixture()
if (process.argv.includes('--diagnostics')) {
  fixture.sourceUnits[0].text += ' 此处结果往往成立，但不保证必然成立。'
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
}
const harness = await modelLearningHarness({ fixture })
if (process.argv.includes('--diagnosis-citation-records')) {
  // Explicit synthetic predictions/results, including an unrevealed prediction.
  // Browser citation checks only read these frozen records.
  const base = { documentId: harness.document.documentId, modelId: 'taxi', expectedRevision: 1 }
  const plan = await harness.post({ ...base, action: 'plan' })
  if (plan.error) throw new Error(plan.error.message)
  const stamp = Date.now() - 10000
  for (const [index, id] of ['a', 'b', 'hidden'].entries()) {
    const attemptId = 'diagnosis-prediction-' + id
    const saved = await harness.post({ ...base, action: 'save', taskId: plan.tasks[0].id, attemptId, selfRating: 'uncertain',
      response: { ...learnerResponse, scenario: id + ' · 合成情境；条件尚未独立核验' } })
    if (saved.error) throw new Error(saved.error.message)
    harness.store.db.prepare('UPDATE learning_attempts SET created_at = ? WHERE attempt_id = ?').run(stamp + index, attemptId)
    const prediction = id === 'hidden' ? saved : await harness.post({ ...base, action: 'reveal', attemptId, expectedVersion: 1 })
    if (prediction.error) throw new Error(prediction.error.message)
    const results = id === 'a' ? ['a', 'b', 'input'] : [id]
    for (const [position, name] of results.entries()) {
      const resultId = 'diagnosis-result-' + id + '-' + name
      const result = await harness.post({ ...base, action: 'save-result', predictionId: attemptId, attemptId: resultId, expectedVersion: prediction.attempt.version,
        response: { ...feedbackResponse('reflection'), diagnosis: name === 'input' ? 'input' : 'mapping', content: resultId + ' · 个人诊断，尚未核验' } })
      if (result.error) throw new Error(result.error.message)
      harness.store.db.prepare('UPDATE learning_attempts SET created_at = ? WHERE attempt_id = ?').run(stamp + 100 + position, resultId)
    }
  }
}
if (process.argv.includes('--learning-citation-records')) {
  // Explicit challenge snapshots exercise the same saved-citation component;
  // unrevealed source remains hidden and browser navigation stays read-only.
  const base = { documentId: harness.document.documentId, modelId: 'taxi', exercise: 'counterexample', expectedRevision: 1 }
  const plan = await harness.post({ ...base, action: 'plan' })
  if (plan.error) throw new Error(plan.error.message)
  const stamp = Date.now() - 10000
  for (const [index, id] of ['a', 'b', 'hidden'].entries()) {
    const attemptId = 'learning-challenge-' + id
    const saved = await harness.post({ ...base, action: 'save', taskId: plan.tasks[0].id, attemptId, selfRating: 'uncertain',
      response: { ...counterexampleResponse, scenario: id + ' · ' + counterexampleResponse.scenario } })
    if (saved.error) throw new Error(saved.error.message)
    harness.store.db.prepare('UPDATE learning_attempts SET created_at = ? WHERE attempt_id = ?').run(stamp + index, attemptId)
    if (id !== 'hidden') {
      const revealed = await harness.post({ ...base, action: 'reveal', attemptId, expectedVersion: 1 })
      if (revealed.error) throw new Error(revealed.error.message)
    }
  }
}
if (process.argv.includes('--understanding-citation-records')) {
  // Explicit synthetic learner records let browser checks switch snapshots
  // without writing any personal data during citation navigation.
  const base = { documentId: harness.document.documentId, modelId: 'taxi', exercise: 'understanding', expectedRevision: 1 }
  const plan = await harness.post({ ...base, action: 'plan' })
  if (plan.error) throw new Error(plan.error.message)
  for (const [attemptId, parentAttemptId] of [['understanding-first', ''], ['understanding-second', 'understanding-first']]) {
    const result = await harness.post({ ...base, action: 'save', taskId: plan.tasks[0].id, attemptId, selfRating: 'not_assessed',
      response: { inputs: '本次行程距离', mapping: attemptId + ' · 个人表述，尚未核验', outputs: '费用', conditions: '白天、无附加收费',
        boundary: '不能外推到夜间；未独立验证', questions: '条件是否充分？', revisionReason: parentAttemptId ? '对照后仍有疑问' : '',
        parentAttemptId, practiceIds: [] } })
    if (result.error) throw new Error(result.error.message)
  }
}
const initial = harness.store.getDocument(harness.document.documentId)
const initialUnderstanding = JSON.stringify(harness.store.listLearningAttempts(harness.document.documentId, 'taxi', 'understanding'))
const initialLearning = JSON.stringify(harness.store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all())
const initialUnits = JSON.stringify(harness.store.getDocumentSourceUnits(harness.document.documentId))
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
${citationNavigation ? modelCitationBrowserNavigatorSource() : ''}
function App(){
  const [view,setView]=React.useState(null),[reference,setReference]=React.useState(null),[modelsActive,setModelsActive]=React.useState(true);
  const state=React.useRef({graphCommitQueueRef:{current:Promise.resolve()},currentResultRef:{current:null},graphRevisionRef:{current:0},verifyBusyRef:{current:false}});
  const refresh=async()=>{const result=await rpc('document-export',{documentId:'connection-fixture',includeSourceText:true});if(result.error)throw new Error(result.error.message);const next={graph:result.graph,sourceText:result.sourceText};state.current.currentResultRef.current=next;state.current.graphRevisionRef.current=result.revision;setView(next)};
  React.useEffect(()=>{refresh().catch(reason=>setReference({error:reason.message}))},[]);
  const citationNavigator=React.useMemo(()=>view&&${citationNavigation ? `createCitationNavigator(view,reference=>setReference(previous=>({...reference,sequence:(previous?.sequence||0)+1})),${citationWindow})` : 'null'},[view]);
  if(!view)return h('main',{className:'kg-root'},h('p',{role:'status'},'正在读取隔离模型…'));
  state.current.resultView=view;state.current.onSaved=setView;
  const controller=createModelReviewController(state.current,{call:rpc});
  const locate=citationNavigator||(reference=>{const target=reference.sourceQuoteOnly?exactSourceQuoteTarget(KGViewer.makeView(view.graph,view.sourceText),reference):null;setReference(previous=>({...reference,sequence:(previous?.sequence||0)+1,readingParagraph:target?.first??reference.paragraph}))});
  return h('main',{className:'kg-root'},h('h1',null,'联结模型 · 结构核对'),${process.argv.includes('--citation-switch-controls') ? "h('button',{onClick:()=>setModelsActive(value=>!value)},modelsActive?'查看知识图':'返回联结模型')," : ''}
    h('div',{style:{display:modelsActive?'block':'none'}},h(KGViewer.ConnectionModelPanel,{documentId:'connection-fixture',revision:state.current.graphRevisionRef.current,active:modelsActive,
    load:(args,signal)=>rpc('connection-models',args,signal),learningCall:(args,signal)=>rpc('learning-mode',args,signal),onStructure:controller,onRoles:controller,onRefresh:refresh,onLocate:locate})),
    h('p',{role:'status'},reference?JSON.stringify(reference):''), ${citationNavigation ? `h('section',{'aria-label':'原文定位结果'},KGViewer.makeView(view.graph,view.sourceText).paragraphs.map((span,index)=>h('p',{key:index,id:'kg-para-'+index,'data-located':reference?.readingParagraph===index},view.sourceText.slice(span.start,span.end))))` : 'null'});
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
      learningRecordsUnchanged: JSON.stringify(harness.store.listLearningAttempts(harness.document.documentId, 'taxi', 'understanding')) === initialUnderstanding,
      diagnosisRecordsUnchanged: JSON.stringify(harness.store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()) === initialLearning,
      sourceUnitsUnchanged: JSON.stringify(harness.store.getDocumentSourceUnits(harness.document.documentId)) === initialUnits,
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
