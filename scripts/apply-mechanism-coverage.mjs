import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(label + ': source pattern not found')
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(label + ': source pattern is not unique')
  return source.slice(0, first) + after + source.slice(first + before.length)
}

const hostPath = new URL('../src/index.host.js', import.meta.url)
let host = readFileSync(hostPath, 'utf8')

host = replaceOnce(host,
`       const hasKgExtractor = typeof kgExtractor === 'function' || Boolean(kgExtractor && typeof kgExtractor.extractChunk === 'function')
       const hasKgRelationWeaver = Boolean(kgExtractor && typeof kgExtractor.weaveRelations === 'function')`,
`       const hasKgExtractor = typeof kgExtractor === 'function' || Boolean(kgExtractor && typeof kgExtractor.extractChunk === 'function')
       const hasKgCoverageReviewer = Boolean(kgExtractor && typeof kgExtractor.reviewCoverage === 'function')
       const hasKgRelationWeaver = Boolean(kgExtractor && typeof kgExtractor.weaveRelations === 'function')`,
'coverage capability')

const relationPromptMarker = `      // After every chunk has been admitted, a bounded relation-only pass may`
const relationPromptIndex = host.indexOf(relationPromptMarker)
if (relationPromptIndex < 0) throw new Error('relation prompt marker not found')
const coverageBlock = `      // The first extraction pass can be perfectly valid yet still compress a
      // multi-step mechanism into one endpoint summary. This bounded second
      // look is intentionally narrower than a second extractor: it may only
      // add source-explicit atomic nodes that the accepted batch omitted, plus
      // relations incident to those new nodes. It cannot rewrite/delete nodes
      // or optimize graph connectivity.
      const COVERAGE_SYSTEM_PROMPT = [
        '你是「知识图机制覆盖复核器」。你会收到一个原文内容块，以及已经通过确定性验收的该块知识节点。你的唯一任务是检查：首轮抽取是否把对后续“为什么/如何”问答必要的中间机制、独立后果或高知识密度例子摘要掉了。',
        '',
        '只补漏，不重做：',
        '1. 只能输出首轮图中真正缺失的新节点，以及至少一端连接这些新节点的必要关系；禁止改写、删除、合并已有节点，禁止只补已有节点之间的关系。',
        '2. 优先恢复原文明确表达的多步机制链、条件→结果、中间状态、独立可查询后果。若首轮只保留“A最终导致E”，而原文明示A→B→C→D→E，则补回对解释为什么/如何有用的B/C/D。',
        '3. 一节点一命题。不要把多个步骤再次压成一个总结节点；不要为追求完整而把每句话都建成节点。',
        '4. 多个例子同时存在时，只补能揭示机制步骤、关键区分或连接多个核心命题的例子；纯修辞、只重复已有原则的比喻优先省略。例子节点仍用 example；如果它是类比，用 analogy 关系表达其作用。',
        '5. 所有新节点和关系必须由当前编号原文直接支持。quote/evidence 必须逐字来自原文；保留“可能、多数、通常、必须、如果、不是”等限定。',
        '6. 不要因为节点孤立、图不够漂亮或边太少而补知识。原文没有缺口时返回空 nodes/edges。',
        '7. 最多补 12 个新节点。type/relation 与主抽取器完全相同。',
        '8. 只输出合法 JSON：{"nodes":[{"id":"m1","type":"claim","text":"缺失的原子命题","quote":"原文逐字摘录","paragraph":2}],"edges":[{"fromNodeId":"m1","toNodeId":"n3","relation":"causes","evidence":[{"paragraph":2,"quote":"直接证明关系的原文"}]}]}。无缺口时输出 {"nodes":[],"edges":[]}。',
      ].join(NL)

      function mechanismCoverageNeededHost(batch, graph) {
        const units = batch && Array.isArray(batch.units) ? batch.units : []
        if (units.length === 0) return false
        const cue = /(?:导致|因此|所以|于是|从而|因而|进而|继而|随后|最终|无法|依赖|变成|成为|误认为|等同|如果|一旦|只有|必须|先|再|然后|接着|直到|越来越)/g
        const nodesByParagraph = new Map()
        for (const node of graph && Array.isArray(graph.nodes) ? graph.nodes : []) {
          if (!node || !Number.isInteger(node.paragraph)) continue
          nodesByParagraph.set(node.paragraph, (nodesByParagraph.get(node.paragraph) || 0) + 1)
        }
        let mechanismUnits = 0
        let suspiciousUnits = 0
        for (const unit of units) {
          if (!unit || !Number.isInteger(unit.num)) continue
          const text = String(unit.text || '')
          const cues = text.match(cue) || []
          if (cues.length === 0) continue
          mechanismUnits += 1
          const represented = nodesByParagraph.get(unit.num) || 0
          if (represented === 0 || (cues.length >= 2 && represented <= 1)) suspiciousUnits += 1
        }
        return suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(cue) || []).length >= 2)))
      }

      function buildCoverageUserTextHost(title, batch, accepted, existingDigest) {
        let text = ''
        if (title) text += '资料标题：' + title + NL
        text += '当前编号原文：' + NL
        for (const unit of batch && Array.isArray(batch.units) ? batch.units : []) text += '[P' + unit.num + '] ' + String(unit.text || '') + NL
        text += NL + '首轮已接受节点（id|类型|段落|文本）：' + NL
        for (const node of accepted && Array.isArray(accepted.nodes) ? accepted.nodes : []) {
          text += node.id + '|' + node.type + '|P' + (Number.isInteger(node.paragraph) ? node.paragraph : '?') + '|' + String(node.text || '').slice(0, 220) + NL
        }
        if (!accepted || !Array.isArray(accepted.nodes) || accepted.nodes.length === 0) text += '（无）' + NL
        if (existingDigest) text += NL + '前文/已有图可引用节点（禁止重复创建）：' + NL + existingDigest + NL
        return text
      }

      async function repairMechanismCoverageHost(task, model, batch, accepted, acc, existingIds, existingDigest, batchContext, totalParagraphs) {
        const result = { attempted: false, addedNodes: 0, addedEdges: 0 }
        if (!mechanismCoverageNeededHost(batch, accepted)) return result
        if (!model && !hasKgCoverageReviewer) return result
        result.attempted = true
        taskStage('正在复核第 ' + ((task.progress && task.progress.batch && task.progress.batch.index) || '?') + ' 个内容块的机制覆盖…')
        try {
          const prompt = buildCoverageUserTextHost(task.title, batch, accepted, existingDigest)
          const raw = hasKgCoverageReviewer
            ? await kgExtractor.reviewCoverage({
              title: task.title,
              chunk: { ...batch, units: Array.isArray(batch.units) ? batch.units : [] },
              graph: {
                summary: accepted.summary || '',
                nodes: accepted.nodes.map(cloneGraphNodeHost),
                edges: accepted.edges.map(cloneGraphEdgeHost),
              },
              existingNodeIds: Array.from(existingIds),
              existingDigest,
              systemPrompt: COVERAGE_SYSTEM_PROMPT,
              prompt,
            })
            : await callModel(model, COVERAGE_SYSTEM_PROMPT, prompt, 120000, 0.05, 5000)
          const obj = raw && typeof raw === 'object' ? raw : parseJson(raw)
          if (!obj || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) throw new Error('机制覆盖复核结果必须包含 nodes/edges 数组')
          if (obj.nodes.length === 0) return result
          if (obj.nodes.length > 12) throw new Error('机制覆盖复核新增节点超过 12 个安全上限')
          const allowedIds = new Set([...existingIds, ...accepted.nodes.map((node) => node && node.id).filter(Boolean)])
          const repair = normalizeGraph({ summary: '', nodes: obj.nodes, edges: obj.edges }, totalParagraphs, allowedIds, batchContext)
          if (repair.error) throw new Error(repair.error)
          const knownNodes = new Map(acc.nodes)
          for (const node of accepted.nodes) if (node && node.id) knownNodes.set(node.id, node)
          renumberNewIds(repair, { nodes: knownNodes })
          const newIds = new Set(repair.nodes.map((node) => node.id))
          repair.edges = repair.edges.filter((edge) => newIds.has(edge.fromNodeId) || newIds.has(edge.toNodeId))
          let gate = validateGraphInvariantsHost(repair, task.text, {
            includeQuality: false,
            extraNodes: knownNodes,
            normalizationWarnings: repair.warnings,
          })
          const safe = applySafeInvariantRepairsHost(repair, gate, { allowEdgeDrops: true }).repairs
          if (safe.length > 0) gate = validateGraphInvariantsHost(repair, task.text, {
            includeQuality: false,
            extraNodes: knownNodes,
            normalizationWarnings: repair.warnings,
            ignoreSafeNormalizationDrops: true,
          })
          if (gate.blockingIssues.length > 0) throw new Error(formatInvariantFeedbackHost(gate.blockingIssues))
          accepted.nodes.push(...repair.nodes)
          accepted.edges.push(...repair.edges)
          for (const warning of repair.warnings) accepted.warnings.push('coverage_repair:' + warning)
          result.addedNodes = repair.nodes.length
          result.addedEdges = repair.edges.length
          return result
        } catch (error) {
          if (error && error.code === 'cancelled') throw error
          accepted.warnings.push('coverage_review_failed:' + (error && error.message ? error.message : String(error)))
          return result
        }
      }

`
host = host.slice(0, relationPromptIndex) + coverageBlock + host.slice(relationPromptIndex)

