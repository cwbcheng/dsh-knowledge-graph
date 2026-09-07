#!/usr/bin/env node
/**
 * Segment a plain text document into numbered content units ("paragraphs").
 *
 * This is a faithful port of the host plugin's splitParagraphsOffsetsHost /
 * structured-classify + atomic-ranges + prose-grouping algorithm. The host and
 * client mutually require the SAME numbering, because every graph node /
 * relation stores a paragraph index that must resolve to exactly one content
 * unit on both sides, and because the evidence quote is authenticated against
 * that unit's text. A standalone import pipeline that invents its own simpler
 * paragraph split would produce paragraph indices the UI / verifier could not
 * resolve, so we reuse the exact algorithm.
 *
 * Usage (as a library):
 *   import { splitParagraphs, splitParagraphsOffsets } from './paragraphs.mjs'
 *   const paras = splitParagraphs(sourceText)             // string[]
 *   const offsets = splitParagraphsOffsets(sourceText)    // {text,start,end}[]
 */

import { createHash } from 'node:crypto'

const NL = String.fromCharCode(10)

const SEG_MAX = 300
const SEG_SOFT_MAX = 120
const SEG_SENTENCE_MAX = 180
const SEG_MIN_TOPIC = 24
const SEG_TOPIC_SIM = 0.08

const SENT_END = new Set(['。', '！', '？', '!', '?', '；', ';'])
const SENT_CLOSER = new Set(['”', '’', '"', "'", '」', '』', '）', ')', '】', '》', '〉'])
const SEG_SOFT = new Set(['，', '、', '：', ':', ',', '—', '…', ' ', '\t'])

const SEG_TRANSITIONS = [
  '综上所述', '总而言之', '换句话说', '也就是说', '由此可见', '由此可知', '除此之外',
  '值得注意的是', '需要说明', '需要指出', '问题在于', '关键在于', '事实上', '实际上',
  '另一方面', '与此同时', '举例来说', '例如', '比如', '譬如', '特别是', '尤其是',
  '首先是', '其次', '再次', '最后', '总之', '综上', '因此', '所以', '于是', '因而',
  '故而', '然而', '但是', '不过', '可是', '只是', '相反', '反之', '此外', '另外',
  '而且', '并且', '况且', '再说', '进一步', '然后', '接下来', '接着', '随后',
  '首先', '最后一点',
].sort((a, b) => b.length - a.length)

function hasSentEnd(s) {
  for (let i = 0; i < s.length; i++) if (SENT_END.has(s[i])) return true
  return false
}

function startsWithAny(s, prefixes) {
  const t = s.trimStart()
  for (const p of prefixes) if (t.startsWith(p)) return true
  return false
}

function lineIndent(line) {
  let i = 0
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  return i
}

function listMarker(line) {
  const t = line.trim()
  if (!t) return false
  return /^[-*•·▪◦●○]\s+/.test(t)
    || /^[（(]?\d{1,3}[）).、]\s*/.test(t)
    || /^[一二三四五六七八九十]+[、.．]\s*/.test(t)
    || /^第[一二三四五六七八九十百0-9]+[条章节款]\s*/.test(t)
    || /^[a-zA-Z][.、]\s+/.test(t)
}

