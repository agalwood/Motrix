import { describe, expect, it } from 'vitest'
import { isDisallowed, isStaged, type Phase, phaseMatrix } from './phase-matrix'

describe('phase-matrix', () => {
  // Core test cases from task spec
  it('fs.task.rename disallowed in beforeFinalize', () => {
    expect(phaseMatrix('fs.task', 'rename', 'beforeFinalize')).toBe(
      'disallowed'
    )
  })

  it('ctx.update staged in beforeCreate', () => {
    expect(phaseMatrix('ctx', 'update', 'beforeCreate')).toBe('staged')
  })

  it('http.get immediate in beforeCreate', () => {
    expect(phaseMatrix('http', 'get', 'beforeCreate')).toBe('immediate')
  })

  it('metadata.set staged in beforeCreate, disallowed in afterComplete', () => {
    expect(phaseMatrix('metadata', 'set', 'beforeCreate')).toBe('staged')
    expect(phaseMatrix('metadata', 'set', 'afterComplete')).toBe('disallowed')
  })

  it('fs.task.rename allowed in onError', () => {
    expect(phaseMatrix('fs.task', 'rename', 'onError')).toBe('immediate')
  })

  // Additional test cases from task spec
  it('isDisallowed returns true for fs.task.rename in beforeFinalize', () => {
    expect(isDisallowed('fs.task', 'rename', 'beforeFinalize')).toBe(true)
  })

  it('isStaged returns true for ctx.update in beforeCreate', () => {
    expect(isStaged('ctx', 'update', 'beforeCreate')).toBe(true)
  })

  it('default unknown capability.method returns immediate', () => {
    expect(phaseMatrix('unknown', 'method', 'beforeCreate')).toBe('immediate')
  })

  it('fs.task.stat is disallowed in beforeCreate', () => {
    expect(phaseMatrix('fs.task', 'stat', 'beforeCreate')).toBe('disallowed')
  })

  it('fs.task.stat is immediate in beforeFinalize, afterComplete, onError', () => {
    expect(phaseMatrix('fs.task', 'stat', 'beforeFinalize')).toBe('immediate')
    expect(phaseMatrix('fs.task', 'stat', 'afterComplete')).toBe('immediate')
    expect(phaseMatrix('fs.task', 'stat', 'onError')).toBe('immediate')
  })

  it('metadata.get is immediate in every phase', () => {
    const phases: Phase[] = [
      'beforeCreate',
      'beforeFinalize',
      'afterComplete',
      'onError',
    ]
    phases.forEach((phase) => {
      expect(phaseMatrix('metadata', 'get', phase)).toBe('immediate')
    })
  })

  it('metadata.has is immediate in every phase', () => {
    const phases: Phase[] = [
      'beforeCreate',
      'beforeFinalize',
      'afterComplete',
      'onError',
    ]
    phases.forEach((phase) => {
      expect(phaseMatrix('metadata', 'has', phase)).toBe('immediate')
    })
  })

  it('metadata.keys is immediate in every phase', () => {
    const phases: Phase[] = [
      'beforeCreate',
      'beforeFinalize',
      'afterComplete',
      'onError',
    ]
    phases.forEach((phase) => {
      expect(phaseMatrix('metadata', 'keys', phase)).toBe('immediate')
    })
  })

  it('metadata.getAll is immediate in every phase', () => {
    const phases: Phase[] = [
      'beforeCreate',
      'beforeFinalize',
      'afterComplete',
      'onError',
    ]
    phases.forEach((phase) => {
      expect(phaseMatrix('metadata', 'getAll', phase)).toBe('immediate')
    })
  })

  it('storage.* are all immediate in every phase', () => {
    const methods = ['get', 'set', 'compareAndSet', 'delete', 'keys']
    const phases: Phase[] = [
      'beforeCreate',
      'beforeFinalize',
      'afterComplete',
      'onError',
    ]
    methods.forEach((method) => {
      phases.forEach((phase) => {
        expect(phaseMatrix('storage', method, phase)).toBe('immediate')
      })
    })
  })

  it('notify.* are all immediate in every phase', () => {
    const methods = ['show']
    const phases: Phase[] = [
      'beforeCreate',
      'beforeFinalize',
      'afterComplete',
      'onError',
    ]
    methods.forEach((method) => {
      phases.forEach((phase) => {
        expect(phaseMatrix('notify', method, phase)).toBe('immediate')
      })
    })
  })
})

describe('ffmpeg is intentionally absent from the flat matrix', () => {
  it('phaseMatrix returns the "immediate" default for ffmpeg keys', () => {
    // The real gate lives in CapabilityBridge.dispatchFfmpeg →
    // gateFfmpegOutput, because the verdict depends on the output path
    // (saveDir vs plugin storage vs other), which a flat (cap, method)
    // → verdict lookup cannot express. This sentinel pins the current
    // behavior so a future refactor that adds explicit ffmpeg rows here
    // trips on a deliberate decision.
    expect(phaseMatrix('ffmpeg', 'transcode', 'beforeFinalize')).toBe(
      'immediate'
    )
    expect(phaseMatrix('ffmpeg', 'extractAudio', 'afterComplete')).toBe(
      'immediate'
    )
    expect(phaseMatrix('ffmpeg', 'mergeStreams', 'beforeCreate')).toBe(
      'immediate'
    )
  })
})
