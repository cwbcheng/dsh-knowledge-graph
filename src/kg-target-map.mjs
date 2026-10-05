export function createTargetMapTools() {
  const clone = value => JSON.parse(JSON.stringify(value))
  const fail = (message, code = 'invalid_input') => { throw Object.assign(new Error(message), { code }) }
  const text = (value, limit = 4000) => typeof value === 'string' && value.length <= limit
  const identity = value => text(value, 4096) && !!value.trim()
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
  const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key))
  const types = ['connection_model', 'discrimination_model', 'concept']
  // JSON object member order is not content; array order and literal field values still are.
  const same = (a, b) => {
    if (a === b) return true
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]))
    if (!object(a) || !object(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
  }
  const slot = (id, role, name = '') => ({ id, role, name, meaning: '', unit: '', scope: '' })
  function blank(target) {
    const mode = target.type === 'connection_model' ? 'connection' : 'discrimination'
    return { version: 1, mode, title: target.text, mapping: '', conditions: '', boundary: '',
      slots: [slot('input-1', 'input', mode === 'discrimination' ? '万物' : ''), slot('output-1', 'output', mode === 'discrimination' ? 'A 或非 A' : '')],
      outcomes: mode === 'discrimination' ? [{ id: 'yes', slotId: 'output-1', label: 'A', detail: '' }, { id: 'no', slotId: 'output-1', label: '非 A', detail: '' }] : [], examples: [] }
  }
  function example(map, id, stage = 'material') {
    return { id, stage, context: '', process: '', exposure: 'unsure',
      inputs: map.slots.filter(item => item.role === 'input').map(item => ({ slotId: item.id, value: '' })),
      outputs: map.slots.filter(item => item.role === 'output').map(item => ({ slotId: item.id, outcomeId: '', detail: '' })),
      feedback: { kind: 'personal', text: '', source: '' } }
  }
  function validate(value, { draft = false } = {}) {
    if (!exact(value, ['version', 'mode', 'title', 'mapping', 'conditions', 'boundary', 'slots', 'outcomes', 'examples']) ||
        value.version !== 1 || !['connection', 'discrimination'].includes(value.mode) || !text(value.title) || !draft && !value.title.trim() ||
        !['mapping', 'conditions', 'boundary'].every(key => text(value[key], 8000)) || JSON.stringify(value).length > 240000) fail('靶图格式无效或内容超过单张容量')
    const unique = (items, max) => Array.isArray(items) && items.length <= max && items.every(item => object(item) && identity(item.id) && item.id.length <= 120) && new Set(items.map(item => item.id)).size === items.length
    if (!unique(value.slots, 16) || !unique(value.outcomes, 80) || !unique(value.examples, 40)) fail('槽位、输出或例子身份重复，或数量超出限制')
    for (const item of value.slots) if (!exact(item, ['id', 'role', 'name', 'meaning', 'unit', 'scope']) ||
      !['input', 'output'].includes(item.role) || !['name', 'meaning', 'unit', 'scope'].every(key => text(item[key]))) fail('槽位字段无效')
    const inputs = value.slots.filter(item => item.role === 'input'), outputs = value.slots.filter(item => item.role === 'output')
    if (!inputs.length || !outputs.length || inputs.length > 8 || outputs.length > 8) fail('每侧需要 1 至 8 个独立槽位')
    for (const item of value.outcomes) if (!exact(item, ['id', 'slotId', 'label', 'detail']) || !outputs.some(out => out.id === item.slotId) ||
      !text(item.label) || !draft && !item.label.trim() || !text(item.detail)) fail('输出范围中的取值未对应有效输出槽位')
    const bindings = (items, slots, keys) => Array.isArray(items) && items.length === slots.length && new Set(items.map(item => item?.slotId)).size === items.length &&
      items.every(item => exact(item, keys) && slots.some(slot => slot.id === item.slotId))
    for (const item of value.examples) {
      if (!exact(item, ['id', 'stage', 'context', 'process', 'exposure', 'inputs', 'outputs', 'feedback']) ||
          !['material', 'prediction', 'reviewed'].includes(item.stage) || !['known', 'unsure', 'self_reported_new'].includes(item.exposure) ||
          !text(item.context, 8000) || !text(item.process, 8000) || !bindings(item.inputs, inputs, ['slotId', 'value']) ||
          item.inputs.some(input => !text(input.value)) || !bindings(item.outputs, outputs, ['slotId', 'outcomeId', 'detail']) ||
          item.outputs.some(out => !text(out.detail) || !text(out.outcomeId, 120) || out.outcomeId && !value.outcomes.some(candidate => candidate.id === out.outcomeId && candidate.slotId === out.slotId)) ||
          !exact(item.feedback, ['kind', 'text', 'source']) || !['personal', 'source', 'observation', 'ai'].includes(item.feedback.kind) ||
          !text(item.feedback.text, 8000) || !text(item.feedback.source, 4000)) fail('具体推测、输出配对或对照结果无效')
      if (!draft && item.stage !== 'material' && (!item.context.trim() || !item.process.trim() || item.inputs.some(input => !input.value.trim()) ||
          item.outputs.some(out => !out.outcomeId && !out.detail.trim()))) fail('记录预测前需填写完整情境、所有输入、推测过程与预测输出')
      if (item.stage !== 'reviewed' && (item.feedback.text || item.feedback.source)) fail('先保存预测，再记录对照结果')
      if (!draft && item.stage === 'reviewed' && (!item.feedback.text.trim() || !item.feedback.source.trim())) fail('对照结果需要内容和来源说明')
    }
    return clone(value)
  }
  function transition(next, previous, records, knownContexts = []) {
    const old = previous?.map
    // Operators, exponents and token spacing may change the situation being predicted.
    const contextKey = value => value.normalize('NFC').trim()
    for (const item of next.examples) {
      const prior = old?.examples.find(example => example.id === item.id)
      if (item.stage === 'reviewed' && (!prior || !['prediction', 'reviewed'].includes(prior.stage))) fail('对照结果必须对应已经保存的预测')
      if (prior?.stage === 'material' && item.stage !== 'material') fail('已有材料不能改称未见验证，请保留材料并另选情境')
      if (!prior && item.stage === 'prediction' && item.exposure === 'self_reported_new') {
        const key = contextKey(item.context)
        if (next.examples.some(example => example.id !== item.id && contextKey(example.context) === key) ||
            knownContexts.some(context => contextKey(context) === key) ||
            records.some(record => record.map.examples.some(example => contextKey(example.context) === key))) fail('这个情境已存在于靶图记录中，不能标记为自报未见')
      }
    }
    for (const prior of old?.examples || []) {
      if (prior.stage === 'material') continue
      const item = next.examples.find(example => example.id === prior.id)
      if (!item || item.stage === 'material') fail('已保存预测不能删除或改回材料；历史记录必须保留')
      const core = item => ({ ...item, stage: '', feedback: {} })
      if (!same(core(item), core(prior))) fail('已保存预测的情境、输入、过程和预测输出不能事后改写')
      if (prior.stage === 'reviewed' && !same(item, prior)) fail('已有对照结果不能改写；请新增例子记录修订')
      // A renamed shared output would silently change every old prediction pointing to it.
      for (const out of prior.outputs) if (out.outcomeId && !same(next.outcomes.find(value => value.id === out.outcomeId), old.outcomes.find(value => value.id === out.outcomeId))) fail('已用于预测的输出取值不能删除或改名')
      const identityOfSlot = value => value ? { ...value, meaning: '' } : null
      for (const binding of [...prior.inputs, ...prior.outputs]) if (!same(identityOfSlot(next.slots.find(value => value.id === binding.slotId)), identityOfSlot(old.slots.find(value => value.id === binding.slotId)))) fail('已用于预测的槽位身份、单位或对象范围不能改写；内涵表述仍可修订')
    }
  }
  function gaps(map, { targets = false } = {}) {
    const result = []
    const add = (message, path, field) => result.push({ message, path, field })
    for (const item of map.slots) {
      if (!item.name.trim()) add('槽位名称未填写：' + item.id, ['slots', item.id, 'name'], '概念名')
      if (map.mode === 'connection' && !item.meaning.trim()) add('判别表述待整理：' + (item.name || item.id), ['slots', item.id, 'meaning'], '我的内涵表述')
    }
    if (!map.mapping.trim()) add(map.mode === 'discrimination' ? '判别规律待整理' : '映射规律待整理', ['mapping'], '规律表述')
    if (!map.examples.length) add('尚无具体推测', ['examples'], '具体情境与推测')
    for (const item of map.examples) {
      const input = item.inputs.find(value => !value.value.trim()), output = item.outputs.find(value => !value.outcomeId && !value.detail.trim())
      const missing = !item.context.trim() ? ['context'] : input ? ['inputs', input.slotId] : !item.process.trim() ? ['process'] : output ? ['outputs', output.slotId] : null
      if (missing) add('例子要素未完整：' + item.id, ['examples', item.id, ...missing],
        ({ context: '完整情境', process: '推测过程', inputs: '具体输入', outputs: '预测或材料输出' })[missing[0]] + (missing[1] ? ' · ' + missing[1] : ''))
    }
    return targets ? result : result.map(item => item.message)
  }
  const historyContentFields = { mapping: '规律表述', conditions: '适用条件', boundary: '边界与疑问', slotName: '槽位名称', slotMeaning: '内涵表述',
    slotUnit: '单位', slotScope: '对象与时间范围', outcomeLabel: '输出取值', outcomeDetail: '输出说明', context: '完整情境', process: '推测过程',
    input: '具体输入', output: '具体输出', feedback: '对照结果', feedbackSource: '对照来源' }
  function* historyContentValues(map) {
    for (const field of ['mapping', 'conditions', 'boundary']) yield [field, map[field], [field]]
    for (const item of map.slots || []) for (const [field, key] of [['slotName', 'name'], ['slotMeaning', 'meaning'], ['slotUnit', 'unit'], ['slotScope', 'scope']]) yield [field, item[key], ['slots', item.id, key]]
    for (const item of map.outcomes || []) { yield ['outcomeLabel', item.label, ['outcomes', item.id, 'label']]; yield ['outcomeDetail', item.detail, ['outcomes', item.id, 'detail']] }
    for (const item of map.examples || []) {
      yield ['context', item.context, ['examples', item.id, 'context']]; yield ['process', item.process, ['examples', item.id, 'process']]
      for (const input of item.inputs || []) yield ['input', input.value, ['examples', item.id, 'inputs', input.slotId]]
      for (const output of item.outputs || []) yield ['output', output.detail, ['examples', item.id, 'outputs', output.slotId, 'detail']]
      yield ['feedback', item.feedback?.text, ['examples', item.id, 'feedback', 'text']]; yield ['feedbackSource', item.feedback?.source, ['examples', item.id, 'feedback', 'source']]
    }
  }
  function* historyTextMatches(value, query) {
    if (typeof value !== 'string' || !query) return
    const haystack = value.toLowerCase(), needle = query.toLowerCase()
    let folded = 0, end = 0, index
    // Search the whole lowercase string (including final sigma), but return intact original code points.
    while ((index = haystack.indexOf(needle, folded)) >= 0) {
      while (end < value.length) {
        const char = String.fromCodePoint(value.codePointAt(end)), length = char.toLowerCase().length
        if (folded + length > index) break
        end += char.length; folded += length
      }
      const start = end
      while (folded < index + needle.length) {
        const char = String.fromCodePoint(value.codePointAt(end))
        end += char.length; folded += char.toLowerCase().length
      }
      yield { start, end }
    }
  }
  function* historyContentMatches(map, query) {
    for (const [field, value, path] of historyContentValues(map)) {
      const match = historyTextMatches(value, query).next().value
      if (!match) continue
      const { start, end } = match
      let left = Math.max(0, start - 40), right = Math.min(value.length, end + 80)
      if (left > 0 && value.codePointAt(left - 1) > 0xffff) left--
      if (right < value.length && value.codePointAt(right - 1) > 0xffff) right++
      yield { field, excerpt: (left ? '…' : '') + value.slice(left, right) + (right < value.length ? '…' : ''), path }
    }
  }
  function historyContentMatch(map, query, { target = false } = {}) {
    const match = historyContentMatches(map, query).next().value
    return match ? target ? match : { field: match.field, excerpt: match.excerpt } : null
  }
  const historyMatches = (item, query, searchIn = 'metadata') => searchIn === 'content'
    ? !query || exact(item.match, ['field', 'excerpt']) && Object.hasOwn(historyContentFields, item.match.field) && text(item.match.excerpt, 640) && item.match.excerpt.toLowerCase().includes(query.toLowerCase())
    : [item.id, item.title, item.reason].some(value => value.toLowerCase().includes(query.toLowerCase()))
  function handle(saved, args, allRecords = [], now = Date.now(), totalRecords = allRecords.length, knownContexts = [], historyPage = null, catalogCounts = null) {
    try {
      if (!object(args) || !identity(args.documentId) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1 ||
          !['catalog', 'read', 'save', 'record', 'history'].includes(args.action)) fail('靶图请求身份或操作无效')
      if (!saved || saved.documentId !== args.documentId) fail('找不到该文档', 'not_found')
      if (saved.revision !== args.expectedRevision) return { error: { code: 'revision_conflict', message: '知识图已更新；旧靶图和草稿保留，请重新载入', currentRevision: saved.revision } }
      const nodes = saved.graph?.nodes || [], documentId = args.documentId, revision = saved.revision
      if (args.action === 'catalog') {
        const query = args.query ?? '', mode = args.mode ?? 'all', offset = args.offset ?? 0, records = args.records === undefined ? 'all' : args.records
        const searchIn = args.searchIn === undefined ? 'metadata' : args.searchIn
        if (!text(query, 256) || !['metadata', 'content'].includes(searchIn) || !['all', 'connection', 'discrimination'].includes(mode) || !['all', 'saved'].includes(records) || !Number.isSafeInteger(offset) || offset < 0) fail('靶图目录筛选无效')
        const counts = catalogCounts || new Map()
        if (!catalogCounts) for (const record of allRecords) {
          if (record.documentId !== documentId) continue
          const count = counts.get(record.target.id) || { recordCount: 0, currentRecordCount: 0 }
          count.recordCount++; if (record.baseRevision === revision) count.currentRecordCount++
          if (!count.latestRecord || record.createdAt > count.latestRecord.createdAt || record.createdAt === count.latestRecord.createdAt && record.id.localeCompare(count.latestRecord.id) > 0) {
            count.latestRecord = { id: record.id, title: record.map.title, baseRevision: record.baseRevision, createdAt: record.createdAt }
          }
          const match = searchIn === 'content' && query ? historyContentMatch(record.map, query) : null
          if (match) {
            count.matchCount = (count.matchCount || 0) + 1
            if (!count.latestMatch || record.createdAt > count.latestMatch.createdAt || record.createdAt === count.latestMatch.createdAt && record.id.localeCompare(count.latestMatch.id) > 0) {
              count.latestMatch = { id: record.id, title: record.map.title, baseRevision: record.baseRevision, createdAt: record.createdAt, match }
            }
          }
          counts.set(record.target.id, count)
        }
        const items = nodes.filter(node => types.includes(node.type) && (mode === 'all' || (node.type === 'connection_model' ? 'connection' : 'discrimination') === mode) &&
          (records === 'all' || counts.get(node.id)?.recordCount > 0) &&
          (searchIn === 'content' ? !!query && counts.get(node.id)?.matchCount > 0 :
            !query || [node.text + ' ' + node.id, counts.get(node.id)?.latestRecord?.title || ''].some(value => value.toLowerCase().includes(query.toLowerCase()))))
        return { version: 1, documentId, revision, records, searchIn, query, total: items.length, offset, items: items.slice(offset, offset + 20).map(node => ({ id: node.id, text: node.text, type: node.type,
          recordCount: counts.get(node.id)?.recordCount || 0, currentRecordCount: counts.get(node.id)?.currentRecordCount || 0,
          ...(searchIn === 'content' ? { matchCount: counts.get(node.id).matchCount, latestMatch: clone(counts.get(node.id).latestMatch) } : {}),
          latestRecord: counts.get(node.id)?.latestRecord ? clone(counts.get(node.id).latestRecord) : null })) }
      }
      if (!identity(args.targetId)) fail('靶图目标身份无效')
      const targets = nodes.filter(node => node.id === args.targetId && types.includes(node.type))
      if (targets.length !== 1) fail('目标节点不存在或身份不唯一', 'not_found')
      const target = { id: targets[0].id, type: targets[0].type, text: targets[0].text }
      const records = allRecords.filter(record => record.documentId === documentId && record.target.id === target.id).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      const current = records.find(record => record.baseRevision === revision) || null
      if (args.action === 'history') {
        const offset = args.offset ?? 0, query = args.query === undefined ? '' : args.query, searchIn = args.searchIn === undefined ? 'metadata' : args.searchIn
        if (!text(query, 256) || !['metadata', 'content'].includes(searchIn) || !Number.isSafeInteger(offset) || offset < 0 || args.historyHead !== undefined && (!text(args.historyHead, 120) || args.historyHead && !identity(args.historyHead))) fail('修订记录分页身份或检索词无效')
        const metadata = historyPage ? [] : records.map(record => ({ id: record.id, baseRevision: record.baseRevision, title: record.map.title, createdAt: record.createdAt, reason: record.reason,
          ...(searchIn === 'content' && query ? { match: historyContentMatch(record.map, query) } : {}) }))
        const matches = metadata.filter(item => historyMatches(item, query, searchIn))
        const page = historyPage || { historyHead: records[0]?.id || '', historyRecordTotal: records.length, historyTotal: matches.length,
          history: matches.slice(offset, offset + 20) }
        if (args.historyHead !== undefined && args.historyHead !== page.historyHead) fail('修订记录有更新，请重新读取列表；当前草稿保留。', 'history_conflict')
        return { version: 1, documentId, revision, target, offset, query, searchIn, ...page }
      }
      if (args.action === 'record') {
        const record = records.find(record => record.id === args.recordId)
        if (!record) fail('找不到该目标的靶图记录', 'not_found')
        return { version: 1, documentId, revision, record: clone(record), stale: record.baseRevision !== revision }
      }
      if (args.action === 'read') return { version: 1, documentId, revision, target, current: clone(current), template: blank(target),
        history: records.slice(0, 20).map(record => ({ id: record.id, baseRevision: record.baseRevision, title: record.map.title, createdAt: record.createdAt, reason: record.reason })), historyTotal: totalRecords }
      if (!identity(args.id) || args.id.length > 120 || !text(args.parentId, 120) || !text(args.reason, 2000) || args.confirm !== true ||
          args.startRound !== undefined && typeof args.startRound !== 'boolean') fail('保存靶图需要确认及有效的修订身份')
      const map = validate(args.map)
      if (map.mode !== (target.type === 'connection_model' ? 'connection' : 'discrimination')) fail('靶图类型与目标不一致')
      const record = { id: args.id, documentId, baseRevision: revision, target, parentId: args.parentId, reason: args.reason,
        origin: 'personal_target_map_not_mastery', ...(args.startRound ? { startsRound: true } : {}), map, createdAt: now }
      const existing = allRecords.find(item => item.id === args.id)
      if (existing) {
        const retry = value => { const { createdAt, bases, ...rest } = value; return rest }
        if (!same(retry(existing), retry(record))) fail('保存请求与已有记录冲突', 'attempt_conflict')
        return { version: 1, documentId, revision, saved: clone(existing), unchanged: true }
      }
      if ((current?.id || '') !== args.parentId) fail('靶图已有新修订；草稿保留，请先读取最新记录', 'attempt_conflict')
      if (current && !args.reason.trim()) fail('修订靶图需要填写修改理由')
      if (args.startRound) {
        // Restart the example set explicitly; old predictions and their meanings remain in their immutable snapshots.
        if (!current || !args.reason.trim() || !same(map, { ...current.map, examples: [] })) fail('新一轮须沿用已保存的上层表述、填写理由并从空白例组开始；随后可另存结构修订')
      } else transition(map, current, records, knownContexts)
      record.bases = Object.fromEntries(map.examples.filter(item => item.stage !== 'material').map(item => [item.id,
        current?.bases && Object.hasOwn(current.bases, item.id) ? clone(current.bases[item.id]) : { recordId: record.id, baseRevision: revision }]))
      record.createdAt = Math.max(now, (records[0]?.createdAt || 0) + 1)
      return { version: 1, documentId, revision, saved: clone(record), appendRecord: record }
    } catch (error) {
      if (['invalid_input', 'not_found', 'attempt_conflict', 'history_conflict'].includes(error.code)) return { error: { code: error.code, message: error.message } }
      throw error
    }
  }
  return { blank, slot, example, validate, transition, gaps, historyContentFields, historyTextMatches, historyContentMatch, historyContentMatches, historyMatches, handle }
}
