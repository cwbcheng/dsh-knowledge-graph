import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(label + ': pattern not found')
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(label + ': pattern is not unique')
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function replaceBlock(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(label + ': start marker not found')
  const end = source.indexOf(endMarker, start)
  if (end < 0) throw new Error(label + ': end marker not found')
  if (source.indexOf(startMarker, start + startMarker.length) >= 0) throw new Error(label + ': start marker not unique')
  return source.slice(0, start) + replacement + source.slice(end)
}

const nodeTypesInline = 'fact 事实 / claim 主张 / inference 推论 / concept 概念 / definition 定义 / example 例子 / counter_example 反例 / rule 规则'
const relationsInline = 'supports 支持 / example 例子 / counter_example 反例 / defines 定义 / infers 推断 / causes 因果 / is_a 属于 / contains 包含 / driven_by 受驱动于 / not_is 不是 / analogy 类比说明 / aims_at 旨在'
const relationKeys = 'supports/example/counter_example/defines/infers/causes/is_a/contains/driven_by/not_is/analogy/aims_at'

const hostPath = new URL('../src/index.host.js', import.meta.url)
let host = readFileSync(hostPath, 'utf8')

const systemPrompt = `      const SYSTEM_PROMPT = [
        '你是「知识拆解引擎」。用户会给你一段资料正文（章节、技术文档、学习笔记等），正文已按内容切分为编号单元（一个编号单元可能含多个句子），[P数字] 为该单元编号。目标不是摘要，而是生成可复用、可继续推理的原子知识图。',
        '',
        '节点必须从以下 8 类中选择：',
        '1. fact 事实 —— 可直接观察、记录或核对的具体信息/元信息。作者的理论判断、经验概括、价值判断不得标 fact。',
        '2. claim 主张 —— 作者/资料直接提出但未在当前文本中作为客观事实核实的观点、经验概括、理论判断。必须保留“可能、多数、通常、必须、如果”等限定强度。',
        '3. inference 推论 —— 由已有事实/主张结合原文逻辑推出的可复用结论；不能只是换句话复述原句。',
        '4. concept 概念 —— 稳定、可复用的术语或明确命名对象。作者临时标签、修辞表达不得仅因显眼就升级为 concept，除非文本明确把它当作持续讨论的理论对象。',
        '5. definition 定义 —— 对概念的精确界定。',
        '6. example 例子 —— 用于说明某个事实、主张、规则或概念的具体实例。',
        '7. counter_example 反例 —— 边界约束、不成立的情况。',
        '8. rule 规则 —— 方法、步骤、操作流程或明确规范。',
        '',
        '关系必须从以下 12 类中选择：',
        '${relationsInline}',
        '其中 is_a：下位/具体项→上位类别；contains：整体→组成；driven_by：手段/行为→目标或驱动因素；not_is：A→B 表示“A不是/不等同于B”；analogy：类比案例→被说明的原则；aims_at：主体/方案/作品→目标。能用这些精确关系时，不要退化成 supports。',
        '',
        '硬性要求：',
        '1. 每个节点必须给出 paragraph 字段：主要出处所在 [P数字] 的整数编号，必须准确。',
        '2. 每个节点必须尽量给出 quote：使用能完整支撑该节点的最小原文片段。quote 必须保留会改变断言强度的否定、数量范围、可能性、频率、必要性和条件词，例如“可能、多数、部分、通常、必须、如果”。禁止用删掉这些词的片段来支撑更强的表述。',
        '3. 一节点一命题：除 concept 外，一个节点只表达一个可独立判断的主要断言/结果。遇到“A 导致 B，并进一步导致 C/同时产生 D”时拆成多个节点，再用关系连接；禁止把多个并列后果、机制步骤或判断压缩进一个长节点。',
        '4. fact 与 claim 必须严格区分：来源中“作者认为/可能/多数/通常/症结在于/本书认为”等理论或经验判断优先使用 claim；只有可直接观察、记录、核对的具体信息才使用 fact。',
        '5. 宁缺毋滥：环境描写、铺垫、出版服务信息或与主题无关的句子不要进入核心图。',
        '6. 只输出合法 JSON，禁止 markdown 代码块标记，禁止任何解释文字。',
        '7. JSON 结构固定为：{"summary":"一句话总结全文","nodes":[{"id":"n1","type":"claim","text":"节点的原子表述","quote":"原文逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"supports","evidence":[{"paragraph":2,"quote":"能直接证明这条关系的原文逐字摘录"}]}]}',
        '8. type 只能取 fact/claim/inference/concept/definition/example/counter_example/rule；relation 只能取 ${relationKeys}；paragraph 必须是真实编号。',
        '9. 节点 id 用 n1、n2、n3... 全局唯一；edges 的 fromNodeId/toNodeId 必须引用存在节点。',
        '10. 单批节点数最多 48 个；这是安全上限，不是压缩目标。不要为了少建节点而合并本应独立的命题。',
        '11. 每个 fact/claim/inference 节点的 text 必须由 quote 支撑，且不得删除或强化原文的可能性、数量范围、条件、否定和必要性。',
        '12. 同一稳定概念或同一原子命题只建一个节点；优先保留能跨段复用的概念和机制链，但不要把多个原子命题合成“主结论大节点”。',
        '13. 关系方向必须符合语义；每条边必须有直接证明该 relation 的原文 evidence。端点分别出现、主题相似或同段出现都不能单独证明关系。',
        '14. 与主题有关的节点可保持孤立；原文未定义的核心概念允许作为待后文展开的节点存在，禁止为了连通率强行补关系。',
        '15. 输出前自查：节点是否原子？fact/claim 是否分对？是否保留“可能/多数/必须/如果”等强度？是否存在比 supports 更精确的关系？证据是否真的证明节点和关系？',
      ].join(NL)`
