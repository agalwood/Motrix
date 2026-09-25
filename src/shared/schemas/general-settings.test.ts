import { TEST_GENERAL_REVISION } from '@test-utils/general-settings'
import { describe, expect, it } from 'vitest'
import { SaveGeneralSettingsRequestSchema } from './general-settings'

const directories = { addFavorites: [], removeFavorites: [], removeRecent: [] }

describe('SaveGeneralSettingsRequestSchema', () => {
  it('accepts dirty General fields and exact literal directory deltas', () => {
    const request = {
      expectedRevision: TEST_GENERAL_REVISION,
      app: {
        defaultSaveDir: '/saved ',
        notifyOnError: false,
        notifyInAppOnComplete: false,
        notifyInAppOnError: false,
        notificationBadgeStyle: 'dot',
      },
      directories: {
        ...directories,
        addFavorites: ['/favorite '],
        removeRecent: ['/old '],
      },
    }
    expect(SaveGeneralSettingsRequestSchema.parse(request)).toEqual(request)
    expect(
      SaveGeneralSettingsRequestSchema.parse({
        expectedRevision: TEST_GENERAL_REVISION,
        app: {},
        directories,
      })
    ).toEqual({ expectedRevision: TEST_GENERAL_REVISION, app: {}, directories })
  })

  it.each([
    {},
    { expectedRevision: undefined, app: {}, directories },
    { expectedRevision: 'not-a-revision', app: {}, directories },
    { app: {}, directories, extra: true },
    { app: { theme: 'dark' }, directories },
    {
      app: { directoryPreferences: { favorites: [], recent: [] } },
      directories,
    },
    { app: { notifyOnError: 'false' }, directories },
    { app: { notifyInAppOnComplete: 'false' }, directories },
    { app: { notifyInAppOnError: undefined }, directories },
    { app: { notificationBadgeStyle: 'off' }, directories },
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
    expect(
      SaveGeneralSettingsRequestSchema.safeParse({
        expectedRevision: TEST_GENERAL_REVISION,
        ...request,
      }).success
    ).toBe(false)
  })
})
