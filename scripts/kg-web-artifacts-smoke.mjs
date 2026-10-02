import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pinWebArtifacts } from './kg-web-artifacts.mjs'

if (process.platform !== 'linux') {
  console.log('web artifact pinning is used by the Linux/WSL launcher; run this test in WSL')
  process.exit(0)
}
const root = fs.mkdtempSync(join(tmpdir(), 'kg-web-artifacts space#-'))
const source = join(root, 'source')
const home = join(root, 'home')
const client = join(source, 'lib/client.js')
const originalRead = fs.readFileSync
try {
  fs.mkdirSync(join(source, 'lib'), { recursive: true })
  fs.mkdirSync(join(source, 'node_modules'), { recursive: true })
  fs.writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-knowledge-graph', type: 'module' }))
  fs.writeFileSync(join(source, 'cordis.patch.yml'), '- insert: []\n')
  fs.writeFileSync(join(source, 'lib/index.js'), 'export const version = "A"\n')
  fs.writeFileSync(client, 'client-A\n')
  fs.writeFileSync(join(source, '.env'), 'private fixture\n')
  fs.writeFileSync(join(source, 'lib/learning.sqlite'), 'user data fixture\n')
  fs.writeFileSync(join(source, 'lib/secret.txt'), 'private fixture\n')
  const first = pinWebArtifacts(source, home)
  assert.deepEqual(fs.readdirSync(first).sort(), ['build-manifest.json', 'cordis.patch.yml', 'lib', 'node_modules', 'package.json'])
  assert.deepEqual(fs.readdirSync(join(first, 'lib')).sort(), ['client.js', 'index.js'])
  assert.equal(fs.realpathSync(join(first, 'node_modules')), fs.realpathSync(join(source, 'node_modules')))
  if (process.platform === 'linux') assert.equal(fs.statSync(join(first, 'lib/client.js')).mode & 0o777, 0o444)
  assert.equal(pinWebArtifacts(source, home), first)
  const exec = promisify(execFile)
  const args = [fileURLToPath(new URL('./kg-web-artifacts.mjs', import.meta.url)), source, join(root, 'concurrent-home')]
  const concurrent = await Promise.all([exec(process.execPath, args), exec(process.execPath, args)])
  assert.equal(concurrent[0].stdout, concurrent[1].stdout)
  assert.equal(fs.readFileSync(join(concurrent[0].stdout.trim(), 'lib/client.js'), 'utf8'), 'client-A\n')

  fs.writeFileSync(client, 'client-B\n')
  const second = pinWebArtifacts(source, home)
  assert.notEqual(second, first)
  assert.equal(fs.readFileSync(join(first, 'lib/client.js'), 'utf8'), 'client-A\n')
  const preserved = fs.readFileSync(join(second, 'build-manifest.json'), 'utf8')
  fs.chmodSync(join(second, 'lib/client.js'), 0o600)
  fs.writeFileSync(join(second, 'lib/client.js'), 'corrupted fixture\n')
  assert.throws(() => pinWebArtifacts(source, home), /integrity check failed/)
  assert.equal(fs.readFileSync(join(second, 'lib/client.js'), 'utf8'), 'corrupted fixture\n', 'do not silently repair a corrupt published snapshot')
  assert.equal(fs.readFileSync(join(second, 'build-manifest.json'), 'utf8'), preserved)
  fs.writeFileSync(join(second, 'lib/client.js'), 'client-B\n')
  fs.chmodSync(join(second, 'lib/client.js'), 0o444)

  fs.writeFileSync(client, 'client-C\n')
  let changed = false
  fs.readFileSync = function(path, ...options) {
    const bytes = originalRead.call(this, path, ...options)
    if (path === client && !changed) {
      changed = true
      fs.writeFileSync(client, 'client-D\n')
    }
    return bytes
  }
  syncBuiltinESMExports()
  assert.throws(() => pinWebArtifacts(source, home), /changed while taking a snapshot/)
  fs.readFileSync = originalRead
  syncBuiltinESMExports()
  assert.equal(fs.readdirSync(dirname(first)).filter(name => name.startsWith('.staging-')).length, 0)
  assert.equal(fs.readFileSync(join(first, 'lib/client.js'), 'utf8'), 'client-A\n')
  assert.equal(fs.readFileSync(join(second, 'lib/client.js'), 'utf8'), 'client-B\n')

  fs.unlinkSync(client)
  fs.symlinkSync(join(source, '.env'), client)
  assert.throws(() => pinWebArtifacts(source, home), /regular file/)
  fs.unlinkSync(client)
  assert.throws(() => pinWebArtifacts(source, home), /Incomplete/)
  fs.writeFileSync(client, 'client-D\n')
  const redirectedHome = join(root, 'redirected-home')
  const unrelated = join(root, 'unrelated')
  fs.mkdirSync(redirectedHome)
  fs.mkdirSync(unrelated)
  fs.writeFileSync(join(unrelated, 'keep.txt'), 'preserve\n')
  fs.symlinkSync(unrelated, join(redirectedHome, 'plugin-artifacts'), 'dir')
  assert.throws(() => pinWebArtifacts(source, redirectedHome), /must not be a symlink/)
  assert.deepEqual(fs.readdirSync(unrelated), ['keep.txt'])
  assert.equal(fs.readFileSync(join(unrelated, 'keep.txt'), 'utf8'), 'preserve\n')

  // Load the real build outside the checkout so omitted local imports cannot hide.
  const production = pinWebArtifacts(fileURLToPath(new URL('../', import.meta.url)), join(root, 'production-home'))
  const load = ['--input-type=module', '-e',
    'const plugin = await import(process.argv[1]); if (typeof plugin.apply !== "function") throw new Error("Plugin entry missing")',
    pathToFileURL(join(production, 'lib/index.js')).href]
  await exec(process.execPath, load, { cwd: root, env: { ...process.env, DSH_KG_DB: join(root, 'isolated.sqlite') } })
  assert(fs.existsSync(join(production, 'lib/kg-target-map.mjs')))
  fs.unlinkSync(join(production, 'lib/kg-target-map.mjs'))
  await assert.rejects(exec(process.execPath, load, { cwd: root }), error =>
    error.code !== 0 && /ERR_MODULE_NOT_FOUND/.test(error.stderr) && /kg-target-map\.mjs/.test(error.stderr))
  assert.throws(() => pinWebArtifacts(fileURLToPath(new URL('../', import.meta.url)), join(root, 'production-home')), /integrity check failed/)
  console.log(JSON.stringify({ ok: true, codeOnly: true, immutablePriorBuild: true, checksumReuse: true,
    corruptionRejected: true, concurrentBuildRejected: true, stagingCleaned: true,
    symlinkEscapeRejected: true, missingHalfRejected: true, specialPath: true,
    productionImportClosure: true, omittedTargetMapRejected: true }))
} finally {
  fs.readFileSync = originalRead
  syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
