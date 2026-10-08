import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Drive the generated scene's real search controls, and count text work in its
// own JS realm. Unrelated SVG/label reads cannot inflate this search metric.
let cursor = 0
const slots = [], frames = new Map(), timers = new Map(), effects = [], taskBreaks = []
let nextFrame = 0, nextTimer = 0, dirty = false, clock = 0
const slot = init => slots[cursor++] ||= init()
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) {
    const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => {
      const value = typeof next === 'function' ? next(state.value) : next
      if (!Object.is(value, state.value)) { state.value = value; dirty = true }
    }]
  },
  useRef(initial) { return slot(() => ({ current: initial })) },
  useMemo(fn, deps) {
    const memo = slot(() => ({}))
    if (!memo.deps || deps.some((dep, i) => !Object.is(dep, memo.deps[i]))) { memo.value = fn(); memo.deps = deps }
    return memo.value
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
  useEffect(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((dep, i) => !Object.is(dep, state.deps[i]))) {
      effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const textWork = { nodes: 0, characters: 0 }
const environment = { window: { React }, console, textWork, AbortController, DOMException,
  performance: { now: () => clock },
  textCost() { clock += 0.25 },
  setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id },
  clearTimeout: id => timers.delete(id),
  requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id },
  cancelAnimationFrame: id => frames.delete(id),
  document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 8 }) }) }) },
}
runInNewContext(`const normalize = String.prototype.normalize;
  String.prototype.normalize = function(form) {
    if (form === 'NFKC' && this.includes('\\n')) { textWork.nodes++; textWork.characters += this.length; textCost(); }
    return normalize.call(this, form);
  };`, environment)
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { GraphScene, layoutOverview, computeBBox, createGraphNodeSearch,'), environment)
const { GraphScene, layoutOverview, computeBBox, createGraphNodeSearch } = environment.window.KGViewer
const all = (element, predicate) => Array.isArray(element) ? element.flatMap(child => all(child, predicate))
  : !element || typeof element !== 'object' ? []
    : [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
const byClass = name => element => element.props?.className?.split(' ').includes(name)
const nodes = Array.from({ length: 12000 }, (_, i) => ({
  id: i === 5999 ? 'exact>id ' : 'n' + i, type: i % 3 ? 'fact' : 'concept', text: 'Node ' + i,
  quote: '合成摘录，保留完整证据。'.repeat(80) + ' Unique quote ' + i,
}))
const original = JSON.stringify(nodes)
const sizes = new Map(nodes.map(node => [node.id, { w: 200, h: 100, lines: [node.text] }]))
const layout = layoutOverview(nodes, sizes)
const props = { nodes, edges: [], anchors: {}, selectedNodeId: null, selectedEdgeId: null, focusReq: { seq: 0 },
  ctx: { timeout: () => () => {} }, onReady() {}, onLayoutModeChange() {},
  onSelectNode(id) { props.selectedNodeId = id; props.selectedEdgeId = null },
  onSelectEdge(id) { props.selectedEdgeId = id; props.selectedNodeId = null },
  prepared: { sizes, layout, bbox: computeBBox(nodes, layout, sizes), edgeLanes: new Map(), layeredEdgeGeometry: new Map() },
  layoutMode: 'overview' }
const viewportElement = { clientWidth: 900, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0 }),
  addEventListener() {}, removeEventListener() {} }