host = replaceBlock(host, '      const SYSTEM_PROMPT = [', '\n\n      // Trajectory extraction:', systemPrompt, 'SYSTEM_PROMPT')

const trajPrompt = `      const TRAJ_SYSTEM_PROMPT = [
        '你是「轨迹知识拆解引擎」。用户会给你一段 AI Agent 执行轨迹（每个 [P数字] 是用户消息、工具调用、工具结果或 AI 回复），请把轨迹拆成可复用的原子知识图。',
        '',
        '节点类型：${nodeTypesInline}',
        '其中 fact 仅表示工具/文件/搜索等直接观察到的信息；claim 表示用户或 Agent 直接提出但未被工具结果核实的主张；inference 表示 Agent 基于证据形成的推论。',
        '关系类型：${relationsInline}',
        '',
        '硬性要求：',
        '1. 每个节点必须给出真实 paragraph；quote 尽量逐字摘录并保留可能性、否定、范围与条件词。',
        '2. 一节点一命题：一个节点只保留一个观察、主张、推论或动作规则，多个后果/判断必须拆开。',
        '3. 宁缺毋滥：重复、无关事件不要建节点；工具结果中的直接事实与 Agent 自己的判断必须分开。',
        '4. 只输出合法 JSON，禁止 markdown 或解释文字。',
        '5. type 只能取 fact/claim/inference/concept/definition/example/counter_example/rule；relation 只能取 ${relationKeys}。',
        '6. 单批节点最多 48 个，这是安全上限，不得为了减少节点数合并独立命题。',
        '7. 每条关系必须由轨迹原文直接证明；能用 is_a/contains/driven_by/not_is/analogy/aims_at 等精确关系时不要退化成 supports。',
        '8. 原文依据不足时允许节点保持孤立，禁止为了提高连通率虚构关系。',
        '9. JSON 结构固定为：{"summary":"一句话总结 Agent 做了什么","nodes":[{"id":"n1","type":"fact","text":"原子表述","quote":"轨迹逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"supports","evidence":[{"paragraph":2,"quote":"直接证明关系的轨迹摘录"}]}]}',
      ].join(NL)`
host = replaceBlock(host, '      const TRAJ_SYSTEM_PROMPT = [', '\n\n      // Incremental append:', trajPrompt, 'TRAJ_SYSTEM_PROMPT')

