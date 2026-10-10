import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const name = 'dsh-knowledge-graph'
// These are the runtime outputs of build-lib.mjs and build-client.mjs.
const modules = ['index.js', 'client.js', 'kg-store.mjs', 'kg-markdown.mjs', 'kg-ontology.mjs',
  'kg-image-nodes.mjs', 'kg-model-structure.mjs', 'kg-model-chain.mjs', 'kg-target-map.mjs', 'kg-source-relations.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function ensureDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  if (!lstatSync(path).isDirectory()) throw new Error('Artifact directory must not be a symlink: ' + path)
}

function readArtifacts(root) {
  const files = new Map()
  const read = relative => {
    const path = join(root, relative)
    if (!lstatSync(path).isFile()) throw new Error('Artifact must be a regular file: ' + relative)
    files.set(relative, readFileSync(path))
  }
  read('package.json')
  read('cordis.patch.yml')
  if (!lstatSync(join(root, 'lib')).isDirectory()) throw new Error('Artifact lib must not be a symlink')
  for (const module of modules) {
    const relative = 'lib/' + module
    try { lstatSync(join(root, relative)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    read(relative)
  }
  const pkg = JSON.parse(files.get('package.json').toString())
  if (pkg.name !== name || !files.has('lib/index.js') || !files.has('lib/client.js')) {
    throw new Error('Incomplete knowledge graph plugin artifacts')
  }
  return files
}

const checksums = files => [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes) }))

/** Pin only the plugin's built code, never user data, credentials or the source tree. */
export function pinWebArtifacts(pluginDir, dshHome) {
  const source = realpathSync(pluginDir)
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  const home = realpathSync(dshHome)
  const base = join(home, 'plugin-artifacts')
  ensureDirectory(base)
  const root = join(base, name)
  ensureDirectory(root)
  const dependencies = existsSync(join(source, 'node_modules')) ? realpathSync(join(source, 'node_modules')) : null
  const files = readArtifacts(source)
  const identity = JSON.stringify({ files: checksums(files), dependencies })
  const buildId = hash(identity)
  const target = join(root, buildId)
  const manifest = JSON.stringify({ format: 'dsh.kg-web-artifacts', version: 1, buildId, ...JSON.parse(identity) }) + '\n'
  const verify = () => {
    if (!lstatSync(target).isDirectory()) throw new Error('Pinned artifact path must not be a symlink')
    const receipt = join(target, 'build-manifest.json')
    if (!lstatSync(receipt).isFile() || readFileSync(receipt, 'utf8') !== manifest
      || JSON.stringify(checksums(readArtifacts(target))) !== JSON.stringify(checksums(files))) {
      throw new Error('Pinned artifact integrity check failed; do not boot this build: ' + buildId)
    }
    const link = join(target, 'node_modules')
    const info = lstatSync(link, { throwIfNoEntry: false })
    if (dependencies === null ? info !== undefined
      : !info?.isSymbolicLink() || readlinkSync(link) !== dependencies) {
      throw new Error('Pinned artifact dependency link changed')
    }
  }
  if (existsSync(target)) {
    verify()
    return target
  }
  const staging = mkdtempSync(join(root, '.staging-'))
  try {
    for (const [path, bytes] of files) {
      mkdirSync(dirname(join(staging, path)), { recursive: true, mode: 0o700 })
      writeFileSync(join(staging, path), bytes, { flag: 'wx', mode: 0o444 })
    }
    if (dependencies !== null) symlinkSync(dependencies, join(staging, 'node_modules'), 'dir')
    writeFileSync(join(staging, 'build-manifest.json'), manifest, { flag: 'wx', mode: 0o444 })
    if (JSON.stringify(checksums(readArtifacts(source))) !== JSON.stringify(checksums(files))) {
      throw new Error('Plugin artifacts changed while taking a snapshot; wait for the build to finish')
    }
    try { renameSync(staging, target) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
    }
    verify()
    return target
  } finally {
    // Only this call's exclusively created staging directory is disposable.
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: kg-web-artifacts.mjs <plugin-directory> <dsh-home>')
    process.stdout.write(pinWebArtifacts(process.argv[2], process.argv[3]) + '\n')
  } catch (error) {
    process.stderr.write('error: ' + error.message + '\n')
    process.exitCode = 1
  }
}