host = replaceOnce(host,
`          const generationInvariantRepairs = []
          let generationInvariantRetries = 0`,
`          const generationInvariantRepairs = []
          let generationInvariantRetries = 0
          let coverageAttemptedBatches = 0
          let coverageRepairedBatches = 0
          let coverageAddedNodes = 0
          let coverageAddedEdges = 0`,
'coverage counters')

host = replaceOnce(host,
`            // ALWAYS renumber colliding ids. Previously this only ran in append
            // mode, so multi-batch extractions (each batch restarts at n1) had
            // later-batch nodes silently dropped as duplicate ids — a serious
            // quality bug for documents longer than one batch.
            renumberNewIds(norm, acc)`,
`            if (effectiveTaskKind === 'extract' || effectiveTaskKind === 'append') {
              const coverage = await repairMechanismCoverageHost(task, model, batch, norm, acc, existingIds, existingDigest, batchContext, paras.length)
              if (coverage.attempted) coverageAttemptedBatches += 1
              if (coverage.addedNodes > 0) {
                coverageRepairedBatches += 1
                coverageAddedNodes += coverage.addedNodes
                coverageAddedEdges += coverage.addedEdges
                norm.warnings.push('coverage_repair_added:nodes=' + coverage.addedNodes + ':edges=' + coverage.addedEdges)
              }
            }
            // ALWAYS renumber colliding ids. Previously this only ran in append
            // mode, so multi-batch extractions (each batch restarts at n1) had
            // later-batch nodes silently dropped as duplicate ids — a serious
            // quality bug for documents longer than one batch.
            renumberNewIds(norm, acc)`,
'coverage insertion')

