#!/usr/bin/env node
/**
 * Validate the 《学习观》 ontology against the real book, with a real model.
 *
 * Everything else in the ontology suite proves the ENGINE is correct: that the
 * profile validates, that the prompt declares the right types, that the client
 * renders them, that the persistent transport carries them, that the
 * diagnostics fire. None of it answers the only question that can invalidate the
 * design — when a model reads the actual book, does this ontology come out?
 *
 * This drives that: it takes a paragraph window out of the stored 《学习观》
 * document, posts it to the RUNNING plugin's own HTTP route (so the prompt, the
 * ontology resolution and the validation are the production ones), waits for the
 * run, and reports what came back.
 *
 * What it is looking for, and why:
 *
 *   - types used / declared. An ontology that declares 18 node types and gets 4
 *     back is over-specified, and the unused ones are the evidence.
 *   - relations used / declared, same reading.
 *   - diagnostics that fired. A graph the book would call collapsed SHOULD fire
 *     them; an empty list on rich material means the rules are dead code.
 *   - nodes with no source anchor. The ontology's whole claim is that material
 *     cannot be invented; an unanchored node is 言存义空 committed by the model.
 *
 * Requires the plugin to be running the current build: the route only honours
 * `ontology` after the round that single-sourced it across both transports.
 * It reads source text from SQLite READ-ONLY and never writes to the store.
 *
 * Usage:
 *   node scripts/kg-ontology-book-validate.mjs                 # default window
 *   node scripts/kg-ontology-book-validate.mjs --from 4437 --to 4680
 *   node scripts/kg-ontology-book-validate.mjs --model zhipu:glm-4.6v-flash
 *   node scripts/kg-ontology-book-validate.mjs --dry-run       # show the window, call nothing
 *
 * Output (which contains book text) goes to scripts/tmp/, which is gitignored.
 */

import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const SERVER = process.env.KG_SERVER || 'http://127.0.0.1:3080'
const ROUTE = SERVER + '/api/dsh-knowledge-graph'
const STORE = process.env.KG_STORE || (homedir() + '/.dsh-knowledge-graph.sqlite')
const BOOK = process.env.KG_BOOK_DOCUMENT || 'document-989d55fc-2a05-4350-a807-2002f6e77a17'
const OUT_DIR = new URL('./tmp/', import.meta.url)

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}
const has = (name) => process.argv.includes('--' + name)

// The default window is 第 34 章's material taxonomy, and it is deliberate that it
// spans BOTH coordinate branches rather than one:
//
//   4437 验证材料 · 4476 例习互转 · 4523 内涵描述 · 4629 正例/负例 · 4857 联结材料
//   4868 因素材料 · 4906 关系材料 · 4997 关系类型
//
// That is the densest stretch of the book for this ontology, so a single run
// exercises 判别材料 and 联结材料, 上料 and 下料, and both model kinds. A window
// covering only one branch would let an ontology that cannot tell them apart
// still look complete.
const from = Number(arg('from', '4437'))
const to = Number(arg('to', '4997'))
const modelArg = arg('model', '')

async function call(path, body, method = 'POST') {
  const response = await fetch(ROUTE + '/' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  })
  const text = await response.text()
  try { return JSON.parse(text) } catch (error) { throw new Error(path + ' returned non-JSON (' + response.status + '): ' + text.slice(0, 300)) }
}

// ---- read the window, read-only ------------------------------------------
const db = new DatabaseSync(STORE, { readOnly: true })
let document
try {
  document = db.prepare('SELECT title, chars, paragraph_count AS paragraphs, graph_meta_json AS meta FROM documents WHERE document_id = ?').get(BOOK)
  if (!document) throw new Error('book document not found: ' + BOOK)
  const units = db.prepare('SELECT paragraph, text FROM document_units WHERE document_id = ? AND paragraph >= ? AND paragraph < ? ORDER BY paragraph').all(BOOK, from, to)
  if (units.length === 0) throw new Error('no source units in [' + from + ',' + to + ')')
  var window = units
} finally {
  db.close()
}

const excerpt = window.map((unit) => unit.text).join('\n')
console.log('book:', String(document.title).slice(0, 60))
console.log('window: paragraphs [' + from + ',' + to + ') · ' + window.length + ' units · ' + excerpt.length + ' chars')
if (has('dry-run')) {
  console.log('first unit:', window[0].text.slice(0, 120).replace(/\n/g, ' '))
  console.log('last unit:', window[window.length - 1].text.slice(0, 120).replace(/\n/g, ' '))
  process.exit(0)
}

// ---- refuse to grade a server that predates the ontology plumbing ---------
const probe = await call('document-load', { documentId: BOOK, nodeLimit: 1, includeSourceText: false })
if (probe && probe.graph && !('graphOntology' in probe.graph)) {
  console.error('')
  console.error('The running server is an OLD build: its routes do not carry the ontology.')
  console.error('Restart `dsh web` so lib/index.js is reloaded, then run this again.')
  process.exit(2)
}

// ---- run a real extraction ------------------------------------------------
const model = modelArg && modelArg.includes(':')
  ? { provider: modelArg.slice(0, modelArg.indexOf(':')), model: modelArg.slice(modelArg.indexOf(':') + 1) }
  : null
const started = await call('extract', {
  title: 'LV 验证 · ' + String(document.title).slice(0, 40) + ' [' + from + ',' + to + ')',
  text: excerpt,
  ontology: 'learning-view-v1',
  ...(model ? { model } : {}),
})
if (started.error) {
  console.error('extract rejected:', JSON.stringify(started.error))
  process.exit(1)
}
console.log('task:', started.taskId, '— running (this is a real model call; be patient)')

