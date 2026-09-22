#!/usr/bin/env node
/**
 * End-to-end ontology selection.
 *
 * Proves the ontology is a property of the DOCUMENT that actually reaches the
 * model and the stored graph, not just a table the host looks up:
 *   - a learning-view-v1 extraction sends the learning-view prompt
 *   - its result is stamped with that ontology all the way to the canonical doc
 *   - a re-extraction inherits it instead of silently reverting to proposition
 *   - two documents with different ontologies do not cross-talk
 *
 * The last point is the reason ontology lookups resolve from a carrier
 * (`ontIdOf`) instead of a module-level "current ontology" value.
 */

import assert from 'node:assert/strict'

import hostPlugin from '../src/index.host.js'
import { getOntology } from '../src/kg-ontology.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'

const handlers = new Map()
const calls = []

// A model that returns whatever types the prompt declared: it echoes the first
// node type it was offered, which lets the test read the ontology back out of
// the model's input rather than trusting host-side state.
const extractor = async ({ title, systemPrompt, chunk }) => {
  calls.push({ title, systemPrompt })
  if (title === 'lv-append') {
    const unit = chunk.units.find((item) => item.text.includes('可迁移性'))
    return {
      summary: '追加学习观材料',
      nodes: [{ id: 'new-feature', type: 'feature_description', text: unit.text, quote: unit.text, paragraph: unit.num, stage: 'processed', hidden: 'not-declared' }],
      edges: [],
    }
  }
  if (title === 'lv') {
    return {
      summary: '学习观材料',
      nodes: [
        { id: 'n1', type: 'positive_example', text: '背单词表能通过考试', quote: '背单词表能通过考试', paragraph: 0, stage: 'data' },
        { id: 'n2', type: 'intension_description', text: '掌握指能推测未见情况', quote: '掌握指能推测未见情况', paragraph: 1, relKind: 'basic' },
      ],
      edges: [
        { fromNodeId: 'n1', toNodeId: 'n2', relation: 'exemplifies', role: 'input', mode: 'contrast', hidden: 'must-not-survive', evidence: [{ paragraph: 0, quote: '背单词表能通过考试' }] },
      ],
    }
  }
  if (title === 'prop') {
    return {
      summary: '命题材料',
      nodes: [{ id: 'p1', type: 'claim', text: '温度升高导致气压变化', quote: '温度升高导致气压变化', paragraph: 0 }],
      edges: [],
    }
  }
  // A model that answers the learning-view prompt with a proposition type: the
  // validator must drop it rather than let a foreign type into the graph.
  if (title === 'lv-foreign') {
    return {
      summary: '越界类型',
      nodes: [
        { id: 'f1', type: 'fact', text: '这是一条事实', quote: '这是一条事实', paragraph: 0 },
        { id: 'f2', type: 'concept', text: '概念甲', quote: '概念甲', paragraph: 0 },
      ],
      edges: [],
    }
  }
  return { summary: '', nodes: [], edges: [] }
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? extractor : null },
  interval() { return () => {} },
})