const appendPrompt = `      const APPEND_SYSTEM_PROMPT = [
        '你是「知识图增量拆解引擎」。用户会给你新的资料正文和已有节点清单。只把新正文引入的知识增量加入现有图，并保持原有语义 contract。',
        '',
        '节点：${nodeTypesInline}',
        '关系：${relationsInline}',
        '',
        '硬性要求：',
        '1. 只输出新正文引入的新节点；已有稳定概念/同一原子命题再次出现时不得重复建节点，可通过关系引用已有 id。',
        '2. 一节点一命题；多个后果、步骤或判断必须拆成多个节点。fact 仅用于可直接核对的具体事实，作者理论/经验判断使用 claim。',
        '3. quote 必须保留会改变语义强度的“可能、多数、部分、通常、必须、如果、不是”等词；node.text 不得把可能说成确定、把部分说成全部。',
        '4. 新节点 paragraph 必须来自新正文真实 [P数字]；已有节点 id 必须来自清单，禁止编造。',
        '5. summary 输出合并后整张图的一句话总结。',
        '6. 只输出合法 JSON。type 只能取 fact/claim/inference/concept/definition/example/counter_example/rule；relation 只能取 ${relationKeys}。',
        '7. 单批新节点最多 48 个，这是安全上限，不得通过合并独立命题来满足上限。',
        '8. 能使用 is_a/contains/driven_by/not_is/analogy/aims_at 等精确关系时不要退化成 supports。每条边 evidence 必须直接证明 relation；端点证据不能代替关系证据。',
        '9. 原文没有充分依据时允许节点保持孤立；不要为了接入旧图而虚构关系。',
        '10. JSON 结构固定为：{"summary":"合并后的总结","nodes":[{"id":"n1","type":"claim","text":"原子表述","quote":"原文逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"supports","evidence":[{"paragraph":2,"quote":"直接证明关系的原文摘录"}]}]}',
      ].join(NL)`
host = replaceBlock(host, '      const APPEND_SYSTEM_PROMPT = [', '\n\n      // Incremental trajectory append:', appendPrompt, 'APPEND_SYSTEM_PROMPT')

const trajAppendPrompt = `      const TRAJ_APPEND_SYSTEM_PROMPT = [
        '你是「轨迹知识图增量拆解引擎」。用户会给你新的 AI Agent 执行轨迹和已有节点清单，只加入新轨迹带来的知识增量。',
        '',
        '节点：${nodeTypesInline}',
        '关系：${relationsInline}',
        '',
        '硬性要求：',
        '1. 只输出新轨迹引入的新节点；已有节点再次出现不得重复建节点。',
        '2. fact 仅表示直接工具/文件/搜索结果；未被核实的用户或 Agent 判断使用 claim；基于证据推出的结论使用 inference。',
        '3. 一节点一命题；多个观察、判断或后果必须拆开。quote 必须保留改变断言强度的范围、可能性、否定与条件词。',
        '4. paragraph 必须来自新轨迹真实 [P数字]；已有 id 只能引用给定清单。',
        '5. 单批新节点最多 48 个；这是安全上限，不得为压缩节点数合并独立命题。',
        '6. 关系只能取 ${relationKeys}；优先精确语义关系，每条边 evidence 必须直接证明 relation。',
        '7. 轨迹没有充分依据时允许节点保持孤立，禁止为了连通率虚构关系。',
        '8. 只输出合法 JSON。结构固定为：{"summary":"合并后的总结","nodes":[{"id":"n1","type":"claim","text":"原子表述","quote":"轨迹逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"supports","evidence":[{"paragraph":2,"quote":"直接证明关系的轨迹摘录"}]}]}',
      ].join(NL)`
host = replaceBlock(host, '      const TRAJ_APPEND_SYSTEM_PROMPT = [', '\n\n      // After every chunk has been admitted', trajAppendPrompt, 'TRAJ_APPEND_SYSTEM_PROMPT')

