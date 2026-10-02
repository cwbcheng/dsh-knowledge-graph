import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'linux') {
  console.log('dev-web launcher is Linux/WSL-only; run this test in WSL')
  process.exit(0)
}
const root = await mkdtemp(join(tmpdir(), 'kg-dev-web space#-'))
const plugin = join(root, 'plugin')
const harness = join(root, 'harness')
const home = join(root, 'home')
const log = join(root, 'web.log')
const pidFile = join(root, 'web.pid')
const script = join(plugin, 'scripts/dev-web.sh')
const children = new Set()
const exec = promisify(execFile)
let supervisedUnit
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function launch(extra = {}, args = []) {
  const child = spawn('bash', [script, ...args], { env: { ...process.env, DSH_REPO: harness, DSH_HOME: home,
    PATH: dirname(process.execPath) + ':' + join(root, 'bin') + ':' + process.env.PATH,
    DSH_DEV_NODE: process.execPath, DSH_DEV_PROFILE: 'fixture', DSH_DEV_LOG: log, DSH_DEV_PID: pidFile,
    DSH_DEV_STARTUP_SECONDS: '8', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  child.stdout.on('data', x => { output += x })
  child.stderr.on('data', x => { output += x })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('launcher test timed out: ' + output)) }, 15000)
    child.once('error', reject)
    child.once('close', (code, signal) => { clearTimeout(timer); children.delete(child); resolve({ code, signal, output }) })
  })
  return { child, done, output: () => output }
}
async function run(env, args) { return launch(env, args).done }
async function until(check, attempts = 100) {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await delay(50) }
  throw new Error('condition timed out')
}
async function stopped(pid) {
  await until(async () => {
    try { return (await readFile('/proc/' + pid + '/stat', 'utf8')).includes(') Z ') } catch { return true }
  })
}
try {
  for (const dir of ['src', 'lib', 'scripts']) await mkdir(join(plugin, dir), { recursive: true })
  await mkdir(join(harness, 'apps/cli/lib'), { recursive: true })
  await mkdir(join(home, 'profiles/fixture'), { recursive: true })
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/pnpm'), '#!/bin/sh\nprintf "fixture pnpm\\n"\n', { mode: 0o700 })
  await copyFile(new URL('./dev-web.sh', import.meta.url), script)
  await copyFile(new URL('./kg-web-artifacts.mjs', import.meta.url), join(plugin, 'scripts/kg-web-artifacts.mjs'))
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-knowledge-graph', type: 'module',
    exports: { '.': './lib/index.js', './client': './lib/client.js' } }))
  await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: dsh-knowledge-graph\n      name: dsh-knowledge-graph\n')
  await writeFile(join(plugin, 'lib/index.js'), 'export const version = "A"\n')
  await writeFile(join(plugin, 'lib/client.js'), 'client-A\n')
  await writeFile(join(harness, 'pnpm-workspace.yaml'), 'packages: []\n')
  await writeFile(join(home, 'profiles/fixture/package.json'), JSON.stringify({
    dependencies: { 'dsh-knowledge-graph': 'link:' + plugin }, dsh: { profile: { bundles: ['dsh-knowledge-graph'] } },
  }))
  await mkdir(join(home, 'profiles/fixture/node_modules'), { recursive: true })
  await symlink(plugin, join(home, 'profiles/fixture/node_modules/dsh-knowledge-graph'))
  await writeFile(join(harness, 'apps/cli/lib/bin.js'), `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
if (process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
const profile = path.join(process.env.DSH_HOME, 'profiles/fixture');
if (process.argv.includes('plugin')) {
  if (process.env.FAIL_INSTALL) process.exit(17);
  if (process.env.SKIP_INSTALL) process.exit(0);
  const spec = process.argv.at(-1);
  if (!spec.startsWith('link:')) throw new Error('snapshot must be installed as a local link');
  const target = spec.slice(5);
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json')));
  manifest.dependencies['dsh-knowledge-graph'] = spec;
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(manifest));
  const link = path.join(profile, 'node_modules/dsh-knowledge-graph');
  fs.unlinkSync(link); fs.symlinkSync(target, link);
  fs.appendFileSync(path.join(profile, 'install-count'), '1\\n');
  process.exit(0);
}
if (process.env.FAIL_EARLY) process.exit(42);
async function main() {
const artifact = fs.realpathSync(path.join(profile, 'node_modules/dsh-knowledge-graph'));
const host = await import(pathToFileURL(path.join(artifact, 'lib/index.js')).href);
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = http.createServer((req, res) => {
  if (req.url === '/runtime-probe') { res.write('stream-'); setImmediate(() => res.end('ok')); return; }
  if (req.url === '/?token=fresh-token') { res.writeHead(303, { 'Set-Cookie': 'fixture=yes; Path=/', Location: '/' }); res.end(); return; }
  if (req.headers.cookie !== 'fixture=yes' || req.headers.origin !== 'http://127.0.0.1:' + port) { res.writeHead(401); res.end('unauthorized'); return; }
  if (req.url === '/artifact-probe') { res.end(JSON.stringify({ host: host.version,
    client: fs.readFileSync(path.join(artifact, 'lib/client.js'), 'utf8'), artifact })); return; }
  if (process.env.FAIL_HEALTH) { res.writeHead(404); res.end('{"ontologies":"not a catalogue"}'); return; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ontologies: [{ id: 'fixture' }] }));
  if (process.env.EXIT_LATER) setTimeout(() => process.exit(43), 500);
});
server.listen(port, '127.0.0.1', async () => {
  // The server can be healthy while model transport is broken (--jitless does
  // exactly that on Node 24). Require the child's native fetch to read a stream.
  const probe = await fetch('http://127.0.0.1:' + port + '/runtime-probe');
  if (await probe.text() !== 'stream-ok') throw new Error('runtime fetch failed');
  console.log('dsh web: http://127.0.0.1:' + port + '/?token=fresh-token');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
main().catch(error => { console.error(error); process.exit(1); });
`)
  const port = String(await freePort())
  const env = { DSH_DEV_PORT: port }
  await writeFile(log, 'dsh web: http://127.0.0.1:3099/?token=stale-token\n')
  const detached = await run(env, ['--detach'])
  assert.equal(detached.code, 0, detached.output)
  assert.match(detached.output, /fresh-token/)
  assert.doesNotMatch(detached.output, /stale-token/)
  assert.match(detached.output, /authenticated ontology-list returned HTTP 200/)
  const [pid, start] = (await readFile(pidFile, 'utf8')).trim().split(' ')
  assert.match(start, /^\d+$/)
  assert.match(await readFile('/proc/' + pid + '/cmdline', 'utf8'), /bin\.js/)
  const procFields = (await readFile('/proc/' + pid + '/stat', 'utf8')).split(') ')[1].split(' ')
  assert.equal(procFields[3], pid, 'detached child must own a separate session')
  assert.ok((await readdir(root)).some(name => name.startsWith('web.log.previous.')))
  const artifacts = async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/artifact-probe', {
      headers: { Cookie: 'fixture=yes', Origin: 'http://127.0.0.1:' + port },
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const original = await artifacts()
  assert.equal(original.host, 'A')
  assert.equal(original.client, 'client-A\n')
  await writeFile(join(plugin, 'lib/index.js'), 'export const version = "B"\n')
  await writeFile(join(plugin, 'lib/client.js'), 'client-B\n')
  const unchanged = await artifacts()
  assert.equal(unchanged.host, 'A')
  assert.equal(unchanged.client, 'client-A\n', 'building the checkout must not hot-publish a client against the old Host')
  assert.equal(unchanged.artifact, original.artifact)
  const duplicate = await run(env, ['--detach'])
  assert.notEqual(duplicate.code, 0)
  assert.equal(await readFile(pidFile, 'utf8'), pid + ' ' + start + '\n')
  assert.equal((await run(env, ['--stop'])).code, 0)
  await stopped(pid)

  const failedInstall = await run({ ...env, FAIL_INSTALL: '1' }, ['--detach'])
  assert.equal(failedInstall.code, 17, 'a failed snapshot installation must prevent server startup')
  assert.equal(await readFile(join(home, 'profiles/fixture/install-count'), 'utf8'), '1\n')
  const skippedInstall = await run({ ...env, SKIP_INSTALL: '1' }, ['--detach'])
  assert.notEqual(skippedInstall.code, 0, 'package-manager success is not proof the intended build was installed')
  assert.match(skippedInstall.output, /profile did not install the pinned/)
  assert.doesNotMatch(skippedInstall.output, /health:/)
  assert.equal(await readFile(join(home, 'profiles/fixture/install-count'), 'utf8'), '1\n')
  const next = await run(env, ['--detach'])
  assert.equal(next.code, 0, next.output)
  const updated = await artifacts()
  assert.equal(updated.host, 'B')
  assert.equal(updated.client, 'client-B\n')
  assert.notEqual(updated.artifact, original.artifact)
  assert.equal(await readFile(join(original.artifact, 'lib/client.js'), 'utf8'), 'client-A\n', 'prior launch artifacts must remain readable')
  const nextPid = (await readFile(pidFile, 'utf8')).split(' ')[0]
  assert.equal((await run(env, ['--stop'])).code, 0)
  await stopped(nextPid)
  const reused = await run(env, ['--detach'])
  assert.equal(reused.code, 0, reused.output)
  assert.equal((await artifacts()).artifact, updated.artifact)
  assert.equal(await readFile(join(home, 'profiles/fixture/install-count'), 'utf8'), '1\n1\n', 'an unchanged build must not reinstall the package')
  const reusedPid = (await readFile(pidFile, 'utf8')).split(' ')[0]
  assert.equal((await run(env, ['--stop'])).code, 0)
  await stopped(reusedPid)

  const early = await run({ ...env, FAIL_EARLY: '1' }, ['--detach'])
  assert.equal(early.code, 42, early.output)
  assert.doesNotMatch(early.output, /health:|fresh-token/)
  const bad = await run({ ...env, FAIL_HEALTH: '1', DSH_DEV_STARTUP_SECONDS: '3' }, ['--detach'])
  assert.notEqual(bad.code, 0)
  assert.match(bad.output, /readiness failed/)
  assert.match(bad.output, /HTTP 404/)
  const later = await run({ ...env, EXIT_LATER: '1' })
  assert.equal(later.code, 43, later.output)

  const foreground = launch(env)
  await until(() => foreground.output().includes('health:'))
  const foregroundPid = (await readFile(pidFile, 'utf8')).split(' ')[0]
  foreground.child.kill('SIGINT')
  assert.equal((await foreground.done).code, 130)
  await stopped(foregroundPid)

  const safe = await run(env, ['--detach', '--safe-runtime'])
  assert.equal(safe.code, 0, safe.output)
  const safePid = (await readFile(pidFile, 'utf8')).split(' ')[0]
  const safeArgs = (await readFile('/proc/' + safePid + '/cmdline', 'utf8')).split('\0')
  for (const flag of ['--no-opt', '--no-maglev', '--no-sparkplug', '--regexp-interpret-all']) assert.ok(safeArgs.includes(flag))
  assert.ok(!safeArgs.includes('--jitless'))
  assert.equal((await run(env, ['--stop'])).code, 0)
  await stopped(safePid)
  const noWasm = await run({ ...env, NODE_OPTIONS: '--jitless' }, ['--detach'])
  assert.notEqual(noWasm.code, 0, 'inbound HTTP alone must not hide broken outbound fetch')
  assert.doesNotMatch(noWasm.output, /health:/)
  assert.match(await readFile(log, 'utf8'), /WebAssembly is not defined/)

  // Opt-in real service-manager test. Never kill the user's running DSH instance.
  if (process.env.KG_TEST_SYSTEMD === '1') {
    supervisedUnit = 'kg-supervisor-test-' + process.pid + '.service'
    const unit = await readFile(new URL('./dsh-kgsrc-web.service', import.meta.url), 'utf8')
    const properties = unit.split('\n').map(line => line.trim()).filter(line => /^(StartLimit|Type=|Restart|SuccessExitStatus=|KillMode=|TimeoutStopSec=|UMask=)/.test(line))
    const fixtureEnv = { DSH_REPO: harness, DSH_HOME: home, DSH_DEV_NODE: process.execPath,
      DSH_DEV_PROFILE: 'fixture', DSH_DEV_PORT: port, DSH_DEV_LOG: log, DSH_DEV_PID: pidFile,
      DSH_DEV_STARTUP_SECONDS: '8' }
    const serviceArgs = ['--user', '--unit=' + supervisedUnit,
      ...properties.map(x => '--property=' + x), ...Object.entries(fixtureEnv).map(([k, v]) => '--setenv=' + k + '=' + v),
      '/bin/bash', script, '--safe-runtime']
    await exec('systemd-run', serviceArgs)
    const show = async key => (await exec('systemctl', ['--user', 'show', supervisedUnit, '--property=' + key, '--value'])).stdout.trim()
    assert.equal(await show('StartLimitIntervalUSec'), '5min')
    assert.equal(await show('StartLimitBurst'), '3')
    const livePid = async () => {
      const value = (await readFile(pidFile, 'utf8').catch(() => '')).split(' ')[0]
      if (!value) return null
      try {
        const stat = await readFile('/proc/' + value + '/stat', 'utf8')
        if (stat.includes(') Z ')) return null
        const response = await fetch('http://127.0.0.1:' + port + '/api/dsh-knowledge-graph/ontology-list', {
          headers: { Cookie: 'fixture=yes', Origin: 'http://127.0.0.1:' + port }, signal: AbortSignal.timeout(500),
        })
        if (response.status !== 200) return null
        const mainPid = await show('MainPID')
        const journal = await exec('journalctl', ['--user', '_PID=' + mainPid, '--no-pager', '-o', 'cat'])
        return journal.stdout.includes('health: dsh-knowledge-graph authenticated') ? value : null
      } catch { return null }
    }
    let previous
    await until(async () => { previous = await livePid(); return previous }, 400)
    for (let crash = 0; crash < 3; crash++) {
      // SIGKILL exercises uncatchable process death without producing a core dump.
      process.kill(Number(previous), 'SIGKILL')
      await stopped(previous)
      if (crash < 2) {
        let replacement
        await until(async () => { replacement = await livePid(); return replacement && replacement !== previous }, 500)
        previous = replacement
      }
    }
    // Some systemd versions retain Result=exit-code after hitting the limit.
    // A final failed state (not activating/auto-restart) plus the exact restart
    // count proves throttling without depending on that version-specific label.
    await until(async () => (await show('ActiveState')) === 'failed', 500)
    assert.equal(await show('NRestarts'), '3')
    assert.equal(await livePid(), null, 'restart storm must stop at the configured limit')
    await exec('systemctl', ['--user', 'reset-failed', supervisedUnit])
    supervisedUnit = 'kg-supervisor-stop-test-' + process.pid + '.service'
    serviceArgs[1] = '--unit=' + supervisedUnit
    await exec('systemd-run', serviceArgs)
    await until(async () => { previous = await livePid(); return previous }, 400)
    await exec('systemctl', ['--user', 'stop', supervisedUnit])
    await stopped(previous)
    assert.equal(await show('ActiveState'), 'inactive', 'explicit stop must not restart')
  }

  // A stale record must not kill an unrelated process, even if it owns the port.
  const unrelated = createServer()
  await new Promise(resolve => unrelated.listen(Number(port), '127.0.0.1', resolve))
  try {
    await writeFile(pidFile, process.pid + ' 0\n')
    assert.equal((await run(env, ['--stop'])).code, 0)
    assert.equal(unrelated.listening, true)
    assert.notEqual((await run(env, ['--detach'])).code, 0)
  } finally { await new Promise(resolve => unrelated.close(resolve)) }
  console.log(JSON.stringify({ ok: true, staleLog: true, authenticatedReadiness: true, realPid: true,
    earlyExit: true, foregroundExitCode: true, signalCleanup: true, failedHealthStops: true, unrelatedProcessPreserved: true,
    safeRuntime: true, nativeFetchStream: true, pinnedHostAndClient: true, nextLaunchUpdatesBoth: true,
    failedInstallationStops: true, unchangedBuildReused: true, supervisedRecovery: !!supervisedUnit }))
} finally {
  if (supervisedUnit) {
    await exec('systemctl', ['--user', 'stop', supervisedUnit]).catch(() => {})
    await exec('systemctl', ['--user', 'reset-failed', supervisedUnit]).catch(() => {})
  }
  for (const child of children) child.kill('SIGTERM')
  await run({}, ['--stop'])
  await rm(root, { recursive: true, force: true })
}
