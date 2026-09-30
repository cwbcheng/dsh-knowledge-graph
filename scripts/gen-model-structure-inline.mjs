import { readFileSync, writeFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'

const open = '      // >>> GENERATED MODEL STRUCTURE TOOLS >>>'
const close = '      // <<< END MODEL STRUCTURE TOOLS <<<'
const block = open + '\n      const MODEL_STRUCTURE_TOOLS = (' + createModelStructureTools.toString().split('\n').join('\n      ') + ')()\n' + close
for (const file of ['index.host.js', 'index.client.js']) {
  const path = new URL('../src/' + file, import.meta.url)
  const source = readFileSync(path, 'utf8'), start = source.indexOf(open), end = source.indexOf(close)
  if (start < 0 || end < start) throw new Error('model structure tool markers missing in ' + file)
  if (source.slice(start, end + close.length) !== block) {
    if (process.argv.includes('--check')) throw new Error('model structure tools stale; run npm run build')
    writeFileSync(path, source.slice(0, start) + block + source.slice(end + close.length))
  }
}
