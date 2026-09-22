import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { getOntology, describeOntology } from '../src/kg-ontology.mjs'

// Render the whole production tab after its real restoration effect, rather
// than checking a source substring or rendering only the empty state.
async function mount(file, persistent) {
  const state = [], refs = [], effects = [], memo = [], storage = new Map()
  let si = 0, ri = 0, ei = 0, mi = 0, pending = []
  const changed = (old, deps) => !old || deps.some((value, i) => value !== old.deps[i])
  const React = {
    Fragment: 'fragment',
    createElement: (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat() }),
    useState(initial) { const i = si++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] },
    useRef(initial) { return refs[ri++] ||= { current: initial } },
    useEffect(fn, deps) { const i = ei++, old = effects[i]; if (changed(old, deps)) pending.push(() => { old?.cleanup?.(); effects[i] = { deps, cleanup: fn() } }) },
    useMemo(fn, deps) { const i = mi++; if (changed(memo[i], deps)) memo[i] = { deps, value: fn() }; return memo[i].value },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
  }
  const ctx = { get: name => name === 'slots' ? { inject() {} } : null, timeout: () => () => {} }
  const sandbox = { React, console, AbortController, requestAnimationFrame: setTimeout, cancelAnimationFrame: clearTimeout, styles: { insert() {} }, ctx,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    host: { async call(method) { assert.equal(method, 'list-models'); return { models: [] } } },
    fetch: async url => { assert.equal(url, '/api/dsh-knowledge-graph/list-models'); return { json: async () => ({ models: [] }) } },
    window: { innerWidth: 1200, innerHeight: 800 },
  }
  let source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const marker = '      // --------------------------- slot registration'
  assert(source.includes(marker))
  source = source.replace(marker, '      globalThis.testApi = { TrajectoryTab, writeTrajResult };\n' + marker)
  if (persistent) {
    sandbox.window.__ModuleLoader__ = { load({ factory }) { sandbox.plugin = factory(() => React) } }
    runInNewContext(source, sandbox)
    await sandbox.plugin.apply(ctx)
  } else {
    await runInNewContext(source.replace('export default function clientPlugin()', 'function clientPlugin()') + ';clientPlugin().apply(ctx)', sandbox)
  }
  return { api: sandbox.testApi, storage,
    render(sessionId) { si = ri = ei = mi = 0; pending = []; const tree = sandbox.testApi.TrajectoryTab({ sessionId }); for (const fn of pending) fn(); return tree },
    dispose() { for (const effect of effects) effect?.cleanup?.() },
  }
}
const find = (tree, check) => !tree || typeof tree !== 'object' ? null : check(tree) ? tree : tree.children?.map(child => find(child, check)).find(Boolean)
for (const [file, persistent] of [['../src/index.client.js', false], ['../lib/client.js', true]]) {
  for (const ontologyId of ['proposition-v1', 'learning-view-v1']) {
    const ui = await mount(file, persistent)
    const text = 'A completed trace event.'
    const graph = { source: { documentId: 'trajectory-fixture', revision: 4 }, revision: 4,
      graphOntology: describeOntology(getOntology(ontologyId)), nodes: [{ id: 'n0', type: ontologyId === 'proposition-v1' ? 'fact' : 'concept', text, quote: text, paragraph: 0 }], edges: [] }
    ui.api.writeTrajResult('completed', { graph, traceText: text, traceEvents: [{ line: text, seq: 1 }], revision: 4 })
    assert(find(ui.render('empty'), n => n.attrs['aria-label'] === '轨迹知识图'))
    ui.render('completed')
    await new Promise(resolve => setImmediate(resolve))
    const tree = ui.render('completed')
    assert(find(tree, n => n.attrs['aria-label'] === '轨迹 ⇄ 知识图结果'), file + ': restored result must render')
    const viewer = find(tree, n => n.tag?.name === 'GraphViewer')
    assert.equal(viewer.attrs.nodes[0].id, 'n0')
    assert.equal(viewer.attrs.revision, 4)
    assert.equal(viewer.attrs.sourceText, text)
    assert([...ui.storage.values()].every(value => !value.includes('A completed trace event.')), 'browser persistence stores references, never full traces')
    ui.dispose()
  }
}
console.log(JSON.stringify({ trajectoryResultRenders: true, dynamicAndPersistent: true, bothOntologies: true, referenceOnlyStorage: true }))
