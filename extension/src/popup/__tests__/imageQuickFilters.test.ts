import { describe, expect, it } from 'vitest'

import {
  availableImageFormats,
  canonicalImageFormat,
  countActiveImageQuickFilters,
  EMPTY_IMAGE_QUICK_FILTERS,
  matchesImageQuickFilters,
  normalizeImageQuickFilterCondition,
  normalizeImageQuickFilters,
} from '@/popup/imageQuickFilters'

const image = (
  overrides: Partial<{
    url: string
    mimeType: string
    width: number
    height: number
    sizeBytes: number
  }> = {}
) => ({
  url: 'https://images.example/photo.jpg',
  mimeType: 'image/jpeg',
  width: 1920,
  height: 1080,
  sizeBytes: 2 * 1024 * 1024,
  ...overrides,
})

describe('canonicalImageFormat', () => {
  it.each([
    ['image/jpeg', 'JPG'],
    ['image/jpg; charset=binary', 'JPG'],
    ['image/pjpeg', 'JPG'],
    ['image/png', 'PNG'],
    ['image/webp', 'WEBP'],
    ['image/gif', 'GIF'],
    ['image/avif-sequence', 'AVIF'],
    ['image/apng', 'APNG'],
    ['image/x-ms-bmp', 'BMP'],
    ['image/vnd.microsoft.icon', 'ICO'],
    ['image/tiff', 'TIFF'],
    ['image/heic-sequence', 'HEIC'],
    ['image/heif', 'HEIF'],
    ['image/jxl', 'JXL'],
    ['image/svg+xml', 'OTHER'],
  ])('maps MIME %s to %s', (mimeType, expected) => {
    expect(canonicalImageFormat(image({ mimeType }))).toBe(expected)
  })

  it.each([
    ['photo.JPEG?token=1', 'JPG'],
    ['photo.png#large', 'PNG'],
    ['photo.apng', 'APNG'],
    ['photo.tif', 'TIFF'],
    ['photo.ico', 'ICO'],
    ['photo.unknown', 'OTHER'],
  ])('falls back to URL suffix %s', (leaf, expected) => {
    expect(
      canonicalImageFormat(
        image({
          url: `https://images.example/${leaf}`,
          mimeType: undefined,
        })
      )
    ).toBe(expected)
  })

  it('gives a concrete MIME priority over a misleading URL suffix', () => {
    expect(
      canonicalImageFormat(
        image({
          url: 'https://images.example/photo.png',
          mimeType: 'image/webp',
        })
      )
    ).toBe('WEBP')
    expect(
      canonicalImageFormat(
        image({
          url: 'https://images.example/photo.jpg',
          mimeType: 'image/svg+xml',
        })
      )
    ).toBe('OTHER')
  })
})

describe('availableImageFormats', () => {
  it('deduplicates formats in a fixed visual order', () => {
    expect(
      availableImageFormats([
        image({ mimeType: 'image/webp' }),
        image({ mimeType: 'image/jpeg' }),
        image({ mimeType: 'image/svg+xml' }),
        image({ mimeType: 'image/png' }),
        image({ mimeType: 'image/jpeg' }),
      ])
    ).toEqual(['JPG', 'PNG', 'WEBP', 'OTHER'])
  })
})

