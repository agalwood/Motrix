import { describe, expect, it } from 'vitest'
import {
  DirectoryPreferencesResultSchema,
  DirectoryPreferencesSchema,
  GetDirectoryPreferencesRequestSchema,
  MutateDirectoryPreferencesRequestSchema,
} from './directory-preferences'
import {
  ListServerDirectoryLocationsRequestSchema,
  ListServerDirectoryLocationsResultSchema,
} from './server-directory'

describe('directory preference contracts', () => {
  it.each([
    {},
    { action: 'addFavorite', path: '' },
    { action: 'addFavorite', path: '/ok', extra: true },
    { action: 'clearRecent', paths: ['/x'] },
    { action: 'removeFavorite', paths: [] },
    { action: 'removeRecent', paths: Array(11).fill('/x') },
    { action: 'removeFavorite', paths: Array(21).fill('/x') },
  ])('rejects malformed mutations %j', (request) => {
    expect(
      MutateDirectoryPreferencesRequestSchema.safeParse(request).success
    ).toBe(false)
  })
  it('bounds persisted records and preserves literal whitespace', () => {
    expect(
      DirectoryPreferencesSchema.parse({ favorites: ['/ '], recent: [] })
        .favorites
    ).toEqual(['/ '])
    expect(
      DirectoryPreferencesSchema.safeParse({
        favorites: Array(21).fill('/x'),
        recent: [],
      }).success
    ).toBe(false)
    expect(
      DirectoryPreferencesSchema.safeParse({
        favorites: [],
        recent: Array(11).fill('/x'),
      }).success
    ).toBe(false)
  })
  it('uses strict empty query requests and sanitized results', () => {
    for (const schema of [
      GetDirectoryPreferencesRequestSchema,
      ListServerDirectoryLocationsRequestSchema,
    ]) {
      expect(schema.safeParse({}).success).toBe(true)
      expect(schema.safeParse({ path: '/secret' }).success).toBe(false)
      expect(schema.safeParse(undefined).success).toBe(false)
    }
    for (const schema of [
      DirectoryPreferencesResultSchema,
      ListServerDirectoryLocationsResultSchema,
    ]) {
      expect(
        schema.safeParse({
          ok: false,
          error: { code: 'unavailable', message: '/secret' },
        }).success
      ).toBe(false)
    }
  })
})
