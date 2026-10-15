import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeUrlForLog, log } from '@/background/log'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  log.setLevel('info') // reset to default for isolation
  vi.restoreAllMocks()
})

describe('log gating', () => {
  it('redacts URL credentials, paths, queries, and fragments', () => {
    expect(
      describeUrlForLog(
        'https://user:secret@cdn.example:8443/private/file?token=abc#part'
      )
    ).toBe('https://cdn.example:8443')
    expect(describeUrlForLog('magnet:?xt=urn:btih:secret')).toBe(
      'magnet:<redacted>'
    )
    expect(describeUrlForLog('not a url')).toBe('<invalid-url>')
  })

  it('at default info: error/warn/info emit, debug does not', () => {
    log.setLevel('info')
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    expect(console.error).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledOnce()
    expect(console.info).toHaveBeenCalledOnce()
    expect(console.debug).not.toHaveBeenCalled()
  })
  it('at debug: debug emits', () => {
    log.setLevel('debug')
    log.debug('d')
    expect(console.debug).toHaveBeenCalledOnce()
  })
  it('at warn: info and debug suppressed, error and warn emit', () => {
    log.setLevel('warn')
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    expect(console.error).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledOnce()
    expect(console.info).not.toHaveBeenCalled()
    expect(console.debug).not.toHaveBeenCalled()
  })
  it('at silent: nothing emits', () => {
    log.setLevel('silent')
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
    expect(console.debug).not.toHaveBeenCalled()
  })
})
