import { DownloadErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { GENERIC_REASON_KEY, resolveFailureDescriptor } from './descriptor'

const base = {
  errorCode: null,
  errorMessage: null,
  errorDetailKey: null,
  errorDetailParams: null,
}

describe('resolveFailureDescriptor', () => {
  it('orders detailKey before code key before generic', () => {
    const d = resolveFailureDescriptor({
      ...base,
      errorCode: DownloadErrorCode.DiskFull,
      errorDetailKey: 'task.recovery.startup.reAddFailed',
      errorDetailParams: { name: 'a.zip' },
    })
    expect(d.reasonCandidates.map((c) => c.key)).toEqual([
      'task.recovery.startup.reAddFailed',
      'task.error.reason.diskFull',
      GENERIC_REASON_KEY,
    ])
    expect(d.reasonCandidates[0]?.params).toEqual({ name: 'a.zip' })
  })
  it('detail key without code skips the code tier', () => {
    const d = resolveFailureDescriptor({ ...base, errorDetailKey: 'x.y' })
    expect(d.reasonCandidates.map((c) => c.key)).toEqual([
      'x.y',
      GENERIC_REASON_KEY,
    ])
    expect(d.hintKey).toBeNull()
  })
  it('all-null yields generic only, no hint, no detail', () => {
    const d = resolveFailureDescriptor(base)
    expect(d.reasonCandidates.map((c) => c.key)).toEqual([GENERIC_REASON_KEY])
    expect(d.technicalDetail).toBeNull()
  })
  it('code maps hint key and raw message becomes technicalDetail', () => {
    const d = resolveFailureDescriptor({
      ...base,
      errorCode: DownloadErrorCode.Unauthorized,
      errorMessage: 'HTTP 401',
    })
    expect(d.hintKey).toBe('task.error.hint.unauthorized')
    expect(d.technicalDetail).toBe('HTTP 401')
  })
  it('covers every DownloadErrorCode leaf', () => {
    for (const code of Object.values(DownloadErrorCode)) {
      const d = resolveFailureDescriptor({ ...base, errorCode: code })
      expect(d.reasonCandidates[0]?.key).toMatch(/^task\.error\.reason\./)
    }
  })
  it('whitespace-only errorMessage produces null technicalDetail', () => {
    const d = resolveFailureDescriptor({
      ...base,
      errorMessage: '   ',
    })
    expect(d.technicalDetail).toBeNull()
  })
  it('detailKey with spaces is trimmed in candidate', () => {
    const d = resolveFailureDescriptor({
      ...base,
      errorDetailKey: ' x.y ',
    })
    expect(d.reasonCandidates.map((c) => c.key)).toEqual([
      'x.y',
      GENERIC_REASON_KEY,
    ])
  })
})
