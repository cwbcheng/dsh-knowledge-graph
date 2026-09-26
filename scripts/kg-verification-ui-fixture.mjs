// Full production workbench/trajectory client and persistent HTTP host, backed
// by an owned temporary SQLite database and a manually controlled model.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { openSqliteStore } from '../src/kg-store.mjs'
import * as plugin from '../lib/index.js'

const directory = mkdtempSync(join(tmpdir(), 'kg-verification-ui-'))
process.env.DSH_KG_DB = join(directory, 'fixture.sqlite')
const store = await openSqliteStore(process.env.DSH_KG_DB)
const documentId = 'verification-fixture'
const snapshotMode = process.argv.includes('--snapshot')
const contextLimitMode = process.argv.includes('--context-limit')
const sourceLimitMode = process.argv.includes('--source-limit')
const sourceBoundaryMode = process.argv.includes('--source-boundary')
const graphReviewMode = process.argv.includes('--graph-review')
const repairContextLimitMode = process.argv.includes('--review-repair-limit')
const repairPatchLimitMode = process.argv.includes('--repair-patch-limit')
const repairQualification = 'The conclusion applies only to adults, not for children.'
const completeRepairText = 'The study compared the groups under controlled conditions and recorded their scores. '.repeat(7)
  + repairQualification
const reviewFieldsMode = process.argv.includes('--review-fields') || repairContextLimitMode
const reviewDismissMode = process.argv.includes('--review-dismiss')
const reviewSaveMode = process.argv.includes('--review-save') || reviewDismissMode
const trajectoryQueueMode = process.argv.includes('--trajectory-queue')
const quickVerifyMode = process.argv.includes('--quick-verify')
const documentQueueMode = process.argv.includes('--document-queue') || quickVerifyMode
const heldSaveMode = trajectoryQueueMode || documentQueueMode
const reviewMode = process.argv.includes('--review') || snapshotMode || contextLimitMode || sourceLimitMode || sourceBoundaryMode || graphReviewMode || reviewFieldsMode || reviewSaveMode || heldSaveMode || repairPatchLimitMode
const paragraphs = Array.from({ length: snapshotMode || contextLimitMode || reviewSaveMode ? 803 : 37 }, (_, i) => 'Fixture observation ' + i + ' is recorded in the source.')
if (reviewSaveMode) paragraphs[0] = 'Fixture observation 0 supports fixture observation 801 in the source.'
if (repairPatchLimitMode) paragraphs[0] = paragraphs[1] = '> ' + completeRepairText
if (reviewFieldsMode) paragraphs[0] = '> ' + 'The study compared groups under the same controlled conditions. '.repeat(5)
  + 'The conclusion applies to adults, not for children.'
if (sourceLimitMode || sourceBoundaryMode) paragraphs[36] = '> ' + 'x'.repeat(239999)
if (sourceBoundaryMode) {
  paragraphs[0] = '  ScopeStart()'
  paragraphs[1] = 'AtomicCodeSegment_'.repeat(14)
  paragraphs[2] = '  ScopeEnd()'
}
if (graphReviewMode) paragraphs.push('An unanchored qualification applies to the entire summary.')
const sourceText = sourceBoundaryMode
  ? paragraphs.slice(0, 3).join('\n') + '\n\n' + paragraphs.slice(3).join('\n\n') : paragraphs.join('\n\n')
