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

export function apply(ctx) {
      const NL = String.fromCharCode(10)
      const MAX_TEXT = 20000
      // buildLocalReport performs O(n²) duplicate/contradiction scans; cap
      // verification input so a crafted request cannot block the host loop.
      const MAX_VERIFY_NODES = 800

      const SYSTEM_PROMPT = [
        '你是「知识拆解引擎」。用户会给你一段资料正文（章节、技术文档、学习笔记等），正文按段落编号（[P数字] 为该段落的编号），请把它拆解为一张知识图。',
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
        '11. 只在当前批次内建边，不要引用本批不存在的节点；每条边的方向必须符合语义（例子/反例→被支撑项，定义→被定义项，事实→推论，因→果）。',
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
        '11. 只在当前批次内建边，不要引用本批不存在的节点；每条边的方向必须符合语义（例子/反例→被支撑项，定义→被定义项，事实→推论，因→果）。',
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
        '你是「知识图审校引擎」。用户会同时给你（A）资料原文（[P数字] 为段落编号）和（B）由另一个模型生成的知识图 JSON。你的任务不是复述，而是逐节点、逐边地质疑这张图，找出与原文不符、证据不足、类型/关系不合理、自相矛盾或明显重复的内容。',
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

      // ---- paragraph splitting (must match the client exactly) ----
      function splitParagraphsHost(text) {
        const lines = text.split(NL)
        const out = []
        let para = []
        for (const line of lines) {
          if (line.trim() === '') {
            if (para.length > 0) { out.push(para.join(NL)); para = [] }
          } else {
            para.push(line)
          }
        }
        if (para.length > 0) out.push(para.join(NL))
        return out.filter((t) => t.trim().length > 0)
      }

      function buildBatchesByParagraph(paras, max) {
        const batches = []
        let cur = []
        let curLen = 0
        for (let i = 0; i < paras.length; i++) {
          const t = paras[i]
          if (curLen > 0 && curLen + t.length + 1 > max) { batches.push(cur); cur = []; curLen = 0 }
          cur.push({ num: i, text: t })
          curLen += t.length + 1
        }
        if (cur.length > 0) batches.push(cur)
        return batches
      }

      function buildUserPrompt(title, units, index, total) {
        let s = ''
        if (title) s += '资料标题：' + title + NL
        if (total > 1) s += '（这是资料的 ' + (index + 1) + '/' + total + ' 部分，请只基于本部分内容拆解，不要臆测其他部分）' + NL
        s += '资料正文（按段落编号，[P数字] 为该段落编号）：' + NL
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
      function splitParagraphsOffsetsHost(text) {
        const lines = text.split(NL)
        const out = []
        const para = []
        let offset = 0
        for (const line of lines) {
          if (line.trim() === '') {
            if (para.length > 0) {
              const t = para.join(NL)
              out.push({ text: t, start: offset - t.length - 1, end: offset - 1 })
              para.length = 0
            }
          } else {
            para.push(line)
          }
          offset += line.length + 1
        }
        if (para.length > 0) {
          const t = para.join(NL)
          out.push({ text: t, start: offset - t.length - 1, end: offset - 1 })
        }
        return out.filter((p) => p.text.trim().length > 0)
      }
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
        if (s.startsWith('```')) {
          const nl = s.indexOf('\n')
          s = s.slice(nl >= 0 ? nl + 1 : 3)
          if (s.endsWith('```')) s = s.slice(0, s.length - 3)
        }
        const start = s.indexOf('{')
        const end = s.lastIndexOf('}')
        if (start < 0 || end <= start) throw new Error('没有找到 JSON 对象')
        return JSON.parse(s.slice(start, end + 1))
      }

      function normalizeGraph(obj, totalParagraphs, extraIds) {
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

          seen.add(id)
          nodes.push({ id, type, text, quote, paragraph: pNum })
        }

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
          edges.push({ fromNodeId: from, toNodeId: to, relation })
        }

        return { summary, nodes, edges, warnings }
      }

      function mergeBatch(batch, acc, batchIndex) {
        const prefix = 'batch' + (batchIndex + 1) + ':'
        for (const w of batch.warnings) acc.warnings.push(prefix + w)
        for (const node of batch.nodes) {
          if (!acc.nodes.has(node.id)) acc.nodes.set(node.id, node)
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
      async function resolveModelInner() {
        const adm = ctx.get('agentDefaultModel')
        if (adm) {
          try {
            const sel = adm.currentSelection()
            if (sel && typeof sel.provider === 'string' && sel.provider && typeof sel.model === 'string' && sel.model) {
              return { provider: sel.provider, model: sel.model }
            }
          } catch (e) { /* fall through to llm catalog */ }
        }
        const llm = ctx.get('llm')
        if (!llm) return null
        try {
          const providers = llm.listProviders()
          for (const p of providers) {
            try {
              const models = await llm.listModels(p.id)
              if (models && models.length && models[0].id) return { provider: p.id, model: models[0].id }
            } catch (e) { /* try next provider */ }
          }
        } catch (e) { /* no providers */ }
        return null
      }
      // A hung listProviders/listModels must never leave the global `busy`
      // lock held forever. Racing the catalog against a hard timeout means the
      // task still settles as no_model and busy is released.
      async function resolveModel() {
        let disposer = null
        const timeoutP = new Promise((resolve) => {
          disposer = ctx.timeout(() => resolve(null), 10000)
        })
        try {
          return await Promise.race([resolveModelInner(), timeoutP])
        } finally {
          if (disposer) disposer()
        }
      }

      async function callModel(model, system, userText, timeoutMs, temperature) {
        const llm = ctx.get('llm')
        if (!llm) {
          const err = new Error('模型服务不可用')
          err.code = 'llm_unavailable'
          throw err
        }
        let out = ''
        let timedOut = false
        const collecting = (async () => {
          const iter = llm.stream({
            provider: model.provider,
            model: model.model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
            temperature: typeof temperature === 'number' ? temperature : 0.2,
            maxTokens: 8000,
          })
          try {
            for await (const chunk of iter) {
              // After timeout the outer promise rejects, but the stream may
              // keep yielding; stop accumulating so a stuck stream cannot
              // balloon memory while the task is already failed.
              if (timedOut) continue
              if (chunk.type === 'text-delta') out += chunk.text
            }
          } finally {
            if (iter && typeof iter.return === 'function') {
              try { iter.return() } catch (e) { /* already closed */ }
            }
          }
          return out
        })()
        let disposer = null
        const timeoutP = new Promise((_resolve, reject) => {
          disposer = ctx.timeout(() => {
            timedOut = true
            const err = new Error('AI 拆分超时，请稍后重试')
            err.code = 'timeout'
            reject(err)
          }, timeoutMs)
        })
        try {
          return await Promise.race([collecting, timeoutP])
        } finally {
          if (disposer) disposer()
        }
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
      function serializeTrace(events) {
        // Keep the first events that fit under MAX_TEXT so the AI prompt stays
        // small; events and paragraphs stay 1:1 so anchors never drift.
        const cap = MAX_TEXT - 400
        const lines = []
        const meta = []
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
          meta.push({ seq: ev.seq, type: ev.type, line })
          total += len + 2
        }
        let tail = ''
        if (skipped > 0) tail = NL + NL + '（轨迹过长，已截断：后续 ' + skipped + ' 个事件未纳入拆解）'
        return { traceText: lines.join(NL + NL) + tail, traceEvents: meta }
      }

      // ---- incremental append helpers ----
      // Compact the existing graph into one line per node for the prompt.
      function serializeExistingGraph(existing, maxNodes) {
        const list = []
        const nodes = existing && Array.isArray(existing.nodes) ? existing.nodes : []
        for (const n of nodes) {
          if (!n || typeof n !== 'object') continue
          const id = typeof n.id === 'string' ? n.id.trim() : ''
          const text = typeof n.text === 'string' ? n.text.trim() : ''
          if (!id || !text) continue
          list.push(id + '|' + (typeof n.type === 'string' ? n.type : '') + '|' + text.slice(0, 60))
        }
        const cap = typeof maxNodes === 'number' && maxNodes > 0 ? maxNodes : 150
        if (list.length > cap) list.length = cap
        return list.join(NL)
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

      function failTask(task, code, message) {
        task.status = 'failed'
        task.finishedAt = Date.now()
        task.errorCode = code
        task.errorMessage = message
      }

      async function runTask(task) {
        try {
          const model = await resolveModel()
          if (!model) return failTask(task, 'no_model', '当前环境没有可用的 AI 模型，请先设置模型后重试')
          const paras = splitParagraphsHost(task.text)
          const batches = buildBatchesByParagraph(paras, 6000)
          const acc = { nodes: new Map(), edges: [], edgeKeys: new Set(), warnings: [] }
          let summary = ''
          const batchSummaries = []
          // ---- append mode: seed the accumulator with the existing graph ----
          const isAppend = task.kind === 'append' || task.kind === 'trajectory-append'
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
              })
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
              acc.edges.push({ fromNodeId: from, toNodeId: to, relation: rel })
            }
            if (typeof existing.summary === 'string' && existing.summary) summary = existing.summary
          }
          const offset = isAppend && Number.isInteger(task.paragraphOffset) && task.paragraphOffset > 0 ? task.paragraphOffset : 0
          const existingDigest = isAppend ? serializeExistingGraph(existing, 150) : ''
          const system = isTrajAppend ? TRAJ_APPEND_SYSTEM_PROMPT : (isAppend ? APPEND_SYSTEM_PROMPT : (task.kind === 'trajectory' ? TRAJ_SYSTEM_PROMPT : SYSTEM_PROMPT))
          for (let i = 0; i < batches.length; i++) {
            let userText = buildUserPrompt(task.title, batches[i], i, batches.length)
            if (existingDigest) {
              userText += NL + NL + '已有知识图节点清单（id|类型|文本，引用边时只能用这些 id）：' + NL + existingDigest
            }
            let norm = null
            let lastErr = ''
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const raw = await callModel(model, system, userText, 180000, 0.1)
                const obj = parseJson(raw)
                const r = normalizeGraph(obj, paras.length, existingIds)
                if (r.error) { lastErr = r.error; continue }
                norm = r
                break
              } catch (e) {
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
                addedIds.push(n.id)
              }
            }
            mergeBatch(norm, acc, i)
            if (norm.summary) batchSummaries.push(norm.summary)
            // Batch prompts ask for a LOCAL summary. Keep the first as a
            // fallback; multi-batch summaries are consolidated below so the
            // final summary actually covers the whole text.
            if (isAppend ? norm.summary : !summary) summary = norm.summary || summary
          }
          if (batchSummaries.length > 1) {
            try {
              const raw = await callModel(model, SUMMARY_SYSTEM_PROMPT, buildSummaryUserText(summary, batchSummaries), 60000, 0.1)
              const obj = parseJson(raw)
              if (obj && typeof obj.summary === 'string' && obj.summary.trim()) summary = obj.summary.trim()
            } catch (e) {
              // Fall back to the batch-level summary; never fail extraction
              // just because the summary-merge call failed.
              acc.warnings.push('summary_consolidation_failed:' + (e && e.message ? e.message : String(e)))
            }
          }
          const nodes = []
          acc.nodes.forEach((v) => nodes.push(v))
          if (nodes.length === 0) return failTask(task, 'empty', 'AI 没有拆出任何节点，请尝试内容更明确的资料')
          if (nodes.length > 120) return failTask(task, 'too_many_nodes', '合并后的节点过多（' + nodes.length + ' 个），请缩短追加内容后重试')
          task.status = 'succeeded'
          task.finishedAt = Date.now()
          task.result = {
            summary, nodes, edges: acc.edges, warnings: acc.warnings,
            ...task.kind === 'trajectory' ? { traceText: task.traceText, traceEvents: task.traceEvents } : {},
            ...isTrajAppend ? {
              traceText: (typeof task.baseTraceText === 'string' && task.baseTraceText ? task.baseTraceText + NL + NL : '') + task.text,
              traceEvents: [...(Array.isArray(task.baseTraceEvents) ? task.baseTraceEvents : []), ...(task.traceEvents || [])],
            } : {},
            ...isAppend ? { addedNodeIds: addedIds } : {},
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] extraction failed:', e)
          if (e && e.code === 'timeout') failTask(task, 'timeout', 'AI 拆分超时，请稍后重试')
          else failTask(task, 'failed', 'AI 拆分失败：' + msg)
        }
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
        const pBatches = buildBatchesByParagraph(paras, 4500)
        const batches = pBatches.map((units) => {
          const pSet = new Set(units.map((u) => u.num))
          const nodes = (graph.nodes || []).filter((n) => n && Number.isInteger(n.paragraph) && pSet.has(n.paragraph))
          return { units, pSet, nodes }
        })
        // Nodes without a usable paragraph join the first batch so they are
        // still audited instead of silently skipped.
        const orphan = (graph.nodes || []).filter((n) => n && !(Number.isInteger(n.paragraph) && n.paragraph >= 0 && n.paragraph < paras.length))
        if (orphan.length > 0) {
          if (batches.length === 0) batches.push({ units: [], pSet: new Set(), nodes: [] })
          batches[0].nodes = batches[0].nodes.concat(orphan)
        }
        return batches
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
        return callModel(model, VERIFIER_SYSTEM_PROMPT, buildVerifierUserText(candidates, units), 180000).then((raw) => {
          const obj = parseJson(raw)
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
        try {
          const model = task.model || await resolveModel()
          if (!model) return failTask(task, 'no_model', '当前环境没有可用的 AI 模型，请先设置模型后重试')
          const paras = splitParagraphsHost(task.text)
          const totalParagraphs = paras.length
          const local = buildLocalReport(task.graph, task.text)
          const batches = buildVerifyBatches(paras, task.graph)
          const aiIssues = []
          const warnings = []
          for (let i = 0; i < batches.length; i++) {
            const batch = batches[i]
            const userText = buildVerifyUserText2(batch, i, batches.length, task.graph)
            let norm = null
            let lastErr = ''
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const raw = await callModel(model, VERIFY_SYSTEM_PROMPT, userText, 240000)
                const obj = parseJson(raw)
                const r = normalizeIssues(obj, task.graph, task.text, totalParagraphs, warnings, 'b' + (i + 1) + ':')
                if (r.error) { lastErr = r.error; continue }
                norm = r
                break
              } catch (e) {
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
          task.result = {
            reportId: 'vd-' + Date.now().toString(36) + '-' + task.id,
            mode: task.mode === 'standard' ? 'standard' : 'quick',
            createdAt: Date.now(),
            model,
            scope: { kind: 'full', ids: [] },
            summary: 'AI 深度审校完成：' + counts.error + ' 个错误、' + counts.warning + ' 个警告、' + counts.suggestion + ' 条建议（已叠加本地规则检查）。',
            metrics: { ...local.metrics, errorCount: counts.error, warningCount: counts.warning, suggestionCount: counts.suggestion },
            warnings,
            issues,
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] verification failed:', e)
          if (e && e.code === 'timeout') failTask(task, 'timeout', 'AI 审校超时，请稍后重试')
          else failTask(task, 'failed', 'AI 审校失败：' + msg)
        }
      }

      // buildVerifyUserText2 includes the batch's own subgraph (nodes plus the
      // edges whose BOTH endpoints are in the batch). Cross-batch edges are
      // reviewed in the batch that owns the other endpoint.
      function buildVerifyUserText2(batch, index, total, graph) {
        const ids = new Set((batch.nodes || []).map((n) => n.id))
        const sub = serializeGraphForVerify(graph, ids)
        let s = '资料原文（按段落编号，[P数字] 为该段落编号）' + (total > 1 ? '（第 ' + (index + 1) + '/' + total + ' 批，只审校本批涉及的节点与边）' : '') + '：' + NL
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
        try {
          const model = task.model || await resolveModel()
          if (!model) return failTask(task, 'no_model', '当前环境没有可用的 AI 模型，请先设置模型后重试')
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
              const obj = parseJson(raw)
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
          task.result = {
            reportId: 'vq-' + Date.now().toString(36) + '-' + task.id,
            mode: 'question',
            createdAt: Date.now(),
            model,
            scope: { kind: task.target ? task.target.kind : 'graph', ids: task.target ? [task.target.id] : [] },
            question: task.question,
            target: task.target || null,
            verdict: norm.verdict,
            answer: norm.answer,
            evidence: norm.evidence,
            proposedFix: norm.proposedFix,
            summary: norm.answer.slice(0, 80),
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] question task failed:', e)
          if (e && e.code === 'timeout') failTask(task, 'timeout', 'AI 质疑回答超时，请稍后重试')
          else failTask(task, 'failed', 'AI 质疑回答失败：' + msg)
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
              const raw = await readBody(req, 524288)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先粘贴资料正文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } })
              seq += 1
              const task = { id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', title, text, createdAt: Date.now() }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] task crashed', e)
                failTask(task, 'failed', 'AI 拆分失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (pathname === '/api/dsh-knowledge-graph/task-status' || pathname === '/api/dsh-knowledge-graph/trajectory-status') {
              const taskId = url.searchParams.get('taskId') ?? ''
              const t = tasks.get(taskId)
              if (!t) return writeJson(res, 200, { status: 'not_found' })
              if (t.status === 'succeeded') return writeJson(res, 200, { status: 'succeeded', result: t.result })
              if (t.status === 'failed') return writeJson(res, 200, { status: 'failed', error: { code: t.errorCode, message: t.errorMessage } })
              return writeJson(res, 200, { status: 'running' })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/verify-graph') {
              const raw = await readBody(req, 524288)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先提供图对应的原文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              const graph = a.graph && typeof a.graph === 'object' ? a.graph : null
              if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '当前没有可验证的知识图' } })
              }
              if (graph.nodes.length > MAX_VERIFY_NODES) {
                return writeJson(res, 200, { error: { code: 'invalid_input', message: '知识图节点过多（' + graph.nodes.length + ' 个），请缩短内容后重试' } })
              }
              const mode = a.mode === 'standard' ? 'standard' : 'quick'
              if (mode === 'quick') return writeJson(res, 200, { report: buildLocalReport(graph, text) })
              if (busy) return writeJson(res, 200, { error: { code: 'busy', message: '已有 AI 任务正在进行，请稍候再试' } })
              const model = a.model && typeof a.model === 'object' && typeof a.model.provider === 'string' && typeof a.model.model === 'string' ? a.model : null
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'verify',
                text, graph, mode, model, createdAt: Date.now(),
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
              const raw = await readBody(req, 524288)
              let payload = {}
              try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
              const a = payload && typeof payload === 'object' ? payload : {}
              const text = typeof a.text === 'string' ? a.text.trim() : ''
              const question = typeof a.question === 'string' ? a.question.trim() : ''
              if (!question) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先输入要质疑的问题' } })
              if (question.length > 600) return writeJson(res, 200, { error: { code: 'invalid_input', message: '质疑问题不能超过 600 字' } })
              if (!text) return writeJson(res, 200, { error: { code: 'invalid_input', message: '请先提供图对应的原文' } })
              if (text.length > MAX_TEXT) return writeJson(res, 200, { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } })
              const graph = a.graph && typeof a.graph === 'object' ? a.graph : null
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
                text, graph, target, question, model, createdAt: Date.now(),
              }
              tasks.set(task.id, task)
              busy = true
              Promise.resolve().then(() => runQuestionTask(task)).catch((e) => {
                console.error('[dsh-knowledge-graph] question task crashed', e)
                failTask(task, 'failed', 'AI 质疑回答失败：内部错误')
              }).finally(() => { busy = false })
              return writeJson(res, 200, { taskId: task.id })
            }
            if (req.method === 'POST' && pathname === '/api/dsh-knowledge-graph/trajectory-append-extract') {
              const raw = await readBody(req, 524288)
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
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'trajectory-append',
                title: '', text: trace.traceText, traceText: trace.traceText, traceEvents: trace.traceEvents,
                baseTraceText, baseTraceEvents, existing, paragraphOffset,
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
              const raw = await readBody(req, 524288)
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
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'append',
                title, text, existing, paragraphOffset, createdAt: Date.now(),
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
              const raw = await readBody(req, 524288)
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
              seq += 1
              const task = {
                id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', kind: 'trajectory',
                title: '', text: trace.traceText, traceText: trace.traceText, traceEvents: trace.traceEvents,
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
      // Extension endpoint (/dsh-kg): NOT under /api, so the browser-trust
      // fence does not gate it (chrome-extension origins would be rejected as
      // cross-site). The Origin check below is the no-token abuse guard.
      const kgExtHandle = async (req, res) => {
        const origin = (req.headers && req.headers.origin) || ''
        if (origin) {
          const ok = /^chrome-extension:\/\//.test(origin)
            || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
          if (!ok) return writeJson(res, 403, { error: { code: 'forbidden', message: 'origin not allowed' } })
          res.setHeader('Access-Control-Allow-Origin', origin)
          res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
          // Chrome 142+ Private Network Access: a public/extension context
          // calling a local server needs this preflight acknowledgement.
          res.setHeader('Access-Control-Allow-Private-Network', 'true')
        }
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