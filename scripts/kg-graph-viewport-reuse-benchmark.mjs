import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

// Exercise the generated production scene, not a duplicate cache algorithm.
// Element, excerpt and Map counts include the new viewport-cache maintenance.
// Timing includes this instrumentation and excludes DOM/browser drawing.
const baseline = process.argv.slice(2).find(arg => !arg.startsWith('--'))
const smoke = process.argv.includes('--smoke')
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const sources = [['current', viewer]]
if (baseline) sources.unshift([baseline, execFileSync('git', ['show', baseline + ':extension/viewer.js'], {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
})])
const all = (element, predicate) => Array.isArray(element) ? element.flatMap(child => all(child, predicate))
  : !element || typeof element !== 'object' ? []
    : [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
const byClass = name => element => element.props?.className?.split(' ').includes(name)

function fixture(source, zoomSteps, width = 900, height = 600) {
  let cursor = 0, work
  const reset = () => { work = { elements: 0, nodeShells: 0, nodeLabels: 0, excerptReads: 0, nodeReads: 0, mapCreates: 0, mapGets: 0, mapSets: 0 } }
  reset()
  const slots = [], frames = new Map()
  let nextFrame = 0
  const slot = init => { const index = cursor++; return slots[index] ||= init() }
  const React = {
    createElement(type, props, ...children) {
      work.elements++
      if (props?.className === 'kg-node') work.nodeShells++
      if (props?.className === 'kg-node-name') work.nodeLabels++
      return { type, props: { ...props, children } }
    },
    useState(initial) {
      const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [state.value, next => { state.value = typeof next === 'function' ? next(state.value) : next }]
    },
    useRef(initial) { return slot(() => ({ current: initial })) },
    useMemo(fn, deps) {
      const memo = slot(() => ({}))
      if (!memo.deps || deps.some((dep, i) => !Object.is(dep, memo.deps[i]))) { memo.value = fn(); memo.deps = deps }
      return memo.value
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useEffect() {},
  }
  class CountedMap extends Map {
    constructor(...args) { super(...args); work.mapCreates++ }
    get(key) { work.mapGets++; return super.get(key) }
    set(key, value) { work.mapSets++; return super.set(key, value) }
  }
  const environment = { window: { React }, console, Map: CountedMap,
    requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id },
    cancelAnimationFrame: id => frames.delete(id),
    document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 10 }) }) }) },
  }
  runInNewContext(source.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene, layoutOverview, computeBBox,'), environment)
  const { GraphScene, layoutOverview, computeBBox } = environment.window.KGViewer
  const evidence = 'Full source evidence, including its condition and boundary. '.repeat(80)
  const nodes = new Proxy(Array.from({ length: 12000 }, (_, i) => ({ id: 'n' + i, type: 'claim', text: 'Node ' + i, paragraph: i,
    get quote() { work.excerptReads++; return evidence + i },
  })), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) work.nodeReads++
      return Reflect.get(target, key, receiver)
    },
  })
  const sizes = new CountedMap(nodes.map(node => [node.id, { w: 200, h: 100, lines: ['first', 'second', 'third', 'fourth'] }]))
  const layout = layoutOverview(nodes, sizes)
  const props = { nodes, edges: [], anchors: Object.fromEntries(nodes.map((node, i) => [node.id, i])),
    selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 }, layoutMode: 'overview',
    ctx: { timeout: () => () => {} }, onSelectNode() {}, onSelectEdge() {}, onReady() {}, onLayoutModeChange() {},
    prepared: { sizes, layout, bbox: computeBBox(nodes, layout, sizes), edgeLanes: new CountedMap(), layeredEdgeGeometry: new CountedMap() } }
  const captures = new Set()
  const container = { clientWidth: width, clientHeight: height, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id), contains: () => false }
  let tree
  const render = () => { cursor = 0; tree = GraphScene(props); return tree }
  const viewport = () => all(tree, byClass('kg-graph-viewport'))[0]
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); render() }
  const click = label => { all(tree, item => item.type === 'button' && item.props['aria-label'] === label)[0].props.onClick(); flush() }
  const pointer = (name, x = 0, y = 0) => { viewport().props[name]({ button: 0, pointerId: 1, clientX: x, clientY: y,
    target: { closest: () => null } }); name === 'onPointerDown' ? render() : flush() }
  const panStart = () => pointer('onPointerDown')
  const pan = (x, y) => pointer('onPointerMove', x, y)
  const panEnd = (x, y) => pointer('onPointerUp', x, y)
  render(); viewport().props.ref.current = container
  click('重置缩放为 100%')
  for (let i = 0; i < zoomSteps; i++) click('缩小（10%）')
  const transform = all(tree, item => item.type === 'g' && item.props.style?.transform)[0].props.style.transform
  const [tx, ty] = transform.match(/translate\(([-\d.eE+]+)px, ([-\d.eE+]+)px\)/).slice(1).map(Number)
  panStart(); pan(110 - tx, 110 - ty); panEnd(110 - tx, 110 - ty)
  const nodeElements = () => all(tree, byClass('kg-node'))
  const measure = run => { reset(); const start = performance.now(); run(); return { ...work, ms: +(performance.now() - start).toFixed(3) } }
  // Observe live cache sizes as well as re-entry reads: a long pan must release
  // old viewport entries, not accumulate the full graph in an extra cache.
  const cacheSizes = () => slots.filter(slot => slot.value?.entries instanceof CountedMap).map(slot => slot.value.entries.size)
  return { props, container, render, click, panStart, pan, panEnd, measure, nodeElements, cacheSizes,
    badges: () => all(tree, byClass('kg-node-issue-badge')), evidence }
}