const relationPrompt = `      const RELATION_WEAVE_SYSTEM_PROMPT = [
        '你是「知识图关系编织引擎」。你会收到已经通过验收的节点、已有关系和编号原文。只在原文直接支持时补充遗漏关系；目标是语义精确，不是提高连通率。',
        '',
        '允许的关系：${relationsInline}',
        '',
        '硬性要求：',
        '1. 只输出关系边，禁止新增、删除、合并或改写节点。fromNodeId/toNodeId 必须来自给定节点清单。',
        '2. 禁止仅因关键词相似、主题相近、同段出现或两个端点分别有证据就连边。',
        '3. 每条边必须给 evidence；quote 必须逐字来自原文，并直接证明该 relation。跨段关系列出共同证明关系所需的全部摘录。',
        '4. 优先使用精确关系：is_a 下位→上位；contains 整体→组成；driven_by 手段/行为→目标；not_is A→B；analogy 类比案例→被说明原则；aims_at 主体/方案/作品→目标。只有确实只是论证支持时才用 supports。',
        '5. 其它方向：例子/反例→被说明项，定义→被定义项，事实/主张→推论，因→果。example/counter_example/defines 的源节点类型仍应分别为 example/counter_example/definition。',
        '6. 候选关系对只是召回提示，不是关系证据。孤立节点可以保持孤立，未定义概念也可以悬空。',
        '7. 原文明示“属于/是一种/包含/由…驱动/不是/类比/旨在/导致/因此/例子/定义”等关系时，应选择对应的最精确 relation。',
        '8. 每次最多补充 24 条高置信关系；宁缺毋滥。',
        '9. 只输出合法 JSON，结构固定为：{"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"is_a","evidence":[{"paragraph":2,"quote":"直接证明关系的原文逐字摘录"}]}]}',
      ].join(NL)`
host = replaceBlock(host, '      const RELATION_WEAVE_SYSTEM_PROMPT = [', '\n\n      // Verification / questioning prompts.', relationPrompt, 'RELATION_WEAVE_SYSTEM_PROMPT')

host = replaceOnce(host,
  "        '节点类型：fact 事实 / inference 推论 / concept 概念 / definition 定义 / example 例子 / counter_example 反例 / rule 规则',\n        '关系类型：supports 支持 / example 例子 / counter_example 反例 / defines 定义 / infers 推断 / causes 因果',",
  "        '节点类型：" + nodeTypesInline + "',\n        '关系类型：" + relationsInline + "',\n        '审校时重点检查：作者主张是否被误标 fact；节点是否包含多个独立命题；是否丢失“可能/多数/部分/通常/必须/如果/不是”等语义限定；是否把可用精确关系退化成 supports。',",
  'verify prompt vocabulary')

host = replaceOnce(host,
  "        '5. 关系修复只能使用这些 relation：supports、example、counter_example、defines、infers、causes。若回答指出“n1 应与 n2 建立关系边”，必须把它编码进 edgePatch（fromNodeId、toNodeId、relation、evidence），不能只写在 answer 里；方向或关系类型无法从原文确定时返回 {\"action\":\"none\"}，不要猜测或删除节点。add_edge/update_edge 的 evidence 必须直接证明这条关系。',",
  "        '5. 关系修复只能使用这些 relation：supports、example、counter_example、defines、infers、causes、is_a、contains、driven_by、not_is、analogy、aims_at。优先使用原文明确表达的精确关系；若回答指出“n1 应与 n2 建立关系边”，必须编码进 edgePatch。方向或类型无法确定时返回 {\"action\":\"none\"}。add_edge/update_edge 的 evidence 必须直接证明这条关系。',",
  'question relation vocabulary')

host = replaceOnce(host,
`       const CANDIDATE_CLAIM_TYPES = new Set(['fact', 'inference', 'rule', 'definition', 'counter_example'])`,
`       const CANDIDATE_CLAIM_TYPES = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])`,
'host claim candidate set')

host = replaceOnce(host,
`      const TYPE_ALIASES = {
        fact: 'fact', 事实: 'fact',
        inference: 'inference', 推论: 'inference',`,
`      const TYPE_ALIASES = {
        fact: 'fact', 事实: 'fact',
        claim: 'claim', 主张: 'claim', 观点: 'claim',
        inference: 'inference', 推论: 'inference',`,
'type aliases claim')

