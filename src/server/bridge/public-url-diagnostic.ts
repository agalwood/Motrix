export enum MdxpPublicUrlWarningReason {
  NotSet = 'not-set',
  Empty = 'empty',
  Invalid = 'invalid',
  UnsupportedProtocol = 'unsupported-protocol',
  LoopbackHost = 'loopback-host',
  UnspecifiedHost = 'unspecified-host',
}

export interface MdxpPublicUrlWarning {
  reason: MdxpPublicUrlWarningReason
  /** Safe to log: URL.origin omits credentials, path, query, and fragment. */
  origin?: string
}

export interface MdxpPublicUrlDiagnosticInput {
  mdxpHost: string
  publicUrl: string | undefined
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase()
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized.slice(1, -1)
  }
  return normalized
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

function isUnspecifiedHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return normalized === '0.0.0.0' || normalized === '::'
}

/**
 * Diagnose a public-URL configuration only when MDXP is exposed beyond the
 * local machine. The result is informational: callers must not reject or
 * rewrite the configured URL based on it.
 */
export function diagnoseMdxpPublicUrl({
  mdxpHost,
  publicUrl,
}: MdxpPublicUrlDiagnosticInput): MdxpPublicUrlWarning | undefined {
  if (isLoopbackHost(mdxpHost)) return undefined

  if (publicUrl === undefined) {
    return { reason: MdxpPublicUrlWarningReason.NotSet }
  }

  const candidate = publicUrl.trim()
  if (candidate === '') {
    return { reason: MdxpPublicUrlWarningReason.Empty }
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { reason: MdxpPublicUrlWarningReason.Invalid }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { reason: MdxpPublicUrlWarningReason.UnsupportedProtocol }
  }

  if (isLoopbackHost(parsed.hostname)) {
    return {
      reason: MdxpPublicUrlWarningReason.LoopbackHost,
      origin: parsed.origin,
    }
  }

  if (isUnspecifiedHost(parsed.hostname)) {
    return {
      reason: MdxpPublicUrlWarningReason.UnspecifiedHost,
      origin: parsed.origin,
    }
  }

  return undefined
}
