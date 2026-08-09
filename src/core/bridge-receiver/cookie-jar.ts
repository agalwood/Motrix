import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface CookieInput {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  expiresAt?: number
}

/**
 * Write a Netscape HTTP Cookie File. aria2's `--load-cookies` consumes
 * this format. Each line is tab-separated:
 *
 *   domain  flag  path  secure  expires  name  value
 *
 * `flag` is "TRUE" if the cookie applies to subdomains (domain starts
 * with a dot). `secure` is "TRUE" if HTTPS-only. `expires` is unix
 * seconds; 0 means session cookie.
 */
export async function writeCookieJar(
  filePath: string,
  cookies: ReadonlyArray<CookieInput>
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies) {
    const flag = c.domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const expires = c.expiresAt ?? 0
    lines.push(
      [c.domain, flag, c.path, secure, expires, c.name, c.value].join('\t')
    )
  }
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8')
}
