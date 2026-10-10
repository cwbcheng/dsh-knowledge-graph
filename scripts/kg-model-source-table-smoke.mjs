import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelSourceTableFixture } from './kg-model-source-table-fixture-data.mjs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const component = value => value.slice(value.indexOf('      function ConnectionSourceUnits('), value.indexOf('      function ConnectionModelComparison('))
for (const file of ['../lib/client.js', '../extension/viewer.js']) assert.equal(component(client), component(readFileSync(new URL(file, import.meta.url), 'utf8')))
const parser = client.slice(client.indexOf('      function sourceSpanIndexAtOffset('), client.indexOf('      // Build the view model:'))
let parses = 0
const DOMParser = class {
  // Minimal DOM adapter; the delivery browser also exercises Chromium's parser.
  parseFromString(html, type) {
    assert.equal(type, 'text/html'); parses++
    const text = html => html.replace(/<[^>]*>/g, '').trim()
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(row => ({
      cells: [...row[1].matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g)].map(cell => ({
        textContent: text(cell[2]), colSpan: Number(/colspan="(\d+)"/.exec(cell[1])?.[1] || 1), rowSpan: 1,
      })),
    }))
    return { querySelector: () => ({ rows, caption: { textContent: text(/<caption>([\s\S]*?)<\/caption>/.exec(html)?.[1] || '') } }) }
  }
}
const environment = { DOMParser, NL: '\n', React: { Fragment: 'fragment' },
  h: (type, props, ...children) => ({ type, props: { ...props, children } }) }
runInNewContext(parser + component(client) + '\nthis.Source=ConnectionSourceUnits', environment)
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')
const contract = createGraphContract(), references = []
const render = units => environment.Source({ units, documentId: 'connection-fixture', revision: 1, onLocate: reference => references.push({ ...reference }) })
const detail = fixture => contract.connectionModels(fixture, { expectedRevision: 1, modelId: 'taxi' })
const assertTable = (units, expected) => {
  const tree = render(units), tables = all(tree, node => node.type === 'table'), buttons = all(tree, node => node.type === 'button')
  assert.equal(tables.length, expected ? 1 : 0)
  assert.deepEqual(buttons.map(button => text(button)), units.map(unit => 'P' + (unit.paragraph + 1)), 'Every contributing stored identity remains directly addressable')
  references.length = 0
  for (const button of buttons) button.props.onClick()
  assert.deepEqual(references, units.map(unit => ({ documentId: 'connection-fixture', revision: 1, paragraph: unit.paragraph,
    quote: unit.text.slice(0, 2000), sourceQuoteOnly: true })), 'Source location binds the stored identity, exact quote and current snapshot')
  if (expected) {
    assert.equal(text(all(tables, node => node.type === 'caption')[0]), '仅限白天、无附加收费；表中映射未作独立验证。')
    assert(text(tree).includes('计价原文：仅对本次行程说明。'))
    assert(text(tree).includes('夜间加价不在此模型范围内，不能直接套用。'))
    assert(text(tables).includes('不保证必然成立') && text(tables).includes('10 元 + 超出部分 × 2 元/km'))
    assert.equal(all(tables, node => node.type === 'td' && node.props.colSpan === 2).length, 1)
  }
  assert.equal(all(tree, node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML') || ['script', 'img', 'iframe'].includes(node.type)).length, 0)
  return tree
}

for (const dense of [false, true]) {
  const fixture = modelSourceTableFixture({ dense }), before = JSON.stringify(fixture), result = detail(fixture)
  assert(!result.error, JSON.stringify(result.error))
  assert.deepEqual(result.sourceUnits.map(unit => unit.sourcePosition), [0, 1, 2, 3])
  assertTable(result.sourceUnits, true)
  const reversed = structuredClone(fixture); reversed.sourceUnits.reverse()
  assert.deepEqual(detail(reversed), result, 'Source order matches the canonical paragraph sort, not input enumeration')
  const picker = contract.connectionModels(fixture, { expectedRevision: 1, modelId: 'taxi', structureSources: true, sourceOffset: 2 })
  assert.deepEqual(picker.sourceUnits.items.map(unit => unit.sourcePosition), [2, 3], 'Pagination retains absolute source positions')
  assert.deepEqual(picker.sourceUnits.items.map(unit => ({ paragraph: unit.paragraph, text: unit.text })), fixture.sourceUnits.slice(2, 4))
  assertTable(result.sourceUnits.map(({ sourcePosition, ...unit }) => unit), dense)
  for (const bad of [undefined, null, -1, 1.5, '2']) {
    const mixed = structuredClone(result.sourceUnits); mixed[2].sourcePosition = bad
    assertTable(mixed, false)
  }
  assert.equal(JSON.stringify(fixture), before)
  const gap = detail(modelSourceTableFixture({ dense, gap: true }))
  assert.deepEqual(gap.sourceUnits.map(unit => unit.sourcePosition), [0, 1, 2, 3, 6, 7, 8, 9])
  const count = parses; assertTable(gap.sourceUnits, false)
  assert.equal(parses, count, 'Filtered-out restrictions must prevent parsing a seemingly complete joined table')
}
assert.deepEqual(Array.from(render([])), [])

const reading = { window: { React: { createElement: environment.h } }, documentIdOfGraph: graph => graph?.source?.documentId }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), reading)
const quoteHelper = client.slice(client.indexOf('function exactSourceQuoteTarget('), client.indexOf('function KnowledgeConsumePanel('))
runInNewContext(quoteHelper + '\nthis.target=exactSourceQuoteTarget', reading)
const sourceFixture = modelSourceTableFixture(), view = reading.window.KGViewer.makeView({ ...sourceFixture.graph, revision: 1 }, sourceFixture.sourceText)
assertTable(detail(sourceFixture).sourceUnits, true)
for (const reference of references) {
  const target = reading.target(view, reference), start = view.sourceText.indexOf(reference.quote)
  assert(view.paragraphs[target.first].start <= start && view.paragraphs[target.last].end >= start + reference.quote.length)
  if (reference.paragraph > 0) assert.notEqual(target.first, reference.paragraph, 'Stored identity is not a re-parsed reading paragraph index')
  assert.throws(() => reading.target(view, { ...reference, revision: 2 }), /版本/)
  assert.throws(() => reading.target(view, { ...reference, documentId: 'other-document' }), /版本/)
}
const reference = references[0]
assert.throws(() => reading.target({ ...view, sourceText: view.sourceText + '\n\n' + reference.quote }, reference), /多个相同片段/)
const long = [{ paragraph: 55, sourcePosition: 0, text: '长段限定语：' + '仅限原文条件。'.repeat(350) }]
assertTable(long, false)
assert.equal(references[0].quote.length, 2000, 'Bounded navigation quotes do not truncate displayed source')
assert(text(render(long)).includes(long[0].text))

let modelCalls = 0, httpRequests = 0
const fixture = modelSourceTableFixture(), harness = await modelLearningHarness({ fixture,
  llm: { async createMessage() { modelCalls++; throw new Error('No model calls') } } })
const server = createServer((req, res) => harness.handler(req, res))
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), sourceBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  for (const args of [{}, { structureEdit: true }, { structureSources: true, sourceOffset: 2 }]) {
    httpRequests++
    const options = { documentId: fixture.documentId, expectedRevision: 1, modelId: 'taxi', ...args }
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.deepEqual(result, contract.connectionModels(fixture, options), 'Real SQLite HTTP snapshot and dynamic host agree')
    if (!args.structureSources) assertTable(result.sourceUnits, true)
  }
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), sourceBefore, 'Display metadata is never persisted into source units')
  assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(modelCalls, 0)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
console.log(JSON.stringify({ ok: true, sparseAndDenseTables: true, allParagraphLocations: true, captionAndQualifiers: true, actualReadingTargets: true,
  omittedContextNeverJoined: true, legacyAndMixedMetadata: true, generatedParity: true, httpRequests, readOnly: true, modelCalls }))
