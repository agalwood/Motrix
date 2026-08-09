export type Phase =
  | 'beforeCreate'
  | 'beforeFinalize'
  | 'afterComplete'
  | 'onError'
export type Verdict = 'immediate' | 'staged' | 'disallowed'

function immediate(): Record<Phase, Verdict> {
  return {
    beforeCreate: 'immediate',
    beforeFinalize: 'immediate',
    afterComplete: 'immediate',
    onError: 'immediate',
  }
}

const MATRIX: Record<string, Partial<Record<Phase, Verdict>>> = {
  'http.request': immediate(),
  'http.get': immediate(),
  'http.post': immediate(),
  'fs.task.stat': {
    beforeCreate: 'disallowed',
    beforeFinalize: 'immediate',
    afterComplete: 'immediate',
    onError: 'immediate',
  },
  'fs.task.exists': {
    beforeCreate: 'disallowed',
    beforeFinalize: 'immediate',
    afterComplete: 'immediate',
    onError: 'immediate',
  },
  'fs.task.openReader': {
    beforeCreate: 'disallowed',
    beforeFinalize: 'immediate',
    afterComplete: 'immediate',
    onError: 'immediate',
  },
  'fs.task.computeHash': {
    beforeCreate: 'disallowed',
    beforeFinalize: 'immediate',
    afterComplete: 'immediate',
    onError: 'immediate',
  },
  'fs.task.rename': {
    beforeCreate: 'disallowed',
    beforeFinalize: 'disallowed',
    afterComplete: 'disallowed',
    onError: 'immediate',
  },
  'fs.storage.read': immediate(),
  'fs.storage.write': immediate(),
  'fs.storage.delete': immediate(),
  'fs.storage.rename': immediate(),
  'fs.storage.exists': immediate(),
  'fs.storage.stat': immediate(),
  'fs.storage.mkdir': immediate(),
  'storage.get': immediate(),
  'storage.set': immediate(),
  'storage.compareAndSet': immediate(),
  'storage.delete': immediate(),
  'storage.keys': immediate(),
  'notify.show': immediate(),
  'commands.execute': immediate(),
  'metadata.set': {
    beforeCreate: 'staged',
    beforeFinalize: 'staged',
    afterComplete: 'disallowed',
    onError: 'disallowed',
  },
  'metadata.delete': {
    beforeCreate: 'staged',
    beforeFinalize: 'staged',
    afterComplete: 'disallowed',
    onError: 'disallowed',
  },
  'metadata.get': immediate(),
  'metadata.has': immediate(),
  'metadata.keys': immediate(),
  'metadata.getAll': immediate(),
  'ctx.update': {
    beforeCreate: 'staged',
    beforeFinalize: 'staged',
    afterComplete: 'disallowed',
    onError: 'disallowed',
  },
  // ffmpeg.*: intentionally NOT in this flat table — the verdict depends on
  // the output path (saveDir vs plugin storage vs other), which a (cap, method)
  // → verdict lookup cannot express. The real gate lives in
  // CapabilityBridge.dispatchFfmpeg → gateFfmpegOutput, which calls
  // classifyFfmpegOutput from hooks/ffmpeg-path-classify.ts.
}

export function phaseMatrix(
  cap: string,
  method: string,
  phase: Phase
): Verdict {
  const key = `${cap}.${method}`
  return MATRIX[key]?.[phase] ?? 'immediate'
}

export const isStaged = (c: string, m: string, p: Phase) =>
  phaseMatrix(c, m, p) === 'staged'

export const isDisallowed = (c: string, m: string, p: Phase) =>
  phaseMatrix(c, m, p) === 'disallowed'
