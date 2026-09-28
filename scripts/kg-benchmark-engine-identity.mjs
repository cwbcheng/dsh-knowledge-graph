import { hostBuildSha256 } from '../lib/index.js'

export { hostBuildSha256 }

export function verifyBenchmarkEngineIdentity(identity) {
  if (!/^[a-f0-9]{64}$/.test(identity?.hostBuildSha256 || '') ||
      identity.hostBuildSha256 !== hostBuildSha256) {
    throw new Error('isolated Host runtime build differs from the local benchmark build')
  }
  return { hostBuildSha256 }
}
