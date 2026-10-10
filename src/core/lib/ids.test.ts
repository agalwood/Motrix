import { describe, expect, it, vi } from 'vitest'
import { newEngineTaskId, newTaskId } from './ids'

describe('newTaskId', () => {
  it('returns a UUID v7 (version nibble = 7)', () => {
    const id = newTaskId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})

describe('newEngineTaskId', () => {
  it('mints a valid reserved gid when no override is provided', () => {
    expect(newEngineTaskId(undefined, 'createTask')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('preserves a caller-reserved gid without invoking its override twice', () => {
    const override = vi.fn(() => 'ABCDEF0123456789')

    expect(newEngineTaskId(override, 'createTask')).toBe('ABCDEF0123456789')
    expect(override).toHaveBeenCalledOnce()
  })

  it.each([
    '',
    'abcdef012345678',
    'abcdef01234567890',
    'g'.repeat(16),
    ' abcdef0123456789',
    'abcdef0123456789\n',
  ])(
    'rejects malformed reserved gid %j before it can enter the reservation protocol',
    (gid) => {
      expect(() => newEngineTaskId(() => gid, 'createTask')).toThrow(
        new TypeError(
          'createTask reserved gid must contain exactly 16 hexadecimal characters'
        )
      )
    }
  )
})
