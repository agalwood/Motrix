import { describe, expect, it } from 'vitest'
import { classify, isEffectful, isRegistrationOnly } from './classification'

describe('CapabilityClassification', () => {
  it('marks hooks.beforeCreate as registration-only', () => {
    expect(classify('hooks', 'beforeCreate')).toBe('registration-only')
    expect(isRegistrationOnly('hooks', 'beforeCreate')).toBe(true)
  })
  it('marks commands.register as registration-only', () => {
    expect(classify('commands', 'register')).toBe('registration-only')
  })
  it('marks lifecycle.onDeactivate as registration-only', () => {
    expect(classify('lifecycle', 'onDeactivate')).toBe('registration-only')
  })
  it('marks http.get as effectful', () => {
    expect(classify('http', 'get')).toBe('effectful')
    expect(isEffectful('http', 'get')).toBe(true)
  })
  it('marks commands.execute as effectful', () => {
    expect(classify('commands', 'execute')).toBe('effectful')
  })
  it('marks every ffmpeg launch method (incl. run) as effectful', () => {
    // The worker exposes transcode/extractAudio/mergeStreams/generateThumbnail
    // and run as launch methods; all must classify as effectful so that an
    // activation-phase call raises activation_capability_violation rather than
    // throwing "unknown capability method" (which the worker proxy swallows).
    for (const m of [
      'probe',
      'transcode',
      'extractAudio',
      'mergeStreams',
      'generateThumbnail',
      'run',
    ]) {
      expect(classify('ffmpeg', m)).toBe('effectful')
    }
  })
  it('throws for unknown capability/method', () => {
    expect(() => classify('http', 'unknownMethod')).toThrow(
      /unknown capability/
    )
  })
})
