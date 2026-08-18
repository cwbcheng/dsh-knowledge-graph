import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CRX3_VERSION = '2.0.0'
const CRX3_INTEGRITY = 'sha512-f23Oi2Zpl68aBSf5gHwn+lxQyPF+m2NAhMwwycXOxqOx6bpzDqzbcp6k/DRsyHxpsDvg5WwXcHOJSOgJ7Px5LQ=='
const defaultKey = join(homedir(), '.config', 'dsh-knowledge-graph', 'extension-signing.pem')
const keyPath = resolve(process.env.DSH_KG_EXTENSION_KEY || defaultKey)
const outputPath = resolve(ROOT, 'dist', 'dsh-knowledge-graph.crx')

const keyRelative = relative(ROOT, keyPath)
if (keyRelative === '' || (!keyRelative.startsWith('..' + sep) && keyRelative !== '..')) {
  throw new Error('DSH_KG_EXTENSION_KEY must point outside the repository; private keys must not be checked in')
}

mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
if (existsSync(keyPath)) chmodSync(keyPath, 0o600)

// Signing is an offline trust boundary: never download a packer while the
// long-lived private key is in scope. Require the exact audited package from
// this repository's lockfile and execute its local bin with the current Node.
const signingRoot = resolve(ROOT, 'scripts', 'signing')
const lock = JSON.parse(readFileSync(resolve(signingRoot, 'package-lock.json'), 'utf8'))
const lockedCrx3 = lock && lock.packages && lock.packages['node_modules/crx3']
if (!lockedCrx3 || lockedCrx3.version !== CRX3_VERSION || lockedCrx3.integrity !== CRX3_INTEGRITY) {
  throw new Error('scripts/signing/package-lock.json must pin crx3@' + CRX3_VERSION + ' with the audited integrity before signing')
}
const crxBin = resolve(signingRoot, 'node_modules', 'crx3', 'bin', 'crx3.js')
if (!existsSync(crxBin)) throw new Error('Local crx3@' + CRX3_VERSION + ' is not installed; run npm ci --prefix scripts/signing before signing')
const realCrxBin = realpathSync(crxBin)
const expectedCrxRoot = realpathSync(resolve(signingRoot, 'node_modules', 'crx3'))
const crxRelative = relative(expectedCrxRoot, realCrxBin)
if (crxRelative.startsWith('..' + sep) || isAbsolute(crxRelative)) throw new Error('crx3 executable resolved outside its locked package')

const result = spawnSync(process.execPath, [
  realCrxBin,
  '--key', keyPath,
  '--crx', outputPath,
  '--',
  resolve(ROOT, 'extension'),
], {
  cwd: ROOT,
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) throw new Error('CRX3 packer exited with status ' + result.status)

if (existsSync(keyPath)) chmodSync(keyPath, 0o600)
console.log('CRX written:', outputPath)
console.log('Signing key kept outside repository:', keyPath)
console.log('Temporary packaging directory:', tmpdir())
