import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseSearchParams } from './use-typed-search-params'

const schema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  sort: z.enum(['date', 'name', 'speed']).catch('date'),
  search: z.string().catch(''),
})

describe('parseSearchParams', () => {
  it('returns defaults for empty params', () => {
    const result = parseSearchParams(new URLSearchParams(), schema)
    expect(result.page).toBe(1)
    expect(result.sort).toBe('date')
    expect(result.search).toBe('')
  })

  it('parses valid params', () => {
    const sp = new URLSearchParams('page=3&sort=name&search=hello')
    const result = parseSearchParams(sp, schema)
    expect(result.page).toBe(3)
    expect(result.sort).toBe('name')
    expect(result.search).toBe('hello')
  })

  it('falls back to defaults for invalid values', () => {
    const sp = new URLSearchParams('page=abc&sort=invalid')
    const result = parseSearchParams(sp, schema)
    expect(result.page).toBe(1)
    expect(result.sort).toBe('date')
  })
})
