import { draftDiagnosisView } from './kg-model-draft-diagnosis-fixture.mjs'

// Count JSON work by data shape, across the complete generated edit/render path.
// Keep instrumentation out of timings and leave all JSON semantics intact.
export function draftCopyView(source, harness, options = {}) {
  const work = { specStringifies: 0, draftStringifies: 0, specParses: 0, draftParses: 0, storageWrites: 0 }
  const isSpec = value => value?.version === 1 && Array.isArray(value.slots) && Array.isArray(value.branches) && Array.isArray(value.examples)
  const count = (value, suffix) => { if (isSpec(value)) work['spec' + suffix]++; else if (isSpec(value?.spec)) work['draft' + suffix]++ }
  const view = draftDiagnosisView(source, harness, { ...options, json: {
    stringify(value, ...args) { count(value, 'Stringifies'); return JSON.stringify(value, ...args) },
    parse(...args) { const value = JSON.parse(...args); count(value, 'Parses'); return value },
  } })
  const set = view.cache.set
  view.cache.set = function(...args) { work.storageWrites++; return set.apply(this, args) }
  return Object.assign(view, { work })
}

export const copyWorkSince = (view, start) => Object.fromEntries(Object.entries(view.work).map(([key, value]) => [key, value - start[key]]))
