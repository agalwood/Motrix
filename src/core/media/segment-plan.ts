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
  return new URL(ref, base).toString()
}
