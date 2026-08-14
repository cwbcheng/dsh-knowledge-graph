/**
 * dsh-knowledge-graph — Host half (DSH Cordis plugin)
 *
 * Asynchronous AI extraction engine:
 *   - Splits the input into numbered paragraphs (the same algorithm the client
 *     uses, so indexes line up deterministically).
 *   - Sends the paragraphs to the configured LLM and asks it to emit a JSON
 *     knowledge graph whose every node reports the PARAGRAPH it came from
 *     ("paragraph"), which becomes the reliable anchor for two-way linking —
 *     instead of depending on the model to reproduce the source verbatim.
 *   - Long documents are processed in batches of numbered paragraphs.
 *   - Results are schema-validated, batch-merged (first node wins per id,
 *     dangling/self-loop edges dropped and reported), and typed diagnostics are
 *     surfaced rather than silently swallowing data.
 *
 * Exposes two Package-private RPC methods to the client:
 *   - "extract"      -> { taskId }  (starts an async job, returns immediately)
 *   - "task-status"  -> { status: 'running' | 'succeeded' | 'failed' | 'not_found', ... }
 *
 * This is plain JavaScript returning a Cordis Plugin. No TypeScript / JSX.
 */

export default function hostPlugin() {
  return {
    inject: ['timer'],
    apply(ctx) {
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

      function normalizeGraph(obj, totalParagraphs) {
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
          if (!seen.has(from) || !seen.has(to)) { warnings.push('edge_dropped:missing_endpoint:' + from + '->' + to); continue }
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
          for (let i = 0; i < batches.length; i++) {
            const userText = buildUserPrompt(task.title, batches[i], i, batches.length)
            let norm = null
            let lastErr = ''
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const raw = await callModel(model, task.kind === 'trajectory' ? TRAJ_SYSTEM_PROMPT : SYSTEM_PROMPT, userText, 180000)
                const obj = parseJson(raw)
                const r = normalizeGraph(obj, paras.length)
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
            mergeBatch(norm, acc, i)
            if (!summary && norm.summary) summary = norm.summary
          }
          const nodes = []
          acc.nodes.forEach((v) => nodes.push(v))
          if (nodes.length === 0) return failTask(task, 'empty', 'AI 没有拆出任何节点，请尝试内容更明确的资料')
          if (nodes.length > 120) return failTask(task, 'too_many_nodes', '拆出的节点过多（' + nodes.length + ' 个），请缩短资料后重试')
          task.status = 'succeeded'
          task.finishedAt = Date.now()
          task.result = {
            summary, nodes, edges: acc.edges, warnings: acc.warnings,
            ...task.kind === 'trajectory' ? { traceText: task.traceText, traceEvents: task.traceEvents } : {},
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          console.error('[dsh-knowledge-graph] extraction failed:', e)
          if (e && e.code === 'timeout') failTask(task, 'timeout', 'AI 拆分超时，请稍后重试')
          else failTask(task, 'failed', 'AI 拆分失败：' + msg)
        }
      }

      harness.handle('extract', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : ''
        const text = typeof a.text === 'string' ? a.text.trim() : ''
        if (!text) return { error: { code: 'invalid_input', message: '请先粘贴资料正文' } }
        if (text.length > MAX_TEXT) return { error: { code: 'invalid_input', message: '资料正文不能超过 ' + MAX_TEXT + ' 字' } }
        if (busy) return { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } }
        seq += 1
        const task = { id: 'kg-' + Date.now().toString(36) + '-' + seq, status: 'running', title, text, createdAt: Date.now() }
        tasks.set(task.id, task)
        busy = true
        Promise.resolve().then(() => runTask(task)).catch((e) => {
          console.error('[dsh-knowledge-graph] task crashed', e)
          failTask(task, 'failed', 'AI 拆分失败：内部错误')
        }).finally(() => { busy = false })
        return { taskId: task.id }
      })

      harness.handle('task-status', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const taskId = typeof a.taskId === 'string' ? a.taskId : ''
        const t = tasks.get(taskId)
        if (!t) return { status: 'not_found' }
        if (t.status === 'succeeded') return { status: 'succeeded', result: t.result }
        if (t.status === 'failed') return { status: 'failed', error: { code: t.errorCode, message: t.errorMessage } }
        return { status: 'running' }
      })

      harness.handle('trajectory-extract', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
        const sessions = ctx.get('sessions')
        const session = sessions ? sessions.get(sessionId) : undefined
        if (!session) return { error: { code: 'no_session', message: '找不到该会话（可能尚未开始或已结束），请先在对话中发一条消息再试' } }
        const trace = serializeTrace(session.events)
        if (!trace.traceText) return { error: { code: 'empty', message: '该会话还没有可拆解的轨迹内容' } }
        if (busy) return { error: { code: 'busy', message: '已有拆分任务正在进行，请稍候再试' } }
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
        return { taskId: task.id }
      })

      harness.handle('trajectory-status', async (args) => {
        const a = args && typeof args === 'object' ? args : {}
        const taskId = typeof a.taskId === 'string' ? a.taskId : ''
        const t = tasks.get(taskId)
        if (!t) return { status: 'not_found' }
        if (t.status === 'succeeded') return { status: 'succeeded', result: t.result }
        if (t.status === 'failed') return { status: 'failed', error: { code: t.errorCode, message: t.errorMessage } }
        return { status: 'running' }
      })

      // Periodically purge finished tasks (kept for 2h after completion).
      ctx.interval(() => {
        const now = Date.now()
        for (const [id, t] of tasks) {
          if (t.status !== 'running' && now - t.finishedAt > 2 * 3600 * 1000) tasks.delete(id)
        }
      }, 3600 * 1000)
    },
  }
}
