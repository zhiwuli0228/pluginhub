/**
 * Local discovery + launch — public API.
 *
 * @module local-detect
 */

export { listListeningPorts, invalidatePortCache, parseWindowsNetstat, parseLsof, parseProcNetTcp } from './ports.js'
export { resolveOrigin, probeFingerprint, normaliseOrigin, refreshAfterLaunch } from './detector.js'
export { launchAndWait } from './launcher.js'
export type { LaunchResult } from './launcher.js'
export type {
  DiscoverSpec,
  FingerprintSpec,
  LaunchSpec,
  Resolution,
  ResolutionSource,
} from './types.js'
