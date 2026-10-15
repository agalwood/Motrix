import {
  WindowsPackageExpectationSchema,
  WindowsPackageIdentityRequestSchema,
  WindowsPackageIdentityResponseSchema,
  WindowsPackageIdentitySchema,
} from '@shared/schemas/windows-package-identity'
import {
  createWindowsPlatformClient,
  type WindowsPlatformClientDeps,
} from './windows-platform-client'

export function createWindowsPackageIdentityClient(
  deps: WindowsPlatformClientDeps = {}
) {
  const client = createWindowsPlatformClient(
    {
      request: WindowsPackageIdentityRequestSchema,
      response: WindowsPackageIdentityResponseSchema,
    },
    { maxOutputBytes: 64 * 1024, ...deps }
  )
  return {
    query: () => client.request({ version: 1, op: 'package_identity_query' }),
  }
}

/**
 * Match OS query data against an independently supplied package expectation.
 * This pure comparison does not prove delivery from the Microsoft Store.
 * Startup uses this matcher after validating the bundled expectation resource.
 */
export function matchWindowsPackageIdentity(
  expected: unknown,
  observed: unknown
) {
  const expectation = WindowsPackageExpectationSchema.safeParse(expected)
  if (!expectation.success)
    return { ok: false, code: 'invalid_expectation' } as const
  const identity = WindowsPackageIdentitySchema.safeParse(observed)
  if (!identity.success) return { ok: false, code: 'invalid_identity' } as const
  const a = expectation.data
  const b = identity.data
  const matches =
    a.publisher === b.publisher &&
    a.version === b.version &&
    a.architecture === b.architecture &&
    (['name', 'familyName', 'resourceId'] as const).every(
      (field) => a[field].toLowerCase() === b[field].toLowerCase()
    )
  return matches
    ? ({ ok: true, identity: b } as const)
    : ({ ok: false, code: 'identity_mismatch' } as const)
}
