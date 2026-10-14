import assert from 'node:assert/strict'

// Measure only the actual related-material Map. Restore instrumentation before
// timing and compare the entire response, including evidence and other pages.
export function materialValuesWork(query, document, options, expected) {
  const nodes = new Set(document.graph.nodes), maps = new WeakSet()
  const descriptors = ['set', 'values'].map(key => [key, Object.getOwnPropertyDescriptor(Map.prototype, key)])
  const original = Object.fromEntries(descriptors.map(([key, descriptor]) => [key, descriptor.value]))
  let collections = 0, valuesYielded = 0
  Map.prototype.set = function (key, value) {
    if (nodes.has(value?.node) && Object.hasOwn(value, 'links')) maps.add(this)
    return original.set.call(this, key, value)
  }
  Map.prototype.values = function () {
    const iterator = original.values.call(this)
    if (!maps.has(this)) return iterator
    collections++
    return (function* () { for (const value of iterator) { valuesYielded++; yield value } })()
  }
  try { assert.deepEqual(query(document, options), expected) }
  finally { for (const [key, descriptor] of descriptors) Object.defineProperty(Map.prototype, key, descriptor) }
  return { collections, valuesYielded }
}
