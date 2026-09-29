import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
type Run = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>
export type SafariBootstrapRegistrationStatus =
  | 'not-bundled'
  | 'enabled'
  | 'requires-approval'
  | 'failed'

export interface SafariBootstrapRegistrationOptions {
  platform: NodeJS.Platform
  isPackaged: boolean
  executablePath: string
  run?: Run
  exists?: (path: string) => Promise<boolean>
}

/** Register only the same-Team helper sealed inside this packaged desktop app. */
export async function registerSafariBootstrap(
  options: SafariBootstrapRegistrationOptions
): Promise<SafariBootstrapRegistrationStatus> {
  if (options.platform !== 'darwin' || !options.isPackaged) return 'not-bundled'
  const macOS = dirname(options.executablePath)
  const contents = dirname(macOS)
  const bundle = dirname(contents)
  if (
    basename(macOS) !== 'MacOS' ||
    basename(contents) !== 'Contents' ||
    !bundle.endsWith('.app')
  )
    return 'not-bundled'
  const registrar = join(macOS, 'MotrixSafariRegistrar')
  const exists =
    options.exists ??
    (async (path) => {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    })
  if (!(await exists(registrar))) return 'not-bundled'
  const run: Run =
    options.run ??
    (async (file, args) =>
      execute(file, [...args], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 32 * 1024,
        windowsHide: true,
      }))
  try {
    // Read the Team from the verified signature, never Info.plist or an env var.
    await run('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      '-R',
      '=anchor apple generic and identifier "app.motrix.native"',
      bundle,
    ])
    const signature = await run('/usr/bin/codesign', [
      '-d',
      '--verbose=2',
      bundle,
    ])
    const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(signature.stderr)?.[1]
    if (!team) return 'failed'
    const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}" and identifier "app.motrix.safari.registration" and entitlement["com.apple.security.application-groups"] = "${team}.app.motrix.shared"`
    await run('/usr/bin/codesign', [
      '--verify',
      '--strict',
      '-R',
      requirement,
      registrar,
    ])
    // The registrar additionally validates the parent, service, and compiled
    // configuration before using SMAppService. Registration is idempotent.
    const result = JSON.parse(
      (await run(registrar, ['--register'])).stdout
    ) as unknown
    if (!result || typeof result !== 'object' || Array.isArray(result))
      return 'failed'
    const record = result as Record<string, unknown>
    if (Object.keys(record).length !== 2 || record.protocolVersion !== 1)
      return 'failed'
    return record.status === 'enabled' || record.status === 'requires-approval'
      ? record.status
      : 'failed'
  } catch {
    // Never pass subprocess output or errors into a renderer or diagnostic log.
    return 'failed'
  }
}
