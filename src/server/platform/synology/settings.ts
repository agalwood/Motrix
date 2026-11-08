import path from 'node:path'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type NasPackageSettings,
  type NasSettingsResult,
  saveNasSettingsSchema,
} from '@shared/schemas/nas-settings'
import { parseRemoteExtensionConfig } from '../../bridge/remote-extension-config'
import {
  resolveNasAdministrator,
  sameNasAccount,
} from '../nas/client-authorization'
import { currentNasUser } from '../nas/identity'
import { NasSettingsStore } from '../nas/settings-store'
import type { SynologyAccounts } from './accounts'
import {
  dsmDirectoryConfig,
  inspectDsmRoots,
  readDsmDirectoryGrants,
} from './files'

function validConnections(value: NasPackageSettings): boolean {
  if (!value.operatorUrl && !value.extensionUrl) return true
  try {
    const url = new URL(value.operatorUrl)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.replace(/\/$/, '') !== '/motrix'
    )
      return false
  } catch {
    return false
  }
  return (
    parseRemoteExtensionConfig(
      {
        MOTRIX_REMOTE_EXTENSION_ENABLED: value.extensionUrl ? 'true' : 'false',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: value.extensionUrl,
        MOTRIX_PUBLIC_URL: value.operatorUrl,
        MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: String(value.allowHttp),
      },
      { requireWebOperator: true }
    ).status !== 'invalid'
  )
}

export async function synologySettingsHandlers(
  directory: string,
  accounts: SynologyAccounts
) {
  const store = new NasSettingsStore(directory, 'synology')
  const active = await readDsmDirectoryGrants(
    path.join(directory, 'directories.json'),
    true
  )
  await store.view()
  const denied = (): NasSettingsResult => ({
    ok: false,
    error: { code: 'permissionDenied' },
  })
  const identity = async () => {
    const user = currentNasUser()
    if (user?.platform !== 'synology')
      throw new Error('DSM administrator required')
    return resolveNasAdministrator(accounts, user)
  }
  return {
    unavailableRoots: active.unavailable,
    queryHandlers: {
      [Queries.GetNasSettings]: async (): Promise<NasSettingsResult> => {
        try {
          await identity()
          return { ok: true, value: await store.view() }
        } catch {
          return denied()
        }
      },
    },
    commandHandlers: {
      [Commands.SaveNasSettings]: async (
        raw: unknown
      ): Promise<NasSettingsResult> => {
        const request = saveNasSettingsSchema.safeParse(raw)
        if (
          !request.success ||
          !validConnections(request.data.settings) ||
          !dsmDirectoryConfig.safeParse({ roots: request.data.settings.roots })
            .success
        )
          return { ok: false, error: { code: 'invalid' } }
        try {
          const user = await identity()
          return store.save(raw, async (settings, signal) => {
            const before = await inspectDsmRoots(settings.roots)
            if (!before.every((id): id is string => id !== null))
              return 'folderUnavailable'
            for (const root of settings.roots) {
              signal.throwIfAborted()
              const info = await accounts.inspectFile(user, root, signal)
              const acl = info?.additional.perm.acl
              if (
                !info?.isdir ||
                !acl?.read ||
                !acl.write ||
                !acl.append ||
                !acl.exec
              )
                return false
            }
            const current = await accounts.resolve(user, signal)
            if (current === null || !sameNasAccount(user, current)) return false
            const after = await inspectDsmRoots(settings.roots)
            if (!after.every((id, index) => id === before[index]))
              return 'folderUnavailable'
            return { directoryIdentities: before }
          })
        } catch {
          return denied()
        }
      },
    },
  }
}
