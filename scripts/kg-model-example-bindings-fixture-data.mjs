// Count actual binding callbacks and slot Set operations; exclude endpoint arrays.
// Whole-query Set totals include validation; compare deltas to isolate prepared bindings.
export function countExampleBindingReads(query) {
  const some = Array.prototype.some, has = Set.prototype.has, add = Set.prototype.add
  let bindingSomeCalls = 0, bindingSomeVisits = 0, slotSetReads = 0, populatedSlotWrites = 0
  const slotIdentity = value => typeof value === 'string' && value.startsWith('slot-')
  Array.prototype.some = function(callback, thisArg) {
    if (!slotIdentity(this[0]?.slotId) || !Object.hasOwn(this[0], 'value')) return some.call(this, callback, thisArg)
    bindingSomeCalls++
    return some.call(this, (value, index, array) => { bindingSomeVisits++; return callback.call(thisArg, value, index, array) })
  }
  Set.prototype.has = function(value) { if (slotIdentity(value)) slotSetReads++; return has.call(this, value) }
  Set.prototype.add = function(value) { if (slotIdentity(value)) populatedSlotWrites++; return add.call(this, value) }
  try { return { response: query(), bindingSomeCalls, bindingSomeVisits, slotSetReads, populatedSlotWrites } }
  finally { Array.prototype.some = some; Set.prototype.has = has; Set.prototype.add = add }
}

export function expectedBindingIndexWork(structure) {
  let slotSetReads = 0, populatedSlotWrites = 0, indexedBindingVisits = 0
  for (const example of structure.examples) for (const role of ['input', 'output']) {
    const slots = structure.slots.filter(slot => slot.role === role), bindings = example[role === 'input' ? 'inputs' : 'outputs']
    if (slots.length <= 8 || bindings.length <= 8) continue
    slotSetReads += slots.length; indexedBindingVisits += bindings.length
    populatedSlotWrites += bindings.filter(binding => binding.value.trim()).length
  }
  return { slotSetReads, populatedSlotWrites, indexedBindingVisits }
}
