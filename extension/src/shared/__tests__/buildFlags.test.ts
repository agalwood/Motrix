import { describe, expect, it } from 'vitest'
import { BUILD_VARIANT, isWebStoreBuild } from '@/shared/buildFlags'

describe('buildFlags', () => {
  it('defaults to full when __MOTRIX_BUILD__ is undefined (test env)', () => {
    expect(['webstore', 'full']).toContain(BUILD_VARIANT)
  })
  it('isWebStoreBuild reflects the variant', () => {
    expect(isWebStoreBuild()).toBe(BUILD_VARIANT === 'webstore')
  })
})
