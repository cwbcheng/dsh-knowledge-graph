import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultKey = join(homedir(), '.config', 'dsh-knowledge-graph', 'extension-signing.pem')
const keyPath = resolve(process.env.DSH_KG_EXTENSION_KEY || defaultKey)
const outputPath = resolve(ROOT, 'dist', 'dsh-knowledge-graph.crx')

const keyRelative = relative(ROOT, keyPath)
if (keyRelative === '' || (!keyRelative.startsWith('..' + sep) && keyRelative !== '..')) {
  throw new Error('DSH_KG_EXTENSION_KEY must point outside the repository; private keys must not be checked in')
}

mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
if (existsSync(keyPath)) chmodSync(keyPath, 0o600)

const result = spawnSync('npx', [
  '--yes',
  'crx3',
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
