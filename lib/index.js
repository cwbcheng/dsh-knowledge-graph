/**
 * dsh-knowledge-graph — persistent host half (Cordis composition module).
 *
 * Mirrors src/index.host.js (dynamic-package format) for the persistent
 * install: same engine, but the browser talks to it over the webServer HTTP
 * route /api/dsh-knowledge-graph instead of the package-private harness RPC.
 * Keep engine logic in sync with src/index.host.js.
 */
export const name = 'dsh-knowledge-graph'
// webServer hosts the RPC route; timer gives ctx.timeout/ctx.interval.
export const inject = ['webServer', 'timer']
import { openSqliteStore, defaultStorePath } from './kg-store.mjs'

export function apply(ctx) {
  let sqliteStorePromise = null
  const getSqliteStore = () => {
    if (!sqliteStorePromise) sqliteStorePromise = openSqliteStore(defaultStorePath())
    return sqliteStorePromise
  }
  const persistGraph = async (graph, task) => {
    const store = await getSqliteStore()
    return store.saveGraph(graph, { runId: task && task.id ? task.id : undefined })
  }
  const persistCheckpoint = async (checkpoint, task, status) => {
    const store = await getSqliteStore()
    return store.saveCheckpoint(checkpoint, { runId: task && task.id ? task.id : undefined, status })
  }
      const NL = String.fromCharCode(10)
      // Extraction accepts a substantially larger source than one model prompt;
      // runTask still processes it in bounded chunks. Keep the cap below the
      // HTTP/body and browser-storage limits while allowing book-sized inputs.
      const MAX_TEXT = 1000000
       const MAX_VERIFY_TEXT = 4000000
       const MAX_VERIFY_SCOPE_UNITS = 2000
       const MAX_VERIFY_SCOPE_CHARS = 240000
      const MAX_TRACE_TEXT = 20000
      // buildLocalReport performs O(n²) duplicate/contradiction scans; cap
      // verification input so a crafted request cannot block the host loop.
      const MAX_VERIFY_NODES = 800
      const MAX_GRAPH_NODES = 800
       const MAX_DOCUMENT_FILE_BYTES = 15 * 1024 * 1024
       const MAX_ARCHIVE_ENTRIES = 200
       const MAX_ARCHIVE_ENTRY_OUTPUT_BYTES = 8 * 1024 * 1024
       const MAX_ARCHIVE_OUTPUT_BYTES = 32 * 1024 * 1024
       const MAX_PDF_STREAM_OUTPUT_BYTES = 8 * 1024 * 1024
       const MAX_EXTRACTED_DOCUMENT_CHARS = 4 * 1024 * 1024
       // Optional host capability: a composition may provide a declaration
       // extractor service. It receives owned chunk JSON and may return either
       // the normalized graph object or the JSON text expected from the LLM.
       const kgExtractor = ctx.get('kgExtractor')
       const hasKgExtractor = typeof kgExtractor === 'function' || Boolean(kgExtractor && typeof kgExtractor.extractChunk === 'function')
       const candidateReviewState = new Map()
       const CANDIDATE_ENTITY_TYPES = new Set(['concept', 'definition'])
       const CANDIDATE_CLAIM_TYPES = new Set(['fact', 'inference', 'rule', 'definition', 'counter_example'])
       const CANDIDATE_STATUSES = new Set(['candidate', 'accepted', 'rejected'])
       function candidateDocumentId(graph) {
         const source = graph && graph.source && typeof graph.source === 'object' ? graph.source : {}
         return typeof source.documentId === 'string' && source.documentId ? source.documentId : (typeof graph.documentId === 'string' && graph.documentId ? graph.documentId : (typeof source.id === 'string' ? source.id : 'local'))
       }
       function candidateRowsFromGraph(graph, options = {}) {
         const documentId = candidateDocumentId(graph)
         const requestedKind = options.kind === 'entity' || options.kind === 'claim' ? options.kind : 'all'
         const requestedStatus = CANDIDATE_STATUSES.has(options.status) ? options.status : null
         const limit = Math.max(1, Math.min(500, Number.isInteger(options.limit) ? options.limit : 100))
         const rows = []
         for (const node of Array.isArray(graph && graph.nodes) ? graph.nodes : []) {
           if (!node || typeof node.id !== 'string' || typeof node.text !== 'string' || !node.text.trim()) continue
           const kinds = []
           if (CANDIDATE_ENTITY_TYPES.has(node.type)) kinds.push('entity')
           if (CANDIDATE_CLAIM_TYPES.has(node.type)) kinds.push('claim')
           for (const kind of kinds) {
             if (requestedKind !== 'all' && requestedKind !== kind) continue
             const key = documentId + '|' + kind + '|' + node.id
             const status = CANDIDATE_STATUSES.has(candidateReviewState.get(key)) ? candidateReviewState.get(key) : 'candidate'
             if (requestedStatus && status !== requestedStatus) continue
             rows.push({
               id: (kind === 'entity' ? 'ent_' : 'clm_') + node.id,
               kind,
               documentId,
               nodeId: node.id,
               text: node.text,
               type: node.type,
               status,
               confidence: typeof node.confidence === 'number' ? node.confidence : null,
               evidence: Array.isArray(node.evidence) ? node.evidence : [],
               paragraph: Number.isInteger(node.paragraph) ? node.paragraph : null,
               sectionId: typeof node.sectionId === 'string' ? node.sectionId : null,
               sectionTitle: typeof node.sectionTitle === 'string' ? node.sectionTitle : null,
             })
           }
         }
         return rows.slice(0, limit)
       }
       function candidateKeyFromArgs(args) {
         const documentId = typeof args.documentId === 'string' && args.documentId ? args.documentId : candidateDocumentId(args.graph)
         const kind = args.kind === 'entity' ? 'entity' : args.kind === 'claim' ? 'claim' : ''
         const nodeId = typeof args.nodeId === 'string' && args.nodeId ? args.nodeId : ''
         return kind && nodeId ? documentId + '|' + kind + '|' + nodeId : ''
       }

      const SYSTEM_PROMPT = [
        '你是「知识拆解引擎」。用户会给你一段资料正文（章节、技术文档、学习笔记等），正文已按内容切分为编号单元（一个编号单元可能是自然段里的若干句），[P数字] 为该单元的编号，请把它拆解为一张知识图。',
        '',
        '节点必须从以下 7 类中选择：',
        '1. fact 事实 —— 谁做了什么、具体的陈述',
        '2. inference 推论 —— 由事实推出、可复用的结论',
        '3. concept 概念 —— 跨文档出现的抽象名词',
        '4. definition 定义 —— 概念的精确界定',
        '5. example 例子 —— 支撑事实或概念的具体实例',
        '6. counter_example 反例 —— 边界约束、不成立的情况',
        '7. rule 规则 —— 方法、步骤、操作流程',
        '',
        '关系必须从以下 6 类中选择：',
        'supports 支持 / example 例子 / counter_example 反例 / defines 定义 / infers 推断 / causes 因果',
        '',
        '硬性要求：',
        '1. 每个节点必须给出 paragraph 字段：该节点主要出处所在段落的编号（即原文中 [P数字] 标记里的数字，整数）。这是回链定位的关键依据，必须准确。',
        '2. 每个节点还应给出 quote 字段：资料原文中逐字摘录的句子或片段，尽量原样引用，禁止改写或编造；摘录不到时可以为空字符串。',
        '3. 宁缺毋滥：环境描写、铺垫、与主题无关的句子不要拆成节点。',
        '4. 只输出合法 JSON，禁止 markdown 代码块标记，禁止任何解释文字。',
        '5. JSON 结构固定为：{"summary":"一句话总结全文","nodes":[{"id":"n1","type":"fact","text":"节点的规范表述","quote":"原文逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"supports"}]}',
        '6. type 只能取 fact/inference/concept/definition/example/counter_example/rule 之一；relation 只能取 supports/example/counter_example/defines/infers/causes 之一；paragraph 必须是正文中真实存在的段落编号。',
        '7. 节点 id 用 n1、n2、n3... 全局唯一；edges 中的 fromNodeId/toNodeId 必须引用存在的节点 id。',
        '8. 单批节点数不超过 30 个。',
        '9. 每个 fact/inference 节点的 text 必须能从其 quote 所在位置推出；inference 必须是可复用的结论，不能只是换句话复述事实。',
        '10. 同一概念、同一事实只建一个节点；节点 text 要精炼，不要整段照抄原文。',
        '11. 默认只在当前批次内建边；如果提示附带“已有节点候选清单”，可在语义依据充分时连接其中真实存在的节点，但不得编造 id；每条边的方向必须符合语义（例子/反例→被支撑项，定义→被定义项，事实→推论，因→果）。',
        '12. 输出前自查：先想“这段原文真的支持这个节点/这条边吗？类型对吗？方向对吗？”，确认后再输出 JSON。',
      ].join(NL)

      // Trajectory extraction: the input is an AGENT EXECUTION TRACE (each
      // [P数字] is one numbered trace event — a user message, a tool call, a
      // tool result, or an assistant reply), not prose.
      const TRAJ_SYSTEM_PROMPT = [
        '你是「轨迹知识拆解引擎」。用户会给你一段 AI Agent 的执行轨迹（每个 [P数字] 是一个编号事件：用户消息、工具调用、工具结果或 AI 回复），请把它拆解为一张知识图，可视化这个 Agent 查到了什么、做出了什么判断。',
        '',
        '节点必须从以下 7 类中选择：',
        '1. fact 事实 —— Agent 查到/观察到的具体信息（工具结果、搜索结果、文件内容）',
        '2. inference 推论 —— Agent 由事实推出的结论或判断',
        '3. concept 概念 —— 轨迹中反复出现的主题/抽象名词',
        '4. definition 定义 —— 概念的精确界定',
        '5. example 例子 —— 支撑事实或概念的具体实例',
        '6. counter_example 反例 —— 边界约束、不成立的情况',
        '7. rule 规则 —— Agent 遵循的方法、步骤、操作流程',
        '',
        '关系必须从以下 6 类中选择：',
        'supports 支持 / example 例子 / counter_example 反例 / defines 定义 / infers 推断 / causes 因果',
        '',
        '硬性要求：',
        '1. 每个节点必须给出 paragraph 字段：该节点主要出处所在轨迹事件的编号（[P数字] 中的数字，整数）。',
        '2. 每个节点还应给出 quote 字段：轨迹原文中逐字摘录的片段，尽量原样引用；摘录不到时可以为空字符串。',
        '3. 宁缺毋滥：重复的、无关的事件不要拆成节点；优先保留"查到了什么"和"因此做出了什么判断"。',
        '4. 只输出合法 JSON，禁止 markdown 代码块标记，禁止任何解释文字。',
        '5. JSON 结构固定为：{"summary":"一句话总结这个 Agent 做了什么","nodes":[{"id":"n1","type":"fact","text":"节点的规范表述","quote":"轨迹逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"supports"}]}',
        '6. type 只能取 fact/inference/concept/definition/example/counter_example/rule 之一；relation 只能取 supports/example/counter_example/defines/infers/causes 之一；paragraph 必须是轨迹中真实存在的事件编号。',
        '7. 节点 id 用 n1、n2、n3... 全局唯一；edges 中的 fromNodeId/toNodeId 必须引用存在的节点 id。',
        '8. 单批节点数不超过 30 个。',
        '9. 每个 fact/inference 节点的 text 必须能从其 quote 所在位置推出；inference 必须是可复用的结论，不能只是换句话复述事实。',
        '10. 同一概念、同一事实只建一个节点；节点 text 要精炼，不要整段照抄原文。',
        '11. 默认只在当前批次内建边；如果提示附带“已有节点候选清单”，可在语义依据充分时连接其中真实存在的节点，但不得编造 id；每条边的方向必须符合语义（例子/反例→被支撑项，定义→被定义项，事实→推论，因→果）。',
        '12. 输出前自查：先想“这段原文真的支持这个节点/这条边吗？类型对吗？方向对吗？”，确认后再输出 JSON。',
      ].join(NL)

      // Incremental append: the input is NEW text plus the EXISTING graph
      // (node list). The AI only outputs new nodes; edges may reference
      // existing node ids so the new part links into the old graph.
      const APPEND_SYSTEM_PROMPT = [
        '你是「知识图增量拆解引擎」。用户会给你一段新的资料正文（每个 [P数字] 是一个编号段落），以及一张已经存在的知识图节点清单（格式：节点id|类型|文本）。请把新正文引入的知识增量地加入这张图。',
        '',
        '节点类型与关系类型同常规拆分：',
        '节点：fact 事实 / inference 推论 / concept 概念 / definition 定义 / example 例子 / counter_example 反例 / rule 规则',
        '关系：supports 支持 / example 例子 / counter_example 反例 / defines 定义 / infers 推断 / causes 因果',
        '',
        '硬性要求：',
        '1. 只输出新正文引入的新节点；已有的概念再次出现时绝不重复建节点，而是输出指向该已有节点 id 的关系边。',
        '2. 关系边既可以连接两个新节点，也可以连接新节点与已有节点；引用已有节点时 fromNodeId/toNodeId 必须是节点清单中真实存在的 id，禁止编造。',
        '3. 每个新节点必须给出 paragraph 字段：[P数字] 中的数字（相对于新正文的段落编号，整数）；quote 字段尽量逐字摘录。',
        '4. summary 字段输出合并后整张图的一句话总结（涵盖新旧全部内容）。',
        '5. 只输出合法 JSON，禁止 markdown 代码块标记，禁止任何解释文字。',
        '6. JSON 结构固定为：{"summary":"合并后的一句话总结","nodes":[{"id":"n1","type":"fact","text":"节点的规范表述","quote":"原文逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"supports"}]}',
        '7. 节点 id 用 n1、n2、n3... 且不得与节点清单中的已有 id 重复；单批新节点不超过 30 个。',
        '8. 宁缺毋滥：与已有图重复、无关的内容不要输出节点。',
        '9. 输出前自查：每个新节点的 text 都能从新正文 quote 推出；与已有节点的边必须有语义依据，不要因为名称相似就强行连边；关系方向必须正确。',
      ].join(NL)

      // Incremental trajectory append: NEW trace events plus the existing
      // trajectory graph. Same mechanics as APPEND_SYSTEM_PROMPT, but framed
      // for agent-execution events (tools/facts/inferences).
      const TRAJ_APPEND_SYSTEM_PROMPT = [
        '你是「轨迹知识图增量拆解引擎」。用户会给你一段新的 AI Agent 执行轨迹（每个 [P数字] 是一个编号事件：用户消息、工具调用、工具结果或 AI 回复），以及一张已经存在的轨迹知识图节点清单（格式：节点id|类型|文本）。请把新轨迹中引入的知识增量地加入这张图。',
        '',
        '节点类型与关系类型同常规拆分：',
        '节点：fact 事实 / inference 推论 / concept 概念 / definition 定义 / example 例子 / counter_example 反例 / rule 规则',
        '关系：supports 支持 / example 例子 / counter_example 反例 / defines 定义 / infers 推断 / causes 因果',
        '',
        '硬性要求：',
        '1. 只输出新轨迹引入的新节点；已有概念再次出现时绝不重复建节点，而是输出指向该已有节点 id 的关系边。',
        '2. 关系边既可以连接两个新节点，也可以连接新节点与已有节点；引用已有节点时 fromNodeId/toNodeId 必须是节点清单中真实存在的 id，禁止编造。',
        '3. 每个新节点必须给出 paragraph 字段：[P数字] 中的数字（相对于新轨迹的事件编号，整数）；quote 字段尽量逐字摘录。',
        '4. summary 字段输出合并后整张图的一句话总结（涵盖新旧全部内容）。',
        '5. 只输出合法 JSON，禁止 markdown 代码块标记，禁止任何解释文字。',
        '6. JSON 结构固定为：{"summary":"合并后的一句话总结","nodes":[{"id":"n1","type":"fact","text":"节点的规范表述","quote":"轨迹逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"n1","toNodeId":"n2","relation":"supports"}]}',
        '7. 节点 id 用 n1、n2、n3... 且不得与节点清单中的已有 id 重复；单批新节点不超过 30 个。',
        '8. 宁缺毋滥：与已有图重复、无关的事件不要输出节点；优先保留「查到了什么」和「因此做出了什么判断」。',
        '9. 输出前自查：每个新节点的 text 都能从新轨迹 quote 推出；与已有节点的边必须有语义依据，不要因为名称相似就强行连边；关系方向必须正确。',
      ].join(NL)

      // Verification / questioning prompts. The verifier is an ADVERSARIAL
      // reviewer: the source text is the only ground truth, every issue must
      // carry evidence that can be located in the source, and low-confidence
      // issues are not emitted. Standard mode adds a second pass that keeps
      // only issues a second LLM call corroborates (mitigates critic noise).
      const VERIFY_SYSTEM_PROMPT = [
        '你是「知识图审校引擎」。用户会同时给你（A）资料原文（已按内容切分并编号，[P数字] 为内容单元编号）和（B）由另一个模型生成的知识图 JSON。你的任务不是复述，而是逐节点、逐边地质疑这张图，找出与原文不符、证据不足、类型/关系不合理、自相矛盾或明显重复的内容。',
        '',
        '节点类型：fact 事实 / inference 推论 / concept 概念 / definition 定义 / example 例子 / counter_example 反例 / rule 规则',
        '关系类型：supports 支持 / example 例子 / counter_example 反例 / defines 定义 / infers 推断 / causes 因果',
        '',
        '检查维度：',
        '1. grounding 事实性：节点 text 是否忠于原文 quote 所在段落？是否夸大、曲解或超出原文？quote 是否真能在对应段落找到？',
        '2. type 类型：节点类型是否贴切（尤其 fact 与 inference、definition 与 concept 的区分）？',
        '3. relation 关系：边是否存在且方向正确？example/counter_example 的源应是例子/反例，defines 的源应是定义；infers 的目标应是推论。',
        '4. duplicate 重复：不同 id 的节点是否在说同一件事，应当合并？',
        '5. contradiction 矛盾：图内两个节点是否互相冲突？',
        '6. completeness 遗漏：原文中重要的结论、定义、规则或边界条件是否漏拆？',
        '7. summary 总结：summary 是否忠于全文、不夸大？',
        '',
        '硬性要求：',
        '1. 原文是唯一事实源：禁止用外部知识或你的常识去"纠正"原文内容本身；只判断图与原文是否一致。',
        '2. 每条 issue 必须给出 evidence（至少一条）：{"paragraph": 段落编号, "quote": "原文逐字摘录"}；quote 必须能在原文中找到，找不到证据的质疑禁止输出。',
        '3. 只有 confidence >= 0.7 的 issue 才允许输出；宁缺毋滥。',
        '4. 只输出合法 JSON，禁止 markdown 代码块标记，禁止解释文字。',
        '5. JSON 结构固定为：{"issues":[{"id":"v1","severity":"error|warning|suggestion","category":"grounding|type|relation|duplicate|contradiction|completeness|summary","targetKind":"node|edge|graph","targetId":"n3 或 fromNodeId>toNodeId","title":"一句话问题","detail":"为什么有问题","evidence":[{"paragraph":2,"quote":"原文逐字摘录"}],"confidence":0.9,"proposedFix":{"action":"none|update_node|delete_node|add_node|update_edge|delete_edge|add_edge|merge_nodes|update_summary","nodePatch":{"id":"n3","patch":{"type":"fact","text":"修正后的表述","quote":"修正后的摘录","paragraph":2}},"edgePatch":{"fromNodeId":"n1","toNodeId":"n2","relation":"supports"},"mergeIntoId":"n5"}}]}',
        '6. targetId：node 用节点 id；edge 用 "fromNodeId>toNodeId"；graph 用 null。没有修复方案时 proposedFix 用 {"action":"none"}。',
        '7. 控制输出长度：title 不超过 80 字，detail 不超过 300 字，evidence.quote 不超过 200 字，避免输出被截断。',
        '8. 每批最多输出 15 个 issue：只报最确定的 error/warning，suggestion 最多 3 条；宁可下一批/下次复核再报，也不要输出超长内容导致超时。',
      ].join(NL)

      const VERIFIER_SYSTEM_PROMPT = [
        '你是「知识图审校复核员」。你会收到（A）候选问题列表、（B）问题相关的原文段落。请逐条判断：该候选问题是否真的被原文支持、是否属于误报或夸大。',
        '',
        '硬性要求：',
        '1. 只有原文确实支持该问题时才保留；证据牵强、属于风格偏好或需要外部知识才能判断的一律剔除。',
        '2. 只输出合法 JSON，禁止 markdown 代码块标记，禁止解释文字。',
        '3. JSON 结构固定为：{"kept":[{"id":"候选问题id","note":"复核意见"}]}',
      ].join(NL)

      const QUESTION_SYSTEM_PROMPT = [
        '你是「知识图答疑审校员」。用户对一张由 AI 生成的知识图提出了一个质疑或问题。你会收到（A）与质疑相关的原文段落、（B）相关的知识图子图、（C）用户的问题。',
        '',
        '请只依据原文回答：',
        '1. 图的这部分是否真的被原文支持？用户的质疑是否成立？',
        '2. verdict 只能取：supported（图被原文支持，质疑不成立）/ contradicted（图与原文矛盾，质疑成立）/ insufficient（原文证据不足，无法支持该图内容）/ out_of_scope（问题超出本图与原文范围）。',
        '3. evidence 必须给出原文逐字摘录与段落编号；找不到证据时给空数组。',
        '4. 如需修正图，给出 proposedFix（结构同审校引擎）；否则给 {"action":"none"}。',
        '5. 只输出合法 JSON，禁止 markdown 代码块标记，禁止解释文字。',
        '6. JSON 结构固定为：{"verdict":"supported|contradicted|insufficient|out_of_scope","answer":"结论与解释","evidence":[{"paragraph":2,"quote":"原文逐字摘录"}],"proposedFix":{"action":"none"}}',
      ].join(NL)

      // Multi-batch summary consolidation: batch prompts ask for a local
      // summary, so a second small call merges them into ONE full-text summary
      // instead of letting the first/last batch's local summary win.
      const SUMMARY_SYSTEM_PROMPT = [
        '你是「摘要合并引擎」。你会收到（A）资料既有的一句话总结（可能为空）和（B）各批内容的一句话总结。请合并成一句涵盖全文要点、不超过 80 字的总结。',
        '只输出合法 JSON，禁止 markdown 代码块标记，禁止解释文字。',
        'JSON 结构固定为：{"summary":"合并后的一句话总结"}',
      ].join(NL)

      // External fact-checking: the SOURCE TEXT (not the graph) is now the
      // target. Claims come from graph nodes; evidence comes from retrievers
      // (Wikipedia is the built-in free provider) and optional user rules.
      // The judge may only cite evidence ids that were actually provided —
      // this makes hallucinated URLs/citations structurally impossible.
      const FACT_JUDGE_SYSTEM_PROMPT = [
        '你是「外部事实核查裁决员」。你会收到（A）待核查声明列表、（B）检索到的证据列表（可能为空）、（C）原文上下文。',
        '任务：逐条判断声明与外部证据是否一致。',
        '',
        'verdict 只能取：',
        'supported（证据支持声明）/ contradicted（证据与声明冲突）/ partially_supported（方向对但范围、程度、细节有误）/ insufficient（证据不足，无法判断）/ unverifiable（主观、虚构、无法外部核查）/ out_of_scope（超出配置的核查领域）',
        '',
        '硬性要求：',
        '1. 只能引用 evidence 列表中真实存在的 evidenceId；禁止编造证据、URL 或引文。',
        '2. evidenceQuote 必须从对应证据的 snippet 中逐字摘录（找不到就留空）。',
        '3. 证据列表为空（快速模式）时，可以基于你的内部知识判断，但 confidence 不得超过 0.6，且只能给 supported / contradicted / insufficient / unverifiable。',
        '4. 有证据（深度模式）时禁止用内部知识反驳证据；证据不足必须给 insufficient。',
        '5. 对小说、设定、观点、比喻等内容给 unverifiable，不要强行核查。',
        '6. 只输出合法 JSON，禁止 markdown 代码块标记，禁止解释文字。',
        '7. JSON 结构固定为：{"verdicts":[{"claimId":"c1","verdict":"supported","confidence":0.8,"rationale":"结论与理由","evidenceIds":["e1"],"evidenceQuote":"证据原文逐字摘录","correction":"如需修正原文，给出修正后的表述；否则空字符串"}]}',
      ].join(NL)

      const TYPE_ALIASES = {
        fact: 'fact', 事实: 'fact',
        inference: 'inference', 推论: 'inference',
        concept: 'concept', 概念: 'concept',
        definition: 'definition', 定义: 'definition',
        example: 'example', 例子: 'example',
        counter_example: 'counter_example', counterexample: 'counter_example', 'counter-example': 'counter_example', 反例: 'counter_example',
        rule: 'rule', 规则: 'rule',
      }
      const REL_ALIASES = {
        supports: 'supports', support: 'supports', 支持: 'supports',
        example: 'example', example_of: 'example', 例子: 'example',
        counter_example: 'counter_example', counterexample: 'counter_example', 反例: 'counter_example',
        defines: 'defines', define: 'defines', 定义: 'defines',
        infers: 'infers', infer: 'infers', implies: 'infers', 推断: 'infers',
        causes: 'causes', cause: 'causes', 因果: 'causes', 导致: 'causes',
      }

      // ---- structure-aware paragraph segmentation ----
      // Each blank-line block is classified first (heading / list / dialogue /
      // table / code / quote / prose), then numbered units are built with the
      // rules of that structure instead of a fixed character budget. The
      // client MUST mirror this exact algorithm (splitParagraphs).
      const SEG_MAX_HOST = 300
      const SEG_SOFT_MAX_HOST = 120
      const SEG_SENTENCE_MAX_HOST = 180
      const SEG_MIN_TOPIC_HOST = 24
      const SEG_TOPIC_SIM_HOST = 0.08
      const SENT_END_HOST = new Set(['。', '！', '？', '!', '?', '；', ';'])
      const SENT_CLOSER_HOST = new Set(['”', '’', '"', "'", '」', '』', '）', ')', '】', '》', '〉'])
      const SEG_SOFT_HOST = new Set(['，', '、', '：', ':', ',', '—', '…', ' ', '\t'])
      const SEG_TRANSITIONS_HOST = [
        '综上所述', '总而言之', '换句话说', '也就是说', '由此可见', '由此可知', '除此之外',
        '值得注意的是', '需要说明', '需要指出', '问题在于', '关键在于', '事实上', '实际上',
        '另一方面', '与此同时', '举例来说', '例如', '比如', '譬如', '特别是', '尤其是',
        '首先是', '其次', '再次', '最后', '总之', '综上', '因此', '所以', '于是', '因而',
        '故而', '然而', '但是', '不过', '可是', '只是', '相反', '反之', '此外', '另外',
        '而且', '并且', '况且', '再说', '进一步', '然后', '接下来', '接着', '随后',
        '首先', '最后一点',
      ].sort((a, b) => b.length - a.length)

      function hasSentEndHost(s) {
        for (let i = 0; i < s.length; i++) if (SENT_END_HOST.has(s[i])) return true
        return false
      }
      function startsWithAnyHost(s, prefixes) {
        const t = s.trimStart()
        for (const p of prefixes) if (t.startsWith(p)) return true
        return false
      }
      function lineIndentHost(line) {
        let i = 0
        while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
        return i
      }
      function listMarkerHost(line) {
        const t = line.trim()
        if (!t) return false
        return /^[-*•·▪◦●○]\s+/.test(t)
          || /^[（(]?\d{1,3}[）).、]\s*/.test(t)
          || /^[一二三四五六七八九十]+[、.．]\s*/.test(t)
          || /^第[一二三四五六七八九十百0-9]+[条章节款]\s*/.test(t)
          || /^[a-zA-Z][.、]\s+/.test(t)
      }
      function dialogLineHost(line) {
        const t = line.trim()
        if (!t) return false
        if (/^[“"「『]/.test(t)) return true
        return /^[^：:]{0,12}(说|道|问|答|喊|讲)[：:]/.test(t)
      }
      function headingLineHost(line) {
        const t = line.trim()
        if (!t || t.length > 60 || hasSentEndHost(t) || listMarkerHost(t) || dialogLineHost(t)) return false
        return /^(第[一二三四五六七八九十百0-9]+[章节条款部分]|[一二三四五六七八九十]+[、.．]|\d+(\.\d+)*[、.．]?)\s*/.test(t)
          || !/[，。：；,;:?!？!]/.test(t)
      }
      // Hard sentence boundaries + trailing closing quotes/brackets.
      function atomicRangesHost(line) {
        const ranges = []
        let start = 0
        let i = 0
        while (i < line.length) {
          if (SENT_END_HOST.has(line[i])) {
            let end = i + 1
            while (end < line.length && SENT_CLOSER_HOST.has(line[end])) end++
            ranges.push({ start, end })
            start = end
            i = end
          } else {
            i += 1
          }
        }
        if (start < line.length) ranges.push({ start, end: line.length })
        return ranges
      }
      // Split one atomic sentence that still exceeds SEG_SENTENCE_MAX_HOST;
      // prefer soft punctuation, hard-cut as a last resort.
      function splitLongSentenceHost(text, absStart, out) {
        let pos = 0
        const floor = Math.floor(SEG_SENTENCE_MAX_HOST * 0.55)
        while (text.length - pos > SEG_SENTENCE_MAX_HOST) {
          const limit = pos + SEG_SENTENCE_MAX_HOST
          let cut = -1
          for (let i = limit; i > pos + floor; i--) {
            if (SEG_SOFT_HOST.has(text[i - 1])) { cut = i; break }
          }
          if (cut < 0) cut = limit
          const piece = text.slice(pos, cut)
          if (piece.trim()) out.push({ text: piece, start: absStart + pos, end: absStart + cut })
          pos = cut
        }
        const rest = text.slice(pos)
        if (rest.trim()) out.push({ text: rest, start: absStart + pos, end: absStart + text.length })
      }
      function pushPieceHost(text, start, end, out) {
        const piece = text.slice(start, end)
        if (piece.trim()) out.push({ text: piece, start, end })
      }
      // Lexical topic signal for ordinary prose: CJK bigrams + latin words.
      function segTokenizeHost(s) {
        const out = []
        let word = ''
        const flush = () => { if (word.length >= 2) { out.push(word); word = '' } }
        for (let i = 0; i < s.length; i++) {
          const c = s[i]
          if (/[A-Za-z0-9]/.test(c)) word += c.toLowerCase()
          else {
            flush()
            if (/[\u4e00-\u9fff]/.test(c)) {
              const next = i + 1 < s.length && /[\u4e00-\u9fff]/.test(s[i + 1])
              const prev = i > 0 && /[\u4e00-\u9fff]/.test(s[i - 1])
              if (next) out.push(c + s[i + 1])
              else if (!prev) out.push(c)
            }
          }
        }
        flush()
        return out
      }
      function topicSimilarityHost(a, b) {
        const sa = new Set(segTokenizeHost(a))
        const sb = new Set(segTokenizeHost(b))
        if (sa.size === 0 || sb.size === 0) return 0
        let hit = 0
        for (const t of sa) if (sb.has(t)) hit += 1
        return hit / Math.min(sa.size, sb.size)
      }
      function classifyBlockHost(texts) {
        const n = texts.length
        if (n === 0) return 'prose'
        if (n === 1 && headingLineHost(texts[0])) return 'heading'
        let dialog = 0
        let list = 0
        let code = 0
        let table = 0
        let quote = 0
        for (const t of texts) {
          if (dialogLineHost(t)) dialog += 1
          if (listMarkerHost(t)) list += 1
          if (lineIndentHost(t) >= 2) code += 1
          if (t.indexOf('|') >= 0) table += 1
          if (t.trimStart().startsWith('>')) quote += 1
        }
        if (dialog / n >= 0.5) return 'dialogue'
        if (quote / n >= 0.6) return 'quote'
        if (table / n >= 0.6) return 'table'
        if (code / n >= 0.6) return 'code'
        if (list / n >= 0.6) return 'list'
        return 'prose'
      }
      // One structural line = one unit; over-long lines split at sentence
      // boundaries first (then soft punctuation / hard cap as fallback).
      function appendLineCappedHost(line, absStart, out) {
        const push = (s, e) => {
          const piece = line.slice(s, e)
          if (piece.trim()) out.push({ text: piece, start: absStart + s, end: absStart + e })
        }
        if (line.length <= SEG_SOFT_MAX_HOST) {
          push(0, line.length)
          return
        }
        const ranges = atomicRangesHost(line)
        let s = null
        let e = null
        const flush = () => {
          if (s != null) { push(s, e); s = null; e = null }
        }
        for (const r of ranges) {
          if (r.end - r.start > SEG_SENTENCE_MAX_HOST) {
            flush()
            splitLongSentenceHost(line.slice(r.start, r.end), absStart + r.start, out)
            continue
          }
          if (s == null) { s = r.start; e = r.end }
          else if (r.end - s <= SEG_SOFT_MAX_HOST) { e = r.end }
          else { flush(); s = r.start; e = r.end }
        }
        flush()
      }
      // Code lines never get sentence-split; only hard-cap them.
      function appendRawLineHost(line, absStart, out) {
        if (line.length <= SEG_MAX_HOST) {
          if (line.trim()) out.push({ text: line, start: absStart, end: absStart + line.length })
        } else {
          splitLongSentenceHost(line, absStart, out)
        }
      }
      // A quote block stays together while it fits the soft cap, then it
      // splits between whole lines.
      function appendQuoteBlockHost(lines, text, out) {
        if (lines.length === 0) return
        let s = lines[0].start
        let e = lines[0].end
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i]
          if (l.end - s <= SEG_SOFT_MAX_HOST) { e = l.end; continue }
          pushPieceHost(text, s, e, out)
          s = l.start
          e = l.end
        }
        pushPieceHost(text, s, e, out)
      }
      // Ordinary prose: group sentences by topic transitions (discourse
      // markers / lexical topic drift), close a unit at a soft length limit,
      // and use the hard cap only as a last resort.
      function groupProsePartsHost(parts, text, out) {
        let s = null
        let e = null
        for (const p of parts) {
          if (s == null) { s = p.start; e = p.end; continue }
          const mergedLen = (e - s) + (p.start - e) + (p.end - p.start)
          let boundary = false
          if (mergedLen > SEG_MAX_HOST) {
            boundary = true
          } else if (mergedLen > SEG_SOFT_MAX_HOST && e - s >= SEG_MIN_TOPIC_HOST) {
            boundary = true
          } else if (e - s >= SEG_MIN_TOPIC_HOST) {
            if (startsWithAnyHost(p.text, SEG_TRANSITIONS_HOST)) boundary = true
            else if (topicSimilarityHost(text.slice(s, e), text.slice(p.start, p.end)) < SEG_TOPIC_SIM_HOST) boundary = true
          }
          if (boundary) {
            pushPieceHost(text, s, e, out)
            s = p.start
            e = p.end
          } else {
            e = p.end
          }
        }
        if (s != null) pushPieceHost(text, s, e, out)
      }

      function splitParagraphsHost(text) {
        return splitParagraphsOffsetsHost(text).map((p) => p.text)
      }

      function splitParagraphsOffsetsHost(text) {
        const lines = text.split(NL)
        const blocks = []
        let cur = []
        let lineStart = 0
        for (const line of lines) {
          if (line.trim() === '') {
            if (cur.length > 0) { blocks.push(cur); cur = [] }
            lineStart += line.length + 1
            continue
          }
          cur.push({ text: line, start: lineStart, end: lineStart + line.length })
          lineStart += line.length + 1
        }
        if (cur.length > 0) blocks.push(cur)
        const out = []
        for (const block of blocks) {
          const kind = classifyBlockHost(block.map((l) => l.text))
          if (kind === 'quote') {
            appendQuoteBlockHost(block, text, out)
          } else if (kind === 'code') {
            for (const l of block) appendRawLineHost(l.text, l.start, out)
          } else if (kind === 'list' || kind === 'dialogue' || kind === 'table' || kind === 'heading') {
            for (const l of block) appendLineCappedHost(l.text, l.start, out)
          } else {
            const parts = []
            for (const l of block) {
              for (const r of atomicRangesHost(l.text)) {
                splitLongSentenceHost(l.text.slice(r.start, r.end), l.start + r.start, parts)
              }
            }
            groupProsePartsHost(parts, text, out)
          }
        }
        return out
      }

      function stableHashHost(value) {
        let hash = 2166136261
        const s = String(value == null ? '' : value)
        for (let i = 0; i < s.length; i++) {
          hash ^= s.charCodeAt(i)
          hash = Math.imul(hash, 16777619)
        }
        return (hash >>> 0).toString(36)
      }

      // Turn heading-like content units into a lightweight book map. This is
      // deliberately deterministic: the map is navigation/provenance data,
      // not an LLM-generated claim about the source.
      function buildSectionsHost(paras) {
        const sections = []
        let current = null
        const makeSection = (title, start) => ({
          id: 'section-' + String(sections.length + 1).padStart(3, '0') + '-' + stableHashHost(String(title || '全文') + '@' + start),
          title: String(title || '全文').trim().slice(0, 120) || '全文',
          startParagraph: start,
          endParagraph: start,
          summary: '',
        })
        for (let i = 0; i < paras.length; i++) {
          const text = String(paras[i] || '').trim()
          const fileHeading = /^={2,}\s*文件：.+\s*={2,}$/.test(text)
          const structuralHeading = /^(?:#{1,6}\s+|第[一二三四五六七八九十百0-9]+[章节条款部分]|[一二三四五六七八九十]+[、.．]|\d+(?:\.\d+)*[、.．]?\s+)/.test(text)
          const heading = fileHeading || structuralHeading || headingLineHost(text) ? text.slice(0, 120) : ''
          if (!current) {
            current = makeSection(heading || '全文', 0)
          } else if (heading && i > current.startParagraph) {
            current.endParagraph = i - 1
            sections.push(current)
            current = makeSection(heading, i)
          }
          current.endParagraph = i
        }
        if (current) sections.push(current)
        if (sections.length === 0) sections.push(makeSection('全文', 0))
        return sections
      }

      function buildBatchesByParagraph(paras, max, context) {
        const batches = []
        const paragraphMeta = context && Array.isArray(context.paragraphMeta) ? context.paragraphMeta : []
        let cur = []
        let curLen = 0
        const flush = () => {
          if (cur.length === 0) return
          const sectionIds = []
          const sectionTitles = []
          for (const unit of cur) {
            const meta = paragraphMeta[unit.num]
            if (!meta) continue
            if (meta.sectionId && !sectionIds.includes(meta.sectionId)) sectionIds.push(meta.sectionId)
            if (meta.sectionTitle && !sectionTitles.includes(meta.sectionTitle)) sectionTitles.push(meta.sectionTitle)
          }
          const index = batches.length + 1
          batches.push({
            chunkId: 'chunk-' + String(index).padStart(4, '0'),
            units: cur,
            startParagraph: cur[0].num,
            endParagraph: cur[cur.length - 1].num,
            sectionIds,
            sectionTitles,
          })
          cur = []
          curLen = 0
        }
        for (let i = 0; i < paras.length; i++) {
          const t = String(paras[i] || '')
          if (curLen > 0 && curLen + t.length + 1 > max) flush()
          cur.push({ num: i, text: t })
          curLen += t.length + 1
        }
        flush()
        return batches
      }

      function buildSourceManifestHost(title, text, paras, documentIdOverride) {
        const sections = buildSectionsHost(paras)
        const paragraphMeta = new Array(paras.length)
        for (const section of sections) {
          for (let i = section.startParagraph; i <= section.endParagraph && i < paragraphMeta.length; i++) {
            paragraphMeta[i] = { sectionId: section.id, sectionTitle: section.title }
          }
        }
        const documentId = typeof documentIdOverride === 'string' && documentIdOverride.trim()
          ? documentIdOverride.trim().slice(0, 160)
          : 'document-' + stableHashHost(String(title || '') + NL + String(text || '').slice(0, 4000))
        const sourceId = 'source-' + stableHashHost(String(title || '') + NL + String(text || ''))
        const batches = buildBatchesByParagraph(paras, 6000, { sourceId, paragraphMeta })
        return {
          documentId,
          sourceId,
          title: String(title || '').trim().slice(0, 200),
          chars: String(text || '').length,
          paragraphCount: paras.length,
          chunkCount: batches.length,
          sectionCount: sections.length,
          sections,
          paragraphMeta,
          batches,
        }
      }

      function buildUserPrompt(title, batch, index, total) {
        const units = Array.isArray(batch) ? batch : (batch && Array.isArray(batch.units) ? batch.units : [])
        let s = ''
        if (title) s += '资料标题：' + title + NL
        if (total > 1) s += '（这是资料的 ' + (index + 1) + '/' + total + ' 部分，请只基于本部分内容拆解，不要臆测其他部分）' + NL
        if (batch && !Array.isArray(batch)) {
          if (batch.chunkId) s += '当前稳定块 ID：' + batch.chunkId + NL
          if (batch.sectionTitles && batch.sectionTitles.length > 0) s += '当前章节上下文：' + batch.sectionTitles.join(' / ') + NL
        }
        s += '资料正文（已按内容切分并编号，[P数字] 为该内容单元编号）：' + NL
        for (const u of units) s += '[P' + u.num + '] ' + u.text + NL
        return s
      }

      function buildSummaryUserText(existingSummary, batchSummaries) {
        let s = '既有总结：' + (existingSummary || '（无）') + NL
        s += '各批总结：' + NL
        for (let i = 0; i < batchSummaries.length; i++) s += (i + 1) + '. ' + batchSummaries[i] + NL
        return s
      }

      // ---- anchor resolution (must match the client's algorithm exactly) ----
      // The client resolves quote -> offset for display; the host uses the
      // same matching for verification so "无法核验" means the same thing on
      // both sides.
      const IDEO_SPACE_HOST = String.fromCharCode(12288)
      const isWSHost = (ch) => ch === ' ' || ch === NL || ch === IDEO_SPACE_HOST || ch.charCodeAt(0) === 9
      const PUNCT_CHARS_HOST = (function () {
        const set = new Set()
        const add = (s) => { for (const ch of s) set.add(ch) }
        add('，。！？、；：…—（）,.!?;:()·～')
        add(String.fromCharCode(8220) + String.fromCharCode(8221) + String.fromCharCode(8216) + String.fromCharCode(8217))
        add(String.fromCharCode(12300) + String.fromCharCode(12301) + String.fromCharCode(12302) + String.fromCharCode(12303))
        return set
      })()
      function normalizeForHost(s, mode) {
        const out = []
        const map = []
        let pendingWS = false
        for (let i = 0; i < s.length; i++) {
          const ch = s[i]
          const ws = isWSHost(ch)
          const punct = PUNCT_CHARS_HOST.has(ch)
          if (mode === 'ws' && ws) {
            if (out.length > 0 && !pendingWS) { out.push(' '); map.push(i); pendingWS = true }
          } else if (mode === 'punct' && punct) {
            pendingWS = false
          } else if (mode === 'both' && (ws || punct)) {
            if (out.length > 0 && !pendingWS) { out.push(' '); map.push(i); pendingWS = true }
          } else {
            out.push(ch); map.push(i); pendingWS = false
          }
        }
        return { text: out.join(''), map }
      }
      function fuzzyMatchHost(needle, source, maxSkips) {
        if (!needle || needle.length < 3 || !source) return null
        const anchor = needle[0]
        let pos = -1
        let best = null
        let scanned = 0
        while (scanned < 80) {
          pos = source.indexOf(anchor, pos + 1)
          if (pos < 0) break
          scanned += 1
          let qi = 0
          let si = pos
          let skips = 0
          let gap = 0
          while (qi < needle.length && si < source.length) {
            if (source[si] === needle[qi]) { qi += 1; si += 1; gap = 0 }
            else if (skips < maxSkips && gap < 6) { skips += 1; si += 1; gap += 1 }
            else break
          }
          if (!best || qi > best.matched) best = { pos, matched: qi }
          if (best && best.matched >= needle.length - 1) break
        }
        if (!best) return null
        const required = needle.length <= 4 ? needle.length : needle.length - 2
        return best.matched >= required ? best.pos : null
      }
      function resolveNeedleHost(needle, source) {
        if (!needle) return null
        const q = String(needle).trim()
        if (!q) return null
        const idx = source.indexOf(q)
        if (idx >= 0) return idx
        const modes = ['ws', 'punct', 'both']
        for (const mode of modes) {
          const qn = normalizeForHost(q, mode)
          if (qn.text.length < 2) continue
          const sn = normalizeForHost(source, mode)
          const hit = sn.text.indexOf(qn.text)
          if (hit >= 0) return sn.map[hit]
        }
        const minLen = 3
        const maxLen = Math.min(q.length, 24)
        for (let len = maxLen; len >= minLen; len--) {
          const idx2 = source.indexOf(q.slice(0, len))
          if (idx2 >= 0) return idx2
        }
        for (let len = maxLen; len >= minLen; len--) {
          const idx2 = source.indexOf(q.slice(q.length - len))
          if (idx2 >= 0) return idx2
        }
        const rawHit = fuzzyMatchHost(q, source, 3)
        if (rawHit != null) return rawHit
        const pn = normalizeForHost(q, 'punct')
        if (pn.text.length >= 3) {
          const sn2 = normalizeForHost(source, 'punct')
          const pnHit = fuzzyMatchHost(pn.text, sn2.text, 2)
          if (pnHit != null) return sn2.map[pnHit]
        }
        return null
      }
      function resolveAnchorHost(quote, source, fallbackText) {
        let off = resolveNeedleHost(quote, source)
        if (off == null && fallbackText && fallbackText !== quote) off = resolveNeedleHost(fallbackText, source)
        return off
      }
      function tokenizeHost(s) {
        const out = []
        let cur = ''
        for (const ch of String(s || '')) {
          if (isWSHost(ch)) { if (cur) { out.push(cur); cur = '' } } else cur += ch
        }
        if (cur) out.push(cur)
        return out
      }
      function paragraphIndexOfOffset(paras, off) {
        if (off == null) return null
        for (let i = 0; i < paras.length; i++) {
          if (off >= paras[i].start && off < paras[i].end) return i
        }
        return null
      }
      function jaccardHost(a, b) {
        if (!a || !b || a.size === 0 || b.size === 0) return 0
        let inter = 0
        for (const x of a) if (b.has(x)) inter += 1
        return inter / (a.size + b.size - inter)
      }
      // Chinese text has no whitespace word boundaries, so duplicate /
      // contradiction detection adds character bigrams for long tokens.
      function phraseTokensHost(s) {
        const out = new Set()
        for (const t of tokenizeHost(s)) {
          out.add(t)
          if (t.length >= 3) {
            for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2))
          }
        }
        return out
      }

      // ---- deterministic verification (quick pass, no LLM) ----
      const ISSUE_SEVERITIES = new Set(['error', 'warning', 'suggestion'])
      const ISSUE_CATEGORIES = new Set(['grounding', 'type', 'relation', 'duplicate', 'contradiction', 'completeness', 'summary', 'other'])
      const VERIFY_FIX_ACTIONS = new Set(['none', 'update_node', 'delete_node', 'add_node', 'update_edge', 'delete_edge', 'add_edge', 'merge_nodes', 'update_summary'])
      // Hard source-type rules; other checks stay soft (warning-level).
      const REL_SOURCE_RULES = {
        example: 'example',
        counter_example: 'counter_example',
        defines: 'definition',
      }
      const NEGATION_MARKERS = ['不', '无', '未', '非', '禁止', '不能', '无法', '没有', '不可', '不会', '反对']

      function buildLocalReport(graph, sourceText) {
        const reportId = 'vq-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36)
        const issues = []
        let seq = 0
        const addIssue = (severity, category, targetKind, targetId, title, detail, evidence, proposedFix, confidence) => {
          seq += 1
          issues.push({
            id: 'loc' + seq,
            source: 'local',
            severity,
            category,
            targetKind,
            targetId,
            title,
            detail,
            evidence: Array.isArray(evidence) ? evidence : [],
            confidence: typeof confidence === 'number' ? confidence : 1,
            proposedFix: proposedFix || { action: 'none' },
            status: 'open',
          })
        }
        const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []
        const edges = graph && Array.isArray(graph.edges) ? graph.edges : []
        const nodeById = new Map()
        for (const n of nodes) {
          if (n && typeof n.id === 'string') nodeById.set(n.id, n)
        }
        const edgeKey = (e) => (e && typeof e.fromNodeId === 'string' && typeof e.toNodeId === 'string') ? e.fromNodeId + '>' + e.toNodeId : ''

        // L0 — structure.
        const seenEdges = new Set()
        edges.forEach((e, i) => {
          if (!e || typeof e !== 'object') return
          const key = edgeKey(e)
          if (!key) {
            addIssue('error', 'relation', 'edge', String(i), '关系边缺少端点', '这条边缺少 fromNodeId 或 toNodeId。', [], { action: 'delete_edge', edgePatch: { index: i } })
            return
          }
          if (e.fromNodeId === e.toNodeId) {
            addIssue('error', 'relation', 'edge', key, '关系边存在自环', '同一节点不能与自身建立关系。', [], { action: 'delete_edge', edgePatch: { fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, relation: e.relation } })
            return
          }
          if (!nodeById.has(e.fromNodeId) || !nodeById.has(e.toNodeId)) {
            addIssue('error', 'relation', 'edge', key, '关系边引用了不存在的节点', '该边的一端在图节点列表中不存在。', [], { action: 'delete_edge', edgePatch: { fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, relation: e.relation } })
            return
          }
          const dedupeKey = key + ':' + e.relation
          if (seenEdges.has(dedupeKey)) {
            addIssue('warning', 'relation', 'edge', key, '重复的关系边', '相同端点与关系类型存在多条边。', [], { action: 'delete_edge', edgePatch: { fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, relation: e.relation } })
          }
          seenEdges.add(dedupeKey)
          const fromType = nodeById.get(e.fromNodeId).type
          const toType = nodeById.get(e.toNodeId).type
          const requiredSource = REL_SOURCE_RULES[e.relation]
          if (requiredSource && fromType !== requiredSource) {
            addIssue('error', 'relation', 'edge', key, '关系与源节点类型不匹配',
              '「' + e.relation + '」关系的源节点应为 ' + requiredSource + '，当前是 ' + fromType + '。',
              [], { action: 'none' })
          }
          if (e.relation === 'infers' && toType !== 'inference' && toType !== 'rule') {
            addIssue('warning', 'relation', 'edge', key, '「推断」关系的目标不是推论/规则',
              'infers 边指向了 ' + toType + ' 节点，请确认它确实是可复用结论。', [], { action: 'none' })
          }
          if (e.relation === 'causes' && (fromType === 'definition' || fromType === 'concept' || toType === 'definition' || toType === 'concept')) {
            addIssue('warning', 'relation', 'edge', key, '「因果」关系连接了定义/概念节点',
              'causes 一般描述事实或规则之间的因果，连接 definition/concept 请人工复核。', [], { action: 'none' })
          }
        })
        for (const n of nodes) {
          if (!n || typeof n !== 'object') continue
          if (!n.id || !n.text) {
            addIssue('error', 'type', 'node', n.id || null, '节点缺少 id 或 text', '该节点无法被图渲染器使用。', [], n.id ? { action: 'delete_node', nodePatch: { id: n.id } } : { action: 'none' })
          } else if (!TYPE_ALIASES[n.type]) {
            addIssue('error', 'type', 'node', n.id, '节点类型不在允许范围内', 'type=' + n.type + ' 不是 7 类节点之一。', [], { action: 'delete_node', nodePatch: { id: n.id } })
          }
        }
        const degree = new Map()
        for (const e of edges) {
          if (!e || !nodeById.has(e.fromNodeId) || !nodeById.has(e.toNodeId)) continue
          degree.set(e.fromNodeId, (degree.get(e.fromNodeId) || 0) + 1)
          degree.set(e.toNodeId, (degree.get(e.toNodeId) || 0) + 1)
        }
        for (const n of nodes) {
          if (n && n.id && !degree.has(n.id)) {
            addIssue('warning', 'completeness', 'node', n.id, '孤立节点', '该节点没有任何关系边，请确认它是否需要连接进图。', [], { action: 'none' })
          }
        }

        // L1 — quote / paragraph grounding.
        const paras = splitParagraphsOffsetsHost(sourceText || '')
        const coveredParas = new Set()
        let evidenceOk = 0
        for (const n of nodes) {
          if (!n || typeof n !== 'object' || !n.id) continue
          const quote = typeof n.quote === 'string' ? n.quote.trim() : ''
          const pNum = Number.isInteger(n.paragraph) && n.paragraph >= 0 && n.paragraph < paras.length ? n.paragraph : null
          const quoteOffset = quote ? resolveAnchorHost(quote, sourceText || '', n.text) : null
          const quotePara = quoteOffset != null ? paragraphIndexOfOffset(paras, quoteOffset) : null
          if (quote && quoteOffset == null) {
            if (pNum == null) {
              addIssue('error', 'grounding', 'node', n.id, '摘录无法在原文中找到，且段落锚点缺失',
                'quote 与原文无法匹配，paragraph 也缺失/越界，该节点无法回链原文。',
                [], { action: 'none' })
            } else {
              addIssue('warning', 'grounding', 'node', n.id, '摘录无法在原文中找到',
                'quote 不是原文逐字摘录（段落编号仍可用于回链），请改为原文原句。',
                [{ paragraph: pNum, quote: '' }], { action: 'none' })
            }
          } else if (quote && quoteOffset != null) {
            if (pNum != null && quotePara != null && pNum !== quotePara) {
              addIssue('error', 'grounding', 'node', n.id, '摘录位置与段落编号不一致',
                'quote 实际位于第 ' + (quotePara + 1) + ' 段，但节点声明为第 ' + (pNum + 1) + ' 段。',
                [{ paragraph: quotePara, quote }],
                { action: 'update_node', nodePatch: { id: n.id, patch: { paragraph: quotePara } } })
            }
            if (pNum == null && quotePara != null) {
              addIssue('warning', 'grounding', 'node', n.id, '段落编号缺失，已按摘录定位',
                '节点没有 paragraph，但 quote 可定位到第 ' + (quotePara + 1) + ' 段。',
                [{ paragraph: quotePara, quote }],
                { action: 'update_node', nodePatch: { id: n.id, patch: { paragraph: quotePara } } })
            }
          } else if (!quote && pNum == null) {
            addIssue('warning', 'grounding', 'node', n.id, '既无摘录也无段落编号', '该节点没有任何证据锚点，无法回链原文。', [], { action: 'none' })
          } else if (!quote && pNum != null) {
            addIssue('suggestion', 'grounding', 'node', n.id, '缺少原文摘录', '建议补充 quote，便于人工核验该节点内容。', [{ paragraph: pNum, quote: '' }], { action: 'none' })
          }
          if (quoteOffset != null || pNum != null) evidenceOk += 1
          if (pNum != null) coveredParas.add(pNum)
          if (quotePara != null) coveredParas.add(quotePara)
        }
        const uncovered = []
        for (let i = 0; i < paras.length; i++) if (!coveredParas.has(i)) uncovered.push(i + 1)
        if (uncovered.length > 0 && uncovered.length <= 6) {
          addIssue('suggestion', 'completeness', 'graph', null, '部分段落未拆出任何节点',
            '以下段落没有可定位的节点：第 ' + uncovered.join('、') + ' 段。如其中有重要结论/定义/规则，建议追加拆分。',
            [], { action: 'none' })
        }

        // L2 — duplicates / possible contradictions (heuristics, human confirms).
        const textNorm = new Map()
        for (const n of nodes) {
          if (!n || !n.id || !n.text) continue
          const norm = normalizeForHost(n.text, 'both').text
          textNorm.set(n.id, { norm, tokens: phraseTokensHost(norm) })
        }
        const nodeArr = nodes.filter((n) => n && n.id && textNorm.has(n.id))
        for (let i = 0; i < nodeArr.length; i++) {
          for (let j = i + 1; j < nodeArr.length; j++) {
            const a = nodeArr[i]
            const b = nodeArr[j]
            const ta = textNorm.get(a.id)
            const tb = textNorm.get(b.id)
            const sim = jaccardHost(ta.tokens, tb.tokens)
            if (sim >= 0.75) {
              addIssue('warning', 'duplicate', 'node', a.id, '疑似重复节点：' + a.id + ' / ' + b.id,
                '两个节点表述高度相似（相似度 ' + Math.round(sim * 100) + '%），建议合并。',
                [], { action: 'merge_nodes', nodePatch: { id: a.id }, mergeIntoId: b.id })
            } else if (sim >= 0.3 && (a.type === 'fact' || a.type === 'inference' || a.type === 'rule') && (b.type === 'fact' || b.type === 'inference' || b.type === 'rule')) {
              const hasNeg = (x) => NEGATION_MARKERS.some((m) => x.norm.includes(m))
              if (hasNeg(ta) !== hasNeg(tb)) {
                addIssue('warning', 'contradiction', 'node', a.id, '疑似互相矛盾：' + a.id + ' / ' + b.id,
                  '两个节点主题相近但一正一反，可能自相矛盾，请人工复核或点击该问题提交 AI 深度复核。',
                  [], { action: 'none' })
              }
            }
          }
        }
        if (typeof graph.summary !== 'string' || !graph.summary.trim()) {
          addIssue('warning', 'summary', 'graph', null, '缺少一句话总结', 'summary 为空，建议补充全文摘要。', [], { action: 'none' })
        }

        const order = { error: 0, warning: 1, suggestion: 2 }
        issues.sort((x, y) => (order[x.severity] - order[y.severity]) || (y.confidence - x.confidence))
        const counts = { error: 0, warning: 0, suggestion: 0 }
        for (const it of issues) counts[it.severity] += 1
        return {
          reportId,
          mode: 'quick',
          createdAt: Date.now(),
          model: null,
          scope: { kind: 'full', ids: [] },
          summary: '快速体检完成：' + counts.error + ' 个错误、' + counts.warning + ' 个警告、' + counts.suggestion + ' 条建议。',
          metrics: {
            checkedNodes: nodes.length,
            checkedEdges: edges.length,
            errorCount: counts.error,
            warningCount: counts.warning,
            suggestionCount: counts.suggestion,
            evidenceCoverage: nodes.length > 0 ? Math.round((evidenceOk / nodes.length) * 100) : 0,
            paragraphCoverage: paras.length > 0 ? Math.round((coveredParas.size / paras.length) * 100) : 0,
          },
          issues,
        }
      }

      // ---- JSON / schema parsing ----
      function parseJson(raw) {
        let s = String(raw || '').trim()
        const snippet = s.replace(/\s+/g, ' ').slice(0, 180)
        // Strip every markdown fence line, not only a leading fence: models
        // often preface the JSON with a sentence and then ```json ... ```.
        s = s.split('\n').filter((line) => !line.trim().startsWith('```')).join('\n')
        const start = s.indexOf('{')
        const end = s.lastIndexOf('}')
        if (start < 0 || end <= start) throw new Error('没有找到 JSON 对象（模型输出前 180 字：' + (snippet || '空') + '）')
        s = s.slice(start, end + 1)
        try {
          return JSON.parse(s)
        } catch (firstErr) {
          // The model occasionally hits the token limit mid-array. Try a few
          // safe completions of truncated JSON before giving up: strip a
          // trailing comma and close the issue array + root object.
          const candidates = [s]
          const trimmed = s.replace(/,\s*$/, '')
          candidates.push(trimmed + ']}', trimmed + '}', trimmed + ']', trimmed + ']}', s + ']}', s + '}')
          for (const candidate of candidates) {
            try { return JSON.parse(candidate) } catch (e) { /* try next */ }
          }
          throw new Error((firstErr && firstErr.message ? firstErr.message : 'JSON 解析失败') + '（模型输出前 180 字：' + snippet + '）')
        }
      }

      function normalizeGraph(obj, totalParagraphs, extraIds, sourceContext) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: '结果不是 JSON 对象' }
        const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
        if (!Array.isArray(obj.nodes)) return { error: '缺少 nodes 数组' }
        if (!Array.isArray(obj.edges)) return { error: '缺少 edges 数组' }

        const warnings = []
        const nodes = []
        const seen = new Set()

        for (const n of obj.nodes) {
          if (!n || typeof n !== 'object') { warnings.push('node_dropped:not_object'); continue }
          const id = typeof n.id === 'string' ? n.id.trim() : ''
          if (!id) { warnings.push('node_dropped:missing_id'); continue }
          if (seen.has(id)) { warnings.push('node_dropped:duplicate_id:' + id); continue }
          const type = TYPE_ALIASES[typeof n.type === 'string' ? n.type.trim().toLowerCase() : '']
          if (!type) { warnings.push('node_dropped:unknown_type:' + id); continue }
          const text = typeof n.text === 'string' ? n.text.trim() : ''
          if (!text) { warnings.push('node_dropped:empty_text:' + id); continue }
          const quote = typeof n.quote === 'string' ? n.quote.trim() : ''
          if (!quote) warnings.push('node_missing_quote:' + id)

          const rawP = n.paragraph != null ? n.paragraph : (n.para != null ? n.para : n.paragraphIndex)
          let pNum = null
          if (rawP != null) {
            const num = Number(String(rawP).trim())
            if (isFinite(num) && num >= 0 && Math.floor(num) === num) pNum = num
          }
          if (rawP == null) warnings.push('node_missing_paragraph:' + id)
          else if (pNum == null) warnings.push('node_paragraph_invalid:' + id)
          else if (pNum >= totalParagraphs) { warnings.push('node_paragraph_out_of_range:' + id); pNum = null }

          const paragraphMeta = sourceContext && Array.isArray(sourceContext.paragraphMeta) && pNum != null
            ? sourceContext.paragraphMeta[pNum]
            : null
          const evidence = (quote || pNum != null)
            ? [{ paragraph: pNum, quote }]
            : []
          const sourceFields = sourceContext && sourceContext.sourceId
            ? {
              documentId: sourceContext.documentId || null,
              sourceId: sourceContext.sourceId,
              chunkId: sourceContext.chunkId || null,
              sectionId: paragraphMeta && paragraphMeta.sectionId ? paragraphMeta.sectionId : null,
              sectionTitle: paragraphMeta && paragraphMeta.sectionTitle ? paragraphMeta.sectionTitle : null,
            }
            : {}
          seen.add(id)
          nodes.push({ id, type, text, quote, paragraph: pNum, evidence, ...sourceFields })
        }

        const nodeById = new Map(nodes.map((node) => [node.id, node]))
        const edges = []
        for (const e of obj.edges) {
          if (!e || typeof e !== 'object') { warnings.push('edge_dropped:not_object'); continue }
          const from = typeof e.fromNodeId === 'string' ? e.fromNodeId.trim() : ''
          const to = typeof e.toNodeId === 'string' ? e.toNodeId.trim() : ''
          const relation = REL_ALIASES[typeof e.relation === 'string' ? e.relation.trim().toLowerCase() : '']
          if (!relation) { warnings.push('edge_dropped:unknown_relation:' + from + '->' + to); continue }
          if (!seen.has(from) && !(extraIds && extraIds.has(from))) { warnings.push('edge_dropped:missing_endpoint:' + from + '->' + to); continue }
          if (!seen.has(to) && !(extraIds && extraIds.has(to))) { warnings.push('edge_dropped:missing_endpoint:' + from + '->' + to); continue }
          if (from === to) { warnings.push('edge_dropped:self_loop:' + from); continue }
          const edgeEvidence = []
          for (const nodeId of [from, to]) {
            const node = nodeById.get(nodeId)
            for (const evidence of node && Array.isArray(node.evidence) ? node.evidence : []) {
              if (edgeEvidence.length >= 2) break
              edgeEvidence.push(evidence)
            }
          }
          edges.push({
            fromNodeId: from,
            toNodeId: to,
            relation,
            evidence: edgeEvidence,
            ...(sourceContext && sourceContext.sourceId ? {
              documentId: sourceContext.documentId || null,
              sourceId: sourceContext.sourceId,
              chunkId: sourceContext.chunkId || null,
            } : {}),
          })
        }

        return { summary, nodes, edges, warnings }
      }

      function mergeBatch(batch, acc, batchIndex) {
        const prefix = 'batch' + (batchIndex + 1) + ':'
        for (const w of batch.warnings) acc.warnings.push(prefix + w)
        for (const node of batch.nodes) {
          if (!acc.nodes.has(node.id)) {
             acc.nodes.set(node.id, node)
             registerNodeLookupKeyHost(acc, node)
           }
        }
        for (const e of batch.edges) {
          if (!acc.nodes.has(e.fromNodeId) || !acc.nodes.has(e.toNodeId)) {
            acc.warnings.push(prefix + 'edge_dropped:missing_endpoint:' + e.fromNodeId + '->' + e.toNodeId)
            continue
          }
          if (e.fromNodeId === e.toNodeId) {
            acc.warnings.push(prefix + 'edge_dropped:self_loop:' + e.fromNodeId)
            continue
          }
          const key = e.fromNodeId + '>' + e.toNodeId + ':' + e.relation
          if (acc.edgeKeys.has(key)) {
            acc.warnings.push(prefix + 'edge_dropped:duplicate:' + key)
            continue
          }
          acc.edgeKeys.add(key)
          acc.edges.push(e)
        }
      }

      // ---- model routing ----
      // Soft race: wait up to `ms` for the value, otherwise resolve null so the
      // caller can fall through to the next source. This is a fallback, not a
      // "task failed after timeout".
      async function softRace(fn, ms) {
        let timer = null
        const timeoutP = new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), ms)
          if (timer && typeof timer.unref === 'function') timer.unref()
        })
        try {
          return await Promise.race([Promise.resolve().then(fn), timeoutP])
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      async function listModelsSoft(llm, providerId, ms) {
        return softRace(() => llm.listModels(providerId), ms)
      }
      function taskStage(stage, warning) {
        if (!activeTask || activeTask.cancelled) return
        activeTask.progress = activeTask.progress || { stage: '运行中', charsReceived: 0, updatedAt: Date.now() }
        activeTask.progress.stage = stage
        activeTask.progress.updatedAt = Date.now()
        if (warning !== undefined) activeTask.progress.warning = warning
      }
      async function resolveModelInner() {
        taskStage('正在读取当前默认模型…')
        const adm = ctx.get('agentDefaultModel')
        if (adm) {
          try {
            const sel = await softRace(() => adm.currentSelection(), 8000)
            if (sel && typeof sel.provider === 'string' && sel.provider && typeof sel.model === 'string' && sel.model) {
              taskStage('已选择当前默认模型：' + sel.provider + ' · ' + sel.model)
              return { provider: sel.provider, model: sel.model }
            }
            if (sel == null && activeTask && !activeTask.cancelled) taskStage('当前默认模型不可用或读取超时，改查模型目录…', '默认模型未配置或读取超过 8 秒，正在尝试模型目录')
          } catch (e) { /* fall through to llm catalog */ }
        }
        const llm = ctx.get('llm')
        if (!llm) {
          taskStage('模型服务不可用')
          return null
        }
        let providers = []
        taskStage('正在读取模型提供商目录…')
        try {
          const list = llm.listProviders()
          if (Array.isArray(list)) providers = list.filter((p) => p && typeof p.id === 'string' && p.id)
        } catch (e) { /* no providers */ }
        if (providers.length === 0) {
          taskStage('没有找到可用的模型提供商', '模型目录为空，请检查模型设置或手动指定模型')
          return null
        }
        // Query ALL providers concurrently and return the FIRST usable result;
        // the others keep settling in the background but stop touching the
        // task progress. One slow catalog can no longer serialize N × 12s.
        const total = providers.length
        let checked = 0
        let won = false
        const report = (stage, warning) => { if (!won) taskStage(stage, warning) }
        taskStage('正在并行查询 ' + total + ' 个提供商的模型目录…')
        return await new Promise((resolve) => {
          let remaining = providers.length
          const finish = (result) => {
            if (won) return
            if (result) {
              won = true
              taskStage('已选择模型：' + result.provider + ' · ' + result.model)
              resolve({ provider: result.provider, model: result.model })
              return
            }
            remaining -= 1
            if (remaining <= 0) {
              won = true
              taskStage('没有找到可用模型', '模型目录不可用：所有提供商均未能在 12 秒内返回模型列表，可取消任务后重试或手动指定模型')
              resolve(null)
            }
          }
          for (const p of providers) {
            const name = p.name || p.id
            ;(async () => {
              try {
                const models = await listModelsSoft(llm, p.id, 12000)
                checked += 1
                report('已查询模型目录 ' + checked + '/' + total + '：' + name)
                if (models && models.length && models[0].id) {
                  finish({ provider: p.id, model: models[0].id, name })
                  return
                }
                report('已查询模型目录 ' + checked + '/' + total + '：' + name, '模型提供方 ' + name + ' 未能在 12 秒内返回模型列表')
                finish(null)
              } catch (e) {
                checked += 1
                report('已查询模型目录 ' + checked + '/' + total + '：' + name)
                finish(null)
              }
            })()
          }
        })
      }
      // Cancellation is the only way out of an in-flight resolution besides
      // the per-provider soft fallbacks above; the global busy lock is always
      // released by the task runner's finally.
      async function resolveModel() {
        const task = activeTask
        if (!task) return resolveModelInner()
        return new Promise((resolve, reject) => {
          let settled = false
          const cancel = () => {
            if (settled) return
            settled = true
            const err = new Error('任务已取消')
            err.code = 'cancelled'
            reject(err)
          }
          task.cancelHooks = task.cancelHooks || []
          task.cancelHooks.push(cancel)
          resolveModelInner().then((model) => {
            if (settled) return
            settled = true
            resolve(model)
          }, (err) => {
            if (settled) return
            settled = true
            reject(err)
          })
        })
      }

      // No fixed wall-clock timeout: model work runs until it finishes or the
      // user cancels. Progress reports connection state, the AbortSignal is
      // forwarded to the provider, and stalled streams surface visible
      // warnings instead of silently pretending everything is fine.
      async function callModel(model, system, userText, _timeoutMs, temperature, maxTokens) {
        const llm = ctx.get('llm')
        if (!llm) {
          const err = new Error('模型服务不可用')
          err.code = 'llm_unavailable'
          throw err
        }
        const task = activeTask
        const outByIndex = new Map()
        const reasonByIndex = new Map()
        let cancelled = false
        let receivedAny = false
        let chunkTypes = ''
        let finishReason = null
        const collecting = (async () => {
          const controller = new AbortController()
          let iter = null
          const abort = () => {
            cancelled = true
            try { controller.abort() } catch (e) { /* already aborted */ }
            try { if (iter && typeof iter.return === 'function') iter.return() } catch (e) { /* already closed */ }
          }
          const warnTimers = []
          const clearWarnTimers = () => {
            for (const t of warnTimers) clearTimeout(t)
            warnTimers.length = 0
          }
          const warnAt = (ms, text) => {
            warnTimers.push(setTimeout(() => {
              if (task && activeTask === task && !task.cancelled && !receivedAny) {
                task.progress = task.progress || { stage: '运行中', charsReceived: 0, updatedAt: Date.now() }
                task.progress.warning = text
                task.progress.updatedAt = Date.now()
              }
            }, ms))
          }
          if (task) {
            task.abortStream = abort
            task.cancelHooks = task.cancelHooks || []
            task.cancelHooks.push(() => { if (task.abortStream) task.abortStream() })
            task.progress = task.progress || { stage: '运行中', charsReceived: 0, updatedAt: Date.now() }
            task.progress.stage = '正在发起模型请求（' + model.provider + ' · ' + model.model + '）…'
            task.progress.updatedAt = Date.now()
            warnAt(60000, '模型 60 秒未返回首字，连接可能较慢，仍在等待（可取消任务）')
            warnAt(180000, '模型 180 秒未返回首字，可能卡住，建议取消并更换模型后重试')
            warnAt(300000, '模型 5 分钟未返回首字，继续等待或取消任务')
          }
          try {
            const systemText = system
            iter = await Promise.resolve(llm.stream({
              provider: model.provider,
              model: model.model,
              system: systemText,
              messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }],
              temperature: typeof temperature === 'number' ? temperature : 0.2,
              maxTokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8000,
              signal: controller.signal,
            }))
            if (task) {
              task.abortStream = abort
              task.progress = task.progress || { stage: '运行中', charsReceived: 0, updatedAt: Date.now() }
              task.progress.stage = '模型请求已发出，等待首个字符…'
              task.progress.updatedAt = Date.now()
            }
            for await (const chunk of iter) {
              if (cancelled || (task && task.cancelled)) {
                cancelled = true
                break
              }
              if (!chunk || typeof chunk !== 'object') continue
              if (chunkTypes.length < 80 && chunk.type) chunkTypes += (chunkTypes ? ',' : '') + chunk.type
              if (chunk.type === 'finish') {
                finishReason = chunk.reason || null
                continue
              }
              if (chunk.type === 'text-delta') {
                receivedAny = true
                outByIndex.set(chunk.index, (outByIndex.get(chunk.index) || '') + chunk.text)
              } else if (chunk.type === 'reasoning-delta') {
                receivedAny = true
                reasonByIndex.set(chunk.index, (reasonByIndex.get(chunk.index) || '') + chunk.text)
              } else if (chunk.type === 'block-end' && chunk.block) {
                // Some providers deliver the assembled block only (no deltas).
                // Avoid double counting when deltas were already streamed.
                if (chunk.block.type === 'text' && typeof chunk.block.text === 'string' && !outByIndex.has(chunk.index)) {
                  receivedAny = true
                  outByIndex.set(chunk.index, chunk.block.text)
                } else if (chunk.block.type === 'reasoning' && typeof chunk.block.text === 'string' && !reasonByIndex.has(chunk.index)) {
                  receivedAny = true
                  reasonByIndex.set(chunk.index, chunk.block.text)
                }
              }
              if (receivedAny && task) {
                task.progress = task.progress || { stage: '模型生成中', charsReceived: 0, updatedAt: Date.now() }
                task.progress.stage = chunk.type === 'reasoning-delta' || (chunk.block && chunk.block.type === 'reasoning') ? '模型思考中…' : '模型生成中…'
                const outLen = Array.from(outByIndex.values()).reduce((n, s) => n + s.length, 0)
                const reasonLen = Array.from(reasonByIndex.values()).reduce((n, s) => n + s.length, 0)
                task.progress.charsReceived = outLen + reasonLen
                task.progress.warning = null
                task.progress.updatedAt = Date.now()
              }
            }
          } finally {
            clearWarnTimers()
            if (iter && typeof iter.return === 'function') {
              try { iter.return() } catch (e) { /* already closed */ }
            }
            if (task) task.abortStream = null
          }
          if (cancelled || (task && task.cancelled)) {
            const err = new Error('任务已取消')
            err.code = 'cancelled'
            throw err
          }
          const out = Array.from(outByIndex.values()).join('')
          const reasoning = Array.from(reasonByIndex.values()).join('')
          if (!out.trim()) {
            if (reasoning.trim()) throw new Error('模型只输出了思考过程（' + reasoning.length + ' 字），没有给出 JSON；请更换模型后重试')
            if (finishReason && finishReason.kind === 'error' && finishReason.failure) {
              const f = finishReason.failure
              throw new Error((f.message || '模型流以错误结束') + (f.code ? '（code=' + f.code + '）' : '') + '；请更换模型后重试')
            }
            if (finishReason && finishReason.kind === 'aborted') throw new Error('模型流被中断（aborted）；请取消后重试或更换模型')
            if (finishReason && finishReason.kind === 'max-tokens') throw new Error('模型在输出正文前就达到了 token 上限；请缩短资料后重试')
            if (finishReason && finishReason.kind === 'tool-calls') throw new Error('模型只发起了工具调用，没有返回正文；请更换模型后重试')
            const detail = chunkTypes ? '（收到流事件类型：' + chunkTypes + (finishReason ? '，结束原因：' + finishReason.kind : '') + '）' : '（未收到任何流事件）'
            throw new Error('模型没有返回任何内容' + detail + '；请更换模型后重试')
          }
          return out
        })()
        return collecting
      }

      // ---- trajectory serialization: Session.events -> numbered trace text ----
      function traceTextOf(content) {
        if (!Array.isArray(content)) return ''
        const parts = []
        const walk = (blocks) => {
          for (const b of blocks) {
            if (!b || typeof b !== 'object') continue
            if (typeof b.text === 'string') parts.push(b.text)
            if (Array.isArray(b.content)) walk(b.content)
          }
        }
        walk(content)
        return parts.join(' ')
      }
      function traceClip(s, max) {
        const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
        return t.length > max ? t.slice(0, max) + '…' : t
      }

      // ---- document attachment import ----
      // Reads the `==== DSH_PASTE_INPUT_V1 ====` marker emitted by
      // @dsh-community/dsh-paste-input for sent messages or for a composer
      // reference serialized just before the user clicks the graph button,
      // then turns the referenced files into source text for the knowledge graph.
      let docNodeMods = null
      async function docNodeModules() {
        if (!docNodeMods) {
          const [fs, zlib, path] = await Promise.all([
            import('node:fs/promises'),
            import('node:zlib'),
            import('node:path'),
          ])
          docNodeMods = { fs, zlib, path }
        }
        return docNodeMods
      }
      const DOC_TEXT_EXTS_HOST = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'log', 'html', 'htm', 'xml', 'yaml', 'yml', 'ini', 'conf', 'srt', 'tex', 'rst', 'org', 'tsv', 'py', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'java', 'c', 'cpp', 'h', 'hpp', 'rs', 'go', 'sh', 'bat', 'ps1', 'sql', 'toml', 'properties'])
      function looksUtf8TextHost(buf, name) {
        const ext = (name.split('.').pop() || '').toLowerCase()
        if (DOC_TEXT_EXTS_HOST.has(ext)) return true
        const probe = buf.subarray(0, Math.min(buf.length, 2048))
        if (probe.indexOf(0) >= 0) return false
        let controls = 0
        for (let i = 0; i < probe.length; i++) {
          const c = probe[i]
          if (c < 0x09 || (c > 0x0d && c < 0x20) || c === 0x7f) controls += 1
        }
        return controls <= Math.max(1, Math.floor(probe.length * 0.02))
      }
      function decodeXmlEntitiesHost(s) {
        return String(s || '')
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { const n = parseInt(h, 16); return isFinite(n) ? String.fromCharCode(n) : '' })
          .replace(/&#(\d+);/g, (_, d) => { const n = parseInt(d, 10); return isFinite(n) ? String.fromCharCode(n) : '' })
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      }
      function inflatePdfHost(data, zlib, maxOutputLength) {
        const limit = Math.max(1, Number.isInteger(maxOutputLength) ? maxOutputLength : MAX_PDF_STREAM_OUTPUT_BYTES)
        try { return zlib.inflateSync(data, { maxOutputLength: limit }) } catch (e) {}
        try { return zlib.inflateRawSync(data, { maxOutputLength: limit }) } catch (e) { return null }
      }
      function decodeAsciiHexHost(buf) {
        const s = buf.toString('latin1')
        const out = []
        let hi = null
        for (let i = 0; i < s.length; i++) {
          const c = s[i]
          if (c === '>') break
          const n = parseInt(c, 16)
          if (!isFinite(n)) continue
          if (hi == null) hi = n
          else { out.push((hi << 4) | n); hi = null }
        }
        return Buffer.from(out)
      }
      function pdfLiteralHost(s) {
        return String(s)
          .replace(/\\(\r?\n)/g, '')
          .replace(/\\([nrtbf()\\])/g, (_, c) => c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === 'b' ? '\b' : c === 'f' ? '\f' : c)
          .replace(/\\([0-7]{1,3})/g, (_, o) => { const n = parseInt(o, 8); return isFinite(n) ? String.fromCharCode(n) : '' })
      }
      function hexPdfStringHost(hex) {
        try {
          const raw = Buffer.from(hex, 'hex')
          if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
            let s = ''
            for (let i = 2; i + 1 < raw.length; i += 2) s += String.fromCharCode((raw[i] << 8) | raw[i + 1])
            return s
          }
          return raw.toString('latin1')
        } catch (e) { return '' }
      }
      function pdfExtractTextHost(buf, zlib) {
        const chunks = []
        let i = 0
        let total = 0
        while (i < buf.length && total < MAX_ARCHIVE_OUTPUT_BYTES) {
          const s = buf.indexOf('stream', i)
          if (s < 0) break
          let p = s + 6
          if (buf[p] === 0x0d) p += 1
          if (buf[p] === 0x0a) p += 1
          const e = buf.indexOf('endstream', p)
          if (e < 0) break
          let data = buf.subarray(p, e)
          const head = buf.subarray(Math.max(0, s - 240), s).toString('latin1')
          const remaining = MAX_ARCHIVE_OUTPUT_BYTES - total
          if (head.includes('FlateDecode')) data = inflatePdfHost(data, zlib, Math.min(MAX_PDF_STREAM_OUTPUT_BYTES, remaining))
          else if (head.includes('ASCIIHexDecode')) data = decodeAsciiHexHost(data)
          if (data && data.length > remaining) data = data.subarray(0, remaining)
          if (data && data.length > 0) {
            chunks.push(data)
            total += data.length
          }
          i = e + 9
        }
        const content = Buffer.concat(chunks.length > 0 ? chunks : [buf.subarray(0, MAX_ARCHIVE_OUTPUT_BYTES)]).toString('latin1')
        const out = []
        const re = /\(((?:\\.|[^()\\])*)\)\s*Tj|\[((?:\\.|[^\]\\])*)\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj/g
        let m
        while ((m = re.exec(content)) !== null) {
          if (m[1] != null) out.push(pdfLiteralHost(m[1]))
          else if (m[2] != null) {
            const inner = /\(((?:\\.|[^()\\])*)\)/g
            let x
            while ((x = inner.exec(m[2])) !== null) out.push(pdfLiteralHost(x[1]))
          } else if (m[3] != null) {
            out.push(hexPdfStringHost(m[3]))
          }
        }
        return out.join(' ').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_EXTRACTED_DOCUMENT_CHARS)
      }
      function zipEocdHost(buf) {
        const len = buf.length
        if (len < 22) return null
        const min = Math.max(0, len - 65557)
        for (let p = len - 22; p >= min; p--) {
          if (p + 22 <= len && buf.readUInt32LE(p) === 0x06054b50) {
            return {
              entryCount: buf.readUInt16LE(p + 10),
              centralSize: buf.readUInt32LE(p + 12),
              centralOffset: buf.readUInt32LE(p + 16),
            }
          }
        }
        return null
      }
      function zipEntriesHost(buf) {
        const eocd = zipEocdHost(buf)
        if (!eocd || eocd.centralOffset > buf.length || eocd.centralSize > buf.length - eocd.centralOffset) return []
        const entries = []
        let p = eocd.centralOffset
        const end = p + eocd.centralSize
        const declaredCount = Math.min(eocd.entryCount, MAX_ARCHIVE_ENTRIES)
        while (p + 46 <= end && entries.length < declaredCount) {
          if (buf.readUInt32LE(p) !== 0x02014b50) break
          const compSize = buf.readUInt32LE(p + 20)
          const uncompressedSize = buf.readUInt32LE(p + 24)
          const nameLen = buf.readUInt16LE(p + 28)
          const extraLen = buf.readUInt16LE(p + 30)
          const commentLen = buf.readUInt16LE(p + 32)
          const localOffset = buf.readUInt32LE(p + 42)
          const recordSize = 46 + nameLen + extraLen + commentLen
          if (recordSize > end - p || p + 46 + nameLen > end) break
          const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
          entries.push({ name, compSize, uncompressedSize, localOffset })
          p += recordSize
        }
        return entries
      }
      function zipReadEntryHost(buf, entry, zlib, outputLimit) {
        if (!entry || typeof entry !== 'object') return null
        const p = entry.localOffset
        const limit = Math.max(1, Number.isInteger(outputLimit) ? outputLimit : MAX_ARCHIVE_ENTRY_OUTPUT_BYTES)
        if (!Number.isInteger(p) || p < 0 || p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null
        const method = buf.readUInt16LE(p + 8)
        const nameLen = buf.readUInt16LE(p + 26)
        const extraLen = buf.readUInt16LE(p + 28)
        const start = p + 30 + nameLen + extraLen
        if (start < p || start > buf.length || entry.compSize > buf.length - start || entry.compSize > MAX_DOCUMENT_FILE_BYTES) return null
        if (Number.isInteger(entry.uncompressedSize) && entry.uncompressedSize > limit) return null
        const data = buf.subarray(start, start + entry.compSize)
        if (method === 8) {
          try { return zlib.inflateRawSync(data, { maxOutputLength: limit }) } catch (e) { return null }
        }
        if (method === 0) return data.length <= limit ? data : null
        return null
      }
      function xmlToTextHost(xml, mode) {
        let s = xml.toString('utf8')
        if (mode === 'pptx') {
          const parts = []
          const re = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
          let m
          while ((m = re.exec(s)) !== null) parts.push(decodeXmlEntitiesHost(m[1]))
          return parts.join(' ').replace(/[ \t]{2,}/g, ' ')
        }
        if (mode === 'xlsx') {
          const parts = []
          const si = /<si\b[^>]*>([\s\S]*?)<\/si>/g
          let m
          while ((m = si.exec(s)) !== null) {
            const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g
            let x
            while ((x = t.exec(m[1])) !== null) parts.push(decodeXmlEntitiesHost(x[1]))
          }
          const is = /<is\b[^>]*>([\s\S]*?)<\/is>/g
          while ((m = is.exec(s)) !== null) {
            const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g
            let x
            while ((x = t.exec(m[1])) !== null) parts.push(decodeXmlEntitiesHost(x[1]))
          }
          return parts.join(' ').replace(/[ \t]{2,}/g, ' ')
        }
        // docx / odt / generic XML: paragraph and line-break markers first
        s = s.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n')
        s = s.replace(/<w:p\b/g, '\n<w:p').replace(/<text:p\b/g, '\n<text:p').replace(/<text:h\b/g, '\n<text:h')
        s = s.replace(/<[^>]+>/g, ' ')
        return decodeXmlEntitiesHost(s).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
      }
      function zipExtractTextHost(buf, name, zlib) {
        const entries = zipEntriesHost(buf)
        const lower = name.toLowerCase()
        const parts = []
        let hits = 0
        let outputBytes = 0
        let outputChars = 0
        const readEntryText = (entry, mode) => {
          const remaining = MAX_ARCHIVE_OUTPUT_BYTES - outputBytes
          if (remaining <= 0) return null
          const data = zipReadEntryHost(buf, entry, zlib, Math.min(MAX_ARCHIVE_ENTRY_OUTPUT_BYTES, remaining))
          if (!data) return null
          outputBytes += data.length
          const text = xmlToTextHost(data, mode).slice(0, Math.max(0, MAX_EXTRACTED_DOCUMENT_CHARS - outputChars))
          outputChars += text.length
          return text
        }
        if (lower.endsWith('.docx')) {
          for (const e of entries) {
            if (e.name !== 'word/document.xml') continue
            const text = readEntryText(e, 'docx')
            if (text) { parts.push(text); hits += 1 }
          }
        } else if (lower.endsWith('.pptx')) {
          for (const e of entries) {
            if (!/^ppt\/slides\/slide\d+\.xml$/.test(e.name)) continue
            const text = readEntryText(e, 'pptx')
            if (text) { parts.push('幻灯片：' + text); hits += 1 }
          }
        } else if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
          const shared = entries.find((e) => e.name === 'xl/sharedStrings.xml')
          if (shared) {
            const text = readEntryText(shared, 'xlsx')
            if (text) { parts.push(text); hits += 1 }
          }
          for (const e of entries) {
            if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)) continue
            const text = readEntryText(e, 'xlsx')
            if (text) { parts.push(text); hits += 1 }
          }
        } else if (lower.endsWith('.odt')) {
          const e = entries.find((x) => x.name === 'content.xml')
          if (e) {
            const text = readEntryText(e, 'docx')
            if (text) { parts.push(text); hits += 1 }
          }
        }
        if (hits > 0) return parts.join('\n\n').trim().slice(0, MAX_EXTRACTED_DOCUMENT_CHARS)
        return null
      }
      async function readDocumentTextHost(absPath, name) {
        const mods = await docNodeModules()
        const noFollow = Number.isInteger(mods.fs.constants && mods.fs.constants.O_NOFOLLOW) ? mods.fs.constants.O_NOFOLLOW : 0
        const handle = await mods.fs.open(absPath, mods.fs.constants.O_RDONLY | noFollow)
        try {
          const st = await handle.stat()
          if (!st.isFile()) return { error: '不是普通文件' }
          if (st.size > MAX_DOCUMENT_FILE_BYTES) return { error: '文件超过 15 MiB，已跳过' }
          const buf = await handle.readFile()
        const lower = name.toLowerCase()
        if (lower.endsWith('.pdf') || (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-')) {
          const text = pdfExtractTextHost(buf, mods.zlib)
          return text.trim() ? { text, format: 'pdf', bytes: st.size, warning: 'PDF 文本为本地解析，复杂排版可能不完整' } : { error: 'PDF 没有提取到文本（可能是扫描版或超过解压安全上限）' }
        }
        if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7) && buf[3] < 10) {
          const text = zipExtractTextHost(buf, lower, mods.zlib)
          return text && text.trim() ? { text, format: lower.split('.').pop() || 'zip', bytes: st.size } : { error: '压缩文档没有提取到文本（格式不支持或超过解压安全上限）' }
        }
        if (looksUtf8TextHost(buf, name)) {
          const text = buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, NL).slice(0, MAX_EXTRACTED_DOCUMENT_CHARS)
          if (text.trim()) return { text, format: 'text', bytes: st.size }
        }
          return { error: '暂不支持的文件格式（支持文本类 / PDF / DOCX / PPTX / XLSX / ODT）' }
        } finally {
          try { await handle.close() } catch (e) {}
        }
      }
      function parsePasteInputMarkersHost(text) {
        const markers = []
        const re = /==== DSH_PASTE_INPUT_V1 ====[ \t]*\r?\n([^\r\n]+)[ \t]*\r?\n[\s\S]*?Attached files[^\r\n]*\r?\n([\s\S]*?)==== END DSH_PASTE_INPUT ====/g
        let m
        while ((m = re.exec(String(text || ''))) !== null) {
          const root = m[1].trim()
          const files = []
          const fr = /^\s*-\s*"((?:\\.|[^"])*)"\s*\([^)]*\)\s*$/gm
          let f
          while ((f = fr.exec(m[2])) !== null) files.push(f[1].replace(/\\"/g, '"'))
          if (root && files.length > 0) markers.push({ root, files })
        }
        return markers
      }
      // dsh-at-file emits `<workspace-reference path="docs/x.pdf" kind="file" />`;
      // the path is relative to the session workspace (session.header.cwd).
      function parseWorkspaceReferencesHost(text) {
        const refs = []
        const re = /<workspace-reference\b[^>]*\/?>/g
        let m
        while ((m = re.exec(String(text || ''))) !== null) {
          const tag = m[0]
          const pathM = /\bpath\s*=\s*"([^"]*)"/.exec(tag)
          const kindM = /\bkind\s*=\s*"([^"]*)"/.exec(tag)
          if (pathM && pathM[1] && (!kindM || kindM[1] === 'file')) refs.push(pathM[1])
        }
        return refs
      }
      function pathInsideHost(root, candidate, pathMod) {
        const rel = pathMod.relative(root, candidate)
        return Boolean(rel) && !rel.startsWith('..' + pathMod.sep) && !pathMod.isAbsolute(rel)
      }
      function ownedAttachmentRootHost(root, sessionId, pathMod) {
        if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return false
        const parts = pathMod.resolve(root).split(pathMod.sep).filter(Boolean)
        for (let i = 0; i + 3 < parts.length; i++) {
          if (parts[i] === '.dsh' && parts[i + 1] === 'tmp' && parts[i + 2] === 'attachments' && parts[i + 3] === sessionId) return true
        }
        return false
      }
      async function resolveContainedDocumentPathHost(rootPath, relativePath, mods) {
        const rootReal = await mods.fs.realpath(rootPath)
        const candidate = mods.path.resolve(rootReal, relativePath)
        const candidateReal = await mods.fs.realpath(candidate)
        if (!pathInsideHost(rootReal, candidateReal, mods.path)) return null
        return { root: rootReal, path: candidateReal }
      }
      async function collectDocumentAttachmentsHost(sessionId, session, pendingText) {
        const mods = await docNodeModules()
        const found = []
        const warnings = []
        const seen = new Set()
        const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
        const cwdRoot = cwd ? mods.path.resolve(cwd) : ''
        const texts = pendingText !== undefined
          ? [String(pendingText)]
          : (session && Array.isArray(session.events) ? session.events
              .filter((ev) => ev && ev.type === 'user/message')
              .map((ev) => traceTextOf(ev.data && ev.data.content))
              .filter(Boolean) : [])
        for (const text of texts) {
          for (const marker of parsePasteInputMarkersHost(text)) {
            let markerRootReal = null
            try { markerRootReal = await mods.fs.realpath(mods.path.resolve(marker.root)) } catch (e) {}
            if (!markerRootReal || !ownedAttachmentRootHost(markerRootReal, sessionId, mods.path)) {
              warnings.push('忽略不在当前会话附件目录中的路径：' + marker.root)
              continue
            }
            for (const rel of marker.files) {
              let resolved = null
              try { resolved = await resolveContainedDocumentPathHost(markerRootReal, rel, mods) } catch (e) {}
              if (!resolved) {
                warnings.push('忽略越界或不存在的附件路径：' + rel)
                continue
              }
              const abs = resolved.path
              if (seen.has(abs)) continue
              seen.add(abs)
              try {
                const extracted = await readDocumentTextHost(abs, rel)
                if (extracted.error) warnings.push(rel + '：' + extracted.error)
                else found.push({ name: rel, path: abs, ...extracted })
              } catch (e) {
                warnings.push(rel + '：读取失败（' + (e && e.message ? e.message : '未知错误') + '）')
              }
            }
          }
          for (const rel of parseWorkspaceReferencesHost(text)) {
            if (!cwdRoot) {
              warnings.push('忽略 @文件引用 ' + rel + '：会话没有工作区目录')
              continue
            }
            let resolved = null
            try { resolved = await resolveContainedDocumentPathHost(cwdRoot, rel, mods) } catch (e) {}
            if (!resolved) {
              warnings.push('忽略越界或不存在的 @文件引用：' + rel)
              continue
            }
            const abs = resolved.path
            if (seen.has(abs)) continue
            seen.add(abs)
            try {
              const extracted = await readDocumentTextHost(abs, rel)
              if (extracted.error) warnings.push(rel + '：' + extracted.error)
              else found.push({ name: rel, path: abs, ...extracted })
            } catch (e) {
              warnings.push(rel + '：读取失败（' + (e && e.message ? e.message : '未知错误') + '）')
            }
          }
        }
        return { found, warnings }
      }
      function serializeTrace(events) {
        // Keep the first events that fit under MAX_TRACE_TEXT so the AI prompt stays
        // small. Each trace event is its own blank-line block; the content-aware
        // splitter may divide a long event into several numbered units, so each
        // meta record also carries [start, end) offsets into traceText for the
        // client to map units -> events.
        const cap = MAX_TRACE_TEXT - 400
        const lines = []
        const entries = []
        let total = 0
        let skipped = 0
        for (const ev of events) {
          const d = ev && typeof ev.data === 'object' ? ev.data : {}
          let line = null
          if (ev.type === 'turn/start') line = '—— 回合 ' + d.turn + ' 开始 ——'
          else if (ev.type === 'turn/end') line = '—— 回合 ' + d.turn + ' 结束（' + d.reason + '）——'
          else if (ev.type === 'user/message') line = '用户消息：' + traceClip(traceTextOf(d.content), 400)
          else if (ev.type === 'assistant/message') line = 'AI 回复：' + traceClip(traceTextOf(d.message && d.message.content), 600)
          else if (ev.type === 'tool/call') line = '调用工具 ' + d.name + '：' + traceClip(d.arguments, 200)
          else if (ev.type === 'tool/result') line = '工具结果：' + traceClip(traceTextOf(d.message && d.message.content), 400)
          if (!line) continue
          const len = line.length
          if (total > 0 && total + len + 2 > cap) { skipped += 1; continue }
          if (total === 0 && len > cap) line = line.slice(0, cap)
          lines.push(line)
          entries.push({ seq: ev.seq, type: ev.type, line })
          total += len + 2
        }
        const body = lines.join(NL + NL)
        const meta = []
        let pos = 0
        for (let i = 0; i < lines.length; i++) {
          meta.push({ ...entries[i], start: pos, end: pos + lines[i].length })
          pos += lines[i].length + (i < lines.length - 1 ? 2 : 0)
        }
        let tail = ''
        if (skipped > 0) tail = NL + NL + '（轨迹过长，已截断：后续 ' + skipped + ' 个事件未纳入拆解）'
        return { traceText: body + tail, traceEvents: meta }
      }

      // ---- incremental append helpers ----
      function normalizeGraphLookupTextHost(value) {
        return normalizeForHost(String(value || '').normalize('NFKC').toLowerCase(), 'both').text.trim()
      }
      function graphNodeLookupKeyHost(node) {
        const text = normalizeGraphLookupTextHost(node && node.text)
        if (!text) return ''
        const type = node && (node.type === 'concept' || node.type === 'definition') ? 'entity' : (node && node.type ? node.type : '')
        return type + '|' + text
      }
      function mergeNodeEvidenceHost(target, incoming) {
        if (!target || !incoming) return
        if ((!target.quote || !target.quote.trim()) && incoming.quote) target.quote = incoming.quote
        if (!Number.isInteger(target.paragraph) && Number.isInteger(incoming.paragraph)) target.paragraph = incoming.paragraph
        const evidence = Array.isArray(target.evidence) ? target.evidence.slice(0, 4) : []
        const incomingEvidence = Array.isArray(incoming.evidence) ? incoming.evidence : []
        for (const item of incomingEvidence) {
          if (!item || evidence.length >= 4) break
          const key = String(item.paragraph) + '|' + String(item.quote || '')
          if (!evidence.some((existing) => String(existing.paragraph) + '|' + String(existing.quote || '') === key)) evidence.push({ paragraph: item.paragraph, quote: String(item.quote || '').slice(0, 600) })
        }
        target.evidence = evidence
      }
      function registerNodeLookupKeyHost(acc, node) {
        const key = graphNodeLookupKeyHost(node)
        if (key && !acc.nodeKeys.has(key)) acc.nodeKeys.set(key, node.id)
      }
      function dedupeIncomingNodesHost(norm, acc) {
        const idMap = new Map()
        const kept = []
        const pending = new Map()
        for (const node of norm.nodes) {
          const key = graphNodeLookupKeyHost(node)
          const canonicalId = (key && (acc.nodeKeys.get(key) || pending.get(key))) || ''
          if (canonicalId && canonicalId !== node.id) {
            idMap.set(node.id, canonicalId)
            const canonical = acc.nodes.get(canonicalId) || kept.find((candidate) => candidate.id === canonicalId)
            if (canonical) mergeNodeEvidenceHost(canonical, node)
            acc.warnings.push('duplicate_merged:' + node.id + '->' + canonicalId)
            continue
          }
          kept.push(node)
          if (key) pending.set(key, node.id)
        }
        for (const edge of norm.edges) {
          if (idMap.has(edge.fromNodeId)) edge.fromNodeId = idMap.get(edge.fromNodeId)
          if (idMap.has(edge.toNodeId)) edge.toNodeId = idMap.get(edge.toNodeId)
        }
        norm.nodes = kept
        return norm
      }
      function serializeExistingGraph(existing, maxNodes, queryText) {
        const nodes = existing && Array.isArray(existing.nodes) ? existing.nodes : []
        const candidates = []
        const query = normalizeGraphLookupTextHost(queryText)
        const queryTokens = query ? phraseTokensHost(query) : new Set()
        for (let index = 0; index < nodes.length; index++) {
          const n = nodes[index]
          if (!n || typeof n !== 'object') continue
          const id = typeof n.id === 'string' ? n.id.trim() : ''
          const text = typeof n.text === 'string' ? n.text.trim() : ''
          if (!id || !text) continue
          const normalized = normalizeGraphLookupTextHost(text)
          const tokens = phraseTokensHost(normalized)
          let overlap = 0
          if (queryTokens.size > 0) for (const token of queryTokens) if (tokens.has(token)) overlap += 1
          const score = queryTokens.size > 0 ? (normalized === query ? 2 : overlap / Math.max(queryTokens.size, tokens.size, 1)) : 0
          candidates.push({ node: n, index, score })
        }
        if (queryTokens.size > 0) candidates.sort((a, b) => b.score - a.score || a.index - b.index)
        const cap = typeof maxNodes === 'number' && maxNodes > 0 ? maxNodes : 24
        return candidates.slice(0, cap).map(({ node }) => (
          node.id + '|' + (typeof node.type === 'string' ? node.type : '') + '|' + String(node.text || '').slice(0, 120)
        )).join(NL)
      }

      // AI ids restart at n1 per batch; renumber any id that collides with an
      // already-accumulated node (existing graph or earlier batch), rewriting
      // edges accordingly.
      function renumberNewIds(norm, acc) {
        const taken = new Set(acc.nodes.keys())
        let maxNum = 0
        for (const id of taken) {
          const m = /^n(\d+)$/.exec(id)
          if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10))
        }
        const idMap = new Map()
        for (const node of norm.nodes) {
          if (taken.has(node.id)) {
            let nid = null
            while (nid == null || taken.has(nid)) { maxNum += 1; nid = 'n' + maxNum }
            idMap.set(node.id, nid)
            node.id = nid
          }
          taken.add(node.id)
        }
        if (idMap.size > 0) {
          for (const e of norm.edges) {
            if (idMap.has(e.fromNodeId)) e.fromNodeId = idMap.get(e.fromNodeId)
            if (idMap.has(e.toNodeId)) e.toNodeId = idMap.get(e.toNodeId)
          }
        }
        return norm
      }

      // ---- task runner ----
      const tasks = new Map()
      let seq = 0
      let busy = false
      let activeTask = null

      function failTask(task, code, message) {
        task.status = code === 'cancelled' ? 'cancelled' : 'failed'
        task.finishedAt = Date.now()
        task.errorCode = code
        task.errorMessage = message
      }
      // Checkpoints contain only owned JSON data. They are returned on demand
       // by task-status and can be persisted by the client without keeping any
       // live Host references. The next batch is always the first unfinished
       // one, so a retry never duplicates completed chunks.
       function buildTaskCheckpoint(task, sourceManifest, chunkResults, acc, summary, nextBatchIndex) {
         const nodes = []
         acc.nodes.forEach((node) => {
           if (nodes.length < MAX_GRAPH_NODES) nodes.push({ ...node, evidence: Array.isArray(node.evidence) ? node.evidence.slice(0, 4) : [] })
         })
         const nodeIds = new Set(nodes.map((node) => node.id))
         const edges = acc.edges
           .filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))
           .slice(0, MAX_GRAPH_NODES * 6)
           .map((edge) => ({ ...edge, evidence: Array.isArray(edge.evidence) ? edge.evidence.slice(0, 4) : [] }))
         return {
           version: 1,
           title: sourceManifest.title,
           documentId: sourceManifest.documentId,
           sourceId: sourceManifest.sourceId,
           chars: sourceManifest.chars,
           paragraphCount: sourceManifest.paragraphCount,
           totalBatches: sourceManifest.chunkCount,
           nextBatchIndex,
           paragraphOffset: Number.isInteger(task.paragraphOffset) ? task.paragraphOffset : 0,
           summary: summary || '',
           graph: { summary: summary || '', nodes, edges, warnings: acc.warnings.slice(-300) },
           staging: {
             sourceId: sourceManifest.sourceId,
             documentId: sourceManifest.documentId,
             chunkCount: chunkResults.length,
             chunks: chunkResults.map((chunk) => ({
               ...chunk,
               sectionIds: Array.isArray(chunk.sectionIds) ? chunk.sectionIds.slice() : [],
               sectionTitles: Array.isArray(chunk.sectionTitles) ? chunk.sectionTitles.slice() : [],
               nodeIds: Array.isArray(chunk.nodeIds) ? chunk.nodeIds.slice() : [],
               warnings: Array.isArray(chunk.warnings) ? chunk.warnings.slice(0, 20) : [],
             })),
           },
         }
       }

       function announceModel(task, model) {
        if (!task || !model) return
        task.progress = task.progress || { stage: '运行中', charsReceived: 0, updatedAt: Date.now() }
        task.progress.stage = '已选择模型：' + model.provider + ' · ' + model.model + '，等待模型响应…'
        task.progress.model = { provider: model.provider, model: model.model }
        task.progress.updatedAt = Date.now()
      }

      async function runTask(task) {
        if (task.cancelled) return failTask(task, 'cancelled', '任务已取消')
        task.cancelHooks = []
        task.progress = { stage: '准备模型', charsReceived: 0, updatedAt: Date.now() }
        activeTask = task
        try {
          const model = task.model || ((hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check') ? null : await resolveModel())
          if (!model && !(hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check')) {
            const warning = task.progress && task.progress.warning ? '（' + task.progress.warning + '）' : ''
            return failTask(task, 'no_model', '当前环境没有可用的 AI 模型，请先设置模型后重试' + warning)
          }
          if (model) announceModel(task, model)
          const paras = splitParagraphsHost(task.text)
                     const isResume = task.kind === 'resume'
           const sourceManifest = buildSourceManifestHost(task.title, task.text, paras, task.documentId)
          const batches = sourceManifest.batches
          const sourceContext = {
            documentId: sourceManifest.documentId,
            sourceId: sourceManifest.sourceId,
            paragraphMeta: sourceManifest.paragraphMeta,
          }
          const persistCheckpointSafe = async (status) => {
             if (typeof persistCheckpoint !== 'function' || !task.checkpoint) return
             try { await persistCheckpoint(task.checkpoint, task, status || task.status || 'running') } catch (error) {
               if (task.progress) task.progress.warning = 'SQLite checkpoint 保存失败：' + (error && error.message ? error.message : String(error))
             }
           }
           if (isResume) {
             const checkpoint = task.checkpoint
             const nextBatch = checkpoint && Number.isInteger(checkpoint.nextBatchIndex) ? checkpoint.nextBatchIndex : -1
             if (!checkpoint || checkpoint.version !== 1 || checkpoint.sourceId !== sourceManifest.sourceId || nextBatch < 0 || nextBatch > batches.length || !checkpoint.graph || !Array.isArray(checkpoint.graph.nodes)) {
               return failTask(task, 'checkpoint_invalid', 'checkpoint 与当前正文不匹配，无法安全续跑；请重新拆分全文')
             }
           }
           const acc = { nodes: new Map(), edges: [], edgeKeys: new Set(), warnings: [], nodeKeys: new Map() }
          let summary = ''
          const batchSummaries = []
          const chunkResults = []
          const sectionSummaryParts = new Map()
          // ---- append mode: seed the accumulator with the existing graph ----
                     const isAppend = task.kind === 'append' || task.kind === 'trajectory-append' || isResume
          const isTrajAppend = task.kind === 'trajectory-append'
          const existing = isAppend && task.existing && typeof task.existing === 'object' ? task.existing : null
          const existingIds = new Set()
          const addedIds = []
          if (existing) {
            for (const n of existing.nodes || []) {
              if (!n || typeof n !== 'object') continue
              const id = typeof n.id === 'string' ? n.id.trim() : ''
              const text = typeof n.text === 'string' ? n.text.trim() : ''
              if (!id || !text) continue
              acc.nodes.set(id, {
                id,
                type: TYPE_ALIASES[typeof n.type === 'string' ? n.type.trim().toLowerCase() : ''] || 'fact',
                text,
                quote: typeof n.quote === 'string' ? n.quote : '',
                paragraph: typeof n.paragraph === 'number' ? n.paragraph : null,
                 evidence: Array.isArray(n.evidence) ? n.evidence.slice(0, 4) : [],
                 documentId: typeof n.documentId === 'string' ? n.documentId : null,
                 sourceId: typeof n.sourceId === 'string' ? n.sourceId : null,
                 chunkId: typeof n.chunkId === 'string' ? n.chunkId : null,
                 sectionId: typeof n.sectionId === 'string' ? n.sectionId : null,
                 sectionTitle: typeof n.sectionTitle === 'string' ? n.sectionTitle : null,
              })
              registerNodeLookupKeyHost(acc, acc.nodes.get(id))
               existingIds.add(id)
            }
            for (const e of existing.edges || []) {
              if (!e || typeof e !== 'object') continue
              const from = typeof e.fromNodeId === 'string' ? e.fromNodeId : ''
              const to = typeof e.toNodeId === 'string' ? e.toNodeId : ''
              const rel = REL_ALIASES[typeof e.relation === 'string' ? e.relation.trim().toLowerCase() : '']
              if (!rel || !existingIds.has(from) || !existingIds.has(to) || from === to) continue
              const key = from + '>' + to + ':' + rel
              if (acc.edgeKeys.has(key)) continue
              acc.edgeKeys.add(key)
              acc.edges.push({
                 fromNodeId: from,
                 toNodeId: to,
                 relation: rel,
                 evidence: Array.isArray(e.evidence) ? e.evidence.slice(0, 4) : [],
                 ...(typeof e.documentId === 'string' ? { documentId: e.documentId } : {}),
                 ...(typeof e.sourceId === 'string' ? { sourceId: e.sourceId } : {}),
                 ...(typeof e.chunkId === 'string' ? { chunkId: e.chunkId } : {}),
               })
            }
            if (typeof existing.summary === 'string' && existing.summary) summary = existing.summary
          }
          if (existing && Array.isArray(existing.warnings)) acc.warnings.push(...existing.warnings.slice(-300))
           if (isResume && task.checkpoint) {
             summary = typeof task.checkpoint.summary === 'string' && task.checkpoint.summary ? task.checkpoint.summary : summary
             const priorChunks = task.checkpoint.staging && Array.isArray(task.checkpoint.staging.chunks) ? task.checkpoint.staging.chunks : []
             for (const chunk of priorChunks) {
               if (!chunk || typeof chunk !== 'object' || !chunk.chunkId) continue
               chunkResults.push({
                 ...chunk,
                 sectionIds: Array.isArray(chunk.sectionIds) ? chunk.sectionIds.slice() : [],
                 sectionTitles: Array.isArray(chunk.sectionTitles) ? chunk.sectionTitles.slice() : [],
                 nodeIds: Array.isArray(chunk.nodeIds) ? chunk.nodeIds.slice() : [],
                 warnings: Array.isArray(chunk.warnings) ? chunk.warnings.slice(0, 20) : [],
               })
               if (chunk.summary) {
                 batchSummaries.push(chunk.summary)
                 for (const sectionId of chunk.sectionIds || []) {
                   const parts = sectionSummaryParts.get(sectionId) || []
                   parts.push(chunk.summary)
                   sectionSummaryParts.set(sectionId, parts)
                 }
               }
             }
           }
           const offset = isAppend && Number.isInteger(task.paragraphOffset) && task.paragraphOffset > 0 ? task.paragraphOffset : 0
           const resumeFromBatch = isResume && task.checkpoint && Number.isInteger(task.checkpoint.nextBatchIndex) ? task.checkpoint.nextBatchIndex : 0
          task.checkpoint = buildTaskCheckpoint(task, sourceManifest, chunkResults, acc, summary, resumeFromBatch)
           await persistCheckpointSafe('running')
           const existingDigest = ''
          const system = isTrajAppend ? TRAJ_APPEND_SYSTEM_PROMPT : (isResume ? SYSTEM_PROMPT : (isAppend ? APPEND_SYSTEM_PROMPT : (task.kind === 'trajectory' ? TRAJ_SYSTEM_PROMPT : SYSTEM_PROMPT)))
          for (let i = resumeFromBatch; i < batches.length; i++) {
            const batch = batches[i]
             const batchContext = { ...sourceContext, chunkId: batch.chunkId }
             taskStage('正在处理第 ' + (i + 1) + '/' + batches.length + ' 个内容块（' + batch.chunkId + '）')
             if (task.progress) {
               task.progress.batch = { index: i + 1, total: batches.length, chunkId: batch.chunkId, startParagraph: batch.startParagraph, endParagraph: batch.endParagraph }
             }
             const batchQuery = (batch.units || []).map((unit) => unit && unit.text ? unit.text : '').join(' ')
             const existingDigest = acc.nodes.size > 0
               ? serializeExistingGraph({ nodes: Array.from(acc.nodes.values()) }, 24, batchQuery)
               : ''
             let userText = buildUserPrompt(task.title, batch, i, batches.length)
            if (existingDigest) {
              userText += NL + NL + '已有知识图节点清单（id|类型|文本，引用边时只能用这些 id）：' + NL + existingDigest
            }
            let norm = null
            let lastErr = ''
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const raw = hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check'
                   ? await (typeof kgExtractor === 'function' ? kgExtractor({
                     title: task.title,
                     chunk: { ...batch, units: Array.isArray(batch.units) ? batch.units : [] },
                     paragraphOffset: offset,
                     existingNodeIds: Array.from(existingIds),
                     existingDigest,
                     systemPrompt: system,
                     prompt: userText,
                     attempt,
                   }) : kgExtractor.extractChunk({
                     title: task.title,
                     chunk: { ...batch, units: Array.isArray(batch.units) ? batch.units : [] },
                     paragraphOffset: offset,
                     existingNodeIds: Array.from(existingIds),
                     existingDigest,
                     systemPrompt: system,
                     prompt: userText,
                     attempt,
                   }))
                   : await callModel(model, system, userText, 180000, 0.1)
                const obj = raw && typeof raw === 'object' ? raw : parseJson(raw)
                const r = normalizeGraph(obj, paras.length, existingIds, batchContext)
                if (r.error) { lastErr = r.error; continue }
                norm = r
                break
              } catch (e) {
                if (e && e.code === 'cancelled') throw e
                if (e && e.code === 'timeout') { lastErr = '超时'; break }
                lastErr = e && e.message ? e.message : String(e)
              }
            }
            if (!norm) {
              return failTask(task, 'schema_invalid', 'AI 返回结果无法解析（第 ' + (i + 1) + '/' + batches.length + ' 批，已自动重试）：' + lastErr)
            }
            // ALWAYS renumber colliding ids. Previously this only ran in append
            // mode, so multi-batch extractions (each batch restarts at n1) had
            // later-batch nodes silently dropped as duplicate ids — a serious
            // quality bug for documents longer than one batch.
            renumberNewIds(norm, acc)
            if (isAppend) {
              for (const n of norm.nodes) {
                if (n.paragraph != null) n.paragraph += offset
                 if (Array.isArray(n.evidence)) {
                   for (const evidence of n.evidence) if (evidence && Number.isInteger(evidence.paragraph)) evidence.paragraph += offset
                 }
                addedIds.push(n.id)
              }
            }
            if (isAppend) {
               for (const edge of norm.edges) {
                 if (Array.isArray(edge.evidence)) {
                   for (const evidence of edge.evidence) if (evidence && Number.isInteger(evidence.paragraph)) evidence.paragraph += offset
                 }
               }
             }
             dedupeIncomingNodesHost(norm, acc)
             mergeBatch(norm, acc, i)
             for (const node of norm.nodes) existingIds.add(node.id)
            if (norm.summary) {
               batchSummaries.push(norm.summary)
               for (const sectionId of batch.sectionIds || []) {
                 const parts = sectionSummaryParts.get(sectionId) || []
                 parts.push(norm.summary)
                 sectionSummaryParts.set(sectionId, parts)
               }
             }
             chunkResults.push({
               chunkId: batch.chunkId,
               startParagraph: batch.startParagraph + offset,
               endParagraph: batch.endParagraph + offset,
               sectionIds: Array.isArray(batch.sectionIds) ? batch.sectionIds.slice() : [],
               sectionTitles: Array.isArray(batch.sectionTitles) ? batch.sectionTitles.slice() : [],
               summary: norm.summary || '',
               nodeIds: norm.nodes.map((node) => node.id),
               edgeCount: norm.edges.length,
               warnings: norm.warnings.slice(0, 20),
             })
            // Batch prompts ask for a LOCAL summary. Keep the first as a
            // fallback; multi-batch summaries are consolidated below so the
            // final summary actually covers the whole text.
            if (isAppend ? norm.summary : !summary) summary = norm.summary || summary
             task.checkpoint = buildTaskCheckpoint(task, sourceManifest, chunkResults, acc, summary, i + 1)
             await persistCheckpointSafe('running')
          }
          if (batchSummaries.length > 1) {
            try {
              const raw = await callModel(model, SUMMARY_SYSTEM_PROMPT, buildSummaryUserText(summary, batchSummaries), 60000, 0.1)
              const obj = raw && typeof raw === 'object' ? raw : parseJson(raw)
              if (obj && typeof obj.summary === 'string' && obj.summary.trim()) summary = obj.summary.trim()
            } catch (e) {
              // Fall back to the batch-level summary; never fail extraction
              // just because the summary-merge call failed.
              acc.warnings.push('summary_consolidation_failed:' + (e && e.message ? e.message : String(e)))
            }
          }
          const nodes = []
          task.checkpoint = buildTaskCheckpoint(task, sourceManifest, chunkResults, acc, summary, batches.length)
           acc.nodes.forEach((v) => nodes.push(v))
          if (nodes.length === 0) return failTask(task, 'empty', 'AI 没有拆出任何节点，请尝试内容更明确的资料')
          if (nodes.length > MAX_GRAPH_NODES) return failTask(task, 'too_many_nodes', '合并后的节点过多（' + nodes.length + ' 个，当前上限 ' + MAX_GRAPH_NODES + '），请分章节拆分或追加更小的内容')
          task.status = 'succeeded'
          task.finishedAt = Date.now()
          const sourceSections = sourceManifest.sections.map((section) => {
             const parts = sectionSummaryParts.get(section.id) || []
             return {
               id: section.id,
               title: section.title,
               startParagraph: section.startParagraph + offset,
               endParagraph: section.endParagraph + offset,
               summary: parts.join(' ').slice(0, 1200),
             }
           })
           const source = {
             id: sourceManifest.sourceId,
             documentId: sourceManifest.documentId,
             title: sourceManifest.title,
             chars: sourceManifest.chars,
             paragraphCount: sourceManifest.paragraphCount,
             chunkCount: sourceManifest.chunkCount,
             sectionCount: sourceManifest.sectionCount,
             sections: sourceSections,
             ...(isAppend && existing && existing.source && existing.source.id ? { previousId: existing.source.id } : {}),
           }
           const trajAppendPrefix = isTrajAppend && typeof task.baseTraceText === 'string' && task.baseTraceText ? task.baseTraceText + NL + NL : ''
          const trajAppendEvents = isTrajAppend ? [
            ...(Array.isArray(task.baseTraceEvents) ? task.baseTraceEvents : []),
            ...(Array.isArray(task.traceEvents) ? task.traceEvents : []).map((e) => (
              e && typeof e.start === 'number' && typeof e.end === 'number'
                ? { ...e, start: e.start + trajAppendPrefix.length, end: e.end + trajAppendPrefix.length }
                : e
            )),
          ] : null
          task.result = {
            summary, nodes, edges: acc.edges, warnings: acc.warnings,
             source,
             staging: {
               sourceId: source.id,
               documentId: source.documentId,
               chunkCount: chunkResults.length,
               chunks: chunkResults,
             },
            ...task.kind === 'trajectory' ? { traceText: task.traceText, traceEvents: task.traceEvents } : {},
            ...isTrajAppend ? {
              traceText: trajAppendPrefix + task.text,
              traceEvents: trajAppendEvents,
            } : {},
            ...isAppend ? { addedNodeIds: addedIds } : {},
           }
           await persistCheckpointSafe('succeeded')
           if (typeof persistGraph === 'function') {
             try { await persistGraph(task.result, task) } catch (error) {
               task.result.warnings = Array.isArray(task.result.warnings) ? task.result.warnings : []
               task.result.warnings.push('sqlite_persist_failed:' + (error && error.message ? error.message : String(error)))
             }
           }

        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] extraction failed:', e)
          if (e && e.code === 'cancelled') failTask(task, 'cancelled', '任务已取消')
          else failTask(task, 'failed', 'AI 拆分失败：' + msg)
           await persistCheckpointSafe(task.status)
        }
      }

      function prepareVerificationInputHost(args) {
        const rawText = typeof args.text === 'string' ? args.text.trim() : ''
        const graph = args.graph && typeof args.graph === 'object' ? args.graph : null
        const sourceUnits = Array.isArray(args.sourceUnits) ? args.sourceUnits : []
        if (!graph || sourceUnits.length === 0) return { text: rawText, graph, paragraphMap: null, scoped: false }
        const units = []
        const seen = new Set()
        let chars = 0
        for (const unit of sourceUnits) {
          if (!unit || typeof unit !== 'object') continue
          const paragraph = Number(unit.paragraph)
          const text = typeof unit.text === 'string' ? unit.text.trim() : ''
          if (!Number.isInteger(paragraph) || paragraph < 0 || !text || seen.has(paragraph)) continue
          if (units.length >= MAX_VERIFY_SCOPE_UNITS || chars + text.length > MAX_VERIFY_SCOPE_CHARS) break
          seen.add(paragraph)
          units.push({ paragraph, text })
          chars += text.length
        }
        if (units.length === 0) return { text: rawText, graph, paragraphMap: null, scoped: false }
        units.sort((a, b) => a.paragraph - b.paragraph)
        const paragraphMap = units.map((unit) => unit.paragraph)
        const localParagraph = new Map(paragraphMap.map((paragraph, index) => [paragraph, index]))
        const scopedGraph = {
          ...graph,
          nodes: Array.isArray(graph.nodes) ? graph.nodes.map((node) => ({
            ...node,
            paragraph: Number.isInteger(node && node.paragraph) && localParagraph.has(node.paragraph) ? localParagraph.get(node.paragraph) : null,
            evidence: Array.isArray(node && node.evidence) ? node.evidence.map((evidence) => ({
              ...evidence,
              paragraph: Number.isInteger(evidence && evidence.paragraph) && localParagraph.has(evidence.paragraph) ? localParagraph.get(evidence.paragraph) : null,
            })) : node && node.evidence,
          })) : [],
          edges: Array.isArray(graph.edges) ? graph.edges.slice() : [],
        }
        return {
          text: units.map((unit) => unit.text).join(NL + NL),
          graph: scopedGraph,
          paragraphMap,
          scoped: true,
        }
      }
      function mapVerificationParagraphHost(value, paragraphMap) {
        if (!Array.isArray(paragraphMap) || !Number.isInteger(value)) return value
        return value >= 0 && value < paragraphMap.length ? paragraphMap[value] : value
      }
      function mapVerificationResultHost(result, paragraphMap) {
        if (!result || !Array.isArray(paragraphMap)) return result
        const mapEvidence = (evidence) => Array.isArray(evidence) ? evidence.map((item) => ({ ...item, paragraph: mapVerificationParagraphHost(item && item.paragraph, paragraphMap) })) : evidence
        const mapFix = (fix) => {
          if (!fix || typeof fix !== 'object') return fix
          const next = { ...fix }
          if (fix.nodePatch && typeof fix.nodePatch === 'object') {
            next.nodePatch = { ...fix.nodePatch, patch: fix.nodePatch.patch && typeof fix.nodePatch.patch === 'object'
              ? { ...fix.nodePatch.patch, ...(Number.isInteger(fix.nodePatch.patch.paragraph) ? { paragraph: mapVerificationParagraphHost(fix.nodePatch.patch.paragraph, paragraphMap) } : {}) }
              : fix.nodePatch.patch }
          }
          return next
        }
        if (Array.isArray(result.issues)) return { ...result, issues: result.issues.map((issue) => ({ ...issue, evidence: mapEvidence(issue.evidence), proposedFix: mapFix(issue.proposedFix) })) }
        if (Array.isArray(result.claims)) return { ...result, claims: result.claims.map((claim) => ({ ...claim, paragraph: mapVerificationParagraphHost(claim.paragraph, paragraphMap) })) }
        if (Array.isArray(result.evidence) || result.proposedFix) return { ...result, evidence: mapEvidence(result.evidence), proposedFix: mapFix(result.proposedFix) }
        return result
      }

      // ---- verification (deep AI audit) ----
      function serializeGraphForVerify(graph, nodeIds) {
        const idSet = nodeIds ? new Set(nodeIds) : null
        const nodes = (graph.nodes || [])
          .filter((n) => n && (!idSet || idSet.has(n.id)))
          .map((n) => ({
            id: n.id,
            type: n.type,
            text: String(n.text || '').slice(0, 200),
            quote: String(n.quote || '').slice(0, 300),
            paragraph: n.paragraph,
          }))
        const ids = new Set(nodes.map((n) => n.id))
        const edges = (graph.edges || [])
          .filter((e) => e && ids.has(e.fromNodeId) && ids.has(e.toNodeId))
          .map((e) => ({ fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, relation: e.relation }))
        return { summary: graph.summary || '', nodes, edges }
      }
      function buildVerifyBatches(paras, graph) {
        const pBatches = buildBatchesByParagraph(paras, 2500)
        let batches = pBatches.map((batch) => {
           const units = Array.isArray(batch) ? batch : batch.units
          const pSet = new Set(units.map((u) => u.num))
          const nodes = (graph.nodes || []).filter((n) => n && Number.isInteger(n.paragraph) && pSet.has(n.paragraph))
          return { units, pSet, nodes, chunkId: batch.chunkId || null }
        })
        if (batches.some((batch) => batch.nodes.length > 0)) batches = batches.filter((batch) => batch.nodes.length > 0)
        // Nodes without a usable paragraph join the first batch so they are
        // still audited instead of silently skipped.
        const orphan = (graph.nodes || []).filter((n) => n && !(Number.isInteger(n.paragraph) && n.paragraph >= 0 && n.paragraph < paras.length))
        if (orphan.length > 0) {
          if (batches.length === 0) batches.push({ units: [], pSet: new Set(), nodes: [] })
          batches[0].nodes = batches[0].nodes.concat(orphan)
        }
        // Keep each batch small enough that the judge's JSON cannot hit the
        // model output limit even when every node produces an issue.
        const final = []
        for (const b of batches) {
          const nodes = b.nodes || []
          if (nodes.length <= 12) { final.push(b); continue }
          for (let i = 0; i < nodes.length; i += 12) {
            final.push({ units: i === 0 ? b.units : [], pSet: b.pSet, nodes: nodes.slice(i, i + 12) })
          }
        }
        return final
      }
      function sanitizeEvidence(rawEvidence, sourceText, totalParagraphs, allowEmpty) {
        const out = []
        for (const ev of Array.isArray(rawEvidence) ? rawEvidence : []) {
          if (!ev || typeof ev !== 'object') continue
          let paragraph = null
          if (ev.paragraph != null) {
            const num = Number(String(ev.paragraph).trim())
            if (isFinite(num) && num >= 0 && num < totalParagraphs && Math.floor(num) === num) paragraph = num
          }
          let quote = typeof ev.quote === 'string' ? ev.quote.trim().slice(0, 600) : ''
          if (quote && resolveAnchorHost(quote, sourceText) == null) quote = ''
          if (paragraph == null && !quote) continue
          out.push({ paragraph, quote })
        }
        return allowEmpty || out.length > 0 ? out : null
      }
      function sanitizeFix(fix, graph, totalParagraphs) {
        if (!fix || typeof fix !== 'object') return { action: 'none' }
        const action = VERIFY_FIX_ACTIONS.has(fix.action) ? fix.action : 'none'
        const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []
        const ids = new Set(nodes.map((n) => n && n.id))
        const cleanNodePatch = (p) => {
          if (!p || typeof p !== 'object') return null
          const id = typeof p.id === 'string' ? p.id : ''
          const patch = p.patch && typeof p.patch === 'object' ? p.patch : {}
          const clean = {}
          if (patch.type != null) {
            const t = TYPE_ALIASES[typeof patch.type === 'string' ? patch.type.trim().toLowerCase() : '']
            if (t) clean.type = t
          }
          if (typeof patch.text === 'string') clean.text = patch.text.trim().slice(0, 500)
          if (typeof patch.quote === 'string') clean.quote = patch.quote.trim().slice(0, 600)
          if (patch.paragraph != null) {
            const num = Number(String(patch.paragraph).trim())
            if (isFinite(num) && num >= 0 && num < totalParagraphs && Math.floor(num) === num) clean.paragraph = num
          }
          return { id, patch: clean }
        }
        const cleanEdgePatch = (p) => {
          if (!p || typeof p !== 'object') return null
          const from = typeof p.fromNodeId === 'string' ? p.fromNodeId : ''
          const to = typeof p.toNodeId === 'string' ? p.toNodeId : ''
          const relation = REL_ALIASES[typeof p.relation === 'string' ? p.relation.trim().toLowerCase() : '']
          if (!from || !to || !ids.has(from) || !ids.has(to) || !relation) return null
          const out = { fromNodeId: from, toNodeId: to, relation }
          if (typeof p.index === 'number' && p.index >= 0) out.index = p.index
          return out
        }
        const clean = { action }
        if (action === 'update_node' || action === 'delete_node') {
          const p = cleanNodePatch(fix.nodePatch)
          if (!p || !p.id || !ids.has(p.id)) return { action: 'none' }
          clean.nodePatch = p
        } else if (action === 'merge_nodes') {
          const p = cleanNodePatch(fix.nodePatch)
          const into = typeof fix.mergeIntoId === 'string' ? fix.mergeIntoId : ''
          if (!p || !p.id || !ids.has(p.id) || !into || !ids.has(into) || p.id === into) return { action: 'none' }
          clean.nodePatch = p
          clean.mergeIntoId = into
        } else if (action === 'add_node') {
          const p = cleanNodePatch(fix.nodePatch)
          if (p && p.id && (ids.has(p.id) || !/^n\d+$/.test(p.id))) delete p.id
          if (!p || !p.patch.type || !p.patch.text) return { action: 'none' }
          clean.nodePatch = p
        } else if (action === 'update_edge' || action === 'delete_edge' || action === 'add_edge') {
          const p = cleanEdgePatch(fix.edgePatch)
          if (!p) return { action: 'none' }
          clean.edgePatch = p
        } else if (action === 'update_summary') {
          if (typeof fix.summaryPatch === 'string' && fix.summaryPatch.trim()) clean.summaryPatch = fix.summaryPatch.trim().slice(0, 500)
          else if (typeof fix.nodePatch === 'object' && typeof fix.nodePatch.patch === 'object' && typeof fix.nodePatch.patch.text === 'string') clean.summaryPatch = fix.nodePatch.patch.text.slice(0, 500)
          else return { action: 'none' }
        }
        return clean
      }
      function normalizeIssues(obj, graph, sourceText, totalParagraphs, warnings, idPrefix) {
        const issues = []
        const seen = new Set()
        for (const raw of Array.isArray(obj && obj.issues) ? obj.issues : []) {
          if (!raw || typeof raw !== 'object') { warnings.push('verify_issue_dropped:not_object'); continue }
          const severity = ISSUE_SEVERITIES.has(raw.severity) ? raw.severity : 'warning'
          const category = ISSUE_CATEGORIES.has(raw.category) ? raw.category : 'other'
          const targetKind = raw.targetKind === 'node' || raw.targetKind === 'edge' ? raw.targetKind : 'graph'
          const targetId = targetKind === 'graph' ? null : (typeof raw.targetId === 'string' ? raw.targetId.trim() : '')
          const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []
          const nodeIds = new Set(nodes.map((n) => n && n.id))
          let edgeExists = false
          if (targetKind === 'edge' && targetId) {
            const parts = targetId.split('>')
            if (parts.length === 2 && nodeIds.has(parts[0]) && nodeIds.has(parts[1])) {
              edgeExists = (graph.edges || []).some((e) => e && e.fromNodeId === parts[0] && e.toNodeId === parts[1])
            } else if (/^\d+$/.test(targetId)) {
              edgeExists = Number(targetId) < (graph.edges || []).length
            }
          }
          if (targetKind === 'node' && !nodeIds.has(targetId)) { warnings.push('verify_issue_dropped:missing_target:' + idPrefix + raw.id); continue }
          if (targetKind === 'edge' && !edgeExists) { warnings.push('verify_issue_dropped:missing_edge:' + idPrefix + raw.id); continue }
          const evidence = sanitizeEvidence(raw.evidence, sourceText, totalParagraphs, category === 'completeness' || category === 'summary')
          if (evidence == null) { warnings.push('verify_issue_dropped:no_evidence:' + idPrefix + raw.id); continue }
          let confidence = Number(raw.confidence)
          if (!isFinite(confidence)) confidence = 0.5
          confidence = Math.min(Math.max(confidence, 0), 1)
          if (confidence < 0.7) { warnings.push('verify_issue_dropped:low_confidence:' + idPrefix + raw.id); continue }
          const id = (idPrefix || 'v') + (typeof raw.id === 'string' ? raw.id : issues.length + 1)
          if (seen.has(id)) { warnings.push('verify_issue_dropped:duplicate_id:' + id); continue }
          seen.add(id)
          issues.push({
            id,
            source: 'ai',
            severity,
            category,
            targetKind,
            targetId,
            title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '未命名问题',
            detail: typeof raw.detail === 'string' ? raw.detail.trim().slice(0, 1000) : '',
            evidence,
            confidence,
            proposedFix: sanitizeFix(raw.proposedFix, graph, totalParagraphs),
            status: 'open',
          })
        }
        return { issues }
      }
      function buildVerifierUserText(candidates, units) {
        let s = '候选问题列表（JSON）：' + NL + JSON.stringify(candidates.map((c) => ({ id: c.id, severity: c.severity, category: c.category, title: c.title, detail: c.detail, evidence: c.evidence }))) + NL
        s += NL + '相关原文段落：' + NL
        for (const u of units) s += '[P' + u.num + '] ' + u.text + NL
        return s
      }
      function verifyCandidates(model, candidates, units, warnings) {
        return callModel(model, VERIFIER_SYSTEM_PROMPT, buildVerifierUserText(candidates, units), 240000, 0.1, 8000).then((raw) => {
          const obj = raw && typeof raw === 'object' ? raw : parseJson(raw)
          const kept = new Set()
          for (const k of Array.isArray(obj.kept) ? obj.kept : []) {
            if (k && typeof k.id === 'string') kept.add(k.id)
          }
          return candidates.filter((c) => kept.has(c.id))
        }).catch((e) => {
          warnings.push('verify_confirm_failed:' + (e && e.message ? e.message : String(e)))
          return candidates
        })
      }
      function mergeReportIssues(localReport, aiIssues) {
        const issues = []
        const seen = new Set()
        for (const it of (localReport ? localReport.issues : []).concat(aiIssues || [])) {
          const key = it.category + '|' + it.targetKind + '|' + it.targetId + '|' + it.title
          if (seen.has(key)) continue
          seen.add(key)
          issues.push(it)
        }
        const order = { error: 0, warning: 1, suggestion: 2 }
        issues.sort((x, y) => (order[x.severity] - order[y.severity]) || (y.confidence - x.confidence))
        return issues
      }
      async function runVerifyTask(task) {
        if (task.cancelled) return failTask(task, 'cancelled', '任务已取消')
        task.cancelHooks = []
        task.progress = { stage: '准备审校', charsReceived: 0, updatedAt: Date.now() }
        activeTask = task
        try {
          const model = task.model || ((hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check') ? null : await resolveModel())
          if (!model && !(hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check')) {
            const warning = task.progress && task.progress.warning ? '（' + task.progress.warning + '）' : ''
            return failTask(task, 'no_model', '当前环境没有可用的 AI 模型，请先设置模型后重试' + warning)
          }
          if (model) announceModel(task, model)
          const paras = splitParagraphsHost(task.text)
          const totalParagraphs = paras.length
          const local = buildLocalReport(task.graph, task.text)
          const batches = buildVerifyBatches(paras, task.graph)
          const aiIssues = []
           const resumeFromBatch = 0
          const warnings = []
          for (let i = resumeFromBatch; i < batches.length; i++) {
            const batch = batches[i]
            const userText = buildVerifyUserText2(batch, i, batches.length, task.graph)
            let norm = null
            let lastErr = ''
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const raw = await callModel(model, VERIFY_SYSTEM_PROMPT, userText, 360000, 0.1, 12000)
                const obj = raw && typeof raw === 'object' ? raw : parseJson(raw)
                const r = normalizeIssues(obj, task.graph, task.text, totalParagraphs, warnings, 'b' + (i + 1) + ':')
                if (r.error) { lastErr = r.error; continue }
                norm = r
                break
              } catch (e) {
                if (e && e.code === 'cancelled') throw e
                if (e && e.code === 'timeout') { lastErr = '超时'; break }
                lastErr = e && e.message ? e.message : String(e)
              }
            }
            if (!norm) return failTask(task, 'schema_invalid', 'AI 审校结果无法解析（第 ' + (i + 1) + '/' + batches.length + ' 批，已自动重试）：' + lastErr)
            let kept = norm.issues
            if (task.mode === 'standard' && kept.length > 0) {
              kept = await verifyCandidates(model, kept, batch.units, warnings)
            }
            for (const it of kept) aiIssues.push(it)
          }
          const issues = mergeReportIssues(local, aiIssues)
          const counts = { error: 0, warning: 0, suggestion: 0 }
          for (const it of issues) counts[it.severity] += 1
          task.status = 'succeeded'
          task.finishedAt = Date.now()
          const report = {
            reportId: 'vd-' + Date.now().toString(36) + '-' + task.id,
            mode: task.mode === 'standard' ? 'standard' : 'quick',
            createdAt: Date.now(),
            model,
            scope: task.scope || { kind: 'full', ids: [] },
            summary: 'AI 深度审校完成：' + counts.error + ' 个错误、' + counts.warning + ' 个警告、' + counts.suggestion + ' 条建议（已叠加本地规则检查）。',
            metrics: { ...local.metrics, errorCount: counts.error, warningCount: counts.warning, suggestionCount: counts.suggestion },
            warnings,
            issues,
          }
          task.result = mapVerificationResultHost(report, task.paragraphMap)
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] verification failed:', e)
          if (e && e.code === 'cancelled') failTask(task, 'cancelled', '任务已取消')
          else if (e && e.code === 'timeout') failTask(task, 'timeout', 'AI 审校超时，请稍后重试')
          else failTask(task, 'failed', 'AI 审校失败：' + msg)
        }
      }

      // buildVerifyUserText2 includes the batch's own subgraph (nodes plus the
      // edges whose BOTH endpoints are in the batch). Cross-batch edges are
      // reviewed in the batch that owns the other endpoint.
      function buildVerifyUserText2(batch, index, total, graph) {
        const ids = new Set((batch.nodes || []).map((n) => n.id))
        const sub = serializeGraphForVerify(graph, ids)
        let s = '资料原文（已按内容切分并编号，[P数字] 为该内容单元编号）' + (total > 1 ? '（第 ' + (index + 1) + '/' + total + ' 批，只审校本批涉及的节点与边）' : '') + '：' + NL
        for (const u of batch.units) s += '[P' + u.num + '] ' + u.text + NL
        s += NL + '待审校知识图子图（JSON，包含本批节点及它们与图中其他节点的边）：' + NL + JSON.stringify(sub)
        return s
      }

      function buildQuestionContext(graph, sourceText, target, question) {
        const paras = splitParagraphsOffsetsHost(sourceText || '')
        const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []
        const nodeById = new Map(nodes.map((n) => [n.id, n]))
        let pSet = new Set()
        if (target && target.kind === 'node' && nodeById.has(target.id)) {
          const n = nodeById.get(target.id)
          let p = Number.isInteger(n.paragraph) && n.paragraph >= 0 && n.paragraph < paras.length ? n.paragraph : null
          if (p == null && n.quote) {
            const off = resolveAnchorHost(n.quote, sourceText || '', n.text)
            p = off != null ? paragraphIndexOfOffset(paras, off) : null
          }
          if (p != null) { pSet.add(Math.max(0, p - 1)); pSet.add(p); pSet.add(Math.min(paras.length - 1, p + 1)) }
        } else if (target && target.kind === 'edge' && target.id) {
          const parts = target.id.split('>')
          for (const id of parts) {
            const n = nodeById.get(id)
            if (n && Number.isInteger(n.paragraph) && n.paragraph >= 0 && n.paragraph < paras.length) pSet.add(n.paragraph)
          }
        } else {
          // Graph-level question: include as many paragraphs as fit.
          let len = 0
          for (let i = 0; i < paras.length && len < 5000; i++) {
            pSet.add(i)
            len += paras[i].text.length + 1
          }
        }
        const subNodes = nodes.filter((n) => n && (nodeById.get(n.id) && (n.paragraph == null || pSet.has(n.paragraph) || (target && (n.id === target.id || (target.kind === 'edge' && target.id && target.id.split('>').includes(n.id)))))))
        const subIds = new Set(subNodes.map((n) => n.id))
        const sub = {
          summary: graph.summary || '',
          nodes: subNodes.map((n) => ({ id: n.id, type: n.type, text: String(n.text || '').slice(0, 200), quote: String(n.quote || '').slice(0, 300), paragraph: n.paragraph })),
          edges: (graph.edges || []).filter((e) => e && subIds.has(e.fromNodeId) && subIds.has(e.toNodeId)).map((e) => ({ fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, relation: e.relation })),
        }
        return { paras, pSet, sub }
      }
      function normalizeQuestionResult(obj, graph, sourceText, totalParagraphs, warnings) {
        const verdict = ['supported', 'contradicted', 'insufficient', 'out_of_scope'].includes(obj && obj.verdict) ? obj.verdict : 'insufficient'
        const answer = typeof obj.answer === 'string' ? obj.answer.trim().slice(0, 2000) : ''
        const evidence = sanitizeEvidence(obj && obj.evidence, sourceText, totalParagraphs, true) || []
        return {
          verdict,
          answer,
          evidence,
          proposedFix: sanitizeFix(obj && obj.proposedFix, graph, totalParagraphs),
          warnings,
        }
      }
      async function runQuestionTask(task) {
        if (task.cancelled) return failTask(task, 'cancelled', '任务已取消')
        task.cancelHooks = []
        task.progress = { stage: '准备答疑', charsReceived: 0, updatedAt: Date.now() }
        activeTask = task
        try {
          const model = task.model || ((hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check') ? null : await resolveModel())
          if (!model && !(hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check')) {
            const warning = task.progress && task.progress.warning ? '（' + task.progress.warning + '）' : ''
            return failTask(task, 'no_model', '当前环境没有可用的 AI 模型，请先设置模型后重试' + warning)
          }
          if (model) announceModel(task, model)
          const ctx2 = buildQuestionContext(task.graph, task.text, task.target, task.question)
          const units = []
          const sorted = Array.from(ctx2.pSet).sort((a, b) => a - b)
          for (const p of sorted) {
            if (p >= 0 && p < ctx2.paras.length) units.push({ num: p, text: ctx2.paras[p].text })
          }
          let userText = '用户质疑/问题：' + task.question + NL
          userText += NL + '目标：' + (task.target && task.target.kind === 'node' ? '节点 ' + task.target.id : task.target && task.target.kind === 'edge' ? '关系 ' + task.target.id : '整张图') + NL
          userText += NL + '相关原文段落：' + NL
          for (const u of units) userText += '[P' + u.num + '] ' + u.text + NL
          userText += NL + '相关知识图子图（JSON）：' + NL + JSON.stringify(ctx2.sub)
          let norm = null
          let lastErr = ''
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const raw = await callModel(model, QUESTION_SYSTEM_PROMPT, userText, 180000)
              const obj = raw && typeof raw === 'object' ? raw : parseJson(raw)
              const r = normalizeQuestionResult(obj, task.graph, task.text, ctx2.paras.length, [])
              if (r.error) { lastErr = r.error; continue }
              norm = r
              break
            } catch (e) {
              if (e && e.code === 'timeout') { lastErr = '超时'; break }
              lastErr = e && e.message ? e.message : String(e)
            }
          }
          if (!norm) return failTask(task, 'schema_invalid', 'AI 质疑回答无法解析（已自动重试）：' + lastErr)
          task.status = 'succeeded'
          task.finishedAt = Date.now()
          const result = {
            reportId: 'vq-' + Date.now().toString(36) + '-' + task.id,
            mode: 'question',
            createdAt: Date.now(),
            model,
            scope: task.scope || { kind: task.target ? task.target.kind : 'graph', ids: task.target ? [task.target.id] : [] },
            question: task.question,
            target: task.target || null,
            verdict: norm.verdict,
            answer: norm.answer,
            evidence: norm.evidence,
            proposedFix: norm.proposedFix,
            summary: norm.answer.slice(0, 80),
          }
          task.result = mapVerificationResultHost(result, task.paragraphMap)
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] question task failed:', e)
          if (e && e.code === 'cancelled') failTask(task, 'cancelled', '任务已取消')
          else if (e && e.code === 'timeout') failTask(task, 'timeout', 'AI 质疑回答超时，请稍后重试')
          else failTask(task, 'failed', 'AI 质疑回答失败：' + msg)
        }
      }

      // ---- external fact-checking (source text vs outside evidence) ----
      const FACT_VERDICTS = new Set(['supported', 'contradicted', 'partially_supported', 'insufficient', 'unverifiable', 'out_of_scope'])
      const FACT_KINDS = new Set(['fact', 'inference', 'rule', 'definition', 'counter_example'])
      const FACT_CHECKWORTHY = { fact: 0.9, counter_example: 0.9, rule: 0.85, definition: 0.75, inference: 0.6 }
      function stripHtmlHost(s) {
        return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      }
      function buildExternalClaims(graph, sourceText, maxClaims) {
        const cap = typeof maxClaims === 'number' && maxClaims > 0 ? maxClaims : 60
        const paras = splitParagraphsOffsetsHost(sourceText || '')
        const claims = []
        for (const n of (graph && Array.isArray(graph.nodes) ? graph.nodes : [])) {
          if (!n || typeof n.id !== 'string' || !FACT_KINDS.has(n.type)) continue
          const text = typeof n.text === 'string' ? n.text.trim() : ''
          if (!text) continue
          let paragraph = Number.isInteger(n.paragraph) && n.paragraph >= 0 && n.paragraph < paras.length ? n.paragraph : null
          if (paragraph == null && n.quote) {
            const off = resolveAnchorHost(n.quote, sourceText || '', text)
            paragraph = off != null ? paragraphIndexOfOffset(paras, off) : null
          }
          const quote = (typeof n.quote === 'string' && n.quote.trim() ? n.quote : text).trim().slice(0, 300)
          claims.push({
            id: 'c' + (claims.length + 1),
            nodeId: n.id,
            kind: n.type,
            paragraph,
            quote,
            claim: quote,
            checkworthy: FACT_CHECKWORTHY[n.type] || 0.6,
            status: 'open',
          })
          if (claims.length >= cap) break
        }
        return claims
      }
      async function fetchWikipediaEvidence(query, maxResults) {
        if (typeof fetch !== 'function') return []
        const cap = Math.min(typeof maxResults === 'number' && maxResults > 0 ? maxResults : 4, 5)
        for (const lang of ['zh', 'en']) {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 8000)
          try {
            const params = new URLSearchParams({
              action: 'query', list: 'search', srsearch: query, srlimit: String(cap),
              format: 'json', utf8: '1', origin: '*',
            })
            const res = await fetch('https://' + lang + '.wikipedia.org/w/api.php?' + params.toString(), { signal: controller.signal })
            if (!res.ok) continue
            const data = await res.json()
            const hits = data && data.query && Array.isArray(data.query.search) ? data.query.search : []
            if (hits.length === 0) continue
            return hits.slice(0, cap).map((h, i) => ({
              id: 'w' + (i + 1),
              provider: 'wikipedia',
              url: 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(String(h.title || '').replace(/ /g, '_')),
              title: String(h.title || ''),
              snippet: stripHtmlHost(h.snippet).slice(0, 600),
              domainAuthority: 4,
            }))
          } catch (e) {
            /* try next language / give up silently */
          } finally {
            clearTimeout(timer)
          }
        }
        return []
      }
      function buildRulesEvidence(rulesText) {
        const rules = String(rulesText || '').trim()
        if (!rules) return []
        return splitParagraphsHost(rules).slice(0, 30).map((t, i) => ({
          id: 'r' + (i + 1),
          provider: 'rules',
          url: null,
          title: '用户规则 ' + (i + 1),
          snippet: t.slice(0, 600),
          domainAuthority: 3,
        }))
      }
      function buildFactJudgeUserText(claims, evidenceList, summary) {
        let s = '知识图摘要：' + (summary || '（无）') + NL
        s += NL + '待核查声明列表（JSON）：' + NL + JSON.stringify(claims.map((c) => ({ id: c.id, kind: c.kind, claim: c.claim, paragraph: c.paragraph })))
        s += NL + '证据列表（JSON，evidenceId 是唯一可引用标识）：' + NL + JSON.stringify(evidenceList)
        return s
      }
      function normFactText(s) { return String(s || '').replace(/\s+/g, '') }
      function normalizeFactVerdicts(obj, claims, evidenceById, mode, warnings) {
        const byId = new Map(claims.map((c) => [c.id, c]))
        const out = []
        for (const raw of Array.isArray(obj && obj.verdicts) ? obj.verdicts : []) {
          if (!raw || typeof raw !== 'object') { warnings.push('fact_verdict_dropped:not_object'); continue }
          const claim = byId.get(String(raw.claimId || ''))
          if (!claim) { warnings.push('fact_verdict_dropped:missing_claim:' + raw.claimId); continue }
          let verdict = FACT_VERDICTS.has(raw.verdict) ? raw.verdict : 'insufficient'
          let confidence = Number(raw.confidence)
          if (!isFinite(confidence)) confidence = 0.5
          confidence = Math.min(Math.max(confidence, 0), 1)
          let evidence = []
          const evidenceIds = Array.isArray(raw.evidenceIds) ? raw.evidenceIds.map(String) : []
          for (const id of evidenceIds) {
            const ev = evidenceById.get(id)
            if (ev && !evidence.some((x) => x.id === ev.id)) evidence.push(ev)
          }
          let evidenceQuote = typeof raw.evidenceQuote === 'string' ? raw.evidenceQuote.trim().slice(0, 400) : ''
          if (mode === 'deep') {
            if (evidenceQuote) {
              const q = normFactText(evidenceQuote)
              const found = evidence.some((ev) => normFactText(ev.snippet).includes(q))
              if (!found) {
                warnings.push('fact_evidence_quote_not_found:' + claim.id)
                evidenceQuote = ''
              }
            }
            const needsEvidence = verdict === 'supported' || verdict === 'contradicted' || verdict === 'partially_supported'
            if (needsEvidence && evidence.length === 0) {
              warnings.push('fact_verdict_downgraded_no_evidence:' + claim.id)
              verdict = 'insufficient'
            } else if (needsEvidence && !evidenceQuote) {
              warnings.push('fact_verdict_downgraded_no_quote:' + claim.id)
              verdict = 'insufficient'
            }
          } else {
            // Quick mode is model knowledge only: cap confidence and never
            // claim "partially_supported" without evidence.
            confidence = Math.min(confidence, 0.6)
            if (verdict === 'partially_supported' || verdict === 'out_of_scope') verdict = 'insufficient'
            evidence = []
            evidenceQuote = ''
          }
          out.push({
            ...claim,
            verdict,
            confidence,
            rationale: typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, 1000) : '',
            correction: typeof raw.correction === 'string' ? raw.correction.trim().slice(0, 500) : '',
            evidence,
            evidenceQuote,
            status: 'open',
          })
        }
        for (const claim of claims) {
          if (!out.some((c) => c.id === claim.id)) out.push({ ...claim, verdict: 'insufficient', confidence: 0, rationale: '模型未返回该声明的裁决', correction: '', evidence: [], evidenceQuote: '', status: 'open' })
        }
        return out
      }
      async function runFactCheckTask(task) {
        if (task.cancelled) return failTask(task, 'cancelled', '任务已取消')
        task.cancelHooks = []
        task.progress = { stage: '准备外部核查', charsReceived: 0, updatedAt: Date.now() }
        activeTask = task
        try {
          const model = task.model || ((hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check') ? null : await resolveModel())
          if (!model && !(hasKgExtractor && task.kind !== 'verify' && task.kind !== 'question' && task.kind !== 'fact-check')) {
            const warning = task.progress && task.progress.warning ? '（' + task.progress.warning + '）' : ''
            return failTask(task, 'no_model', '当前环境没有可用的 AI 模型，请先设置模型后重试' + warning)
          }
          if (model) announceModel(task, model)
          const claims = buildExternalClaims(task.graph, task.text, 60)
          if (claims.length === 0) return failTask(task, 'empty', '知识图中没有可外部核查的声明（需有事实/规则/定义/反例/推论类节点）')
          const mode = task.mode === 'deep' ? 'deep' : 'quick'
          const sources = Array.isArray(task.sources) ? task.sources : []
          const rulesEvidence = sources.includes('rules') ? buildRulesEvidence(task.rules) : []
          const finalClaims = []
          const warnings = []
          const batchSize = 10
          for (let i = 0; i < claims.length; i += batchSize) {
            const batch = claims.slice(i, i + batchSize)
            const evidenceById = new Map()
            if (mode === 'deep') {
              for (const r of rulesEvidence) evidenceById.set(r.id, r)
              for (const c of batch) {
                if (!sources.includes('wikipedia')) continue
                const evs = await fetchWikipediaEvidence(c.claim.slice(0, 120), 4)
                for (const ev of evs) {
                  const id = c.id + ':' + ev.id
                  const withId = { ...ev, id }
                  evidenceById.set(id, withId)
                }
              }
            }
            const evidenceList = Array.from(evidenceById.values())
            const userText = buildFactJudgeUserText(batch, evidenceList, task.graph.summary || '')
            let norm = null
            let lastErr = ''
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const raw = await callModel(model, FACT_JUDGE_SYSTEM_PROMPT, userText, 240000, 0.1)
                const obj = raw && typeof raw === 'object' ? raw : parseJson(raw)
                const r = normalizeFactVerdicts(obj, batch, evidenceById, mode, warnings)
                if (r.error) { lastErr = r.error; continue }
                norm = r
                break
              } catch (e) {
                if (e && e.code === 'cancelled') throw e
                if (e && e.code === 'timeout') { lastErr = '超时'; break }
                lastErr = e && e.message ? e.message : String(e)
              }
            }
            if (!norm) return failTask(task, 'schema_invalid', 'AI 外部核查结果无法解析（已自动重试）：' + lastErr)
            for (const c of norm) finalClaims.push(c)
          }
          const counts = { supported: 0, contradicted: 0, partially_supported: 0, insufficient: 0, unverifiable: 0, out_of_scope: 0 }
          for (const c of finalClaims) {
            if (counts[c.verdict] != null) counts[c.verdict] += 1
          }
          const factualTotal = finalClaims.length - counts.unverifiable - counts.out_of_scope
          const supportedRate = factualTotal > 0 ? Math.round((counts.supported / factualTotal) * 100) : 0
          task.status = 'succeeded'
          task.finishedAt = Date.now()
          const result = {
            reportId: 'fc-' + Date.now().toString(36) + '-' + task.id,
            mode,
            createdAt: Date.now(),
            model,
            scope: task.scope || { kind: 'full', ids: [] },
            summary: '外部事实核查完成：' + counts.supported + ' 项支持 / ' + counts.contradicted + ' 项矛盾 / ' + counts.partially_supported + ' 项部分支持 / ' + counts.insufficient + ' 项证据不足 / ' + counts.unverifiable + ' 项无法核查。',
            metrics: {
              totalClaims: finalClaims.length,
              ...counts,
              supportedRate,
            },
            warnings,
            claims: finalClaims,
          }
          task.result = mapVerificationResultHost(result, task.paragraphMap)
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] fact-check failed:', e)
          if (e && e.code === 'cancelled') failTask(task, 'cancelled', '任务已取消')
          else if (e && e.code === 'timeout') failTask(task, 'timeout', 'AI 外部事实核查超时，请稍后重试')
          else failTask(task, 'failed', 'AI 外部事实核查失败：' + msg)
        }
      }

      // ---- HTTP RPC over the host webServer (persistent mode) ----
      const webServer = ctx.get('webServer')
      if (!webServer) return
      const kgHandle = async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.local')
            const pathname = url.pathname
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/extract') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先粘贴资料正文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              seq += 1
              const checkpoint = a.checkpoint && typeof a.checkpoint === 'object' ? a.checkpoint : null
               const task = {
                 id: 'kg-' + Date.now().toString(36) + '-' + seq,
                 status: 'running',
                 kind: checkpoint ? 'resume' : undefined,
                 title,
                 text,
                 documentId: typeof a.documentId === 'string' && a.documentId.trim()
                   ? a.documentId.trim().slice(0, 160)
                   : (checkpoint && typeof checkpoint.documentId === 'string' ? checkpoint.documentId.slice(0, 160) : ''),
                 checkpoint,
                 existing: checkpoint && checkpoint.graph && typeof checkpoint.graph === 'object' ? checkpoint.graph : null,
                 paragraphOffset: checkpoint && Number.isInteger(checkpoint.paragraphOffset) ? checkpoint.paragraphOffset : 0,
                 model,
                 createdAt: Date.now(),
               }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/document-import') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
              const pendingProvided = Object.prototype.hasOwnProperty.call(a, 'pending')
              const pendingText = pendingProvided && typeof a.pending === 'string' ? a.pending : ''
              if (!sessionId) return writeJson(res, 200, { error: { code: 'no_session', message: '缺少会话 id，无法读取附件' } })
              const sessions = ctx.get('sessions')
              const session = sessions ? sessions.get(sessionId) : undefined
              if (!session) return writeJson(res, 200, { error: { code: 'no_session', message: '找不到该会话，无法读取当前输入框附件' } })
              const collected = await collectDocumentAttachmentsHost(sessionId, session, pendingProvided ? pendingText : undefined)
              if (collected.found.length === 0) {
                return writeJson(res, 200, {
                  error: { code: 'no_attachment', message: pendingProvided ? '当前输入框没有检测到可读取的未发送附件文档，请先添加文档附件。' : '当前会话没有检测到附件文档。支持 dsh-paste-input 附件与 dsh-at-file 的 @文件引用。' },
                  warnings: collected.warnings,
                })
              }
              let text = ''
              let remaining = MAX_TEXT
              let truncated = false
              const files = []
              for (const f of collected.found) {
                const prefix = '==== 文件：' + f.name + ' ====' + NL
                const body = f.text || ''
                let part = prefix + body
                if (part.length > remaining) {
                  part = part.slice(0, remaining)
                  truncated = true
                }
                text += part + NL + NL
                remaining -= part.length + 2
                files.push({ name: f.name, path: f.path, format: f.format || 'text', bytes: f.bytes || 0, chars: body.length, warning: f.warning || null })
                if (remaining <= 0) break
              }
              const names = files.map((f) => f.name).join('、')
              const baseTitle = files.length === 1 ? files[0].name.replace(/.[^.]+$/, '') : (files.length + ' 份附件')
              const title = (baseTitle || '附件文档').slice(0, 60)
              const importManifest = buildSourceManifestHost(title, text, splitParagraphsHost(text))
              return writeJson(res, 200, {
                title,
                text,
                files,
                names,
                truncated,
                manifest: {
                  documentId: importManifest.documentId,
                  sourceId: importManifest.sourceId,
                  chars: importManifest.chars,
                  paragraphCount: importManifest.paragraphCount,
                  chunkCount: importManifest.chunkCount,
                  sectionCount: importManifest.sectionCount,
                  sections: importManifest.sections.map((section) => ({
                    id: section.id,
                    title: section.title,
                    startParagraph: section.startParagraph,
                    endParagraph: section.endParagraph,
                  })),
                },
                warnings: collected.warnings,
              })
            }
            if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/dsh-knowledge-graph/list-models') {
              const llm = ctx.get('llm')
              const providers = []
              if (llm) {
                try {
                  const list = llm.listProviders()
                  const results = await Promise.all(list.map(async (p) => {
                    try {
                      const models = await listModelsSoft(llm, p.id, 8000)
                      return { p, models: Array.isArray(models) ? models : [] }
                    } catch (e) { return null }
                  }))
                  for (const r of results) {
                    if (!r) continue
                    providers.push({
                      id: r.p.id,
                      name: r.p.name || r.p.id,
                      models: r.models.filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name || m.id })),
                    })
                  }
                } catch (e) { /* no providers */ }
              }
              let current = null
              const adm = ctx.get('agentDefaultModel')
              if (adm) {
                try {
                  const sel = await softRace(() => adm.currentSelection(), 8000)
                  if (sel && sel.provider && sel.model) current = { provider: sel.provider, model: sel.model }
                } catch (e) { /* ignore */ }
              }
              return writeJson(res, 200, { providers, current })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/candidate-list') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const options = {
                documentId: typeof a.documentId === 'string' ? a.documentId.slice(0, 160) : '',
                kind: a.kind,
                status: a.status,
                limit: Number.isInteger(a.limit) ? a.limit : 100,
              }
              try {
                const store = await getSqliteStore()
                return writeJson(res, 200, { candidates: store.listCandidates(options), source: 'sqlite' })
              } catch (error) {
                return writeJson(res, 200, { candidates: candidateRowsFromGraph(a.graph, options), source: 'fallback', warning: 'SQLite candidate store unavailable' })
              }
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/candidate-update') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const kind = a.kind === 'entity' || a.kind === 'claim' ? a.kind : ''
              const status = CANDIDATE_STATUSES.has(a.status) ? a.status : ''
              if (!kind || !status || typeof a.id !== 'string' || !a.id) return writeJson(res, 200, { error: { code: 'invalid_input', message: '候选更新缺少合法 kind、id 或 status' } })
              try {
                const store = await getSqliteStore()
                const candidate = store.updateCandidate(kind, a.id, status)
                if (!candidate) return writeJson(res, 200, { error: { code: 'not_found', message: '找不到要更新的候选' } })
                return writeJson(res, 200, { candidate, source: 'sqlite' })
              } catch (error) {
                const key = candidateKeyFromArgs(a)
                if (key) candidateReviewState.set(key, status)
                return writeJson(res, 200, { candidate: { id: a.id, kind, nodeId: a.nodeId || null, documentId: a.documentId || candidateDocumentId(a.graph), status }, source: 'fallback', warning: 'SQLite candidate store unavailable' })
              }
            }
            if (pathname === '/api/dsh-knowledge-graph/task-status' || pathname === '/api/dsh-knowledge-graph/trajectory-status') {
              const taskId = url.searchParams.get('taskId') ?? ''
               const includeCheckpoint = url.searchParams.get('includeCheckpoint') === '1'
              const t = tasks.get(taskId)
              if (!t) return writeJson(res, 200, { status: 'not_found' })
              if (t.status === 'succeeded') return writeJson(res, 200, { status: 'succeeded', result: t.result })
              if (t.status === 'cancelled') return writeJson(res, 200, { status: 'cancelled', error: { code: t.errorCode, message: t.errorMessage }, ...(includeCheckpoint && t.checkpoint ? { checkpoint: t.checkpoint } : {}) })
              if (t.status === 'failed') return writeJson(res, 200, { status: 'failed', error: { code: t.errorCode, message: t.errorMessage }, ...(includeCheckpoint && t.checkpoint ? { checkpoint: t.checkpoint } : {}) })
              return writeJson(res, 200, {
                status: 'running',
                progress: {
                  stage: t.progress && t.progress.stage ? t.progress.stage : '运行中',
                  charsReceived: t.progress ? (t.progress.charsReceived || 0) : 0,
                  elapsedMs: t.createdAt ? Date.now() - t.createdAt : 0,
                  warning: t.progress && t.progress.warning ? t.progress.warning : null,
                  model: t.progress && t.progress.model ? t.progress.model : null,
                   batch: t.progress && t.progress.batch ? t.progress.batch : null,
                   checkpoint: includeCheckpoint && t.checkpoint ? t.checkpoint : null,
                },
              })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/task-cancel') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const taskId = typeof a.taskId === 'string' ? a.taskId : ''
              const t = tasks.get(taskId)
              if (!t) return writeJson(res, 200, { status: 'not_found' })
              if (t.status !== 'running') return writeJson(res, 200, { status: t.status })
              t.cancelled = true
              if (Array.isArray(t.cancelHooks)) {
                for (const hook of t.cancelHooks) { try { hook() } catch (e) {} }
              }
              if (typeof t.abortStream === 'function') { try { t.abortStream() } catch (e) {} }
              return writeJson(res, 200, { status: 'cancelling' })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/verify-graph') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const input = prepareVerificationInputHost(a)
              const text = input.text
              const graph = input.graph
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先提供图对应的原文' } })
              if (text.length > MAX_VERIFY_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '验证资料不能超过 ' + MAX_VERIFY_TEXT + ' 字；过长追加内容请按来源单元分范围验证' } })
              if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可验证的知识图' } })
              }
              if (graph.nodes.length > MAX_VERIFY_NODES) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '知识图节点过多（' + graph.nodes.length + ' 个），请缩短内容后重试' } })
              }
              const mode = a.mode === 'standard' ? 'standard' : 'quick'
              if (mode === 'quick') {
                 const report = buildLocalReport(graph, text)
                 report.scope = input.scoped ? { kind: 'source-units', ids: input.paragraphMap.slice() } : { kind: 'full', ids: [] }
                 return writeJson(res, 200, { report: mapVerificationResultHost(report, input.paragraphMap) })
               }
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有 AI 任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'verify',
                text, graph, mode, model, paragraphMap: input.paragraphMap, scope: input.scoped ? { kind: 'source-units', ids: input.paragraphMap.slice() } : { kind: 'full', ids: [] }, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runVerifyTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] verify task crashed', e)
                failTask(task, 'failed', 'AI 审校失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/question-graph') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const input = prepareVerificationInputHost(a)
              const text = input.text
              const graph = input.graph
              const question = typeof a.question === 'string' ? a.question.trim() : ''
              if (!question) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先输入要质疑的问题' } })
              if (question.length > 600) return writeJson(res, 200, { error: { code: 'invalid_input', message: '质疑问题不能超过 600 字' } })
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先提供图对应的原文' } })
              if (text.length > MAX_VERIFY_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '验证资料不能超过 ' + MAX_VERIFY_TEXT + ' 字；过长追加内容请按来源单元分范围验证' } })
              if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可质疑的知识图' } })
              }
              if (graph.nodes.length > MAX_VERIFY_NODES) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '知识图节点过多（' + graph.nodes.length + ' 个），请缩短内容后重试' } })
              }
              const target = a.target && typeof a.target === 'object'
                ? { kind: a.target.kind === 'edge' ? 'edge' : a.target.kind === 'node' ? 'node' : 'graph', id: typeof a.target.id === 'string' ? a.target.id.trim() : null }
                : { kind: 'graph', id: null }
              if (target.kind !== 'graph' && !target.id) return writeJson(res, 200, { error: { code: 'invalid_input', message: '质疑目标缺少 id' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有 AI 任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'question',
                text, graph, target, question, model, paragraphMap: input.paragraphMap, scope: input.scoped ? { kind: 'source-units', ids: input.paragraphMap.slice() } : { kind: 'full', ids: [] }, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runQuestionTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] question task crashed', e)
                failTask(task, 'failed', 'AI 质疑回答失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/fact-check') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const input = prepareVerificationInputHost(a)
              const text = input.text
              const graph = input.graph
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先提供要核查的原文' } })
              if (text.length > MAX_VERIFY_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '验证资料不能超过 ' + MAX_VERIFY_TEXT + ' 字；过长追加内容请按来源单元分范围验证' } })
              if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可核查的知识图' } })
              }
              if (graph.nodes.length > MAX_VERIFY_NODES) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '知识图节点过多（' + graph.nodes.length + ' 个），请缩短内容后重试' } })
              }
              const mode = a.mode === 'quick' ? 'quick' : 'deep'
              const requested = Array.isArray(a.sources) ? a.sources : ['wikipedia']
              const sources = requested.filter((s) => s === 'wikipedia' || s === 'rules')
              if (mode === 'deep' && sources.length === 0) return writeJson(res, 200, { error: { code: 'invalid_input', message: '深度核查至少需要一个证据来源（wikipedia 或 rules）' } })
              const rules = typeof a.rules === 'string' ? a.rules.slice(0, 10000) : ''
              if (sources.includes('rules') && !rules.trim()) return writeJson(res, 200, { error: { code: 'invalid_input', message: '选择了规则来源，请粘贴领域规则/法条/教材内容' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有 AI 任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'fact-check',
                text, graph, mode, sources, rules, model, paragraphMap: input.paragraphMap, scope: input.scoped ? { kind: 'source-units', ids: input.paragraphMap.slice() } : { kind: 'full', ids: [] }, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runFactCheckTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] fact-check task crashed', e)
                failTask(task, 'failed', 'AI 外部事实核查失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/trajectory-append-extract') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
              const sessions = ctx.get('sessions')
              const session = sessions ? sessions.get(sessionId) : undefined
              if (!session) return writeJson(res, 200, { error: { code: 'no_session', message: '找不到该会话（可能尚未开始或已结束），请先在对话中发一条消息再试' } })
              const existing = a.existing && typeof a.existing === 'object' ? a.existing : null
              if (!existing || !Array.isArray(existing.nodes) || existing.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可追加的轨迹图，请先完成一次拆解' } })
              }
              const baseTraceText = typeof existing.traceText === 'string' ? existing.traceText : ''
              const baseTraceEvents = Array.isArray(existing.traceEvents) ? existing.traceEvents.filter((e) => e && typeof e.seq === 'number') : []
              let fromSeq = -1
              for (const ev of baseTraceEvents) if (ev.seq > fromSeq) fromSeq = ev.seq
              const newEvents = []
              for (const ev of session.events || []) {
                if (typeof ev.seq === 'number' && ev.seq > fromSeq) newEvents.push(ev)
              }
              if (newEvents.length === 0) return writeJson(res, 200, { error: { code: 'empty', message: '该会话在上次拆解后没有新事件，无需追加' } })
              const trace = serializeTrace(newEvents)
              if (!trace.traceText) return writeJson(res, 200, { error: { code: 'empty', message: '该会话还没有可拆解的轨迹内容' } })
              const paragraphOffset = baseTraceText ? splitParagraphsHost(baseTraceText).length : 0
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'trajectory-append',
                title: '', text: trace.traceText, traceText: trace.traceText, traceEvents: trace.traceEvents,
                baseTraceText, baseTraceEvents, existing, paragraphOffset, model,
                createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] trajectory append task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/append-extract') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先粘贴要追加的资料正文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '追加正文不能超过 ' + MAX_TEXT + ' 字' } })
              const existing = a.existing && typeof a.existing === 'object' ? a.existing : null
              if (!existing || !Array.isArray(existing.nodes) || existing.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可追加的已有图，请先完成一次拆分' } })
              }
              const paragraphOffset = Number.isInteger(a.paragraphOffset) && a.paragraphOffset > 0 ? a.paragraphOffset : 0
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'append',
                title, text, existing, documentId: typeof a.documentId === 'string' ? a.documentId.trim().slice(0, 160) : '', paragraphOffset, model, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] append task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/trajectory-extract') {
              const raw = await readBody(req, 4 * 1024 * 1024)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
              const sessions = ctx.get('sessions')
              const session = sessions ? sessions.get(sessionId) : undefined
              if (!session) return writeJson(res, 200, { error: { code: 'no_session', message: '找不到该会话（可能尚未开始或已结束），请先在对话中发一条消息再试' } })
              const trace = serializeTrace(session.events)
              if (!trace.traceText) return writeJson(res, 200, { error: { code: 'empty', message: '该会话还没有可拆解的轨迹内容' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'trajectory',
                title: '', text: trace.traceText, traceText: trace.traceText, traceEvents: trace.traceEvents, model,
                createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] trajectory task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            return writeJson(res, 404, { error: { code: 'not_found', message: 'unknown endpoint' } })
          } catch (error) {
            writeJson(res, 500, { error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
          }
        }
      // Extension endpoint (/dsh-kg): keep the route outside /api so the
      // browser-trust fence does not reject chrome-extension origins, but do
      // not treat Origin as optional authentication. Only the rotated CRX id
      // is allowed by default; additional origins must be explicitly opted in.
      const kgConfiguredOrigins = String(globalThis.process && globalThis.process.env && globalThis.process.env.DSH_KG_EXTENSION_ORIGINS || '')
        .split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean)
      const kgAllowedOrigins = new Set(kgConfiguredOrigins.length > 0
        ? kgConfiguredOrigins
        : ['chrome-extension://kffpcpfkpmfkicdnlckdphiplnhlbkof'])
      const kgAllowLocalOrigin = Boolean(globalThis.process && globalThis.process.env && globalThis.process.env.DSH_KG_ALLOW_LOCAL_ORIGIN === '1')
      const kgExtHandle = async (req, res) => {
        const origin = String((req.headers && req.headers.origin) || '').trim().replace(/\/$/, '')
        const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
        if (!origin || origin === 'null' || (!kgAllowedOrigins.has(origin) && !(kgAllowLocalOrigin && localOrigin))) {
          return writeJson(res, 403, { error: { code: 'forbidden', message: 'origin not allowed' } })
        }
        res.setHeader('Vary', 'Origin')
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        // Chrome 142+ Private Network Access: a public/extension context
        // calling a local server needs this preflight acknowledgement.
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
        // Rewrite the URL so the shared kgHandle router sees its native
        // /api/dsh-knowledge-graph/... paths (/dsh-kg/extract -> .../extract).
        const u = new URL(req.url ?? '/', 'http://dsh.local')
        let rewritten = u.pathname
        if (rewritten.startsWith('/dsh-kg')) {
          const rest = rewritten.replace(/^\/dsh-kg\/?/, '')
          rewritten = '/api/dsh-knowledge-graph' + (rest ? '/' + rest : '')
        }
        req.url = rewritten + u.search
        return kgHandle(req, res)
      }
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/dsh-knowledge-graph',
        handler: kgHandle,
      }), 'dsh-knowledge-graph: extract route')
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/dsh-kg',
        handler: kgExtHandle,
      }), 'dsh-knowledge-graph: extension route')
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''
    let done = false
    const onData = (chunk) => {
      data += chunk
      if (Buffer.byteLength(data, 'utf8') > limit) finish(new Error('body too large'))
    }
    const onEnd = () => finish()
    const onError = (err) => finish(err)
    const finish = (err) => {
      if (done) return
      done = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      if (err) reject(err)
      else resolve(data)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

      // Periodically purge finished tasks (kept for 2h after completion).
      ctx.interval(() => {
        const now = Date.now()
        for (const [id, t] of tasks) {
          if (t.status !== 'running' && now - t.finishedAt > 2 * 3600 * 1000) tasks.delete(id)
        }
      }, 3600 * 1000)
    }