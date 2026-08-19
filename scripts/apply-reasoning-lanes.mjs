import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(label + ': pattern not found')
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(label + ': pattern is not unique')
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(name + ': function not found')
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { start, end: i + 1, text: source.slice(start, i + 1) }
    }
  }
  throw new Error(name + ': unbalanced function')
}

const clientPath = 'src/index.client.js'
let client = readFileSync(clientPath, 'utf8')
const found = extractFunction(client, 'layoutLayered')
let layered = found.text

layered = replaceOnce(
  layered,
  "        const directionalRelations = new Set(['supports', 'driven_by', 'aims_at'])\n        const level = new Map()",
  "        const directionalRelations = new Set(['supports', 'driven_by', 'aims_at'])\n        // View-only reasoning lanes: a real multi-step causes/infers path may\n        // align vertically, but lane identity never enters the canonical graph.\n        const backbonePaths = []\n        const level = new Map()",
  'backbone path declaration',
)

layered = replaceOnce(
  layered,
  `            const topo = component.filter((id) => reasonIds.has(id) && indegree.get(id) === 0)
            for (const id of topo) local.set(id, 0)
            let processed = 0
            while (topo.length > 0) {
              const id = topo.shift()
              processed += 1
              const base = local.get(id) || 0
              for (const to of outgoing.get(id) || []) {
                local.set(to, Math.max(local.get(to) || 0, base + 1))
                indegree.set(to, indegree.get(to) - 1)
                if (indegree.get(to) === 0) topo.push(to)
              }
            }
            if (processed !== reasonIds.size) local.clear()`,
  `            const topo = component.filter((id) => reasonIds.has(id) && indegree.get(id) === 0)
            const roots = topo.slice()
            const topoOrder = []
            for (const id of topo) local.set(id, 0)
            let processed = 0
            while (topo.length > 0) {
              const id = topo.shift()
              topoOrder.push(id)
              processed += 1
              const base = local.get(id) || 0
              for (const to of outgoing.get(id) || []) {
                local.set(to, Math.max(local.get(to) || 0, base + 1))
                indegree.set(to, indegree.get(to) - 1)
                if (indegree.get(to) === 0) topo.push(to)
              }
            }
            if (processed !== reasonIds.size) {
              local.clear()
            } else {
              // Pick only substantial reasoning backbones (>= 3 nodes). This
              // is deterministic longest-path selection inside the already
              // accepted causes/infers DAG, not semantic clustering.
              const remainingDepth = new Map()
              for (let orderIndex = topoOrder.length - 1; orderIndex >= 0; orderIndex--) {
                const id = topoOrder[orderIndex]
                let depth = 0
                for (const to of outgoing.get(id) || []) depth = Math.max(depth, 1 + (remainingDepth.get(to) || 0))
                remainingDepth.set(id, depth)
              }
              const used = new Set()
              roots.sort((a, b) => (remainingDepth.get(b) || 0) - (remainingDepth.get(a) || 0) || String(a).localeCompare(String(b)))
              for (const root of roots) {
                if (used.has(root)) continue
                const path = []
                let cursor = root
                while (cursor && !used.has(cursor)) {
                  path.push(cursor)
                  used.add(cursor)
                  const next = (outgoing.get(cursor) || [])
                    .filter((to) => !used.has(to))
                    .sort((a, b) => (remainingDepth.get(b) || 0) - (remainingDepth.get(a) || 0) || String(a).localeCompare(String(b)))[0]
                  cursor = next || null
                }
                if (path.length >= 3) backbonePaths.push(path)
              }
            }`,
  'backbone extraction',
)

