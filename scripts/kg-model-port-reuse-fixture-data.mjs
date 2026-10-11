import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

export function modelPortReuseFixture({ chunks = 512, slots = 40, structured = true } = {}) {
  const fixture = modelStructureFixture()
  fixture.graph.nodes = []; fixture.graph.edges = []
  fixture.sourceUnits = Array.from({ length: chunks }, (_, paragraph) => ({ paragraph,
    text: '隔离测量资料 ' + paragraph + '：该情境下的输入、条件与输出只是一份未核验结构记录。' }))
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
  fixture.graph.source.sections = [{ id: 'measured', title: '隔离测量资料', startParagraph: 0, endParagraph: chunks - 1 }]
  fixture.graph.staging = { chunks: fixture.sourceUnits.map(unit => ({ chunkId: 'part-' + unit.paragraph,
    sourceId: fixture.graph.source.id, startParagraph: unit.paragraph, endParagraph: unit.paragraph })) }
  const provenance = { kind: 'source', paragraph: chunks - 1, quote: fixture.sourceUnits.at(-1).text, note: '只验证引文位置，不证明映射为真。' }
  const evidence = fixture.sourceUnits.slice(-8).map(unit => ({ documentId: fixture.documentId,
    sourceId: fixture.graph.source.id, paragraph: unit.paragraph, quote: unit.text }))
  const field = text => ({ text, provenance: { ...provenance } })
  for (let index = 0; index < slots; index++) fixture.graph.nodes.push({ id: 'port-' + index, type: 'concept',
    text: '端点 ' + index, paragraph: chunks - 1, evidence: structuredClone(evidence), state: 'candidate', entailmentStatus: 'unverified' })
  for (const id of ['left', 'right']) {
    const model = { id, type: 'connection_model', text: id + '：未核验条件映射', paragraph: chunks - 1,
      evidence: structuredClone(evidence), state: 'candidate', entailmentStatus: 'unverified' }
    if (structured) model.modelStructure = { version: 1, identity: 'hypothesis',
      slots: Array.from({ length: slots }, (_, index) => ({ id: 'slot-' + index, conceptId: 'port-' + index,
        label: '端点 ' + index, role: index % 2 ? 'output' : 'input', unit: '未定', state: '本情境', provenance: { ...provenance } })),
      branches: [{ id: 'conditional', label: '仅在所记情境', condition: field('对象、时间与条件仍需核对'),
        mapping: field('暂记输入到输出的映射；尚未独立验证'), boundary: field('不作跨情境预测或掌握证明') }], examples: [] }
    fixture.graph.nodes.push(model)
    fixture.graph.edges.push(...Array.from({ length: slots }, (_, index) => ({ fromNodeId: id,
      toNodeId: 'port-' + index, relation: 'maps_between', role: index % 2 ? 'output' : 'input', evidence: structuredClone(evidence) })))
  }
  return fixture
}
