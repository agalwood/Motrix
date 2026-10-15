import {
  hostOf,
  hostSuffixMatch,
  MIB,
  type TakeoverConfig,
  type TakeoverRule,
  type TakeoverTarget,
} from '@/shared/takeover'

function ruleMatches(rule: TakeoverRule, target: TakeoverTarget): boolean {
  const { match } = rule
  if (match.domains && match.domains.length > 0) {
    const host = hostOf(target.url)
    const pageHost = hostOf(target.pageUrl)
    // Site exclusions follow the originating page even when its files are
    // served by a different CDN. Allow rules still match the download host.
    if (
      !match.domains.some(
        (d) =>
          hostSuffixMatch(host, d) ||
          (rule.action === 'chrome' && hostSuffixMatch(pageHost, d))
      )
    )
      return false
  }
  if (typeof match.minSizeMB === 'number') {
    // Unknown sizes use unknownSizeAction after the other rules are checked.
    if (target.sizeBytes === null) return false
    if (target.sizeBytes >= match.minSizeMB * MIB) return false
  }
  if (match.mimePatterns && match.mimePatterns.length > 0) {
    if (!match.mimePatterns.some((p) => target.mime.includes(p))) return false
  }
  return true
}

export function decideTakeover(
  config: TakeoverConfig,
  target: TakeoverTarget
): 'motrix' | 'chrome' {
  // An explicit right-click "Download with Motrix" is direct user intent, not
  // a candidate for the auto-interception policy. Hand it to Motrix regardless
  // of config.enabled / rules / defaultAction (those gate automatic capture
  // only). Without this, the right-click silently no-ops whenever "Send
  // eligible downloads to Motrix" is off.
  if (target.origin === 'context-menu') return 'motrix'
  if (!config.enabled) return 'chrome'
  for (const rule of config.rules) {
    if (ruleMatches(rule, target)) {
      return rule.action === 'motrix' ? 'motrix' : 'chrome' // 'ask' reserved for Plan 2 -> chrome
    }
  }
  return target.sizeBytes === null
    ? (config.unknownSizeAction ?? 'chrome')
    : config.defaultAction
}
