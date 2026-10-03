import { ErrorCode } from '@shared/errors'
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
    expect(Object.keys(handlers)).toHaveLength(12)
    for (const handler of Object.values(handlers)) {
      await expect(
        handler?.({ root: '/untrusted/path', sourceHandle: '../../etc/passwd' })
      ).rejects.toMatchObject({ code: ErrorCode.EngineNotSupported })
    }
  })
})
