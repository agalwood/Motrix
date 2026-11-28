import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getLogger } from '@core/logger'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { appSettingsSchema } from '@shared/schemas/app-settings'
import { graphicsRecoveryNoticeSchema } from '@shared/schemas/graphics-recovery'
import { app } from 'electron'
import { z } from 'zod'
import { registerTrustedIpcHandler } from '../ipc/trusted-ipc'
import { GPU_HEALTHY_INTERVAL_MS, GraphicsRecovery } from './graphics-recovery'

const earlySettingsSchema = z.object({
  app: z.object({
    hardwareAcceleration: appSettingsSchema.shape.hardwareAcceleration,
  }),
})

export function setupGraphicsRecovery(
  userDataDir: string,
  settingsPath: string
) {
  const log = getLogger('graphics')
  let hardwareAcceleration = true
  try {
    hardwareAcceleration = earlySettingsSchema.parse(
      JSON.parse(readFileSync(settingsPath, 'utf8'))
    ).app.hardwareAcceleration
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err: error }, 'Unable to read early graphics preference')
    }
  }
  const recovery = new GraphicsRecovery({
    statePath: path.join(userDataDir, 'graphics-recovery.json'),
    hardwareAcceleration,
    warn: (err, message) => log.warn({ err }, message),
  })
  if (!recovery.hardwareAcceleration) app.disableHardwareAcceleration()
  log.info(
    {
      hardwareAcceleration: recovery.hardwareAcceleration,
      recoveredAtStartup: recovery.recoveredAtStartup,
    },
    'Applied startup graphics mode'
  )

  let stopped = false
  let loggedDevice = false
  let healthyTimer: ReturnType<typeof setTimeout> | undefined
  const clearHealthyTimer = () => {
    clearTimeout(healthyTimer)
    healthyTimer = undefined
  }
  const gpuInfoUpdated = () => {
    if (stopped) return
    const features = app.getGPUFeatureStatus()
    log.info(
      { features, enabled: app.isHardwareAccelerationEnabled() },
      'GPU features updated'
    )
    if (
      recovery.hardwareAcceleration &&
      app.isHardwareAccelerationEnabled() &&
      features.gpu_compositing?.startsWith('enabled')
    ) {
      if (healthyTimer === undefined) {
        healthyTimer = setTimeout(() => {
          healthyTimer = undefined
          recovery.markHealthy()
        }, GPU_HEALTHY_INTERVAL_MS)
        healthyTimer.unref()
      }
    } else clearHealthyTimer()
    if (!loggedDevice) {
      loggedDevice = true
      void app
        .getGPUInfo('basic')
        .then((info) => {
          log.info({ info }, 'GPU device information')
        })
        .catch((err) =>
          log.warn({ err }, 'Unable to read GPU device information')
        )
    }
  }
  const childGone = (_event: unknown, details: Electron.Details) => {
    if (stopped || details.type !== 'GPU') return
    clearHealthyTimer()
    log.warn(
      { reason: details.reason, exitCode: details.exitCode },
      'GPU process exited'
    )
    recovery.recordFailure({
      reason: details.reason,
      exitCode: details.exitCode,
    })
  }
  app.on('gpu-info-update', gpuInfoUpdated)
  app.on('child-process-gone', childGone)
  registerTrustedIpcHandler(Queries.GetGraphicsRecoveryNotice, async () =>
    recovery.getNotice()
  )
  registerTrustedIpcHandler(
    Commands.AcknowledgeGraphicsRecoveryNotice,
    async (_event, payload: unknown) => {
      recovery.acknowledgeNotice(graphicsRecoveryNoticeSchema.parse(payload).id)
    }
  )
  const stop = () => {
    stopped = true
    clearHealthyTimer()
    app.off('gpu-info-update', gpuInfoUpdated)
    app.off('child-process-gone', childGone)
  }
  app.once('will-quit', stop)
  return { recovery, stop }
}
