import assert from 'node:assert/strict'
import { modelConceptQueryFixture } from './kg-model-concept-query-fixture.mjs'

export function modelConceptEmptyFixture({ extraUnits = 32 } = {}) {
  const document = modelConceptQueryFixture(), first = document.sourceUnits.length
  for (let i = 0; i < extraUnits; i++) document.sourceUnits.push({ paragraph: first + i, text: '独立原文段落 ' + i })
  document.sourceText = document.sourceUnits.map(unit => unit.text).join('\n\n')
  return document
}

export const emptyConceptModes = [
  { concepts: true, query: 'missing' }, { concepts: true, query: 'rejected-concept' },
  { concepts: true, query: '检索概念', offset: 128 }, { concepts: true, offset: 999 },
  { concepts: true, query: 'ＭＩＳＳＩＮＧ', modelId: 'multi' },
]

// Count input reads and actual Map insertions independently of elapsed timing.
export function conceptSourceIndexWork(query, document, options, expected) {
  const units = document.sourceUnits, descriptor = Object.getOwnPropertyDescriptor(units, 'map'), map = units.map
  const setDescriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'set'), set = Map.prototype.set
  const sourceIndexes = new Set()
  let sourceUnitVisits = 0, sourceIndexEntries = 0
  Object.defineProperty(units, 'map', { configurable: true, value(callback, ...args) {
    return map.call(this, (...values) => { sourceUnitVisits++; return callback(...values) }, ...args)
  } })
  Map.prototype.set = function(key, value) {
    if (Number.isInteger(key) && typeof value === 'string') { sourceIndexEntries++; sourceIndexes.add(this) }
    return set.call(this, key, value)
  }
  try { assert.deepEqual(query(document, options), expected) }
  finally {
    if (descriptor) Object.defineProperty(units, 'map', descriptor); else delete units.map
    Object.defineProperty(Map.prototype, 'set', setDescriptor)
  }
  return { sourceUnitVisits, sourceIndexEntries, sourceIndexes: sourceIndexes.size }
}