function run(source, zoomSteps, current) {
  const f = fixture(source, zoomSteps), samples = [], snapshots = []
  const sample = (name, action) => {
    const before = new Map(f.nodeElements().map(node => [node.props['data-node-id'], node]))
    const metrics = f.measure(action)
    const after = f.nodeElements(), retained = after.filter(node => before.has(node.props['data-node-id']))
    const entering = after.length - retained.length
    if (current) {
      assert.equal(metrics.nodeShells, entering, 'Only entering nodes rebuild their shells: ' + name)
      assert.equal(metrics.excerptReads, entering, 'Retained nodes do not reread source evidence: ' + name)
      for (const node of retained) assert.equal(node, before.get(node.props['data-node-id']), name + ' preserves retained subtrees')
      assert.deepEqual(f.cacheSizes().sort((a, b) => a - b), [zoomSteps > 9 ? 0 : after.length, after.length].sort((a, b) => a - b),
        'Both metadata caches stay bounded to the current viewport')
    }
    assert.equal(metrics.nodeReads, 0, 'Camera updates do not traverse the canonical node array')
    samples.push({ name, before: before.size, after: after.length, retained: retained.length, entering,
      rebuiltRetained: retained.filter(node => node !== before.get(node.props['data-node-id'])).length, ...metrics })
    // Include complete evidence, labels, geometry, styles and accessibility;
    // callbacks have separate live-action assertions below.
    snapshots.push(JSON.stringify(after))
  }
  f.panStart()
  sample('same-window', () => f.pan(1, 1))
  sample('cross-two-axes', () => f.pan(-300, -200))
  sample('cross-next-column', () => f.pan(-450, -200))
  sample('return-to-origin', () => f.pan(1, 1))
  sample('distant-window', () => f.pan(-2400, -1500))
  sample('re-enter-evicted-window', () => f.pan(1, 1))
  f.panEnd(1, 1)
  sample('resize-wider', () => { f.container.clientWidth = 1600; f.render() })
  // This step stays on the same side of the 35% detail threshold.
  sample('zoom-in', () => f.click('放大（10%）'))
  const actions = []
  const retained = f.nodeElements()[0]
  f.props.onSelectNode = id => actions.push(id)
  const callbacks = f.measure(f.render)
  assert.equal(f.nodeElements()[0], retained)
  retained.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  retained.props.onClick({ stopPropagation() {} })
  assert.deepEqual(actions, [retained.props['data-node-id'], retained.props['data-node-id']])
  assert(retained.props['aria-label'].endsWith(f.evidence + retained.props['data-node-id'].slice(1)))
  return { zoomSteps, samples, snapshots, callbacks }
}

