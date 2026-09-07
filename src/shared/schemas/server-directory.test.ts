import { describe, expect, it } from 'vitest'
import {
  AllowedSaveDirsSchema,
  CreateServerDirectoryRequestSchema,
  CreateServerDirectoryResultSchema,
  ListServerDirectoriesRequestSchema,
  ListServerDirectoriesResultSchema,
  ValidateServerDirectoryRequestSchema,
} from './server-directory'

describe('server directory contracts', () => {
  it.each([
    undefined,
    {},
    { path: '' },
    { path: '/a', extra: true },
    { path: 'x'.repeat(4097) },
    { path: '/a', showHidden: 'yes' },
  ])('rejects malformed list request %j', (request) => {
    expect(ListServerDirectoriesRequestSchema.safeParse(request).success).toBe(
      false
    )
  })
  it('preserves literal whitespace without allowing unbounded or unknown fields', () => {
    expect(
      CreateServerDirectoryRequestSchema.parse({ parentPath: '/a ', name: ' ' })
    ).toEqual({ parentPath: '/a ', name: ' ' })
    expect(
      CreateServerDirectoryRequestSchema.safeParse({
        parentPath: '/a',
        name: 'x'.repeat(256),
      }).success
    ).toBe(false)
    expect(
      ValidateServerDirectoryRequestSchema.safeParse({
        path: '/a',
        extra: true,
      }).success
    ).toBe(false)
  })
  it('parses only bounded result envelopes without raw error details', () => {
    expect(
      CreateServerDirectoryResultSchema.parse({
        ok: false,
        error: { code: 'creationOutcomeUnknown' },
      })
    ).toEqual({ ok: false, error: { code: 'creationOutcomeUnknown' } })
    expect(
      CreateServerDirectoryResultSchema.safeParse({
        ok: false,
        error: { code: 'unavailable', message: '/private/secret' },
      }).success
    ).toBe(false)
    expect(
      ListServerDirectoriesResultSchema.safeParse({
        ok: true,
        value: {
          path: '/',
          parentPath: null,
          breadcrumbs: [{ name: '/', path: '/' }],
          entries: Array.from({ length: 2001 }, () => ({
            name: 'a',
            path: '/a',
          })),
          truncated: true,
          canCreate: false,
        },
      }).success
    ).toBe(false)
    expect(
      AllowedSaveDirsSchema.parse({
        paths: [{ path: '/a' }],
        defaultPath: '/a ',
        allowCustom: false,
      }).defaultPath
    ).toBe('/a ')
  })
})
