// Measure real callbacks across the whole query, including unchanged diagnostics.
export function countExampleStatusReads(query) {
  const filter = Array.prototype.filter, find = Array.prototype.find, set = Map.prototype.set
  let slotFilters = 0, slotFilterVisits = 0, branchFinds = 0, branchFindVisits = 0, indexedBranches = 0
  Array.prototype.filter = function(callback, thisArg) {
    if (this[0]?.id !== 'slot-0') return filter.call(this, callback, thisArg)
    slotFilters++
    return filter.call(this, (value, index, array) => { slotFilterVisits++; return callback.call(thisArg, value, index, array) })
  }
  Array.prototype.find = function(callback, thisArg) {
    if (this[0]?.id !== 'branch-0') return find.call(this, callback, thisArg)
    branchFinds++
    return find.call(this, (value, index, array) => { branchFindVisits++; return callback.call(thisArg, value, index, array) })
  }
  Map.prototype.set = function(key, value) {
    if (typeof value?.id === 'string' && value.id.startsWith('branch-') && value.mapping && value.condition && value.boundary) indexedBranches++
    return set.call(this, key, value)
  }
  try { return { response: query(), slotFilters, slotFilterVisits, branchFinds, branchFindVisits, indexedBranches } }
  finally { Array.prototype.filter = filter; Array.prototype.find = find; Map.prototype.set = set }
}
