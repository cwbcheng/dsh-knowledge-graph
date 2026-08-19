import { readFileSync, writeFileSync } from 'node:fs'

const clientPath = 'src/index.client.js'
const testPath = 'scripts/kg-semantic-layout-smoke.mjs'
let client = readFileSync(clientPath, 'utf8')
let test = readFileSync(testPath, 'utf8')

const earlyReturn = `        const placed = placeLevels()\n        if (backbonePaths.length === 0) return placed\n\n        // Keep every substantial reasoning backbone in a stable vertical lane.\n`
const noEarlyReturn = `        const placed = placeLevels()\n\n        // Keep every substantial reasoning backbone in a stable vertical lane.\n`
if (client.split(earlyReturn).length !== 2) throw new Error('backbone early-return target mismatch')
client = client.replace(earlyReturn, noEarlyReturn)

const oldTail = `        if (pinnedXOut && typeof pinnedXOut.set === 'function') {
          if (typeof pinnedXOut.clear === 'function') pinnedXOut.clear()
          for (const [id, laneX] of backboneLane) if (placed.has(id)) pinnedXOut.set(id, laneX)
        }
        return placed
`
const newTail = `        // Strong local semantic relations should look local too. This pass is
        // view-only: it preserves y/rank and never changes graph semantics.
        // causes/infers are handled by reasoning lanes; supports/driven_by/
        // aims_at stay free to span larger conceptual distances.
        const strongLocalRelations = new Set(['defines', 'contains', 'is_a', 'analogy', 'example', 'counter_example'])
        const localMoved = new Set()
        const localGap = 22
        const localRadius = 260
        const rowPeers = (id) => {
          const p = placed.get(id)
          if (!p) return []
          return nodes.filter((node) => node.id !== id && placed.has(node.id) && placed.get(node.id).y === p.y)
        }
        const slotFree = (id, x) => {
          const s = sizes.get(id)
          const half = (s ? s.w : 170) / 2
          return rowPeers(id).every((peer) => {
            const pp = placed.get(peer.id)
            const ps = sizes.get(peer.id)
            const peerHalf = (ps ? ps.w : 170) / 2
            return x + half + localGap <= pp.x - peerHalf || x - half - localGap >= pp.x + peerHalf
          })
        }
        for (const edge of edges) {
          if (!edge || !strongLocalRelations.has(edge.relation)) continue
          if (backboneLane.has(edge.fromNodeId) || backboneLane.has(edge.toNodeId)) continue
          let anchorId = edge.toNodeId
          let moverId = edge.fromNodeId
          if (edge.relation === 'contains') { anchorId = edge.fromNodeId; moverId = edge.toNodeId }
          if (localMoved.has(moverId)) continue
          const anchor = placed.get(anchorId)
          const mover = placed.get(moverId)
          if (!anchor || !mover) continue
          const dx = Math.abs(mover.x - anchor.x)
          if (dx <= localRadius) continue
          const preferredSide = mover.x < anchor.x ? -1 : 1
          const candidates = [anchor.x]
          for (let offset = 24; offset <= localRadius; offset += 24) {
            candidates.push(anchor.x + preferredSide * offset)
            candidates.push(anchor.x - preferredSide * offset)
          }
          const chosen = candidates.find((x) => slotFree(moverId, x))
          if (chosen == null) continue
          mover.x = chosen
          localMoved.add(moverId)
        }
        if (pinnedXOut && typeof pinnedXOut.set === 'function') {
          if (typeof pinnedXOut.clear === 'function') pinnedXOut.clear()
          for (const [id, laneX] of backboneLane) if (placed.has(id)) pinnedXOut.set(id, laneX)
        }
        return placed
`
if (client.split(oldTail).length !== 2) throw new Error('layout tail target mismatch')
client = client.replace(oldTail, newTail)

const oldNodes = `const nodes = ['a','b','c','d','e','x','p','q'].map((id) => ({ id }))`
const newNodes = `const nodes = [
  ...['a','b','c','d','e','x','p','q'].map((id) => ({ id, type: 'claim' })),
  { id: 'system', type: 'concept' },
  { id: 'flow', type: 'rule' },
  { id: 'far', type: 'claim' },
]`
if (!test.includes(oldNodes)) throw new Error('semantic layout node fixture target mismatch')
test = test.replace(oldNodes, newNodes)

const oldEdges = `  { fromNodeId: 'p', toNodeId: 'q', relation: 'supports' },
]`
const newEdges = `  { fromNodeId: 'p', toNodeId: 'q', relation: 'supports' },
  { fromNodeId: 'system', toNodeId: 'flow', relation: 'contains' },
  { fromNodeId: 'far', toNodeId: 'system', relation: 'supports' },
]`
if (!test.includes(oldEdges)) throw new Error('semantic layout edge fixture target mismatch')
test = test.replace(oldEdges, newEdges)

const marker = `const pos = resolveLayeredOverlaps(nodes, sizes, rawPos, 18, pinnedX)\n`
const assertions = `const localDistance = Math.abs(pos.get('flow').x - pos.get('system').x)
assert(localDistance <= 260, 'strong local contains relation was not attracted near its anchor: ' + localDistance)
assert(source.includes("const strongLocalRelations = new Set(['defines', 'contains', 'is_a', 'analogy', 'example', 'counter_example'])"), 'strong local relation set is missing or widened')
assert(source.includes('const localRadius = 260'), 'local attraction must stay bounded')
assert(!source.includes("strongLocalRelations = new Set(['supports'"), 'supports must not become a strong local attraction relation')
`
if (!test.includes(marker)) throw new Error('semantic layout assertion insertion target mismatch')
test = test.replace(marker, marker + assertions)

const layeredSourceMarker = `const layeredSource = extractFunction(source, 'layoutLayered')\n`
const extraAssertion = `assert(!layeredSource.includes('if (backbonePaths.length === 0) return placed'), 'strong local attraction is incorrectly gated on a reasoning backbone')\n`
if (!test.includes(layeredSourceMarker)) throw new Error('layered source assertion target mismatch')
test = test.replace(layeredSourceMarker, layeredSourceMarker + extraAssertion)

writeFileSync(clientPath, client)
writeFileSync(testPath, test)
console.log(JSON.stringify({ ok: true, changed: [clientPath, testPath] }))