host = replaceOnce(host,
`        causes: 'causes', cause: 'causes', 因果: 'causes', 导致: 'causes', drives: 'causes', drive: 'causes', 驱动: 'causes',
      }`,
`        causes: 'causes', cause: 'causes', 因果: 'causes', 导致: 'causes', drives: 'causes', drive: 'causes', 驱动: 'causes',
        is_a: 'is_a', isa: 'is_a', 属于: 'is_a',
        contains: 'contains', contain: 'contains', 包含: 'contains',
        driven_by: 'driven_by', drivenby: 'driven_by', 受驱动于: 'driven_by',
        not_is: 'not_is', notis: 'not_is', 不是: 'not_is', 不等于: 'not_is',
        analogy: 'analogy', analogizes: 'analogy', 类比: 'analogy', 类比说明: 'analogy',
        aims_at: 'aims_at', aim_at: 'aims_at', 旨在: 'aims_at',
      }`,
'relation aliases')

host = replaceOnce(host,
`      const EVIDENCE_REQUIRED_NODE_TYPES = new Set(['fact', 'inference', 'rule', 'definition', 'counter_example'])
      const GROUNDING_STATUSES = new Set(['grounded', 'candidate', 'unsupported'])
      const ENTAILMENT_STATUSES = new Set(['verified', 'unsupported', 'uncertain', 'unverified'])`,
`      const EVIDENCE_REQUIRED_NODE_TYPES = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])
      const SEMANTIC_GUARD_NODE_TYPES = new Set(['fact', 'claim', 'inference', 'rule', 'definition'])
      const SEMANTIC_GUARD_GROUPS = [
        ['可能', '也许', '或许', '未必', '不一定', '似乎', '大概'],
        ['多数', '大多数'],
        ['部分', '一些', '有些', '少数'],
        ['通常', '往往', '常常', '有时'],
        ['必须'],
        ['只有'],
        ['如果', '一旦', '除非'],
      ]
      function semanticGuardDriftHost(quote, text) {
        const source = String(quote || '')
        const normalized = String(text || '')
        for (const group of SEMANTIC_GUARD_GROUPS) {
          const sourceHas = group.some((term) => source.includes(term))
          if (sourceHas && !group.some((term) => normalized.includes(term))) return group.find((term) => source.includes(term)) || group[0]
        }
        return ''
      }
      function nodeLooksNonAtomicHost(node) {
        if (!node || !['fact', 'claim', 'inference', 'rule'].includes(node.type)) return false
        const text = String(node.text || '')
        if (text.length < 90) return false
        const semicolons = (text.match(/[；;]/g) || []).length
        const chainMarkers = (text.match(/(?:并且|同时|以及|导致|从而|于是|因而|进而|继而|随后)/g) || []).length
        return semicolons > 0 || chainMarkers >= 2
      }
      const GROUNDING_STATUSES = new Set(['grounded', 'candidate', 'unsupported'])
      const ENTAILMENT_STATUSES = new Set(['verified', 'unsupported', 'uncertain', 'unverified'])`,
'semantic guard constants')

host = replaceOnce(host,
`          if (!TYPE_ALIASES[node.type]) {
            add('node_invalid_type', true, 'error', 'type', 'node', id, '节点类型不在允许范围内', 'type=' + node.type + ' 不是允许的 7 类节点之一。', [], { action: 'delete_node', nodePatch: { id } })
          }
          if (skipGrounding) continue
          const quote = typeof node.quote === 'string' ? node.quote.trim() : ''
          const pNum = Number.isInteger(node.paragraph) && node.paragraph >= 0 && node.paragraph < paras.length ? node.paragraph : null`,
`          if (!TYPE_ALIASES[node.type]) {
            add('node_invalid_type', true, 'error', 'type', 'node', id, '节点类型不在允许范围内', 'type=' + node.type + ' 不是允许的 8 类节点之一。', [], { action: 'delete_node', nodePatch: { id } })
          }
          if (skipGrounding) continue
          const quote = typeof node.quote === 'string' ? node.quote.trim() : ''
          const pNum = Number.isInteger(node.paragraph) && node.paragraph >= 0 && node.paragraph < paras.length ? node.paragraph : null
          const semanticGuard = SEMANTIC_GUARD_NODE_TYPES.has(node.type) ? semanticGuardDriftHost(quote, node.text) : ''
          if (semanticGuard) {
            add('node_semantic_strength_drift', true, 'error', 'grounding', 'node', id,
              '节点表述改变了原文断言强度',
              '原文证据包含“' + semanticGuard + '”等范围/可能性/条件限定，但节点 text 没有保留同类限定，可能把弱主张升级成强断言。',
              pNum != null ? [{ paragraph: pNum, quote }] : [], { action: 'none' }, 1,
              { safeRepairable: false })
          }`,
'semantic strength invariant')

