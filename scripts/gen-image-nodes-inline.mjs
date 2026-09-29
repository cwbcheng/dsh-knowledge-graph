import { readFileSync, writeFileSync } from 'node:fs'
import { createImageNodeTools } from '../src/kg-image-nodes.mjs'

// Dynamic Host has no module loader. Inline the same pure source used by SQLite.
const path = new URL('../src/index.host.js', import.meta.url)
const open = '      // >>> GENERATED IMAGE NODE TOOLS >>>'
const close = '      // <<< END IMAGE NODE TOOLS <<<'
const source = readFileSync(path, 'utf8'), start = source.indexOf(open), end = source.indexOf(close)
if (start < 0 || end < start) throw new Error('image node tool markers missing')
const block = open + '\n      const IMAGE_NODE_TOOLS = (' + createImageNodeTools.toString().split('\n').join('\n      ') + ')()\n' + close
if (source.slice(start, end + close.length) !== block) {
  if (process.argv.includes('--check')) throw new Error('image node tools stale; run npm run build')
  writeFileSync(path, source.slice(0, start) + block + source.slice(end + close.length))
}
