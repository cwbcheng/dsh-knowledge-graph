import assert from 'node:assert/strict'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'

export function modelNameReuseFixture() {
  const document = modelBranchCountsFixture({ slots: 40, branches: 40, examples: 100 })
  const template = document.graph.nodes.find(node => node.id === 'distance')
  for (let i = 0; i < 24; i++) document.graph.nodes.push({ ...structuredClone(template), id: '000-name-page-' + i, text: '目录占位 ' + i })
  for (const [id,text] of [['__proto__','同名目录概念'], ['constructor','合法目录概念'], ['spaced/id:opaque identity','同名目录概念']]) {
    document.graph.nodes.push({ ...structuredClone(template), id, text })
  }
  return document
}

// Capture the public read callback for counterless timing with actual Host
// responses prepared outside the measured callback/render pair. Query setup,
// debounce controls, response IO and assertions remain outside that timing.
export function conceptReadCallback(view) {
  let pending = null
  view.props.load = (args, signal) => {
    assert.equal(args.concepts, true); assert.equal(signal.aborted, false)
    return { then(callback) { pending = { callback, signal }; return { catch() {} } } }
  }
  return async query => {
    view.change('搜索槽位概念', query); await view.flushDebounce()
    const read = pending; pending = null; assert(read && !read.signal.aborted)
    return read.callback
  }
}