host = replaceOnce(host,
`          if (includeQuality) {
            const groundingStatus = declaredQuoteMatch || quotePara != null`,
`          if (includeQuality) {
            if (nodeLooksNonAtomicHost(node)) {
              add('node_non_atomic_suspected', false, 'warning', 'type', 'node', id,
                '节点可能包含多个独立命题',
                '该节点较长且包含多重并列/因果连接词；建议按“一节点一命题”拆成多个节点并用关系连接。',
                pNum != null ? [{ paragraph: pNum, quote }] : [], { action: 'none' })
            }
            const groundingStatus = declaredQuoteMatch || quotePara != null`,
'atomicity quality warning')

writeFileSync(hostPath, host)

const clientPath = new URL('../src/index.client.js', import.meta.url)
let client = readFileSync(clientPath, 'utf8')
client = client.replace('Graph: 7 node-type colors', 'Graph: 8 node-type colors')
client = replaceOnce(client,
`      const TYPE_META = {
        fact: { label: '事实', color: '#3b82f6', fill: 'rgba(59,130,246,0.15)' },
        inference: { label: '推论', color: '#8b5cf6', fill: 'rgba(139,92,246,0.15)' },`,
`      const TYPE_META = {
        fact: { label: '事实', color: '#3b82f6', fill: 'rgba(59,130,246,0.15)' },
        claim: { label: '主张', color: '#0f766e', fill: 'rgba(15,118,110,0.15)' },
        inference: { label: '推论', color: '#8b5cf6', fill: 'rgba(139,92,246,0.15)' },`,
'client claim meta')
client = replaceOnce(client,
`      const REL_LABEL = { supports: '支持', example: '例子', counter_example: '反例', defines: '定义', infers: '推断', causes: '因果' }
      const REL_SOURCE_RULES = { example: 'example', counter_example: 'counter_example', defines: 'definition' }
      const TYPE_ORDER = ['fact', 'inference', 'concept', 'definition', 'example', 'counter_example', 'rule']
       const CANDIDATE_ENTITY_TYPES = new Set(['concept', 'definition'])
       const CANDIDATE_CLAIM_TYPES = new Set(['fact', 'inference', 'rule', 'definition', 'counter_example'])`,
`      const REL_LABEL = { supports: '支持', example: '例子', counter_example: '反例', defines: '定义', infers: '推断', causes: '因果', is_a: '属于', contains: '包含', driven_by: '受驱动于', not_is: '不是', analogy: '类比说明', aims_at: '旨在' }
      const REL_SOURCE_RULES = { example: 'example', counter_example: 'counter_example', defines: 'definition' }
      const TYPE_ORDER = ['fact', 'claim', 'inference', 'concept', 'definition', 'example', 'counter_example', 'rule']
       const CANDIDATE_ENTITY_TYPES = new Set(['concept', 'definition'])
       const CANDIDATE_CLAIM_TYPES = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])`,
'client relation/type vocabulary')
writeFileSync(clientPath, client)

const storePath = new URL('../src/kg-store.mjs', import.meta.url)
let store = readFileSync(storePath, 'utf8')
store = replaceOnce(store,
`const CLAIM_TYPES = new Set(['fact', 'inference', 'rule', 'definition', 'counter_example'])`,
`const CLAIM_TYPES = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])`,
'store claim candidates')
writeFileSync(storePath, store)

