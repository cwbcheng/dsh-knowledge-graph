import assert from 'node:assert/strict'
import { modelNameReuseFixture } from './kg-model-name-reuse-fixture.mjs'

export function modelDraftPortReuseFixture() {
  const fixture = modelNameReuseFixture(), edge = fixture.graph.edges[0]
  for (const id of ['__proto__', 'spaced/id:opaque identity']) {
    const port = { ...structuredClone(edge), toNodeId: id }; delete port.role
    fixture.graph.edges.push(port)
  }
  return fixture
}

// Capture the actual generated structure-response callback. Host IO, request
// setup, abort controls and assertions stay outside benchmark timings.
export function structureReadCallback(view) {
  let pending = null
  view.props.load = (args, signal) => args.structureEdit ? {
    then(callback) {
      assert.equal(signal.aborted, false); pending = { callback, signal }
      return { catch() { return { finally() {} } } }
    },
  } : { then() { return { catch() {} } } }
  return async () => {
    view.props.active = false; view.render(); await view.settle()
    view.props.active = true; view.render(); await view.settle()
    const read = pending; pending = null; assert(read && !read.signal.aborted)
    return read.callback
  }
}