describe('normalization', () => {
  it('canonicalizes, deduplicates, and sorts selected formats', () => {
    expect(
      normalizeImageQuickFilters({
        formats: [' webp ', 'JPEG', 'jpg', 'bogus', 'PNG'],
      })
    ).toEqual({ formats: ['JPG', 'PNG', 'WEBP'] })
  })

  it('accepts only supported operators and bounded non-negative integers', () => {
    expect(
      normalizeImageQuickFilterCondition({ operator: 'gte', value: 0 }, 'width')
    ).toEqual({ operator: 'gte', value: 0 })
    expect(
      normalizeImageQuickFilterCondition(
        { operator: 'lte', value: Number.MAX_SAFE_INTEGER },
        'size'
      )
    ).toEqual({ operator: 'lte', value: Number.MAX_SAFE_INTEGER })

    for (const condition of [
      { operator: 'gt', value: 100 },
      { operator: 'eq', value: -1 },
      { operator: 'eq', value: 1.5 },
      { operator: 'eq', value: Number.NaN },
      { operator: 'eq', value: Number.POSITIVE_INFINITY },
      { operator: 'eq', value: Number.MAX_VALUE },
      null,
      '100',
    ]) {
      expect(normalizeImageQuickFilterCondition(condition, 'width')).toBe(
        undefined
      )
    }
    expect(
      normalizeImageQuickFilterCondition(
        { operator: 'eq', value: 100_001 },
        'height'
      )
    ).toBeUndefined()
  })

  it('removes malformed fields without mutating the input', () => {
    const filters = {
      formats: ['jpeg', 'WEBP'],
      width: { operator: 'gte', value: 800 },
      height: { operator: 'lte', value: -1 },
      size: { operator: 'eq', value: Number.NaN },
    }
    expect(normalizeImageQuickFilters(filters)).toEqual({
      formats: ['JPG', 'WEBP'],
      width: { operator: 'gte', value: 800 },
    })
    expect(filters.formats).toEqual(['jpeg', 'WEBP'])
  })

  it('returns a fresh empty value for unknown input', () => {
    expect(EMPTY_IMAGE_QUICK_FILTERS).toEqual({ formats: [] })
    expect(normalizeImageQuickFilters(null)).toEqual({ formats: [] })
    expect(normalizeImageQuickFilters([])).toEqual({ formats: [] })
  })
})

describe('matchesImageQuickFilters', () => {
  it('combines format, width, height, and byte-size filters', () => {
    const filters = {
      formats: ['JPG', 'PNG'],
      width: { operator: 'gte', value: 1920 },
      height: { operator: 'eq', value: 1080 },
      size: { operator: 'lte', value: 2 * 1024 * 1024 },
    }
    expect(matchesImageQuickFilters(image(), filters)).toBe(true)
    expect(
      matchesImageQuickFilters(image({ mimeType: 'image/webp' }), filters)
    ).toBe(false)
    expect(matchesImageQuickFilters(image({ width: 1919 }), filters)).toBe(
      false
    )
    expect(matchesImageQuickFilters(image({ height: 1079 }), filters)).toBe(
      false
    )
    expect(
      matchesImageQuickFilters(
        image({ sizeBytes: 2 * 1024 * 1024 + 1 }),
        filters
      )
    ).toBe(false)
  })

  it('does not match unknown or invalid metadata when that metric is active', () => {
    for (const overrides of [
      { width: undefined },
      { width: 0 },
      { width: Number.NaN },
      { width: Number.MAX_VALUE },
    ]) {
      expect(
        matchesImageQuickFilters(image(overrides), {
          formats: [],
          width: { operator: 'gte', value: 0 },
        })
      ).toBe(false)
    }
    expect(
      matchesImageQuickFilters(image({ sizeBytes: undefined }), {
        formats: [],
        size: { operator: 'lte', value: Number.MAX_SAFE_INTEGER },
      })
    ).toBe(false)
  })

  it('ignores malformed filters instead of making all resources disappear', () => {
    expect(
      matchesImageQuickFilters(image(), {
        formats: ['not-a-format'],
        width: { operator: 'gte', value: Number.NaN },
      })
    ).toBe(true)
  })
})

describe('countActiveImageQuickFilters', () => {
  it('counts all selected formats as one and each valid metric as one', () => {
    expect(countActiveImageQuickFilters(EMPTY_IMAGE_QUICK_FILTERS)).toBe(0)
    expect(
      countActiveImageQuickFilters({
        formats: ['JPEG', 'PNG'],
        width: { operator: 'gte', value: 640 },
        height: { operator: 'eq', value: 480 },
        size: { operator: 'lte', value: 1024 },
      })
    ).toBe(4)
  })

  it('does not count invalid or unknown values', () => {
    expect(
      countActiveImageQuickFilters({
        formats: ['invalid'],
        width: { operator: 'gte', value: -1 },
        height: { operator: 'wat', value: 100 },
      })
    ).toBe(0)
  })
})
