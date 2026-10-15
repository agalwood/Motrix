import { hostSuffixMatch } from '@/shared/takeover'

/** Seed list of sensitive host suffixes (financial / government / medical). User-extendable. */
export const SENSITIVE_SUFFIXES: string[] = [
  'gov',
  'mil',
  'gov.uk',
  'gov.cn',
  'bank',
  'paypal.com',
  'nhs.uk',
]

export function isSensitiveDomain(host: string): boolean {
  const h = host.toLowerCase()
  return SENSITIVE_SUFFIXES.some((suffix) => hostSuffixMatch(h, suffix))
}
