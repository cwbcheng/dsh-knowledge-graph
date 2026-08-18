import { readFileSync } from 'node:fs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const pack = readFileSync(new URL('./pack-extension.mjs', import.meta.url), 'utf8')
const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const lock = JSON.parse(readFileSync(new URL('./signing/package-lock.json', import.meta.url), 'utf8'))
const crx3 = lock && lock.packages && lock.packages['node_modules/crx3']

assert(!pack.includes("spawnSync('npx'") && !pack.includes("'--yes'"), 'signing still executes a network-resolved npx package')
assert(pack.includes('process.execPath') && pack.includes("scripts', 'signing'"), 'signing does not execute the local isolated packer')
assert(crx3 && crx3.version === '2.0.0', 'signing lockfile does not pin crx3@2.0.0')
assert(crx3.integrity === 'sha512-f23Oi2Zpl68aBSf5gHwn+lxQyPF+m2NAhMwwycXOxqOx6bpzDqzbcp6k/DRsyHxpsDvg5WwXcHOJSOgJ7Px5LQ==', 'signing lockfile integrity changed unexpectedly')
assert(!client.includes('LS_CHECKPOINT'), 'book-scale checkpoint is still stored in localStorage')
assert(client.includes('LEGACY_LARGE_STORAGE_KEYS'), 'legacy large localStorage payloads are not cleaned during upgrade')
assert(client.includes("localStorage.setItem(LS_RESULT, JSON.stringify({ title, documentId"), 'result localStorage is not reference-only')
assert(client.includes("return sourceUnits.length > 0 ? { text: '', sourceUnits } : {}"), 'scoped verification still sends full source text over the wire')
assert(client.includes("host.call('graph-commit'"), 'UI graph edits are not committed to the canonical Host graph')
assert(client.includes("host.call('document-load'"), 'history/result restore does not hydrate from Host/SQLite')

console.log(JSON.stringify({ ok: true, signing: 'locked-local-crx3', browserPersistence: 'reference-only', wireScope: 'bounded' }))