function dialogLine(line) {
  const t = line.trim()
  if (!t) return false
  if (/^[“"「『]/.test(t)) return true
  return /^[^：:]{0,12}(说|道|问|答|喊|讲)[：:]/.test(t)
}

function headingLine(line) {
  const t = line.trim()
  if (!t || t.length > 60 || hasSentEnd(t) || listMarker(t) || dialogLine(t)) return false
  return /^(第[一二三四五六七八九十百0-9]+[章节条款部分]|[一二三四五六七八九十]+[、.．]|\d+(\.\d+)*[、.．]?)\s*/.test(t)
    || !/[，。：；,;:?!？!]/.test(t)
}

function atomicRanges(line) {
  const ranges = []
  let start = 0
  let i = 0
  while (i < line.length) {
    if (SENT_END.has(line[i])) {
      let end = i + 1
      while (end < line.length && SENT_CLOSER.has(line[end])) end++
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

function splitLongSentence(text, absStart, out) {
  let pos = 0
  const floor = Math.floor(SEG_SENTENCE_MAX * 0.55)
  while (text.length - pos > SEG_SENTENCE_MAX) {
    const limit = pos + SEG_SENTENCE_MAX
    let cut = -1
    for (let i = limit; i > pos + floor; i--) {
      if (SEG_SOFT.has(text[i - 1])) { cut = i; break }
    }
    if (cut < 0) cut = limit
    const piece = text.slice(pos, cut)
    if (piece.trim()) out.push({ text: piece, start: absStart + pos, end: absStart + cut })
    pos = cut
  }
  const rest = text.slice(pos)
  if (rest.trim()) out.push({ text: rest, start: absStart + pos, end: absStart + text.length })
}

function pushPiece(text, start, end, out) {
  const piece = text.slice(start, end)
  if (piece.trim()) out.push({ text: piece, start, end })
}

function segTokenize(s) {
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

function topicSimilarity(a, b) {
  const sa = new Set(segTokenize(a))
  const sb = new Set(segTokenize(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let hit = 0
  for (const t of sa) if (sb.has(t)) hit += 1
  return hit / Math.min(sa.size, sb.size)
}

function classifyBlock(texts) {
  const n = texts.length
  if (n === 0) return 'prose'
  if (n === 1 && headingLine(texts[0])) return 'heading'
  let dialog = 0
  let list = 0
  let code = 0
  let table = 0
  let quote = 0
  for (const t of texts) {
    if (dialogLine(t)) dialog += 1
    if (listMarker(t)) list += 1
    if (lineIndent(t) >= 2) code += 1
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

function appendLineCapped(line, absStart, out) {
  const push = (s, e) => {
    const piece = line.slice(s, e)
    if (piece.trim()) out.push({ text: piece, start: absStart + s, end: absStart + e })
  }
  if (line.length <= SEG_SOFT_MAX) {
    push(0, line.length)
    return
  }
  const ranges = atomicRanges(line)
  let s = null
  let e = null
  const flush = () => {
    if (s != null) { push(s, e); s = null; e = null }
  }
  for (const r of ranges) {
    if (r.end - r.start > SEG_SENTENCE_MAX) {
      flush()
      splitLongSentence(line.slice(r.start, r.end), absStart + r.start, out)
      continue
    }
    if (s == null) { s = r.start; e = r.end }
    else if (r.end - s <= SEG_SOFT_MAX) { e = r.end }
    else { flush(); s = r.start; e = r.end }
  }
  flush()
}

function appendRawLine(line, absStart, out) {
  if (line.length <= SEG_MAX) {
    if (line.trim()) out.push({ text: line, start: absStart, end: absStart + line.length })
  } else {
    splitLongSentence(line, absStart, out)
  }
}

function appendQuoteBlock(lines, text, out) {
  if (lines.length === 0) return
  let s = lines[0].start
  let e = lines[0].end
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.end - s <= SEG_SOFT_MAX) { e = l.end; continue }
    pushPiece(text, s, e, out)
    s = l.start
    e = l.end
  }
  pushPiece(text, s, e, out)
}

function groupProseParts(parts, text, out) {
  let s = null
  let e = null
  for (const p of parts) {
    if (s == null) { s = p.start; e = p.end; continue }
    const mergedLen = (e - s) + (p.start - e) + (p.end - p.start)
    let boundary = false
    if (mergedLen > SEG_MAX) {
      boundary = true
    } else if (mergedLen > SEG_SOFT_MAX && e - s >= SEG_MIN_TOPIC) {
      boundary = true
    } else if (e - s >= SEG_MIN_TOPIC) {
      if (startsWithAny(p.text, SEG_TRANSITIONS)) boundary = true
      else if (topicSimilarity(text.slice(s, e), text.slice(p.start, p.end)) < SEG_TOPIC_SIM) boundary = true
    }
    if (boundary) {
      pushPiece(text, s, e, out)
      s = p.start
      e = p.end
    } else {
      e = p.end
    }
  }
  if (s != null) pushPiece(text, s, e, out)
}

export function splitParagraphsOffsets(text) {
  const lines = String(text == null ? '' : text).split(NL)
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
    const kind = classifyBlock(block.map((l) => l.text))
    if (kind === 'quote') {
      appendQuoteBlock(block, text, out)
    } else if (kind === 'code') {
      for (const l of block) appendRawLine(l.text, l.start, out)
    } else if (kind === 'list' || kind === 'dialogue' || kind === 'table' || kind === 'heading') {
      for (const l of block) appendLineCapped(l.text, l.start, out)
    } else {
      const parts = []
      for (const l of block) {
        for (const r of atomicRanges(l.text)) {
          splitLongSentence(l.text.slice(r.start, r.end), l.start + r.start, parts)
        }
      }
      groupProseParts(parts, text, out)
    }
  }
  return out
}

export function splitParagraphs(text) {
  return splitParagraphsOffsets(text).map((p) => p.text)
}

function stableHash(value) {
  let h = 0
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) - h + value.charCodeAt(i)) | 0
    h |= 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function buildSections(paras) {
  const sections = []
  let current = null
  const makeSection = (title, start) => ({
    id: 'section-' + String(sections.length + 1).padStart(3, '0') + '-' + stableHash(String(title || '全文') + '@' + start),
    title: String(title || '全文').trim().slice(0, 120) || '全文',
    startParagraph: start,
    endParagraph: start,
    summary: '',
  })
  for (let i = 0; i < paras.length; i++) {
    const text = String(paras[i] || '').trim()
    const fileHeading = /^={2,}\s*文件：.+\s*={2,}$/.test(text)
    const structuralHeading = /^(?:#{1,6}\s+|第[一二三四五六七八九十百0-9]+[章节条款部分]|[一二三四五六七八九十]+[、.．]|\d+(?:\.\d+)*[、.．]?\s+)/.test(text)
    const heading = fileHeading || structuralHeading || headingLine(text) ? text.slice(0, 120) : ''
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
    const startParagraph = cur[0].num
    const endParagraph = cur[cur.length - 1].num
    const sourceId = context && typeof context.sourceId === 'string' ? context.sourceId : ''
    const chunkIdentity = stableHash(sourceId + ':' + index + ':' + startParagraph + ':' + endParagraph)
    batches.push({
      chunkId: 'chunk-' + chunkIdentity + '-' + String(index).padStart(4, '0'),
      sourceId,
      units: cur,
      startParagraph,
      endParagraph,
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

/**
 * Build the source manifest used by the host's buildSourceManifestHost. The
 * document/source ids, title, char/page/section/chunk counts, sections and
 * batches are all produced deterministically so the imported SQLite graph is
 * identical to what the host would have produced itself.
 */
export function buildSourceManifest(title, text, paras) {
  const sections = buildSections(paras)
  const paragraphMeta = new Array(paras.length)
  for (const section of sections) {
    for (let i = section.startParagraph; i <= section.endParagraph && i < paragraphMeta.length; i++) {
      paragraphMeta[i] = { sectionId: section.id, sectionTitle: section.title }
    }
  }
  const sourceId = 'source-' + sha256Hex(String(text || ''))
  const batches = buildBatchesByParagraph(paras, 6000, { sourceId, paragraphMeta })
  return {
    documentId: 'document-' + sha256Hex(sourceId),
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

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}
