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
const resolveLayeredOverlaps = new Function('return (' + extractFunction(source, 'resolveLayeredOverlaps') + ')')()
const nodes = [
  ...['a','b','c','d','e','x','p','q'].map((id) => ({ id, type: 'claim' })),
  { id: 'system', type: 'concept' },
  { id: 'flow', type: 'rule' },
  { id: 'far', type: 'claim' },
]
const edges = [
  { fromNodeId: 'a', toNodeId: 'b', relation: 'causes' },
  { fromNodeId: 'b', toNodeId: 'c', relation: 'causes' },
  { fromNodeId: 'c', toNodeId: 'd', relation: 'causes' },
  { fromNodeId: 'd', toNodeId: 'e', relation: 'causes' },
  { fromNodeId: 'x', toNodeId: 'c', relation: 'analogy' },
  { fromNodeId: 'p', toNodeId: 'q', relation: 'supports' },
  { fromNodeId: 'system', toNodeId: 'flow', relation: 'contains' },
  { fromNodeId: 'far', toNodeId: 'system', relation: 'supports' },
]
const sizes = new Map(nodes.map((node) => [node.id, { w: node.id === 'q' ? 218 : 170, h: 72 }]))
const pinnedX = new Map()
const rawPos = layoutLayered(nodes, edges, sizes, pinnedX)
const pos = resolveLayeredOverlaps(nodes, sizes, rawPos, 18, pinnedX)
const localDistance = Math.abs(pos.get('flow').x - pos.get('system').x)
assert(localDistance <= 260, 'strong local contains relation was not attracted near its anchor: ' + localDistance)
assert(source.includes("const strongLocalRelations = new Set(['defines', 'contains', 'is_a', 'analogy', 'example', 'counter_example'])"), 'strong local relation set is missing or widened')
assert(source.includes('const localRadius = 260'), 'local attraction must stay bounded')
assert(!source.includes("strongLocalRelations = new Set(['supports'"), 'supports must not become a strong local attraction relation')
for (const [from, to] of [['a','b'],['b','c'],['c','d'],['d','e']]) {
  assert(pos.get(from).y < pos.get(to).y, 'reasoning chain is not monotonic: ' + from + ' -> ' + to + ' / ' + JSON.stringify({ from: pos.get(from), to: pos.get(to) }))
}
const chainX = ['a','b','c','d','e'].map((id) => pos.get(id).x)
assert(Math.max(...chainX) - Math.min(...chainX) < 1, 'reasoning backbone did not stay pinned after overlap resolution: ' + JSON.stringify(chainX))
assert(pinnedX.size === 5, 'reasoning lane pins were not exported to the overlap resolver: ' + pinnedX.size)
const satelliteDistance = Math.abs(pos.get('x').x - pos.get('c').x)
assert(pos.get('x').y < pos.get('c').y, 'analogy satellite was not placed as a branch near its target')
assert(satelliteDistance >= 120 && satelliteDistance <= 280, 'analogy satellite is not a nearby side branch: ' + satelliteDistance)
if (pos.get('q').y === pos.get('b').y) {
  const required = (sizes.get('q').w + sizes.get('b').w) / 2 + 18
  assert(Math.abs(pos.get('q').x - pos.get('b').x) >= required - 0.1, 'unrelated row peer overlapped the pinned backbone slot')
}
const layeredSource = extractFunction(source, 'layoutLayered')
assert(!layeredSource.includes('if (backbonePaths.length === 0) return placed'), 'strong local attraction is incorrectly gated on a reasoning backbone')
assert(!layeredSource.includes('Shift an entire visual row rather than one node'), 'whole-row lane shifting is still present')
assert(layeredSource.includes('backbone nodes occupy fixed lane slots') || layeredSource.includes('Backbone nodes occupy fixed lane slots'), 'fixed lane-slot projection is missing')
assert(source.includes("const reasoningRelations = new Set(['causes', 'infers'])"), 'relation-aware layered backbone is missing')
assert(source.includes("return 'layered'"), 'new sessions do not default to the semantic layered projection')
console.log(JSON.stringify({ ok: true, chain: ['a','b','c','d','e'].map((id) => ({ id, ...pos.get(id) })), satellite: pos.get('x'), peer: pos.get('q') }))
