import { ErrorCode } from '@shared/errors'
import { Queries } from '@shared/protocol/queries'
import { describe, expect, it } from 'vitest'
import {
  unsupportedLegacyImportCommands,
  unsupportedLegacyImportQueries,
} from './legacy-import'

describe('server legacy import boundary', () => {
  it('explicitly rejects every desktop import channel before interpreting a supplied path', async () => {
    const handlers = {
      ...unsupportedLegacyImportCommands(),
      ...unsupportedLegacyImportQueries(),
    }
    expect(Object.keys(handlers)).toHaveLength(15)
    await expect(
      handlers[Queries.GetLegacyImportNavigation]?.()
    ).resolves.toEqual({ detected: false, invitationPending: false })
    for (const [channel, handler] of Object.entries(handlers)) {
      if (channel === Queries.GetLegacyImportNavigation) continue
      await expect(
        handler?.({ root: '/untrusted/path', sourceHandle: '../../etc/passwd' })
      ).rejects.toMatchObject({ code: ErrorCode.EngineNotSupported })
    }
  })
})
