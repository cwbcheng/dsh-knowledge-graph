import { readFileSync, writeFileSync } from 'node:fs'
import { createModelChainTools } from '../src/kg-model-chain.mjs'

const open = '      // >>> GENERATED MODEL CHAIN TOOLS >>>'
const close = '      // <<< END MODEL CHAIN TOOLS <<<'
const block = open + '\n      const MODEL_CHAIN_TOOLS = (' + createModelChainTools.toString().split('\n').join('\n      ') + ')()\n' + close
for (const file of ['index.host.js', 'index.client.js']) {
  const path = new URL('../src/' + file, import.meta.url)
  const source = readFileSync(path, 'utf8'), start = source.indexOf(open), end = source.indexOf(close)
  if (start < 0 || end < start) throw new Error('model chain tool markers missing in ' + file)
  if (source.slice(start, end + close.length) !== block) {
    if (process.argv.includes('--check')) throw new Error('model chain tools stale; run npm run build')
    writeFileSync(path, source.slice(0, start) + block + source.slice(end + close.length))
  }
}
