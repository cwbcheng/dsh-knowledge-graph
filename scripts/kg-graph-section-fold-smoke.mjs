// 按章节折叠：显示层把同一节的节点收成一个合成节点，关系按节重连。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(name + ' not found')
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(name + ' is not balanced')
}

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const foldGraphBySection = (0, eval)('(' + extractFunction(source, 'foldGraphBySection') + ')')

const nodes = [
  { id: 'a1', type: 'concept', text: 'A1', sectionId: 's-a', sectionTitle: '第 A 节' },
  { id: 'a2', type: 'fact', text: 'A2', sectionId: 's-a', sectionTitle: '第 A 节' },
  { id: 'a3', type: 'concept', text: 'A3', sectionId: 's-a', sectionTitle: '第 A 节' },
  { id: 'b1', type: 'concept', text: 'B1', sectionId: 's-b', sectionTitle: '第 B 节' },
  { id: 'solo', type: 'concept', text: 'Solo', sectionId: 's-c', sectionTitle: '第 C 节' },
  { id: 'loose', type: 'concept', text: 'Loose' },
]
const edges = [
  { fromNodeId: 'a1', toNodeId: 'a2', relation: 'contains' },
  { fromNodeId: 'a2', toNodeId: 'b1', relation: 'supports' },
  { fromNodeId: 'a3', toNodeId: 'b1', relation: 'supports' },
  { fromNodeId: 'b1', toNodeId: 'a3', relation: 'causes' },
  { fromNodeId: 'loose', toNodeId: 'a1', relation: 'analogy' },
]
const snapshot = JSON.stringify({ nodes, edges })

// 1. 没要求折叠时原样返回，节点对象身份不变。
const plain = foldGraphBySection(nodes, edges, new Set())
assert.equal(plain.nodes, nodes)
assert.equal(plain.edges, edges)
assert.equal(plain.map, null)
assert.deepEqual(plain.foldable, ['s-a'], '只有成员 ≥ 2 的章节可折叠')
assert.equal(plain.sections.size, 0)

// 2. 折叠 A 节：三个成员收成一个合成节点，位置取第一个成员。
const folded = foldGraphBySection(nodes, edges, new Set(['s-a']))
assert.equal(folded.nodes.length, 4, '三个成员被替换成一个合成节点')
assert.equal(folded.nodes[0].id, 'section:s-a')
assert.equal(folded.nodes[0].folded, true)
assert.equal(folded.nodes[0].text, '第 A 节 · 3 个节点')
assert.equal(folded.nodes[0].type, 'concept')
assert.equal(folded.nodes[0].sectionId, 's-a')
assert.deepEqual(folded.sections.get('section:s-a').members, ['a1', 'a2', 'a3'])
assert.equal(folded.map.get('a1'), 'section:s-a')
assert.equal(folded.map.get('b1'), 'b1')

// 3. 关系按节重连：内部边消失，跨节边去重并打上 foldedEdge。
assert.equal(folded.edges.length, 3, '内部 a1→a2 被移除，两条 a·→b1 合并为一条: ' + JSON.stringify(folded.edges.map(e => e.fromNodeId + '>' + e.toNodeId + ':' + e.relation)))
const cross = folded.edges.filter(e => e.fromNodeId === 'section:s-a' && e.toNodeId === 'b1')
assert.equal(cross.length, 1)
assert.equal(cross[0].relation, 'supports')
assert.equal(cross[0].foldedEdge, true)
assert.equal(cross[0].evidence, edges[1].evidence, '聚合边保留首条原始边的证据字段')
assert.ok(folded.edges.some(e => e.fromNodeId === 'b1' && e.toNodeId === 'section:s-a' && e.relation === 'causes'))
assert.ok(folded.edges.some(e => e.fromNodeId === 'loose' && e.toNodeId === 'section:s-a' && e.relation === 'analogy'))
assert.ok(folded.edges.every(e => e.fromNodeId !== e.toNodeId), '不允许自环')

// 4. 单节点章节即使被点名也不折叠，但仍在 foldable 之外。
const solo = foldGraphBySection(nodes, edges, new Set(['s-c']))
assert.equal(solo.foldedSections.size, 0)
assert.equal(solo.nodes, nodes)
assert.ok(solo.foldable.indexOf('s-c') < 0)

// 5. 全部折叠：节点数 = 可折叠章节数 + 其它节点，且没有重复关系。
const everything = foldGraphBySection(nodes, edges, new Set(foldGraphBySection(nodes, edges, new Set()).foldable))
assert.equal(everything.nodes.length, 4, '折叠后的节 + 单节点节 + 无章节节点')
assert.equal(everything.foldedSections.size, 1)
const identities = everything.edges.map(e => e.fromNodeId + '>' + e.toNodeId + ':' + e.relation)
assert.equal(new Set(identities).size, identities.length, '聚合后没有重复关系')

// 6. 输入不可变。
assert.equal(JSON.stringify({ nodes, edges }), snapshot, '折叠不得修改原始图数据')

// 7. 空图与畸形输入不抛错。
for (const input of [[], null, undefined]) {
  const empty = foldGraphBySection(input, input, new Set(['s-a']))
  assert.deepEqual(empty.nodes, [])
  assert.deepEqual(empty.edges, [])
  assert.deepEqual(empty.foldable, [])
}
const malformed = foldGraphBySection(
  [{ id: 'x', sectionId: 's-q', sectionTitle: 'Q' }, null, { id: 'y', sectionId: 's-q', sectionTitle: 'Q' }],
  [null, { fromNodeId: 'x', toNodeId: 'y', relation: 'supports' }],
  new Set(['s-q']))
assert.equal(malformed.nodes.length, 1, '折叠后的节只留一个合成节点，null 节点被丢弃')
assert.equal(malformed.edges.length, 0, '节内关系不显示')
const dangling = foldGraphBySection(
  [{ id: 'a', sectionId: 's-q', sectionTitle: 'Q' }, { id: 'b', sectionId: 's-q', sectionTitle: 'Q' }],
  [{ fromNodeId: 'a', toNodeId: 'missing', relation: 'supports' }], new Set(['s-q']))
assert.equal(dangling.edges.length, 0, '悬空端点不会进入布局')

// 8. 生成产物一致。
for (const path of ['src/index.client.js', 'lib/client.js', 'extension/viewer.js']) {
  const built = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  assert(built.includes(extractFunction(source, 'foldGraphBySection')), path + ' is missing foldGraphBySection')
}

console.log(JSON.stringify({ ok: true, identityWhenOpen: true, collapsedNode: true, edgeRemap: true,
  singleMemberSection: true, foldAll: true, immutable: true, malformed: true, generatedParity: true }))
