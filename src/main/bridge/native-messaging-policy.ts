import type { NativeMessagingRegistrationPolicy } from '@shared/schemas/native-messaging-policy'
import { app } from 'electron'
import {
  type DistributionContextInput,
  resolveDistributionContext,
} from '../platform/distribution-context'
import { isPackagedLinuxFlatpak } from './flatpak-environment'

export function resolveNativeMessagingRegistrationPolicy(
  input: DistributionContextInput & { env?: NodeJS.ProcessEnv }
): NativeMessagingRegistrationPolicy {
  if (resolveDistributionContext(input).isWindowsPackage)
    return { mode: 'unsupported', reason: 'windows-package' }
  if (
    input.platform === 'linux' &&
    isPackagedLinuxFlatpak({
      platform: 'linux',
      isPackaged: input.isPackaged,
      env: input.env ?? {},
    })
  )
    return { mode: 'external' }
  return { mode: 'managed' }
}

export function getNativeMessagingRegistrationPolicy(): NativeMessagingRegistrationPolicy {
  return resolveNativeMessagingRegistrationPolicy({
    platform: process.platform,
    isPackaged: app.isPackaged,
    windowsStore: process.windowsStore,
    env: process.env,
  })
}
