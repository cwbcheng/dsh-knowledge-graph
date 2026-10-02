import { readFileSync, writeFileSync } from 'node:fs'
import { createTargetMapTools } from '../src/kg-target-map.mjs'
const open = '      // >>> GENERATED TARGET MAP TOOLS >>>', close = '      // <<< END TARGET MAP TOOLS <<<'
const block = open + '\n      const TARGET_MAP_TOOLS = (' + createTargetMapTools.toString().split('\n').join('\n      ') + ')()\n' + close
for (const name of ['index.host.js', 'index.client.js']) {
  const path = new URL('../src/' + name, import.meta.url), source = readFileSync(path, 'utf8')
  const start = source.indexOf(open), end = source.indexOf(close)
  if (start < 0 || end < start) throw new Error('target map markers missing: ' + name)
  if (source.slice(start, end + close.length) !== block) {
    if (process.argv.includes('--check')) throw new Error('target map tools stale: ' + name)
    writeFileSync(path, source.slice(0, start) + block + source.slice(end + close.length))
  }
}