let tree
const render = () => {
  for (let pass = 0; pass < 20; pass++) {
    cursor = 0; dirty = false; tree = GraphScene(props)
    all(tree, byClass('kg-graph-viewport'))[0].props.ref.current = viewportElement
    effects.splice(0).forEach(fn => fn())
    if (!dirty) return tree
  }
  throw new Error('Render did not settle')
}
const runTimer = () => {
  const [id, timer] = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0]
  timers.delete(id); taskBreaks.push(textWork.nodes); timer.fn()
}
const flush = async () => {
  for (let pass = 0; pass < 1000; pass++) {
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn())
    await Promise.resolve(); await Promise.resolve(); render()
    if (timers.size) { runTimer(); continue }
    if (!frames.size && !dirty) return
  }
  throw new Error('Async search did not settle')
}
const click = async label => { all(tree, item => item.type === 'button' && item.props['aria-label'] === label)[0].props.onClick(); render(); await flush() }
const searchInput = () => all(tree, item => item.type === 'input' && item.props.type === 'search')[0]
const changeQuery = value => { searchInput().props.onChange({ target: { value } }); render() }
const query = async value => { changeQuery(value); await flush() }
const changeType = value => { all(tree, item => item.type === 'select' && item.props['aria-label'] === '查找节点类型')[0].props.onChange({ target: { value } }); render() }
const type = async value => { changeType(value); await flush() }
const results = () => all(tree, byClass('kg-node-search-result')).map(item => item.props['data-node-id'])
const resultsCount = () => all(tree, byClass('kg-node-search-count'))[0].props.children[0]
// Independent oracle preserves the existing NFKC, case, type and ordering
// contract; it must not read the implementation's cached normalized strings.
const expected = (value, nodeType = '', input = nodes) => {
  const normalized = value.trim().normalize('NFKC').toLocaleLowerCase()
  return input.filter(node => (!nodeType || node.type === nodeType) &&
    (!normalized || [node.id, node.text, node.quote].join('\n').normalize('NFKC').toLocaleLowerCase().includes(normalized)))
}
const check = (value, nodeType = '', input = nodes) => {
  const matches = expected(value, nodeType, input)
  assert.equal(resultsCount(), matches.length + ' 个匹配 · 当前视图 ' + input.length + ' 个节点')
  assert.deepEqual(results(), matches.slice(0, 20).map(node => node.id))
}

// Independent synchronous baseline uses the same matching/cache contract. Its
// complete cold text work occupies one task; time costs below are simulated.
const baseline = createGraphNodeSearch(nodes).find('unique quote 11999', 'fact')
assert.deepEqual(Array.from(baseline, node => node.id), ['n11999'])
const baselineNormalizedPerTask = textWork.nodes
assert.equal(baselineNormalizedPerTask, 8000)
textWork.nodes = 0; textWork.characters = 0; clock = 0

render(); await click('重置缩放为 100%')
const initialWork = { ...textWork }
console.log(JSON.stringify({ graphNodes: nodes.length, searchClosed: true, normalizedNodes: initialWork.nodes, normalizedCharacters: initialWork.characters }))
assert.equal(initialWork.nodes, 0, 'Initial graph loading must not normalize every quote for a closed search panel')
await click('查找节点'); check('')
assert.equal(textWork.nodes, 0, 'Opening an empty search needs only node references, not normalized text')
await type('fact'); check('', 'fact')
await click('下一页匹配节点')
assert.deepEqual(results(), expected('', 'fact').slice(20, 40).map(node => node.id))
assert.equal(textWork.nodes, 0, 'Blank queries, type filtering and pagination do not need text normalization')
changeQuery('obsolete query')
assert.equal(textWork.nodes, 0, 'The first input render cannot synchronously normalize quotes')
assert.equal(resultsCount(), '正在查找…')
assert.equal(all(tree, byClass('kg-node-search-count'))[0].props['aria-busy'], true)
assert.equal(results().length, 0, 'Pending input hides stale blank-query results')
searchInput().props.onKeyDown({ key: 'Enter', preventDefault() { assert.fail('Pending search cannot navigate') } })
assert.equal(props.selectedNodeId, null)
runTimer(); await Promise.resolve()
assert(textWork.nodes > 0 && textWork.nodes < 8000, 'The cold query yields before finishing the graph')
const cancelledWork = textWork.nodes, staleCallback = [...timers.values()][0].fn
changeQuery('  ＵＮＩＱＵＥ ｑｕｏｔｅ １１９９９  ')
staleCallback(); await Promise.resolve()
assert.equal(textWork.nodes, cancelledWork, 'A late callback cannot restart a cancelled query')
await flush(); check('  ＵＮＩＱＵＥ ｑｕｏｔｅ １１９９９  ', 'fact')
const factWork = { ...textWork }
assert.equal(factWork.nodes, 8000, 'The first text query only normalizes nodes in the selected type')
await query('node 5999'); check('node 5999', 'fact')
assert.equal(textWork.nodes, factWork.nodes, 'Editing a query reuses normalized text')
await query('exact>id'); check('exact>id', 'fact')
searchInput().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() {} }); await flush()
assert.equal(props.selectedNodeId, null, 'IME composition cannot accidentally navigate')
searchInput().props.onKeyDown({ key: 'Enter', preventDefault() {} }); await flush()
assert.equal(props.selectedNodeId, 'exact>id ', 'Search navigation preserves full canonical identity')
await click('查找节点'); check('exact>id', 'fact')
assert.equal(textWork.nodes, factWork.nodes, 'Closing and reopening retains the current graph search cache')
changeType('concept'); runTimer(); await Promise.resolve()
assert(textWork.nodes > 8000 && textWork.nodes < nodes.length)
const typeCancelledWork = textWork.nodes, staleTypeCallback = [...timers.values()][0].fn
changeType('fact'); staleTypeCallback(); await flush(); check('exact>id', 'fact')
assert.equal(textWork.nodes, typeCancelledWork, 'Changing type cancels the old scan and can reuse completed results')
await type('concept'); check('exact>id', 'concept')
assert.equal(textWork.nodes, nodes.length, 'Changing type fills only the previously unsearched nodes')
await type(''); await query(' unique quote 11999 '); check(' unique quote 11999 ')
assert.equal(textWork.nodes, nodes.length, 'All subsequent queries reuse one normalization per node')
changeQuery('cancel on close')
await click('关闭查找'); await click('放大（10%）'); await click('缩小（10%）')
assert.equal(textWork.nodes, nodes.length, 'Camera updates and a closed panel do no additional search text work')

