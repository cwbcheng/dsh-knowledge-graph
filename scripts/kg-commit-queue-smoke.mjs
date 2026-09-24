import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const helperStart = client.indexOf('      function asAllNodesGraph(graph) {')
const helperEnd = client.indexOf('      function historyMetadata(entry) {', helperStart)
const commitStart = client.indexOf('        const persistGraph = (g, baseGraph, pinnedRevision) => {')
const commitEnd = client.indexOf('        const handleRemoveParagraphType = ', commitStart)
assert(helperStart >= 0 && helperEnd > helperStart && commitStart >= 0 && commitEnd > commitStart)
const { asAllNodesGraph, graphCommitViewPatch } = new Function(
  `${client.slice(helperStart, helperEnd)}; return { asAllNodesGraph, graphCommitViewPatch }`,
)()
const commitSource = client.slice(commitStart, commitEnd)

function fixture(replyForCall) {
  const documentId = 'queue-fixture'
  const base = asAllNodesGraph({
    source: { documentId, revision: 1 }, revision: 1,
    nodes: [{ id: 'n1', type: 'fact', text: 'original' }], edges: [],
  })
  const refs = {
    graphRevisionRef: { current: 1 },
    graphCommitQueueRef: { current: Promise.resolve() },
    graphCommitEpochRef: { current: 0 },
    currentResultRef: { current: { graph: base, sourceText: 'source' } },
  }
  const calls = []
  const errors = []
  const history = []
  const host = { call: async (name, payload) => {
    assert.equal(name, 'graph-commit')
    calls.push(payload)
    return replyForCall(calls.length, payload)
  } }
  const makeView = (graph, sourceText) => ({ graph, sourceText })
  const setResultView = (next) => {
    refs.currentResultRef.current = typeof next === 'function' ? next(refs.currentResultRef.current) : next
  }
  const makeCommit = (view) => {
    const deps = {
      resultView: view, fullText: 'source', title: 'fixture', currentHistoryId: null,
      ...refs, host, makeView, setResultView, asAllNodesGraph, graphCommitViewPatch,
      documentIdOfGraph: (graph) => graph?.source?.documentId || '',
      semanticOperationsOf: () => [], graphSemanticOperations: new WeakMap(),
      localStorage: { setItem() {} }, LS_RESULT: 'result',
      setHistory: (update) => history.push(update([])),
      appendHistory: (previous, entry) => [...previous, entry],
      setError: (error) => errors.push(error),
      setVerification() {}, setFactReport() {},
      toastStore: { show() {} },
    }
    return new Function(...Object.keys(deps), `${commitSource}; return persistGraph`)(...Object.values(deps))
  }
  return { base, refs, calls, errors, history, makeView, setResultView, makeCommit }
}

let releaseFirst
const firstReply = new Promise((resolve) => { releaseFirst = resolve })
const failed = fixture((number) => number === 1
  ? firstReply
  : { documentId: 'queue-fixture', revision: 2, graph: { nodes: [], edges: [] } })
const firstGraph = { ...failed.base, nodes: [{ ...failed.base.nodes[0], text: 'rejected change' }] }
const secondGraph = { ...firstGraph, nodes: [...firstGraph.nodes, { id: 'n2', type: 'fact', text: 'later edit' }] }
const first = failed.makeCommit(failed.refs.currentResultRef.current)(firstGraph, failed.base)
failed.setResultView(failed.makeView(firstGraph, 'source'))
const second = failed.makeCommit(failed.refs.currentResultRef.current)(secondGraph, firstGraph)
failed.setResultView(failed.makeView(secondGraph, 'source'))
await new Promise((resolve) => setImmediate(resolve))
assert.equal(failed.calls.length, 1)
releaseFirst({ error: { code: 'invariant_violation', message: 'rejected by host' } })
assert.equal(await first, null)
assert.equal(await second, null)
assert.equal(failed.calls.length, 1, 'a dependent edit must not be sent after its baseline was rejected')
assert.equal(failed.refs.currentResultRef.current.graph.nodes[0].text, 'original', 'the optimistic chain must roll back')
assert.equal(failed.refs.graphCommitEpochRef.current, 1)
assert.match(failed.errors.at(-1).message, /后续排队的编辑不会提交/)
assert.equal(failed.history.length, 0, 'an abandoned optimistic graph must not enter local history')

const freshGraph = { ...failed.base, nodes: [...failed.base.nodes, { id: 'n3', type: 'fact', text: 'fresh edit' }] }
const fresh = failed.makeCommit(failed.refs.currentResultRef.current)(freshGraph, failed.base)
failed.setResultView(failed.makeView(freshGraph, 'source'))
assert.equal((await fresh)?.revision, 2, 'a new edit after rollback may use the restored baseline')
assert.equal(failed.calls.length, 2)
assert.deepEqual(failed.calls[1].graph.nodes.map((node) => node.id), ['n3'])

let releaseSuccess
const slowSuccess = new Promise((resolve) => { releaseSuccess = resolve })
const passed = fixture((number) => number === 1
  ? slowSuccess
  : { documentId: 'queue-fixture', revision: 3, graph: { nodes: [], edges: [] } })
const passFirst = { ...passed.base, nodes: [{ ...passed.base.nodes[0], text: 'accepted change' }] }
const passSecond = { ...passFirst, nodes: [...passFirst.nodes, { id: 'n2', type: 'fact', text: 'second edit' }] }
const savedFirst = passed.makeCommit(passed.refs.currentResultRef.current)(passFirst, passed.base)
passed.setResultView(passed.makeView(passFirst, 'source'))
const savedSecond = passed.makeCommit(passed.refs.currentResultRef.current)(passSecond, passFirst)
passed.setResultView(passed.makeView(passSecond, 'source'))
await new Promise((resolve) => setImmediate(resolve))
assert.equal(passed.calls.length, 1, 'the second commit must wait for the first')
releaseSuccess({ documentId: 'queue-fixture', revision: 2, graph: { nodes: [], edges: [] } })
assert.equal((await savedFirst)?.revision, 2)
assert.equal((await savedSecond)?.revision, 3)
assert.deepEqual(passed.calls.map((call) => call.expectedRevision), [1, 2])
assert.deepEqual(passed.calls[1].graph.nodes.map((node) => node.id), ['n2'])

console.log(JSON.stringify({ ok: true, rejectedChainStopped: true, freshEditAllowed: true, successfulChainSerialized: true }))
