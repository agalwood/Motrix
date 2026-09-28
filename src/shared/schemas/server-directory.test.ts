import { describe, expect, it } from 'vitest'
import {
  AllowedSaveDirsSchema,
  CreateServerDirectoryRequestSchema,
  CreateServerDirectoryResultSchema,
  ListServerDirectoriesRequestSchema,
  ListServerDirectoriesResultSchema,
  ServerDirectoryLocationsSchema,
  ValidateServerDirectoryRequestSchema,
} from './server-directory'

describe('server directory contracts', () => {
  const listing = {
    ok: true,
    value: {
      path: '/',
      parentPath: null,
      breadcrumbs: [{ name: '/', path: '/' }],
      entries: [{ name: 'folder', path: '/folder' }],
      truncated: false,
      canCreate: true,
    },
  }
  it.each([undefined, 0, -1000, 1700000000123.5])(
    'accepts optional finite listing timestamps: %s',
    (modifiedAt) => {
      const result = {
        ...listing,
        value: {
          ...listing.value,
          entries: [
            {
              ...listing.value.entries[0],
              ...(modifiedAt === undefined ? {} : { modifiedAt }),
            },
          ],
        },
      }
      expect(ListServerDirectoriesResultSchema.parse(result)).toEqual(result)
    }
  )
  it.each([Number.NaN, Infinity, -Infinity, null, '1000'])(
    'rejects invalid listing timestamps: %s',
    (modifiedAt) => {
      expect(
        ListServerDirectoriesResultSchema.safeParse({
          ...listing,
          value: {
            ...listing.value,
            entries: [{ ...listing.value.entries[0], modifiedAt }],
          },
        }).success
      ).toBe(false)
    }
  )
  it('keeps timestamps out of breadcrumbs, create results and saved locations', () => {
    const entry = { name: 'folder', path: '/folder', modifiedAt: 1000 }
    expect(
      ListServerDirectoriesResultSchema.safeParse({
        ...listing,
        value: { ...listing.value, breadcrumbs: [entry] },
      }).success
    ).toBe(false)
    expect(
      CreateServerDirectoryResultSchema.safeParse({ ok: true, value: entry })
        .success
    ).toBe(false)
    expect(
      ServerDirectoryLocationsSchema.safeParse({
        common: [],
        favorites: [{ ...entry, sourcePaths: ['/folder'] }],
        recent: [],
      }).success
    ).toBe(false)
    expect(
      ServerDirectoryLocationsSchema.safeParse({
        common: [{ kind: 'default', path: '/folder', modifiedAt: 1000 }],
        favorites: [],
        recent: [],
      }).success
    ).toBe(false)
  })
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
