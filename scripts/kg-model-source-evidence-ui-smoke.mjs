import assert from 'node:assert/strict'
import { modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelSourceEvidenceFixture } from './kg-model-source-evidence-fixture-data.mjs'

const fixture = modelSourceEvidenceFixture()
let modelCalls = 0, actualHttpRequests = 0
const harness = await modelLearningHarness({ fixture, llm: { async createMessage() { modelCalls++; throw new Error('No model calls') } } })
const server = createServer((req, res) => harness.handler(req, res))
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  const post = async (body, method = 'connection-models') => {
    actualHttpRequests++
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 200); return response.json()
  }
  const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const arrow = value => value.match(/^\.kg-model-arrow \{[^\n]+\}/m)?.[0]
  assert(arrow(source)?.includes('width: 20px; height: 27px;') && arrow(source).includes('pointer-events: none;'), 'A rotated full-width decorative row must not cover source controls')
  assert.equal(arrow(source), arrow(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')))
  assert.equal(arrow(source), arrow(readFileSync(new URL('../extension/viewer.css', import.meta.url), 'utf8')))
  const extract = value => value.slice(value.indexOf('const MODEL_PROVENANCE_LABELS ='), value.indexOf('function modelGapText('))
  for (const file of ['../lib/client.js', '../extension/viewer.js']) assert.equal(extract(source), extract(readFileSync(new URL(file, import.meta.url), 'utf8')), file)
  const environment = { h: (type, props, ...children) => ({ type, props: { ...props, children } }), React: { Fragment: 'fragment' } }
  runInNewContext(extract(source) + '\nthis.Evidence=ModelStructureEvidence;this.Pairs=ModelPairedExamples', environment)
  const quoteEnvironment = { documentIdOfGraph: graph => graph?.source?.documentId }
  const quoteHelper = source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel('))
  runInNewContext(quoteHelper + '\nthis.target=exactSourceQuoteTarget', quoteEnvironment)
  const parts = fixture.sourceText.split('\n\n'), paragraphs = []
  let start = 0
  for (const part of parts) { paragraphs.push({ start, end: start + part.length }); start += part.length + 2 }
  const view = { graph: harness.store.getDocument(fixture.documentId), sourceText: fixture.sourceText, paragraphs }
  const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
    : [...(test(node) ? [node] : []), ...all(node.props.children, test)]
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')
  const located = [], props = { documentId: fixture.documentId, revision: 1, onLocate: reference => located.push(reference) }
  const details = new Map()
  let sourceActions = 0, rejectedOrigins = 0
  for (const kind of ['fields', 'user', 'ai', 'unknown', 'duplicate', 'conflict']) {
    const detail = await post({ documentId: fixture.documentId, expectedRevision: 1, modelId: 'source-' + kind })
    assert(!detail.error, JSON.stringify(detail.error)); details.set(kind, detail)
    const structure = detail.structure
    assert(structure && detail.documentId === fixture.documentId && detail.revision === 1)
    const citations = [...structure.slots.map(slot => slot.provenance), ...['condition', 'mapping', 'boundary'].map(key => structure.branches[0][key].provenance),
      structure.examples[0].provenance]
    assert.equal(citations.length, 6)
    for (const value of citations) {
      const tree = environment.Evidence({ ...props, value }), buttons = all(tree, node => node.type === 'button')
      assert(text(tree).includes(value.quote) && text(tree).includes(value.note), 'Full quotes and qualifiers stay readable for every declared origin')
      assert.equal(buttons.length, value.kind === 'source' ? 1 : 0, 'User, AI and unknown origins are not source-location actions')
      if (!buttons.length) { rejectedOrigins++; continue }
      assert(!buttons[0].props.disabled)
      buttons[0].props.onClick(); const reference = located.at(-1)
      assert.equal(reference.documentId, fixture.documentId); assert.equal(reference.revision, 1)
      assert.equal(reference.paragraph, value.paragraph); assert.equal(reference.quote, value.quote)
      assert.equal(reference.sourceQuoteOnly, true); assert.equal(reference.nodeId, undefined, 'Do not constrain field evidence to the model node or chapter')
      if (value.quote.startsWith('FIELD DUPLICATE:')) assert.throws(() => quoteEnvironment.target(view, reference), /多个相同片段/)
      else {
        const target = quoteEnvironment.target(view, reference)
        assert.equal(view.sourceText.slice(paragraphs[target.first].start).startsWith(reference.quote), true)
        assert(paragraphs[target.last].end >= view.sourceText.indexOf(reference.quote) + reference.quote.length)
      }
      sourceActions++
    }
    const pairTree = environment.Pairs({ ...props, structure, onSlot() {}, onPage() {} })
    const nested = all(pairTree, node => node.type === environment.Evidence)
    assert.equal(nested.length, 1)
    assert.equal(nested[0].props.documentId, fixture.documentId); assert.equal(nested[0].props.revision, 1)
  }
  const value = details.get('fields').structure.branches[0].mapping.provenance
  const invalid = [
    candidate => { candidate.documentId = '' }, candidate => { candidate.documentId = 'x'.repeat(4097) }, candidate => { candidate.documentId = null },
    candidate => { candidate.revision = 0 }, candidate => { candidate.revision = 1.5 }, candidate => { candidate.revision = '1' },
    candidate => { candidate.value.paragraph = -1 }, candidate => { candidate.value.paragraph = 0.5 }, candidate => { candidate.value.paragraph = null },
    candidate => { candidate.value.quote = ' ' }, candidate => { candidate.value.quote = 'x'.repeat(2001) },
    candidate => { candidate.onLocate = undefined },
  ]
  for (const mutate of invalid) {
    const candidate = { ...props, value: structuredClone(value) }; mutate(candidate)
    const tree = environment.Evidence(candidate), buttons = all(tree, node => node.type === 'button')
    assert(buttons.length === 0 || buttons.every(button => button.props.disabled), 'Incomplete identities or stale snapshot actions must not navigate')
    const count = located.length
    for (const button of buttons) button.props.onClick()
    assert.equal(located.length, count, 'Disabled source actions must remain guarded even if a callback is invoked directly')
  }
  const action = all(environment.Evidence({ ...props, value }), node => node.type === 'button')[0]
  action.props.onClick(); const reference = located.at(-1)
  const target = quoteEnvironment.target(view, reference)
  assert.notEqual(target.first, value.paragraph, 'Stored source-unit identity differs from the reading-view paragraph after split units')
  for (const mutate of [ref => { ref.documentId += ' ' }, ref => { ref.revision = 2 }, ref => { ref.quote = ref.quote.toUpperCase() },
    ref => { ref.quote += 'not in the full stored quotation' }, ref => { ref.paragraph = -1 }]) {
    const changed = { ...reference }; mutate(changed); assert.throws(() => quoteEnvironment.target(view, changed))
  }
  assert.throws(() => quoteEnvironment.target({ ...view, graph: { ...view.graph, revision: 2 } }, reference), /版本/)
  assert.throws(() => quoteEnvironment.target({ ...view, paragraphs: [] }, reference), /阅读范围/)
  const callback = modelCitationPanelLocationSource
  assert.equal(callback(source), callback(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')))
  const modes = [], pending = [], adapter = { changeReadMode: mode => modes.push(mode), resultView: view, currentResultRef: { current: view },
    locateConsumptionReference: (ref, isCurrent) => { assert.equal(isCurrent(), true); quoteEnvironment.target(view, ref); return new Promise(resolve => pending.push(resolve)) } }
  runInNewContext('this.locate=' + callback(source), adapter)
  await assert.rejects(adapter.locate({ ...reference, revision: 2 }), /版本/)
  assert.equal(modes.length, 0, 'Failed evidence lookup must not hide its model-panel error before validation')
  const attempt = adapter.locate(reference)
  assert.equal(modes.length, 0, 'Do not change modes before a successful lookup resolves')
  pending.shift()(true); assert.equal(await attempt, true); assert.deepEqual(modes, ['graph'])
  const stopped = adapter.locate(reference)
  pending.shift()(false); assert.equal(await stopped, false); assert.deepEqual(modes, ['graph'])
  for (const tree of [environment.Evidence({ ...props, value }), environment.Evidence({ ...props, value: details.get('fields').structure.branches[0].boundary.provenance })]) {
    assert.equal(all(tree, node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML')).length, 0)
    assert.equal(all(tree, node => node.type === 'img').length, 0)
    assert(!text(tree).includes('已掌握') && !text(tree).includes('独立验证通过'))
  }
  for (const request of [{ documentId: fixture.documentId + ' ', expectedRevision: 1, modelId: 'source-fields' },
    { documentId: fixture.documentId, expectedRevision: 2, modelId: 'source-fields' },
    { documentId: fixture.documentId, expectedRevision: 1, modelId: 'source-fields ' }]) assert((await post(request)).error)

  // Seed distinct accepted canonical keys, including their prefix and trimmed
  // aliases. The real HTTP projection and quote receiver must retain each key.
  const prefix = 'opaque-model-document:' + 'x'.repeat(138)
  assert.equal(prefix.length, 160)
  const identities = [prefix, prefix + 'A', prefix + 'y'.repeat(69) + 'A', prefix + 'y'.repeat(69) + 'B',
    prefix + 'z'.repeat(3936), ' ' + fixture.documentId + ' ', ' 文档: "甲">:原始 \t']
  let opaqueSourceActions = 0, rejectedWriteIdentities = 0, opaqueOriginGuards = 0
  for (const documentId of identities) {
    const remap = input => Array.isArray(input) ? input.map(remap) : input && typeof input === 'object'
      ? Object.fromEntries(Object.entries(input).map(([key, item]) => [key,
        key === 'documentId' && item === fixture.documentId ? documentId : remap(item)])) : input
    harness.store.saveGraph(remap(fixture.graph), { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
    const graphBefore = JSON.stringify(harness.store.getDocument(documentId))
    const unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(documentId))
    const detail = await post({ documentId, expectedRevision: 1, modelId: 'source-fields' })
    assert(!detail.error, JSON.stringify(detail.error)); assert.equal(detail.documentId, documentId); assert.equal(detail.revision, 1)
    const sourceValues = [...detail.structure.slots.map(slot => slot.provenance),
      ...['condition', 'mapping', 'boundary'].map(key => detail.structure.branches[0][key].provenance), detail.structure.examples[0].provenance]
    const opaqueView = { ...view, graph: harness.store.getDocument(documentId) }
    const pairEvidence = all(environment.Pairs({ ...props, documentId, structure: detail.structure, onSlot() {}, onPage() {} }),
      node => node.type === environment.Evidence)
    assert.equal(pairEvidence.length, 1); assert.equal(pairEvidence[0].props.documentId, documentId); assert.equal(pairEvidence[0].props.revision, 1)
    for (const origin of sourceValues) {
      const button = all(environment.Evidence({ ...props, documentId, value: origin }), node => node.type === 'button')[0]
      assert(button && !button.props.disabled, 'Accepted canonical read-only document identity must allow field source navigation: length ' + documentId.length)
      button.props.onClick(); const full = located.at(-1)
      assert.equal(full.documentId, documentId); assert.equal(full.revision, 1); assert.equal(full.quote, origin.quote)
      assert.equal(full.paragraph, origin.paragraph); assert.equal(full.sourceQuoteOnly, true); assert.equal(full.nodeId, undefined)
      const target = quoteEnvironment.target(opaqueView, full)
      assert(opaqueView.sourceText.slice(paragraphs[target.first].start).startsWith(origin.quote))
      // Even an existing alias with the same quote cannot substitute its identity.
      for (const foreign of new Set([fixture.documentId, documentId.trim(), documentId.slice(0, 160)])) {
        if (foreign !== documentId) assert.throws(() => quoteEnvironment.target(opaqueView, { ...full, documentId: foreign }), /文档或版本/)
      }
      assert.throws(() => quoteEnvironment.target(opaqueView, { ...full, revision: 2 }), /文档或版本/)
      opaqueSourceActions++
    }
    for (const kind of ['user', 'ai', 'unknown']) {
      const other = await post({ documentId, expectedRevision: 1, modelId: 'source-' + kind })
      assert(!other.error); assert.equal(other.documentId, documentId)
      const origin = other.structure.branches[0].mapping.provenance
      assert.equal(origin.kind, kind)
      assert.equal(all(environment.Evidence({ ...props, documentId, value: origin }), node => node.type === 'button').length, 0)
      opaqueOriginGuards++
    }
    if (documentId.length > 160 || documentId !== documentId.trim()) {
      for (const method of ['graph-commit-preview', 'graph-commit']) {
        const rejected = await post({ documentId, expectedRevision: 1, baseNodeIds: [], baseEdgeKeys: [], graph: { nodes: [], edges: [] } }, method)
        assert.equal(rejected.error?.code, 'invalid_input', 'Read-only access must not widen the structure-write identity contract')
        rejectedWriteIdentities++
      }
    }
    assert.equal(JSON.stringify(harness.store.getDocument(documentId)), graphBefore)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(documentId)), unitsBefore)
  }
  assert.equal((await post({ documentId: 'x'.repeat(4097), expectedRevision: 1, modelId: 'source-fields' })).error?.code, 'invalid_input')
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(modelCalls, 0)
  console.log(JSON.stringify({ ok: true, actualHttpRequests, sourceActions, rejectedOrigins, invalidMetadata: invalid.length,
    opaqueDocuments: identities.length, opaqueSourceActions, opaqueOriginGuards, rejectedWriteIdentities,
    maxReadIdentity: 4096, opaqueKeysNotNormalized: true, existingAliasesRefused: true,
    negativeTargets: 7, completeFieldQuotes: true, sourceUnitNotReadingIndex: true, duplicateQuoteRefused: true,
    noRawHtml: true, conflictingSourceRetained: true, oldSnapshotDisabled: true, failureKeepsModelPanel: true,
    noTruthPromotion: true, nonMutating: true, modelCalls }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
