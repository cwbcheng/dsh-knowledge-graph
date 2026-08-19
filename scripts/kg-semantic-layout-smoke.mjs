import { readFileSync } from 'node:fs'
function assert(condition, message) { if (!condition) throw new Error(message) }
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(name + ' not found')
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(name + ' is not balanced')
}
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const radialSource = extractFunction(source, 'layoutRadial')
assert(radialSource.includes('let hub = nodes[0]'), 'radial layout lost its highest-degree hub/BFS contract')
assert(!radialSource.includes('reasoningRelations'), 'relation-aware reasoning ranking leaked into radial layout')
const num = (name) => {
  const match = source.match(new RegExp('const ' + name + ' = ([0-9.]+)'))
  if (!match) throw new Error(name + ' not found')
  return Number(match[1])
}
const names = ['LAYER_COL_GAP', 'LAYER_MAX_ROW_WIDTH', 'LAYER_X_GAP', 'LAYER_Y_GAP']
const values = names.map(num)
const layoutLayered = new Function(...names, 'return (' + extractFunction(source, 'layoutLayered') + ')')(...values)
const nodes = ['a','b','c','d','e','x'].map((id) => ({ id }))
const edges = [
  { fromNodeId: 'a', toNodeId: 'b', relation: 'causes' },
  { fromNodeId: 'b', toNodeId: 'c', relation: 'causes' },
  { fromNodeId: 'c', toNodeId: 'd', relation: 'causes' },
  { fromNodeId: 'd', toNodeId: 'e', relation: 'causes' },
  { fromNodeId: 'x', toNodeId: 'c', relation: 'analogy' },
]
const sizes = new Map(nodes.map((node) => [node.id, { w: 170, h: 72 }]))
const pos = layoutLayered(nodes, edges, sizes)
for (const [from, to] of [['a','b'],['b','c'],['c','d'],['d','e']]) {
  assert(pos.get(from).y < pos.get(to).y, 'reasoning chain is not monotonic: ' + from + ' -> ' + to + ' / ' + JSON.stringify({ from: pos.get(from), to: pos.get(to) }))
}
assert(pos.get('x').y < pos.get('c').y, 'analogy satellite was not placed as a branch near its target')
assert(source.includes("const reasoningRelations = new Set(['causes', 'infers'])"), 'relation-aware layered backbone is missing')
assert(source.includes("return 'layered'"), 'new sessions do not default to the semantic layered projection')
console.log(JSON.stringify({ ok: true, chain: ['a','b','c','d','e'].map((id) => ({ id, ...pos.get(id) })), satellite: pos.get('x') }))
