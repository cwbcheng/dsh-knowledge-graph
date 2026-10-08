// Optional before/after diagnostic of the generated production scene.
// node scripts/kg-graph-node-selection-benchmark.mjs [baseline-git-revision]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

const revision = process.argv[2]
if (revision?.startsWith('-')) throw new Error('Expected a git revision')
const bundle = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const metrics = []
for (let trial = 0; trial < 5; trial++) {
  let owner, cursor = 0, shells = 0, excerptReads = 0
  const slot = initial => { const index = cursor++; return owner.slots[index] ||= initial() }
  const React = {
    createElement(type, props, ...children) {
      if (props?.className === 'kg-node') shells++
      return { type, props: { ...props, children } }
    },
    useState(initial) {
      const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value }]
    },
    useRef: initial => slot(() => ({ current: initial })),
    useMemo(fn, deps) {
      const memo = slot(() => ({}))
      if (!memo.deps || deps.some((value, i) => !Object.is(value, memo.deps[i]))) { memo.value = fn(); memo.deps = deps }
      return memo.value
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useEffect() {},
  }
  const environment = { window: { React }, console, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 10 }) }) }) } }
  runInNewContext(bundle.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene, layoutOverview, computeBBox,'), environment)
  const { GraphScene, layoutOverview, computeBBox } = environment.window.KGViewer
  const count = 12000, filler = '合成摘录，保留完整证据。'.repeat(80)
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, type: i % 3 ? 'fact' : 'concept', text: 'Node ' + i,
    get quote() { excerptReads++; return filler + ' quote ' + i } }))
  const edges = nodes.slice(1).map((node, i) => ({ fromNodeId: 'n' + i, toNodeId: node.id, relation: 'supports' }))
  const sizes = new Map(nodes.map(node => [node.id, { w: 200, h: 100, lines: [node.text] }]))
  const layout = layoutOverview(nodes, sizes), anchors = Object.fromEntries(nodes.map(node => [node.id, 0]))
  const hooks = { slots: [] }, events = []
  const props = { nodes, edges, anchors, selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 },
    ctx: { timeout: () => () => {} }, onSelectNode() {}, onSelectEdge() {}, onReady() {}, onLayoutModeChange() {},
    prepared: { sizes, layout, bbox: computeBBox(nodes, layout, sizes), edgeLanes: new Map(), layeredEdgeGeometry: new Map() }, layoutMode: 'overview' }
  const render = id => { owner = hooks; cursor = 0; return GraphScene({ ...props, selectedNodeId: id, onSelectNode: value => events.push([id, value]) }) }
  const all = (tree, predicate) => Array.isArray(tree) ? tree.flatMap(item => all(item, predicate))
    : !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)]
  render(null); render('n6000')
  shells = 0; excerptReads = 0
  let tree, elapsed = 0
  for (const id of ['n6001', 'n6002', 'n6003', 'n6004']) {
    const start = performance.now(); tree = render(id); elapsed += performance.now() - start
    const selected = all(tree, item => item.props?.className === 'kg-node' && item.props['aria-pressed'])
    assert.deepEqual(selected.map(item => item.props['data-node-id']), [id])
  }
  const reused = all(tree, item => item.props?.className === 'kg-node' && item.props['data-node-id'] === 'n10')[0]
  reused.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(events, [['n6004', 'n10']], 'Retained nodes must use the latest parent callback')
  assert.equal(all(tree, item => item.props?.className === 'kg-node').length, count)
  assert(reused.props['aria-label'].endsWith(filler + ' quote 10'), 'Full accessible evidence is preserved')
  metrics.push({ shells, excerptReads, elapsed })
}
assert(metrics.every(item => item.shells === metrics[0].shells && item.excerptReads === metrics[0].excerptReads))
console.log(JSON.stringify({ baseline: revision || 'current', graphNodes: 12000, trials: metrics.length, consecutiveSelections: 4,
  rebuiltNodeShells: metrics[0].shells, excerptReads: metrics[0].excerptReads,
  sceneRenderMedianMs: Math.round(median(metrics.map(item => item.elapsed)) * 100) / 100,
  fullEvidenceAndLatestCallbacks: true }))