const graph = {
  source: { id: documentId, documentId, title: 'Verification fixture' },
  nodes: (graphReviewMode ? paragraphs.slice(0, -1) : paragraphs).map((text, i) => ({ id: 'n' + i, type: 'fact', text: text.trim(), quote: text, paragraph: i,
    evidence: [{ documentId, sourceId: documentId, paragraph: i, quote: text }], groundingStatus: 'grounded' })),
  edges: [],
  traceText: sourceText,
  traceEvents: paragraphs.map((line, index) => ({ line, index, type: 'user/message', title: 'Fixture event ' + index })),
}
if (reviewMode) {
  for (const node of graph.nodes.slice(0, 2)) { node.quote = ''; node.evidence = []; node.groundingStatus = 'unverified' }
  graph.verification = { stale: true, lastReport: {
    reportId: 'fixture-review', mode: 'deep', summary: 'Isolated batch review fixture', stale: true,
    metrics: { errorCount: 2, warningCount: 2, suggestionCount: 0 },
    issues: graph.nodes.slice(0, 4).map((node, i) => ({ id: 'review-' + node.id, targetKind: 'node', targetId: node.id,
      title: i < 2 ? 'Missing source quote' : 'Check source support', detail: 'Check only this node against its source paragraph.',
      severity: i < 2 ? 'error' : 'warning', source: 'ai', status: 'open', evidence: [{ paragraph: i, quote: paragraphs[i] }],
      proposedFix: { action: 'none' } })),
  } }
}
if (contextLimitMode) {
  graph.edges = [{ fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports' },
    ...Array.from({ length: 94 }, (_, i) => ({ fromNodeId: 'n801', toNodeId: 'n' + (i + 2), relation: 'supports' }))]
  graph.verification.lastReport.issues[0].detail = 'Compare n0 with n801 and inspect both complete neighborhoods.'
}
if (sourceLimitMode || sourceBoundaryMode) {
  Object.assign(graph.nodes[36], { text: 'An indivisible oversized quotation.', quote: '', evidence: [], groundingStatus: 'unverified' })
  graph.edges = sourceBoundaryMode ? [{ fromNodeId: 'n3', toNodeId: 'n1', relation: 'supports' }]
    : [{ fromNodeId: 'n0', toNodeId: 'n36', relation: 'supports' }]
}
if (reviewSaveMode) {
  graph.edges = [{ fromNodeId: 'n0', toNodeId: 'n801', relation: 'supports', evidence: [{ paragraph: 0, quote: paragraphs[0] }] }]
  graph.verification.lastReport.issues[0].detail = 'Check n0 against the comparison n801 before repairing the quotation.'
}
if (reviewDismissMode) {
  Object.assign(graph.nodes[0], { quote: paragraphs[0], evidence: [{ paragraph: 0, quote: paragraphs[0] }], groundingStatus: 'grounded' })
}
if (graphReviewMode) Object.assign(graph.verification.lastReport.issues[0], { targetKind: 'graph', targetId: null,
  title: 'Summary may omit a qualification', detail: 'Check the entire summary.' })
if (reviewFieldsMode) {
  graph.nodes[0].text = (repairContextLimitMode ? 'x'.repeat(236000)
    : 'The study compared multiple groups and measured their scores under the same conditions. '.repeat(3))
    + 'The conclusion applies to adults, not for children.'
  Object.assign(graph.nodes[0], { quote: paragraphs[0], evidence: [{ paragraph: 0, quote: paragraphs[0] }], groundingStatus: 'grounded' })
  graph.edges = [{ fromNodeId: 'n0', toNodeId: 'n4', relation: 'supports', evidence: [{ paragraph: 0, quote: paragraphs[0] }] }]
  Object.assign(graph.verification.lastReport.issues[0], { title: 'Possible overgeneralization',
    detail: 'The conclusion may improperly include children.' })
}
if (repairPatchLimitMode) for (const i of [0, 1]) {
  Object.assign(graph.nodes[i], { text: 'The conclusion applies to every population.', quote: repairQualification,
    evidence: [{ paragraph: i, quote: repairQualification }], groundingStatus: 'grounded' })
  Object.assign(graph.verification.lastReport.issues[i], { title: 'Conclusion omits its population restriction',
    detail: 'Check the restriction to adults.', evidence: [{ paragraph: i, quote: repairQualification }] })
}
store.saveGraph(graph, { sourceText })
if (documentQueueMode) {
  const second = structuredClone(graph), id = 'verification-second'
  second.source = { ...second.source, id, documentId: id, title: 'Second verification fixture' }
  second.nodes = second.nodes.map(node => ({ ...node, evidence: (node.evidence || []).map(evidence =>
    ({ ...evidence, documentId: id, sourceId: id })) }))
  store.saveGraph(second, { sourceText })
}
const routes = new Map(), ctx = new Context(), pending = new Set()
const stats = { submissions: 0, statusCalls: 0, commits: 0, modelCalls: 0, questionRequests: 0, snapshotExports: 0 }
if (snapshotMode) Object.assign(stats, { cachedSourceResponses: 0, sourceParagraph0: null })
let dropStatus = 0, rejectSave = false, finishAutomatically = false
let holdNextSave = false, releaseHeldSave = null
let holdNextVerification = false, releaseHeldVerification = null
class Timer extends Service {
  constructor(context) { super(context, 'timer'); context.mixin('timer', ['interval']) }
  interval(fn, ms) { return this.ctx.effect(() => { const id = setInterval(fn, ms); return () => clearInterval(id) }) }
}
await ctx.plugin(Timer)
ctx.provide('llm', { stream(request) {
  stats.modelCalls++
  if (snapshotMode) stats.sourceParagraph0 = String(request.messages?.[0]?.content?.[0]?.text || '')
    .split('\n').find(line => line.startsWith('[P0]')) || null
  const reviewedIndex = Number(JSON.stringify(request).match(/review-n(\d+)/)?.[1])
  const wholeGraphReview = graphReviewMode && reviewedIndex === 0
  if (wholeGraphReview) {
    const prompt = String(request.messages?.[0]?.content?.[0]?.text || '')
    const subgraph = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"summary":')))
    stats.wholeGraphContext = { nodes: subgraph.nodes.length, edges: subgraph.edges.length,
      sourceUnits: prompt.split('\n').filter(line => line.startsWith('[P')).length,
      includesUnanchoredTail: prompt.includes(paragraphs.at(-1)) }
  }
  const sourceLine = sourceLimitMode || sourceBoundaryMode ? String(request.messages?.[0]?.content?.[0]?.text || '').split('\n')
    .find(line => line.startsWith('[P') && line.endsWith(' ' + paragraphs[reviewedIndex])) : null
  const evidenceParagraph = wholeGraphReview ? paragraphs.length - 1 : sourceLine ? Number(sourceLine.match(/^\[P(\d+)\]/)?.[1]) : reviewedIndex
  let reply = reviewMode && Number.isInteger(reviewedIndex) ? {
    verdict: wholeGraphReview || (reviewDismissMode && reviewedIndex === 0) || (sourceBoundaryMode && reviewedIndex === 3) ? 'false_positive'
      : reviewedIndex < 2 ? 'confirmed' : reviewedIndex === 2 ? 'false_positive' : 'uncertain',
    answer: 'Fixture evidence decision for n' + reviewedIndex,
    evidence: [{ paragraph: evidenceParagraph, quote: paragraphs[wholeGraphReview ? paragraphs.length - 1 : reviewedIndex] }],
    proposedFix: reviewedIndex < 2 && !wholeGraphReview && !(reviewDismissMode && reviewedIndex === 0) ? { action: 'update_node', nodePatch: { id: 'n' + reviewedIndex,
      patch: { quote: paragraphs[reviewedIndex] } } } : { action: 'none' },
  } : { issues: [] }
  if (reviewFieldsMode && reviewedIndex === 0) {
    const prompt = String(request.messages?.[0]?.content?.[0]?.text || '')
    const subgraph = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"summary":')))
    const target = subgraph.nodes.find(node => node.id === 'n0')
    stats.reviewFields = { textChars: target.text.length, quoteChars: target.quote.length,
      hasQualification: target.text.includes('not for children'), relationEvidence: subgraph.edges[0]?.evidence?.length || 0,
      promptChars: prompt.length }
    reply = { verdict: repairContextLimitMode || !stats.reviewFields.hasQualification ? 'confirmed' : 'false_positive',
      answer: repairContextLimitMode ? 'Controlled confirmation pending repair. ' + 'x'.repeat(1900)
        : 'The node already limits the conclusion to adults, not children.',
      evidence: [{ paragraph: 0, quote: 'The conclusion applies to adults, not for children.' }],
      proposedFix: { action: 'none' } }
  }
  if (repairPatchLimitMode && reviewedIndex < 2) {
    const repairPass = request.system.includes('结构化修复规划员')
    const text = reviewedIndex === 1 && repairPass ? repairQualification : completeRepairText
    stats.repairProposals ||= []
    stats.repairProposals.push({ node: reviewedIndex, repairPass, textChars: text.length })
    reply = { verdict: 'confirmed', answer: 'The source limits this conclusion to adults; retain that restriction.',
      evidence: [{ paragraph: reviewedIndex, quote: repairQualification }],
      proposedFix: { action: 'update_node', nodePatch: { id: 'n' + reviewedIndex, patch: { text } } } }
  }
  let closed = false
  const values = [{ done: false, value: { type: 'reasoning-delta', index: 0, text: 'fixture' } }], readers = []
  const stream = {
    [Symbol.asyncIterator]() { return this },
    next() { return values.length ? Promise.resolve(values.shift()) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => readers.push(resolve)) },
    return() { closed = true; pending.delete(stream); while (readers.length) readers.shift()({ done: true }); return Promise.resolve({ done: true }) },
    finish() {
      if (closed) return
      const item = { done: false, value: { type: 'text-delta', index: 0, text: JSON.stringify(reply) } }
      if (readers.length) readers.shift()(item); else values.push(item)
      this.return()
    },
  }
  pending.add(stream)
  if (finishAutomatically) setTimeout(() => stream.finish(), 100)
  return stream
} })
ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
await ctx.plugin(plugin).await()
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Isolated verification fixture</title><style>body{margin:0;font:14px system-ui}main{max-width:1280px;margin:auto;padding:12px;box-sizing:border-box}nav{display:flex;gap:8px;padding:8px;flex-wrap:wrap;background:#e5e7eb;color:#111}#fixture-state{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script></head><body>
<nav aria-label="Fixture controls"><a href="/">Workbench fixture</a><a href="/?trajectory=1">Trajectory fixture</a>
<button onclick="control('next')">Finish one batch</button><button onclick="control('complete')">Complete fixture task</button>
<button onclick="control('offline')">Drop two status requests</button><button onclick="control('reject-save')">Reject next report save</button></nav>
${snapshotMode ? '<nav><button onclick="control(\'advance-revision\')">Advance fixture revision</button></nav>' : ''}
${reviewSaveMode ? '<nav><button onclick="control(\'change-hidden\')">Change hidden dependency</button><button onclick="control(\'change-unrelated\')">Change unrelated node</button></nav>' : ''}
${heldSaveMode ? '<nav><button onclick="control(\'hold-next-save\')">Hold next graph save</button><button onclick="control(\'reject-held-save\')">Reject held graph save</button></nav>' : ''}
${quickVerifyMode ? '<nav><button onclick="control(\'hold-next-verification\')">Hold next quick report</button><button onclick="control(\'release-verification\')">Release quick report</button></nav>' : ''}
<main class="kg-root" id="root"></main><pre id="fixture-state"></pre>
<script>
window.fixtureErrors=[];window.addEventListener('error',event=>fixtureErrors.push(event.message));
async function control(action){await fetch('/fixture/'+action,{method:'POST'})}
localStorage.setItem('dsh-kg-result-v2',JSON.stringify({documentId:'verification-fixture',title:'Verification fixture'}));
localStorage.setItem('dsh-kg-traj-result-v2:fixture',JSON.stringify({documentId:'verification-fixture'}));
window.__ModuleLoader__={load({factory}){
 const client=factory(name=>{if(name==='react')return React;throw new Error('Unexpected module '+name)});
 const slots={inject(){},register(){}};
 const ctx={get:name=>name==='slots'?slots:null,timeout(fn,ms){const id=setTimeout(fn,ms);return ()=>clearTimeout(id)}};
 client.apply(ctx);
 const trajectory=new URLSearchParams(location.search).has('trajectory');
 ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(trajectory?fixtureComponents.TrajectoryTab:fixtureComponents.WorkbenchBody,trajectory?{sessionId:'fixture'}:{ctx}));
}};
setInterval(async()=>{document.getElementById('fixture-state').textContent=JSON.stringify(await fetch('/fixture/stats').then(r=>r.json()))},1000);
</script><script src="/client.js"></script></body></html>`
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('cache-control', 'no-store')
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
    if (url.pathname === '/fixture/stats') { json({ ...stats, pending: pending.size, revision: store.getDocumentRevision(documentId),
      ...(repairPatchLimitMode ? { repairTargets: store.getDocument(documentId).nodes.slice(0, 2) } : {}),
      ...(heldSaveMode ? { saveHeld: !!releaseHeldSave } : {}),
      ...(quickVerifyMode ? { verificationHeld: !!releaseHeldVerification } : {}),
      ...(documentQueueMode ? { documents: [documentId, 'verification-second'].map(id => ({ id,
        revision: store.getDocumentRevision(id), statuses: store.getDocument(id).verification.lastReport.issues.map(issue => issue.status),
        ...(quickVerifyMode ? { reportId: store.getDocument(id).verification.lastReport.reportId,
          graphContentHash: createHash('sha256').update(JSON.stringify({ nodes: store.getDocument(id).nodes,
            edges: store.getDocument(id).edges })).digest('hex') } : {}) })) } : {}),
      ...(reviewSaveMode ? { targetQuote: store.getDocument(documentId).nodes.find(node => node.id === 'n0').quote,
        unrelatedText: store.getDocument(documentId).nodes.find(node => node.id === 'n700').text,
        graphContentHash: createHash('sha256').update(JSON.stringify({ nodes: store.getDocument(documentId).nodes,
          edges: store.getDocument(documentId).edges })).digest('hex') } : {}),
      issueStatuses: store.getDocument(documentId).verification?.lastReport?.issues?.map(issue => issue.status) }); return }
    if (url.pathname.startsWith('/fixture/') && req.method === 'POST') {
      if (url.pathname.endsWith('/offline')) dropStatus = 2
      if (url.pathname.endsWith('/reject-save')) rejectSave = true
      if (heldSaveMode && url.pathname.endsWith('/hold-next-save')) holdNextSave = true
      if (heldSaveMode && url.pathname.endsWith('/reject-held-save')) releaseHeldSave?.()
      if (quickVerifyMode && url.pathname.endsWith('/hold-next-verification')) holdNextVerification = true
      if (quickVerifyMode && url.pathname.endsWith('/release-verification')) releaseHeldVerification?.()
      if (url.pathname.endsWith('/complete')) { finishAutomatically = true; for (const stream of pending) stream.finish() }
      if (url.pathname.endsWith('/next')) pending.values().next().value?.finish()
      if (snapshotMode && url.pathname.endsWith('/advance-revision')) store.saveGraph(store.getDocument(documentId), { sourceText })
      if (reviewSaveMode && ['/fixture/change-hidden', '/fixture/change-unrelated'].includes(url.pathname)) {
        const next = store.getDocument(documentId), id = url.pathname.endsWith('/change-hidden') ? 'n801' : 'n700'
        next.nodes.find(node => node.id === id).text += ' Revised by another fixture session.'
        store.saveGraph(next, { sourceText })
      }
      json({ ok: true }); return
    }
    if (url.pathname.endsWith('/list-models')) { json({ providers: [], issueReview: true,
      current: { provider: 'fixture', model: 'controlled-model-with-long-name-for-wrapping-check' } }); return }
    if (url.pathname.endsWith('/verify-graph')) {
      stats.submissions++; finishAutomatically = false
      // Delay only response delivery: the real route must still consume the body.
      const end = res.end.bind(res)
      const hold = holdNextVerification
      holdNextVerification = false
      res.end = (...args) => {
        if (hold) releaseHeldVerification = () => { releaseHeldVerification = null; if (!res.destroyed) end(...args) }
        else setTimeout(() => { if (!res.destroyed) end(...args) }, 2000)
        return res
      }
    }
    if (snapshotMode && url.pathname.endsWith('/document-load')) {
      // Simulate an old source cached beside a valid renderer window. Exports
      // still read the real paired source from the isolated canonical store.
      const end = res.end.bind(res)
      res.end = (body, ...args) => {
        const payload = JSON.parse(body)
        if (typeof payload.sourceText === 'string') {
          payload.sourceText = payload.sourceText.replaceAll('Fixture observation', 'Cached obsolete observation')
          stats.cachedSourceResponses++
        }
        return end(JSON.stringify(payload), ...args)
      }
    }
    if (url.pathname.endsWith('/document-export')) stats.snapshotExports++
    if (url.pathname.endsWith('/question-graph')) stats.questionRequests++
    if (url.pathname.endsWith('/task-status')) {
      stats.statusCalls++
      if (dropStatus > 0) { dropStatus--; res.statusCode = 503; res.end('fixture offline'); return }
    }
    if (url.pathname.endsWith('/graph-commit')) {
      stats.commits++
      if (holdNextSave) {
        holdNextSave = false
        await new Promise(resolve => { releaseHeldSave = resolve })
        releaseHeldSave = null
        json({ error: { code: 'fixture_save_failed', message: 'Fixture held save rejected' } })
        return
      }
      if (rejectSave) { rejectSave = false; json({ error: { code: 'fixture_save_failed', message: 'Fixture report save rejected' } }); return }
    }
    if (url.pathname.startsWith('/api/')) { await routes.get('/api/dsh-knowledge-graph').handler(req, res); return }
    if (url.pathname === '/client.js') {
      const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
      const marker = '      // --------------------------- slot registration'
      if (!source.includes(marker)) throw new Error('client exposure marker not found')
      res.setHeader('content-type', 'text/javascript')
      res.end(source.replace(marker, '      window.fixtureComponents = { WorkbenchBody, TrajectoryTab };\n' + marker))
      return
    }
    const asset = { '/react.js': 'react.production.min.js', '/react-dom.js': 'react-dom.production.min.js' }[url.pathname]
    if (asset) { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(new URL('../extension/vendor/' + asset, import.meta.url))); return }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
    res.statusCode = 404; res.end()
  } catch (error) { res.statusCode = 500; res.end(String(error.stack)) }
})
server.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + server.address().port))
async function stop() {
  for (const stream of pending) stream.return()
  await ctx.fiber.dispose(); store.close(); server.closeAllConnections(); server.close()
  rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}
process.once('SIGTERM', stop); process.once('SIGINT', stop)
