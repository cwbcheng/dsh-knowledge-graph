import { readFileSync, writeFileSync } from 'node:fs'
import { createModelConsumptionTools } from '../src/kg-model-structure.mjs'

const open = '      // >>> GENERATED MODEL CONSUMPTION TOOLS >>>'
const close = '      // <<< END MODEL CONSUMPTION TOOLS <<<'
const block = open + '\n      const MODEL_CONSUMPTION_TOOLS = (' + createModelConsumptionTools.toString().split('\n').join('\n      ')
  + ')(MODEL_STRUCTURE_TOOLS)\n' + close
const path = new URL('../src/index.host.js', import.meta.url)
const source = readFileSync(path, 'utf8'), start = source.indexOf(open), end = source.indexOf(close)
if (start < 0 || end < start) throw new Error('model consumption tool markers missing')
if (source.slice(start, end + close.length) !== block) {
  if (process.argv.includes('--check')) throw new Error('model consumption tools stale; run npm run build')
  writeFileSync(path, source.slice(0, start) + block + source.slice(end + close.length))
}
