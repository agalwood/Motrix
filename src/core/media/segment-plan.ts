import { admitHttpSource } from '@core/task/source-admission'
export type Container = 'mpegts' | 'fmp4' | 'single'

export interface ByteRange {
  offset: number
  length: number
}

export interface KeyRef {
  method: 'AES-128'
  uri: string
  iv: Uint8Array
}

export interface InitSegment {
  url: string
  byteRange?: ByteRange
  key?: KeyRef
}

export interface MediaPart {
  url: string
  index: number
  byteRange?: ByteRange
  key?: KeyRef
}

export interface SegmentPlan {
  container: Container
  init?: InitSegment
  segments: MediaPart[]
  isComplete: boolean
}

export type MediaErrorCode =
  | 'unsupported-live'
  | 'unsupported-master'
  | 'unsupported-encryption'

export class MediaParseError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'MediaParseError'
  }
}

export function seqNumberIv(seq: number): Uint8Array {
  const b = new Uint8Array(16)
  new DataView(b.buffer).setBigUint64(8, BigInt(seq), false)
  return b
}

export function resolveUri(base: string, ref: string): string {
  base = admitHttpSource(base)
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return admitHttpSource(ref)
  // Validate reference characters before WHATWG can silently discard them.
  const suffixAt = ref.search(/[?#]/)
  const referencePath = suffixAt < 0 ? ref : ref.slice(0, suffixAt)
  const suffix = suffixAt < 0 ? '' : ref.slice(suffixAt)
  // Literal dot segments have an unambiguous meaning only with a known base.
  // Encoded dots and all other parser rewrites still require correction.
  const checkedPath = referencePath
    .split('/')
    .map((part) => (part === '.' || part === '..' ? 'segment' : part))
    .join('/')
  admitHttpSource(
    ref.startsWith('//')
      ? `https:${checkedPath}${suffix}`
      : `https://reference.invalid/${checkedPath.replace(/^\/+/, '')}${suffix}`
  )
  return admitHttpSource(new URL(ref, base).toString())
}
