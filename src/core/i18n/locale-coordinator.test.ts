import type { SupportedLocale } from '@shared/constants/locales'
import { describe, expect, it, vi } from 'vitest'
import { LocaleCoordinator } from './locale-coordinator'

describe('LocaleCoordinator', () => {
  it('serializes changes and reconciles a late target to the newest locale', async () => {
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let target: ((locale: SupportedLocale) => void) | null = null
    const applied: SupportedLocale[] = []
    const targetApplied: SupportedLocale[] = []
    const emitLocaleChanged = vi.fn()
    const coordinator = new LocaleCoordinator({
      initialLocale: 'en-US',
      applyLocale: async (locale, isCurrent) => {
        applied.push(locale)
        if (applied.length === 1) await firstBlocked
        if (!isCurrent()) return
        target?.(locale)
      },
      emitLocaleChanged,
    })

    const first = coordinator.update('zh-CN', true)
    await vi.waitFor(() => expect(applied).toEqual(['zh-CN']))

    target = (locale) => targetApplied.push(locale)
    const reconcile = coordinator.reconcile()
    const newest = coordinator.update('en-US', true)
    releaseFirst?.()
    await Promise.all([first, reconcile, newest])

    expect(applied).toEqual(['zh-CN', 'en-US'])
    expect(targetApplied).toEqual(['en-US'])
    expect(coordinator.currentLocale).toBe('en-US')
    expect(emitLocaleChanged.mock.calls).toEqual([['en-US']])
  })

  it('skips queued intermediate locales before they start', async () => {
    const applyLocale = vi.fn()
    const emitLocaleChanged = vi.fn()
    const coordinator = new LocaleCoordinator({
      initialLocale: 'en-US',
      applyLocale,
      emitLocaleChanged,
    })

    const intermediate = coordinator.update('zh-CN', true)
    const latest = coordinator.update('en-US', true)
    await Promise.all([intermediate, latest])

    expect(applyLocale).toHaveBeenCalledOnce()
    expect(applyLocale).toHaveBeenCalledWith('en-US', expect.any(Function))
    expect(emitLocaleChanged).toHaveBeenCalledOnce()
    expect(emitLocaleChanged).toHaveBeenCalledWith('en-US')
  })

  it('force-reapplies the current locale after a target attaches late', async () => {
    let target: ((locale: SupportedLocale) => void) | null = null
    const targetApplied: SupportedLocale[] = []
    const coordinator = new LocaleCoordinator({
      initialLocale: 'en-US',
      applyLocale: (locale, isCurrent) => {
        if (isCurrent()) target?.(locale)
      },
      emitLocaleChanged: vi.fn(),
    })

    await coordinator.update('zh-CN', false)
    expect(targetApplied).toEqual([])

    target = (locale) => targetApplied.push(locale)
    await coordinator.reconcile()

    expect(targetApplied).toEqual(['zh-CN'])
  })

  it('keeps the published locale unchanged until the current apply succeeds', async () => {
    let releaseApply: (() => void) | undefined
    let markApplyStarted: (() => void) | undefined
    const applyBlocked = new Promise<void>((resolve) => {
      releaseApply = resolve
    })
    const applyStarted = new Promise<void>((resolve) => {
      markApplyStarted = resolve
    })
    let publishedLocale: SupportedLocale = 'en-US'
    const coordinator = new LocaleCoordinator({
      initialLocale: publishedLocale,
      onAppliedLocale: (locale) => {
        publishedLocale = locale
      },
      applyLocale: async () => {
        markApplyStarted?.()
        await applyBlocked
      },
      emitLocaleChanged: vi.fn(),
    })

    const switching = coordinator.update('zh-CN', false)
    await applyStarted

    expect(coordinator.currentLocale).toBe('zh-CN')
    expect(publishedLocale).toBe('en-US')

    releaseApply?.()
    await switching
    expect(publishedLocale).toBe('zh-CN')
  })

  it('continues processing after a failed transition', async () => {
    const applyLocale = vi
      .fn<
        (locale: SupportedLocale, isCurrent: () => boolean) => Promise<void>
      >()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue(undefined)
    const coordinator = new LocaleCoordinator({
      initialLocale: 'en-US',
      applyLocale,
      emitLocaleChanged: vi.fn(),
    })

    await expect(coordinator.update('zh-CN', true)).rejects.toThrow('failed')
    await expect(coordinator.update('en-US', true)).resolves.toBeUndefined()
    expect(applyLocale).toHaveBeenCalledTimes(2)
  })
})