let status = null
const began = Date.now()
for (let attempt = 0; attempt < 3600; attempt += 1) {
  status = await call('task-status?taskId=' + encodeURIComponent(started.taskId), null, 'GET')
  if (status.status !== 'running') break
  if (attempt % 20 === 0) process.stdout.write('.')
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
console.log('')
if (!status || status.status === 'running') {
  console.error('timed out after ' + Math.round((Date.now() - began) / 1000) + 's; the run continues server-side')
  process.exit(1)
}
if (status.status !== 'succeeded') {
  console.error('run ' + status.status + ':', JSON.stringify(status.error))
  process.exit(1)
}

// ---- grade what came back -------------------------------------------------
const result = status.result || {}
const nodes = Array.isArray(result.nodes) ? result.nodes : []
const edges = Array.isArray(result.edges) ? result.edges : []
const record = result.graphOntology || { nodeTypes: [], relationTypes: [] }
const findings = Array.isArray(result.graphDiagnostics) ? result.graphDiagnostics : []

assertOntology(result.ontology === 'learning-view-v1', 'the run must come back as learning-view-v1, got ' + result.ontology)

const declaredTypes = record.nodeTypes.map((type) => type.id)
const declaredRelations = record.relationTypes.map((relation) => relation.id)
const usedTypes = tally(nodes.map((node) => node && node.type))
const usedRelations = tally(edges.map((edge) => edge && edge.relation))
const unanchored = nodes.filter((node) => !node || typeof node.paragraph !== 'number' || node.paragraph < 0)
const outOfRange = unanchored.length === 0 ? [] : nodes.filter((node) => typeof node.paragraph === 'number' && (node.paragraph < 0 || node.paragraph >= window.length))
const undeclaredTypes = Object.keys(usedTypes).filter((type) => !declaredTypes.includes(type))
const undeclaredRelations = Object.keys(usedRelations).filter((relation) => !declaredRelations.includes(relation))

function tally(values) {
  const out = {}
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue
    out[value] = (out[value] || 0) + 1
  }
  return out
}
function assertOntology(condition, message) {
  if (!condition) { console.error('GRADE FAILED: ' + message); process.exit(1) }
}

// The knowledge/material split comes from the payload's own `kind` field. It is
// NOT `layer !== 'lower'`: upper materials such as intension_description are
// also `layer: upper`, so that test would count every 上料 as knowledge.
const typeById = new Map(record.nodeTypes.map((type) => [type.id, type]))
const isKnowledge = (id) => { const type = typeById.get(id); return !!type && type.kind === 'knowledge' }
const knowledgeTypeIds = declaredTypes.filter(isKnowledge)
const report = {
  window: { from, to, units: window.length, chars: excerpt.length },
  elapsedSeconds: Math.round((Date.now() - began) / 1000),
  ontology: result.ontology,
  counts: { nodes: nodes.length, edges: edges.length, warnings: (result.warnings || []).length },
  typeCoverage: { declared: declaredTypes.length, used: Object.keys(usedTypes).length, unused: declaredTypes.filter((id) => !usedTypes[id]) },
  relationCoverage: { declared: declaredRelations.length, used: Object.keys(usedRelations).length, unused: declaredRelations.filter((id) => !usedRelations[id]) },
  usedTypes,
  usedRelations,
  undeclaredTypes,
  undeclaredRelations,
  unanchoredNodes: unanchored.length,
  outOfRangeNodes: outOfRange.length,
  diagnostics: findings.map((finding) => ({ id: finding.id, zh: finding.zh, count: finding.count })),
  knowledgeNodes: nodes.filter((node) => isKnowledge(node && node.type)).length,
  materialNodes: nodes.filter((node) => { const type = typeById.get(node && node.type); return !!type && type.kind === 'material' }).length,
  knowledgeTypes: { declared: knowledgeTypeIds.length, used: knowledgeTypeIds.filter((id) => usedTypes[id]).length, unused: knowledgeTypeIds.filter((id) => !usedTypes[id]) },
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const jsonPath = new URL('lv-book-' + stamp + '.json', OUT_DIR)
writeFileSync(jsonPath, JSON.stringify({ ...report, graph: { nodes, edges } }, null, 2))

console.log('')
console.log('elapsed        ', report.elapsedSeconds + 's')
console.log('nodes / edges  ', nodes.length + ' / ' + edges.length)
console.log('node types     ', report.typeCoverage.used + '/' + report.typeCoverage.declared + ' used')
if (report.typeCoverage.unused.length) console.log('  unused       ', report.typeCoverage.unused.join(' '))
console.log('relations      ', report.relationCoverage.used + '/' + report.relationCoverage.declared + ' used')
if (report.relationCoverage.unused.length) console.log('  unused       ', report.relationCoverage.unused.join(' '))
console.log('diagnostics    ', findings.length ? findings.map((f) => f.id + '(' + f.count + ')').join(' ') : '(none fired)')
console.log('knowledge/mat. ', report.knowledgeNodes + ' / ' + report.materialNodes)
console.log('unanchored     ', unanchored.length)
if (undeclaredTypes.length) console.log('UNDECLARED TYPES', undeclaredTypes.join(' '))
if (undeclaredRelations.length) console.log('UNDECLARED RELS ', undeclaredRelations.join(' '))
console.log('')
console.log('wrote', jsonPath.pathname)
console.log('')
console.log('Read it as: every undeclared type is an ontology bug, every unanchored node is')
console.log('invented material, a large unused-type list means the profile over-declares,')
console.log('and a rich excerpt with no diagnostics means the rules are dead code.')
