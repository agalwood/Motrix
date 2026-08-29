import { AppError, ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import type { ValidateOptions } from './ctx-update'
import { validateFinalizePatch, validateHttpPatch } from './ctx-update'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<ValidateOptions> = {}): ValidateOptions {
  return {
    permissions: new Set<string>(),
    role: 'enrich',
    hook: 'beforeCreate',
    saveDir: '/downloads',
    ...overrides,
  }
}

function withPerm(...perms: string[]): ValidateOptions {
  return makeOpts({ permissions: new Set(perms) })
}

// ── validateHttpPatch ─────────────────────────────────────────────────────────

describe('validateHttpPatch', () => {
  it('accepts a valid HTTP patch', () => {
    const patch = { filename: 'file.zip', connections: 4 }
    const result = validateHttpPatch(patch, withPerm('fs.task.write'))
    expect(result).toEqual(patch)
  })

  it('accepts an empty patch object', () => {
    const result = validateHttpPatch({}, makeOpts())
    expect(result).toEqual({})
  })

  it('accepts proxy: empty string (clear proxy)', () => {
    const result = validateHttpPatch({ proxy: '' }, makeOpts())
    expect(result.proxy).toBe('')
  })

  it('accepts a valid HTTP task proxy with credentials', () => {
    const result = validateHttpPatch(
      { proxy: 'http://user:pass@host:1080' },
      makeOpts()
    )
    expect(result.proxy).toBe('http://user:pass@host:1080')
  })

  it.each([
    'socks5://user:pass@host:1080',
    'http://user%0Aevil:pass@host:1080',
  ])('rejects a task proxy aria2 cannot safely consume: %s', (proxy) => {
    expect(() => validateHttpPatch({ proxy }, makeOpts())).toThrow(AppError)
  })

  it('accepts a headers array with name/value objects', () => {
    const headers = [{ name: 'Authorization', value: 'Bearer token' }]
    const result = validateHttpPatch({ headers }, makeOpts())
    expect(result.headers).toEqual(headers)
  })

  it('rejects filename: "../escape" (path traversal)', () => {
    expect(() =>
      validateHttpPatch({ filename: '../escape' }, withPerm('fs.task.write'))
    ).toThrow(AppError)
  })

  it('rejects filename: "a/b" (forward slash)', () => {
    expect(() =>
      validateHttpPatch({ filename: 'a/b' }, withPerm('fs.task.write'))
    ).toThrow(AppError)
  })

  it('rejects filename: ".hidden" (starts with dot)', () => {
    expect(() =>
      validateHttpPatch({ filename: '.hidden' }, withPerm('fs.task.write'))
    ).toThrow(AppError)
  })

  it('rejects filename with backslash', () => {
    expect(() =>
      validateHttpPatch({ filename: 'a\\b' }, withPerm('fs.task.write'))
    ).toThrow(AppError)
  })

  it('rejects connections: 17 (over max)', () => {
    expect(() => validateHttpPatch({ connections: 17 }, makeOpts())).toThrow(
      AppError
    )
  })

  it('rejects connections: 0 (under min)', () => {
    expect(() => validateHttpPatch({ connections: 0 }, makeOpts())).toThrow(
      AppError
    )
  })

  it('rejects proxy: "ftp://x:21" (unsupported scheme)', () => {
    expect(() =>
      validateHttpPatch({ proxy: 'ftp://x:21' }, makeOpts())
    ).toThrow(AppError)
  })

  it('throws CtxUpdateInvalid when filename patch lacks fs.task.write', () => {
    const err = (() => {
      try {
        validateHttpPatch({ filename: 'file.zip' }, makeOpts())
        return null
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(AppError)
    const appErr = err as AppError
    expect(appErr.code).toBe(ErrorCode.PluginRuntimeFault)
    expect(appErr.message).toContain(
      'CtxUpdateInvalid: filename requires fs.task.write permission'
    )
  })

  it('throws AuditRoleCannotMutate when role is audit', () => {
    const err = (() => {
      try {
        validateHttpPatch({}, makeOpts({ role: 'audit' }))
        return null
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(AppError)
    const appErr = err as AppError
    expect(appErr.code).toBe(ErrorCode.PluginRuntimeFault)
    expect(appErr.message).toBe('AuditRoleCannotMutate')
  })

  it('rejects unknown key saveDir (strict schema, invariant I31)', () => {
    expect(() => validateHttpPatch({ saveDir: '/other' }, makeOpts())).toThrow(
      AppError
    )
  })

  it('error code is always PluginRuntimeFault', () => {
    try {
      validateHttpPatch({ connections: 99 }, makeOpts())
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(ErrorCode.PluginRuntimeFault)
    }
  })
})

// ── validateFinalizePatch ─────────────────────────────────────────────────────

describe('validateFinalizePatch', () => {
  it('accepts filePath within saveDir', () => {
    const result = validateFinalizePatch(
      { filePath: 'subdir/x.mp4' },
      makeOpts({ saveDir: '/downloads' })
    )
    expect(result.filePath).toBe('subdir/x.mp4')
  })

  it('accepts filePath when saveDir has a trailing slash', () => {
    const result = validateFinalizePatch(
      { filePath: 'x.mp4' },
      makeOpts({ saveDir: '/tmp/save/' })
    )
    expect(result.filePath).toBe('x.mp4')
  })

  it('rejects filePath that escapes saveDir via ../', () => {
    expect(() =>
      validateFinalizePatch(
        { filePath: '../escape' },
        makeOpts({ saveDir: '/downloads' })
      )
    ).toThrow(AppError)
  })

  it('rejects filePath that escapes saveDir via absolute path', () => {
    expect(() =>
      validateFinalizePatch(
        { filePath: '/etc/passwd' },
        makeOpts({ saveDir: '/downloads' })
      )
    ).toThrow(AppError)
  })

  it('throws AuditRoleCannotMutate when role is audit', () => {
    const err = (() => {
      try {
        validateFinalizePatch(
          { filePath: 'ok.mp4' },
          makeOpts({ role: 'audit', saveDir: '/downloads' })
        )
        return null
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(AppError)
    const appErr = err as AppError
    expect(appErr.code).toBe(ErrorCode.PluginRuntimeFault)
    expect(appErr.message).toBe('AuditRoleCannotMutate')
  })

  it('rejects unknown key in finalize patch (strict schema)', () => {
    expect(() =>
      validateFinalizePatch(
        { filePath: 'ok.mp4', extra: 'bad' },
        makeOpts({ saveDir: '/downloads' })
      )
    ).toThrow(AppError)
  })

  it('rejects missing filePath', () => {
    expect(() =>
      validateFinalizePatch({}, makeOpts({ saveDir: '/downloads' }))
    ).toThrow(AppError)
  })

  it('error code is always PluginRuntimeFault', () => {
    try {
      validateFinalizePatch(
        { filePath: '../escape' },
        makeOpts({ saveDir: '/downloads' })
      )
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(ErrorCode.PluginRuntimeFault)
    }
  })
})
