// Compare the generated production scene with an optional baseline revision.
// node scripts/kg-graph-image-benchmark.mjs [baseline-git-revision]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

const revision = process.argv[2]
if (revision?.startsWith('-')) throw new Error('Expected a git revision')
const viewer = revision ? execFileSync('git', ['show', revision + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

for (const [count, imageCount] of [[803, 14], [12000, 200]]) {
  const trials = []
  for (let trial = 0; trial < 5; trial++) {
    let current, cursor = 0, imageReads = 0
    const slot = initial => { const index = cursor++; return current.slots[index] ||= initial() }
    const React = {
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useState(initial) {
        const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
        return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value }]
      },
      useRef: initial => slot(() => ({ current: initial })),
      useMemo(fn, deps) {
        const memo = slot(() => ({}))
        if (!memo.deps || deps.some((dep, i) => !Object.is(dep, memo.deps[i]))) { memo.value = fn(); memo.deps = deps }
        return memo.value
      },
      useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
      useEffect() {},
    }
    const environment = { window: { React }, console, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
      document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 8 }) }) }) } }
    runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene,'), environment)
    const { GraphScene } = environment.window.KGViewer
    const originals = Array.from({ length: imageCount }, (_, i) => ({ id: '原图:' + i, caption: 'Original ' + i,
      interpretationStatus: i % 2 ? 'not_requested' : 'ai_unverified', startParagraph: i * 50, endParagraph: i * 50 + 24 }))
    const images = new Proxy(originals, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) imageReads++
      return Reflect.get(target, key, receiver)
    } })
    const nodes = Array.from({ length: count }, (_, i) => ({ id: i < imageCount ? 'image:' + encodeURIComponent(originals[i].id) : 'n' + i,
      type: i < imageCount ? 'image' : 'fact', text: 'Node ' + i, quote: 'Synthetic evidence ' + i, paragraph: i }))
    const sizes = new Map(nodes.map(node => [node.id, { w: 200, h: 180, lines: [node.text] }]))
    const layout = { pos: new Map(nodes.map((node, i) => [node.id, { x: i % 100 * 240, y: Math.floor(i / 100) * 220 }])) }
    const visualSource = { kind: 'markdown-assets', images }, before = JSON.stringify({ nodes, images: originals })
    const props = { nodes, edges: [], visualSource, anchors: Object.fromEntries(nodes.map(node => [node.id, 0])),
      selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 }, onSelectNode() {}, onSelectEdge() {},
      onReady() {}, onLayoutModeChange() {}, ctx: { timeout: () => () => {} }, layoutMode: 'layered',
      prepared: { sizes, layout, bbox: { w: 24000, h: 26400, cx: 0, cy: 0 }, edgeLanes: new Map(), layeredEdgeGeometry: new Map() },
      renderSourceImage: image => React.createElement('span', { 'data-image': image.id }, image.caption) }
    // GraphViewer normally calls makeView first to register image type metadata.
    environment.window.KGViewer.makeView({ nodes: [], edges: [], source: { visualSource } }, '')
    const hooks = { slots: [] }
    const render = () => { current = hooks; cursor = 0; return GraphScene(props) }
    imageReads = 0
    const started = performance.now(), scene = render(), firstRenderMs = performance.now() - started
    const firstImageReads = imageReads
    const walk = tree => Array.isArray(tree) ? tree.flatMap(walk) : !tree || typeof tree !== 'object' ? []
      : [tree, ...walk(tree.props?.children)]
    const renderedNodes = walk(scene).filter(element => element.props?.className === 'kg-node')
    assert.equal(renderedNodes.length, count)
    assert.equal(renderedNodes.filter(element => element.props['aria-label'].includes('保留原图')).length, imageCount)
    assert.equal(walk(scene).filter(element => element.props?.['data-image']).length, imageCount)
    assert(renderedNodes.slice(imageCount).some(element => element.props['aria-label'].includes('AI 视觉转写摘录')))
    const labels = renderedNodes.map(element => element.props['aria-label'])
    const expected = nodes.map(node => node.type === 'image' ? '图片节点：' + node.text + '，保留原图'
      : '事实节点：' + node.text + '，' + (originals.some(image => image.interpretationStatus === 'ai_unverified' &&
        node.paragraph >= image.startParagraph && node.paragraph <= image.endParagraph) ? 'AI 视觉转写摘录，非原书文字：' : '原文摘录：') + node.quote)
    assert.deepEqual(labels, expected, 'Every accessible source classification must match the original lookup')
    imageReads = 0; render()
    assert.equal(imageReads, 0, 'Unchanged metadata must not be scanned on a retained scene')
    assert.equal(JSON.stringify({ nodes, images: originals }), before)
    trials.push({ firstRenderMs, firstImageReads })
  }
  assert(trials.every(value => value.firstImageReads === trials[0].firstImageReads))
  console.log(JSON.stringify({ baseline: revision || 'current', graphNodes: count, images: imageCount,
    trials: trials.length, firstRenderImageReads: trials[0].firstImageReads,
    firstRenderMedianMs: Math.round(median(trials.map(value => value.firstRenderMs)) * 100) / 100,
    exactSourceLabels: true, unchangedData: true }))
}
