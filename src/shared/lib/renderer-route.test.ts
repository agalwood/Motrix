import { describe, expect, it } from 'vitest'
import { normalizeRendererRoute } from './renderer-route'

describe('normalizeRendererRoute', () => {
  it('preserves only known paths and an opaque task selection', () => {
    expect(normalizeRendererRoute('/downloads/all?task=task-1&q=secret')).toBe(
      '/downloads/all?task=task-1'
    )
    expect(normalizeRendererRoute('/settings/advanced?token=secret')).toBe(
      '/settings/advanced'
    )
    expect(normalizeRendererRoute('/plugins/org.plugin')).toBe(
      '/plugins/org.plugin'
    )
  })
  it.each([
    'https://example.com',
    '//example.com',
    '/%2e%2e/secret',
    '/downloads/unknown',
    '/settings/../secret',
    '/plugins/a#secret',
    `/${'x'.repeat(2048)}`,
  ])('rejects unsafe route %s', (route) => {
    expect(normalizeRendererRoute(route)).toBeUndefined()
  })
})
