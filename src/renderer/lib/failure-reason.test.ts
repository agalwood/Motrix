import { DownloadErrorCode } from '@shared/errors'
import type { TaskErrorFields } from '@shared/task-error/descriptor'
import { describe, expect, it } from 'vitest'
import { resolveFailureReason } from './failure-reason'

const base: TaskErrorFields = {
  errorCode: null,
  errorMessage: null,
  errorDetailKey: null,
  errorDetailParams: null,
}

/** Minimal i18n stub: `catalog` maps key -> translated template string. */
function fakeI18n(catalog: Record<string, string>) {
  return {
    exists: (key: string) => key in catalog,
    t: (key: string, params?: Record<string, string>) => {
      const template = catalog[key]
      if (template === undefined) return key
      if (!params) return template
      return Object.entries(params).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
        template
      )
    },
  }
}

describe('resolveFailureReason', () => {
  it('picks the first existing candidate (detail key over code key)', () => {
    const i18n = fakeI18n({
      'task.recovery.startup.reAddFailed': 'Could not re-add {{name}}',
      'task.error.reason.diskFull': 'Disk is full',
      'task.error.reason.generic': 'Download failed',
    })
    const result = resolveFailureReason(
      {
        ...base,
        errorCode: DownloadErrorCode.DiskFull,
        errorDetailKey: 'task.recovery.startup.reAddFailed',
        errorDetailParams: { name: 'a.zip' },
      },
      i18n
    )
    expect(result.reason).toBe('Could not re-add a.zip')
  })

  it('falls through to the code-based key when the detail key is missing from the catalog', () => {
    const i18n = fakeI18n({
      'task.error.reason.diskFull': 'Disk is full',
      'task.error.reason.generic': 'Download failed',
    })
    const result = resolveFailureReason(
      {
        ...base,
        errorCode: DownloadErrorCode.DiskFull,
        errorDetailKey: 'task.recovery.startup.reAddFailed',
      },
      i18n
    )
    expect(result.reason).toBe('Disk is full')
  })

  it('falls through all the way to generic when neither the detail nor code key exist', () => {
    const i18n = fakeI18n({
      'task.error.reason.generic': 'Download failed',
    })
    const result = resolveFailureReason(
      {
        ...base,
        errorCode: DownloadErrorCode.DiskFull,
        errorDetailKey: 'task.recovery.startup.reAddFailed',
      },
      i18n
    )
    expect(result.reason).toBe('Download failed')
  })

  it('omits the hint when no hint key is derivable', () => {
    const i18n = fakeI18n({
      'task.error.reason.generic': 'Download failed',
    })
    const result = resolveFailureReason(base, i18n)
    expect(result.hint).toBeNull()
  })

  it('omits the hint when the hint key is absent from the catalog', () => {
    const i18n = fakeI18n({
      'task.error.reason.notFound': 'File not found',
    })
    const result = resolveFailureReason(
      { ...base, errorCode: DownloadErrorCode.NotFound },
      i18n
    )
    expect(result.hint).toBeNull()
  })

  it('resolves the hint when the hint key exists in the catalog', () => {
    const i18n = fakeI18n({
      'task.error.reason.diskFull': 'Disk is full',
      'task.error.hint.diskFull': 'Free up disk space, then retry',
    })
    const result = resolveFailureReason(
      { ...base, errorCode: DownloadErrorCode.DiskFull },
      i18n
    )
    expect(result.hint).toBe('Free up disk space, then retry')
  })

  it('passes the raw error message through as technicalDetail untranslated', () => {
    const i18n = fakeI18n({
      'task.error.reason.networkError': 'Network connection failed',
    })
    const result = resolveFailureReason(
      {
        ...base,
        errorCode: DownloadErrorCode.NetworkError,
        errorMessage: 'Connection refused',
      },
      i18n
    )
    expect(result.technicalDetail).toBe('Connection refused')
  })

  it('interpolates params into the resolved reason', () => {
    const i18n = fakeI18n({
      'task.recovery.startup.reAddFailed': 'Could not re-add {{name}}',
      'task.error.reason.generic': 'Download failed',
    })
    const result = resolveFailureReason(
      {
        ...base,
        errorDetailKey: 'task.recovery.startup.reAddFailed',
        errorDetailParams: { name: 'archive.zip' },
      },
      i18n
    )
    expect(result.reason).toBe('Could not re-add archive.zip')
  })

  it('returns null technicalDetail when there is no error message', () => {
    const i18n = fakeI18n({ 'task.error.reason.generic': 'Download failed' })
    const result = resolveFailureReason(base, i18n)
    expect(result.technicalDetail).toBeNull()
  })
})
