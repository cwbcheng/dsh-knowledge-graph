import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { getOntology, describeOntology } from '../src/kg-ontology.mjs'

// Render the whole production tab after its real restoration effect, rather
// than checking a source substring or rendering only the empty state.
async function mount(file, persistent, replyForCommit) {
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
  const call = async (method, payload) => {
    if (method === 'list-models') return { models: [] }
    assert.equal(method, 'graph-commit')
    assert.equal(typeof replyForCommit, 'function')
    return replyForCommit(payload)
  }
  const sandbox = { React, console, AbortController, requestAnimationFrame: setTimeout, cancelAnimationFrame: clearTimeout, styles: { insert() {} }, ctx,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    host: { call },
    fetch: async (url, options) => {
      assert(url.startsWith('/api/dsh-knowledge-graph/'))
      const reply = await call(url.split('/').at(-1), options?.body ? JSON.parse(options.body) : {})
      return { json: async () => reply }
    },
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

const tick = () => new Promise(resolve => setImmediate(resolve))
// Render real source rows with multiple content units per event, then switch
// sessions while preserving the same source spans but changing event metadata.
const rowsOf = tree => !tree || typeof tree !== 'object' ? [] : [
  ...(tree.attrs?.id?.startsWith('kg-traj-para-') ? [tree] : []), ...(tree.children || []).flatMap(rowsOf),
]
for (const [file, persistent] of [['../src/index.client.js', false], ['../lib/client.js', true]]) {
  const ui = await mount(file, persistent)
  const lines = Array.from({ length: 6 }, (_, i) => 'Source observation ' + i + ' has exact evidence.')
  const source = lines.join('\n\n'), firstEnd = lines.slice(0, 3).join('\n\n').length
  const graph = { source: { documentId: 'trace-multiple-units', revision: 4 }, revision: 4,
    nodes: lines.map((text, i) => ({ id: 'n' + i, type: 'fact', text, quote: text, paragraph: i })), edges: [] }
  const events = [{ line: source.slice(0, firstEnd), seq: 91, type: 'tool/result', start: 0, end: firstEnd },
    { line: source.slice(firstEnd + 2), seq: 22, type: 'user/message', start: firstEnd + 2, end: source.length }]
  const before = JSON.stringify(events)
  ui.api.writeTrajResult('multi-event', { graph, traceText: source, traceEvents: events, revision: 4 })
  ui.render('multi-event'); await tick()
  let tree = ui.render('multi-event'), rows = rowsOf(tree)
  assert.equal(rows.length, 6)
  rows.forEach((row, i) => {
    assert(row.attrs['aria-label'].includes(i < 3 ? '工具结果' : '用户消息'), 'source units retain their actual event kind')
    assert(find(row, part => part.tag === 'span' && part.children?.includes(i < 3 ? '#91' : '#22')), 'event sequence is independent of paragraph index')
  })
  const revised = [{ line: source, seq: 700, type: 'assistant/message', start: 0, end: source.length }]
  ui.api.writeTrajResult('replaced-event', { graph: { ...graph, source: { ...graph.source, documentId: 'trace-replaced' } },
    traceText: source, traceEvents: revised, revision: 4 })
  ui.render('replaced-event'); await tick()
  tree = ui.render('replaced-event'); rows = rowsOf(tree)
  assert.equal(rows.length, 6)
  assert(rows.every(row => row.attrs['aria-label'].includes('AI 回复')), 'session replacement refreshes the memoized event lookup')
  assert(rows.every(row => find(row, part => part.tag === 'span' && part.children?.includes('#700'))))
  rows[4].attrs.onKeyDown({ key: 'Enter', preventDefault() {} })
  const selectedViewer = find(ui.render('replaced-event'), n => n.tag?.name === 'GraphViewer')
  assert.equal(selectedViewer.attrs.selectedNodeId, 'n4', 'event labels do not change paragraph-to-node navigation')
  assert.equal(JSON.stringify(events), before)
  ui.dispose()
}
const reviewGraph = (documentId, revision) => ({ source: { documentId, revision }, revision,
  nodes: [{ id: 'n0', type: 'fact', text: 'Source', quote: 'Source', paragraph: 0 }], edges: [],
  verification: { lastReport: { reportId: 'report-' + documentId, issues: [0, 1].map(i => ({ id: 'issue-' + i,
    targetKind: 'node', targetId: 'n0', title: 'Fixture issue', source: 'local', severity: 'warning', status: 'open' })) } } })
for (const [file, persistent] of [['../src/index.client.js', false], ['../lib/client.js', true]]) {
  for (const navigation of ['session', 'unmount']) {
    for (const outcome of ['accepted', 'rejected']) {
      const calls = []
      let release
      const barrier = new Promise(resolve => { release = resolve })
      const ui = await mount(file, persistent, async payload => {
        calls.push(payload)
        const callNumber = calls.length
        if (callNumber === 1) await barrier
        return callNumber === 1 && outcome === 'rejected' ? { error: { message: 'old session rejected' } }
          : { documentId: payload.documentId, revision: payload.expectedRevision + 1, graph: payload.graph }
      })
      const original = reviewGraph('old-document', 4), next = reviewGraph('new-document', 20)
      ui.api.writeTrajResult('old-session', { graph: original, traceText: 'Source', traceEvents: [], revision: 4 })
      ui.api.writeTrajResult('new-session', { graph: next, traceText: 'Source', traceEvents: [], revision: 20 })
      const panel = sessionId => find(ui.render(sessionId), n => n.tag?.name === 'VerificationPanel')
      ui.render('old-session')
      const first = panel('old-session').attrs.onRejectIssue(original.verification.lastReport.issues[0])
      const second = panel('old-session').attrs.onRejectIssue(original.verification.lastReport.issues[1])
      await tick()
      assert.equal(calls.length, 1, 'second edit waits behind the in-flight baseline')
      if (navigation === 'session') {
        ui.render('new-session')
        const fresh = panel('new-session').attrs.onRejectIssue(next.verification.lastReport.issues[0])
        await tick()
        assert.equal(calls.length, 2, 'the new session must not wait for the old session network response')
        assert.equal(calls[1].documentId, 'new-document')
        assert.equal(calls[1].expectedRevision, 20)
        await fresh
      } else ui.dispose()
      const savedRefs = JSON.stringify([...ui.storage])
      release()
      await Promise.all([first, second])
      assert.equal(calls.length, navigation === 'session' ? 2 : 1, 'navigation must abandon undispatched old-session edits')
      assert.equal(JSON.stringify([...ui.storage]), savedRefs, 'late responses cannot overwrite saved session references')
      if (navigation === 'session') {
        const tree = ui.render('new-session')
        const current = find(tree, n => n.tag?.name === 'VerificationPanel')
        assert.equal(current.attrs.graph.source.documentId, 'new-document')
        assert.deepEqual(Array.from(current.attrs.report.issues, issue => issue.status), ['rejected', 'open'])
        assert.equal(find(tree, n => n.attrs?.role === 'alert'), undefined, 'old failures must not replace the new session UI')
        ui.dispose()
      }
    }
  }
}
console.log(JSON.stringify({ trajectoryResultRenders: true, dynamicAndPersistent: true, bothOntologies: true,
  multiUnitEventIdentity: true, eventMetadataReplacement: true, sourceNodeNavigation: true,
  referenceOnlyStorage: true, sessionQueueIsolation: true, unmountQueueIsolation: true }))
