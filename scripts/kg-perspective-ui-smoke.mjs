import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('        const applyPerspective = async (resolved) => {')
const end = client.indexOf('        const handleCandidateReview =', start)
assert(start >= 0 && end > start)
const body = client.slice(start, end) + '\nreturn applyPerspective'
const state = { tab: 'search', query: 'test', filters: { type: 'all', section: 'all', grounding: 'all', entailment: 'all' },
  chapterId: 'all', layout: 'layered', focusNodeId: 'n-late', gather: null,
  reading: { open: true, topicId: 'chapter-a', themeId: '', offset: 0, themeOffset: 0 }, sourceParagraph: 0 }
const resolved = { revision: 1, state }
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const make = (locate) => {
  const calls = []
  const graph = { source: { documentId: 'doc-a' } }
  const env = { resultView: { graph }, currentResultRef: { current: { graph } }, graphRevisionRef: { current: 1 },
    documentIdOfGraph: item => item?.source?.documentId,
    consumptionPerspectiveRef: { current: null }, readingPerspectiveRef: { current: null },
    gatherPerspectiveRef: { current: null }, locateConsumptionReference: locate,
    setReadingMapOpen: value => calls.push(['reading', value]),
    setConsumptionRestore: value => calls.push(['consumption', value(null)]),
    setReadingRestore: value => calls.push(['reading-restore', value(null)]),
    setGatherRestore: value => calls.push(['gather', value(null)]),
    changeLayoutMode: value => calls.push(['layout', value]),
    setSelectedNodeId: value => calls.push(['node', value]),
    setSelectedEdgeId: value => calls.push(['edge', value]),
    setChapterFilter: value => calls.push(['chapter', value]) }
  const apply = new Function(...Object.keys(env), body)(...Object.values(env))
  return { apply, env, calls }
}

const failed = make(async () => { throw new Error('load failed') })
await assert.rejects(failed.apply(resolved), /load failed/)
assert.deepEqual(failed.calls, [], 'failed off-window focus must not half-apply other view state')

const wait = deferred()
const switched = make(() => wait.promise)
const pending = switched.apply(resolved)
switched.env.currentResultRef.current = { graph: { source: { documentId: 'doc-b' } } }
wait.resolve(true)
await assert.rejects(pending, /切换/)
assert.deepEqual(switched.calls, [], 'late focus result cannot write an old perspective into a new document')

const successful = make(async () => true)
await successful.apply(resolved)
assert.equal(successful.calls.find(call => call[0] === 'chapter')?.[1], 'all')
assert.equal(successful.calls.find(call => call[0] === 'gather')?.[1].documentId, 'doc-a')
console.log(JSON.stringify({ atomicOnFocusFailure: true, navigationFence: true, scopedRestore: true }))
