import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants, release, setPriority, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Standalone, synthetic workloads only: no DSH boot, real database, or model calls.
const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const positive = (name, fallback, max) => {
  const n = Number(option(name, fallback));
  assert(Number.isInteger(n) && n > 0 && n <= max, `Invalid ${name}`);
  return n;
};
const safeFlags = ['--no-opt', '--no-maglev', '--no-sparkplug', '--regexp-interpret-all'];
const digest = value => createHash('sha256').update(value).digest('hex');

async function workload(mode, milliseconds) {
  assert(['pure', 'sqlite', 'builtin', 'flock', 'combined'].includes(mode));
  try { setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Record test results even without priority permission. */ }
  const dir = mkdtempSync(join(tmpdir(), 'kg-isolation-child-'));
  const native = createRequire(import.meta.url);
  const harness = option('--harness', '/mnt/d/github/deepseek-harness');
  let db;
  let insert;
  let query;
  let addon;
  let lock;
  const fds = new Set();
  const enabled = name => mode === name || mode === 'combined';
  let cycles = 0;
  let maxRss = 0;
  try {
    if (enabled('sqlite')) {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
      insert = db.prepare('INSERT INTO sample VALUES (?, ?)');
      query = db.prepare('SELECT body FROM sample WHERE id = ?');
    }
    if (enabled('builtin')) {
      addon = native(join(harness, 'packages/boot/app-boot/node_modules/node-addon-require-builtin'));
    }
    if (enabled('flock')) {
      lock = native(join(harness, 'native/system/packages/linux-x64/bin/glibc/system.node'));
    }
    const initialMaps = process.platform === 'linux' ? readFileSync('/proc/self/maps', 'utf8') : '';
    console.log(JSON.stringify({ event: 'start', mode, pid: process.pid, node: process.version,
      addons: [...new Set(initialMaps.split('\n').filter(line => /\.node$/.test(line)).map(line => line.slice(line.indexOf('/'))))] }));
    const guard = Buffer.alloc(64 * 1024 * 1024);
    for (let i = 0; i < guard.length; i += 4) guard.writeUInt32LE((i ^ 0xa55ac33c) >>> 0, i);
    const expectedHash = digest(guard);
    const started = performance.now();
    let lastLog = started;
    while (performance.now() - started < milliseconds) {
      const records = Array.from({ length: 2048 }, (_, id) => ({
        id, text: `node-${id}-cycle-${cycles}`, nested: { score: id * 17 + cycles },
      }));
      const text = JSON.stringify(records);
      const parsed = JSON.parse(text);
      assert.equal(parsed.length, records.length);
      for (let i = 0; i < parsed.length; i++) {
        if (parsed[i].id !== i || parsed[i].nested?.score !== i * 17 + cycles) {
          console.log(JSON.stringify({ event: 'mismatch', cycles, i, original: records[i],
            parsed: parsed[i], keys: Object.keys(parsed[i]), reparsed: JSON.parse(text)[i],
            textSlice: text.slice(Math.max(0, text.indexOf(`node-${i}-cycle-${cycles}`) - 40),
              text.indexOf(`node-${i}-cycle-${cycles}`) + 100) }));
        }
        assert.equal(parsed[i].id, i);
        assert.equal(parsed[i].nested.score, i * 17 + cycles);
        assert.equal(parsed[i].text, `node-${i}-cycle-${cycles}`);
        assert(/^node-\d+-cycle-\d+$/.test(parsed[i].text));
      }
      if (db) {
        db.exec('BEGIN');
        try {
          db.exec('DELETE FROM sample');
          for (const row of records.slice(0, 64)) insert.run(row.id, JSON.stringify(row));
          for (let i = 0; i < 64; i++) assert.deepEqual(JSON.parse(query.get(i).body), records[i]);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      if (addon) {
        const loader = addon.requireBuiltin('internal/modules/esm/loader');
        assert.equal(loader.getOrInitializeCascadedLoader(), loader.getOrInitializeCascadedLoader());
        assert.equal(typeof addon.requireBuiltin('internal/modules/cjs/loader').Module, 'function');
        assert(Array.isArray(addon.requireBuiltin('internal/modules/esm/utils').getDefaultConditions()));
        // Node uses primordials.SafeSet, which does not inherit the public Set prototype.
        assert.equal(addon.requireBuiltin('internal/modules/helpers').getCjsConditions().has('require'), true);
      }
      if (lock) {
        const path = join(dir, 'synthetic.lock');
        const owner = openSync(path, 'a+');
        fds.add(owner);
        const contender = openSync(path, 'a+');
        fds.add(contender);
        const tryLock = fd => new Promise(resolve => lock.tryLock(fd, resolve));
        assert.equal(await tryLock(owner), 0);
        assert.equal(await tryLock(contender), constants.errno.EAGAIN);
        closeSync(owner);
        fds.delete(owner);
        assert.equal(await tryLock(contender), 0);
        closeSync(contender);
        fds.delete(contender);
      }
      if (cycles % 16 === 0) {
        assert.equal(digest(guard), expectedHash, 'Persistent buffer changed unexpectedly');
        globalThis.gc?.();
      }
      cycles++;
      maxRss = Math.max(maxRss, process.memoryUsage().rss);
      if (performance.now() - lastLog >= 5000) {
        console.log(JSON.stringify({ event: 'progress', mode, cycles, maxRss }));
        lastLog = performance.now();
      }
    }
    assert.equal(digest(guard), expectedHash);
    if (db) assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const maps = process.platform === 'linux' ? readFileSync('/proc/self/maps', 'utf8') : '';
    const addons = [...new Set(maps.split('\n').filter(line => /\.node$/.test(line)).map(line => line.slice(line.indexOf('/'))))];
    if (mode === 'pure' || mode === 'sqlite') assert.equal(addons.length, 0, 'Unexpected native addon in control');
    console.log(JSON.stringify({ event: 'complete', mode, cycles, maxRss, addons,
      binding: addon?.getBindingInfo(), elapsedMs: Math.round(performance.now() - started),
      node: process.version, v8: process.versions.v8, execArgv: process.execArgv }));
  } finally {
    for (const fd of fds) closeSync(fd);
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function runChild(executable, flags, childArgs, timeout) {
  const env = { ...process.env };
  // Do not inherit preload hooks or diagnostic flags into the control process.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = spawnSync(executable, [...flags, '--expose-gc', '--max-old-space-size=256', script, ...childArgs], {
    timeout, encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL',
  });
  const events = (result.stdout || '').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { event: 'unparsed', text: line }; }
  });
  const complete = events.find(event => event.event === 'complete');
  return { passed: result.status === 0 && !result.signal && !result.error && !!complete,
    status: result.status, signal: result.signal, error: result.error?.message,
    events, stderr: result.stderr, complete };
}