async function waitTask(taskId) {
  for (let i = 0; i < 400; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const lvProfile = getOntology('learning-view-v1')

// ---- 1. an explicit learning-view extraction -------------------------------
const lvStart = await handlers.get('extract')({ title: 'lv', text: '背单词表能通过考试。掌握指能推测未见情况。', ontology: 'learning-view-v1' })
assert(lvStart.taskId, 'extraction did not start: ' + JSON.stringify(lvStart))
const lv = await waitTask(lvStart.taskId)
assert.equal(lv.status, 'succeeded', 'learning-view extraction failed: ' + JSON.stringify(lv.error || {}))

const lvCall = calls.find((call) => call.title === 'lv')
assert(lvCall.systemPrompt.includes('学习观拆解引擎'), 'the learning-view prompt was not used')
for (const typeId of lvProfile.nodeTypes.map((type) => type.id)) {
  assert(lvCall.systemPrompt.includes(typeId + ' ' + lvProfile.nodeTypes.find((type) => type.id === typeId).zh),
    'the learning-view prompt must declare ' + typeId)
}

const lvTypes = lv.result.nodes.map((node) => node.type).sort()
assert.deepEqual(lvTypes, ['intension_description', 'positive_example'], 'learning-view node types did not survive normalization: ' + JSON.stringify(lvTypes))
assert(lv.result.edges.some((edge) => edge.relation === 'exemplifies'), 'the learning-view relation did not survive normalization')

// The ontology defines several relations THROUGH an attribute (`maps_between`
// role input/output, `contrasts` role positive/negative, `compares_*` mode
// contrast/analogy). Those attributes must survive normalization, or the model's
// compliance is invisible and the relations lose the half of their meaning that
// is not in the type name — while anything the ontology did NOT declare is still
// refused rather than copied through.
const attrEdge = lv.result.edges.find((edge) => edge.relation === 'exemplifies')
assert.equal(attrEdge.role, 'input', 'a declared edge attribute must survive normalization')
assert.equal(attrEdge.mode, 'contrast', 'every declared edge attribute must survive, not just the first')
assert(!Object.hasOwn(attrEdge, 'hidden'), 'an undeclared edge attribute must not be copied into the graph')
assert.equal(lv.result.nodes.find((node) => node.id === 'n1').stage, 'data', 'a declared node attribute must survive normalization')
assert.equal(lv.result.nodes.find((node) => node.id === 'n2').relKind, 'basic', 'every declared node attribute must survive')
assert(!Object.hasOwn(lv.result.nodes.find((node) => node.id === 'n1'), 'hidden'), 'undeclared node attributes must not be copied')
assert.equal(lv.result.ontology, 'learning-view-v1', 'the result graph must record its ontology')

// The rendered graph payload must carry the ontology's presentation face, so
// the client can label and colour learning-view nodes without a client build.
const record = lv.result.graphOntology
assert(record && record.id === 'learning-view-v1', 'the view payload must describe its ontology')
assert.equal(record.nodeTypes.length, lvProfile.nodeTypes.length, 'the payload must list every node type')
assert.equal(record.relationTypes.length, lvProfile.relationTypes.length, 'the payload must list every relation type')
assert.equal(record.diagnostics.length, lvProfile.diagnostics.length, 'the payload must list every diagnostic')
for (const type of record.nodeTypes) {
  assert(typeof type.color === 'string' && type.color.startsWith('#'), 'node type needs a colour: ' + type.id)
  assert(typeof type.fill === 'string' && type.fill, 'node type needs a fill: ' + type.id)
  assert(['upper', 'lower', 'none'].includes(type.layer), 'node type needs a layer: ' + type.id)
  assert(['discrimination', 'connection', 'none'].includes(type.modelKind), 'node type needs a modelKind: ' + type.id)
}
// ---- 2. the stored document keeps it ---------------------------------------
const stored = handlers.get('document-load')
if (stored) {
  const loaded = await stored({ documentId: lv.result.source.documentId })
  assert.equal(loaded.graph.ontology, 'learning-view-v1', 'the canonical document must remember its ontology')
}

// ---- 3. a proposition extraction is unaffected -----------------------------
const propStart = await handlers.get('extract')({ title: 'prop', text: '温度升高导致气压变化。' })
const prop = await waitTask(propStart.taskId)
assert.equal(prop.status, 'succeeded', 'proposition extraction failed')
const propCall = calls.find((call) => call.title === 'prop')
assert(propCall.systemPrompt.includes('fact 事实'), 'the default extraction must still use the proposition prompt')
assert(!propCall.systemPrompt.includes('学习观拆解引擎'), 'the default extraction must not use the learning-view prompt')
assert.equal(prop.result.nodes[0].type, 'claim', 'proposition extraction changed')
assert(lv.result.nodes[0].type !== prop.result.nodes[0].type, 'the two ontologies must produce different graphs')

// A proposition payload keeps describing proposition, so existing clients keep
// rendering exactly as before.
const propRecord = prop.result.graphOntology
assert(propRecord && propRecord.id === 'proposition-v1', 'a proposition graph must describe proposition-v1')

// ---- 4. a foreign type is rejected, not smuggled in ------------------------
const foreignStart = await handlers.get('extract')({ title: 'lv-foreign', text: '这是一条事实。概念甲。', ontology: 'learning-view-v1' })
const foreign = await waitTask(foreignStart.taskId)
const smuggled = (foreign.result?.nodes || []).filter((node) => node.type === 'fact')
assert.deepEqual(smuggled, [], 'a proposition-only type must not enter a learning-view graph')

// ---- 5. an unknown ontology resolves to the default ------------------------
const fallbackStart = await handlers.get('extract')({ title: 'prop', text: '温度升高导致气压变化。', ontology: 'not-a-real-ontology' })
const fallback = await waitTask(fallbackStart.taskId)
assert.equal(fallback.result.ontology, 'proposition-v1', 'an unknown ontology id must fall back to the default')

// ---- 6. the ontology round-trips through the store ------------------------
// It is persisted in `graph_meta_json` rather than a new column, so a re-opened
// document keeps its profile without a schema migration.
const db = await openSqliteStore(':memory:')
const docId = 'ontology-roundtrip'
const srcId = 'source-ontology-roundtrip'
const chunkId = 'chunk-ontology-roundtrip'
db.saveGraph({
  summary: 'roundtrip',
  ontology: 'learning-view-v1',
  source: { id: srcId, documentId: docId, title: 'roundtrip', chars: 4, paragraphCount: 1, chunkCount: 1, sectionCount: 1, sections: [{ id: 's1', title: '全文', startParagraph: 0, endParagraph: 0, summary: '' }] },
  staging: { sourceId: srcId, documentId: docId, chunkCount: 1, chunks: [{ chunkId, sourceId: srcId, startParagraph: 0, endParagraph: 0, sectionIds: ['s1'], sectionTitles: ['全文'], summary: '', nodeIds: ['r1'], edgeCount: 0, warnings: [] }] },
  nodes: [{ id: 'r1', type: 'concept', text: '掌握', quote: '掌握', paragraph: 0, evidence: [{ documentId: docId, sourceId: srcId, chunkId, paragraph: 0, quote: '掌握' }], groundingStatus: 'grounded', entailmentStatus: 'unverified', documentId: docId, sourceId: srcId, chunkId }],
  edges: [],
}, { sourceText: '掌握' })
const reopened = db.getDocument(docId)
assert.equal(reopened.ontology, 'learning-view-v1', 'the ontology must survive a store round-trip')
db.close()

// ---- 7. an append cannot switch the document's ontology -------------------
const conflict = await handlers.get('append-extract')({
  documentId: lv.result.source.documentId,
  title: 'lv',
  text: '追加一段材料。',
  ontology: 'proposition-v1',
})
assert.equal(conflict.error && conflict.error.code, 'ontology_conflict', 'an append must refuse to change ontology: ' + JSON.stringify(conflict))

// Appending must keep both the prompt vocabulary and the original semantic
// attributes. A valid new batch must not erase meaning from the existing graph.
const appended = await waitTask((await handlers.get('append-extract')({
  documentId: lv.result.source.documentId, title: 'lv-append', text: '可迁移性是掌握的特征。',
})).taskId)
assert.equal(appended.status, 'succeeded', JSON.stringify(appended.error))
const appendPrompt = calls.find((call) => call.title === 'lv-append').systemPrompt
assert(appendPrompt.includes('学习观拆解引擎'), 'append must use the document ontology, not the hard-coded proposition prompt')
assert(appendPrompt.includes('已有') && appendPrompt.includes('新正文'), 'append must retain its incremental constraints')
assert(!appendPrompt.includes('type 只能取 fact/claim'), 'append must not give conflicting ontology instructions')
assert.equal(appended.result.nodes.find((node) => node.id === 'n1').stage, 'data')
assert.equal(appended.result.nodes.find((node) => node.id === 'n2').relKind, 'basic')
const appendedEdge = appended.result.edges.find((edge) => edge.fromNodeId === 'n1' && edge.toNodeId === 'n2')
assert.equal(appendedEdge.role, 'input')
assert.equal(appendedEdge.mode, 'contrast')
const newFeature = appended.result.nodes.find((node) => node.id === 'new-feature')
assert.equal(newFeature.stage, 'processed')
assert(!Object.hasOwn(newFeature, 'hidden'), 'append must not bypass the attribute allowlist')
assert(newFeature.paragraph > Math.max(...lv.result.nodes.map((node) => node.paragraph)), 'appended source anchors must be offset into the canonical document')

console.log(JSON.stringify({
  ok: true,
  learningViewNodes: lvTypes,
  learningViewOntology: lv.result.ontology,
  propositionOntology: prop.result.ontology,
  foreignTypeRejected: true,
  unknownOntologyFallsBack: true,
  payloadOntology: record.id,
  storeRoundTrip: reopened.ontology,
  appendOntologyConflict: true,
  appendOntologyAndAttributes: true,
}))