host = replaceOnce(host,
`              connectivity: relationWeave,
             grounding: {`,
`              connectivity: relationWeave,
             coverage: {
               attemptedBatches: coverageAttemptedBatches,
               repairedBatches: coverageRepairedBatches,
               addedNodes: coverageAddedNodes,
               addedEdges: coverageAddedEdges,
             },
             grounding: {`,
'coverage generation metadata')

writeFileSync(hostPath, host)

const test = `import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const coverageCalls = []
const extractor = {
  async extractChunk({ title }) {
    if (title === 'mechanism-coverage') {
      return {
        summary: '感觉驱动最终形成高消耗低回报',
        nodes: [{ id: 'n1', type: 'claim', text: '最终学得越多，负担越重，形成高消耗、低回报', quote: '最终学得越多，负担越重，形成高消耗、低回报。', paragraph: 5 }],
        edges: [],
      }
    }
    if (title === 'plain-fact') {
      return { summary: '直接事实', nodes: [{ id: 'f1', type: 'fact', text: '项目包含三个文件', quote: '项目包含三个文件。', paragraph: 0 }], edges: [] }
    }
    throw new Error('unexpected title: ' + title)
  },
  async reviewCoverage(args) {
    coverageCalls.push(args)
    assert(args.systemPrompt.includes('只补漏，不重做'), 'coverage pass is not scoped as missing-node repair')
    assert(args.systemPrompt.includes('纯修辞、只重复已有原则的比喻优先省略'), 'example selection does not prefer mechanism-bearing examples')
    assert(args.prompt.includes('首轮已接受节点'), 'coverage reviewer did not receive the accepted graph')
    return {
      nodes: [
        { id: 'm1', type: 'claim', text: '以感觉懂了驱动学习时，人无法根据明确目标判断学习是否完成', quote: '以感觉懂了驱动学习时，人无法根据明确目标判断学习是否完成。', paragraph: 0 },
        { id: 'm2', type: 'claim', text: '无法判断完成时，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束', quote: '因为无法判断是否完成，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束。', paragraph: 1 },
        { id: 'm3', type: 'claim', text: '学习者容易把记住讲解误认为学会知识', quote: '这样又容易把记住讲解误认为学会知识。', paragraph: 2 },
        { id: 'm4', type: 'claim', text: '学习者无法根据已经完成的程度接着学习', quote: '学习者因此无法根据已经完成的程度接着学习。', paragraph: 3 },
        { id: 'm5', type: 'claim', text: '复习实质上变成重新学习', quote: '于是复习实质上变成重新学习。', paragraph: 4 },
        { id: 'm6', type: 'example', text: '函数定义学习案例', quote: '第一次接触函数定义时，人会反复阅读直到感觉懂了，然后努力记住原话。', paragraph: 6 },
      ],
      edges: [
        { fromNodeId: 'm1', toNodeId: 'm2', relation: 'causes', evidence: [{ paragraph: 1, quote: '因为无法判断是否完成，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束。' }] },
        { fromNodeId: 'm2', toNodeId: 'm3', relation: 'causes', evidence: [{ paragraph: 2, quote: '这样又容易把记住讲解误认为学会知识。' }] },
        { fromNodeId: 'm3', toNodeId: 'm4', relation: 'causes', evidence: [{ paragraph: 3, quote: '学习者因此无法根据已经完成的程度接着学习。' }] },
        { fromNodeId: 'm4', toNodeId: 'm5', relation: 'causes', evidence: [{ paragraph: 4, quote: '于是复习实质上变成重新学习。' }] },
        { fromNodeId: 'm5', toNodeId: 'n1', relation: 'causes', evidence: [{ paragraph: 5, quote: '最终学得越多，负担越重，形成高消耗、低回报。' }] },
        { fromNodeId: 'm6', toNodeId: 'm3', relation: 'example', evidence: [{ paragraph: 6, quote: '第一次接触函数定义时，人会反复阅读直到感觉懂了，然后努力记住原话。' }] },
      ],
    }
  },
  async weaveRelations() { return { edges: [] } },
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({ get(name) { return name === 'kgExtractor' ? extractor : null }, interval() { return () => {} } })

async function waitTask(taskId) {
  for (let i = 0; i < 200; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const mechanismText = [
  '以感觉懂了驱动学习时，人无法根据明确目标判断学习是否完成。',
  '因为无法判断是否完成，人会依赖读几遍、抄几遍、画图等学习仪式宣告结束。',
  '这样又容易把记住讲解误认为学会知识。',
  '学习者因此无法根据已经完成的程度接着学习。',
  '于是复习实质上变成重新学习。',
  '最终学得越多，负担越重，形成高消耗、低回报。',
  '第一次接触函数定义时，人会反复阅读直到感觉懂了，然后努力记住原话。',
].join('\\n\\n')
const started = await handlers.get('extract')({ title: 'mechanism-coverage', text: mechanismText })
const completed = await waitTask(started.taskId)
assert(completed.status === 'succeeded', 'mechanism coverage extraction failed: ' + JSON.stringify(completed))
assert(coverageCalls.length === 1, 'mechanism-dense batch did not receive exactly one bounded coverage review')
assert(completed.result.nodes.length === 7, 'missing mechanism nodes were not recovered: ' + JSON.stringify(completed.result.nodes))
for (const text of ['无法根据明确目标判断学习是否完成', '依赖读几遍、抄几遍、画图等学习仪式', '记住讲解误认为学会知识', '无法根据已经完成的程度接着学习', '复习实质上变成重新学习', '函数定义学习案例']) {
  assert(completed.result.nodes.some((node) => String(node.text || '').includes(text)), 'missing recovered knowledge: ' + text)
}
const coverage = completed.result.generation && completed.result.generation.coverage
assert(coverage && coverage.attemptedBatches === 1 && coverage.repairedBatches === 1 && coverage.addedNodes === 6, 'coverage metadata is incorrect: ' + JSON.stringify(coverage))
assert(completed.result.edges.some((edge) => edge.fromNodeId === 'm5' && edge.toNodeId === 'n1' && edge.relation === 'causes'), 'recovered mechanism chain is not connected to the original endpoint')
assert(completed.result.edges.some((edge) => edge.fromNodeId === 'm6' && edge.toNodeId === 'm3' && edge.relation === 'example'), 'mechanism-bearing function example was not integrated')

const beforePlain = coverageCalls.length
const plainStart = await handlers.get('extract')({ title: 'plain-fact', text: '项目包含三个文件。' })
const plain = await waitTask(plainStart.taskId)
assert(plain.status === 'succeeded', 'plain extraction failed')
assert(coverageCalls.length === beforePlain, 'non-mechanism text triggered an unnecessary second model pass')

console.log(JSON.stringify({ ok: true, recoveredNodes: coverage.addedNodes, boundedReview: true, plainSkipped: true }))
`
writeFileSync(new URL('./kg-mechanism-coverage-smoke.mjs', import.meta.url), test)

