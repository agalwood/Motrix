import { describe, expect, it } from 'vitest'
import {
  AutoLaunchStatusSchema,
  OpenStartupSettingsResultSchema,
  WindowsStartupTaskRequestSchema,
  WindowsStartupTaskResponseSchema,
  WindowsStartupTaskResultSchema,
  WindowsStartupTaskStateSchema,
} from './auto-launch'

const success = {
  version: 1,
  ok: true,
  taskId: 'MotrixStartup',
  state: 'disabled',
  packageIdentityPresent: true,
}

describe('auto-launch schemas', () => {
  it('requires an explicit startup settings navigation result', () => {
    expect(OpenStartupSettingsResultSchema.parse({ ok: false })).toEqual({
      ok: false,
    })
    expect(
      OpenStartupSettingsResultSchema.safeParse({ ok: true, url: 'arbitrary' })
        .success
    ).toBe(false)
    expect(OpenStartupSettingsResultSchema.safeParse({}).success).toBe(false)
  })
  it.each(WindowsStartupTaskStateSchema.options)(
    'retains the actual %s state',
    (state) => {
      const result = { ...success, state }
      expect(WindowsStartupTaskResponseSchema.parse(result)).toEqual(result)
      expect(
        AutoLaunchStatusSchema.parse({ authority: 'windows-package', result })
      ).toEqual({ authority: 'windows-package', result })
    }
  )

  it.each([
    { ...success, state: 'unknown' },
    { ...success, state: 0 },
    { ...success, taskId: 'OtherTask' },
    { ...success, version: 2 },
    { ...success, packageIdentityPresent: false },
    { ...success, extra: true },
    { ok: true, state: 'disabled' },
  ])('rejects an untrusted success response: %j', (value) => {
    expect(WindowsStartupTaskResponseSchema.safeParse(value).success).toBe(
      false
    )
  })

  it.each([
    'invalid_request',
    'no_package_identity',
    'task_unavailable',
    'winrt_failed',
    'unknown_state',
  ])('accepts the helper failure %s without manufacturing a state', (code) => {
    const result = { version: 1, ok: false, code, hresult: '0x80070005' }
    expect(WindowsStartupTaskResponseSchema.parse(result)).toEqual(result)
    expect(WindowsStartupTaskResultSchema.parse(result)).not.toHaveProperty(
      'state'
    )
  })

  it.each([
    'helper_unavailable',
    'helper_failed',
    'helper_timeout',
    'output_limit',
    'invalid_response',
  ])('accepts local %s but does not trust it from helper stdout', (code) => {
    const result = { version: 1, ok: false, code }
    expect(WindowsStartupTaskResultSchema.parse(result)).toEqual(result)
    expect(WindowsStartupTaskResponseSchema.safeParse(result).success).toBe(
      false
    )
  })

  it.each([
    { version: 1, ok: false, code: 'winrt_failed', hresult: '80070005' },
    { version: 1, ok: false, code: 'winrt_failed', hresult: '0x123' },
    { version: 1, ok: false, code: 'winrt_failed', state: 'disabled' },
    { version: 1, ok: false, code: 'other' },
  ])('rejects malformed errors: %j', (value) => {
    expect(WindowsStartupTaskResultSchema.safeParse(value).success).toBe(false)
  })

  it('keeps authority explicit and disallows contradictory fields', () => {
    expect(AutoLaunchStatusSchema.parse({ authority: 'application' })).toEqual({
      authority: 'application',
    })
    expect(AutoLaunchStatusSchema.parse({ authority: 'unsupported' })).toEqual({
      authority: 'unsupported',
    })
    for (const value of [
      { authority: 'windows-package' },
      { authority: 'application', result: success },
      { authority: 'unsupported', enabled: false },
      {},
    ])
      expect(AutoLaunchStatusSchema.safeParse(value).success).toBe(false)
  })

  it('accepts only fixed startup operations and no caller-selected task', () => {
    for (const op of ['startup_query', 'startup_enable', 'startup_disable']) {
      expect(WindowsStartupTaskRequestSchema.parse({ version: 1, op })).toEqual(
        { version: 1, op }
      )
    }
    for (const value of [
      { version: 1, op: 'startup_query', taskId: 'Other' },
      { version: 1, op: 'launch' },
      { version: 2, op: 'startup_query' },
    ])
      expect(WindowsStartupTaskRequestSchema.safeParse(value).success).toBe(
        false
      )
  })
})