if (args.includes('--child')) {
  await workload(option('--case'), positive('--seconds', 15, 300) * 1000);
} else if (args.includes('--fixture-timeout')) {
  setInterval(() => {}, 1000);
} else if (args.includes('--fixture-failure')) {
  console.log(JSON.stringify({ event: 'complete' }));
  process.exitCode = 7;
} else if (args.includes('--self-test')) {
  assert.equal(runChild(process.execPath, [], ['--fixture-failure'], 5000).passed, false);
  const timeout = runChild(process.execPath, [], ['--fixture-timeout'], 500);
  assert.equal(timeout.passed, false);
  assert.match(timeout.error, /ETIMEDOUT/);
  const invalid = runChild(process.execPath, [], ['--child', '--case', 'invalid'], 5000);
  assert.equal(invalid.passed, false);
  const control = runChild(process.execPath, [], ['--child', '--case', 'pure', '--seconds', '1'], 10000);
  assert.equal(control.passed, true, JSON.stringify(control));
  console.log('isolation runner self-test passed (nonzero exit, timeout, invalid case, valid control)');
} else {
  const seconds = positive('--seconds', 15, 300);
  const rounds = positive('--rounds', 2, 10);
  const modes = option('--cases', process.platform === 'linux' ? 'pure,sqlite,builtin,flock,combined' : 'pure,sqlite').split(',');
  assert(modes.every(mode => ['pure', 'sqlite', 'builtin', 'flock', 'combined'].includes(mode)));
  const runtime = resolve(option('--node', process.execPath));
  const flags = args.includes('--safe-runtime') ? safeFlags : [];
  const reportDir = mkdtempSync(join(tmpdir(), 'kg-runtime-isolation-'));
  const report = { startedAt: new Date().toISOString(), platform: process.platform, kernel: release(),
    runtime, runtimeSha256: digest(readFileSync(runtime)), scriptSha256: digest(readFileSync(script)),
    flags, seconds, rounds, results: [] };
  console.log(`Report directory: ${reportDir}`);
  for (let round = 0; round < rounds; round++) {
    // Reverse the second round so a quiet/noisy time window is not mistaken for component causality.
    const ordered = round % 2 ? [...modes].reverse() : modes;
    for (const mode of ordered) {
      const childArgs = ['--child', '--case', mode, '--seconds', String(seconds), '--harness',
        option('--harness', '/mnt/d/github/deepseek-harness')];
      const startedAt = new Date().toISOString();
      const result = runChild(runtime, flags, childArgs, seconds * 1000 + 30000);
      report.results.push({ round: round + 1, mode, startedAt, ...result });
      writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ round: round + 1, mode, passed: result.passed,
        status: result.status, signal: result.signal, cycles: result.complete?.cycles,
        maxRss: result.complete?.maxRss, error: result.error }));
    }
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.results.every(result => result.passed);
  writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
