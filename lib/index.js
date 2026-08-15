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
      async function resolveModel() {
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

      async function callModel(model, system, userText, timeoutMs) {
        const llm = ctx.get('llm')
        if (!llm) {
          const err = new Error('模型服务不可用')
          err.code = 'llm_unavailable'
          throw err
        }
        let out = ''
        const collecting = (async () => {
          for await (const chunk of llm.stream({
            provider: model.provider,
            model: model.model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
            temperature: 0.2,
            maxTokens: 8000,
          })) {
            if (chunk.type === 'text-delta') out += chunk.text
          }
          return out
        })()
        let disposer = null
        const timeoutP = new Promise((_resolve, reject) => {
          disposer = ctx.timeout(() => {
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
          let line = null
          if (ev.type === 'turn/start') line = '—— 回合 ' + ev.data.turn + ' 开始 ——'
          else if (ev.type === 'turn/end') line = '—— 回合 ' + ev.data.turn + ' 结束（' + ev.data.reason + '）——'
          else if (ev.type === 'user/message') line = '用户消息：' + traceClip(traceTextOf(ev.data.content), 400)
          else if (ev.type === 'assistant/message') line = 'AI 回复：' + traceClip(traceTextOf(ev.data.message && ev.data.message.content), 600)
          else if (ev.type === 'tool/call') line = '调用工具 ' + ev.data.name + '：' + traceClip(ev.data.arguments, 200)
          else if (ev.type === 'tool/result') line = '工具结果：' + traceClip(traceTextOf(ev.data.message && ev.data.message.content), 400)
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
          // ---- append mode: seed the accumulator with the existing graph ----
          const isAppend = task.kind === 'append'
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
          const system = isAppend ? APPEND_SYSTEM_PROMPT : (task.kind === 'trajectory' ? TRAJ_SYSTEM_PROMPT : SYSTEM_PROMPT)
          for (let i = 0; i < batches.length; i++) {
            let userText = buildUserPrompt(task.title, batches[i], i, batches.length)
            if (existingDigest) {
              userText += NL + NL + '已有知识图节点清单（id|类型|文本，引用边时只能用这些 id）：' + NL + existingDigest
            }
            let norm = null
            let lastErr = ''
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const raw = await callModel(model, system, userText, 180000)
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
            if (isAppend) {
              renumberNewIds(norm, acc)
              for (const n of norm.nodes) {
                if (n.paragraph != null) n.paragraph += offset
                addedIds.push(n.id)
              }
            }
            mergeBatch(norm, acc, i)
            // append: the AI re-summarizes the WHOLE graph, so the last batch's
            // summary wins; regular batches keep first-wins.
            if (isAppend ? norm.summary : !summary) summary = norm.summary || summary
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
            ...isAppend ? { addedNodeIds: addedIds } : {},
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] extraction failed:', e)
          if (e && e.code === 'timeout') failTask(task, 'timeout', 'AI 拆分超时，请稍后重试')
          else failTask(task, 'failed', 'AI 拆分失败：' + msg)
        }
      }

      // ---- HTTP RPC over the host webServer (persistent mode) ----
      const webServer = ctx.get('webServer')
      if (!webServer) return
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/dsh-knowledge-graph',
        handler: async (req, res) => {
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
        },
      }), 'dsh-knowledge-graph: extract route')


function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''
    let done = false
    const onData = (chunk) => {
      data += chunk
      if (data.length > limit) finish(new Error('body too large'))
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
