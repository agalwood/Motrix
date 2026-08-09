// Tests for the core notify capability interface and UnavailableNotifyHost.

import { describe, expect, it } from 'vitest'
import { NotifyCapabilityError, UnavailableNotifyHost } from './notify'

describe('NotifyCapabilityError', () => {
  it('has a code property', () => {
    const err = new NotifyCapabilityError(
      'plugin.capability.unavailable',
      'test'
    )
    expect(err.code).toBe('plugin.capability.unavailable')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('NotifyCapabilityError')
  })
})

describe('UnavailableNotifyHost', () => {
  it('available === false', () => {
    const host = new UnavailableNotifyHost()
    expect(host.available).toBe(false)
  })

  it('show() rejects with code plugin.capability.unavailable', async () => {
    const host = new UnavailableNotifyHost()
    await expect(
      host.show('test-plugin', { title: 'Hi', body: 'Hello' })
    ).rejects.toMatchObject({
      code: 'plugin.capability.unavailable',
    })
  })

  it('rejected error is an instance of NotifyCapabilityError', async () => {
    const host = new UnavailableNotifyHost()
    await expect(
      host.show('test-plugin', { title: 'Hi', body: 'Hello' })
    ).rejects.toBeInstanceOf(NotifyCapabilityError)
  })
})
