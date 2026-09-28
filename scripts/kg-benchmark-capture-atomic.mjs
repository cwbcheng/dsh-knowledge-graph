import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

export function acquireBenchmarkCaptureLock(path) {
  const lockPath = path + '.lock'
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), nonce: randomUUID() }
  let fd
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('capture is locked; inspect ' + lockPath + ' and its owner before removing a stale lock')
    }
    throw error
  }
  try {
    writeFileSync(fd, JSON.stringify(owner) + '\n')
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(lockPath)
    throw error
  }
  closeSync(fd)
  return () => {
    try {
      if (JSON.parse(readFileSync(lockPath, 'utf8')).nonce === owner.nonce) unlinkSync(lockPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

export function saveBenchmarkCapture(path, capture) {
  const pending = path + '.pending-' + randomUUID()
  const fd = openSync(pending, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(capture, null, 2) + '\n')
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(pending, path)
}
