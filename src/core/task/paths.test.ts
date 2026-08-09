import { describe, expect, it } from 'vitest'
import { isTempPath, toFinalPath, toTempPath } from './paths'

describe('toTempPath', () => {
  it('appends .motrix to file path', () => {
    expect(toTempPath('/downloads/foo.mp4')).toBe('/downloads/foo.mp4.motrix')
  })

  it('appends .motrix to directory path', () => {
    expect(toTempPath('/downloads/ubuntu')).toBe('/downloads/ubuntu.motrix')
  })

  it('no-op when path already has .motrix suffix', () => {
    expect(toTempPath('/downloads/foo.mp4.motrix')).toBe(
      '/downloads/foo.mp4.motrix'
    )
  })
})

describe('toFinalPath', () => {
  it('strips .motrix suffix', () => {
    expect(toFinalPath('/downloads/foo.mp4.motrix')).toBe('/downloads/foo.mp4')
  })

  it('no-op when no suffix', () => {
    expect(toFinalPath('/downloads/foo.mp4')).toBe('/downloads/foo.mp4')
  })

  it('handles directory with .motrix suffix', () => {
    expect(toFinalPath('/downloads/ubuntu.motrix')).toBe('/downloads/ubuntu')
  })
})

describe('isTempPath', () => {
  it('true when ends with .motrix', () => {
    expect(isTempPath('/downloads/foo.mp4.motrix')).toBe(true)
  })

  it('false when does not end with .motrix', () => {
    expect(isTempPath('/downloads/foo.mp4')).toBe(false)
  })

  it('false when .motrix is in middle', () => {
    expect(isTempPath('/downloads/foo.motrix/bar')).toBe(false)
  })
})
