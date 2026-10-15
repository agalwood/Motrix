import {
  hostSuffixMatch,
  type TakeoverConfig,
  type TakeoverRule,
} from '@/shared/takeover'

export function siteDomain(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? '')
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.hostname.toLowerCase()
      : null
  } catch {
    return null
  }
}

function isDomainExclusion(rule: TakeoverRule): boolean {
  return (
    rule.action === 'chrome' &&
    rule.match.minSizeMB === undefined &&
    !rule.match.mimePatterns?.length
  )
}

/** Prefer a parent exclusion so the quick switch never silently removes a
 * rule that also protects other subdomains. */
export function excludedSiteDomain(
  config: TakeoverConfig,
  domain: string
): string | null {
  const matches = config.rules
    .filter(isDomainExclusion)
    .flatMap((rule) => rule.match.domains ?? [])
    .map((entry) => entry.replace(/^\.+/, '').toLowerCase())
    .filter((entry) => hostSuffixMatch(domain, entry))
  return matches.find((entry) => entry !== domain) ?? matches[0] ?? null
}

export function withSiteExcluded(
  config: TakeoverConfig,
  domain: string,
  excluded: boolean
): TakeoverConfig {
  if (
    !domain ||
    siteDomain(`https://${domain}`) !== domain ||
    typeof excluded !== 'boolean'
  )
    throw new Error('invalid site exclusion')
  const inherited = excludedSiteDomain(config, domain)
  if (inherited && inherited !== domain) return config
  if (excluded && inherited) return config
  const rules = config.rules.flatMap((rule) => {
    if (!isDomainExclusion(rule) || !rule.match.domains) return [rule]
    const domains = rule.match.domains.filter(
      (entry) => entry.replace(/^\.+/, '').toLowerCase() !== domain
    )
    if (domains.length === rule.match.domains.length) return [rule]
    return domains.length
      ? [{ ...rule, match: { ...rule.match, domains } }]
      : []
  })
  if (excluded)
    rules.unshift({
      id: `site-exclusion:${domain}`,
      match: { domains: [domain] },
      action: 'chrome',
    })
  return { ...config, rules }
}
