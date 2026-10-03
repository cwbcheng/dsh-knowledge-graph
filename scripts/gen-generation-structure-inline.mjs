import { readFileSync, writeFileSync } from 'node:fs'
import { createGenerationStructureTools } from '../src/kg-generation-structure.mjs'

const open = '      // >>> GENERATED GENERATION STRUCTURE TOOLS >>>'
const close = '      // <<< END GENERATION STRUCTURE TOOLS <<<'
const body = createGenerationStructureTools.toString().split('\n')
  .map((line, index) => index === 0 || !line ? line : '      ' + line).join('\n')
const block = open + '\n      const GENERATION_STRUCTURE_TOOLS = (' + body + ')()\n' + close
for (const file of ['index.host.js', 'index.client.js']) {
  const path = new URL('../src/' + file, import.meta.url)
  const source = readFileSync(path, 'utf8'), start = source.indexOf(open), end = source.indexOf(close)
  if (start < 0 || end < start) throw new Error('generation structure tool markers missing in ' + file)
  if (source.slice(start, end + close.length) !== block) {
    if (process.argv.includes('--check')) throw new Error('generation structure tools stale; run npm run build')
    writeFileSync(path, source.slice(0, start) + block + source.slice(end + close.length))
  }
}
