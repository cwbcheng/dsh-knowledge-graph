// Shortest relation path between two nodes (the graph's "why are these related").
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
const shortestPathBetween = (0, eval)('(' + extractFunction(source, 'shortestPathBetween') + ')')

const edge = (fromNodeId, toNodeId, relation = 'supports') => ({ fromNodeId, toNodeId, relation })

// Direct edge, both directions of travel.
const chain = [edge('a', 'b', 'contains'), edge('b', 'c', 'supports')]
const forward = shortestPathBetween(chain, 'a', 'c')
assert.deepEqual(forward.nodes, ['a', 'b', 'c'])
assert.equal(forward.hops, 2)
assert.deepEqual(forward.links.map(l => l.relation), ['contains', 'supports'])
assert.deepEqual(forward.links.map(l => l.reversed), [false, false])

const backward = shortestPathBetween(chain, 'c', 'a')
assert.deepEqual(backward.nodes, ['c', 'b', 'a'])
assert.deepEqual(backward.links.map(l => l.reversed), [true, true], 'walking upstream marks each hop reversed')
assert.equal(backward.links[0].fromNodeId, 'c')
assert.equal(backward.links[1].toNodeId, 'a')

// Shortest wins over a longer alternative.
const diamond = [edge('a', 'b'), edge('b', 'd'), edge('a', 'c'), edge('c', 'd'), edge('a', 'd')]
const short = shortestPathBetween(diamond, 'a', 'd')
assert.equal(short.hops, 1, 'the direct edge is the shortest path')

// No connection, unknown endpoints, and self paths are explicit results.
assert.equal(shortestPathBetween([edge('a', 'b')], 'a', 'z'), null)
assert.equal(shortestPathBetween([], 'a', 'b'), null)
assert.deepEqual(shortestPathBetween(chain, 'a', 'a'), { nodes: ['a'], links: [], hops: 0 })
assert.equal(shortestPathBetween(chain, null, 'a'), null)

// Hop budget keeps long chains from flooding the overlay.
const long = Array.from({ length: 12 }, (_, i) => edge('n' + i, 'n' + (i + 1)))
assert.equal(shortestPathBetween(long, 'n0', 'n3').hops, 3)
assert.equal(shortestPathBetween(long, 'n0', 'n9'), null, 'chains beyond maxHops return null')
assert.equal(shortestPathBetween(long, 'n0', 'n9', 12).hops, 9, 'callers may raise the hop budget')

// Cycles and parallel relations terminate and stay deterministic.
const cyclic = [edge('a', 'b', 'contains'), edge('b', 'a', 'supports'), edge('b', 'c', 'causes'), edge('c', 'b', 'analogy')]
const throughCycle = shortestPathBetween(cyclic, 'a', 'c')
assert.equal(throughCycle.hops, 2)
assert.deepEqual(throughCycle.nodes, ['a', 'b', 'c'])
const parallel = shortestPathBetween([edge('a', 'b', 'supports'), edge('a', 'b', 'contains')], 'a', 'b')
assert.equal(parallel.links.length, 1, 'parallel relations collapse to one hop')

// Malformed entries never enter the walk.
const malformed = [null, {}, { fromNodeId: '', toNodeId: 'b' }, edge('x', 'y', 'contains')]
assert.equal(shortestPathBetween(malformed, 'x', 'y').hops, 1)
assert.equal(shortestPathBetween(malformed, 'a', 'b'), null)

// Generated artifacts must stay in sync.
for (const path of ['src/index.client.js', 'lib/client.js']) {
  const built = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  assert(built.includes(extractFunction(source, 'shortestPathBetween')), path + ' is missing shortestPathBetween')
  assert(built.includes(extractFunction(source, 'neighborInDirection')), path + ' is missing neighborInDirection')
}

// ---------- 方向键导航 ----------
const neighborInDirection = (0, eval)('(' + extractFunction(source, 'neighborInDirection') + ')')
const pos = new Map([
  ['center', { x: 0, y: 0 }],
  ['right', { x: 160, y: 20 }],
  ['left', { x: -160, y: 0 }],
  ['down', { x: 10, y: 200 }],
  ['up', { x: -10, y: -200 }],
  ['farRight', { x: 900, y: 600 }],
])
const neighbors = ['right', 'left', 'down', 'up', 'farRight']
assert.equal(neighborInDirection(pos, neighbors, 'center', 'ArrowRight'), 'right')
assert.equal(neighborInDirection(pos, neighbors, 'center', 'ArrowLeft'), 'left')
assert.equal(neighborInDirection(pos, neighbors, 'center', 'ArrowDown'), 'down')
assert.equal(neighborInDirection(pos, neighbors, 'center', 'ArrowUp'), 'up')
assert.equal(neighborInDirection(pos, neighbors, 'center', 'ArrowRight'), 'right', 'a distant side neighbor loses to the aligned one')
assert.equal(neighborInDirection(pos, ['right'], 'center', 'ArrowLeft'), null, 'no candidate in that direction')
assert.equal(neighborInDirection(pos, neighbors, 'missing', 'ArrowRight'), null)
assert.equal(neighborInDirection(pos, neighbors, 'center', 'Enter'), null)
assert.equal(neighborInDirection(pos, null, 'center', 'ArrowRight'), null)
assert.equal(neighborInDirection(new Map([['only', { x: 0, y: 0 }]]), ['only'], 'only', 'ArrowRight'), null, 'a self edge offers nowhere to go')

console.log(JSON.stringify({ ok: true, directionality: true, shortestWins: true, hopBudget: true,
  cycles: true, parallel: true, malformed: true, keyboardDirection: true, generatedParity: true }))
