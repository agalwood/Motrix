import {
  type WindowsStartupTaskRequest,
  WindowsStartupTaskResultSchema,
} from '@shared/schemas/auto-launch'
import { WindowsAssociationsResultSchema } from '@shared/schemas/windows-default-apps'
import { createWindowsAssociationsClient } from './windows-associations'
import { createWindowsStartupTaskClient } from './windows-startup-task'

interface ProbeDeps {
  requestStartup: (op: WindowsStartupTaskRequest['op']) => Promise<unknown>
  queryAssociations: () => Promise<unknown>
}

/** Test-profile observation through the same bounded clients as the main UI. */
export async function probeWindowsPackageReadonlyIntegration(
  options: { sourceCommit: string; familyName: string; resourcesPath: string },
  deps: ProbeDeps = {
    requestStartup: createWindowsStartupTaskClient(options).request,
    queryAssociations: createWindowsAssociationsClient(options).query,
  }
) {
  const header = {
    version: 1,
    scope: 'windows-package-readonly-integration',
    sourceCommit: options.sourceCommit,
  } as const
  let operation = 'startup-before'
  try {
    const before = WindowsStartupTaskResultSchema.parse(
      await deps.requestStartup('startup_query')
    )
    if (!before.ok)
      return { ...header, ok: false, operation, code: before.code }
    operation = 'associations'
    const associations = WindowsAssociationsResultSchema.parse(
      await deps.queryAssociations()
    )
    if (!associations.ok)
      return { ...header, ok: false, operation, code: associations.code }
    if (
      associations.mainAppAumid.toLowerCase() !==
      `${options.familyName}!Motrix`.toLowerCase()
    )
      return { ...header, ok: false, operation, code: 'identity_mismatch' }
    operation = 'startup-after'
    const after = WindowsStartupTaskResultSchema.parse(
      await deps.requestStartup('startup_query')
    )
    if (!after.ok) return { ...header, ok: false, operation, code: after.code }
    if (before.state !== after.state)
      return { ...header, ok: false, operation, code: 'startup_state_changed' }
    return {
      ...header,
      ok: true,
      observation: {
        startupStateBefore: before.state,
        startupStateAfter: after.state,
        mainAppAumid: associations.mainAppAumid,
        torrent: associations.torrent,
        magnet: associations.magnet,
        readOnlyVerified: true,
      },
    }
  } catch {
    return { ...header, ok: false, operation, code: 'invalid_response' }
  }
}
