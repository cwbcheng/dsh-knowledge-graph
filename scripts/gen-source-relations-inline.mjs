import { readFileSync, writeFileSync } from 'node:fs'
import { createSourceRelationTools } from '../src/kg-source-relations.mjs'
const open = '      // >>> GENERATED SOURCE RELATION TOOLS >>>'
const close = '      // <<< END SOURCE RELATION TOOLS <<<'
const block = open + '\n      const SOURCE_RELATION_TOOLS = (' + createSourceRelationTools.toString().split('\n').join('\n      ') + ')()\n' + close
const file = new URL('../src/index.host.js', import.meta.url)
const source = readFileSync(file, 'utf8'), start = source.indexOf(open), end = source.indexOf(close)
if (start < 0 || end < start) throw new Error('source relation markers missing')
if (source.slice(start, end + close.length) !== block) {
  if (process.argv.includes('--check')) throw new Error('source relation tools stale; run npm run build')
  writeFileSync(file, source.slice(0, start) + block + source.slice(end + close.length))
}