// A replaced node array must invalidate old quote matches, even with the same
// IDs/layout. The old cache cannot retain obsolete objects or evidence.
const replacement = nodes.map(node => node.id === 'n11999' ? { ...node, quote: 'new evidence only' } : node)
await click('查找节点')
changeQuery(' unique quote 11999 ')
const staleGraphCallback = [...timers.values()][0].fn
props.nodes = replacement; render()
staleGraphCallback(); await flush()
assert.equal(textWork.nodes, nodes.length, 'A graph change still does not prebuild a closed search')
await click('查找节点'); check(' unique quote 11999 ', '', replacement)
assert.equal(textWork.nodes, nodes.length * 2)
await query('new evidence only'); check('new evidence only', '', replacement)
assert.deepEqual(results(), ['n11999'])
await query(''); check('', '', replacement)
await click('下一页匹配节点')
assert.deepEqual(results(), replacement.slice(20, 40).map(node => node.id))
assert.equal(textWork.nodes, nodes.length * 2)
assert.equal(JSON.stringify(nodes), original, 'Searching cannot modify canonical nodes or excerpts')
assert.equal(frames.size, 0)
assert.equal(timers.size, 0, 'Completed/cancelled queries cannot leave timers behind')
taskBreaks.push(textWork.nodes)
const maxNormalizedPerTask = Math.max(...taskBreaks.map((count, i) => count - (taskBreaks[i - 1] || 0)))
assert(maxNormalizedPerTask <= 32, '8ms batches with a deterministic 0.25ms/node must yield within 32 normalizations')
changeQuery('cancel on unmount')
const staleUnmountCallback = [...timers.values()][0].fn
slots.forEach(state => state.cleanup?.())
staleUnmountCallback(); await Promise.resolve(); await Promise.resolve()
assert.equal(timers.size, 0, 'Unmount cancels pending search without a surviving task')
assert.equal(textWork.nodes, nodes.length * 2)
for (const path of ['src/index.client.js', 'lib/client.js']) {
  assert(readFileSync(new URL('../' + path, import.meta.url), 'utf8').includes(createGraphNodeSearch.toString()), path + ': search helper parity')
}
console.log(JSON.stringify({ ok: true, initialWork, firstTypedFilter: factWork,
  coldQueryYields: true, baselineNormalizedPerTask, maxNormalizedPerTask, simulatedMsPerNode: 0.25,
  cancelledQueryCannotNavigate: true, staleCallbackIgnored: true, pendingTypeGraphAndUnmountCancellation: true,
  cachedQueryEdits: true, quoteSearch: true, unicodeQuery: true, canonicalOrder: true,
  exactIdentityNavigation: true, emptyQueryPagination: true, graphReplacementInvalidatesCache: true, readOnly: true }))
