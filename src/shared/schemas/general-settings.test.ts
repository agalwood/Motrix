import { describe, expect, it } from 'vitest'
import { SaveGeneralSettingsRequestSchema } from './general-settings'

const directories = { addFavorites: [], removeFavorites: [], removeRecent: [] }

describe('SaveGeneralSettingsRequestSchema', () => {
  it('accepts dirty General fields and exact literal directory deltas', () => {
    const request = {
      app: { defaultSaveDir: '/saved ', notifyOnError: false },
      directories: {
        ...directories,
        addFavorites: ['/favorite '],
        removeRecent: ['/old '],
      },
    }
    expect(SaveGeneralSettingsRequestSchema.parse(request)).toEqual(request)
    expect(
      SaveGeneralSettingsRequestSchema.parse({ app: {}, directories })
    ).toEqual({ app: {}, directories })
  })

  it.each([
    {},
    { app: {}, directories, extra: true },
    { app: { theme: 'dark' }, directories },
    {
      app: { directoryPreferences: { favorites: [], recent: [] } },
      directories,
    },
    { app: { notifyOnError: 'false' }, directories },
    { app: { notifyOnError: undefined }, directories },
    { app: { defaultSaveDir: '' }, directories },
    { app: {}, directories: { ...directories, clearRecent: true } },
    {
      app: {},
      directories: { ...directories, addFavorites: Array(21).fill('/a') },
    },
    {
      app: {},
      directories: { ...directories, removeFavorites: Array(21).fill('/a') },
    },
    {
      app: {},
      directories: { ...directories, removeRecent: Array(11).fill('/a') },
    },
    {
      app: {},
      directories: { ...directories, addFavorites: ['a'.repeat(4097)] },
    },
  ])('rejects malformed or excessive request %j', (request) => {
    expect(SaveGeneralSettingsRequestSchema.safeParse(request).success).toBe(
      false
    )
  })
})
