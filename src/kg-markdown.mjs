import MarkdownIt from 'markdown-it'

const parser = new MarkdownIt({ html: false, linkify: false })
const imageRule = parser.inline.ruler.getRules('').find(rule => rule.name === 'image')
if (!imageRule) throw new Error('Markdown image parser unavailable')
parser.inline.ruler.at('image', (state, silent) => {
  const start = state.pos
  const matched = imageRule(state, silent)
  if (matched && !silent) {
    const token = state.tokens[state.tokens.length - 1]
    token.meta = { ...token.meta, sourceMarkup: state.src.slice(start, state.pos) }
  }
  return matched
})

export function localAssetPath(value) {
  let path
  try { path = decodeURIComponent(String(value)).replace(/\\/g, '/') } catch { throw new Error('图片路径编码无效') }
  while (path.startsWith('./')) path = path.slice(2)
  if (!path || path.startsWith('/') || /[:?#\u0000-\u001f]/.test(path) || path.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('仅支持资料目录内的相对图片路径：' + String(value).slice(0, 160))
  }
  return path
}

// Parse Markdown rather than treating code samples or HTML as image references.
export function prepareMarkdownBundle(input, paragraphs) {
  const text = typeof input?.text === 'string' ? input.text.replace(/\r\n?/g, '\n').trim() : ''
  if (!text || text.length > 1000000) throw new Error('Markdown 正文为空或超过 1000000 字')
  if (!Array.isArray(input.files) || input.files.length > 128) throw new Error('图片文件不能超过 128 个')
  const files = new Map()
  for (const file of input.files) {
    const path = localAssetPath(file?.path)
    if (files.has(path)) throw new Error('重复图片路径：' + path)
    files.set(path, file)
  }
  const lineOffsets = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineOffsets.push(i + 1)
  const assets = new Map()
  let references = 0
  for (const block of parser.parse(text, {})) {
    if (block.type !== 'inline' || !block.map) continue
    const offset = lineOffsets[block.map[0]] || 0
    let cursor = offset
    const blockEnd = lineOffsets[block.map[1]] ?? text.length
    for (const token of block.children || []) {
      if (token.type !== 'image') continue
      const markup = token.meta?.sourceMarkup
      const imageOffset = markup ? text.indexOf(markup, cursor) : -1
      if (imageOffset < 0 || imageOffset + markup.length > blockEnd) throw new Error('无法精确定位 Markdown 图片语法')
      cursor = imageOffset + markup.length
      const paragraph = paragraphs.findIndex(p => imageOffset >= p.start && imageOffset < p.end)
      const path = localAssetPath(token.attrGet('src'))
      const file = files.get(path)
      if (!file) throw new Error('缺少 Markdown 引用的图片：' + path)
      if (paragraph < 0) throw new Error('无法定位图片原文段落：' + path)
      references++
      let asset = assets.get(path)
      if (!asset) {
        const caption = [paragraphs[paragraph]?.text, paragraphs[paragraph + 1]?.text].filter(Boolean).flatMap(value => value.split('\n')).find(line => /^图\s*\d/.test(line.trim()))
        asset = { path, file, caption: token.content || token.attrGet('title') || caption?.trim().slice(0, 180) || '', paragraphs: [] }
        assets.set(path, asset)
      }
      if (!asset.paragraphs.includes(paragraph)) asset.paragraphs.push(paragraph)
    }
  }
  return { text, assets: Array.from(assets.values()), references, ignoredFiles: files.size - assets.size }
}
