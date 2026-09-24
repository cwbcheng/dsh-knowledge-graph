#!/usr/bin/env node
/**
 * The ontology over the PERSISTENT transport.
 *
 * The plugin has two transports. The dynamic sandbox path registers
 * `harness.handle` callbacks; the persistent build replaces that whole RPC
 * region with HTTP routes written in scripts/build-lib.mjs. Those routes are the
 * code path a running `dsh web` actually executes, and because they are a
 * hand-maintained parallel implementation they can silently drift from the
 * handlers they mirror.
 *
 * They did drift: the ontology plumbing landed only in src/index.host.js, so
 * every web extraction would have silently fallen back to the proposition
 * ontology no matter what the client asked for. That is a feature unreachable
 * from the only UI a user has, and nothing in the suite noticed.
 *
 * This test boots the REAL persistent plugin on a real Cordis context, captures
 * its registered routes, and drives a genuine extraction through them with a
 * stubbed model. It asserts the ontology survives the round trip, that a
 * document keeps its ontology when reopened, and that an append cannot switch
 * it.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

import * as persistentPlugin from '../lib/index.js'

const cordisModule = process.env.KG_TEST_CORDIS_MODULE || '@deepseek-ai/cordis'
const { Context, Service } = await import(cordisModule)

const ctx = new Context()
const routes = new Map()
const timers = new Set()

class TestTimer extends Service {
  constructor(context) {
    super(context, 'timer')
    context.mixin('timer', ['interval'])
  }
  interval(callback, delay) {
    return this.ctx.effect(() => {
      const id = setInterval(callback, delay)
      timers.add(id)
      return () => { clearInterval(id); timers.delete(id) }
    })
  }
}

// The model is the only external service doubled; everything else — plugin
// loading, injection, effects, the real route dispatcher, the real store — is
// the production code path.
let extractorCalls = 0
let lastExtractorSystem = ''
ctx.provide('kgExtractor', async (args) => {
  extractorCalls += 1
  // The extractor is handed a system PROMPT, not an ontology id: the prompt is
  // how the ontology reaches the model, so the stub reads it the same way a
  // real model would, and answers with a type that prompt declares.
  lastExtractorSystem = String(args.systemPrompt || '')
  // Both prompts declare a `concept` type, so the discriminator is the engine
  // the prompt introduces itself as, not the presence of any one type.
  const learningView = lastExtractorSystem.includes('学习观拆解引擎')
  return {
    summary: 'stub',
    nodes: [{ id: 'x1', type: learningView ? 'concept' : 'fact', text: '掌握', quote: '掌握', paragraph: 0 }],
    edges: [],
  }
})

function fakeRequest(method, path, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  if (body !== undefined) {
    req.setEncoding = () => {}
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
      req.emit('end')
    })
  }
  return req
}

function fakeResponse() {
  const res = { statusCode: 0, body: '', headers: {} }
  res.setHeader = (key, value) => { res.headers[key] = value }
  res.writeHead = (status) => { res.statusCode = status; return res }
  res.end = (chunk) => { if (chunk !== undefined) res.body += chunk }
  return res
}

async function call(method, path, body) {
  const route = routes.get('/api/dsh-knowledge-graph')
  assert(route, 'the persistent plugin must register its route')
  const res = fakeResponse()
  await route.handler(fakeRequest(method, path, body), res)
  let parsed = null
  try { parsed = res.body ? JSON.parse(res.body) : null } catch (error) { throw new Error('non-JSON response from ' + path + ': ' + res.body.slice(0, 200)) }
  return parsed
}

async function extract(body) {
  const started = await call('POST', '/api/dsh-knowledge-graph/extract', body)
  assert(!started.error, 'extract rejected: ' + JSON.stringify(started.error))
  assert(started.taskId, 'extract must return a taskId')
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await call('GET', '/api/dsh-knowledge-graph/task-status?taskId=' + encodeURIComponent(started.taskId))
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('extraction did not settle')
}

try {
  await ctx.plugin(TestTimer)
  ctx.provide('webServer', {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  })
  const persistent = ctx.plugin(persistentPlugin)
  await persistent.await()

  // ---- 0. the ontology catalogue crosses the persistent transport ----------
  // The UI can only offer a mode it can name, so the picker's data has to come
  // over the wire — including the counts it shows and the default flag that
  // keeps an unchanged install sending the payload it always did.
  const catalogue = await call('GET', '/api/dsh-knowledge-graph/ontology-list')
  assert(Array.isArray(catalogue.ontologies) && catalogue.ontologies.length >= 2, 'the ontology catalogue must list every ontology: ' + JSON.stringify(catalogue))
  const lvEntry = catalogue.ontologies.find((item) => item.id === 'learning-view-v1')
  assert(lvEntry && typeof lvEntry.label === 'string' && lvEntry.label, 'a catalogue entry needs a display label')
  assert.equal(lvEntry.nodeTypes, 18, 'the catalogue must report the real node-type count')
  assert.equal(lvEntry.relationTypes, 21, 'the catalogue must report the real relation-type count')
  assert.equal(lvEntry.diagnostics, 11, 'the catalogue must report the real diagnostics count')
  assert.equal(lvEntry.isDefault, false, 'learning-view must not be marked as the default')
  assert(catalogue.ontologies.some((item) => item.id === 'proposition-v1' && item.isDefault === true), 'proposition-v1 must be the marked default')

  // ---- 1. the web route honours the requested ontology ---------------------
  const lv = await extract({ title: 'transport-lv', text: '掌握一个概念需要判别材料。', ontology: 'learning-view-v1' })
  assert.equal(lv.status, 'succeeded', 'the extraction must succeed: ' + JSON.stringify(lv.error))
  assert.equal(lv.result.ontology, 'learning-view-v1', 'the web route must extract under the requested ontology')

  // The prompt is the ontology's other face: the model was told which types
  // exist, so a learning-view run must not receive the proposition prompt.
  assert(lastExtractorSystem.includes('concept 概念'), 'the model must receive the learning-view prompt')
  assert(!lastExtractorSystem.includes('fact 事实'), 'the model must not receive the proposition prompt')
  assert(!lastExtractorSystem.includes('claim 主张'), 'the model must not receive proposition-only types')

  // ---- 2. the payload carries the presentation record ----------------------
  const record = lv.result.graphOntology
  assert(record && record.id === 'learning-view-v1', 'the web payload must describe its ontology')
  assert.equal(record.nodeTypes.length, 18, 'the payload must list all 18 node types')
  assert.equal(record.relationTypes.length, 21, 'the payload must list all 21 relations')

  // ---- 2b. the diagnostics are computed, not merely declared -------------
  // The stub graph is a single bare 概念 with no material at all, which is
  // exactly 言存义空. Asserting the finding arrives over the wire is what makes
  // the diagnostic a delivered behaviour rather than a declared intention.
  assert(Array.isArray(lv.result.graphDiagnostics), 'the payload must carry diagnostics')
  const bare = lv.result.graphDiagnostics.find((finding) => finding.id === 'words_without_meaning')
  assert(bare, 'a bare 概念 must report 言存义空 over the HTTP transport: ' + JSON.stringify(lv.result.graphDiagnostics))
  assert(bare.count >= 1 && bare.targets.length >= 1, 'the finding must name what to blame')
  assert(!lv.result.graphDiagnostics.some((finding) => finding.id === 'lower_missing'),
    'a node with no 上料 cannot have lost its 下料')
  // ---- 3. the requested-ontology path is not a fallback -------------------
  // A run with no ontology must still be proposition, so the assertion above
  // cannot be passing merely because everything is learning-view.
  const prop = await extract({ title: 'transport-prop', text: '掌握一个概念需要判别材料。' })
  assert.equal(prop.status, 'succeeded')
  assert.equal(prop.result.ontology, 'proposition-v1', 'an unqualified run must stay proposition')
  assert(prop.result.graphOntology.id === 'proposition-v1', 'a proposition payload must describe proposition')
  assert.equal(prop.result.nodes[0].type, 'fact', 'a proposition run must accept proposition types')
  assert(Array.isArray(prop.result.graphDiagnostics), 'a proposition payload must carry the field too')
  assert.deepEqual(prop.result.graphDiagnostics, [], 'the proposition profile declares no diagnostics')

  // ---- 4. reopening a document restores its ontology ----------------------
  const documentId = lv.result.source.documentId
  const reopened = await call('POST', '/api/dsh-knowledge-graph/document-load', { documentId })
  assert(!reopened.error, 'document-load failed: ' + JSON.stringify(reopened.error))
  assert.equal(reopened.graph.ontology, 'learning-view-v1', 'the document must remember its ontology')
  assert(reopened.graph.graphOntology && reopened.graph.graphOntology.id === 'learning-view-v1',
    'reopening must restore the presentation record, or the client renders the wrong labels')
  const exported = await call('POST', '/api/dsh-knowledge-graph/document-export', { documentId })
  assert(exported.graph?.graphOntology?.id === reopened.graph.graphOntology.id,
    'complete graph export must preserve the work-window ontology for full-view labels')

  // A browser can edit only a small window; the Host must reject a node retype
  // that would invalidate a canonical edge even when that edge is offscreen.
  const ruleNode = { id: 'rule-transport', type: 'rule', text: '掌握一个概念需要判别材料。',
    quote: '掌握一个概念需要判别材料。', paragraph: 0 }
  const edge = { fromNodeId: 'x1', toNodeId: ruleNode.id, relation: 'has_rule',
    evidence: [{ paragraph: 0, quote: '掌握一个概念需要判别材料。' }] }
  const baseGraph = { summary: reopened.graph.summary || '',
    nodes: [...reopened.graph.nodes, ruleNode], edges: [...reopened.graph.edges, edge] }
  const seeded = await call('POST', '/api/dsh-knowledge-graph/graph-commit', {
    documentId, expectedRevision: reopened.revision, graph: baseGraph,
    baseNodeIds: reopened.graph.nodes.map(node => node.id), baseEdgeKeys: [],
  })
  assert(!seeded.error, 'valid graph fixture failed to commit: ' + JSON.stringify(seeded.error))
  const invalidGraph = { summary: seeded.graph.summary || '',
    nodes: [{ ...seeded.graph.nodes.find(node => node.id === ruleNode.id), type: 'data_or_experience' }],
    edges: [] }
  const invalid = await call('POST', '/api/dsh-knowledge-graph/graph-commit', {
    documentId, expectedRevision: seeded.revision, graph: invalidGraph,
    baseNodeIds: [ruleNode.id], baseEdgeKeys: [],
  })
  assert.equal(invalid.error?.code, 'ontology_relation_conflict',
    'canonical commit must reject a retype that invalidates an offscreen edge')
  const afterRejection = await call('POST', '/api/dsh-knowledge-graph/document-load', { documentId })
  assert.equal(afterRejection.revision, seeded.revision, 'rejected commit must not advance revision')
  assert.equal(afterRejection.graph.nodes.find(node => node.id === ruleNode.id)?.type, 'rule',
    'rejected commit must preserve the previous canonical node')

  // ---- 5. an append cannot switch the ontology -----------------------------
  const conflict = await call('POST', '/api/dsh-knowledge-graph/append-extract', {
    documentId,
    title: 'transport-lv',
    text: '再追加一段材料。',
    ontology: 'proposition-v1',
  })
  assert.equal(conflict.error && conflict.error.code, 'ontology_conflict',
    'the web append route must refuse to switch ontology: ' + JSON.stringify(conflict))

  // An append that does NOT ask for a different ontology must inherit.
  const inherited = await call('POST', '/api/dsh-knowledge-graph/append-extract', {
    documentId,
    title: 'transport-lv',
    text: '再追加一段材料。',
  })
  assert(inherited.taskId, 'a conforming append must be accepted: ' + JSON.stringify(inherited))

  await persistent.dispose()
  assert.equal(routes.size, 0, 'disposal must release the routes')

  console.log(JSON.stringify({
    ok: true,
    transport: 'persistent-http',
    extractorCalls,
    learningViewExtraction: lv.result.ontology,
    propositionStaysDefault: prop.result.ontology,
    reopenRestoresOntology: reopened.graph.graphOntology.id,
    appendOntologyConflict: true,
    appendInheritsOntology: true,
    diagnosticsOverWire: bare.id,
    canonicalOntologyGuard: true,
  }))
} finally {
  await ctx.fiber.dispose()
}
