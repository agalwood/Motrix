import { describe, expect, it } from 'vitest'
import { ConnectionManager } from '@/background/ConnectionManager'

const options = {
  clientInfo: {
    kind: 'extension' as const,
    name: 'motrix-extension',
    version: '0.1.14',
    extensionId: 'test-extension-id',
    browser: 'chromium' as const,
    browserVersion: '151',
    locale: 'en',
  },
}

describe('ConnectionManager server capabilities', () => {
  it('returns null before any handshake', () => {
    const cm = new ConnectionManager(options)
    expect(cm.getServerCapabilities()).toBeNull()
  })

  it('captures capabilities from an initialize result', () => {
    const cm = new ConnectionManager(options)
    // @ts-expect-error — exercise the private capture path used by doInitialize
    cm.captureCapabilities({
      ffmpegAvailable: true,
      selectionKinds: ['direct', 'hls', 'dash', 'mux'],
      progress: true,
      cancellation: true,
      taskReveal: true,
    })
    expect(cm.getServerCapabilities()?.selectionKinds).toContain('dash')
    expect(cm.getServerCapabilities()?.taskReveal).toBe(true)
  })

  it('keeps task reveal disabled when an older server omits the capability', () => {
    const cm = new ConnectionManager(options)
    // @ts-expect-error — exercise the private capture path used by doInitialize
    cm.captureCapabilities({
      ffmpegAvailable: false,
      selectionKinds: ['direct'],
    })
    expect(cm.getServerCapabilities()?.taskReveal).toBe(false)
  })
})