layered = replaceOnce(
  layered,
  `        return placeLevels()`,
  `        const placed = placeLevels()
        if (backbonePaths.length === 0) return placed

        // Keep every substantial reasoning backbone in a stable vertical lane.
        // Shift an entire visual row rather than one node, preserving the row
        // geometry and the existing orthogonal edge-router assumptions.
        const backboneLane = new Map()
        const laneGap = Math.max(LAYER_X_GAP * 2, 360)
        const laneMid = (backbonePaths.length - 1) / 2
        backbonePaths.forEach((path, laneIndex) => {
          const laneX = (laneIndex - laneMid) * laneGap
          for (const id of path) backboneLane.set(id, laneX)
        })
        const rowIds = new Map()
        for (const node of nodes) {
          const p = placed.get(node.id)
          if (!p) continue
          const list = rowIds.get(p.y) || []
          list.push(node.id)
          rowIds.set(p.y, list)
        }
        for (const ids of rowIds.values()) {
          const anchors = ids.filter((id) => backboneLane.has(id))
          if (anchors.length === 0) continue
          const shift = anchors.reduce((sum, id) => {
            const p = placed.get(id)
            return sum + backboneLane.get(id) - p.x
          }, 0) / anchors.length
          for (const id of ids) placed.get(id).x += shift
        }

        // Examples/analogies/definitions/concept branches stay next to the
        // backbone node they explain. They remain ordinary graph nodes; this is
        // only a view projection and resolveLayeredOverlaps handles collisions.
        const branchRelations = new Set(['example', 'counter_example', 'analogy', 'defines', 'is_a', 'contains'])
        const branchCount = new Map()
        for (const edge of edges) {
          if (!edge || !branchRelations.has(edge.relation)) continue
          const fromIsBackbone = backboneLane.has(edge.fromNodeId)
          const toIsBackbone = backboneLane.has(edge.toNodeId)
          if (fromIsBackbone === toIsBackbone) continue
          const targetId = fromIsBackbone ? edge.fromNodeId : edge.toNodeId
          const branchId = fromIsBackbone ? edge.toNodeId : edge.fromNodeId
          const target = placed.get(targetId)
          const branch = placed.get(branchId)
          if (!target || !branch) continue
          const count = branchCount.get(targetId) || 0
          const side = count % 2 === 0 ? -1 : 1
          const ring = Math.floor(count / 2) + 1
          const targetSize = sizes.get(targetId)
          const branchSize = sizes.get(branchId)
          const distance = Math.max(
            LAYER_X_GAP * 0.72,
            ((targetSize ? targetSize.w : 170) + (branchSize ? branchSize.w : 170)) / 2 + 24,
          )
          branch.x = target.x + side * distance * ring
          branchCount.set(targetId, count + 1)
        }
        return placed`,
  'lane projection',
)

client = client.slice(0, found.start) + layered + client.slice(found.end)
writeFileSync(clientPath, client)

const testPath = 'scripts/kg-semantic-layout-smoke.mjs'
let test = readFileSync(testPath, 'utf8')
test = replaceOnce(
  test,
  `for (const [from, to] of [['a','b'],['b','c'],['c','d'],['d','e']]) {
  assert(pos.get(from).y < pos.get(to).y, 'reasoning chain is not monotonic: ' + from + ' -> ' + to + ' / ' + JSON.stringify({ from: pos.get(from), to: pos.get(to) }))
}
assert(pos.get('x').y < pos.get('c').y, 'analogy satellite was not placed as a branch near its target')`,
  `for (const [from, to] of [['a','b'],['b','c'],['c','d'],['d','e']]) {
  assert(pos.get(from).y < pos.get(to).y, 'reasoning chain is not monotonic: ' + from + ' -> ' + to + ' / ' + JSON.stringify({ from: pos.get(from), to: pos.get(to) }))
}
const chainX = ['a','b','c','d','e'].map((id) => pos.get(id).x)
assert(Math.max(...chainX) - Math.min(...chainX) < 1, 'reasoning backbone did not stay in one vertical lane: ' + JSON.stringify(chainX))
const satelliteDistance = Math.abs(pos.get('x').x - pos.get('c').x)
assert(pos.get('x').y < pos.get('c').y, 'analogy satellite was not placed as a branch near its target')
assert(satelliteDistance >= 120 && satelliteDistance <= 280, 'analogy satellite is not a nearby side branch: ' + satelliteDistance)`,
  'semantic layout assertions',
)
writeFileSync(testPath, test)

console.log(JSON.stringify({ ok: true, changed: [clientPath, testPath] }))
