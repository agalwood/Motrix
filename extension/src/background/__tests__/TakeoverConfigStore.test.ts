import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TakeoverConfigStore } from '@/background/TakeoverConfigStore'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
    }
  }
}

beforeEach(() => {
  let backing: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const key = Array.isArray(k) ? k[0] : k
    return key && key in backing ? { [key]: backing[key] } : {}
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
})

describe('TakeoverConfigStore', () => {
  it('returns the default when nothing is stored', async () => {
    expect(await new TakeoverConfigStore().get()).toEqual(TAKEOVER_DEFAULT)
  })

  it('round-trips a saved config', async () => {
    const store = new TakeoverConfigStore()
    const cfg = {
      downloadMode: 'direct' as const,
      enabled: true,
      openTaskPanelAfterSubmit: true,
      consentAckVersion: 1,
      defaultAction: 'motrix' as const,
      unknownSizeAction: 'motrix' as const,
      rules: [
        {
          id: 'r1',
          match: { domains: ['ads.example.com'] },
          action: 'chrome' as const,
        },
      ],
    }
    await store.set(cfg)
    expect(await store.get()).toEqual(cfg)
  })

  it('falls back to the default on a malformed stored value', async () => {
    const _store = new TakeoverConfigStore()
    await browser.storage.local.set({ 'motrix.takeoverConfig': 'garbage' })
    expect(await new TakeoverConfigStore().get()).toEqual(TAKEOVER_DEFAULT)
  })

  it.each([undefined, 'invalid', 'chrome', 'motrix'])(
    'normalizes the unknown-size preference from existing storage: %s',
    async (unknownSizeAction) => {
      await browser.storage.local.set({
        'motrix.takeoverConfig': { ...TAKEOVER_DEFAULT, unknownSizeAction },
      })
      expect((await new TakeoverConfigStore().get()).unknownSizeAction).toBe(
        unknownSizeAction === 'motrix' ? 'motrix' : 'chrome'
      )
    }
  )

  it.each(['chrome', 'motrix'] as const)(
    'persists the selected unknown-size handler through other setting patches: %s',
    async (unknownSizeAction) => {
      const store = new TakeoverConfigStore()
      await store.patchTakeoverSettings({
        ...TAKEOVER_DEFAULT,
        unknownSizeAction,
      })
      await store.patchEnabled(true, 1)
      await store.patchSiteExclusion('example.com', true)
      await store.patchTaskPanelPreference(true)
      expect((await store.get()).unknownSizeAction).toBe(unknownSizeAction)
    }
  )

  it('falls back to default when a stored rule has an invalid action', async () => {
    const _store = new TakeoverConfigStore()
    await browser.storage.local.set({
      'motrix.takeoverConfig': {
        enabled: true,
        openTaskPanelAfterSubmit: true,
        consentAckVersion: 1,
        defaultAction: 'motrix',
        rules: [{ id: 'r', match: {}, action: 'bogus' }],
      },
    })
    expect(await new TakeoverConfigStore().get()).toEqual(TAKEOVER_DEFAULT)
  })
})

it('migrates existing preferences with automatic popup off', async () => {
  const { openTaskPanelAfterSubmit: _popup, ...legacy } = {
    ...TAKEOVER_DEFAULT,
    enabled: true,
    consentAckVersion: 1,
  }
  await browser.storage.local.set({ 'motrix.takeoverConfig': legacy })
  expect(await new TakeoverConfigStore().get()).toEqual({
    ...legacy,
    openTaskPanelAfterSubmit: false,
  })
})

it('serializes the quick toggle with settings saves and retains the new preference', async () => {
  const first = new TakeoverConfigStore()
  const second = new TakeoverConfigStore()
  await Promise.all([
    first.set({ ...TAKEOVER_DEFAULT, openTaskPanelAfterSubmit: true }),
    second.patchEnabled(true, 1),
  ])
  expect(await first.get()).toEqual({
    ...TAKEOVER_DEFAULT,
    enabled: true,
    openTaskPanelAfterSubmit: true,
    consentAckVersion: 1,
  })
  await second.patchEnabled(false)
  expect((await first.get()).openTaskPanelAfterSubmit).toBe(true)
})

it.each([true, false])(
  'preserves the legacy autoOpenPopup preference: %s',
  async (autoOpenPopup) => {
    const { openTaskPanelAfterSubmit: _popup, ...legacy } = TAKEOVER_DEFAULT
    await browser.storage.local.set({
      'motrix.takeoverConfig': { ...legacy, autoOpenPopup },
    })
    const store = new TakeoverConfigStore()
    expect((await store.get()).openTaskPanelAfterSubmit).toBe(autoOpenPopup)
    await store.patchTaskPanelPreference(!autoOpenPopup)
    expect((await store.get()).openTaskPanelAfterSubmit).toBe(!autoOpenPopup)
  }
)

it('prefers the new field over a conflicting legacy field', async () => {
  await browser.storage.local.set({
    'motrix.takeoverConfig': { ...TAKEOVER_DEFAULT, autoOpenPopup: true },
  })
  expect((await new TakeoverConfigStore().get()).openTaskPanelAfterSubmit).toBe(
    false
  )
})

it('preserves the latest general preference when saving download takeover settings', async () => {
  const store = new TakeoverConfigStore()
  const { openTaskPanelAfterSubmit: _popup, ...downloadSettings } =
    await store.get()
  await store.patchTaskPanelPreference(true)
  await store.patchTakeoverSettings({ ...downloadSettings, enabled: true })
  expect(await store.get()).toMatchObject({
    enabled: true,
    openTaskPanelAfterSubmit: true,
  })
})

it('serializes site and task panel patches with a takeover toggle without losing rules', async () => {
  const store = new TakeoverConfigStore()
  await Promise.all([
    store.patchSiteExclusion('example.com', true),
    store.patchTaskPanelPreference(true),
    store.patchEnabled(true, 1),
  ])
  expect(await store.get()).toMatchObject({
    enabled: true,
    openTaskPanelAfterSubmit: true,
    consentAckVersion: 1,
    rules: [{ match: { domains: ['example.com'] }, action: 'chrome' }],
  })
})

it('patches the download mode without losing concurrent takeover preferences', async () => {
  const store = new TakeoverConfigStore()
  await store.set({
    ...TAKEOVER_DEFAULT,
    enabled: true,
    openTaskPanelAfterSubmit: true,
  })
  await Promise.all([
    store.patchDownloadMode('confirm'),
    store.patchSiteExclusion('example.com', true),
  ])
  expect(await store.get()).toMatchObject({
    downloadMode: 'confirm',
    enabled: true,
    openTaskPanelAfterSubmit: true,
    rules: [expect.objectContaining({ match: { domains: ['example.com'] } })],
  })
})
