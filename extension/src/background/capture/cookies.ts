import type { Cookie } from '@motrix/mdxp'

export interface BrowserCookieLike {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  expirationDate?: number // unix seconds
}

function mapSameSite(s: string): Cookie['sameSite'] {
  switch (s) {
    case 'strict':
      return 'strict'
    case 'lax':
      return 'lax'
    case 'no_restriction':
      return 'none'
    default:
      return 'unspecified'
  }
}

export function mapCookies(src: BrowserCookieLike[]): Cookie[] {
  return src.map((c) => {
    const base: Cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: mapSameSite(c.sameSite),
    }
    return typeof c.expirationDate === 'number'
      ? { ...base, expiresAt: Math.round(c.expirationDate * 1000) }
      : base
  })
}
