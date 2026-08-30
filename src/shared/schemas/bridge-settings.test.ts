import { describe, expect, it } from 'vitest'
import {
  bridgeSettingsSchema,
  DEFAULT_BRIDGE_SETTINGS,
} from './bridge-settings'

describe('bridgeSettingsSchema', () => {
  it('defaults to auto port and the empty instanceId sentinel', () => {
    expect(DEFAULT_BRIDGE_SETTINGS).toEqual({
      fixedPort: 'auto',
      instanceId: '',
    })
  })

  it('accepts a valid fixed port', () => {
    expect(bridgeSettingsSchema.parse({ fixedPort: 16802 }).fixedPort).toBe(
      16802
    )
  })

  it.each([0, 99999, -1, 1.5, 'nope', null])(
    'recovers an out-of-range or invalid fixedPort (%p) to auto',
    (fixedPort) => {
      expect(bridgeSettingsSchema.parse({ fixedPort }).fixedPort).toBe('auto')
    }
  )

  it('preserves a persisted instanceId untouched', () => {
    expect(
      bridgeSettingsSchema.parse({ instanceId: 'existing-uuid' }).instanceId
    ).toBe('existing-uuid')
  })

  it('recovers a non-string instanceId to the empty sentinel', () => {
    expect(
      bridgeSettingsSchema.parse({ instanceId: 42 as unknown as string })
        .instanceId
    ).toBe('')
  })
})
