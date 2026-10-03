import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGenerationStructureTools } from '../src/kg-generation-structure.mjs'

// Source-only integration: all extraction/discovery is mocked. This host has no
// persistent-store service, HTTP listener, model provider, or existing documents.
const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = 'function buildGraphViewHost('
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `harness.structureHostTest = {
          buildGraphViewHost, normalizeGraph, buildSourceManifestHost, buildUserPrompt,
          stampGenerationStructureHost, splitParagraphsHost,
        }
        ${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const tools = createGenerationStructureTools()
const previousHarness = globalThis.harness
const handlers = new Map()
const extractionCalls = []
const discoveryCalls = []
const harness = { handle(name, handler) { handlers.set(name, handler) } }
const extractor = {
  async extractChunk(args) {
    extractionCalls.push(args)
    return {
      summary: '结构集成测试：独立记录和完整条件，不发明关系。',
      nodes: args.chunk.units.filter(unit => !unit.text.trim().startsWith('#')).map(unit => ({
        id: 'unit-' + unit.num,
        type: unit.text.includes('核心概念') ? 'concept' : unit.text.startsWith('若') ? 'rule' : 'fact',
        text: unit.text, quote: unit.text, paragraph: unit.num,
        // Explicit section provenance must override this intentionally incorrect
        // proposer annotation for source notes, without changing the node type.
        contentLayer: 'main',
      })),
      edges: [],
    }
  },
  async weaveRelations(args) {
    discoveryCalls.push(args)
    return { edges: [] }
  },
  async reviewRelations() { throw new Error('No proposed edges require a reviewer call') },
}
async function waitTask(taskId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const task = await handlers.get('task-status')({ taskId })
    if (task.status !== 'running') return task
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Mock extraction did not settle')
}
try {
  globalThis.harness = harness
  plugin().apply({ get(name) { return name === 'kgExtractor' ? extractor : null }, interval() {} })
  const api = harness.structureHostTest
  const text = [
    '## 版本说明', '这里记录底本整理方法。', '整理符号不是正文命题。',
    '## 知识的来源', '核心概念是本文明确命名的对象。',
    '若甲成立，则乙成立。', '若乙成立，则丙成立。',
    ...Array.from({ length: 8 }, (_, index) => '独立观察记录' + index + '仅描述这一对象。'),
  ].join('\n\n')
  const documentId = 'structure-host-integration-fixture'
  const started = await handlers.get('extract')({ documentId, title: '结构集成测试', text, concurrency: 1, relationBatchBudget: 1 })
  assert.ok(started.taskId, JSON.stringify(started))
  const task = await waitTask(started.taskId)
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error))
  const exported = await handlers.get('document-export')({ documentId, includeSourceText: true })
  assert.ok(!exported.error, JSON.stringify(exported.error))
  const graph = exported.graph
  assert.equal(exported.sourceText, text)
  assert.equal(graph.nodes.length, 13)
  assert.equal(graph.edges.length, 0, 'Concept anchors and adjacent conditional rules must not manufacture semantic edges')
  assert.equal(graph.nodes.filter(node => node.type === 'rule').length, 2)
  assert.equal(graph.nodes.filter(node => node.contentLayer === 'source_context').length, 2)
  assert.ok(graph.nodes.filter(node => node.contentLayer === 'source_context').every(node => node.type === 'fact'))
  assert.equal(graph.nodes.filter(node => node.contentLayer === 'main').length, 11)
  assert.ok(graph.source.sections.every(section => ['main', 'source_context'].includes(section.contentLayer)))
  assert.equal(graph.source.sections.find(section => section.title.includes('知识的来源')).contentLayer, 'main')
  assert.equal(graph.generation.status, 'succeeded_with_warnings', 'Advisory structural warnings must be reported without failing the accepted task')
  assert.equal(graph.generation.structureQuality.status, 'needs_attention')
  assert.ok(graph.generation.structureQuality.checks.some(check => check.code === 'main_fragmented'))
  assert.equal(graph.generation.structureQuality.metrics.main.nodeCount, 11)
  assert.ok(extractionCalls.length > 0 && discoveryCalls.length > 0)
  for (const call of extractionCalls) {
    assert.match(call.prompt, /建图结构约束 v1/)
    assert.match(call.prompt, /共同主题|同主题/)
    assert.match(call.prompt, /前一整条规则不等于B已成立/)
    assert.match(call.prompt, /物理因果/)
    assert.match(call.prompt, /明确章节层次/)
    assert.ok(call.chunk.sectionLayers.some(section => section.contentLayer === 'source_context'))
  }
  const firstTargets = discoveryCalls[0].targetIds
  const concept = graph.nodes.find(node => node.type === 'concept')
  assert.equal(firstTargets[0], concept.id, 'An isolated main concept anchor must precede other main targets and source notes')

  const serialized = JSON.stringify(graph)
  for (const args of [{ nodeLimit: 2 }, { nodeLimit: 1, query: '独立观察记录7' }]) {
    const loaded = await handlers.get('document-load')({ documentId, ...args })
    assert.ok(loaded.graph.view.truncated)
    assert.deepEqual(loaded.graph.graphStructureQuality, tools.inspect(graph))
    assert.equal(loaded.graph.graphStructureQuality.metrics.main.nodeCount, 11)
  }
  assert.equal(JSON.stringify((await handlers.get('document-export')({ documentId })).graph), serialized, 'Read-only queries must not stamp or migrate stored canonical graphs')

  // A large canonical graph must keep its full quality report even when the
  // working view consists of only one matched node or three windowed nodes.
  const large = {
    source: { documentId: 'structure-large-fixture', sections: [{ id: 'body', title: '正文' }] },
    nodes: Array.from({ length: 1001 }, (_, index) => ({ id: 'large-' + index, type: 'fact', text: '大型独立记录' + index, sectionId: 'body' })),
    edges: [],
  }
  const before = JSON.stringify(large)
  const window = api.buildGraphViewHost(large, 0, '', 3)
  const query = api.buildGraphViewHost(large, 0, '大型独立记录999', 1)
  assert.equal(window.nodes.length, 3)
  assert.equal(query.nodes.length, 1)
  for (const view of [window, query]) {
    assert.equal(view.view.totalNodes, 1001)
    assert.equal(view.graphStructureQuality.metrics.main.nodeCount, 1001)
    assert.deepEqual(view.graphStructureQuality, tools.inspect(large))
  }
  assert.equal(JSON.stringify(large), before)
  assert.equal(Object.hasOwn(large, 'generation'), false, 'Loading legacy graphs must not create generation metadata')
  const independent = { nodes: [{ id: 'independent', type: 'fact', text: '有效独立事实' }], edges: [], generation: { status: 'succeeded' } }
  api.stampGenerationStructureHost(independent)
  assert.equal(independent.generation.status, 'succeeded')
  assert.equal(independent.generation.structureQuality.status, 'no_structural_alert')
  assert.equal(independent.generation.structureQuality.relationSearch.searchedTargets, null, 'Unknown discovery coverage is not zero or complete')
  console.log(JSON.stringify({ ok: true, mockedExtractionAndDiscovery: true, advisoryNotGate: true,
    sectionAndNodeLayers: true, noInventedConditionalEdges: true, mainConceptTargetsFirst: true,
    canonicalMetricsInQueryAndWindow: true, largeCanonicalNodes: 1001, readOnlyLegacyAndStoredGraph: true }))
} finally {
  if (previousHarness === undefined) delete globalThis.harness
  else globalThis.harness = previousHarness
}

// The persistent HTTP route uses SQLite windows rather than buildGraphViewHost.
// Its diagnostic must still inspect the complete graph in the same read snapshot.
if (!process.argv.includes('--source-only')) {
  const { modelLearningHarness } = await import('./kg-model-learning-fixture-data.mjs')
  const documentId = 'structure-http-canonical-fixture'
  const nodes = Array.from({ length: 1003 }, (_, index) => ({
    id: 'http-' + index, type: 'fact', paragraph: index,
    sectionId: index < 1001 ? 'body' : 'notes',
    text: index < 1001 ? '大型结构记录' + index : '底本说明' + index,
  }))
  const fixture = {
    documentId, sourceText: nodes.map(node => node.text).join('\n\n'),
    sourceUnits: nodes.map(node => ({ paragraph: node.paragraph, text: node.text })),
    graph: {
      source: { id: 'source-' + documentId, documentId, title: 'HTTP全图诊断', sections: [
        { id: 'body', title: '正文', startParagraph: 0, endParagraph: 1000 },
        { id: 'notes', title: '版本说明', startParagraph: 1001, endParagraph: 1002 },
      ] },
      nodes, edges: [
        { fromNodeId: 'http-0', toNodeId: 'http-1', relation: 'supports' },
        { fromNodeId: 'http-1', toNodeId: 'http-1001', relation: 'supports' },
      ],
    },
  }
  const persistent = await modelLearningHarness({ fixture })
  try {
    const canonical = persistent.store.getDocument(documentId)
    const before = JSON.stringify(canonical)
    const expected = tools.inspect(canonical)
    for (const args of [
      { nodeLimit: 3, includeSourceText: false },
      { nodeLimit: 1, query: '大型结构记录999' },
      { nodeLimit: 1, query: 'no-matched-node', includeSourceText: false },
    ]) {
      const loaded = await persistent.post({ documentId, ...args }, 'document-load')
      assert.ok(!loaded.error, JSON.stringify(loaded.error))
      assert.ok(loaded.graph.nodes.length <= args.nodeLimit)
      assert.equal(loaded.graph.view.totalNodes, 1003)
      assert.deepEqual(loaded.graph.graphStructureQuality, expected)
      assert.equal(loaded.graph.graphStructureQuality.metrics.main.nodeCount, 1001)
      assert.equal(loaded.graph.graphStructureQuality.metrics.sourceContextNodeCount, 2)
      assert.equal(loaded.graph.graphStructureQuality.relationSearch.searchedTargets, null)
    }
    assert.equal(JSON.stringify(persistent.store.getDocument(documentId)), before)
    assert.equal(Object.hasOwn(persistent.store.getDocument(documentId), 'graphStructureQuality'), false)
    console.log(JSON.stringify({ ok: true, persistentHttpCanonicalMetrics: true,
      windowAndQueryUnchanged: true, canonicalNodes: 1003, mainNodes: 1001,
      sourceContextNodes: 2, sourceAndGraphNotMigrated: true }))
  } finally { persistent.stop() }
}
