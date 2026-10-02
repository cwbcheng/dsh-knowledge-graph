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

// Host-only consumption projection; deliberately outside the browser factory.
export function createModelConsumptionTools(structureTools) {
  const matchFields = (structure, query, options = {}) => {
    // Catalogue phrases retain operators; broad token retrieval has separate semantics.
    const normalize = value => value.normalize('NFKC').toLowerCase()
      .replace(options.partial === false ? /\s+/gu : /[\s\p{P}\p{S}]+/gu, ' ').trim()
    const phrase = typeof query === 'string' ? normalize(query) : ''
    if (!phrase || structure == null) return null
    try { structureTools.validateShape(structure) }
    catch (error) {
      if (error.code !== 'invalid_model_structure') throw error
      return null
    }
    const terms = new Set([phrase])
    for (const part of phrase.split(/\s+/)) {
      if (terms.size >= 14) break
      terms.add(part)
      if (part.length >= 3 && /[^\x00-\x7f]/.test(part)) {
        for (let index = 0; index + 2 <= part.length && terms.size < 14; index++) terms.add(part.slice(index, index + 2))
      }
    }
    const items = [], kinds = new Set()
    let full = false, total = 0
    for (const branch of structure.branches) {
      for (const field of ['condition', 'mapping', 'boundary']) {
        const value = normalize(branch[field].text)
        const exact = value.includes(phrase)
        if (!exact && (options.partial === false || ![...terms].some(term => value.includes(term)))) continue
        full ||= exact
        kinds.add(field); total++
        if (items.length < 8) items.push({ branchId: branch.id, field, match: exact ? 'phrase' : 'partial',
          provenanceKind: branch[field].provenance.kind })
      }
    }
    if (!total) return null
    const labels = { condition: '已记录条件匹配', mapping: '已记录规律匹配', boundary: '已记录边界匹配' }
    return { score: full ? 44 : 16, reasons: [...kinds].map(kind => labels[kind]),
      fieldMatches: { version: 1, basis: 'recorded_text_not_applicability', items, omitted: total - items.length } }
  }
  const provenances = structure => [
    ...structure.slots.map(slot => ({ path: 'slots.' + slot.id, provenance: slot.provenance })),
    ...structure.branches.flatMap(branch => ['condition', 'mapping', 'boundary'].map(key =>
      ({ path: 'branches.' + branch.id + '.' + key, provenance: branch[key].provenance }))),
  ]
  const build = (nodes, context) => {
    const models = nodes.filter(node => node.type === 'connection_model')
    const budget = Math.min(48000, Math.max(1024, Math.floor(context.budget)))
    const result = { version: 1, basis: 'recorded_fields_not_semantic_truth', scope: 'slots_and_branches_only', items: [],
      totalModels: models.length, omittedModels: models.length, budget }
    for (const node of models.slice(0, 8)) {
      const item = { modelId: node.id, documentId: context.documentId, revision: context.revision,
        status: 'not_recorded', examplesIncluded: 0, state: node.state || 'candidate',
        groundingStatus: node.groundingStatus || 'candidate', entailmentStatus: node.entailmentStatus || 'unverified' }
      const stored = node.modelStructure
      if (stored != null) {
        try { structureTools.validateShape(stored) }
        catch (error) {
          if (error.code !== 'invalid_model_structure') throw error
          item.status = 'invalid'; item.reason = error.message.slice(0, 200)
        }
        if (item.status !== 'invalid') {
          item.totalSlots = stored.slots.length; item.totalBranches = stored.branches.length
          item.examplesOmitted = stored.examples.length
          // Never clip a required input, condition, qualifier or provenance.
          const core = { version: stored.version, identity: stored.identity, slots: stored.slots,
            branches: stored.branches, examples: [] }
          if (JSON.stringify(core).length > 12000) item.status = 'omitted_budget'
          else {
            const ids = [...new Set(core.slots.map(slot => slot.conceptId))]
            const refs = [...new Set(provenances(core).map(item => item.provenance.paragraph)
              .filter(paragraph => paragraph !== null))]
            const canonicalNodes = context.loadNodes(ids), units = context.loadUnits(refs)
            try { structureTools.validate(core, canonicalNodes, units) }
            catch (error) {
              if (error.code !== 'invalid_model_structure') throw error
              item.status = 'invalid'; item.reason = error.message.slice(0, 200)
            }
            if (item.status !== 'invalid') {
              item.status = 'recorded_core'
              item.structure = { version: core.version, identity: core.identity,
                slots: core.slots, branches: core.branches }
              item.concepts = ids.map(id => {
                const concept = canonicalNodes.get(id), text = typeof concept.text === 'string' ? concept.text : ''
                return { nodeId: id, text: text.slice(0, 300), textTruncated: text.length > 300,
                  groundingStatus: concept.groundingStatus || 'candidate', entailmentStatus: concept.entailmentStatus || 'unverified' }
              })
            }
          }
        }
      }
      result.items.push(item)
      result.omittedModels = models.length - result.items.length
      if (JSON.stringify(item).length > 20000 || JSON.stringify(result).length > budget) {
        // The small status record remains useful even when the whole core cannot fit.
        delete item.structure; delete item.concepts; delete item.reason
        item.status = 'omitted_budget'
        if (JSON.stringify(result).length > budget) {
          result.items.pop(); result.omittedModels = models.length - result.items.length
        }
      }
    }
    return JSON.parse(JSON.stringify(result))
  }
  const buildExamples = (nodes, cores, context) => {
    const budget = Math.min(12000, Math.max(0, Math.floor(context.budget)))
    const byId = new Map(nodes.map(node => [node.id, node]))
    const recorded = cores.items.filter(item => item.status === 'recorded_core')
    const result = { version: 1, basis: 'recorded_examples_not_validation', scope: 'returned_model_cores',
      budget, limit: 8, perModelLimit: 2, modelsWithoutCore: cores.totalModels - recorded.length,
      totalExamples: 0, examplesIncluded: 0, examplesOmitted: 0, items: [], models: [] }
    for (const core of recorded) {
      const total = byId.get(core.modelId).modelStructure.examples.length
      result.totalExamples += total
      result.models.push({ modelId: core.modelId, totalExamples: total, checkedExamples: 0,
        examplesIncluded: 0, examplesOmitted: total, invalidExamples: 0, budgetOmittedExamples: 0 })
    }
    const updateCounts = () => {
      result.examplesIncluded = result.items.length
      result.examplesOmitted = result.totalExamples - result.examplesIncluded
      for (const model of result.models) {
        model.examplesIncluded = result.items.filter(item => item.modelId === model.modelId).length
        model.examplesOmitted = model.totalExamples - model.examplesIncluded
      }
    }
    const omitted = () => ({ version: result.version, basis: result.basis, scope: result.scope, budget,
      status: 'omitted_budget', totalExamples: result.totalExamples, examplesIncluded: 0,
      examplesOmitted: result.totalExamples, modelsWithoutCore: result.modelsWithoutCore, items: [] })
    updateCounts()
    if (JSON.stringify(result).length > budget) return omitted()
    for (const core of recorded) {
      if (result.items.length >= result.limit) break
      const model = result.models.find(item => item.modelId === core.modelId)
      const stored = byId.get(core.modelId).modelStructure
      if (!stored.examples.length) continue
      const ids = [...new Set(core.structure.slots.map(slot => slot.conceptId))]
      const canonicalNodes = context.loadNodes(ids)
      // A bounded sample in stored order is not branch coverage or new validation.
      for (const example of stored.examples.slice(0, result.perModelLimit)) {
        if (result.items.length >= result.limit) break
        model.checkedExamples++
        const refs = [...new Set([...provenances(core.structure).map(item => item.provenance.paragraph),
          example.provenance.paragraph].filter(paragraph => paragraph !== null))]
        try { structureTools.validate({ ...core.structure, examples: [example] }, canonicalNodes, context.loadUnits(refs)) }
        catch (error) {
          if (error.code !== 'invalid_model_structure') throw error
          model.invalidExamples++
          continue
        }
        const fields = structureTools.exampleStatus(core.structure, example)
        const item = { modelId: core.modelId, documentId: context.documentId, revision: context.revision,
          status: 'recorded_example', example,
          fieldCheck: { basis: 'recorded_fields_not_applicability', complete: fields.complete,
            missingBindings: fields.missing, unknownRoleSlots: core.structure.slots.filter(slot => slot.role === 'unknown').map(slot => slot.id),
            branchRecorded: core.structure.branches.some(branch => branch.id === example.branchId),
            reasoningRecorded: !!example.reasoning.trim() } }
        result.items.push(item)
        updateCounts()
        if (JSON.stringify(item).length > 8000 || JSON.stringify(result).length > budget) {
          result.items.pop(); model.budgetOmittedExamples++
          updateCounts()
        }
      }
    }
    if (JSON.stringify(result).length > budget) return omitted()
    return JSON.parse(JSON.stringify(result))
  }
  return { build, buildExamples, provenances, matchFields }
}