const semanticTest = `import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const calls = []
const extractor = async ({ title, attempt, systemPrompt, prompt }) => {
  calls.push({ title, attempt, systemPrompt, prompt })
  if (title === 'semantic-modal') {
    if (attempt === 0) {
      return {
        summary: '模态漂移',
        nodes: [{ id: 'c1', type: 'claim', text: '这是世上最普遍的学习方式', quote: '这可能是世上最普遍的学习方式', paragraph: 0 }],
        edges: [],
      }
    }
    return {
      summary: '模态保真',
      nodes: [{ id: 'c1', type: 'claim', text: '这可能是世上最普遍的学习方式', quote: '这可能是世上最普遍的学习方式', paragraph: 0 }],
      edges: [],
    }
  }
  if (title === 'semantic-relations') {
    return {
      summary: '精确语义关系',
      nodes: [
        { id: 'n1', type: 'concept', text: '学习方法', quote: '学习方法', paragraph: 0 },
        { id: 'n2', type: 'concept', text: '手段', quote: '手段', paragraph: 0 },
        { id: 'n3', type: 'concept', text: '可验证的行为目标', quote: '可验证的行为目标', paragraph: 1 },
        { id: 'n4', type: 'concept', text: '感觉懂了', quote: '感觉懂了', paragraph: 2 },
        { id: 'n5', type: 'concept', text: '学习系统', quote: '学习系统', paragraph: 3 },
        { id: 'n6', type: 'concept', text: '知识基本组成', quote: '知识基本组成', paragraph: 3 },
        { id: 'n7', type: 'example', text: '增肌案例', quote: '增肌案例', paragraph: 4 },
        { id: 'n8', type: 'claim', text: '同一手段需要由正确目标驱动', quote: '同一手段需要由正确目标驱动', paragraph: 4 },
        { id: 'n9', type: 'concept', text: '本书', quote: '本书', paragraph: 5 },
      ],
      edges: [
        { fromNodeId: 'n1', toNodeId: 'n2', relation: 'is_a', evidence: [{ paragraph: 0, quote: '学习方法属于实现学习目的的手段' }] },
        { fromNodeId: 'n1', toNodeId: 'n3', relation: 'driven_by', evidence: [{ paragraph: 1, quote: '学习方法由可验证的行为目标驱动' }] },
        { fromNodeId: 'n4', toNodeId: 'n3', relation: 'not_is', evidence: [{ paragraph: 2, quote: '感觉懂了不是可验证的行为目标' }] },
        { fromNodeId: 'n5', toNodeId: 'n6', relation: 'contains', evidence: [{ paragraph: 3, quote: '学习系统包含知识基本组成' }] },
        { fromNodeId: 'n7', toNodeId: 'n8', relation: 'analogy', evidence: [{ paragraph: 4, quote: '增肌案例通过类比说明：同一手段需要由正确目标驱动' }] },
        { fromNodeId: 'n9', toNodeId: 'n5', relation: 'aims_at', evidence: [{ paragraph: 5, quote: '本书旨在重建学习系统' }] },
      ],
    }
  }
  throw new Error('unexpected fixture ' + title)
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? extractor : null },
  interval() { return () => {} },
})

async function waitTask(taskId) {
  for (let i = 0; i < 160; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const modalStart = await handlers.get('extract')({ title: 'semantic-modal', text: '这可能是世上最普遍的学习方式' })
const modal = await waitTask(modalStart.taskId)
assert(modal.status === 'succeeded', 'modal fixture failed: ' + JSON.stringify(modal))
assert(calls.filter((call) => call.title === 'semantic-modal').length === 2, 'semantic-strength drift did not trigger a bounded retry')
const retry = calls.find((call) => call.title === 'semantic-modal' && call.attempt === 1)
assert(retry && retry.prompt.includes('node_semantic_strength_drift'), 'typed modal-drift feedback was not supplied to retry')
assert(modal.result.nodes[0].type === 'claim' && modal.result.nodes[0].text.includes('可能'), 'author claim was not preserved as a qualified claim')
const contractPrompt = calls.find((call) => call.title === 'semantic-modal').systemPrompt
assert(contractPrompt.includes('一节点一命题'), 'atomic proposition contract is missing')
assert(contractPrompt.includes('claim 主张'), 'claim node type is missing from extraction contract')
assert(contractPrompt.includes('作者的理论判断、经验概括、价值判断不得标 fact'), 'fact/claim boundary is not explicit')
assert(contractPrompt.includes('临时标签、修辞表达不得仅因显眼就升级为 concept'), 'concept promotion guard is missing')
assert(contractPrompt.includes('driven_by') && contractPrompt.includes('analogy') && contractPrompt.includes('aims_at'), 'precise semantic relations are missing from prompt')
assert(contractPrompt.includes('这是安全上限，不是压缩目标'), 'node cap still incentivizes proposition compression')

const relationText = [
  '学习方法属于实现学习目的的手段',
  '学习方法由可验证的行为目标驱动',
  '感觉懂了不是可验证的行为目标',
  '学习系统包含知识基本组成',
  '增肌案例通过类比说明：同一手段需要由正确目标驱动',
  '本书旨在重建学习系统',
].join('\\n\\n')
const relationStart = await handlers.get('extract')({ title: 'semantic-relations', text: relationText })
const relation = await waitTask(relationStart.taskId)
assert(relation.status === 'succeeded', 'new relation vocabulary was rejected: ' + JSON.stringify(relation))
const rels = new Set(relation.result.edges.map((edge) => edge.relation))
for (const expected of ['is_a', 'driven_by', 'not_is', 'contains', 'analogy', 'aims_at']) {
  assert(rels.has(expected), 'missing accepted semantic relation: ' + expected + ' / ' + JSON.stringify(relation.result.edges))
}

const quick = await handlers.get('verify-graph')({ text: relationText, graph: relation.result, mode: 'quick' })
assert(quick && quick.report && quick.report.metrics.errorCount === 0, 'new semantic relations do not survive quick verification: ' + JSON.stringify(quick && quick.report && quick.report.issues))

const db = await openSqliteStore(':memory:')
const documentId = 'semantic-claim-candidate'
const sourceId = 'source-semantic-claim'
const chunkId = 'chunk-semantic-claim'
db.saveGraph({
  summary: 'claim candidate',
  source: { id: sourceId, documentId, title: 'claim', chars: 4, paragraphCount: 1, chunkCount: 1, sectionCount: 1, sections: [{ id: 's1', title: '全文', startParagraph: 0, endParagraph: 0, summary: '' }] },
  staging: { sourceId, documentId, chunkCount: 1, chunks: [{ chunkId, sourceId, startParagraph: 0, endParagraph: 0, sectionIds: ['s1'], sectionTitles: ['全文'], summary: '', nodeIds: ['c1'], edgeCount: 0, warnings: [] }] },
  nodes: [{ id: 'c1', type: 'claim', text: '作者主张', quote: '作者主张', paragraph: 0, evidence: [{ documentId, sourceId, chunkId, paragraph: 0, quote: '作者主张' }], groundingStatus: 'grounded', entailmentStatus: 'unverified', documentId, sourceId, chunkId }],
  edges: [],
}, { sourceText: '作者主张' })
const claimCandidates = db.listCandidates({ documentId, kind: 'claim', limit: 20 })
assert(claimCandidates.some((candidate) => candidate.nodeId === 'c1' && candidate.type === 'claim'), 'claim nodes are not included in candidate review')
db.close()

console.log(JSON.stringify({
  ok: true,
  modalRetry: true,
  atomicContract: true,
  claimType: true,
  semanticRelations: Array.from(rels).sort(),
  claimCandidate: true,
}))
`
writeFileSync(new URL('./kg-semantic-contract-smoke.mjs', import.meta.url), semanticTest)

const packagePath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
pkg.scripts['test:kg-semantic-contract'] = 'node scripts/kg-semantic-contract-smoke.mjs'
if (!pkg.scripts.test.includes('test:kg-semantic-contract')) {
  pkg.scripts.test = pkg.scripts.test.replace(' && npm run test:kg-trust-boundary', ' && npm run test:kg-semantic-contract && npm run test:kg-trust-boundary')
}
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')

console.log(JSON.stringify({ ok: true, patched: ['src/index.host.js', 'src/index.client.js', 'src/kg-store.mjs', 'scripts/kg-semantic-contract-smoke.mjs', 'package.json'] }))