function invalidation(source) {
  const f = fixture(source, 0)
  f.panStart(); f.pan(-300, -200); f.panEnd(-300, -200)
  const retained = f.nodeElements()[0], id = retained.props['data-node-id']
  f.props.anchors = { ...f.props.anchors, [id]: null }
  f.render()
  let node = f.nodeElements()[0]
  assert.notEqual(node, retained)
  assert(node.props['aria-label'].endsWith('，无法定位来源'))
  const opened = []
  f.props.issueReport = { issues: [{ id: 'issue', targetKind: 'node', targetId: id, status: 'open', severity: 'error' }] }
  f.props.onOpenNodeIssues = () => opened.push('old')
  f.render()
  assert.equal(f.badges().length, 1)
  const badge = f.badges()[0]
  f.props.onOpenNodeIssues = value => opened.push(value.id)
  f.render(); assert.equal(f.badges()[0], badge)
  badge.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(opened, [id])
  f.props.issueReport = { issues: [] }; f.render(); assert.equal(f.badges().length, 0)
  const nextPositions = new Map(f.props.prepared.layout.pos)
  const point = nextPositions.get(id)
  nextPositions.set(id, { ...point, x: point.x + 5 })
  f.props.prepared = { ...f.props.prepared, layout: { pos: nextPositions } }; f.render()
  node = f.nodeElements().find(node => node.props['data-node-id'] === id)
  assert.equal(all(node, item => item.type === 'rect')[0].props.x, point.x + 5 - 100)
  const nextSizes = new Map(f.props.prepared.sizes)
  nextSizes.set(id, { w: 210, h: 110, lines: ['new measured label'] })
  f.props.prepared = { ...f.props.prepared, sizes: nextSizes }; f.render()
  node = f.nodeElements().find(node => node.props['data-node-id'] === id)
  assert.equal(all(node, item => item.type === 'rect')[0].props.width, 210)
  assert(JSON.stringify(node).includes('new measured label'))
  f.props.nodes = f.props.nodes.map(node => node.id === id ? { ...node, text: 'Replaced node text', quote: 'Replaced source evidence' } : node)
  f.props.anchors = { ...f.props.anchors, [id]: 0 }; f.render()
  node = f.nodeElements().find(node => node.props['data-node-id'] === id)
  assert(node.props['aria-label'].endsWith('Replaced source evidence'))
  assert(node.props['aria-label'].includes('Replaced node text'))
  const paragraph = f.props.nodes.find(node => node.id === id).paragraph
  f.props.visualSource = { images: [{ id: 'transcript', startParagraph: paragraph, endParagraph: paragraph, interpretationStatus: 'ai_unverified' }] }
  f.render()
  assert(f.nodeElements().find(node => node.props['data-node-id'] === id).props['aria-label'].includes('AI 视觉转写摘录，非原书文字'))
  f.props.visualSource = { images: [] }; f.render()
  assert(!f.nodeElements().find(node => node.props['data-node-id'] === id).props['aria-label'].includes('AI 视觉转写'))
  return { anchors: true, issues: true, liveBadgeAction: true, layout: true, sizes: true, nodeIdentity: true, sourceMetadata: true }
}

const results = sources.map(([version, source]) => ({ version,
  scenarios: [0, 9, 11].map(steps => run(source, steps, version === 'current')),
  invalidation: invalidation(source),
}))
if (results.length === 2) for (let i = 0; i < 3; i++) assert.deepEqual(results[1].scenarios[i].snapshots, results[0].scenarios[i].snapshots,
  'Old/new camera windows preserve complete SVG node content at each step')
for (const result of results) for (const scenario of result.scenarios) delete scenario.snapshots
console.log(JSON.stringify({ ok: true, totalNodes: 12000, smoke, exactNodeContentParity: results.length === 2,
  countsIncludeCacheMaintenance: true, timingIncludesCounters: true, results }))
