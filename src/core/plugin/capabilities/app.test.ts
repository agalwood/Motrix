import { describe, expect, it } from 'vitest'
import { AppCapabilityHost } from './app'

describe('AppCapabilityHost', () => {
  it('returns the runtime snapshot supplied by the host adapter', () => {
    const snapshot = new AppCapabilityHost({
      appVersion: '2.0.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'zh-CN',
      arch: 'arm64',
    }).snapshot()

    expect(snapshot).toEqual({
      version: '2.0.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'zh-CN',
      arch: 'arm64',
    })
  })
})
