import { describe, expect, it } from 'vitest'
import { newTaskId } from './ids'

describe('newTaskId', () => {
  it('returns a UUID v7 (version nibble = 7)', () => {
    const id = newTaskId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('is monotonic by leading timestamp bytes', () => {
    const a = newTaskId()
    const b = newTaskId()
    const aTs = a.replace(/-/g, '').slice(0, 12)
    const bTs = b.replace(/-/g, '').slice(0, 12)
    expect(bTs >= aTs).toBe(true)
  })
})
