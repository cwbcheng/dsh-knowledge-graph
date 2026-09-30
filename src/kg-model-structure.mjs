// Shared by the dynamic Host and SQLite; no environment or persistence access.
export function createModelStructureTools() {
  const fail = (path, message) => { throw Object.assign(new Error(path + ': ' + message), { code: 'invalid_model_structure' }) }
  const object = (value, keys, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object')
    if (Object.keys(value).some(key => !keys.includes(key))) fail(path, 'unsupported field')
  }
  const string = (value, max, path, required = false) => {
    if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(path, 'invalid text')
  }
  const list = (value, max, path) => {
    if (!Array.isArray(value) || value.length > max) fail(path, 'invalid or oversized list')
  }
  const ids = (items, path) => {
    const found = new Set()
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || found.has(item.id)) fail(path, 'missing or duplicate identity')
      found.add(item.id)
    }
    return found
  }
  const provenance = (value, units, path) => {
    object(value, ['kind', 'paragraph', 'quote', 'note'], path)
    if (!['unknown', 'source', 'user', 'ai'].includes(value.kind)) fail(path, 'invalid provenance kind')
    string(value.quote, 2000, path + '.quote')
    string(value.note, 1000, path + '.note')
    if (value.paragraph !== null && (!Number.isSafeInteger(value.paragraph) || value.paragraph < 0)) fail(path, 'invalid paragraph')
    if (value.kind === 'source' && (!value.quote.trim() || value.paragraph === null)) fail(path, 'source fields need a quote and paragraph')
    if (value.quote && units && !units.get(value.paragraph)?.includes(value.quote)) fail(path, 'quote does not match the stored source unit')
  }
  const field = (value, units, path) => {
    object(value, ['text', 'provenance'], path)
    string(value.text, 2000, path + '.text')
    provenance(value.provenance, units, path + '.provenance')
  }
  const validate = (value, nodes, units, shapeOnly = false) => {
    if (!shapeOnly && (!nodes?.get || !units?.get)) fail('modelStructure', 'canonical node and source indexes are required')
    object(value, ['version', 'identity', 'slots', 'branches', 'examples'], 'modelStructure')
    if (JSON.stringify(value).length > 200000) fail('modelStructure', 'payload exceeds 200000 characters')
    if (value.version !== 1 || !['undetermined', 'assertion', 'hypothesis', 'wrong_example', 'type_definition'].includes(value.identity)) fail('modelStructure', 'invalid version or content identity')
    list(value.slots, 40, 'slots'); list(value.branches, 40, 'branches'); list(value.examples, 100, 'examples')
    const slotIds = ids(value.slots, 'slots'), branchIds = ids(value.branches, 'branches')
    ids(value.examples, 'examples')
    const slots = new Map(value.slots.map(slot => [slot.id, slot]))
    for (const slot of value.slots) {
      const path = 'slot ' + slot.id
      object(slot, ['id', 'conceptId', 'label', 'role', 'unit', 'state', 'provenance'], path)
      string(slot.conceptId, 160, path + '.conceptId', true)
      const concept = nodes?.get(slot.conceptId)
      if (!shapeOnly && (concept?.type !== 'concept' || concept.state === 'rejected')) fail(path, 'endpoint must reference an existing non-rejected concept')
      if (!['input', 'output', 'unknown'].includes(slot.role)) fail(path, 'invalid role')
      string(slot.label, 200, path + '.label'); string(slot.unit, 80, path + '.unit'); string(slot.state, 200, path + '.state')
      provenance(slot.provenance, units, path + '.provenance')
    }
    for (const branch of value.branches) {
      const path = 'branch ' + branch.id
      object(branch, ['id', 'label', 'condition', 'mapping', 'boundary'], path)
      string(branch.label, 200, path + '.label', true)
      for (const key of ['condition', 'mapping', 'boundary']) field(branch[key], units, path + '.' + key)
    }
    for (const example of value.examples) {
      const path = 'example ' + example.id
      object(example, ['id', 'title', 'scenario', 'branchId', 'inputs', 'outputs', 'reasoning', 'provenance'], path)
      string(example.title, 200, path + '.title', true)
      string(example.scenario, 2000, path + '.scenario', true)
      string(example.reasoning, 2000, path + '.reasoning')
      string(example.branchId, 80, path + '.branchId')
      if (example.branchId && !branchIds.has(example.branchId)) fail(path, 'branch no longer exists')
      for (const [key, role] of [['inputs', 'input'], ['outputs', 'output']]) {
        list(example[key], 40, path + '.' + key)
        const seen = new Set()
        for (const binding of example[key]) {
          object(binding, ['slotId', 'value'], path + '.' + key)
          if (!slotIds.has(binding.slotId) || seen.has(binding.slotId) || slots.get(binding.slotId).role !== role) fail(path, 'binding has a missing, duplicate, or incompatible slot')
          seen.add(binding.slotId); string(binding.value, 1000, path + '.value')
        }
      }
      provenance(example.provenance, units, path + '.provenance')
    }
    return value
  }
  const errors = (graph, units) => {
    const nodes = new Map((graph.nodes || []).map(node => [node.id, node])), out = []
    for (const node of nodes.values()) {
      if (node.modelStructure == null) continue
      try {
        if (node.type !== 'connection_model') fail('modelStructure', 'only connection_model can hold a model structure')
        validate(node.modelStructure, nodes, units)
      } catch (error) { out.push({ nodeId: node.id, message: error.message }) }
    }
    return out
  }
  const exampleStatus = (structure, example) => {
    const branch = structure.branches.find(item => item.id === example.branchId)
    const missing = []
    for (const role of ['input', 'output']) {
      const bindings = example[role === 'input' ? 'inputs' : 'outputs']
      for (const slot of structure.slots.filter(item => item.role === role)) {
        if (!bindings.some(binding => binding.slotId === slot.id && binding.value.trim())) missing.push(slot.id)
      }
    }
    return { missing, complete: !!branch?.mapping.text.trim() && structure.slots.some(slot => slot.role === 'input')
      && structure.slots.some(slot => slot.role === 'output') && !structure.slots.some(slot => slot.role === 'unknown') && !missing.length }
  }
  const diagnose = (value, context = {}) => {
    const items = [], counts = { structure: 0, examples: 0, sources: 0, review: 0 }
    const origins = { source: 0, user: 0, ai: 0, unknown: 0 }
    const text = value => typeof value === 'string' ? value.trim() : ''
    const array = (value, limit) => Array.isArray(value) ? value.slice(0, limit).filter(item => item && typeof item === 'object') : []
    const add = (code, group, target, info = {}) => {
      counts[group]++
      items.push({ id: code + ':' + (target?.id || '') + ':' + (target?.field || '') + ':' + (info.branchId || info.edgeKey || '') + ':' + (info.edgeIndex ?? info.cautionIndex ?? ''), code, group, target, ...info })
    }
    const origin = (provenance, target, name) => {
      const kind = Object.hasOwn(origins, provenance?.kind) ? provenance.kind : 'unknown'
      origins[kind]++
      if (kind === 'unknown') add('source_unknown', 'sources', { ...target, field: target.field ? target.field + '.provenance' : 'provenance' }, { name })
    }
    const ports = array(context.ports, Number.MAX_SAFE_INTEGER)
    const slots = value ? array(value.slots, 40) : ports.filter(port => port.node?.type === 'concept')
      .map(port => ({ id: port.edgeKey, conceptId: port.node.nodeId, role: port.role, label: port.node.text }))
    const branches = array(value?.branches, 40), examples = array(value?.examples, 100)
    const nameOf = slot => text(slot.label) || text(context.names?.[slot.conceptId]) || slot.conceptId || slot.id
    const target = (section, id = '', field = '') => ({ section, id, field })
    if (!value) add('structure_absent', 'structure', target('slots'))
    else {
      try { validate(value, null, null, true) }
      catch (error) { add('shape_invalid', 'structure', null, { detail: error.message }) }
    }
    if (context.invalid) add('canonical_invalid', 'review', null, { detail: context.invalid })
    for (const [cautionIndex, caution] of (Array.isArray(context.cautions) ? context.cautions.slice(0, 20) : []).entries()) {
      if (text(caution)) add('wording_caution', 'review', target('identity'), { detail: caution, cautionIndex })
    }
    if (!value || value.identity === 'undetermined') add('identity_unknown', 'review', target('identity'))
    else if (value.identity !== 'assertion') add('identity_caution', 'review', target('identity'), { identity: value.identity })
    for (const role of ['input', 'output']) {
      if (!slots.some(slot => slot.role === role)) add('missing_' + role, 'structure', target('slots'))
    }
    const conceptCounts = new Map()
    for (const slot of slots) conceptCounts.set(slot.conceptId, (conceptCounts.get(slot.conceptId) || 0) + 1)
    for (const slot of slots) {
      if (!['input', 'output'].includes(slot.role)) add('slot_role', 'structure', target('slots', value ? slot.id : '', 'role'), { name: nameOf(slot) })
      if (value) {
        if (conceptCounts.get(slot.conceptId) > 1 && !text(slot.state)) add('slot_state', 'review', target('slots', slot.id, 'state'), { name: nameOf(slot) })
        origin(slot.provenance, target('slots', slot.id), nameOf(slot))
      }
    }
    if (!branches.length) add('missing_branch', 'structure', target('branches'))
    for (const branch of branches) {
      for (const key of ['condition', 'mapping', 'boundary']) {
        if (!text(branch[key]?.text)) add('branch_' + key, 'structure', target('branches', branch.id, key), { name: branch.label })
        else origin(branch[key]?.provenance, target('branches', branch.id, key), branch.label + ' / ' + key)
      }
      const paired = examples.filter(example => example.branchId === branch.id && text(example.scenario)
        && text(branch.mapping?.text) && slots.some(slot => slot.role === 'input') && slots.some(slot => slot.role === 'output')
        && slots.every(slot => ['input', 'output'].includes(slot.role) && array(example[slot.role === 'input' ? 'inputs' : 'outputs'], 40)
          .some(binding => binding.slotId === slot.id && text(binding.value))))
      if (!paired.length) add('branch_no_pair', 'examples', target('examples', '', 'branchId'), { name: branch.label, branchId: branch.id })
    }
    if (!examples.length) add('missing_example', 'examples', target('examples'))
    for (const example of examples) {
      if (!text(example.scenario)) add('example_scenario', 'examples', target('examples', example.id, 'scenario'), { name: example.title })
      if (!branches.some(branch => branch.id === example.branchId)) add('example_branch', 'examples', target('examples', example.id, 'branchId'), { name: example.title })
      for (const [key, role] of [['inputs', 'input'], ['outputs', 'output']]) {
        const bindings = array(example[key], 40)
        const missing = slots.filter(slot => slot.role === role && !bindings.some(binding => binding.slotId === slot.id && text(binding.value)))
        if (missing.length) add('example_' + key, 'examples', target('examples', example.id, key), { name: example.title,
          missing: missing.map(slot => ({ slotId: slot.id, name: nameOf(slot) })) })
      }
      if (!text(example.reasoning)) add('example_reasoning', 'examples', target('examples', example.id, 'reasoning'), { name: example.title })
      if (text(example.scenario)) origin(example.provenance, target('examples', example.id), example.title)
    }
    for (const port of ports) {
      if (!port.editable || port.role === 'unknown') add('legacy_port', 'review', null, { name: port.node?.text || port.node?.nodeId,
        edgeKey: port.edgeKey, edgeIndex: port.edgeIndex, paragraph: port.citations?.[0]?.paragraph ?? port.node?.citations?.[0]?.paragraph ?? null })
    }
    if (value && JSON.stringify(slots.map(slot => slot.conceptId + ':' + slot.role).sort())
      !== JSON.stringify(ports.map(port => port.node?.nodeId + ':' + port.role).sort())) add('legacy_difference', 'review', null)
    return { version: 1, basis: 'recorded_fields_not_semantic_truth', stored: !!value, total: items.length, counts, origins, items }
  }
  const fieldFromSource = (target, unit, quote) => {
    if (!target || target.section !== 'branches' || !['condition', 'mapping', 'boundary'].includes(target.field)) fail('source selection', 'invalid destination')
    if (!Number.isSafeInteger(unit?.paragraph) || unit.paragraph < 0 || typeof unit.text !== 'string') fail('source selection', 'invalid stored source unit')
    string(quote, 2000, 'source selection', true)
    if (!unit.text.includes(quote)) fail('source selection', 'quote does not match the selected source unit')
    return { text: quote, provenance: { kind: 'source', paragraph: unit.paragraph, quote, note: '' } }
  }
  return { validate, validateShape: value => validate(value, null, null, true), errors, exampleStatus, diagnose, fieldFromSource }
}
