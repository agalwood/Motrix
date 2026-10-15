import {
  type ExecFileSyncOptionsWithStringEncoding,
  execFileSync,
} from 'node:child_process'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import {
  WINDOWS_PACKAGE_IDENTITY_FILE,
  WindowsPackageIdentityResponseSchema,
  WindowsPackageRuntimeIdentitySchema,
} from '@shared/schemas/windows-package-identity'
import { matchWindowsPackageIdentity } from './windows-package-identity'

const MAX_RESOURCE_BYTES = 32 * 1024
const MAX_REPLY_BYTES = 64 * 1024

type Execute = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding
) => string
export interface WindowsPackageStartupDeps {
  execute?: Execute
}

function readIdentityResource(resourcesPath: string) {
  const file = path.join(resourcesPath, WINDOWS_PACKAGE_IDENTITY_FILE)
  if (!lstatSync(file).isFile()) throw new Error('Invalid identity resource')
  const handle = openSync(file, 'r')
  try {
    const info = fstatSync(handle)
    if (!info.isFile() || info.size > MAX_RESOURCE_BYTES)
      throw new Error('Invalid identity resource')
    const bytes = Buffer.alloc(MAX_RESOURCE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(
        handle,
        bytes,
        length,
        bytes.length - length,
        length
      )
      if (!read) break
      length += read
    }
    if (length > MAX_RESOURCE_BYTES)
      throw new Error('Identity resource exceeded its limit')
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, length)
    )
    return WindowsPackageRuntimeIdentitySchema.parse(JSON.parse(json))
  } finally {
    closeSync(handle)
  }
}

/** Bounded synchronous preflight must run before profile or database creation. */
export function verifyWindowsPackageStartup(
  options: { resourcesPath: string; productVersion: string },
  deps: WindowsPackageStartupDeps = {}
) {
  if (!path.isAbsolute(options.resourcesPath))
    return { ok: false, code: 'invalid_resource' } as const
  let runtime: ReturnType<typeof readIdentityResource>
  try {
    runtime = readIdentityResource(options.resourcesPath)
  } catch {
    return { ok: false, code: 'invalid_resource' } as const
  }
  if (runtime.productVersion !== options.productVersion)
    return { ok: false, code: 'product_version_mismatch' } as const
  let stdout: string
  try {
    stdout = (deps.execute ?? execFileSync)(
      path.join(options.resourcesPath, 'bin', 'motrix-windows-platform.exe'),
      [],
      {
        input: '{"version":1,"op":"package_identity_query"}\n',
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_REPLY_BYTES,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
  } catch {
    // Do not inspect or log child output after a process failure.
    return { ok: false, code: 'identity_query_failed' } as const
  }
  try {
    if (Buffer.byteLength(stdout, 'utf8') > MAX_REPLY_BYTES)
      return { ok: false, code: 'invalid_response' } as const
    const response = WindowsPackageIdentityResponseSchema.safeParse(
      JSON.parse(stdout)
    )
    if (!response.success)
      return { ok: false, code: 'invalid_response' } as const
    if (!response.data.ok)
      return { ok: false, code: 'identity_query_failed' } as const
    const observed = response.data.identity
    // Store may assign the reserved fourth version component. Keep every
    // developer-controlled field exact; test packages retain exact revisions.
    // https://learn.microsoft.com/windows/apps/publish/publish-your-app/package-version-numbering
    const sameStoreBuild =
      runtime.profile === 'store' &&
      runtime.expected.version.split('.').slice(0, 3).join('.') ===
        observed.version.split('.').slice(0, 3).join('.')
    const expected = sameStoreBuild
      ? { ...runtime.expected, version: observed.version }
      : runtime.expected
    const result = matchWindowsPackageIdentity(expected, observed)
    return result.ok
      ? ({ ok: true, runtime, identity: result.identity } as const)
      : ({ ok: false, code: result.code } as const)
  } catch {
    return { ok: false, code: 'invalid_response' } as const
  }
}
