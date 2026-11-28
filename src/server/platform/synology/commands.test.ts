import { describe, expect, it } from 'vitest'
import { DsmCommandError } from './commands'

describe('DSM command failure metadata', () => {
  it.each([
    [{ code: 'EACCES' }, 'accessDenied', undefined],
    [{ code: 'ENOENT' }, 'notFound', undefined],
    [{ killed: true }, 'timeout', undefined],
    [{ code: 5 }, 'exit', 5],
    [{ code: 'untrusted-session-text' }, 'unavailable', undefined],
  ])(
    'retains only a bounded failure category from %o',
    (cause, failure, exitCode) => {
      const error = new DsmCommandError({
        ...cause,
        message: 'id=private-cookie',
        stdout: 'private-account',
        stderr: 'private-output',
        env: { HTTP_COOKIE: 'id=private-cookie' },
      })
      expect(error.failure).toBe(failure)
      expect(error.exitCode).toBe(exitCode)
      expect(JSON.stringify(error)).not.toContain('private')
      expect(error.message).toBe('DSM authority unavailable')
      expect(error.cause).toBeUndefined()
    }
  )
})
