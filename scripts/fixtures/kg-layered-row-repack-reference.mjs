// Frozen row repack from 8243d4a. Used only as an independent geometry oracle.
export function rowRepackReference(nodes, placed, sizes, backboneLane, onChoice) {
  const rowIds = new Map()
  for (const node of nodes) {
    const p = placed.get(node.id)
    if (!p) continue
    const list = rowIds.get(p.y) || []
    list.push(node.id)
    rowIds.set(p.y, list)
  }
  const rowGap = 18
  for (const ids of rowIds.values()) {
    const anchors = ids.filter((id) => backboneLane.has(id))
    if (anchors.length === 0) continue
    const occupied = []
    anchors.sort((a, b) => backboneLane.get(a) - backboneLane.get(b) || String(a).localeCompare(String(b)))
    for (const id of anchors) {
      const p = placed.get(id)
      const s = sizes.get(id)
      const half = (s ? s.w : 170) / 2
      p.x = backboneLane.get(id)
      occupied.push({ left: p.x - half, right: p.x + half })
    }
    occupied.sort((a, b) => a.left - b.left)
    const others = ids
      .filter((id) => !backboneLane.has(id))
      .sort((a, b) => placed.get(a).x - placed.get(b).x || String(a).localeCompare(String(b)))
    for (const id of others) {
      const p = placed.get(id)
      const s = sizes.get(id)
      const half = (s ? s.w : 170) / 2
      const preferred = p.x
      const candidates = [preferred]
      for (const slot of occupied) {
        candidates.push(slot.left - rowGap - half)
        candidates.push(slot.right + rowGap + half)
      }
      candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b)
      const fits = (x) => occupied.every((slot) => x + half + rowGap <= slot.left || x - half - rowGap >= slot.right)
      let chosen = candidates.find((x) => fits(x))
      if (chosen == null) {
        const right = occupied.reduce((max, slot) => Math.max(max, slot.right), preferred)
        chosen = right + rowGap + half
      }
      if (onChoice) onChoice(id, chosen)
      p.x = chosen
      occupied.push({ left: chosen - half, right: chosen + half })
      occupied.sort((a, b) => a.left - b.left)
    }
  }
  return rowIds
}
