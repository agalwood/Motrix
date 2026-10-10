import { describe, expect, it } from 'vitest'
import {
  autoCategorizeSettingsSchema,
  DEFAULT_AUTO_CATEGORIZE,
  isPlainFolderSegment,
} from './auto-categorize'

describe('autoCategorizeSettingsSchema', () => {
  it('defaults to disabled with the IDM-like starter rules', () => {
    const parsed = autoCategorizeSettingsSchema.parse({})
    expect(parsed.enabled).toBe(false)
    expect(parsed.rules).toEqual(DEFAULT_AUTO_CATEGORIZE.rules)
  })

  it('recovers damaged payloads instead of throwing', () => {
    expect(autoCategorizeSettingsSchema.parse(null)).toEqual(
      DEFAULT_AUTO_CATEGORIZE
    )
    expect(
      autoCategorizeSettingsSchema.parse({ enabled: 'yes', rules: 42 })
    ).toEqual(DEFAULT_AUTO_CATEGORIZE)
  })

  it('accepts well-formed rules', () => {
    expect(
      autoCategorizeSettingsSchema.parse({
        enabled: true,
        rules: [{ exts: ['MP4', 'mkv'], folder: 'Video' }],
      })
    ).toEqual({
      enabled: true,
      rules: [{ exts: ['MP4', 'mkv'], folder: 'Video' }],
    })
  })

  it.each([
    [{ enabled: true, rules: [{ exts: [], folder: 'Video' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: '' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: 'a/b' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: 'a\\b' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: '..' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: 'CON' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: 'Video ' }] }],
    [{ enabled: true, rules: [{ exts: ['.mp4'], folder: 'Video' }] }],
    [{ enabled: true, rules: [{ exts: ['m p 4'], folder: 'Video' }] }],
  ])('persists-layer recovers invalid rule %j to defaults', (rule) => {
    // The persisted schema heals damaged files wholesale (outer catch).
    expect(autoCategorizeSettingsSchema.parse(rule)).toEqual(
      DEFAULT_AUTO_CATEGORIZE
    )
  })

  it.each([
    [{ enabled: true, rules: [{ exts: [], folder: 'Video' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: '' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: 'a/b' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: '..' }] }],
    [{ enabled: true, rules: [{ exts: ['mp4'], folder: 'CON' }] }],
    [{ enabled: true, rules: [{ exts: ['.mp4'], folder: 'Video' }] }],
  ])('input-layer rejects invalid rule %j', (rule) => {
    // The settings-save boundary removes the catch: user-submitted rules
    // must fail validation instead of silently becoming defaults.
    expect(
      autoCategorizeSettingsSchema.removeCatch().safeParse(rule).success
    ).toBe(false)
  })

  it('input-layer accepts a well-formed rule without defaults', () => {
    expect(
      autoCategorizeSettingsSchema.removeCatch().parse({
        enabled: true,
        rules: [],
      })
    ).toEqual({ enabled: true, rules: [] })
  })
})

describe('isPlainFolderSegment', () => {
  it('accepts ordinary names', () => {
    expect(isPlainFolderSegment('Video 2024')).toBe(true)
    expect(isPlainFolderSegment('视频')).toBe(true)
  })

  it.each([
    '',
    '   ',
    '.',
    '..',
    'a/b',
    'a\\b',
    'a:b',
    'NUL',
    'com1',
    'trailing.',
    'trailing ',
    'x'.repeat(121),
  ])('rejects %j', (value) => {
    expect(isPlainFolderSegment(value)).toBe(false)
  })
})
