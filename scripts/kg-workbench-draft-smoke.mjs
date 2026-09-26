import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function storageFixture(blocked = false) {
  const entries = new Map(), writes = []
  return { entries, writes,
    getItem: key => entries.get(key) ?? null,
    setItem(key, value) {
      if (blocked) throw new Error('QuotaExceededError')
      writes.push({ key, value }); entries.set(key, value)
    },
    removeItem(key) { entries.delete(key) },
  }
}
for (const file of ['../src/index.client.js', '../lib/client.js']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const section = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from)
    assert(from >= 0 && to > from, 'actual implementation must be available: ' + start)
    return source.slice(from, to)
  }
  const factory = section('function createWorkbenchDraftStore()', 'const workbenchDraftStore =')
  const restore = section('// ---- restore pending task / saved document reference / input draft ----', '// ---- consume page-selection inbox')
  const overlay = section('function FloatingWindow(', '// Floating tool:')
  const makeStore = storage => new Function('localStorage', 'LS_DRAFT', factory + '; return createWorkbenchDraftStore()')(storage, 'draft')
  const draft = text => ({ title: 'Unsubmitted draft', text, imageInputs: [], markdownBundle: null })

  for (const length of [0, 64 * 1024, 64 * 1024 + 1, 1000000]) {
    const storage = storageFixture(), store = makeStore(storage)
    const input = draft('x'.repeat(length))
    store.save(input)
    assert.equal(store.get().text, input.text, file + ': the complete input must outlive the mounted window')
    assert.equal(store.needsUnloadWarning(), length > 64 * 1024)
    assert.equal(storage.entries.has('draft'), length <= 64 * 1024)
    assert(storage.writes.every(write => write.value.length <= 64 * 1024 + 100), 'large drafts must never be copied to localStorage')
  }

  async function fixture({ cached, blocked = false, saved, pending, brokenPreview = false } = {}) {
    const storage = storageFixture(blocked), store = makeStore(storage)
    if (cached) store.save(cached)
    storage.entries.set('draft', JSON.stringify({ title: 'Old title', text: 'Old text' }))
    if (saved) storage.entries.set('result', JSON.stringify(saved))
    if (pending) storage.entries.set('pending', JSON.stringify(pending))
    const state = { title: '', text: '', imageInputs: [], markdownBundle: null, resultView: null,
      phase: 'idle', taskId: null, draftRestored: false, error: null }
    const effects = [], loads = [], previews = []
    const set = key => value => { state[key] = value }
    const refs = { graphRevisionRef: { current: 0 }, submittedRef: { current: null },
      imageInputsRef: { current: [] }, uploadPreviewUrlsRef: { current: new Set() } }
    const dependencies = () => ({
      ...state, ...refs, localStorage: storage, LS_DRAFT: 'draft', LS_PENDING: 'pending', LS_RESULT: 'result',
      LEGACY_LARGE_STORAGE_KEYS: [], loadHistory: () => [], history: [],
      mergeServerHistory: async () => [], setHistory() {}, workbenchDraftStore: store,
      loadGraphDocument: async ({ documentId }) => {
        loads.push(documentId)
        return { graph: { source: { documentId, title: 'Saved graph' }, nodes: [] }, sourceText: 'Canonical source', revision: 8 }
      },
      makeView: (graph, sourceText) => ({ graph, sourceText }),
      setTitle: set('title'), setText: set('text'), setImageInputs: set('imageInputs'),
      setMarkdownBundle: set('markdownBundle'), setPhase: set('phase'), setTaskId: set('taskId'),
      setResultView: set('resultView'), setDraftRestored: set('draftRestored'), setError: set('error'),
      setFullText() {}, setVerification() {}, setFactReport() {}, setInputCollapsed() {}, setCurrentHistoryId() {},
      URL: { createObjectURL(blob) {
        if (brokenPreview) throw new Error('Object URL unavailable')
        assert(blob instanceof Blob, 'restore must use the immutable file, not a revoked object URL')
        const url = 'blob:restored-' + previews.length; previews.push(url); return url
      } },
      useEffect: effect => effects.push(effect),
    })
    const render = () => {
      effects.length = 0
      const deps = dependencies()
      new Function(...Object.keys(deps), restore)(...Object.values(deps))
    }
    render()
    const dispose = effects[0]()
    effects[1]()
    assert.equal(state.draftRestored, false, 'booting must not prematurely overwrite the saved draft')
    await tick()
    assert.equal(state.draftRestored, true)
    render(); effects[1]()
    return { state, store, storage, refs, loads, previews, dispose, render, persist: () => { render(); effects[1]() } }
  }

  const blob = new Blob(['original pixels'], { type: 'image/png' })
  const input = { ...draft('large-data-'.repeat(10000)), imageInputs: [{ id: 'image-1', name: 'probe.png',
    mediaType: 'image/png', bytes: blob.size, data: 'b3JpZ2luYWwgcGl4ZWxz', previewUrl: 'blob:revoked', previewBlob: blob }] }
  for (const blocked of [false, true]) {
    const f = await fixture({ cached: input, blocked, saved: { documentId: 'old-document' } })
    assert.equal(f.state.title, input.title)
    assert.equal(f.state.text, input.text)
    assert.equal(f.state.imageInputs.length, 1)
    assert.equal(f.state.imageInputs[0].previewUrl, 'blob:restored-0')
    assert.equal(f.state.imageInputs[0].previewBlob, blob)
    assert.equal(f.state.imageInputs[0].data, input.imageInputs[0].data)
    assert.equal(f.store.get().imageInputs[0].previewUrl, undefined, 'never cache a mount-owned preview URL')
    assert.equal(f.refs.uploadPreviewUrlsRef.current.size, 1, 'the new mount owns and can revoke its previews')
    assert.deepEqual(f.loads, [], 'unsubmitted input must not be overwritten by an old saved-document reference')
    assert.equal(f.store.needsUnloadWarning(), true)
    assert(f.storage.writes.every(write => !write.value.includes('previewBlob') && !write.value.includes('imageInputs')))
    f.dispose()
  }
  const unavailable = await fixture({ cached: input, brokenPreview: true })
  assert.equal(unavailable.state.imageInputs[0].data, input.imageInputs[0].data)
  assert.equal(unavailable.store.get().imageInputs[0].previewBlob, blob, 'failed preview allocation cannot discard image bytes')
  assert.match(unavailable.state.error.message, /预览/)
  unavailable.dispose()

  const smallQuota = await fixture({ cached: draft('new short text'), blocked: true })
  assert.equal(smallQuota.state.text, 'new short text', 'a failed storage write must not restore the old persistent value')
  assert.equal(smallQuota.store.needsUnloadWarning(), true)
  smallQuota.state.title = ''; smallQuota.state.text = ''; smallQuota.persist()
  const empty = await fixture({ cached: smallQuota.store.get(), blocked: true })
  assert.equal(empty.state.text, '', 'explicitly clearing input must not resurrect an older draft')
  assert.equal(empty.state.title, '')
  assert.equal(empty.store.needsUnloadWarning(), false)
  assert.equal(empty.storage.entries.has('draft'), false, 'clearing must remove stale storage even when setItem is over quota')
  smallQuota.dispose(); empty.dispose()

  const bundle = { bundleId: 'immutable-bundle', imageCount: 3, paragraphCount: 12 }
  const markdown = await fixture({ cached: { ...draft('![diagram](image.png)'), markdownBundle: bundle } })
  assert.equal(markdown.state.markdownBundle, bundle, 'do not turn a prepared image bundle into plain text')
  assert.equal(markdown.store.needsUnloadWarning(), true)
  markdown.dispose()

  const canonical = await fixture({ saved: { documentId: 'canonical-document', title: 'Saved title' } })
  assert.deepEqual(canonical.loads, ['canonical-document'])
  assert.equal(canonical.state.text, 'Canonical source')
  assert.equal(canonical.store.get(), null, 'canonical graphs still restore from Host, not a browser snapshot')
  assert.equal(canonical.store.needsUnloadWarning(), false)
  canonical.dispose()
  const pending = await fixture({ cached: input, pending: { taskId: 'owned-task', title: 'Pending' } })
  assert.equal(pending.state.taskId, 'owned-task', 'existing admitted task reconnect behavior is preserved')
  assert.equal(pending.state.phase, 'extracting')
  assert.equal(pending.store.needsUnloadWarning(), false)
  assert.equal(pending.store.get().imageInputs[0].data, input.imageInputs[0].data)
  pending.dispose()

  // The overlay stays mounted while closed; only its unload guard stays active,
  // never the WorkbenchBody task controllers. Its effect owns listener disposal.
  const storage = storageFixture(), store = makeStore(storage), listeners = new Map(), effects = []
  const FloatingWindow = new Function('useSyncExternalStore', 'useEffect', 'winStore', 'workbenchDraftStore', 'window', 'h', 'WindowInner',
    overlay + '; return FloatingWindow')((_subscribe, snapshot) => snapshot(), fn => effects.push(fn),
    { getOpen: () => false, subscribe() {} }, store,
    { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) },
    () => { throw new Error('closed workbench must not mount task controllers') }, () => {})
  store.save(input)
  assert.equal(FloatingWindow({ ctx: {} }), null)
  const cleanup = effects.pop()()
  assert(listeners.has('beforeunload'), 'large input must still be protected after the window is closed')
  let prevented = false
  const event = { preventDefault() { prevented = true }, returnValue: null }
  listeners.get('beforeunload')(event)
  assert.equal(prevented, true); assert.equal(event.returnValue, '')
  cleanup(); assert.equal(listeners.size, 0)
  store.clear(); FloatingWindow({ ctx: {} }); effects.pop()()
  assert.equal(listeners.size, 0, 'discarded/durable input does not need an unload warning')
}
console.log(JSON.stringify({ largeDraftBoundaries: true, quotaFailure: true, clearWithoutResurrection: true,
  imageBytesAndPreviewOwnership: true, previewFailurePreservesBytes: true, bundlePreserved: true,
  canonicalAndPendingReferences: true, closedWindowUnloadGuard: true, noHiddenTaskControllers: true, sourceAndGenerated: true }))
