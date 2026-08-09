import { createHash } from 'node:crypto'
import type { BeforeCreateHttpContextDTO } from '@shared/types/plugin-hooks'

export interface AuditView {
  type: 'http'
  sourceHost: string
  uris: string[]
  saveDir: string
  headerNames: string[]
  headerValueDigests: string[]
  proxyScheme?: string
  createdBy: string
  requestedAt: number
}

export function sanitizeForAudit(dto: BeforeCreateHttpContextDTO): AuditView {
  const u = new URL(dto.sourceUrl)
  return {
    type: 'http',
    sourceHost: `${u.protocol}//${u.host}`,
    uris: dto.uris.map((s) => {
      try {
        const v = new URL(s)
        return `${v.protocol}//${v.host}`
      } catch {
        return ''
      }
    }),
    saveDir: dto.saveDir,
    headerNames: dto.headers.map((h) => h.name),
    headerValueDigests: dto.headers.map((h) =>
      createHash('sha256').update(h.value).digest('hex')
    ),
    proxyScheme: dto.proxy
      ? new URL(dto.proxy).protocol.replace(':', '')
      : undefined,
    createdBy: dto.createdBy,
    requestedAt: dto.requestedAt,
  }
}
