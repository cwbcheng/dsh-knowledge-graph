#!/usr/bin/env node
/**
 * kg-extract.mjs — standalone "scanned PDF -> knowledge graph" pipeline.
 *
 * This closes the gap that the host plugin leaves open: the host only imports
 * a document that already has a searchable text layer, and it needs a live DSH
 * `kgExtractor` (LLM) to produce a graph. For a scanned PDF — and for running
 * the extraction without a DSH session — neither stage exists. This pipeline
 * provides both:
 *
 *   OCR (python ocr_pdf.py) -> pages JSON
 *     -> assemble source text (scripts/kg-pipeline/assemble_text.mjs)
 *     -> paragraph segmentation (paragraphs.mjs, host-identical)
 *     -> chunked LLM extraction (llm-client.mjs + repo SYSTEM_PROMPT)
 *     -> normalization (normalize.mjs, host-identical)
 *     -> graph assembly (source/sourceText/sections/staging/nodes/edges/revision)
 *     -> SQLite import (repo src/kg-store.mjs saveGraph)
 *
 * Usage:
 *   node kg-extract.mjs --pages <pages.json> --out <graph.json> [--db FILE] [--title TITLE]
 * Options:
 *   --pages       OCR pages JSON produced by ocr_pdf.py ({ "1": "text", ... })
 *   --out         output graph JSON path
 *   --import      if set, import into SQLite via kg-store (requires --db or defaultStorePath)
 *   --db          SQLite db path
 *   --title       document title
 *   --max-batches upper bound on LLM chunks (default all)
 *   --resume      resume from a partially-complete extraction JSON
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { splitParagraphs, buildSourceManifest } from './paragraphs.mjs'
import { normalizeGraph, mergeBatch } from './normalize.mjs'
import { callLLM } from './llm-client.mjs'
import { openSqliteStore } from '../../src/kg-store.mjs'

const NL = String.fromCharCode(10)

// The host's SYSTEM_PROMPT — reused verbatim so the semantic contract (8 node
// types, 12 relations, "one node one proposition", grounding, etc.) is exactly
// what the repo enforces.
const SYSTEM_PROMPT = [
  '你是「知识拆解引擎」。用户会给你一段资料正文（章节、技术文档、学习笔记等），正文已按内容切分为编号单元（一个编号单元可能含多个句子），[P数字] 为该单元编号。目标不是摘要，而是生成可复用、可继续推理的原子知识图。',
  '',
  '节点必须从以下 8 类中选择：',
  '1. fact 事实 —— 可直接观察、记录或核对的具体信息/元信息。作者的理论判断、经验概括、价值判断不得标 fact。',
  '2. claim 主张 —— 作者/资料直接提出但未在当前文本中作为客观事实核实的观点、经验概括、理论判断。必须保留“可能、多数、通常、必须、如果”等限定强度。',
  '3. inference 推论 —— 由已有事实/主张结合原文逻辑推出的可复用结论；不能只是换句话复述原句。',
  '4. concept 概念 —— 稳定、可复用的术语或明确命名对象。作者临时标签、修辞表达不得仅因显眼就升级为 concept，除非文本明确把它当作持续讨论的理论对象。被两个以上独立核心命题反复引用、可跨段/跨章节继续承载知识的明确命名对象，应保留独立 concept anchor；concept 名称优先使用稳定对象本身，不把“重建/优化/提高/建立 + 对象”整体实体化，除非该过程本身被正式命名。',
  '5. definition 定义 —— 对概念的精确界定。',
  '6. example 例子 —— 用于说明某个事实、主张、规则或概念的具体实例。',
  '7. counter_example 反例 —— 只有当一个具体案例明确削弱、限制或否定某个一般命题时使用，并应通过 counter_example 关系指向被挑战命题。负向结果、失败情形或对照情形如果仍在帮助说明/支持原命题，仍用 example，并通过 supports/analogy 表达作用。',
  '8. rule 规则 —— 方法、步骤、操作流程或明确规范。',
  '',
  '关系必须从以下 12 类中选择：',
  'supports 支持 / example 例子 / counter_example 反例 / defines 定义 / infers 推断 / causes 因果 / is_a 属于 / contains 包含 / driven_by 受驱动于 / not_is 不是 / analogy 类比说明 / aims_at 旨在',
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
  '8. type 只能取 fact/claim/inference/concept/definition/example/counter_example/rule；relation 只能取 supports/example/counter_example/defines/infers/causes/is_a/contains/driven_by/not_is/analogy/aims_at；paragraph 必须是真实编号。',
  '9. 节点 id 用 n1、n2、n3... 全局唯一；edges 的 fromNodeId/toNodeId 必须引用存在节点。',
  '10. 单批节点数最多 48 个；这是安全上限，不是压缩目标。不要为了少建节点而合并本应独立的命题。',
  '11. 每个 fact/claim/inference 节点的 text 必须由 quote 支撑，且不得删除或强化原文的可能性、数量范围、条件、否定和必要性。',
  '12. 同一稳定概念或同一原子命题只建一个节点；优先保留能跨段复用的概念和机制链，但不要把多个原子命题合成“主结论大节点”。若一个稳定对象被多个核心命题共同引用，应保留其 concept anchor，而不是只让该术语散落在命题文本里。',
  '13. 关系方向必须符合语义；每条边必须有直接证明该 relation 的原文 evidence。端点分别出现、主题相似或同段出现都不能单独证明关系。',
  '14. 与主题有关的节点可保持孤立；原文未定义的核心概念允许作为待后文展开的节点存在，禁止为了连通率强行补关系。原文明示“并非X/不是X/不意味着X/问题不在X而在Y”等纠偏时，应保留防止错误推理所必需的限定主张；原文明示某问题留待后文回答时，可用普通 claim 记录“当前范围尚未给出具体答案”，不要虚构答案。',
  '15. 高知识密度 worked example 不得只因是例子而整体省略：若例子明确命名一个可复用对象或定义，并在同段或紧邻段落用于引出具体行为、误区、机制或验证区分，至少保留能把该例子连接到后续机制的最小 example/definition/concept 锚点。纯修辞且不承载这种连接作用的例子仍可省略。',
  '16. 对以【图示关系】【表格】【统计图】标记的视觉转写，图中明确编码的节点、类别、分组、对应、包含、箭头/连线、先后顺序以及具有图例语义的颜色/形状都是候选知识，不能仅因它们表现为版面或颜色而当作装饰省略。能准确映射到允许 relation 时建立有直接 evidence 的边；若图中关系真实明确但不适合 12 种 relation，至少创建一个原子 fact/claim 节点忠实记录“谁与谁通过何种可见方式关联”，禁止整段丢弃或强行套用错误关系。纯粹位置且无图例/标签语义的 layout 仍可省略。',
  '17. 输出前自查：节点是否原子？fact/claim 是否分对？counter_example 是否真的在反驳一个命题而不是仅描述负向/对照结果？核心稳定对象是否有 concept anchor？显式纠偏或留待后文的信息是否被遗漏？高知识密度 worked example 是否被整段丢失？是否保留“可能/多数/必须/如果”等强度？是否存在比 supports 更精确的关系？证据是否真的证明节点和关系？',
].join(NL)

function buildUserPrompt(title, batch, index, total, existingDigest) {
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
  if (existingDigest) s += NL + NL + '已有知识图节点清单（id|类型|文本，引用边时只能用这些 id）：' + NL + existingDigest
  return s
}

function serializeExistingGraph(nodes, limit, batchQuery) {
  const terms = String(batchQuery || '').toLowerCase()
  // Rank nodes by overlap with the incoming batch query to keep the digest bounded.
  const ranked = (Array.isArray(nodes) ? nodes : []).slice().map((node, idx) => {
    const text = String(node.text || '').toLowerCase()
    const overlap = terms ? text.split('').reduce((n, ch, i) => n + (text.slice(i, i + 2) && terms.includes(text.slice(i, i + 2)) ? 1 : 0), 0) : 0
    return { node, overlap: clamp(overlap, 0, 100), idx }
  })
  ranked.sort((a, b) => b.overlap - a.overlap)
  const maxLines = Number.isInteger(limit) && limit > 0 ? limit : 24
  const lines = []
  for (const r of ranked) {
    if (lines.length >= maxLines) break
    const n = r.node
    lines.push(String(n.id || '') + '|' + String(n.type || '') + '|' + String(n.text || '').slice(0, 160))
  }
  return lines.join(NL)
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function assembleFinalGraph({ title, sourceText, paras, manifest, nodes, edges, warnings, summaries }) {
  const docId = manifest.documentId
  const srcId = manifest.sourceId
  const now = Date.now()
  // section paragraphs -> endParagraph currently computed by buildSourceManifest
  const sections = manifest.sections
  // Gather per-section summaries from batch summaries.
  const sectionSummaryParts = new Map()
  for (const s of sections) sectionSummaryParts.set(s.id, [])
  for (const b of manifest.batches) {
    const chunkSummary = summaries[b.chunkId] || ''
    for (const sid of b.sectionIds || []) {
      const arr = sectionSummaryParts.get(sid)
      if (arr && chunkSummary) arr.push(chunkSummary)
    }
  }
  for (const s of sections) {
    const parts = (sectionSummaryParts.get(s.id) || []).filter(Boolean)
    s.summary = parts.length > 0 ? parts.join(' ') : ''
  }

  const nodesWithSortedParagraphs = nodes
  const stagingChunks = manifest.batches.map((b) => ({
    chunkId: b.chunkId,
    sourceId: b.sourceId,
    startParagraph: b.startParagraph,
    endParagraph: b.endParagraph,
    sectionIds: b.sectionIds,
    sectionTitles: b.sectionTitles,
    summary: summaries[b.chunkId] || '',
    status: 'completed',
    nodeIds: nodesWithSortedParagraphs.filter((n) => n.paragraph >= b.startParagraph && n.paragraph <= b.endParagraph).map((n) => n.id),
    edgeCount: 0,
    warnings: [],
  }))
  const edgeCount = edges.length

  const source = {
    id: srcId,
    documentId: docId,
    title,
    chars: sourceText.length,
    paragraphCount: manifest.paragraphCount,
    chunkCount: manifest.chunkCount,
    sectionCount: manifest.sectionCount,
    sections,
  }

  return {
    summary: summaries._overall_summary || '',
    warnings,
    generation: {
      invariantVersion: 2,
      status: warnings.length > 0 ? 'succeeded_with_warnings' : 'succeeded',
      sourceAudit: 'ocr+llm',
      chunkCount: manifest.chunkCount,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
    source,
    sourceText,
    revision: 1,
    nodes,
    edges,
    staging: { chunks: stagingChunks },
  }
}

async function main() {
  const args = {}
  for (let i = 2; i < process.argv.length; i++) {
    const tok = process.argv[i]
    if (!tok.startsWith('--')) continue
    const key = tok.slice(2)
    const next = process.argv[i + 1]
    if (next && !next.startsWith('--')) { args[key] = next; i += 1 } else args[key] = true
  }
  const pagesPath = args.pages
  const outPath = args.out
  if (!pagesPath || !outPath) {
    console.error('usage: node kg-extract.mjs --pages <pages.json> --out <graph.json> [--db FILE] [--title T] [--max-batches N] [--resume]')
    process.exit(1)
  }
  const pages = loadJson(pagesPath)
  const sourceText = Object.keys(pages).sort((a, b) => Number(a) - Number(b)).map((k) => pages[k]).join(NL + NL)
  const paras = splitParagraphs(sourceText)
  const manifest = buildSourceManifest(args.title || '学习观：从感觉懂了到真正学会', sourceText, paras)
  console.log(`[kg-extract] chars=${sourceText.length} paragraphs=${paras.length} chunks=${manifest.chunkCount} sections=${manifest.sectionCount}`)

  const batches = manifest.batches
  const maxBatches = args['max-batches'] ? Number(args['max-batches']) : batches.length
  const skip = args.resume ? maybeLoadPartial(outPath) : null
  const acc = { nodes: new Map(), edges: [], ids: [], edgeKeys: new Set(), warnings: [] }
  const summaries = {}
  let summaryAccum = ''
  const resumeFrom = skip ? skip.nextBatch : 0

  for (let i = resumeFrom; i < Math.min(batches.length, maxBatches); i++) {
    const batch = batches[i]
    const batchContext = {
      documentId: manifest.documentId,
      sourceId: manifest.sourceId,
      chunkId: batch.chunkId,
      paragraphTexts: paras,
      totalParagraphs: paras.length,
      paragraphMeta: manifest.paragraphMeta,
    }
    const existingDigest = acc.nodes.size > 0
      ? serializeExistingGraph(Array.from(acc.nodes.values()), 24, (batch.units || []).map((u) => u.text).join(' '))
      : ''
    const userText = buildUserPrompt(args.title || '', batch, i, batches.length, existingDigest)
    console.log(`[kg-extract] batch ${i + 1}/${batches.length} (${batch.chunkId}) P${batch.startParagraph}-${batch.endParagraph} ...`)

    let lastErr = ''
    let lastFailure = 'schema_invalid'
    let ok = false
    // Attempt up to 3 model calls per batch, retrying on both LLM transport
    // failures and schema-invalid / empty outputs.
    const MAX_ATTEMPTS = 3
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !ok; attempt++) {
      try {
        const retrySuffix = attempt > 0 ? NL + NL + '【修复反馈】上一轮输出不合格（' + lastErr + '）。请严格按 JSON 结构与 8 类节点/12 类关系提取，至少产出若干个原子节点；每条边必须有直接证明关系的原文 evidence。' : ''
        const raw = await callLLM({ system: SYSTEM_PROMPT, user: userText + retrySuffix, maxTokens: 8000, temperature: 0.2 })
        const norm = normalizeGraph(raw, paras.length, new Set(acc.ids), batchContext)
        if (norm.error) { lastErr = norm.error; lastFailure = 'schema_invalid'; continue }
        if (norm.nodes.length === 0) { lastErr = '本批未产出任何节点'; lastFailure = 'empty_or_invalid'; continue }
        mergeBatch(norm, acc, i)
        if (norm.summary) summaries[batch.chunkId] = norm.summary
        summaryAccum = norm.summary || summaryAccum
        writePartial(outPath, { nextBatch: i + 1, acc: serializeAcc(acc), summaries, summaryAccum, batches: batches.length })
        ok = true
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e)
        lastFailure = 'llm_error'
        console.error(`[kg-extract] batch ${i + 1} attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${lastErr}`)
      }
    }
    if (!ok) {
      acc.warnings.push('batch' + (i + 1) + ':failed:' + lastFailure + ':' + lastErr.slice(0, 120))
      // Persist whatever we have so far; continue to the next batch.
      writePartial(outPath, { nextBatch: i + 1, acc: serializeAcc(acc), summaries, summaryAccum, batches: batches.length })
    }
  }

  const nodes = Array.from(acc.nodes.values())
  const edges = acc.edges
  summaries._overall_summary = summaryAccum
  const finalGraph = assembleFinalGraph({
    title: args.title || '学习观：从感觉懂了到真正学会',
    sourceText,
    paras,
    manifest,
    nodes,
    edges,
    warnings: acc.warnings,
    summaries,
  })

  writeFileSync(outPath, JSON.stringify(finalGraph, null, 2), 'utf8')
  console.log(`[kg-extract] wrote ${outPath}: nodes=${nodes.length} edges=${edges.length} warnings=${acc.warnings.length}`)

  if (args.import) {
    const db = args.db
    const store = await openSqliteStore(typeof db === 'string' && db ? db : undefined)
    try {
      const result = store.saveGraph(finalGraph, {
        title: args.title || '学习观：从感觉懂了到真正学会',
        sourceText,
        sourceUnits: paras.map((text, ix) => ({ paragraph: ix, text })),
      })
      console.log('[kg-extract] imported →', JSON.stringify(result))
    } finally {
      store.close()
    }
  }
}

function serializeAcc(acc) {
  return {
    nodes: Array.from(acc.nodes.values()),
    edges: acc.edges,
    ids: acc.ids,
    edgeKeys: Array.from(acc.edgeKeys),
    warnings: acc.warnings,
  }
}

function writePartial(outPath, data) {
  try {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath + '.partial.json', JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { /* best effort */ }
}

function maybeLoadPartial(outPath) {
  const p = outPath + '.partial.json'
  if (!existsSync(p)) return null
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'))
    return { nextBatch: d.nextBatch || 0 }
  } catch (e) { return null }
}

// Entry point when run directly.
const isDirect = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://' + process.cwd() + '/').href
if (isDirect) {
  main().catch((e) => { console.error('[kg-extract] fatal:', e && e.stack ? e.stack : e); process.exit(1) })
}
