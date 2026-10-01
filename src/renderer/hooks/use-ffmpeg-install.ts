import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type FfmpegInstallStatus,
  ffmpegInstallResultSchema,
  ffmpegInstallStatusSchema,
} from '@shared/schemas/ffmpeg-release'
import { useRef, useState } from 'react'
import { useTransportMirror } from './use-transport-mirror'

const busyPhases = new Set([
  'metadata',
  'downloading',
  'verifying',
  'extracting',
  'systemTrust',
  'installing',
])

export function useFfmpegInstall() {
  const [status, setStatus] = useState<FfmpegInstallStatus | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const pending = useRef(false)
  const { refresh } = useTransportMirror({
    events: [Events.FfmpegInstallStatusChanged],
    refreshOnSettingsSave: false,
    load: async (stale) => {
      if (transport.platform === 'web') return
      const next = ffmpegInstallStatusSchema.parse(
        await transport.invoke(Queries.GetFfmpegInstallStatus)
      )
      if (!stale()) setStatus(next)
    },
  })
  const install = async () => {
    if (pending.current || (status && busyPhases.has(status.phase))) return null
    pending.current = true
    setSubmitting(true)
    try {
      const result = ffmpegInstallResultSchema.parse(
        await transport.invoke(Commands.InstallFfmpeg)
      )
      await refresh()
      return result
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }
  return {
    status,
    installing: submitting || Boolean(status && busyPhases.has(status.phase)),
    install,
  }
}