const packagePath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
pkg.scripts['test:kg-mechanism-coverage'] = 'node scripts/kg-mechanism-coverage-smoke.mjs'
if (!pkg.scripts.test.includes('test:kg-mechanism-coverage')) {
  pkg.scripts.test = pkg.scripts.test.replace(' && npm run test:kg-semantic-contract', ' && npm run test:kg-semantic-contract && npm run test:kg-mechanism-coverage')
}
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')

const readmePath = new URL('../README.md', import.meta.url)
let readme = readFileSync(readmePath, 'utf8')
const anchor = '  - **最小语义契约**：一个节点只表达一个原子命题；作者的理论/经验概括用 `claim` 而不是 `fact`；保留“可能 / 多数 / 通常 / 必须 / 如果”等原文限定；存在更精确关系时不退化成 `supports`。'
if (!readme.includes(anchor)) throw new Error('README semantic-contract anchor not found')
readme = readme.replace(anchor, anchor + '\n  - **机制覆盖复核**：首轮抽取通过后，仅当内容块存在明显多步机制且中间步骤疑似漏拆时，执行一次受限复核；它只能补缺失原子节点及其必要关系，不能重写已有图，也不会为了连通率补知识。')
writeFileSync(readmePath, readme)

const readmeEnPath = new URL('../README.en.md', import.meta.url)
let readmeEn = readFileSync(readmeEnPath, 'utf8')
const anchorEn = '  - **Minimal semantic contract**: one node expresses one atomic proposition; source/author theories and empirical generalizations use `claim` rather than `fact`; qualifiers such as “possible / most / usually / must / if” must be preserved; use a precise semantic relation instead of falling back to `supports` when the source makes that relation explicit.'
if (!readmeEn.includes(anchorEn)) throw new Error('README.en semantic-contract anchor not found')
readmeEn = readmeEn.replace(anchorEn, anchorEn + '\n  - **Mechanism coverage review**: after a valid first pass, a second bounded review runs only when a source block contains an explicit multi-step mechanism and intermediate knowledge appears omitted. It may add missing atomic nodes and relations incident to them, but cannot rewrite the accepted graph or add knowledge merely to improve connectivity.')
writeFileSync(readmeEnPath, readmeEn)

console.log(JSON.stringify({ ok: true, patched: ['src/index.host.js', 'scripts/kg-mechanism-coverage-smoke.mjs', 'package.json', 'README.md', 'README.en.md'] }))
