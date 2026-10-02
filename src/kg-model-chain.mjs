// A worksheet check, not a formula evaluator or a semantic inference engine.
export function createModelChainTools() {
  const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_chain_draft' }) }
  const object = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('推测草稿包含不支持的字段')
  }
  const text = (value, limit = 1000) => { if (typeof value !== 'string' || value.length > limit) fail('推测草稿的文字格式或长度无效') }
  const array = (value, limit) => { if (!Array.isArray(value) || value.length > limit) fail('推测草稿的条目数量无效') }
  const identity = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) fail('推测草稿缺少有效身份') }
  const unique = items => {
    const seen = new Set()
    for (const item of items) { identity(item.slotId); if (seen.has(item.slotId)) fail('同一步骤的槽位重复'); seen.add(item.slotId) }
  }
  const validateDraft = draft => {
    object(draft, ['version', 'scenario', 'goal', 'steps'])
    if (JSON.stringify(draft).length > 100000 || draft.version !== 1) fail('推测草稿版本或大小无效')
    text(draft.scenario, 2000); text(draft.goal, 2000); array(draft.steps, 2)
    if (draft.steps.length !== 2) fail('请选择且只选择两个步骤')
    for (const step of draft.steps) {
      object(step, ['modelId', 'branchId', 'inputs', 'outputs', 'conditions', 'reasoning'])
      text(step.modelId, 100000)
      if (!step.modelId.trim()) fail('步骤缺少模型身份')
      text(step.branchId, 80); text(step.conditions, 2000); text(step.reasoning, 2000)
      array(step.inputs, 40); array(step.outputs, 40); unique(step.inputs); unique(step.outputs)
      for (const binding of step.inputs) {
        object(binding, ['slotId', 'source', 'value', 'basis', 'fromSlotId', 'meaning', 'unit', 'timeState', 'objectScope'])
        if (!['known', 'link'].includes(binding.source)) fail('输入来源无效')
        for (const key of ['value', 'basis', 'meaning', 'unit', 'timeState', 'objectScope']) text(binding[key])
        text(binding.fromSlotId, 80)
      }
      for (const binding of step.outputs) { object(binding, ['slotId', 'value']); text(binding.value) }
    }
    return draft
  }
  const parseExchange = (raw, context) => {
    if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) fail('草稿文件过大或不是文字')
    let value
    try { value = JSON.parse(raw) } catch { fail('草稿文件不是有效 JSON') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('草稿文件必须是对象')
    const legacy = !Object.hasOwn(value, 'format') && value.basis === 'recorded_fields_and_learner_reports_not_semantic_validity' && value.persisted === false
    if (value.version !== 1 || (value.format !== 'dsh.model-chain-draft' && !legacy)) fail('草稿文件格式或版本不支持')
    if (typeof value.documentId !== 'string' || value.documentId !== context.documentId) fail('草稿属于其他文档，请在原文档打开')
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) fail('草稿来源版本无效')
    if (value.revision > context.revision) fail('草稿来源版本高于当前文档，未导入')
    validateDraft(value.draft)
    if (!Array.isArray(value.modelIds) || value.modelIds.length !== 2 || value.modelIds.some((id, index) => id !== value.draft.steps[index].modelId)) fail('草稿模型身份不一致')
    if (value.modelIds[0] !== context.modelId) fail('草稿的第一个模型不同，请在原模型打开')
    if (value.modelIds[0] === value.modelIds[1]) fail('两步须使用不同模型')
    // File receipts and model snapshots are untrusted; only the editable draft is restored.
    return { documentId: value.documentId, revision: value.revision, peerId: value.modelIds[1], draft: value.draft }
  }
  const evaluate = (pair, draft) => {
    validateDraft(draft)
    const details = [pair.left, pair.right]
    if (draft.steps.some((step, index) => step.modelId !== details[index]?.model?.nodeId) || draft.steps[0].modelId === draft.steps[1].modelId) fail('草稿与所选两个模型的身份不一致')
    const issues = [], warnings = [], steps = []
    const present = value => typeof value === 'string' && !!value.trim()
    const normalized = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
    const issue = (step, code, message, slotId = '', field = '') => issues.push({ step, code, message, slotId, field })
    const warn = (step, code, message) => warnings.push({ step, code, message })
    if (!present(draft.scenario)) issue(1, 'scenario_missing', '第 1 步前：具体情境尚未填写', '', 'scenario')
    if (!present(draft.goal)) issue(1, 'goal_missing', '第 1 步前：推测目标尚未填写', '', 'goal')
    // Check both canonical models before allowing an upstream prediction to feed the next step.
    details.forEach((detail, index) => {
      const number = index + 1, structure = detail.structure, step = draft.steps[index]
      if (!structure) issue(number, 'structure_missing', '第 ' + number + ' 步：模型尚无有效独立槽位与分支')
      if (detail.model.state === 'rejected' || detail.model.entailmentStatus === 'unsupported') issue(number, 'model_rejected', '第 ' + number + ' 步：模型已有驳回或原文不支持记录')
      if (structure && !['assertion', 'hypothesis'].includes(structure.identity)) issue(number, 'identity_unusable', '第 ' + number + ' 步：模型内容身份尚未确认，或是错误示例、类型说明')
      if (structure?.identity === 'hypothesis') warn(number, 'hypothesis', '第 ' + number + ' 步保留为假设，不是已成立的规律')
      for (const caution of detail.model.warnings || []) warn(number, 'model_caution', '第 ' + number + ' 步：' + caution)
      const slots = structure?.slots || [], byId = new Map(slots.map(slot => [slot.id, slot]))
      if (!slots.some(slot => slot.role === 'input')) issue(number, 'input_role_missing', '第 ' + number + ' 步：尚无明确输入槽位')
      if (!slots.some(slot => slot.role === 'output')) issue(number, 'output_role_missing', '第 ' + number + ' 步：尚无明确输出槽位')
      if (slots.some(slot => slot.role === 'unknown')) issue(number, 'role_unknown', '第 ' + number + ' 步：仍有未定角色的槽位')
      for (const [key, role] of [['inputs', 'input'], ['outputs', 'output']]) {
        for (const binding of step[key]) {
          if (!structure) continue
          if (byId.get(binding.slotId)?.role !== role) fail('草稿引用了缺失槽位或逆向角色')
        }
      }
      const branch = structure?.branches.find(item => item.id === step.branchId) || null
      if (!branch) issue(number, 'branch_missing', '第 ' + number + ' 步：尚未选择当前模型的有效分支', '', 'branchId')
      for (const key of ['condition', 'mapping', 'boundary']) {
        if (!branch) continue
        if (!present(branch[key]?.text)) issue(number, 'branch_' + key + '_missing', '第 ' + number + ' 步：所选分支的' + { condition: '条件', mapping: '映射', boundary: '边界' }[key] + '尚未记录', '', key)
        else if (!present(branch[key].provenance?.quote)) issue(number, 'branch_' + key + '_source_missing', '第 ' + number + ' 步：所选分支的' + { condition: '条件', mapping: '映射', boundary: '边界' }[key] + '缺少可核对引文', '', key)
        if (branch[key]?.provenance?.kind !== 'source') warn(number, 'non_source_field', '第 ' + number + ' 步的' + { condition: '条件', mapping: '映射', boundary: '边界' }[key] + '不是原文字段；保留其用户整理、AI 建议或未定来源身份')
      }
      if (!present(step.conditions)) issue(number, 'conditions_missing', '第 ' + number + ' 步：尚未记录情境符合条件及未越过边界的依据', '', 'conditions')
      if (!present(step.reasoning)) issue(number, 'reasoning_missing', '第 ' + number + ' 步：尚未记录应用过程', '', 'reasoning')
      for (const slot of slots.filter(item => item.role === 'output')) {
        if (!present(step.outputs.find(item => item.slotId === slot.id)?.value)) issue(number, 'output_prediction_missing', '第 ' + number + ' 步：输出预测未填写 · ' + (slot.label || slot.conceptText || slot.id), slot.id)
      }
      steps.push({ number, model: detail.model, branch, slots, inputs: [], outputs: step.outputs, conditions: step.conditions, reasoning: step.reasoning })
    })
    let linked = 0
    steps.forEach((step, index) => {
      const number = index + 1
      for (const slot of step.slots.filter(item => item.role === 'input')) {
        const binding = draft.steps[index].inputs.find(item => item.slotId === slot.id)
        if (!binding) { issue(number, 'input_missing', '第 ' + number + ' 步：输入未填写 · ' + (slot.label || slot.conceptText || slot.id), slot.id); continue }
        if (binding.source === 'known') {
          if (!present(binding.value)) issue(number, 'input_missing', '第 ' + number + ' 步：已知输入未填写 · ' + (slot.label || slot.conceptText || slot.id), slot.id)
          if (!present(binding.basis)) issue(number, 'input_basis_missing', '第 ' + number + ' 步：已知输入缺少判别或取得依据 · ' + (slot.label || slot.id), slot.id)
          step.inputs.push({ slotId: slot.id, source: 'learner_known_input', value: binding.value, basis: binding.basis })
          continue
        }
        if (number !== 2) fail('第 1 步不能引用未来输出或逆转映射')
        linked++
        const upstream = steps[0].slots.find(item => item.id === binding.fromSlotId)
        if (!upstream || upstream.role !== 'output') {
          issue(number, 'link_output_missing', '第 2 步：所连的第 1 步输出槽位已缺失或角色不符', slot.id)
          step.inputs.push({ slotId: slot.id, source: 'blocked_link', value: null, fromSlotId: binding.fromSlotId }); continue
        }
        const before = issues.length
        if (upstream.conceptId !== slot.conceptId) issue(number, 'concept_mismatch', '第 2 步：联结两端的概念身份不同；同名或用户声明不能替代身份核对', slot.id)
        for (const [key, label] of [['unit', '单位'], ['state', '时间状态']]) {
          if (!present(upstream[key]) || !present(slot[key])) issue(number, key + '_unknown', '第 2 步：联结两端的' + label + '尚未明确', slot.id)
          else if (normalized(upstream[key]) !== normalized(slot[key])) issue(number, key + '_mismatch', '第 2 步：联结两端已记录的' + label + '不同；未自动换算或视为同义', slot.id)
        }
        for (const [key, label] of [['meaning', '含义'], ['unit', '单位口径'], ['timeState', '时间状态'], ['objectScope', '对象范围']]) {
          if (!present(binding[key])) issue(number, 'link_' + key + '_missing', '第 2 步：尚未记录联结两端' + label + '相容的核对依据', slot.id)
        }
        const upstreamBlocked = issues.some(item => item.step === 1)
        if (upstreamBlocked) issue(number, 'upstream_blocked', '第 2 步：第 1 步尚有缺口，不能将其输出当作已有输入', slot.id)
        const blocked = issues.length !== before
        step.inputs.push({ slotId: slot.id, source: blocked ? 'blocked_link' : 'learner_predicted_link',
          fromSlotId: upstream.id, value: blocked ? null : draft.steps[0].outputs.find(item => item.slotId === upstream.id)?.value || null,
          compatibility: { meaning: binding.meaning, unit: binding.unit, timeState: binding.timeState, objectScope: binding.objectScope },
          semanticStatus: 'learner_report_not_independently_verified' })
      }
    })
    if (!linked) issue(2, 'link_missing', '第 2 步：尚未明确选择承接第 1 步输出的输入槽位')
    const initialConcepts = new Set(steps[0].slots.filter(slot => slot.role === 'input').map(slot => slot.conceptId))
    if (steps[1].slots.some(slot => slot.role === 'output' && initialConcepts.has(slot.conceptId))) warn(2, 'return_to_initial_concept', '链条回到起始概念；即使时间状态不同，也不构成独立新证据')
    warn(0, 'not_verified', '含义、对象范围及适用性核对是用户自述，未独立核验；不是正确答案或事实成立的证明')
    warn(0, 'not_executed', '输出均为用户预测；规律、限定语与不同来源原样保留，未执行公式、逆向推理或合成概率')
    for (const step of steps) step.blocked = issues.some(item => item.step <= step.number)
    return { version: 1, documentId: pair.documentId, revision: pair.revision,
      modelIds: draft.steps.map(step => step.modelId), status: issues.length ? 'blocked' : 'worksheet_complete',
      firstStop: issues.length ? Math.min(...issues.map(item => item.step)) : null,
      basis: 'recorded_fields_and_learner_reports_not_semantic_validity', persisted: false, draft, steps, issues, warnings }
  }
  return { validateDraft, parseExchange, evaluate }
}
