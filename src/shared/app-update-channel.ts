import type { AppUpdateChannel } from './types/settings'

const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Stable and beta are the only published application update channels. */
export function isVersionAllowedForChannel(
  version: string,
  channel: AppUpdateChannel
): boolean {
  const match = STRICT_SEMVER_PATTERN.exec(version)
  if (!match) return false
  const prerelease = match[4]
  return (
    prerelease === undefined ||
    (channel === 'beta' && prerelease.split('.')[0] === 'beta')
  )
}
